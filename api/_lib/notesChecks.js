// Claude turning class notes into cards, tested against the owner's own
// corrections (2026-10-06).
//
// Every card the owner fixes or deletes in the app is logged to
// parse_corrections (src/lib/parseCorrections.js): what the card was, and what
// it became, or that it went. Each one is a mistake Claude made reading a
// class, so each one is a case: read that class again the way the linked
// notebook is read every morning (api/cahier-sync.js: extractCardsFromBlock,
// then cardsFromExtracted), three times, and see whether the mistake comes
// back. New corrections become cases by themselves.
//
// The correction doesn't keep the class's text, so the class is found in the
// student's linked notebook as it is now: by the card's own class dates while
// the card still exists, otherwise by the class, from before the correction,
// whose text holds the card's French. A case whose class can't be found is
// listed and not tested.
//
// Reached through /api/cahier-sync with a `notesChecks` body, because the
// Hobby plan deploys at most 12 routes and there are 12. Admin only:
//
//   list      every case, the class each was found in, the last test runs
//   test      { ids } those cases, their classes read NOTES_RUNS times each
//             (at most TEST_CLASSES classes per request); nothing is saved
//   save-run  { cases: [{ id, repeated: [bool...], made: [bool|null...] }] }
//
// The store, the notebook and the reading are passed in, so the rules can be
// tested without a database, Google or Claude (tests/suites/notes-checks.mjs).

import { createHash } from "node:crypto";
import { EXTRACTION_PROMPT, EXTRACTION_MODEL } from "../parse-cahier.js";
import { missingTable } from "../../src/lib/dealLog.js";

export const NOTES_RUNS = 3;
export const TEST_CLASSES = 4;

// Seven characters that change whenever the question Claude is asked, or the
// model, does. (The steps after it, cardsFromExtracted, are code: a change
// there shows in the results but not here.)
export const NOTES_PROMPT_VERSION = createHash("sha1")
  .update(EXTRACTION_MODEL).update(EXTRACTION_PROMPT).digest("hex").slice(0, 7);

const tidy = (s) => String(s ?? "").normalize("NFC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
// For finding text in a class, and for deleted cards: case, punctuation and
// spacing don't matter.
const loose = (s) => tidy(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

// What kind of mistake a correction undid. Null when it changed nothing (an
// edit saved as it was, then deleted: the deletion is the case).
export function caseKind(c) {
  if (c.action === "delete") return "delete";
  if (tidy(c.original_front) !== tidy(c.corrected_front)) return "front";
  if (tidy(c.original_back) !== tidy(c.corrected_back)) return "back";
  return null;
}

// The words a back edit took off, e.g. "présent général" from "if I had a job
// — présent général". Null when the edit wasn't a removal.
function removedFromBack(c) {
  const o = tidy(c.original_back), k = tidy(c.corrected_back);
  if (!k || !o.startsWith(k)) return null;
  const extra = o.slice(k.length).replace(/^[\s—–\-:;,.(]+|[\s)]+$/g, "");
  return extra.length >= 3 ? extra.toLowerCase() : null;
}

// Whether one reading of the class made the mistake again, and whether it
// made the card as the owner corrected it (null for a deletion).
//
//   front  a card with the original front; or, when the original was the
//          corrected front with something stuck on ("une proposition" + "d",
//          "amener" + " (to bring)"), one with the same kind of thing stuck on
//   back   a card whose back holds the words the owner took off
//   delete a card with the deleted card's front (a long one, a rule or a
//          table, by its first 25 letters, since the wording drifts)
export function judge(c, cards) {
  const kind = caseKind(c);
  const fronts = cards.map((x) => tidy(x.front));
  const made = kind === "delete" ? null : fronts.includes(tidy(c.corrected_front));
  if (kind === "front") {
    const o = tidy(c.original_front), k = tidy(c.corrected_front);
    const stuck = o.startsWith(k) ? o.slice(k.length, k.length + 2) : null;
    const repeated = fronts.some((f) => f === o || (stuck && f !== k && f.startsWith(k) && f.slice(k.length, k.length + 2) === stuck));
    return { repeated, made };
  }
  if (kind === "back") {
    const gone = removedFromBack(c);
    const o = tidy(c.original_back);
    const repeated = cards.some((x) => tidy(x.back) === o || (gone && tidy(x.back).toLowerCase().includes(gone)));
    return { repeated, made };
  }
  if (kind === "delete") {
    const o = loose(c.original_front);
    const repeated = cards.some((x) => {
      const f = loose(x.front);
      return o.length > 40 ? f.startsWith(o.slice(0, 25)) : f === o;
    });
    return { repeated, made: null };
  }
  return { repeated: false, made: null };
}

// The cases: each correction with the class it was found in.
export function buildCases(corrections, cardsById, blocks) {
  const classes = blocks.map((b) => ({ ...b, l: loose(b.text) }));
  const out = [];
  for (const c of corrections) {
    const kind = caseKind(c);
    if (!kind) continue;
    const before = String(c.created_at || "9999").slice(0, 10);
    const words = [c.original_front, c.corrected_front, String(c.original_front || "").split(/[:(=<]/)[0]]
      .map(loose).filter((t) => t.length >= 3);
    const holds = (b) => words.some((t) => b.l.includes(t));
    let found = null;
    const card = cardsById.get(c.card_id);
    if (card?.dates?.length) {
      const own = classes.filter((b) => card.dates.includes(b.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
      found = own.find(holds) || own[0] || null;
    }
    if (!found) {
      found = classes.filter((b) => b.date <= before && holds(b)).sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null;
    }
    out.push({
      id: c.id, kind, made_at: c.created_at, date: found?.date || null,
      original_front: c.original_front, original_back: c.original_back,
      corrected_front: c.corrected_front, corrected_back: c.corrected_back,
    });
  }
  return out;
}

// A test run's cases, counted. A case passes when the mistake never came back.
export function summarize(cases) {
  let every = 0, sometimes = 0, never = 0;
  for (const c of cases) {
    const reads = (c.repeated || []).filter((v) => v !== null);
    const clean = reads.filter((v) => v === false).length;
    if (reads.length && clean === reads.length) every++;
    else if (clean > 0) sometimes++;
    else never++;
  }
  return { cases: cases.length, every, sometimes, never };
}

const reply = (status, json) => ({ status, json });
const WAITING = "Waiting for the database update (migration_015).";

// `store`: corrections(), cards(ids), link(userId), runs(), saveRun(row).
// `readDoc(url)`: the notebook's text. `blocksOf(text)`: its classes.
// `read(block)`: one reading of a class, as cards.
export async function handleNotesChecks({ body, isAdmin, store, readDoc, blocksOf, read }) {
  if (!isAdmin) return reply(403, { error: "Admin only" });
  const action = body?.action;

  const loadCases = async () => {
    const corrections = (await store.corrections()).rows || [];
    const users = [...new Set(corrections.map((c) => c.user_id))];
    const cards = (await store.cards(corrections.map((c) => c.card_id).filter(Boolean))).rows || [];
    const cardsById = new Map(cards.map((c) => [c.id, c]));
    const cases = [];
    const blocksByUser = new Map();
    const problems = [];
    for (const user of users) {
      const link = (await store.link(user)).row;
      if (!link?.doc_url) { problems.push("A student whose corrections these are has no linked notebook."); continue; }
      try {
        blocksByUser.set(user, blocksOf(await readDoc(link.doc_url)));
      } catch (e) {
        problems.push(`Couldn't read the notebook: ${e.message}`);
      }
    }
    for (const user of users) {
      const blocks = blocksByUser.get(user) || [];
      for (const c of buildCases(corrections.filter((x) => x.user_id === user), cardsById, blocks)) cases.push({ ...c, user_id: user });
    }
    return { cases, blocksByUser, problems };
  };

  if (action === "list") {
    const { cases, problems } = await loadCases();
    const runs = await store.runs();
    return reply(200, {
      cases: cases.map(({ user_id, ...c }) => c),
      runs: runs.missing ? [] : runs.rows || [],
      waiting: runs.missing ? WAITING : null,
      problems,
      version: NOTES_PROMPT_VERSION,
      model: EXTRACTION_MODEL,
    });
  }

  if (action === "test") {
    const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
    if (!ids.size) return reply(400, { error: "Nothing to test." });
    const { cases, blocksByUser } = await loadCases();
    const chosen = cases.filter((c) => ids.has(c.id) && c.date);
    const classes = new Map();
    for (const c of chosen) {
      const key = `${c.user_id}|${c.date}`;
      if (!classes.has(key)) classes.set(key, (blocksByUser.get(c.user_id) || []).find((b) => b.date === c.date));
      if (classes.size > TEST_CLASSES) return reply(400, { error: `At most ${TEST_CLASSES} classes at a time.` });
    }
    const readings = new Map();
    await Promise.all([...classes].map(async ([key, block]) => {
      readings.set(key, await Promise.all(Array.from({ length: NOTES_RUNS }, () => read(block).catch(() => null))));
    }));
    const results = chosen.map((c) => {
      const reads = readings.get(`${c.user_id}|${c.date}`) || [];
      const judged = reads.map((cards) => (cards ? judge(c, cards) : null));
      return { id: c.id, repeated: judged.map((j) => (j ? j.repeated : null)), made: judged.map((j) => (j ? j.made : null)) };
    });
    return reply(200, { results, version: NOTES_PROMPT_VERSION });
  }

  if (action === "save-run") {
    const cases = (Array.isArray(body.cases) ? body.cases : [])
      .filter((c) => c && c.id && Array.isArray(c.repeated))
      .map((c) => ({
        id: c.id,
        repeated: c.repeated.map((v) => (v === true || v === false ? v : null)),
        made: (Array.isArray(c.made) ? c.made : []).map((v) => (v === true || v === false ? v : null)),
      }));
    if (!cases.length) return reply(400, { error: "Nothing to save." });
    const summary = summarize(cases);
    const saved = await store.saveRun({
      kind: "notes", version: NOTES_PROMPT_VERSION, model: EXTRACTION_MODEL,
      cases: summary.cases, passed: summary.every, summary, results: cases,
    });
    if (saved.missing) return reply(409, { error: WAITING });
    if (saved.error) return reply(500, { error: saved.error });
    return reply(200, { ok: true, summary, run: saved.row });
  }

  return reply(400, { error: "Unknown action" });
}

export function supabaseNotesStore(db) {
  const out = ({ data, error }) => (missingTable(error) ? { missing: true } : error ? { error: error.message } : { rows: data });
  return {
    async corrections() {
      return out(await db.from("parse_corrections").select("*").order("created_at", { ascending: true }).limit(2000));
    },
    async cards(ids) {
      if (!ids.length) return { rows: [] };
      return out(await db.from("user_cards").select("id, front, back, dates").in("id", [...new Set(ids)]));
    },
    async link(userId) {
      const { data, error } = await db.from("cahier_links").select("doc_url").eq("user_id", userId).maybeSingle();
      return error ? { error: error.message } : { row: data };
    },
    async runs() {
      return out(await db.from("eval_runs").select("id, kind, ran_at, version, model, cases, passed, summary").eq("kind", "notes").order("ran_at", { ascending: false }).limit(20));
    },
    async saveRun(row) {
      const { data, error } = await db.from("eval_runs").insert(row).select("id, kind, ran_at, version, model, cases, passed, summary").single();
      return missingTable(error) ? { missing: true } : error ? { error: error.message } : { row: data };
    },
  };
}
