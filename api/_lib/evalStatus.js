// What the Status window and its red dot need from the tests of Claude's work
// (api/_lib/evalRuns.js): for each test, its last run and the cases a change
// to how Claude is asked made it get wrong, named in plain words. Read with the
// service role by /api/admin-users?view=status, for the admin only, and by the
// morning check (scripts/status-check.mjs --everyone).
//
//   answers  Claude's marking of typed answers
//   notes    Claude reading class notes into cards
//   repeats  Claude judging whether two look-alike cards are the same card
//            (since 2026-10-06; api/_lib/repeatsChecks.js)

import { regressions } from "./evalRuns.js";
import { answerJudge } from "./answerChecks.js";
import { notesJudge } from "./notesChecks.js";
import { repeatsJudge, repeatsSlip } from "./repeatsChecks.js";
import { missingTable } from "../../src/lib/dealLog.js";

const COLUMNS = "id, kind, ran_at, version, model, cases, passed, summary, results";

async function lastTwo(db, kind) {
  const { data, error } = await db.from("eval_runs").select(COLUMNS).eq("kind", kind)
    .order("ran_at", { ascending: false }).limit(2);
  if (missingTable(error)) return { missing: true };
  if (error) return { error: error.message };
  return { latest: data?.[0] || null, previous: data?.[1] || null };
}

const brief = (run) => run && { ran_at: run.ran_at, version: run.version, cases: run.cases, passed: run.passed, summary: run.summary };

export async function evalStatus(db) {
  const out = {};

  const a = await lastTwo(db, "answers");
  if (a.missing || a.error) out.answers = { error: a.error || null, regressions: [] };
  else {
    const ids = regressions(a.latest, a.previous, answerJudge, (c) => c.says);
    let named = [];
    if (ids.length) {
      const { data } = await db.from("answer_reviews").select("id, typed, expected").in("id", ids);
      named = (data || []).map((r) => `Since the last change to how Claude is asked, it gets “${r.typed}” for “${r.expected}” wrong, which it got right before.`);
    }
    out.answers = { latest: brief(a.latest), regressions: named };
  }

  const n = await lastTwo(db, "notes");
  if (n.missing || n.error) out.notes = { error: n.error || null, regressions: [] };
  else {
    const ids = regressions(n.latest, n.previous, notesJudge, (c) => c.date || "");
    let named = [];
    if (ids.length) {
      const { data } = await db.from("parse_corrections").select("id, action, original_front, corrected_front, original_back, corrected_back").in("id", ids);
      named = (data || []).map((c) => (c.action === "delete"
        ? `Since the last change to how your cahier is read, Claude is making “${c.original_front}” into a card again, which you deleted.`
        : c.original_front === c.corrected_front
          ? `Since the last change to how your cahier is read, Claude is writing “${c.original_back}” on “${c.corrected_front}” again, which you corrected to “${c.corrected_back}”.`
          : `Since the last change to how your cahier is read, Claude is making “${c.original_front}” again, which you corrected to “${c.corrected_front}”.`));
    }
    out.notes = { latest: brief(n.latest), regressions: named };
  }

  // Each case carries both cards' text, since half of them (the keep-apart
  // pairs) are no cards in anyone's deck.
  const r = await lastTwo(db, "repeats");
  if (r.missing || r.error) out.repeats = { error: r.error || null, regressions: [] };
  else {
    const ids = new Set(regressions(r.latest, r.previous, repeatsJudge, (c) => c.says));
    const named = (r.latest?.results || []).filter((c) => ids.has(c.id)).map(repeatsSlip);
    out.repeats = { latest: brief(r.latest), regressions: named };
  }

  return out;
}
