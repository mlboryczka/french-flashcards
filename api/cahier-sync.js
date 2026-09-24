// Vercel serverless function: POST /api/cahier-sync
//
// Keeps a student's deck in step with the cahier they and Laura actually
// write in: a Google Doc, one dated block per class, newest at the top.
//
// The upload flow parses a whole notebook once. This reads the same doc
// repeatedly and turns ONLY the classes it has not seen before into cards.
// What it has seen is remembered per class in cahier_links.classes
// (migration_011), as a fingerprint of that class's text.
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
//   2. A class already read is never read again. Editing or deleting a line in
//      an old class changes nothing — those cards carry the student's own
//      history, and rewriting them behind their back is worse than a stale
//      card. A class is fingerprinted so a change is *noticed*, but nothing is
//      done about it.
//   3. A word taught again in a later class keeps the card it already has.
//      Only its class dates are added to (the deck's own record of how often a
//      word came up, which orders new cards). The existing front and back are
//      left exactly as they are, edits included — this is the one place the
//      upload path differs, since a re-upload deliberately rewrites them.
//
// The Anthropic key is the deploy owner's, not the student's: a class is a few
// hundred words and this runs unattended, including from the daily check,
// where no student is present to pay for it.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { requireUser } from "./_lib/auth.js";
import {
  fetchGoogleDoc,
  sliceIntoBlocks,
  extractCardsFromBlock,
  splitSlashPairs,
  expandConjugations,
  dedupeWithPolysemy,
  cleanFrenchFront,
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

export const fingerprint = (text) =>
  createHash("sha256").update(text || "", "utf8").digest("hex").slice(0, 16);

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

// The whole sync for one student. Exported so the daily check can call it for
// every linked doc without going back through HTTP.
export async function syncUser({ admin, apiKey, userId, url, limit, force = false, now = new Date() }) {
  const take = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  let link = await loadLink(admin, userId);
  if (url) {
    const docId = docIdFrom(url);
    if (!docId) {
      return { ok: false, error: "That isn't a Google Doc link. It should look like https://docs.google.com/document/d/..." };
    }
    // A different doc starts again: what was read from the old one says
    // nothing about this one.
    const classes = link && link.doc_id === docId ? link.classes || {} : await classesAlreadyInDeck(admin, userId);
    link = await saveLink(admin, {
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
    await saveLink(admin, { user_id: userId, last_checked_at: now.toISOString(), last_error: e.message });
    return { ok: false, linked: true, error: e.message };
  }

  const blocks = sliceIntoBlocks(rawText);
  if (blocks.length === 0) {
    const message = "No class dates found in that doc. Each class should start with a line like 'Le 24 septembre 2026'.";
    await saveLink(admin, { user_id: userId, last_checked_at: now.toISOString(), last_error: message });
    return { ok: false, linked: true, error: message };
  }

  const seen = link.classes || {};
  // Newest first: the class you were taught yesterday is worth more than one
  // from last spring, and it is the one you expect to see.
  const unseen = blocks.filter((b) => !(b.date in seen)).sort((a, b) => (a.date < b.date ? 1 : -1));
  const batch = unseen.slice(0, take);

  if (batch.length === 0) {
    await saveLink(admin, { user_id: userId, last_checked_at: now.toISOString(), last_error: null });
    return {
      ok: true, linked: true, checkedAt: now.toISOString(), newClasses: [],
      cardsAdded: 0, remaining: 0, lastResult: link.last_result || null,
    };
  }

  const anthropic = new Anthropic({ apiKey });
  const errors = [];
  const raw = [];
  const results = await Promise.all(
    batch.map((b) => extractCardsFromBlock(anthropic, b).catch((e) => ({ error: e.message, block: b })))
  );
  const parsed = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.error) errors.push({ date: batch[i].date, error: r.error });
    else { raw.push(...r); parsed.push(batch[i]); }
  }
  // A class Claude could not read is left unseen, so the next run tries it
  // again rather than losing it silently.
  if (parsed.length === 0) {
    await saveLink(admin, { user_id: userId, last_checked_at: now.toISOString(), last_error: errors[0]?.error || "Could not read that class" });
    return { ok: false, linked: true, error: errors[0]?.error || "Could not read that class", errors };
  }

  const cleaned = raw.map((c) => (c && c.front && c.back ? { ...c, front: cleanFrenchFront(c.front, c.back) } : c));
  const { expanded } = expandConjugations(splitSlashPairs(cleaned));
  const { deduped } = dedupeWithPolysemy(expanded);

  const written = await writeCards(admin, userId, deduped);

  const classes = { ...seen };
  for (const b of parsed) classes[b.date] = fingerprint(b.text);
  const dates = parsed.map((b) => b.date).sort();
  const lastResult = { at: now.toISOString(), dates, cards: written.added, updated: written.updated };
  await saveLink(admin, {
    user_id: userId,
    classes,
    last_checked_at: now.toISOString(),
    last_synced_at: now.toISOString(),
    last_error: null,
    last_result: lastResult,
  });

  console.log(`[cahier-sync] ${userId}: ${parsed.length} classes → ${written.added} new cards, ${written.updated} seen again (${unseen.length - parsed.length} classes left)`);
  return {
    ok: true, linked: true, checkedAt: now.toISOString(),
    newClasses: dates, cardsAdded: written.added, cardsSeenAgain: written.updated,
    remaining: unseen.length - parsed.length,
    dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    errors,
  };
}

async function loadLink(admin, userId) {
  const { data, error } = await admin.from("cahier_links").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`Couldn't read the cahier link: ${error.message}`);
  return data || null;
}

async function saveLink(admin, row) {
  const { data, error } = await admin.from("cahier_links").upsert(row, { onConflict: "user_id" }).select().maybeSingle();
  if (error) throw new Error(`Couldn't save the cahier link: ${error.message}`);
  return data;
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

// Insert what is new; for a word the student already has, add the class date
// and nothing else (rule 3 above).
async function writeCards(admin, userId, cards) {
  const wanted = cards.filter((c) => c?.front && c?.back);
  if (wanted.length === 0) return { added: 0, updated: 0 };

  const existing = new Map();
  const fronts = wanted.map((c) => c.front);
  for (let i = 0; i < fronts.length; i += 200) {
    const { data, error } = await admin
      .from("user_cards").select("id, front, dates").eq("user_id", userId).in("front", fronts.slice(i, i + 200));
    if (error) throw new Error(`Couldn't read the deck: ${error.message}`);
    for (const row of data || []) existing.set(row.front, row);
  }

  const inserts = [];
  let updated = 0;
  for (const c of wanted) {
    const dates = Array.isArray(c.dates) ? c.dates : [];
    const row = existing.get(c.front);
    if (!row) {
      inserts.push({
        user_id: userId, front: c.front, back: c.back, category: c.category,
        dates, source: c.source || "cahier-upload",
      });
      continue;
    }
    const merged = [...new Set([...(Array.isArray(row.dates) ? row.dates : []), ...dates])].sort();
    if (merged.length === (row.dates || []).length) continue;
    const { error } = await admin.from("user_cards").update({ dates: merged }).eq("id", row.id);
    if (error) throw new Error(`Couldn't update a card: ${error.message}`);
    updated++;
  }

  let added = 0;
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500);
    const { error, count } = await admin
      .from("user_cards").upsert(chunk, { onConflict: "user_id,front", count: "exact" });
    if (error) throw new Error(`Couldn't add the new cards: ${error.message}`);
    added += count || chunk.length;
  }
  return { added, updated };
}
