// Claude's review of feedback, and the owner's Apply and Dismiss
// (api/_lib/feedbackReview.js): who may ask for a review, that Apply corrects
// the card where it is and touches nothing else on it, and that it refuses a
// card that changed after Claude looked. Runs against an in-memory store and a
// stand-in for Anthropic that counts calls. No browser, nothing leaves the
// machine.

import { createServer } from "node:http";
import { checker } from "../check.mjs";

const ck = checker();

// The stand-in for Anthropic. `answer` is what the next review says.
let calls = [];
let answer = {};
const anthropic = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: JSON.stringify({ front: "", back: "", brief: "", ...answer }) }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;

const { handleFeedbackRequest, shapeReview, SENDER_WINDOW_MS, FEEDBACK_MODEL } =
  await import("../../api/_lib/feedbackReview.js");

const OWNER = { id: "owner", email: "owner@example.com" };
const STUDENT = { id: "student", email: "student@example.com" };
const KEY = "sk-ant-server";
const NOW = Date.parse("2026-10-04T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const SCREENSHOT = "data:image/png;base64,iVBORw0KGgo=";

// The same five operations as supabaseFeedbackStore, on plain arrays.
function memoryStore() {
  const s = {
    entries: [
      { id: 1, user_id: "student", user_email: "student@example.com", message: "colline means hill, not mountain",
        card_context: { front: "une colline", back: "a mountain", category: "vocab", shown_dir: "fr" },
        screenshot: SCREENSHOT, created_at: ago(60_000), resolved_at: null, review: null },
      { id: 2, user_id: "student", user_email: "student@example.com", message: "the card jumps when it flips",
        card_context: null, created_at: ago(SENDER_WINDOW_MS + 60_000), resolved_at: null, review: null },
      { id: 3, user_id: "owner", user_email: "owner@example.com", message: "grimper is to climb",
        card_context: { row_id: 20, front: "grimper", back: "to climb up", category: "vocab" },
        created_at: ago(3_600_000), resolved_at: null, review: null },
    ],
    deck: [
      // Same front in two decks: a review must only ever see the sender's.
      { id: 10, user_id: "student", front: "une colline", back: "a mountain", source: null, stability: 21, reps: 4 },
      { id: 11, user_id: "owner", front: "une colline", back: "a hill", source: null, stability: 9, reps: 2 },
      { id: 20, user_id: "owner", front: "grimper", back: "to climb up", source: "lesson:verbes#abc", stability: 3, reps: 1 },
      { id: 21, user_id: "student", front: "la colline", back: "the hill", source: null, stability: 1, reps: 1 },
    ],
    async feedback(id) { return s.entries.find((f) => f.id === id) || null; },
    async newestUnreviewed(userId, sinceIso) {
      return s.entries
        .filter((f) => f.user_id === userId && !f.review && !f.resolved_at && f.created_at >= sinceIso)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
    },
    async card({ userId, rowId, front, includeArchived = false }) {
      const row = rowId != null
        ? s.deck.find((c) => c.id === rowId && c.user_id === userId)
        : s.deck.find((c) => c.user_id === userId && c.front.toLowerCase() === String(front).toLowerCase());
      if (!row || (!includeArchived && row.source?.startsWith("archived:"))) return null;
      const lesson = row.source?.startsWith("lesson:") ? row.source.slice(7).split("#")[0] : null;
      return { row_id: row.id, front: row.front, back: row.back, lesson, source: row.source ?? null };
    },
    async setSource(rowId, userId, source) {
      Object.assign(s.deck.find((c) => c.id === rowId && c.user_id === userId), { source });
      return { error: null };
    },
    async saveReview(id, review) { Object.assign(s.entries.find((f) => f.id === id), { review }); },
    async updateCard(rowId, userId, { front, back }) {
      const row = s.deck.find((c) => c.id === rowId && c.user_id === userId);
      if (s.deck.some((c) => c !== row && c.user_id === userId && c.front === front)) {
        return { error: { code: "23505", message: "duplicate key" } };
      }
      Object.assign(row, { front, back });
      return { error: null };
    },
    async reopen(id) { Object.assign(s.entries.find((f) => f.id === id), { resolved_at: null, resolution: null }); },
    async resolve(id, note) {
      const f = s.entries.find((x) => x.id === id);
      if (!f.resolved_at) Object.assign(f, { resolved_at: new Date(NOW).toISOString(), resolution: note });
    },
  };
  return s;
}

const run = (store, user, body, extra = {}) =>
  handleFeedbackRequest({ body, user, isAdmin: user === OWNER, store, apiKey: KEY, now: NOW, ...extra });

console.log("\n  the sender's own browser, straight after sending");
{
  const store = memoryStore();
  calls = [];
  answer = { kind: "card", reasoning: "Colline is a hill.", front: "une colline", back: "a hill" };
  const r = await run(store, STUDENT, { action: "review" });
  ck("its newest feedback is reviewed", r.status === 200 && r.json.id === 1 && r.json.review?.kind === "card",
     JSON.stringify(r.json).slice(0, 120));
  ck("the review is saved on the entry", store.entries[0].review?.fix?.back === "a hill");
  ck("one call to Claude, on the review model", calls.length === 1 && calls[0].body.model === FEEDBACK_MODEL,
     `${calls.length} call(s)`);
  const text = calls[0]?.body.messages[0].content.find((b) => b.type === "text")?.text || "";
  ck("Claude sees the sender's card, not the owner's card with the same front",
     /The card in the deck now is the same/.test(text) && store.entries[0].review.card.row_id === 10, text.slice(0, 160));
  ck("the screenshot goes with it", calls[0]?.body.messages[0].content[0]?.type === "image");
  ck("the answer comes back in a fixed shape", calls[0]?.body.output_config?.format?.type === "json_schema");

  calls = [];
  const again = await run(store, STUDENT, { action: "review" });
  ck("asking again reviews nothing more", again.status === 200 && again.json.review === null && calls.length === 0,
     `${calls.length} call(s)`);
  ck("feedback older than the window is left for View feedback", store.entries[1].review === null);
}

console.log("\n  a student can't act on feedback");
{
  const store = memoryStore();
  calls = [];
  for (const action of ["review", "apply", "dismiss"]) {
    const r = await run(store, STUDENT, { action, id: 3 });
    ck(`${action} by id is refused`, r.status === 403, `HTTP ${r.status}`);
  }
  ck("and nothing was spent or changed", calls.length === 0 && !store.entries[2].review && !store.entries[2].resolved_at);
}

console.log("\n  Apply corrects the card where it is");
{
  const store = memoryStore();
  answer = { kind: "card", reasoning: "Colline is a hill.", front: "une colline", back: "a hill" };
  await run(store, OWNER, { action: "review", id: 1 });
  const before = { ...store.deck[0] };
  const r = await run(store, OWNER, { action: "apply", id: 1 });
  const after = store.deck[0];
  ck("the student's card now reads the fix", r.status === 200 && after.back === "a hill", JSON.stringify(r.json));
  ck("same card, schedule untouched",
     after.id === before.id && after.stability === before.stability && after.reps === before.reps);
  ck("the owner's card with the same front is untouched", store.deck[1].back === "a hill" && store.deck[1].stability === 9);
  ck("the entry is resolved, saying what changed",
     !!store.entries[0].resolved_at && /"une colline · a mountain" to "une colline · a hill"/.test(store.entries[0].resolution),
     store.entries[0].resolution);
  ck("another student's card is not reported as the owner's", r.json.own === false);
  const twice = await run(store, OWNER, { action: "apply", id: 1 });
  ck("applying twice is refused", twice.status === 409, `HTTP ${twice.status}`);
}

console.log("\n  Revert undoes an Apply");
{
  const store = memoryStore();
  answer = { kind: "card", reasoning: "Colline is a hill.", front: "une colline", back: "a hill" };
  await run(store, OWNER, { action: "review", id: 1 });
  await run(store, OWNER, { action: "apply", id: 1 });
  const student = await run(store, STUDENT, { action: "revert", id: 1 });
  ck("a student can't revert", student.status === 403 && store.deck[0].back === "a hill", `HTTP ${student.status}`);
  const r = await run(store, OWNER, { action: "revert", id: 1 });
  ck("the card reads as it did before", r.status === 200 && store.deck[0].back === "a mountain" && store.deck[0].id === 10,
     JSON.stringify(r.json));
  ck("its schedule is untouched", store.deck[0].stability === 21 && store.deck[0].reps === 4);
  ck("the entry is open again, review kept",
     !store.entries[0].resolved_at && !store.entries[0].resolution && store.entries[0].review?.fix?.back === "a hill");
  const again = await run(store, OWNER, { action: "apply", id: 1 });
  ck("and can be applied again", again.status === 200 && store.deck[0].back === "a hill", `HTTP ${again.status}`);

  store.deck[0].back = "a hill, a mound"; // edited after the fix went in
  const edited = await run(store, OWNER, { action: "revert", id: 1 });
  ck("an edit made after the fix is never reverted",
     edited.status === 409 && store.deck[0].back === "a hill, a mound" && !!store.entries[0].resolved_at,
     JSON.stringify(edited.json));

  answer = { kind: "app", reasoning: "Flip.", brief: "b" };
  await run(store, OWNER, { action: "review", id: 2 });
  await run(store, OWNER, { action: "dismiss", id: 2 });
  const dismissed = await run(store, OWNER, { action: "revert", id: 2 });
  ck("a dismissed entry can't be reverted", dismissed.status === 409 && !!store.entries[1].resolved_at,
     `HTTP ${dismissed.status}`);
}

console.log("\n  removing a card that shouldn't be in the deck");
{
  const store = memoryStore();
  store.deck.push({ id: 30, user_id: "owner", front: "estar", back: "to be (location or temporary state)",
                    source: "cahier-upload", stability: 5, reps: 3 });
  store.entries.push({ id: 4, user_id: "owner", user_email: "owner@example.com", message: "this is a spanish word, remove it",
    card_context: { row_id: 30, front: "estar", back: "to be (location or temporary state)", category: "vocab" },
    created_at: ago(120_000), resolved_at: null, review: null });
  answer = { kind: "remove", reasoning: "Estar is Spanish, not French." };
  await run(store, OWNER, { action: "review", id: 4 });
  const est = () => store.deck.find((c) => c.id === 30);
  ck("Claude can suggest taking the card out", store.entries[3].review?.kind === "remove"
     && store.entries[3].review.card?.source === "cahier-upload");
  const student = await run(store, STUDENT, { action: "apply", id: 4 });
  ck("a student can't take it out", student.status === 403 && est().source === "cahier-upload", `HTTP ${student.status}`);
  const r = await run(store, OWNER, { action: "apply", id: 4 });
  ck("Apply archives it rather than deleting it",
     r.status === 200 && r.json.removed === true && est()?.source === "archived:cahier-upload", JSON.stringify(r.json));
  ck("its answers and schedule stay with it", est().stability === 5 && est().reps === 3);
  ck("the entry is resolved, saying so", /^Card taken out of the deck, answers kept: "estar/.test(store.entries[3].resolution || ""),
     store.entries[3].resolution);
  const back = await run(store, OWNER, { action: "revert", id: 4 });
  ck("Revert puts it back in the deck", back.status === 200 && est().source === "cahier-upload", JSON.stringify(back.json));
  ck("and reopens the entry", !store.entries[3].resolved_at);

  est().back = "to be";
  const edited = await run(store, OWNER, { action: "apply", id: 4 });
  ck("a card edited since the review isn't taken out", edited.status === 409 && est().source === "cahier-upload",
     JSON.stringify(edited.json));
  ck("a removal with no card to remove becomes no change", shapeReview({ kind: "remove", reasoning: "" }, null).kind === "none");
}

console.log("\n  Apply refuses a card that changed after Claude looked");
{
  const store = memoryStore();
  answer = { kind: "card", reasoning: "Colline is a hill.", front: "une colline", back: "a hill" };
  await run(store, OWNER, { action: "review", id: 1 });
  store.deck[0].back = "a small mountain"; // the student edited it meanwhile
  const r = await run(store, OWNER, { action: "apply", id: 1 });
  ck("refused, asking for a fresh review", r.status === 409 && r.json.code === "card_changed", JSON.stringify(r.json));
  ck("the student's edit stands and the entry stays open",
     store.deck[0].back === "a small mountain" && !store.entries[0].resolved_at);

  store.deck[0].back = "a mountain";
  store.deck.push({ id: 12, user_id: "student", front: "la colline", back: "x" });
  store.entries[0].review = shapeReview(
    { kind: "card", reasoning: "r", front: "la colline", back: "the hill" },
    { row_id: 10, front: "une colline", back: "a mountain", lesson: null }
  );
  const dup = await run(store, OWNER, { action: "apply", id: 1 });
  ck("a fix that would duplicate another card in the deck is refused", dup.status === 409 && /already has a card/.test(dup.json.error),
     JSON.stringify(dup.json));
  ck("and the card is unchanged", store.deck[0].front === "une colline");
}

console.log("\n  the owner's own card, a lesson card");
{
  const store = memoryStore();
  answer = { kind: "card", reasoning: "Plain 'to climb' is right.", front: "grimper", back: "to climb" };
  await run(store, OWNER, { action: "review", id: 3 });
  const text = calls.at(-1)?.body.messages[0].content.find((b) => b.type === "text")?.text || "";
  ck("Claude is told it is a lesson card", /built-in lesson card \(lesson "verbes"\)/.test(text), text.slice(-120));
  const r = await run(store, OWNER, { action: "apply", id: 3 });
  ck("Apply reports the owner's own card, so the deck on screen reloads", r.status === 200 && r.json.own === true,
     JSON.stringify(r.json));
}

console.log("\n  app problems and Dismiss");
{
  const store = memoryStore();
  answer = { kind: "app", reasoning: "That's the flip animation.", brief: "Measure the flip." };
  await run(store, OWNER, { action: "review", id: 2 });
  ck("an app problem keeps its brief and suggests no card", store.entries[1].review.kind === "app"
     && store.entries[1].review.brief === "Measure the flip." && store.entries[1].review.fix === null);
  const apply = await run(store, OWNER, { action: "apply", id: 2 });
  ck("Apply on it is refused", apply.status === 409, `HTTP ${apply.status}`);
  const d = await run(store, OWNER, { action: "dismiss", id: 2 });
  ck("Dismiss resolves it, keeping Claude's reasoning",
     d.status === 200 && /^Dismissed\. Claude's review: That's the flip animation\./.test(store.entries[1].resolution),
     store.entries[1].resolution);
  const again = await run(store, OWNER, { action: "dismiss", id: 2 });
  ck("dismissing twice is refused", again.status === 409, `HTTP ${again.status}`);
}

console.log("\n  a review that suggests nothing usable");
{
  const card = { row_id: 1, front: "une colline", back: "a hill", lesson: null };
  ck("a 'fix' identical to the card becomes no change",
     shapeReview({ kind: "card", reasoning: "", front: "une colline", back: "a hill" }, card).kind === "none");
  ck("a card fix with no card to fix becomes no change",
     shapeReview({ kind: "card", reasoning: "", front: "a", back: "b" }, null).kind === "none");
  ck("an unknown kind becomes no change", shapeReview({ kind: "delete everything" }, card).kind === "none");

  const store = memoryStore();
  calls = [];
  const r = await run(store, OWNER, { action: "review", id: 1 }, { apiKey: null });
  ck("without the server's key nothing is reviewed or saved",
     r.status === 503 && calls.length === 0 && store.entries[0].review === null, `HTTP ${r.status}`);
}

anthropic.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
