// Vercel serverless function: POST /api/cahier-sync
//
// Keeps a student's deck in step with the cahier they and Laura actually
// write in: a Google Doc, one dated block per class, newest at the top.
//
// It reads the same doc again and again and turns ONLY lines it has not read
// before into cards. What a student's notes have had read is one record per
// student, line by line (notes_read, migration_016; src/lib/notesLines.js),
// shared with the upload, so neither reads a line the other already read.
// Before migration_016 it is remembered per class, by date, in
// cahier_links.classes (migration_011), as it always was.
//
// Request body (all optional):
//   { url }      link or relink a doc, then sync it
//   { limit }    how many unseen classes to parse this run (default 12)
//   { force }    parse even if the doc was checked seconds ago
//
// Response:
//   { ok, linked, checkedAt, newClasses: ["2026-09-24", ...], cardsAdded,
//     remaining, dateRange, errors }
//
// Three rules, all the owner's (2026-09-24):
//
//   1. New classes become cards immediately. They enter the deck as new cards
//      and the scheduler deals with them like any other: due work first, new
//      cards in the room that is left, most recent class first.
//   2. A line already read is never read again, and no card the student has
//      is ever rewritten: those cards carry their own history. Since
//      2026-10-06 (the plan the owner approved: "there should be NO duplicates
//      from reuploading an updated cahier") a line added to an old class, or a
//      corrected one, is read once, on its own; its card then goes through the
//      matching rule below, so a fixed typo adds nothing. Deleting a line
//      changes nothing.
//   3. A word taught again in a later class keeps the card it already has.
//      Only its class dates are added to (the deck's own record of how often a
//      word came up, which orders new cards). The existing front and back are
//      left exactly as they are, edits included. The upload does the same
//      since 2026-10-06; it used to rewrite them.
//
// What counts as "the card it already has" is src/lib/sameCard.js's rule,
// against every card the student has, archived, removed and lesson cards
// included, with near look-alikes put to Claude (src/lib/cardMatch.js).
//
// The Anthropic key is the deploy owner's, not the student's: a class is a few
// hundred words and this runs unattended, including from the daily check,
// where no student is present to pay for it.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

import { requireUser, isAdmin } from "./_lib/auth.js";
import { handleNotesChecks, supabaseNotesStore } from "./_lib/notesChecks.js";
import { planReading } from "../src/lib/notesLines.js";
import { claimReading, releaseReading, readDeck, saveRun, seedingFrom, classFingerprint } from "./_lib/notesReading.js";
import { askSameCard } from "./_lib/sameCardQuestion.js";
import {
  fetchGoogleDoc,
  sliceIntoBlocks,
  extractCardsFromBlock,
  cardsFromExtracted,
} from "./parse-cahier.js";

export const config = { maxDuration: 300 };

// How many unseen classes one run will parse. Each is one Haiku call, they run
// in parallel, and the function has 300s: 12 leaves a wide margin, and a
// student linking a year-old cahier simply syncs again (the client loops,
// `remaining` says how much is left).
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 25;
// Two checks seconds apart — opening the app while the daily check runs —
// would parse the same class twice and pay for it twice.
const MIN_SECONDS_BETWEEN_CHECKS = 30;

export const docIdFrom = (url) => String(url || "").match(/\/document\/d\/([a-zA-Z0-9_-]+)/)?.[1] || null;

export const fingerprint = classFingerprint;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  // Said plainly, because the student can do nothing about it and the person
  // who can needs to know which setting is missing.
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "This app has no Anthropic key set on the server (ANTHROPIC_API_KEY), so it can't read your cahier. Ask whoever runs it to add one.",
    });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The list behind the owner's test of how Claude reads a class, against
  // their own corrections (api/_lib/notesChecks.js; the test itself runs from
  // /api/cahier-daily). Here because of the 12-route limit, and because this
  // is the route that reads classes.
  if (req.body?.notesChecks) {
    try {
      const { status, json } = await handleNotesChecks({
        body: req.body.notesChecks,
        isAdmin: isAdmin(user),
        store: supabaseNotesStore(admin),
        readDoc: fetchGoogleDoc,
        blocksOf: sliceIntoBlocks,
      });
      return res.status(status).json(json);
    } catch (err) {
      console.error("[cahier-sync] notes checks failed:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const result = await syncUser({
      admin,
      apiKey: ANTHROPIC_API_KEY,
      userId: user.id,
      url: req.body?.url,
      limit: req.body?.limit,
      force: req.body?.force,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error("[cahier-sync] failed:", err);
    return res.status(500).json({ error: err.message });
  }
}

// How long into a run the question about near look-alikes may still be
// asked, so the run can save inside the function's five minutes.
const QUESTION_TIME_MS = 240 * 1000;

// The whole sync for one student. Exported so the daily check can call it for
// every linked doc without going back through HTTP.
//
// `ask` replaces Claude's same-or-different question; only tests pass it.
// `deadline` (a time in ms) is when the question must stop; the daily check
// passes its own, shared by every student it reads.
export async function syncUser({ admin, apiKey, userId, url, limit, force = false, now = new Date(), ask = null, deadline = null }) {
  const questionsUntil = deadline ?? Date.now() + QUESTION_TIME_MS;
  const take = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  let link = await loadLink(admin, userId);
  if (url) {
    const docId = docIdFrom(url);
    if (!docId) {
      return { ok: false, error: "That isn't a Google Doc link. It should look like https://docs.google.com/document/d/..." };
    }
    // A different doc starts again from the classes the deck has. After
    // migration_016 this matters little: what was read is the student's
    // record (notes_read), whichever doc it came from.
    const classes = link && link.doc_id === docId ? link.classes || {} : await classesAlreadyInDeck(admin, userId);
    link = await linkDoc(admin, {
      user_id: userId, doc_id: docId, doc_url: url, classes, last_error: null,
    });
  }
  if (!link) return { ok: true, linked: false, newClasses: [], cardsAdded: 0, remaining: 0 };

  if (!force && link.last_checked_at &&
      now.getTime() - new Date(link.last_checked_at).getTime() < MIN_SECONDS_BETWEEN_CHECKS * 1000) {
    return {
      ok: true, linked: true, skipped: "checked moments ago",
      checkedAt: link.last_checked_at, newClasses: [], cardsAdded: 0,
      remaining: null, lastResult: link.last_result || null,
    };
  }

  // Reading the doc is free and takes a second; only parsing costs anything.
  let rawText;
  try {
    rawText = await fetchGoogleDoc(link.doc_url);
  } catch (e) {
    await updateLink(admin, userId, { last_checked_at: now.toISOString(), last_error: e.message });
    return { ok: false, linked: true, error: e.message };
  }

  const blocks = sliceIntoBlocks(rawText);
  if (blocks.length === 0) {
    const message = "No class dates found in that doc. Each class should start with a line like 'Le 24 septembre 2026'.";
    await updateLink(admin, userId, { last_checked_at: now.toISOString(), last_error: message });
    return { ok: false, linked: true, error: message };
  }

  // One reading of a student's notes at a time: the daily check and opening
  // the app, or two devices, used to read the same new class at once.
  const reading = await claimReading(admin, { userId, kind: "sync" });
  if (reading.busy) {
    return {
      ok: true, linked: true, busy: true, skipped: "your notes are being read already",
      checkedAt: link.last_checked_at || null, newClasses: [], cardsAdded: 0,
      remaining: null, lastResult: link.last_result || null,
    };
  }
  try {
    const seen = link.classes || {};
    // What counts as read where the record has no lines for a class: after
    // migration_016, a class whose date is on any card or that this link read,
    // except that a class this link read when its text was different counts
    // as read only for its lines that are on a card (2026-10-07: the owner's
    // 2 October class was read with 4 of its 16 lines); before it, only what
    // this link read, as it always was. The deck is read only when that
    // question comes up or there is something to read: on most days the daily
    // check finds every class in the record and stops there.
    const lines = reading.mode === "lines";
    const unrecorded = lines ? blocks.filter((b) => !Array.isArray(reading.classes?.[b.date])) : [];
    const changed = seedingFrom([], seen, reading.mode).changed;
    const unknown = unrecorded.some((b) => !(b.date in seen) || changed(b));
    let deck = unknown ? await readDeck(admin, userId) : null;
    const seed = seedingFrom(deck?.rows || [], seen, reading.mode);
    const readDates = lines ? seed.readDates : new Set(Object.keys(seen));
    const plan = planReading({ blocks, classes: reading.classes, readDates, changed: seed.changed, knownLine: deck ? seed.knownLine : null });
    // Newest first: the class you were taught yesterday is worth more than one
    // from last spring, and it is the one you expect to see.
    const unread = plan.filter((p) => p.needsReading).sort((a, b) => (a.date < b.date ? 1 : -1));
    const batch = unread.slice(0, take);

    if (batch.length === 0) {
      // Nothing to read, but the record may have filled itself in.
      if (reading.mode === "lines") {
        const saved = await saveRun({
          admin, userId, reading, deck: deck || { rows: [], hasReasons: false }, plan, incoming: [], read: new Set(), ask: async () => [], source: "sync",
        });
        if (!saved.ok) throw new Error(`Couldn't save which lines were read: ${saved.error}`);
      }
      await updateLink(admin, userId, { last_checked_at: now.toISOString(), last_error: null });
      return {
        ok: true, linked: true, checkedAt: now.toISOString(), newClasses: [],
        cardsAdded: 0, remaining: 0, lastResult: link.last_result || null,
      };
    }

    const anthropic = new Anthropic({ apiKey });
    const errors = [];
    const raw = [];
    const results = await Promise.all(
      batch.map((p) =>
        extractCardsFromBlock(anthropic, { date: p.date, text: p.text, newLines: p.partial ? p.newLines : null })
          .catch((e) => ({ error: e.message }))
      )
    );
    const parsed = [];
    const failedDates = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.error) { errors.push({ date: batch[i].date, error: r.error }); failedDates.push(batch[i].date); }
      else { raw.push(...r); parsed.push(batch[i]); }
    }
    // A class Claude could not read is left unread, so the next run tries it
    // again rather than losing it silently.
    if (parsed.length === 0) {
      await updateLink(admin, userId, { last_checked_at: now.toISOString(), last_error: errors[0]?.error || "Could not read that class" });
      return { ok: false, linked: true, error: errors[0]?.error || "Could not read that class", errors };
    }

    const incoming = cardsFromExtracted(raw);
    deck ||= await readDeck(admin, userId);
    const result = await saveRun({
      admin, userId, reading, deck, plan, incoming,
      read: new Set(parsed.map((p) => p.date)), failedDates,
      ask: ask || ((pairs) => askSameCard({ apiKey, pairs, deadline: questionsUntil })),
      source: "sync",
    });
    if (!result.ok) throw new Error(`Couldn't save the new cards: ${result.error}`);

    // The classes read and saved, kept on the link as well: before
    // migration_016 this is the only record, and after it the record is kept
    // per line in notes_read.
    const waiting = new Set(result.waitingDates);
    const done = parsed.filter((p) => !waiting.has(p.date));
    const classes = { ...seen };
    for (const p of done) classes[p.date] = fingerprint(p.text);
    const dates = done.map((p) => p.date).sort();
    const lastResult = { at: now.toISOString(), dates, cards: result.added, updated: result.seenAgain };
    await updateLink(admin, userId, {
      classes,
      last_checked_at: now.toISOString(),
      last_synced_at: now.toISOString(),
      last_error: null,
      last_result: lastResult,
    });

    const remaining = unread.length - done.length;
    console.log(`[cahier-sync] ${userId}: ${parsed.length} classes read (${reading.mode}) → ${result.added} new cards, ${result.seenAgain} seen again, ${result.waiting} waiting, ${result.questions} questions (${remaining} classes left)`);
    return {
      ok: true, linked: true, checkedAt: now.toISOString(),
      newClasses: dates, cardsAdded: result.added, cardsSeenAgain: result.seenAgain,
      cardsWaiting: result.waiting, cardsFailed: result.failed.length,
      // Classes left waiting are tried again on the next run, not now: the
      // question that failed would most likely fail again at once.
      remaining: unread.length - parsed.length,
      dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
      errors,
    };
  } finally {
    await releaseReading(admin, userId, reading.runId);
  }
}

async function loadLink(admin, userId) {
  const { data, error } = await admin.from("cahier_links").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`Couldn't read the cahier link: ${error.message}`);
  return data || null;
}

// Linking, or relinking to a different doc: the whole row, which is the only
// write that may create one.
async function linkDoc(admin, row) {
  const { data, error } = await admin.from("cahier_links").upsert(row, { onConflict: "user_id" }).select().maybeSingle();
  if (error) throw new Error(`Couldn't save the cahier link: ${error.message}`);
  return data;
}

// Everything afterwards is an update to the row that linking made — when it
// was last read, what it found, why it failed.
//
// This used to be the same upsert with only the changed fields, which
// Postgres treats as an insert that then resolves a conflict: the insert half
// carried no doc_id or doc_url, both NOT NULL, so every sync after linking
// died on the first "last checked at" write. It showed up on the owner's
// account as "Couldn't read that cahier" with a linked row that had never
// been checked (2026-09-25).
async function updateLink(admin, userId, patch) {
  const { error } = await admin.from("cahier_links").update(patch).eq("user_id", userId);
  if (error) throw new Error(`Couldn't save the cahier link: ${error.message}`);
}

// The classes this deck already holds cards from, marked as read without
// parsing them again. This is what makes linking a doc cheap for someone who
// uploaded the same notebook last month: only classes taught since are new.
async function classesAlreadyInDeck(admin, userId) {
  const classes = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("user_cards").select("dates").eq("user_id", userId)
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`Couldn't read the deck: ${error.message}`);
    for (const row of data || []) {
      for (const d of Array.isArray(row.dates) ? row.dates : []) {
        if (typeof d === "string") classes[d] = "already in your deck";
      }
    }
    if (!data || data.length < PAGE) break;
  }
  return classes;
}
