#!/usr/bin/env node
// Sort the grammar and pronunciation cards in every deck: keep the drills,
// turn the rest into ordinary cards where there is real French underneath,
// and archive what is only a rule or a sound.
//
//   node scripts/sort-grammar-cards.mjs                    # propose, write nothing
//   node scripts/sort-grammar-cards.mjs --apply <proposal> # back up, then write
//
// The owner's decision (2026-09-24): a card must be answerable by typing
// something the app can check. "Pronoms toniques" → "moi, toi, lui/elle…" has
// nothing to type, and "du riz {ri}" → "riz: silent z" asks about a sound in an
// app with no microphone. The grammar cards that stay are conjugation drills —
// "vivre → je" / "je vis", "devoir → pp" / "dû". Where a rule card has a real
// word, phrase or example sentence under it, that French becomes an ordinary
// two-way card (V for a word, E for an expression or sentence) with a plain
// English back. The rest are archived: out of study, row kept (src/lib/archive.js).
//
// Each card is decided by the first of these that answers:
//   1. A conjugation drill (isConjugationDrill) is kept. No lookup, no model.
//   2. The owner's reviewed sort, scripts/data/grammar-sort-decisions.json —
//      the 117 grammar and pronunciation cards of the original deck, decided by
//      hand. Every deck seeded from that deck is covered by it, so for those
//      decks nothing is guessed.
//   3. Claude, for anything else (cahier-parsed cards on other decks), with the
//      rules above and the owner's own decisions as the worked examples. Its
//      answer is checked, and one that doesn't pass is left undecided — not
//      written, listed for the owner — rather than trusted.
// Lesson cards are skipped: the lesson sync owns them and would undo any change.
// Archived cards are skipped: they are already out of study.
//
// A dry run writes the whole proposal to backups/grammar-sort-proposal-<ts>.json
// and prints it. --apply takes that FILE, not a fresh run, so what is written is
// exactly what was reviewed (hand edits to the file included). Before any
// write it re-reads every row the proposal touches, backs each one up in full
// to backups/grammar-sort-applied-<ts>.json, and skips a row that changed since
// the proposal was made. Running --apply twice writes nothing the second time:
// an archived row is not archived again, a new card whose front the deck
// already has is not inserted, an edit already made is not made again.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   every deck
//   ANTHROPIC_API_KEY                         only for cards the reviewed sort
//                                             doesn't cover; without it those are
//                                             left undecided

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { isConjugationDrill } from "../src/lib/cardInstruction.js";
import { isGrammarCard } from "../src/lib/cardTypes.js";
import { archivedSource, isArchived } from "../src/lib/archive.js";
import { LESSON_SOURCE_PREFIX } from "../src/lib/lessonSource.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DECISIONS_FILE = path.join(ROOT, "scripts", "data", "grammar-sort-decisions.json");
export const MODEL = "claude-opus-5-5";
// Twenty cards is one screen of the proposal and a small, checkable answer.
export const BATCH_SIZE = 20;
const PROPOSAL_KIND = "grammar-sort-proposal";

// ── the pure part: what to do with each card ────────────────────────────────

// The form two fronts are compared in when asking "is this already in the
// deck?". Case, accents, curly apostrophes and spacing are all ways the same
// card gets typed twice: "Connaitre" is "connaître", and the deck should not
// end up with both.
export const normFront = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// The words of a front with notes, respellings, punctuation and case set aside.
const words = (f) =>
  normFront(String(f ?? "").replace(/\([^)]*\)|\{[^}]*\}/g, " "))
    .replace(/[^a-z0-9'\s-]/g, " ").replace(/['-]/g, " ").split(/\s+/).filter(Boolean);
export const sameFrench = (a, b) => words(a).join(" ") === words(b).join(" ");
// Shared words over the longer front's word count.
export const overlap = (a, b) => {
  const x = new Set(words(a)), y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(x.size, y.size);
};

export const isLessonCard = (row) =>
  typeof row?.source === "string" && row.source.startsWith(LESSON_SOURCE_PREFIX);

// The cards this script sorts: filed under grammar or pronunciation, still in
// study, and not a lesson's.
export const inScope = (row) =>
  (row?.category === "G" || row?.category === "P") && !isArchived(row) && !isLessonCard(row);

export function loadDecisions(file = DECISIONS_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// The reviewed decisions by front, for lookup. Keyed by the normalised front
// so a deck that typed "cela = ça" with a capital still finds it.
export function indexDecisions(file) {
  const byFront = new Map();
  for (const d of file.decisions || []) {
    const key = normFront(d.front);
    if (!byFront.has(key)) byFront.set(key, []);
    byFront.get(key).push(d);
  }
  return { byFront, edits: file.edits || [], file };
}

// The reviewed decision for a row, or null.
//
// Three fronts appear twice in the original deck with different backs
// ("s'asseoir / être assis"), and the owner converted one copy and archived the
// other as its duplicate. A deck can only hold one row per front, so the back
// picks the copy when it matches. When it matches neither, the row gets the
// conversion: "archive, duplicate of #24" only made sense because #24 was in
// the same deck being converted, and archiving the one row a deck has would
// lose the French the conversion keeps.
export function reviewedDecision(row, index) {
  const all = index.byFront.get(normFront(row.front)) || [];
  if (!all.length) return null;
  const exact = all.filter((d) => d.front === row.front);
  const pool = exact.length ? exact : all;
  return pool.find((d) => d.back === row.back) || pool.find((d) => d.decision !== "archive") || pool[0];
}

// What the proposal keeps of a row: enough to recognise it, to check it hasn't
// changed before writing, and to give its new cards the row's dates and source.
const snapshot = (row) => ({
  id: row.id,
  user_id: row.user_id,
  front: row.front,
  back: row.back,
  category: row.category,
  source: row.source ?? null,
  dates: Array.isArray(row.dates) ? row.dates : [],
});

// Every in-scope row that can be decided without asking Claude, and the rest.
export function decideRows(rows, index) {
  const decided = [];
  const pending = [];
  for (const row of rows) {
    if (!inScope(row)) continue;
    if (isConjugationDrill(row.front)) {
      decided.push({ ...snapshot(row), decision: "keep", from: "drill", newCards: [] });
      continue;
    }
    const d = reviewedDecision(row, index);
    if (d) {
      decided.push({
        ...snapshot(row),
        decision: d.decision,
        from: "reviewed",
        ...(d.why ? { why: d.why } : {}),
        newCards: (d.newCards || []).map((c) => ({ front: c.front, back: c.back, category: c.category })),
      });
      continue;
    }
    pending.push(row);
  }
  return { decided, pending };
}

// One prompt, one arrow, one French form to type — and no formula around it.
const drillShaped = (row) =>
  String(row.front).split("→").length === 2 &&
  !/\s\+\s|\s=\s|\bvs\b|\{|…|\.\.\./.test(String(row.front)) &&
  !/\{/.test(String(row.back ?? ""));

// Claude's answer for one card, checked. Returns { decision, why, newCards } or
// { error }. The checks are the rules the prompt states, so an answer that
// breaks one is not a judgement call to defer to — it is simply not written.
export function validateClaudeResult(result, row) {
  if (!result || typeof result !== "object") return { error: "no answer for this card" };
  const why = String(result.why ?? "").trim();
  const cards = Array.isArray(result.newCards) ? result.newCards : [];
  switch (result.decision) {
    case "keep":
      // isConjugationDrill already kept every drill it can read; a "keep" on
      // anything that isn't even shaped like one is a rule card slipping
      // through. "si + présent → futur" has an arrow and is still a rule.
      if (!drillShaped(row)) return { error: "keep is only for typeable drills" };
      if (cards.length) return { error: "keep with new cards" };
      return { decision: "keep", why, newCards: [] };
    case "archive":
      if (cards.length) return { error: "archive with new cards" };
      return { decision: "archive", why, newCards: [] };
    case "convert": {
      if (!cards.length) return { error: "convert with no new cards" };
      if (cards.length > 6) return { error: `convert into ${cards.length} cards` };
      const clean = cards.map((c) => ({
        front: String(c?.front ?? "").trim(),
        back: String(c?.back ?? "").trim(),
        category: c?.category,
      }));
      for (const c of clean) {
        if (!c.front || !c.back) return { error: "a new card with an empty side" };
        if (c.category !== "V" && c.category !== "E") return { error: `category ${JSON.stringify(c.category)}` };
        // The same test the app uses to put a card in the Grammar filter: a
        // formula, a {respelling}, "silent", "vs". A converted card that still
        // reads that way has not been converted.
        if (isGrammarCard({ f: c.front, b: c.back })) {
          return { error: `"${c.front}" still reads as a rule or a pronunciation note` };
        }
      }
      const fronts = clean.map((c) => normFront(c.front));
      if (new Set(fronts).size !== fronts.length) return { error: "two new cards with the same front" };
      return { decision: "convert", why, newCards: clean };
    }
    default:
      return { error: `unknown decision ${JSON.stringify(result.decision)}` };
  }
}

// Ask about the rows nothing else decided. The same front and back on several
// decks (a card every student got from the same class) is asked about once
// and answered the same everywhere: cheaper, and consistent.
export async function askAbout(pending, classify, log = () => {}) {
  const groups = new Map();
  for (const row of pending) {
    const key = `${row.front}\u0000${row.back}`;
    if (!groups.has(key)) groups.set(key, { id: `c${groups.size + 1}`, rows: [] });
    groups.get(key).rows.push(row);
  }
  const list = [...groups.values()];
  const items = [];
  const settle = (group, answer) => {
    for (const row of group.rows) {
      const checked = answer.error ? answer : validateClaudeResult(answer, row);
      items.push(
        checked.error
          ? { ...snapshot(row), decision: "undecided", from: "claude", error: checked.error, newCards: [] }
          : { ...snapshot(row), decision: checked.decision, from: "claude", why: checked.why, newCards: checked.newCards }
      );
    }
  };

  if (!classify) {
    for (const g of list) settle(g, { error: "not asked: ANTHROPIC_API_KEY is not set" });
    return { items, calls: 0 };
  }

  let calls = 0;
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE);
    log(`  asking Claude about ${i + 1}-${i + batch.length} of ${list.length}…`);
    let results;
    try {
      calls++;
      results = await classify(
        batch.map((g) => ({ id: g.id, front: g.rows[0].front, back: g.rows[0].back, category: g.rows[0].category }))
      );
    } catch (e) {
      for (const g of batch) settle(g, { error: `Claude call failed: ${e.message}` });
      continue;
    }
    const byId = new Map();
    for (const r of Array.isArray(results) ? results : []) {
      // A card answered twice is answered ambiguously; neither answer is used.
      const id = String(r?.id);
      byId.set(id, byId.has(id) ? { error: "answered twice" } : r);
    }
    for (const g of batch) settle(g, byId.get(g.id) ?? { error: "no answer for this card" });
  }
  return { items, calls };
}

// The two phrase cards the owner corrected while reviewing, in every deck that
// has them. Matched by exact front, as the reviewed file says. Never a lesson
// card: the lesson sync owns those, as it does for the sort above.
export function planEdits(rows, index) {
  const out = [];
  for (const e of index.edits) {
    for (const row of rows) {
      if (row.front !== e.front || isArchived(row) || isLessonCard(row)) continue;
      const newFront = e.newFront ?? row.front;
      const newBack = e.newBack ?? row.back;
      if (newFront === row.front && newBack === row.back) continue;
      out.push({ id: row.id, user_id: row.user_id, front: row.front, back: row.back, newFront, newBack, ...(e.why ? { why: e.why } : {}) });
    }
  }
  return out;
}

// A proposal item that still makes sense. The file can be edited by hand
// between the dry run and --apply, which is allowed; this only refuses what
// could not be written.
function itemProblem(it) {
  if (!["keep", "convert", "archive", "undecided"].includes(it?.decision)) return `unknown decision ${JSON.stringify(it?.decision)}`;
  if (it.decision !== "convert") return null;
  if (!Array.isArray(it.newCards) || !it.newCards.length) return "convert with no new cards";
  for (const c of it.newCards) {
    if (!String(c?.front ?? "").trim() || !String(c?.back ?? "").trim()) return "a new card with an empty side";
    if (!["V", "E", "G"].includes(c?.category)) return `category ${JSON.stringify(c?.category)}`;
  }
  return null;
}

// What applying one deck's part of a proposal would write, against the deck as
// it is NOW: `current` is the proposal's rows re-read by id, `deckRows` every
// row of the deck (id, front, source). Pure, so the dry run can preview it and
// the test can drive it; applyProposal performs exactly what it returns.
export function planWrites(deck, current, deckRows) {
  // skips are what the owner should look at; done is what an earlier --apply
  // already did, which is only worth a count.
  const writes = { edits: [], inserts: [], retags: [], archives: [], skips: [], done: [] };
  const skip = (front, reason) => writes.skips.push({ front, reason });
  const done = (front, reason) => writes.done.push({ front, reason });

  // Every front the deck holds, archived ones included: an archived row still
  // holds its (user_id, front) slot, and a card the owner archived should not
  // come back under a new id.
  const exact = new Map();
  const loose = new Map();
  const hold = (r) => {
    for (const [map, k] of [[exact, r.front], [loose, normFront(r.front)]]) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
  };
  for (const r of deckRows) hold(r);
  // The row holding this front, exactly or in another spelling — other than
  // the row itself, when a row is being respelled.
  const heldBy = (front, selfId) => {
    const other = (r) => String(r.id) !== String(selfId);
    return (exact.get(front) || []).find(other) || (loose.get(normFront(front)) || []).find(other) || null;
  };
  const describe = (r) => (isArchived(r) ? `an archived card "${r.front}" holds it` : `already in the deck as "${r.front}"`);

  // A row the proposal was made from, if it is still the same row.
  const unchanged = (snap) => {
    const row = current.get(String(snap.id));
    if (!row) return { reason: "no longer in the deck" };
    if (row.user_id !== deck.user_id) return { reason: "belongs to another deck" };
    return { row };
  };

  for (const e of deck.edits || []) {
    const { row, reason } = unchanged(e);
    if (!row) { skip(e.front, reason); continue; }
    if (row.front === e.newFront && row.back === e.newBack) { done(e.front, "edit already made"); continue; }
    if (row.front !== e.front || row.back !== e.back) { skip(e.front, "changed since the proposal"); continue; }
    if (e.newFront !== row.front) {
      const holder = heldBy(e.newFront, row.id);
      if (holder) { skip(e.front, `new front ${describe(holder)}`); continue; }
    }
    writes.edits.push({ id: row.id, front: row.front, set: { front: e.newFront, back: e.newBack } });
    hold({ id: row.id, front: e.newFront, source: row.source });
  }

  for (const it of deck.items || []) {
    if (it.decision === "keep" || it.decision === "undecided") continue;
    const problem = itemProblem(it);
    if (problem) { skip(it.front, problem); continue; }
    const { row, reason } = unchanged(it);
    if (!row) { skip(it.front, reason); continue; }
    if (isArchived(row)) { done(it.front, "already archived"); continue; }

    const cards = it.decision === "convert" ? it.newCards : [];
    // A new card with the row's own front is the row itself, filed under the
    // wrong section ("mon copain" under grammar): it is re-filed in place and
    // keeps its history, rather than archived and inserted again as new.
    // Also when the new front is the same French cleaned up — notes, a
    // respelling, capitals or punctuation taken off ("un os {oss}", "je
    // l'attends" → "Je l'attends.") — or, when the card becomes exactly one
    // card, mostly the same words ("je mange du pain / je ne mange pas de
    // pain" → "Je ne mange pas de pain"). It is the same card, tidied, so it
    // keeps its history; replacing it would restart it from nothing.
    const self = cards.find((c) => normFront(c.front) === normFront(row.front)) ||
      cards.find((c) => sameFrench(c.front, row.front)) ||
      (cards.length === 1 && overlap(cards[0].front, row.front) >= 0.6 ? cards[0] : null);
    if (self && row.front === self.front && row.back === self.back && row.category === self.category) {
      done(it.front, "already re-filed");
      continue;
    }
    if (row.front !== it.front || row.back !== it.back) { skip(it.front, "changed since the proposal"); continue; }

    // Re-filing that would respell the front ("Mon copain" → "mon copain")
    // onto a front another row already holds is not a re-filing: the French is
    // in the deck already, so the rule card is archived like any other.
    let refile = null;
    if (self) {
      const holder = self.front !== row.front ? heldBy(self.front, row.id) : null;
      if (holder) skip(self.front, describe(holder));
      else refile = { id: row.id, front: row.front, set: { ...(self.front !== row.front ? { front: self.front } : {}), back: self.back, category: self.category } };
    }

    // New cards first, so the French is in the deck before the rule card
    // leaves it. A run that stops in between leaves both, never neither.
    for (const c of cards) {
      if (c === self) continue;
      const holder = heldBy(c.front, null);
      if (holder) { skip(c.front, describe(holder)); continue; }
      writes.inserts.push({
        user_id: deck.user_id,
        front: c.front,
        back: c.back,
        category: c.category,
        dates: Array.isArray(row.dates) ? row.dates : [],
        source: row.source ?? null,
      });
      hold({ id: `new:${c.front}`, front: c.front, source: row.source });
    }

    if (refile) {
      writes.retags.push(refile);
      if (refile.set.front) hold({ id: row.id, front: refile.set.front, source: row.source });
    } else {
      writes.archives.push({ id: row.id, front: row.front, set: { source: archivedSource(row.source) } });
    }
  }
  return writes;
}

// ── the database ────────────────────────────────────────────────────────────
// `db` is the REST helper built in main(), or a stand-in in the test. Every
// query this script makes is one of the shapes below.

const PAGE = 1000;
async function allPages(db, query) {
  let rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = await db(query, { headers: { Range: `${from}-${from + PAGE - 1}` } });
    rows = rows.concat(page || []);
    if (!page || page.length < PAGE) break;
  }
  return rows;
}

export const loadSortRows = (db) => allPages(db, "user_cards?select=*&category=in.(G,P)&order=id.asc");

export async function loadEditRows(db, edits) {
  const rows = [];
  for (const e of edits) {
    rows.push(...((await db(`user_cards?select=*&front=eq.${encodeURIComponent(e.front)}&order=id.asc`)) || []));
  }
  return rows;
}

export const loadDeckFronts = (db, userId) =>
  allPages(db, `user_cards?select=id,front,source&user_id=eq.${encodeURIComponent(userId)}&order=id.asc`);

export async function loadRowsById(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const r of (await db(`user_cards?select=*&id=in.(${chunk.join(",")})`)) || []) out.set(String(r.id), r);
  }
  return out;
}

// ── the proposal ────────────────────────────────────────────────────────────

const byDeckThenId = (a, b) =>
  a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : Number(a.id) - Number(b.id);

export async function buildProposal({ db, index, classify = null, log = () => {}, now = new Date() }) {
  const rows = await loadSortRows(db);
  const { decided, pending } = decideRows(rows, index);
  const asked = pending.length ? await askAbout(pending, classify, log) : { items: [], calls: 0 };
  const editRows = await loadEditRows(db, index.edits);
  const edits = planEdits(editRows, index);

  const decks = new Map();
  const deckOf = (userId) => {
    if (!decks.has(userId)) decks.set(userId, { user_id: userId, deck: String(userId).slice(0, 8), items: [], edits: [] });
    return decks.get(userId);
  };
  for (const it of [...decided, ...asked.items].sort(byDeckThenId)) deckOf(it.user_id).items.push(it);
  for (const e of edits.sort(byDeckThenId)) deckOf(e.user_id).edits.push(e);

  // What --apply would do against each deck as it stands, so the skips ("savoir
  // is already a card") are visible at review time and not only afterwards.
  const current = new Map([...rows, ...editRows].map((r) => [String(r.id), r]));
  for (const deck of decks.values()) {
    const touches = deck.edits.length || deck.items.some((it) => it.decision === "convert" || it.decision === "archive");
    deck.preview = touches ? planWrites(deck, current, await loadDeckFronts(db, deck.user_id)) : null;
  }

  return {
    kind: PROPOSAL_KIND,
    createdAt: now.toISOString(),
    model: MODEL,
    decisionsFile: path.relative(ROOT, DECISIONS_FILE),
    claudeCalls: asked.calls,
    decks: [...decks.values()].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
  };
}

const count = (items, decision) => items.filter((it) => it.decision === decision).length;
const q = (s) => JSON.stringify(s);
const cardText = (c) => `${q(c.front)} = ${q(c.back)} (${c.category})`;

// The dry run's printout. Decks are named by the first 8 characters of their
// user id and nothing else: this goes to a terminal, and card text is all the
// owner needs to review.
export function summarize(proposal) {
  const lines = [];
  const decks = proposal.decks || [];
  const all = decks.flatMap((d) => d.items);
  lines.push(`${all.length} grammar/pronunciation card(s) across ${decks.length} deck(s).`);
  lines.push(
    `keep ${count(all, "keep")} · convert ${count(all, "convert")} · archive ${count(all, "archive")} · ` +
      `edit ${decks.reduce((n, d) => n + d.edits.length, 0)} · undecided ${count(all, "undecided")}` +
      ` · Claude calls ${proposal.claudeCalls ?? 0}`
  );
  for (const d of decks) {
    lines.push("");
    lines.push(
      `deck ${d.deck}…  keep ${count(d.items, "keep")} · convert ${count(d.items, "convert")} · ` +
        `archive ${count(d.items, "archive")} · edit ${d.edits.length} · undecided ${count(d.items, "undecided")}`
    );
    const skipped = new Map((d.preview?.skips || []).map((s) => [s.front, s.reason]));
    const note = (front) => (skipped.has(front) ? ` [skip: ${skipped.get(front)}]` : "");
    for (const it of d.items) {
      // A drill kept for its shape needs no review. A "keep" from Claude does:
      // it leaves a card under grammar on the model's word alone, and a line
      // is the only way the owner sees which card that was.
      if (it.decision === "keep" && it.from !== "claude") continue;
      const tag = it.from === "claude" ? " [claude]" : "";
      if (it.decision === "convert") {
        const parts = it.newCards.map(
          (c) => cardText(c) + (normFront(c.front) === normFront(it.front) ? " [re-filed in place, keeps its history]" : "") + note(c.front)
        );
        lines.push(`  convert${tag}  ${q(it.front)}  →  ${parts.join("  +  ")}`);
      } else if (it.decision === "keep") {
        lines.push(`  keep${tag}  ${q(it.front)} = ${q(it.back)}${it.why ? `  — ${it.why}` : ""}`);
      } else if (it.decision === "archive") {
        lines.push(`  archive${tag}  ${q(it.front)}${it.why ? `  — ${it.why}` : ""}`);
      } else {
        lines.push(`  undecided  ${q(it.front)} = ${q(it.back)}  — ${it.error}`);
      }
    }
    for (const e of d.edits) {
      const change = e.newFront !== e.front ? `${q(e.front)} → ${q(e.newFront)}` : q(e.front);
      lines.push(`  edit  ${change}  back: ${q(e.back)} → ${q(e.newBack)}${note(e.front)}`);
    }
  }
  return lines.join("\n");
}

// ── applying a reviewed proposal ────────────────────────────────────────────

export async function applyProposal({ db, proposal, backupDir = path.join(ROOT, "backups"), now = new Date(), log = () => {} }) {
  if (proposal?.kind !== PROPOSAL_KIND || !Array.isArray(proposal.decks)) {
    throw new Error("Not a grammar-sort proposal (run without --apply to make one).");
  }

  // 1. Read everything first: every row the proposal names, as it is now, and
  // every front of each deck it touches. No write happens until all of it is
  // read and backed up.
  const plans = [];
  for (const deck of proposal.decks) {
    const ids = [
      ...deck.items.filter((it) => it.decision === "convert" || it.decision === "archive").map((it) => it.id),
      ...(deck.edits || []).map((e) => e.id),
    ];
    if (!ids.length) continue;
    const current = await loadRowsById(db, ids);
    const writes = planWrites(deck, current, await loadDeckFronts(db, deck.user_id));
    plans.push({ deck, current, writes });
  }

  // 2. Back up every row about to change, whole, plus the cards about to be
  // added (to undo an insert, delete by user_id and front).
  const touched = [];
  for (const { current, writes } of plans) {
    for (const w of [...writes.edits, ...writes.retags, ...writes.archives]) touched.push(current.get(String(w.id)));
  }
  const inserts = plans.flatMap((p) => p.writes.inserts);
  let backupFile = null;
  if (touched.length || inserts.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    backupFile = path.join(backupDir, `grammar-sort-applied-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(
      backupFile,
      JSON.stringify({ proposalCreatedAt: proposal.createdAt, appliedAt: now.toISOString(), rows: touched, inserts }, null, 2)
    );
    log(`Backed up ${touched.length} row(s) to ${path.relative(ROOT, backupFile) || backupFile}`);
  }

  // 3. Write, deck by deck: edits, then new cards, then re-filing, then
  // archiving — so a run cut short never leaves a rule card archived without
  // the French it was converted into. Each update is filtered on the front it
  // was planned against, so a row edited in the last few seconds is left alone.
  const report = [];
  for (const { deck, writes } of plans) {
    const r = { deck: deck.deck, edited: 0, inserted: 0, retagged: 0, archived: 0, alreadyDone: writes.done.length, skips: [...writes.skips] };
    const patch = async (w) =>
      (await db(`user_cards?id=eq.${w.id}&front=eq.${encodeURIComponent(w.front)}`, {
        method: "PATCH",
        body: JSON.stringify(w.set),
      })) || [];

    for (const w of writes.edits) {
      if ((await patch(w)).length) r.edited++;
      else r.skips.push({ front: w.front, reason: "changed while applying" });
    }
    if (writes.inserts.length) {
      // ignore-duplicates: a front that appeared since the plan is left as it
      // is, never overwritten. The response lists only what was inserted.
      const added =
        (await db("user_cards?on_conflict=user_id,front", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify(writes.inserts),
        })) || [];
      r.inserted += added.length;
      const got = new Set(added.map((a) => a.front));
      for (const c of writes.inserts) if (!got.has(c.front)) r.skips.push({ front: c.front, reason: "appeared while applying" });
    }
    for (const w of writes.retags) {
      if ((await patch(w)).length) r.retagged++;
      else r.skips.push({ front: w.front, reason: "changed while applying" });
    }
    for (const w of writes.archives) {
      if ((await patch(w)).length) r.archived++;
      else r.skips.push({ front: w.front, reason: "changed while applying" });
    }
    report.push(r);
  }
  return { backupFile, decks: report };
}

// ── Claude ──────────────────────────────────────────────────────────────────

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          decision: { type: "string", enum: ["keep", "convert", "archive"] },
          why: { type: "string" },
          newCards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                front: { type: "string" },
                back: { type: "string" },
                category: { type: "string", enum: ["V", "E"] },
              },
              required: ["front", "back", "category"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "decision", "why", "newCards"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

// The rules, stated once, followed by the owner's own decisions as the worked
// examples: the reviewed sort IS the standard, so the model is shown it rather
// than a paraphrase of it. Two of the owner's conversions produced a drill (G),
// which Claude is not asked to do, so those two are left out of the examples.
export function systemPrompt(file) {
  const examples = (file.decisions || [])
    .filter((d) => d.decision !== "keep" && !(d.newCards || []).some((c) => c.category === "G"))
    .map((d) => JSON.stringify({ front: d.front, back: d.back, decision: d.decision, ...(d.why ? { why: d.why } : {}), newCards: d.newCards || [] }));
  const keeps = (file.decisions || []).filter((d) => d.decision === "keep").slice(0, 3)
    .map((d) => JSON.stringify({ front: d.front, back: d.back, decision: "keep", newCards: [] }));

  return `You are sorting flashcards in a French learner's deck. The app marks an answer by comparing what the learner types with the other side of the card, so a card is only worth studying if there is something definite to type. There is no microphone: a card about how something sounds cannot be answered.

Every card you are given was filed under grammar or pronunciation. Decide one of three things for each.

keep — the card is already a typeable drill: its front is a prompt and its back is the exact French form to type, e.g. "vivre → je" / "je vis", "aller (subj) → que je" / "que j'aille", "devoir → pp" / "dû". Nothing changes. Only a front shaped "something → something" can be a drill.

convert — the card states a rule, a contrast or a pronunciation point, but real French sits underneath it: a word, a phrase, or a full example sentence written on the card itself. Replace the card with ordinary two-way cards for that French.
- front: the French, as a learner would type it: a noun with its article ("un fils"), a verb in the infinitive ("savoir"), an adjective as "masculine, feminine" ("complet, complète"), a sentence with its capital letter and punctuation.
- back: a natural English translation. Where several translations are equally right, separate them with " / " ("I'm going (there) / I'm off"). A short parenthesis may disambiguate ("to know (a person or a place)", "(tu)" for an informal you).
- category: "V" for one word or one concept, "E" for an expression or a sentence.
- No pronunciation notes, no {respellings}, no grammar terms, no "vs", no explanations, on either side.
- Only French that is on the card. Do not invent new examples. One to three new cards is usual.
- A card that is already an ordinary word or phrase, only filed under grammar ("mon copain" / "my boyfriend"), is converted to itself: the same French front, a clean English back, V or E.

archive — a rule or a pronunciation point with nothing typeable underneath (pronoun tables, "qui = sujet / que = COD", "cela = ça", liaison and silent-letter notes, comparisons of sounds), or one whose only examples are too basic to be worth a card ("du pain"). The card leaves study; nothing is deleted.

The deck's owner sorted these cards by hand. Follow the same judgement:
${[...keeps, ...examples].join("\n")}

Return one result per card, with the card's id. "why" is a few words for the owner reading the proposal. For keep and archive, newCards is an empty list.`;
}

// The real classifier: one Messages call per batch, JSON constrained by the
// schema and then checked again by validateClaudeResult. Opus 5.5 runs
// adaptive thinking whatever you ask (it cannot be turned off), and its
// default effort is medium; this is a one-off pass over someone's deck where a
// wrong archive costs a card, so it runs at high.
export function claudeClassifier({ apiKey, file }) {
  const anthropic = new Anthropic({ apiKey });
  const system = systemPrompt(file);
  return async (cards) => {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "high", format: { type: "json_schema", schema: RESULT_SCHEMA } },
      messages: [{ role: "user", content: `Sort these cards:\n\n${JSON.stringify(cards, null, 2)}` }],
    });
    if (msg.stop_reason === "refusal") throw new Error("the model declined this batch");
    if (msg.stop_reason === "max_tokens") throw new Error("the answer was cut off");
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.results) ? parsed.results : [];
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function restHelper({ url, key }) {
  return async (p, init = {}) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${p}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method || "GET"} ${p.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

async function main(argv) {
  loadEnv();
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\nPut them in .env.local or the environment.");
    process.exit(1);
  }
  const db = restHelper({ url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE_KEY });
  const applyAt = argv.indexOf("--apply");

  if (applyAt >= 0) {
    const file = argv[applyAt + 1];
    if (!file || file.startsWith("--")) {
      console.error("--apply needs the proposal file a dry run wrote, e.g.\n  node scripts/sort-grammar-cards.mjs --apply backups/grammar-sort-proposal-<ts>.json");
      process.exit(1);
    }
    const proposal = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    const { decks } = await applyProposal({ db, proposal, log: (s) => console.log(s) });
    if (!decks.length) console.log("Nothing to write.");
    for (const r of decks) {
      console.log(
        `\ndeck ${r.deck}…  edited ${r.edited} · added ${r.inserted} · re-filed ${r.retagged} · archived ${r.archived} · ` +
          `already done ${r.alreadyDone} · skipped ${r.skips.length}`
      );
      for (const s of r.skips) console.log(`  skip  ${q(s.front)}  — ${s.reason}`);
    }
    return;
  }

  const file = loadDecisions();
  const index = indexDecisions(file);
  const classify = ANTHROPIC_API_KEY ? claudeClassifier({ apiKey: ANTHROPIC_API_KEY, file }) : null;
  const proposal = await buildProposal({ db, index, classify, log: (s) => console.log(s) });

  const dir = path.join(ROOT, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `grammar-sort-proposal-${proposal.createdAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(proposal, null, 2));

  console.log(summarize(proposal));
  if (!classify && proposal.decks.some((d) => d.items.some((it) => it.decision === "undecided"))) {
    console.log("\nANTHROPIC_API_KEY is not set, so cards the reviewed sort doesn't cover were left undecided.");
  }
  console.log(`\nDry run: nothing written to the database. The proposal is in ${path.relative(ROOT, out)}`);
  console.log(`Review it (edit it if you like), then:\n  node scripts/sort-grammar-cards.mjs --apply ${path.relative(ROOT, out)}`);
}

// Only when run, never when imported: the test imports the functions above
// and must not read .env.local or touch the network.
const invoked = process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
