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
//   the owner marks what Claude should have said, in the Status window;
//
//   those marks are a test. Each marked answer is put to Claude again, the
//   same way the app asks it, three times over (it can answer differently
//   each time), and the run is saved: "agreed with you every time on 37 of
//   40". Run it after any change to how Claude is asked, and compare.
//
// Reached through /api/review-answer with an `answerChecks` body, because the
// Hobby plan deploys at most 12 routes and there are 12. Admin only:
//
//   list      every saved verdict (all students, newest first), the last
//             test runs, and the version of the question being asked now
//   mark      { id, says: "accept" | "reject" | null } the owner's call
//   test      { ids } (at most TEST_BATCH) marked verdicts put to Claude
//             again, ASKS_PER_CASE times each; nothing is saved
//   save-run  { cases: [{ id, says, got }] } a finished test run, saved
//
// The store is passed in so the rules can be tested without a database
// (tests/suites/answer-checks.mjs).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { missingTable } from "../../src/lib/dealLog.js";

export const ANSWER_MODEL = "claude-opus-5";
export const ASKS_PER_CASE = 3;
export const TEST_BATCH = 8;

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

// A test run's cases, counted. A case passes when Claude agreed with the owner
// every time it was asked; "sometimes" is the ones it can't make its mind up
// about, which are as much a problem as the ones it gets wrong.
export function summarize(cases) {
  let every = 0, sometimes = 0, never = 0;
  for (const c of cases) {
    const asked = (c.got || []).filter((v) => v !== "error");
    const yes = asked.filter((v) => agrees(c.says, v)).length;
    if (asked.length && yes === asked.length) every++;
    else if (yes > 0) sometimes++;
    else never++;
  }
  return { cases: cases.length, every, sometimes, never };
}

const reply = (status, json) => ({ status, json });
const WAITING = "Waiting for the database update (migration_015).";

export async function handleAnswerChecks({ body, isAdmin, store, apiKey }) {
  if (!isAdmin) return reply(403, { error: "Admin only" });
  const action = body?.action;

  if (action === "list") {
    const reviews = await store.list();
    if (reviews.missing) return reply(200, { waiting: WAITING, reviews: [], runs: [], version: ANSWER_PROMPT_VERSION });
    const runs = await store.runs();
    return reply(200, { reviews: reviews.rows, runs: runs.rows || [], version: ANSWER_PROMPT_VERSION, model: ANSWER_MODEL });
  }

  if (action === "mark") {
    const says = body.says === "accept" || body.says === "reject" ? body.says : null;
    if (!body.id) return reply(400, { error: "Which verdict?" });
    const done = await store.mark(body.id, says);
    if (done.missing) return reply(409, { error: WAITING });
    if (done.error) return reply(500, { error: done.error });
    return reply(200, { ok: true, id: body.id, says });
  }

  if (action === "test") {
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, TEST_BATCH) : [];
    if (!ids.length) return reply(400, { error: "Nothing to test." });
    if (!apiKey) return reply(500, { error: "The server has no Anthropic key." });
    const rows = (await store.get(ids)).rows || [];
    const marked = rows.filter((r) => r.owner_says === "accept" || r.owner_says === "reject");
    const results = await Promise.all(marked.map(async (r) => {
      const got = await Promise.all(Array.from({ length: ASKS_PER_CASE }, () =>
        askClaude({ apiKey, direction: r.direction, french: r.front, expected: r.expected, typed: r.typed })
          .then((v) => v.verdict)
          .catch((e) => {
            // A refusal of the key or a rate limit is the whole run's problem,
            // not this case's: say so rather than score it.
            if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.RateLimitError) throw e;
            return "error";
          })));
      return { id: r.id, says: r.owner_says, got };
    }));
    return reply(200, { results, version: ANSWER_PROMPT_VERSION });
  }

  if (action === "save-run") {
    const cases = (Array.isArray(body.cases) ? body.cases : [])
      .filter((c) => c && (c.says === "accept" || c.says === "reject") && Array.isArray(c.got))
      .map((c) => ({ id: c.id, says: c.says, got: c.got.map((v) => (["accept", "reject", "uncertain", "error"].includes(v) ? v : "error")) }));
    if (!cases.length) return reply(400, { error: "Nothing to save." });
    const summary = summarize(cases);
    const saved = await store.saveRun({
      kind: "answers",
      version: ANSWER_PROMPT_VERSION,
      model: ANSWER_MODEL,
      cases: summary.cases,
      passed: summary.every,
      summary,
      results: cases,
    });
    if (saved.missing) return reply(409, { error: WAITING });
    if (saved.error) return reply(500, { error: saved.error });
    return reply(200, { ok: true, summary, run: saved.row });
  }

  return reply(400, { error: "Unknown action" });
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
      return out(await db.from("eval_runs").select("id, kind, ran_at, version, model, cases, passed, summary").eq("kind", "answers").order("ran_at", { ascending: false }).limit(20));
    },
    async saveRun(row) {
      const { data, error } = await db.from("eval_runs").insert(row).select("id, kind, ran_at, version, model, cases, passed, summary").single();
      return missingTable(error) ? { missing: true } : error ? { error: error.message } : { row: data };
    },
  };
}
