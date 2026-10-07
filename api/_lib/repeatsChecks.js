// Claude's same-or-different question about look-alike cards, tested
// (2026-10-06).
//
// Every card-writer asks Claude whether a new card that looks like one the
// student has is "the same card to learn, or different"
// (api/_lib/sameCardQuestion.js), and the morning check asks it about cards
// already in study (api/_lib/statusDaily.js). A wrong "same" loses a card; a
// wrong "different" makes one twice. The owner asked to "make sure the
// evaluation harness is catching this properly", so the question is tested
// like Claude's marking of answers (answerChecks.js) and its reading of class
// notes (notesChecks.js), with right answers nobody is asked for again:
//
//   the same card: each card the 2026-10-06 clean-up put away as a repeat,
//   with the card it repeats (archived_reason "duplicate" and merged_into,
//   migration_016; scripts/record-cleanup-reasons.mjs writes them for that
//   clean-up). The owner approved that clean-up, card by card. Any card put
//   away as a repeat later, with the card it repeats, becomes a case too.
//
//   the same card, fixed in the repo: a card that is one item of another
//   card's list (LIST_ITEMS in api/_lib/keepApart.js; the owner, 2026-10-07).
//
//   different cards: the pairs in api/_lib/keepApart.js, fixed in the repo.
//
// Each case is asked three times, as the app asks it (the same question,
// model and calls), and the run is kept in eval_runs as kind "repeats". The
// server runs it on its own when it is due (api/cahier-daily.js,
// api/_lib/evalRuns.js); no button starts it. Its version is the question's
// (SAME_CARD_VERSION), so a change to the question makes it due the next day,
// and the red dot rules are the other tests' (api/_lib/evalStatus.js).
//
// The store and the question are passed in, so the rules can be tested
// without a database or Claude (tests/suites/repeat-checks.mjs).

import { createHash } from "node:crypto";
import { askSameCard, SAME_CARD_VERSION, SAME_CARD_MODEL } from "./sameCardQuestion.js";
import { missingTable } from "../../src/lib/dealLog.js";
import { missingColumn } from "../../src/lib/reviewLog.js";
import { outcome, tally } from "./evalRuns.js";
import { KEEP_APART, LIST_ITEMS } from "./keepApart.js";

export const REPEATS_RUNS = 3;
export const REPEATS_PROMPT_VERSION = SAME_CARD_VERSION;
// A run asks about at most this many cases, so it fits in a function's five
// minutes: three rounds of six calls of 50, four calls at a time. Any left
// out are counted in the run's summary.
export const MAX_CASES = 300;

const WAITING = "Waiting for the database update (migration_016).";

// The cases. `duplicates`: rows put away as a repeat ({ id, front, back,
// merged_into }); `kept`: the cards they repeat ({ id, front, back }). Card A
// is the card kept, B the one put away, as a card-writer meets them: the
// card the student has, and the same thing made again.
export function repeatsCases({ duplicates = [], kept = [] } = {}) {
  const byId = new Map(kept.map((c) => [String(c.id), c]));
  const same = [];
  for (const d of duplicates) {
    const k = d.merged_into == null ? null : byId.get(String(d.merged_into));
    if (!k || !d.front || !k.front) continue;
    same.push({ id: `dup:${d.id}`, says: "same", a: { front: k.front, back: k.back }, b: { front: d.front, back: d.back } });
  }
  for (const p of LIST_ITEMS) same.push({ id: `item:${p.id}`, says: "same", a: p.a, b: p.b });
  const apart = KEEP_APART.map((p) => ({ id: `apart:${p.id}`, says: "different", a: p.a, b: p.b }));
  // Mixed, and in the same order every run: a long run of one answer would
  // tell Claude something the real question never does.
  const order = (c) => createHash("sha1").update(c.id).digest("hex");
  return [...same, ...apart].sort((x, y) => (order(x) < order(y) ? -1 : 1));
}

// One case's outcome (api/_lib/evalRuns.js): in how many of the usable
// answers Claude said what the case says. A round that failed counts for
// nothing.
export function repeatsJudge(c) {
  const asked = (c.got || []).filter((v) => v === "same" || v === "different");
  return outcome(asked.filter((v) => v === c.says).length, asked.length);
}

export const summarize = (cases) => tally(cases, repeatsJudge);
export const repeatsPass = (c) => repeatsJudge(c) === "pass";

// The whole test, as the server runs it on its own: every case asked
// REPEATS_RUNS times, in rounds that each put every case to Claude once, and
// the run kept. Returns the run, or { skipped } when there is nothing to test
// or Claude couldn't be asked at all.
export async function runRepeatsTest({ store, apiKey, deadline = Infinity, ask = askSameCard }) {
  const dups = await store.duplicates();
  if (dups.missing) return { skipped: WAITING };
  if (dups.error) throw new Error(dups.error);
  const ids = [...new Set((dups.rows || []).map((r) => r.merged_into).filter((x) => x != null))];
  const kept = ids.length ? await store.cards(ids) : { rows: [] };
  if (kept.error) throw new Error(kept.error);
  const all = repeatsCases({ duplicates: dups.rows || [], kept: kept.rows || [] });
  const chosen = all.slice(0, MAX_CASES);
  if (!chosen.length) return { skipped: "No cases to test yet." };
  const pairs = chosen.map((c) => ({ a: c.a, b: c.b }));
  const rounds = await Promise.all(Array.from({ length: REPEATS_RUNS }, () =>
    ask({ apiKey, pairs, deadline }).catch((error) => ({ error }))));
  const results = chosen.map((c, i) => ({
    id: c.id, says: c.says, a: c.a, b: c.b,
    got: rounds.map((r) => (Array.isArray(r) && (r[i] === "same" || r[i] === "different") ? r[i] : null)),
  }));
  const summary = {
    ...summarize(results),
    same_cases: results.filter((c) => c.says === "same").length,
    different_cases: results.filter((c) => c.says === "different").length,
    left_out: all.length - chosen.length,
  };
  if (!summary.cases) {
    const reason = rounds.find((r) => r && r.error)?.error?.message || "no answer";
    return { skipped: `Claude couldn't be asked: ${reason}` };
  }
  const saved = await store.saveRun({
    kind: "repeats", version: REPEATS_PROMPT_VERSION, model: SAME_CARD_MODEL,
    cases: summary.cases, passed: summary.every, summary, results,
  });
  if (saved.missing) return { skipped: WAITING };
  if (saved.error) throw new Error(saved.error);
  return { run: saved.row, summary };
}

// What a case Claude now gets wrong looks like, in plain words, for the
// morning check and the red dot (api/_lib/evalStatus.js).
export function repeatsSlip(c) {
  const pair = `“${c.a?.front}” and “${c.b?.front}”`;
  return c.says === "same"
    ? `Since the last change to how Claude is asked, it calls ${pair} two different cards, which it judged one card before.`
    : `Since the last change to how Claude is asked, it calls ${pair} the same card, which it kept apart before.`;
}

// The store on Supabase, with the service role. `missing` before
// migration_016: no reason on a card put away, and eval_runs doesn't take the
// kind "repeats" yet.
export function supabaseRepeatsStore(db) {
  const gone = (error) => missingTable(error) || missingColumn(error) || error?.code === "23514";
  const out = ({ data, error }) => (gone(error) ? { missing: true } : error ? { error: error.message } : { rows: data });
  return {
    async duplicates() {
      const r = out(await db.from("user_cards").select("id, front, back, merged_into, archived_reason")
        .eq("archived_reason", "duplicate").order("id", { ascending: true }).limit(2000));
      return r.rows ? { rows: r.rows.filter((x) => x.merged_into != null) } : r;
    },
    async cards(ids) {
      return out(await db.from("user_cards").select("id, front, back").in("id", ids));
    },
    async runs() {
      return out(await db.from("eval_runs").select("id, kind, ran_at, version, model, cases, passed, summary, results").eq("kind", "repeats").order("ran_at", { ascending: false }).limit(10));
    },
    async saveRun(row) {
      const { data, error } = await db.from("eval_runs").insert(row).select("id, kind, ran_at, version, model, cases, passed, summary, results").single();
      return gone(error) ? { missing: true } : error ? { error: error.message } : { row: data };
    },
  };
}
