// Claude's marking of typed answers, kept and tested (api/_lib/answerChecks.js,
// api/_lib/evalRuns.js): every verdict saved in the shape the test needs; what
// Claude should have said taken from what the owner already did, never asked
// again; only the admin seeing them; the test the server runs on its own,
// asking Claude again the way the app does, three times a case; when it is
// due; and the red dot only for something Claude had got right before.
// Against an in-memory store and a stand-in for Anthropic that counts calls.
// No browser, nothing leaves the machine.

import { createServer } from "node:http";
import { checker } from "../check.mjs";

const ck = checker();

// The stand-in for Anthropic: `verdicts` maps a typed answer to what Claude
// says about it, in turn, call after call.
let calls = [];
let verdicts = {};
let refuse = false;
const anthropic = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    calls.push(parsed);
    if (refuse) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    const typed = /The user typed: "([^"]*)"/.exec(parsed.messages?.[0]?.content || "")?.[1];
    const list = verdicts[typed] || ["reject"];
    const verdict = list[(calls.filter((c) => c.messages?.[0]?.content.includes(`typed: "${typed}"`)).length - 1) % list.length];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: JSON.stringify({ verdict, reasoning: `stand-in says ${verdict}` }) }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;

const {
  handleAnswerChecks, readVerdict, verdictRow, summarize, agrees, answerPrompt, ownerCall, runAnswerTest, answerPasses, answerJudge,
  ANSWER_MODEL, ANSWER_PROMPT_VERSION, ASKS_PER_CASE,
} = await import("../../api/_lib/answerChecks.js");
const { isDue, regressions, pooled } = await import("../../api/_lib/evalRuns.js");

const KEY = "sk-ant-server";
const STUDENT = { id: "student", email: "student@example.com" };
const OWNER = { id: "owner", email: "owner@example.com" };

// The same calls as supabaseAnswerStore, on plain arrays. `missing` stands for
// a database before migration_015.
function memoryStore({ missing = false } = {}) {
  const s = { reviews: [], saved: [], seq: 0 };
  const gone = { missing: true };
  return Object.assign(s, {
    async save(row) { if (missing) return gone; s.reviews.push({ id: `r${++s.seq}`, overridden: false, owner_says: null, source: "asked", ...row }); return { ok: true }; },
    async list() { return missing ? gone : { rows: [...s.reviews].reverse() }; },
    async get(ids) { return missing ? gone : { rows: s.reviews.filter((r) => ids.includes(r.id)) }; },
    async mark(id, says) { if (missing) return gone; const r = s.reviews.find((x) => x.id === id); if (r) r.owner_says = says; return { ok: true }; },
    async runs() { return missing ? gone : { rows: s.saved }; },
    async saveRun(row) { if (missing) return gone; const run = { id: `run${s.saved.length + 1}`, ...row }; s.saved.push(run); return { row: run }; },
  });
}

const ask = (store, body, admin = true) => handleAnswerChecks({ body, isAdmin: admin, store, adminEmail: OWNER.email });

console.log("\n  reading Claude's reply");
{
  ck("a plain verdict", readVerdict('{"verdict":"accept","reasoning":"same meaning"}').verdict === "accept");
  ck("one wrapped in a code fence", readVerdict('```json\n{"verdict":"reject","reasoning":"x"}\n```').verdict === "reject");
  ck("an unknown verdict is uncertain", readVerdict('{"verdict":"maybe"}').verdict === "uncertain");
  const junk = readVerdict("I think so");
  ck("and a reply that isn't JSON is uncertain, and says it couldn't be read", junk.verdict === "uncertain" && junk.readable === false);
}

console.log("\n  what is saved for each verdict");
{
  const row = verdictRow({
    user: STUDENT, card_id: "une grenouille", direction: "fr", french: "une grenouille", english: "a frog",
    expected: "a frog", typed: "a toad", verdict: "reject", reasoning: "a toad is another animal",
  });
  ck("the student, the card's two sides, what was expected and what was typed",
     row.user_id === "student" && row.user_email === "student@example.com" && row.front === "une grenouille" &&
     row.back === "a frog" && row.expected === "a frog" && row.typed === "a toad", JSON.stringify(row));
  ck("Claude's verdict and reason, the model and the question's version",
     row.verdict === "reject" && row.reasoning === "a toad is another animal" && row.model === ANSWER_MODEL &&
     row.prompt_version === ANSWER_PROMPT_VERSION && /^[0-9a-f]{7}$/.test(ANSWER_PROMPT_VERSION));
  ck("the English side asked becomes direction en", verdictRow({ user: STUDENT, direction: "en", typed: "x", verdict: "accept" }).direction === "en");
  ck("the question names the typed and the expected answer",
     answerPrompt({ direction: "fr", french: "une grenouille", expected: "a frog", typed: "a toad" }).includes('The user typed: "a toad"'));
}

console.log("\n  agreeing with the owner");
{
  ck("accept agrees with accept", agrees("accept", "accept"));
  ck("uncertain leaves the answer wrong, so it agrees with reject", agrees("reject", "uncertain") && !agrees("accept", "uncertain"));
  const s = summarize([
    { says: "accept", got: ["accept", "accept", "accept"] },
    { says: "reject", got: ["reject", "accept", "uncertain"] },
    { says: "accept", got: ["reject", "reject", "reject"] },
    { says: "reject", got: ["reject", "error", "reject"] },
  ]);
  ck("every time, sometimes and never are counted apart; a failed ask doesn't count against Claude",
     s.cases === 4 && s.every === 2 && s.sometimes === 1 && s.never === 1, JSON.stringify(s));
}

console.log("\n  what Claude should have said, from what the owner already did");
{
  const ADMIN = "owner@example.com";
  const own = { user_email: "Owner@Example.com", source: "asked", overridden: false, owner_says: null };
  ck("their Accept anyway after a refusal: accept (Claude was wrong)",
     JSON.stringify(ownerCall({ ...own, verdict: "reject", overridden: true }, ADMIN)) === '{"says":"accept","from":"accept-anyway"}');
  ck("an answer accepted before decisions were kept: accept", ownerCall({ ...own, source: "kept", verdict: "accept" }, ADMIN).says === "accept");
  ck("Claude accepting what they asked to be accepted: accept", ownerCall({ ...own, verdict: "accept" }, ADMIN).from === "asked");
  ck("a refusal they moved on from: refuse", JSON.stringify(ownerCall({ ...own, verdict: "reject" }, ADMIN)) === '{"says":"reject","from":"left"}');
  ck("their own mark beats all of that", ownerCall({ ...own, verdict: "reject", overridden: true, owner_says: "reject" }, ADMIN).says === "reject");
  ck("another student's answer has no call until the owner marks it",
     ownerCall({ ...own, user_email: "student@example.com", verdict: "reject", overridden: true }, ADMIN) === null &&
     ownerCall({ ...own, user_email: "student@example.com", owner_says: "accept" }, ADMIN).from === "marked");
  ck("and with no owner known, only marks count", ownerCall({ ...own, verdict: "accept" }, "") === null);
}

console.log("\n  only the admin");
{
  const store = memoryStore();
  for (const action of ["list", "mark"]) {
    const r = await ask(store, { action, id: "r1" }, false);
    ck(`a student can't ${action}`, r.status === 403);
  }
  ck("and nothing went to Claude", calls.length === 0);
}

console.log("\n  the list and a mark");
{
  const store = memoryStore();
  await store.save(verdictRow({ user: OWNER, card_id: "une grenouille", direction: "fr", french: "une grenouille", english: "a frog", expected: "a frog", typed: "frog", verdict: "accept", reasoning: "" }));
  await store.save(verdictRow({ user: STUDENT, card_id: "une grenouille", direction: "fr", french: "une grenouille", english: "a frog", expected: "a frog", typed: "a toad", verdict: "accept", reasoning: "" }));
  const list = await ask(store, { action: "list" });
  ck("every verdict, newest first, each with the call it's judged by",
     list.status === 200 && list.json.reviews.length === 2 && list.json.reviews[0].typed === "a toad" &&
     list.json.reviews[0].call === null && list.json.reviews[1].call.from === "asked", JSON.stringify(list.json.reviews.map((r) => r.call)));
  await ask(store, { action: "mark", id: "r2", says: "reject" });
  await ask(store, { action: "mark", id: "r1", says: "nonsense" });
  ck("a mark on another student's answer is saved, and anything but accept or reject clears one",
     store.reviews[1].owner_says === "reject" && store.reviews[0].owner_says === null);
  const gone = await ask(store, { action: "test", ids: ["r1"] });
  ck("there's no test to start by hand any more", gone.status === 400);
}

console.log("\n  the test, as the server runs it on its own");
{
  const store = memoryStore();
  const add = (user, typed, verdict, extra = {}) => store.save(verdictRow({ user, card_id: "une grenouille", direction: "fr", french: "une grenouille", english: "a frog", expected: "a frog", typed, verdict, reasoning: "" })).then(() => Object.assign(store.reviews.at(-1), extra));
  await add(OWNER, "frog", "accept");                          // Claude right, by their asking
  await add(OWNER, "the frog", "reject", { overridden: true }); // Claude wrong: they pressed Accept anyway
  await add(OWNER, "a toad", "reject");                        // Claude right: they moved on
  await add(STUDENT, "a fog", "accept");                       // nobody's call: left out
  calls = [];
  verdicts = { frog: ["accept"], "the frog": ["accept", "reject", "accept"], "a toad": ["reject"] };
  const done = await runAnswerTest({ store, apiKey: KEY, adminEmail: OWNER.email });
  ck("only answers with a call are asked about, three times each", calls.length === 3 * ASKS_PER_CASE && done.summary.cases === 3, String(calls.length));
  ck("the way the app asks: same model, same question",
     calls.every((c) => c.model === ANSWER_MODEL) &&
     calls.some((c) => c.messages[0].content === answerPrompt({ direction: "fr", french: "une grenouille", expected: "a frog", typed: "a toad" })));
  ck("counted: agreed every time on two, some of the time on one",
     JSON.stringify([done.summary.every, done.summary.sometimes, done.summary.never, done.summary.untried]) === "[2,1,0,0]", JSON.stringify(done.summary));
  const run = store.saved[0];
  ck("the run is kept, with each answer's call and where it came from",
     run.kind === "answers" && run.version === ANSWER_PROMPT_VERSION && run.passed === 2 &&
     run.results.find((c) => c.says === "accept" && c.from === "accept-anyway") && run.results.every((c) => c.got.length === ASKS_PER_CASE));
  ck("a case passes only when Claude agreed every time",
     answerPasses({ says: "accept", got: ["accept", "accept", "error"] }) && !answerPasses({ says: "accept", got: ["accept", "reject", "accept"] }) &&
     !answerPasses({ says: "reject", got: ["error", "error", "error"] }));

  const twice = memoryStore();
  await twice.save(verdictRow({ user: OWNER, card_id: "un chat", direction: "fr", french: "un chat", english: "a cat", expected: "a cat", typed: "cat", verdict: "reject", reasoning: "" }));
  twice.reviews[0].created_at = "2026-10-01T10:00:00Z";
  await twice.save(verdictRow({ user: OWNER, card_id: "un chat", direction: "fr", french: "un chat", english: "a cat", expected: "a cat", typed: "Cat ", verdict: "reject", reasoning: "" }));
  Object.assign(twice.reviews[1], { created_at: "2026-10-05T10:00:00Z", overridden: true });
  calls = [];
  verdicts = { cat: ["accept"], "Cat ": ["accept"] };
  const merged = await runAnswerTest({ store: twice, apiKey: KEY, adminEmail: OWNER.email });
  const one = twice.saved[0]?.results || [];
  ck("the same answer disputed twice is one case, kept under its first id, judged by the stronger call",
     one.length === 1 && one[0].id === "r1" && one[0].says === "accept" && one[0].from === "accept-anyway" && calls.length === ASKS_PER_CASE,
     JSON.stringify(one));

  refuse = true;
  calls = [];
  const refused = await runAnswerTest({ store, apiKey: KEY, adminEmail: OWNER.email });
  ck("a refused key skips the run rather than keeping one where Claude got everything wrong",
     !!refused.skipped && /couldn't be asked/.test(refused.skipped) && store.saved.length === 1, JSON.stringify(refused));
  refuse = false;

  const empty = await runAnswerTest({ store: memoryStore(), apiKey: KEY, adminEmail: OWNER.email });
  ck("nothing to test: skipped, nothing kept", !!empty.skipped);
}

console.log("\n  when it runs, and what lights the red dot");
{
  const now = Date.parse("2026-10-20T15:00:00Z");
  const run = (days, version = ANSWER_PROMPT_VERSION) => ({ ran_at: new Date(now - days * 86400000).toISOString(), version });
  ck("never run: due", isDue(null, ANSWER_PROMPT_VERSION, now));
  ck("run yesterday with today's question: not due", !isDue(run(1), ANSWER_PROMPT_VERSION, now));
  ck("the question changed since: due the next morning", isDue(run(1, "0000000"), ANSWER_PROMPT_VERSION, now));
  ck("a week since the last run, give or take the hour the schedule fires in: due",
     isDue(run(7), ANSWER_PROMPT_VERSION, now) && isDue(run(6.99), ANSWER_PROMPT_VERSION, now) && !isDue(run(6), ANSWER_PROMPT_VERSION, now));
  const right = ["accept", "accept", "accept"];
  const previous = { version: "v1", results: [
    { id: "a", says: "accept", got: right },
    { id: "b", says: "reject", got: right },
    { id: "d", says: "accept", got: right },
    { id: "e", says: "reject", got: ["reject", "reject", "reject"] },
    { id: "f", says: "accept", got: right },
  ] };
  const latest = { version: "v2", results: [
    { id: "a", says: "accept", got: ["accept", "reject", "reject"] },   // right before the change, mostly wrong after
    { id: "b", says: "reject", got: right },                            // always wrong
    { id: "c", says: "accept", got: ["reject", "reject", "reject"] },   // new
    { id: "d", says: "accept", got: ["accept", "reject", "accept"] },   // one ask in three: chance
    { id: "e", says: "accept", got: ["reject", "reject", "reject"] },   // the owner's call changed
    { id: "f", says: "accept", got: ["error", "error", "error"] },      // never asked
  ] };
  ck("after a change, the dot is for what Claude got right before and mostly wrong now: not what it always got wrong, a new case, one wavering answer, a case whose right answer changed, or one never asked",
     JSON.stringify(regressions(latest, previous, answerJudge, (c) => c.says)) === '["a"]', JSON.stringify(regressions(latest, previous, answerJudge, (c) => c.says)));
  ck("two runs with nothing changed between them light nothing, however they differ",
     regressions({ ...latest, version: "v1" }, previous, answerJudge, (c) => c.says).length === 0);
  ck("the first run lights nothing", regressions(latest, null, answerJudge).length === 0);
  const counted = summarize(latest.results);
  ck("a case never asked is left out of the count and reported apart",
     counted.cases === 5 && counted.untried === 1, JSON.stringify(counted));
  const started = [];
  const out = await pooled([0, 1, 2, 3].map((i) => async () => { started.push(i); return i; }), 2, -1);
  ck("past the time limit, nothing more is started", started.length === 0 && out.every((v) => v === null));
}

console.log("\n  what the Status window is told");
{
  const { evalStatus } = await import("../../api/_lib/evalStatus.js");
  // A stand-in for the few Supabase queries evalStatus makes.
  const tables = {
    eval_runs: [
      { id: "n2", kind: "notes", ran_at: "2026-10-13T16:00:00Z", version: "v2", cases: 2, passed: 0, results: [{ id: "c1", date: "2025-09-22", repeated: [true, true, false] }, { id: "c2", date: "2025-10-21", repeated: [true, true, true] }] },
      { id: "n1", kind: "notes", ran_at: "2026-10-06T16:00:00Z", version: "v1", cases: 2, passed: 1, results: [{ id: "c1", date: "2025-09-22", repeated: [false, false, false] }, { id: "c2", date: "2025-10-21", repeated: [true, true, true] }] },
      { id: "a1", kind: "answers", ran_at: "2026-10-06T15:00:00Z", version: "v", cases: 1, passed: 1, results: [{ id: "r1", says: "accept", got: ["accept", "accept", "accept"] }] },
    ],
    parse_corrections: [
      { id: "c1", action: "edit", original_front: "une propositiond", corrected_front: "une proposition" },
      { id: "c2", action: "delete", original_front: "Naza" },
    ],
    answer_reviews: [],
  };
  const query = (rows) => {
    let out = [...rows];
    const q = {
      select: () => q,
      eq: (k, v) => { out = out.filter((r) => r[k] === v); return q; },
      in: (k, vs) => { out = out.filter((r) => vs.includes(r[k])); return q; },
      order: (k, { ascending }) => { out.sort((a, b) => (a[k] < b[k] ? -1 : 1) * (ascending ? 1 : -1)); return q; },
      limit: (n) => { out = out.slice(0, n); return q; },
      then: (ok) => ok({ data: out, error: null }),
    };
    return q;
  };
  const db = { from: (t) => query(tables[t]) };
  const st = await evalStatus(db);
  ck("a mistake Claude had stopped making, made again after a change, is named for the red dot",
     st.notes.regressions.length === 1 && /“une propositiond” again, which you corrected to “une proposition”/.test(st.notes.regressions[0]), JSON.stringify(st.notes.regressions));
  ck("one it has always made isn't", !st.notes.regressions.some((t) => /Naza/.test(t)));
  ck("a test with one run has nothing to compare, so nothing is named", st.answers.regressions.length === 0 && st.answers.latest.passed === 1);
}

console.log("\n  before the database update");
{
  const store = memoryStore({ missing: true });
  const list = await ask(store, { action: "list" });
  ck("the list says it is waiting for it", list.status === 200 && /migration_015/.test(list.json.waiting || ""));
  const mark = await ask(store, { action: "mark", id: "r1", says: "accept" });
  ck("marking says so too", mark.status === 409);
}

anthropic.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
