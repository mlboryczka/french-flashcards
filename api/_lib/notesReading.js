// One reading of a student's notes, on the server: whose turn it is, what the
// student already has, and saving what was read (2026-10-06). Shared by the
// upload (api/parse-cahier.js) and the linked notebook (api/cahier-sync.js),
// so the two can't write cards by different rules.
//
//   claimReading   one run at a time per student. The daily check and opening
//                  the app, or two devices, used to read the same new class at
//                  once, and Claude spelt it differently each time, so both
//                  spellings went in. A run that finds another one going stops
//                  and says so. A turn lasts at most a few minutes for the
//                  sync, twenty for an upload, so a run that died doesn't hold
//                  it for ever.
//   readDeck       every row the student has, archived and lesson cards too,
//                  because a new card is compared with all of them.
//   saveRun        decides each new card (src/lib/cardMatch.js) and saves the
//                  cards and the lines read in one database step
//                  (save_notes_reading). A failure part way used to leave the
//                  cards saved and the class unread, and the next run read it
//                  again and added Claude's new spellings beside them.
//
// Before migration_016 is run none of the database pieces exist. Then the
// classes already read are known by date only (a class whose date is on a
// card, or that the linked notebook read), cards and dates are written one
// statement at a time as before, and nothing is locked. Uploads, the sync and
// the daily check all keep working.

import { randomUUID, createHash } from "node:crypto";
import { missingTable, missingFunction } from "../../src/lib/dealLog.js";
import { missingColumn } from "../../src/lib/reviewLog.js";
import { archivedSource } from "../../src/lib/archive.js";
import { matchNewCards, waitingDates, plannedWrites } from "../../src/lib/cardMatch.js";
import { recordAfter, sameRecord, readDatesFrom, lineMatcher } from "../../src/lib/notesLines.js";
import { planReplace } from "../../src/lib/replaceDeck.js";
import { SAME_CARD_MODEL, SAME_CARD_VERSION } from "./sameCardQuestion.js";

export const LEASE_SECONDS = { sync: 360, upload: 1200 };
const PAGE = 1000;

// A refusal about the cards themselves (Postgres classes 21, 22, 23, and 54,
// which is a French side too long for the deck's index), as opposed to the
// database being unreachable. Only the step-by-step save before migration_016
// meets these: after it, save_notes_reading leaves such a card out itself and
// names it.
const aboutTheCards = (error) => /^(?:2[123]|54)/.test(String(error?.code || ""));
// Text Postgres can't take: a NUL character, and half of a surrogate pair
// (JSON can carry one; jsonb refuses it). A card can't hold either anyway.
const clean = (s) =>
  typeof s === "string"
    ? s.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    : s;

// A class's text as the linked notebook keeps it once read
// (cahier_links.classes): a short hash, to tell later whether the class
// changed.
export const classFingerprint = (text) =>
  createHash("sha256").update(text || "", "utf8").digest("hex").slice(0, 16);
const FINGERPRINT = /^[0-9a-f]{16}$/;

// How a class with no lines in the record counts as read (src/lib/
// notesLines.js's planReading): every line of it when its date is on a card
// or the linked notebook read it, except a class the notebook read when its
// text was different (2026-10-07). Linking marks the classes already on cards
// with "already in your deck" rather than a fingerprint: those keep counting
// as read whole. `rows` the student's deck (readDeck), `linkClasses`
// cahier_links.classes, `mode` claimReading's.
//
// Only once there is a record of lines read (migration_016): it is what then
// remembers that the class's other lines were read. Before it, a class is
// known by its date only, as it always was, and a line added to an old class
// waits for the migration.
//
// The fingerprint is of the class's text exactly as the Google Doc's export
// gave it, so it only tells a class changed when the text compared is that
// export too: the sync, and an upload of the doc's link (`fromDoc`). Pasted
// text, a .docx (which puts a blank line after every paragraph) or a .pdf
// never matches it, however unchanged the class; on the owner's notes every
// one of their 50 fingerprinted classes looked changed, and 21 lines that
// had been read and made no card were read again (2026-10-07). So an upload
// of any other kind counts such a class as read, as before, and records
// none of its lines (`unsure`): the class keeps waiting for the doc's own
// text, and the next sync reads its lines that are on no card.
export function seedingFrom(rows = [], linkClasses = null, mode = "lines", { fromDoc = false } = {}) {
  const link = linkClasses && typeof linkClasses === "object" ? linkClasses : {};
  const differs = (block) => mode === "lines" && FINGERPRINT.test(String(link[block.date] ?? "")) && link[block.date] !== classFingerprint(block.text);
  let known = null;
  return {
    readDates: readDatesFrom(rows, link),
    changed: (block) => fromDoc && differs(block),
    unsure: (block) => !fromDoc && differs(block),
    // Built only if a class changed.
    knownLine: (line) => (known ||= lineMatcher(rows))(line),
  };
}

// The student's turn to read their notes. Returns
//   { mode: "lines", runId, classes }   the turn, and the record of lines read
//   { busy: true, kind, since }         another run has it
//   { mode: "dates", runId: null, classes: {} }  before migration_016
// Passing the runId an earlier call returned renews that same turn, and only
// that one: an upload whose turn ran out while another reading came and went
// has lost it (the record may have changed under it), and gets busy back.
export async function claimReading(admin, { userId, kind, runId = null }) {
  const id = runId || randomUUID();
  const { data, error } = await admin.rpc("claim_notes_reading", {
    p_user_id: userId, p_run_id: id, p_kind: kind, p_lease_seconds: LEASE_SECONDS[kind] || 600, p_renew: !!runId,
  });
  if (error) {
    if (missingFunction(error) || missingTable(error)) return { mode: "dates", runId: null, classes: {} };
    throw new Error(`Couldn't check whether your notes are being read: ${error.message}`);
  }
  if (!data?.claimed) return { busy: true, kind: data?.run_kind || null, since: data?.run_started_at || null };
  return { mode: "lines", runId: id, classes: data.classes || {} };
}

export async function releaseReading(admin, userId, runId) {
  if (!runId) return;
  try {
    await admin.from("notes_read").update({ run_id: null, run_kind: null, run_expires_at: null })
      .eq("user_id", userId).eq("run_id", runId);
  } catch (e) {
    console.warn("[notes] couldn't give the turn back; it runs out by itself:", e?.message || e);
  }
}

// The student's whole deck. `hasReasons` says whether user_cards has
// archived_reason yet (migration_016).
export async function readDeck(admin, userId) {
  // Whether a card was answered either way round, so "Replace" leaves it in
  // study (src/lib/replaceDeck.js).
  const base = "id, front, back, category, dates, source, fsrs_state, en_fsrs_state, reps, en_reps, last_review, en_last_review";
  let hasReasons = true;
  const rows = [];
  for (let from = 0; ; ) {
    const { data, error } = await admin.from("user_cards")
      .select(hasReasons ? `${base}, archived_reason` : base)
      .eq("user_id", userId).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error && hasReasons && missingColumn(error)) { hasReasons = false; continue; }
    if (error) throw new Error(`Couldn't read the deck: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return { rows, hasReasons };
}

const insertRow = (c, batchId) => ({
  front: clean(c.front), back: clean(c.back), category: c.category || "V",
  dates: Array.isArray(c.dates) ? c.dates : [], source: c.source || "cahier-upload", batch_id: batchId ?? null,
});

// Claude's verdicts, as the record of them keeps them (card_pairs).
function pairRows(asked, source) {
  return (asked || []).filter((p) => p.verdict).map((p) => ({
    card_a: p.aRow?.id ?? null,
    a_new_front: p.aInsert ? clean(p.aInsert.front) : null,
    card_b: null,
    b_new_front: p.bInsert ? clean(p.bInsert.front) : null,
    a_front: clean(p.a.front), a_back: clean(p.a.back), b_front: clean(p.b.front), b_back: clean(p.b.back),
    verdict: p.verdict, version: SAME_CARD_VERSION, model: SAME_CARD_MODEL, source,
  }));
}

// After migration_016: everything in one step, and the turn given back. A
// card the database can't hold is left out by the step itself and named in
// its reply (`refused`), so the rest is still saved with the lines read.
async function saveInOneStep(admin, { userId, runId, inserts, updates, archive, restore, pairs, classes }) {
  const { data, error } = await admin.rpc("save_notes_reading", {
    p_user_id: userId, p_run_id: runId,
    p_inserts: inserts, p_dates: updates.map((u) => ({ id: u.id, dates: u.dates })),
    p_archive: archive.map((r) => ({ id: r.id, reason: r.reason })), p_restore: restore.map((r) => r.id),
    p_pairs: pairs, p_classes: classes, p_finish: true,
  });
  if (error) {
    if (error.code === "NR409") return { ok: false, lostTurn: true, error: error.message, inserted: 0, failed: [] };
    return { ok: false, error: error.message, inserted: 0, failed: [] };
  }
  const failed = (Array.isArray(data?.refused) ? data.refused : []).map((r) => ({ front: r.front, error: r.error }));
  return { ok: true, inserted: data?.inserted ?? inserts.length - failed.length, dated: data?.dated ?? updates.length, failed };
}

// Before migration_016: one statement at a time, as the app always did. A card
// already holding the same French is never written over.
async function saveStepByStep(admin, { userId, inserts, updates, archive, restore = [], hasReasons }) {
  let inserted = 0;
  const failed = [];
  const saveRows = async (chunk) => {
    const { error, count } = await admin.from("user_cards")
      .upsert(chunk.map((r) => ({ user_id: userId, ...r })), { onConflict: "user_id,front", ignoreDuplicates: true, count: "exact" });
    if (!error) { inserted += count ?? chunk.length; return null; }
    if (chunk.length > 1 && aboutTheCards(error)) {
      const size = chunk.length > 50 ? 50 : 1;
      for (let i = 0; i < chunk.length; i += size) {
        const stop = await saveRows(chunk.slice(i, i + size));
        if (stop) return stop;
      }
      return null;
    }
    if (aboutTheCards(error)) { for (const r of chunk) failed.push({ front: r.front, error: error.message }); return null; }
    return error;
  };
  for (let i = 0; i < inserts.length; i += 500) {
    const stop = await saveRows(inserts.slice(i, i + 500));
    if (stop) return { ok: false, error: stop.message, inserted, failed };
  }
  let dated = 0;
  for (const u of updates) {
    const { error } = await admin.from("user_cards").update({ dates: u.merged }).eq("id", u.id).eq("user_id", userId);
    if (error) return { ok: false, error: `Couldn't update a card: ${error.message}`, inserted, failed };
    dated++;
  }
  const bySource = new Map();
  for (const row of archive) {
    const to = archivedSource(row.source);
    if (!bySource.has(to)) bySource.set(to, []);
    bySource.get(to).push(row.id);
  }
  for (const [source, ids] of bySource) {
    for (let i = 0; i < ids.length; i += 200) {
      const patch = hasReasons ? { source, archived_reason: "replaced", archived_at: new Date().toISOString() } : { source };
      const { error } = await admin.from("user_cards").update(patch).in("id", ids.slice(i, i + 200)).eq("user_id", userId);
      if (error) return { ok: false, error: `Couldn't take a card out of study: ${error.message}`, inserted, failed };
    }
  }
  // Back into study, only ever a card a Replace took out (as save_notes_reading
  // does). Only reached with the reason column in place.
  for (const row of hasReasons ? restore : []) {
    const { error } = await admin.from("user_cards")
      .update({ source: String(row.source).slice("archived:".length) || null, archived_reason: null, archived_at: null })
      .eq("id", row.id).eq("user_id", userId).eq("archived_reason", "replaced");
    if (error) return { ok: false, error: `Couldn't bring a card back into study: ${error.message}`, inserted, failed };
  }
  return { ok: true, inserted, dated, failed };
}

// `dates` added to `row` in the list of date writes, beside any it has there.
function addDates(updates, row, dates) {
  if (row?.id == null) return;
  let u = updates.find((x) => x.id === row.id);
  const have = new Set(u ? u.merged : (Array.isArray(row.dates) ? row.dates : []));
  const gain = (Array.isArray(dates) ? dates : []).filter((d) => typeof d === "string" && !have.has(d));
  if (!gain.length) return;
  if (!u) { u = { row, id: row.id, dates: [], merged: [...have] }; updates.push(u); }
  u.dates = [...new Set([...u.dates, ...gain])].sort();
  u.merged = [...new Set([...u.merged, ...gain])].sort();
}

// Decide every card a reading made, and save them with the lines read.
//
//   reading     what claimReading returned
//   deck        what readDeck returned
//   plan        planReading's classes, or null when the caller has none (an
//               old upload dialog that sends only its cards)
//   incoming    the reading's cards, through cardsFromExtracted
//   read        the dates of the classes this run read
//   failedDates classes Claude couldn't read
//   ask         Claude's question (api/_lib/sameCardQuestion.js)
//   replaceDates for "Replace my existing deck": the classes in the upload
export async function saveRun({
  admin, userId, reading, deck, plan = null, incoming = [], read = new Set(), failedDates = [],
  ask, source, batchId = null, replaceDates = null,
}) {
  const match = await matchNewCards({ incoming, deck: deck.rows, ask });
  const waiting = waitingDates(match.decisions, failedDates);
  const writes = plannedWrites(match.decisions, waiting);
  const inserts = writes.inserts.map((c) => insertRow(c, batchId));
  // Cards already in the deck that gained a class date: a word taught again.
  // One that already had the date isn't counted.
  const seenAgain = writes.updates.length;

  let archive = [];
  let restore = [];
  let replaceWaits = 0;
  let answeredStay = 0;
  if (replaceDates) {
    // Judged on the cards as this upload leaves them: a card whose word is
    // in the upload, so that it gains one of its classes now, is in it.
    const gaining = new Map(writes.updates.map((u) => [u.id, u.merged]));
    const rows = deck.rows.map((row) => (gaining.has(row.id) ? { ...row, dates: gaining.get(row.id) } : row));
    const r = planReplace(rows, replaceDates, { reasons: deck.hasReasons });
    if (!deck.hasReasons) {
      // Before migration_016 a Replace takes nothing out. A card taken out
      // then couldn't say a Replace took it, so no later Replace could bring
      // it back, and its class, being on a card, would never be read again:
      // the card would be out of study for good (2026-10-06). The upload is
      // saved as an ordinary add, and the reply says how many cards stayed.
      replaceWaits = r.archive.length + r.stay.length;
    } else {
      // A card the student has answered stays in study whatever the classes
      // say (2026-10-07), and the reply says how many did.
      answeredStay = r.stay.length;
      archive = r.archive.map((row) => ({ ...row, reason: "replaced" }));
      restore = r.restore;
      // A card that stays out because its word is in study on another card:
      // that card gains its class dates, as it would from a reading.
      for (const { row, into } of r.kept) addDates(writes.updates, into, row.dates);
    }
  }

  const lines = reading.mode === "lines" && plan;
  const classes = lines ? recordAfter(plan, reading.classes, { read, waiting }) : null;
  const nothingToWrite = !inserts.length && !writes.updates.length && !archive.length && !restore.length &&
    !(match.asked || []).some((p) => p.verdict) && (!classes || sameRecord(classes, reading.classes));

  let saved;
  if (reading.mode === "lines") {
    saved = nothingToWrite
      ? { ok: true, inserted: 0, dated: 0, failed: [] }
      : await saveInOneStep(admin, {
          userId, runId: reading.runId, inserts, updates: writes.updates, archive, restore,
          pairs: pairRows(match.asked, source), classes,
        });
  } else {
    saved = await saveStepByStep(admin, { userId, inserts, updates: writes.updates, archive, restore, hasReasons: deck.hasReasons });
  }

  // A list card decided item by item waits once, however many of its items do.
  const waitingCards = new Set(match.decisions.filter((d) => d.action === "wait").map((d) => d.card.from || d.card)).size;
  return {
    ...saved,
    added: saved.inserted,
    seenAgain,
    waiting: waitingCards,
    waitingDates: [...waiting].sort(),
    questions: match.questions,
    askError: match.askError,
    labelled: writes.inserts.filter((w) => w.labelled).length,
    keptOutOfStudy: saved.ok ? archive.length : 0,
    broughtBack: saved.ok ? restore.length : 0,
    replaceWaits,
    answeredStay,
    decisions: match.decisions,
  };
}
