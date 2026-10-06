// Claude's marking of typed answers, kept and tested (api/_lib/answerChecks.js):
// every verdict saved in the shape the test needs, only the admin seeing or
// marking them, a test asking Claude again the way the app does, three times
// a case, and a run counted on the server whatever the browser claims.
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
  handleAnswerChecks, readVerdict, verdictRow, summarize, agrees, answerPrompt,
  ANSWER_MODEL, ANSWER_PROMPT_VERSION, ASKS_PER_CASE, TEST_BATCH,
} = await import("../../api/_lib/answerChecks.js");

const KEY = "sk-ant-server";
const STUDENT = { id: "student", email: "student@example.com" };

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

const ask = (store, body, admin = true) => handleAnswerChecks({ body, isAdmin: admin, store, apiKey: KEY });

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

console.log("\n  only the admin");
{
  const store = memoryStore();
  for (const action of ["list", "mark", "test", "save-run"]) {
    const r = await ask(store, { action, id: "r1", ids: ["r1"], cases: [] }, false);
    ck(`a student can't ${action}`, r.status === 403);
  }
  ck("and nothing went to Claude", calls.length === 0);
}

console.log("\n  the list, marking and the test");
{
  const store = memoryStore();
  const typed = ["a toad", "frog", "the frog", "un crapaud", "a frogs", "froggy", "a fog", "a frog!", "an frog", "a frog (animal)"];
  for (const t of typed) {
    await store.save(verdictRow({ user: STUDENT, card_id: "une grenouille", direction: "fr", french: "une grenouille", english: "a frog", expected: "a frog", typed: t, verdict: "reject", reasoning: "" }));
  }
  const list = await ask(store, { action: "list" });
  ck("the admin sees every verdict, newest first, and the question's version",
     list.status === 200 && list.json.reviews.length === 10 && list.json.reviews[0].typed === "a frog (animal)" && list.json.version === ANSWER_PROMPT_VERSION);

  await ask(store, { action: "mark", id: "r1", says: "reject" });
  await ask(store, { action: "mark", id: "r2", says: "accept" });
  await ask(store, { action: "mark", id: "r3", says: "accept" });
  await ask(store, { action: "mark", id: "r4", says: "nonsense" });
  ck("marking saves the owner's call", store.reviews[0].owner_says === "reject" && store.reviews[1].owner_says === "accept");
  ck("anything but accept or reject clears it", store.reviews[3].owner_says === null);

  calls = [];
  verdicts = { "a toad": ["reject"], frog: ["accept"], "the frog": ["accept", "reject", "accept"] };
  const ids = store.reviews.map((r) => r.id);
  const t = await ask(store, { action: "test", ids });
  ck("only the marked answers are tested", t.status === 200 && t.json.results.length === 3, JSON.stringify(t.json));
  ck(`each is asked ${ASKS_PER_CASE} times`, calls.length === 3 * ASKS_PER_CASE, String(calls.length));
  ck("the way the app asks: same model, same question",
     calls.every((c) => c.model === ANSWER_MODEL) &&
     calls.some((c) => c.messages[0].content === answerPrompt({ direction: "fr", french: "une grenouille", expected: "a frog", typed: "a toad" })));
  const byTyped = Object.fromEntries(t.json.results.map((r) => [store.reviews.find((x) => x.id === r.id).typed, r.got]));
  ck("and each answer comes back", byTyped["a toad"].join() === "reject,reject,reject" && byTyped["the frog"].filter((v) => v === "accept").length === 2, JSON.stringify(byTyped));

  for (const r of store.reviews) r.owner_says = "accept";
  calls = [];
  const big = await ask(store, { action: "test", ids });
  ck(`at most ${TEST_BATCH} answers in one go`, big.json.results.length === TEST_BATCH && calls.length === TEST_BATCH * ASKS_PER_CASE);

  const saved = await ask(store, { action: "save-run", cases: [
    { id: "r1", says: "reject", got: ["reject", "reject", "reject"] },
    { id: "r2", says: "accept", got: ["accept", "reject", "accept"] },
    { id: "r3", says: "accept", got: ["reject", "reject", "reject"], every: true },
    { id: "r4", says: "maybe", got: ["accept"] },
  ], passed: 99 });
  ck("a run is counted on the server, whatever the browser says", saved.status === 200 &&
     saved.json.summary.cases === 3 && saved.json.summary.every === 1 && saved.json.summary.sometimes === 1 && saved.json.summary.never === 1 &&
     store.saved[0].passed === 1 && store.saved[0].version === ANSWER_PROMPT_VERSION && store.saved[0].kind === "answers", JSON.stringify(saved.json));
  const after = await ask(store, { action: "list" });
  ck("and listed with the verdicts", after.json.runs.length === 1);

  refuse = true;
  let threw = null;
  try { await ask(store, { action: "test", ids: ["r1"] }); } catch (e) { threw = e; }
  ck("a refused key stops the test rather than scoring Claude wrong", !!threw);
  refuse = false;
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
