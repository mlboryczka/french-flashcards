// Claude's marking of typed answers: asked, kept, and tested (2026-10-06).
//
// "My answer should have been accepted" asks Claude whether a typed answer
// means the same as the card's. Until now only its yeses were kept (as the
// student's accepted alternates); its noes were thrown away, so nobody could
// tell how often it got one wrong. Now:
//
//   every verdict is saved (answer_reviews, migration_015), with the card as
//   shown, what was typed, Claude's reasoning and whether the student then
//   pressed "Accept anyway";
//
//   what Claude should have said comes from what the owner already did
//   (ownerCall): on their own answers, asking for it to be accepted means
//   accept, and "Accept anyway" after a refusal means Claude was wrong. On
//   another student's answer only the owner's mark counts, if they ever make
//   one; nothing waits on it (owner, 2026-10-06: "i marked it right or
//   wrong, why would i need to confirm that again?");
//
//   those calls are a test, run by the server on its own (runAnswerTest,
//   from /api/cahier-daily when evalRuns.isDue says so). Each answer is put
//   to Claude again, the same way the app asks it, three times over (it can
//   answer differently each time), and the run is saved: "agreed every time
//   on 37 of 40".
//
// Reached through /api/review-answer with an `answerChecks` body, because the
// Hobby plan deploys at most 12 routes and there are 12. Admin only:
//
//   list      every saved verdict (all students, newest first) with the call
//             it is judged by, the last runs, and the question's version
//   mark      { id, says: "accept" | "reject" | null } the owner's own call
//             on another student's answer
//
// The store is passed in so the rules can be tested without a database
// (tests/suites/answer-checks.mjs).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { missingTable } from "../../src/lib/dealLog.js";
import { pooled, outcome, tally } from "./evalRuns.js";

export const ANSWER_MODEL = "claude-opus-5";
export const ASKS_PER_CASE = 3;
// A run asks about the most recent answers, at most this many, so it fits in
// a function's five minutes. Any left out are counted in the run's summary.
export const MAX_CASES = 120;
const AT_ONCE = 12;

// The question Claude is asked, word for word as /api/review-answer has asked
// it since before verdicts were kept. Changing a word changes the version
// below, so a test run says which question it tested.
export function answerPrompt({ direction, french, expected, typed }) {
  const shownSide = direction === "fr" ? "French" : "English";
  const expectedSide = direction === "fr" ? "English" : "French";
  return `You are reviewing a French learner's flashcard answer. Decide whether their answer should be accepted as equivalent to the expected answer.

The card showed the ${shownSide} side: "${french || ""}"
The expected ${expectedSide} answer was: "${expected}"
The user typed: "${typed}"

Consider:
- Synonyms and near-synonyms (e.g., "instead of" vs "in place of", "salesperson" vs "salesman")
- Minor phrasing variations that preserve meaning
- Whether the user's answer demonstrates correct understanding
- For French answers, grammatical gender must be correct (un vs une, le vs la)
- For English answers, articles (a/an/the) are interchangeable

Do NOT accept:
- Answers in the wrong language
- Answers with wrong grammatical gender in French
- Answers that mean something different
- Answers that are partially correct but miss the core meaning

Respond with ONLY a JSON object, no other text:
{"verdict": "accept" | "reject" | "uncertain", "reasoning": "one sentence explanation"}`;
}

// Seven characters that change whenever the question or the model does.
export const ANSWER_PROMPT_VERSION = createHash("sha1")
  .update(ANSWER_MODEL)
  .update(answerPrompt({ direction: "fr", french: "\u0001", expected: "\u0002", typed: "\u0003" }))
  .update(answerPrompt({ direction: "en", french: "\u0001", expected: "\u0002", typed: "\u0003" }))
  .digest("hex")
  .slice(0, 7);

// Claude's reply as a verdict. Anything unreadable is "uncertain", which the
// app treats as not accepted.
export function readVerdict(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || "").replace(/```json|```/g, "").trim());
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return { verdict: "uncertain", reasoning: "", readable: false };
  const verdict = ["accept", "reject", "uncertain"].includes(parsed.verdict) ? parsed.verdict : "uncertain";
  return { verdict, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "", readable: true };
}

export async function askClaude({ apiKey, direction, french, expected, typed }) {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: ANSWER_MODEL,
    max_tokens: 1000,
    messages: [{ role: "user", content: answerPrompt({ direction, french, expected, typed }) }],
  });
  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return readVerdict(text);
}

// Whether Claude's verdict is the owner's call. "Uncertain" leaves the answer
// marked wrong, as the app does, so it agrees with "reject".
export const agrees = (says, verdict) => (says === "accept") === (verdict === "accept");

// What Claude should have said about a saved verdict, and where that comes
// from; null when nobody has said. `adminEmail` is the owner's.
//   the owner's own mark, if they made one;
//   on the owner's own answers: "Accept anyway" means accept (Claude was
//   wrong to refuse); an answer accepted before verdicts were kept was
//   accepted at their request; otherwise their asking for it to be accepted
//   is their call when Claude accepted, and moving on without "Accept anyway"
//   is their call when it refused.
export function ownerCall(row, adminEmail) {
  if (row.owner_says === "accept" || row.owner_says === "reject") return { says: row.owner_says, from: "marked" };
  const own = !!adminEmail && String(row.user_email || "").toLowerCase() === adminEmail;
  if (!own) return null;
  if (row.overridden) return { says: "accept", from: "accept-anyway" };
  if (row.source === "kept") return { says: "accept", from: "kept" };
  if (row.verdict === "accept") return { says: "accept", from: "asked" };
  return { says: "reject", from: "left" };
}

// The row saved for one verdict: both sides of the card and what Claude was
// given as the expected answer, so a test can ask it exactly as the app did.
export function verdictRow({ user, card_id, direction, french, english, expected, typed, verdict, reasoning }) {
  return {
    user_id: user.id,
    user_email: user.email || null,
    card_id: String(card_id ?? ""),
    direction: direction === "en" ? "en" : "fr",
    front: String(french ?? ""),
    back: String(english ?? ""),
    expected: String(expected ?? ""),
    typed: String(typed ?? ""),
    verdict,
    reasoning: reasoning || null,
    model: ANSWER_MODEL,
    prompt_version: ANSWER_PROMPT_VERSION,
  };
}

// One case's outcome (api/_lib/evalRuns.js): how many of Claude's usable
// answers agreed with the call. A failed ask counts for nothing either way.
export function answerJudge(c) {
  const asked = (c.got || []).filter((v) => v !== "error");
  return outcome(asked.filter((v) => agrees(c.says, v)).length, asked.length);
}

// A run's cases counted: agreed every time, some of the time, mostly not,
// and not asked at all (left out of the rest).
export const summarize = (cases) => tally(cases, answerJudge);

const reply = (status, json) => ({ status, json });
const WAITING = "Waiting for the database update (migration_015).";

export async function handleAnswerChecks({ body, isAdmin, store, adminEmail }) {
  if (!isAdmin) return reply(403, { error: "Admin only" });
  const action = body?.action;

  if (action === "list") {
    const reviews = await store.list();
    if (reviews.missing) return reply(200, { waiting: WAITING, reviews: [], runs: [], version: ANSWER_PROMPT_VERSION });
    const runs = await store.runs();
    return reply(200, {
      reviews: reviews.rows.map((r) => ({ ...r, call: ownerCall(r, adminEmail) })),
      runs: runs.rows || [],
      version: ANSWER_PROMPT_VERSION,
      model: ANSWER_MODEL,
    });
  }

  if (action === "mark") {
    const says = body.says === "accept" || body.says === "reject" ? body.says : null;
    if (!body.id) return reply(400, { error: "Which verdict?" });
    const done = await store.mark(body.id, says);
    if (done.missing) return reply(409, { error: WAITING });
    if (done.error) return reply(500, { error: done.error });
    return reply(200, { ok: true, id: body.id, says });
  }

  return reply(400, { error: "Unknown action" });
}

export const answerPasses = (c) => answerJudge(c) === "pass";

// The same answer disputed more than once on the same card is one case: the
// first row's id, so it stays the same case from run to run, and the
// strongest call among the rows (a mark, then an accept, then a refusal the
// owner moved on from), so a later "Accept anyway" isn't outvoted by an
// earlier time they moved on.
const STRENGTH = { marked: 3, "accept-anyway": 2, kept: 2, asked: 2, left: 1 };
function cases(rows, adminEmail) {
  const groups = new Map();
  for (const r of rows) {
    const call = ownerCall(r, adminEmail);
    if (!call) continue;
    const key = [r.user_id, r.card_id, r.direction, String(r.typed).trim().toLowerCase()].join("|");
    const g = groups.get(key);
    const newer = !g || Date.parse(r.created_at) >= Date.parse(g.latest);
    if (!g) groups.set(key, { r, call, first: r, latest: r.created_at });
    else {
      if (Date.parse(r.created_at) < Date.parse(g.first.created_at)) g.first = r;
      if (STRENGTH[call.from] > STRENGTH[g.call.from] || (STRENGTH[call.from] === STRENGTH[g.call.from] && newer)) g.call = call;
      if (newer) { g.r = r; g.latest = r.created_at; }
    }
  }
  return [...groups.values()]
    .sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest))
    .map((g) => ({ id: g.first.id, r: g.r, call: g.call }));
}

// The whole test, as the server runs it on its own: every disputed answer with
// a call (the most recent MAX_CASES), each asked ASKS_PER_CASE times, and the
// run saved. Returns the run, or { skipped } when there is nothing to test or
// Claude couldn't be asked at all.
export async function runAnswerTest({ store, apiKey, adminEmail, deadline = Infinity }) {
  const listed = await store.list();
  if (listed.missing) return { skipped: WAITING };
  const all = cases(listed.rows || [], adminEmail);
  const chosen = all.slice(0, MAX_CASES);
  if (!chosen.length) return { skipped: "No answers to test yet." };
  const asks = await pooled(
    chosen.flatMap(({ r }) => Array.from({ length: ASKS_PER_CASE }, () => () =>
      askClaude({ apiKey, direction: r.direction, french: r.front, expected: r.expected, typed: r.typed }).then((v) => v.verdict))),
    AT_ONCE,
    deadline,
  );
  const results = chosen.map(({ id, call }, i) => ({
    id,
    says: call.says,
    from: call.from,
    got: asks.slice(i * ASKS_PER_CASE, (i + 1) * ASKS_PER_CASE).map((v) => (typeof v === "string" ? v : "error")),
  }));
  const summary = { ...summarize(results), left_out: all.length - chosen.length };
  if (!summary.cases) {
    const reason = asks.find((v) => v && v.error)?.error?.message || "no answer";
    return { skipped: `Claude couldn't be asked: ${reason}` };
  }
  const saved = await store.saveRun({
    kind: "answers", version: ANSWER_PROMPT_VERSION, model: ANSWER_MODEL,
    cases: summary.cases, passed: summary.every, summary, results,
  });
  if (saved.missing) return { skipped: WAITING };
  if (saved.error) throw new Error(saved.error);
  return { run: saved.row, summary };
}

// The store on Supabase, with the service role. Each call says `missing` when
// migration_015 hasn't been run, rather than failing.
export function supabaseAnswerStore(db) {
  const out = ({ data, error }) => (missingTable(error) ? { missing: true } : error ? { error: error.message } : { rows: data });
  return {
    async save(row) {
      const { error } = await db.from("answer_reviews").insert(row);
      return missingTable(error) ? { missing: true } : error ? { error: error.message } : { ok: true };
    },
    async overridden({ user_id, card_id, direction, typed }) {
      const { error } = await db.from("answer_reviews").update({ overridden: true })
        .eq("user_id", user_id).eq("card_id", String(card_id)).eq("direction", direction === "en" ? "en" : "fr").eq("typed", typed);
      return missingTable(error) ? { missing: true } : error ? { error: error.message } : { ok: true };
    },
    async list() {
      return out(await db.from("answer_reviews").select("*").order("created_at", { ascending: false }).limit(1000));
    },
    async get(ids) {
      return out(await db.from("answer_reviews").select("*").in("id", ids));
    },
    async mark(id, says) {
      const r = await db.from("answer_reviews")
        .update({ owner_says: says, marked_at: says ? new Date().toISOString() : null })
        .eq("id", id);
      return missingTable(r.error) ? { missing: true } : r.error ? { error: r.error.message } : { ok: true };
    },
    async runs() {
      return out(await db.from("eval_runs").select("id, kind, ran_at, version, model, cases, passed, summary, results").eq("kind", "answers").order("ran_at", { ascending: false }).limit(10));
    },
    async saveRun(row) {
      const { data, error } = await db.from("eval_runs").insert(row).select("id, kind, ran_at, version, model, cases, passed, summary, results").single();
      return missingTable(error) ? { missing: true } : error ? { error: error.message } : { row: data };
    },
  };
}
