// The tutor panel: what it is told, what it shows while the answer is still
// arriving, and what it writes when you add a card.
//
// /api/chat is a real serverless function that costs money, so it is replaced
// here by a local server that speaks the same SSE protocol — and speaks it in
// two chunks with a gap, because "the answer appears as it is generated" is
// the requirement and a single-shot response cannot test it.
import { createServer } from "node:http";
import { openApp, finish, checker, servedDeck } from "../harness.mjs";

const ck = checker();
const deck = await servedDeck();

// Ask about a card the fixture actually has, read back from the fixture so
// this doesn't go stale when the deck changes.
const target = deck.find((c) => /^une colline$/i.test(c.front)) || deck[0];
const ASK = `is ${target.front.replace(/^(une|le|la|les|un)\s+/i, "")} feminine?`;

// Long enough that revealing it in one paint would be obvious.
const LUMP =
  "Amener is for people and apporter is for objects, and the split runs all " +
  "the way through the family: mener and porter underneath, emmener and " +
  "emporter on the way back out. The test is whether the thing walks.";

const PROPOSED = {
  front: "un coteau",
  back: "a hillside",
  category: "vocab",
  note: "the near-synonym you'll meet next",
};

// ── The stand-in tutor endpoint ────────────────────────────────────────────
// Holds the stream open between the two halves of the answer so the test can
// look at the screen mid-generation.
const requests = [];
let releaseSecondHalf;
const gate = new Promise((r) => { releaseSecondHalf = r; });

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    return res.end();
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body || "{}"));

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Access-Control-Allow-Origin": "*",
  });
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  if (requests.length === 1) {
    send({ type: "text", delta: "Yes — colline is feminine. " });
    await gate;
    send({ type: "text", delta: "You already have it in your deck." });
    send({ type: "cards", cards: [PROPOSED] });
    send({ type: "done" });
    res.end();
    return;
  }

  // Second exchange: everything in one lump, after a pause. Real deltas arrive
  // unevenly and adaptive thinking delays the first one, so this is the shape
  // the reveal buffer exists for.
  setTimeout(() => {
    send({ type: "text", delta: LUMP });
    send({ type: "done" });
    res.end();
  }, 600);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ── Drive it ───────────────────────────────────────────────────────────────
const adds = [];
const { browser, page } = await openApp({
  route: async (p) => {
    // continue() rather than fulfill(): fulfill buffers the whole body, which
    // would make every stream arrive in one piece and quietly defeat the point.
    await p.route("**/api/chat", (r) =>
      r.continue({ url: `http://127.0.0.1:${PORT}/chat` })
    );
    // Catch the deck write without needing the mock to grow a POST handler.
    await p.route("**/rest/v1/user_cards*", async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      adds.push(JSON.parse(r.request().postData() || "null"));
      await r.fulfill({
        status: 201,
        headers: { "Access-Control-Allow-Origin": "*" },
        contentType: "application/json",
        body: "[]",
      });
    });
  },
});

await page.click("[data-tutor-toggle]");
await page.waitForSelector("textarea[placeholder*='Ask about']", { timeout: 8000 });
await page.fill("textarea[placeholder*='Ask about']", ASK);
await page.click("button:text-is('Send')");

// ── While the answer is still arriving ─────────────────────────────────────
await page.waitForFunction(
  () => /colline is feminine/i.test(document.body.innerText),
  null,
  { timeout: 8000 }
);
const midStream = await page.evaluate(() => document.body.innerText);
ck(
  "the first half of the answer is on screen before the response completes",
  /colline is feminine/i.test(midStream) && !/already have it/i.test(midStream),
  midStream.includes("already have it") ? "the whole answer arrived at once" : ""
);

releaseSecondHalf();
await page.waitForFunction(
  () => /already have it in your deck/i.test(document.body.innerText),
  null,
  { timeout: 8000 }
);
ck("the rest of the answer follows into the same bubble", true);

// ── What the endpoint was told ─────────────────────────────────────────────
const sent = requests[0] || {};
const related = (sent.context?.relatedCards || []).map((c) => c.front);
ck(
  "the tutor is told about the deck cards this question is about",
  related.includes(target.front),
  related.length ? related.join(", ") : "no relatedCards sent"
);
ck(
  "the deck context rides in the request body, not welded onto the question",
  typeof sent.context === "object" &&
    !/\[Context\]/.test(sent.messages?.[sent.messages.length - 1]?.content || ""),
  JSON.stringify(sent.messages?.[sent.messages.length - 1]?.content || "").slice(0, 120)
);

// ── The proposed card ──────────────────────────────────────────────────────
await page.waitForSelector("[data-proposed-card]", { timeout: 8000 });
ck("a proposed card is offered", await page.locator("[data-proposed-card]").count() === 1);

// The requirement: you can correct a card BEFORE it enters your deck, because
// once it is in, a wrong front is months of wrong reviews.
await page.click("[data-proposed-card] button:has-text('Edit')");
const frontInput = page.locator("[data-proposed-card] input").first();
ck("editing exposes the front as a field", await frontInput.count() === 1);

const CORRECTED = "le coteau";
await frontInput.fill(CORRECTED);
// The lesson sync writes its own 108 cards on mount, so the deck's write log
// already has an entry. Only what happens from here is the tutor's doing.
adds.length = 0;
await page.click("[data-proposed-card] button:text-is('Add')");
await page.waitForSelector("[data-proposed-card] button:text-is('Added')", { timeout: 8000 });

const written = adds[0] || {};
ck(
  "the card that gets written is the edited one, not the proposal",
  written.front === CORRECTED,
  JSON.stringify(written.front)
);
// `dates` are the LESSON dates a word appeared on. A card invented in a chat
// appeared on none, and stamping today made tutor cards outrank real ones in
// the frequency sort.
ck(
  "a tutor card claims no lesson dates",
  !("dates" in written),
  JSON.stringify(written.dates)
);
ck("it is tagged as coming from the tutor", written.source === "tutor-chat", written.source);

// ── The wait, and the shape of the reveal ──────────────────────────────────
// Two requirements: the answer bubble shows it is working rather than sitting
// empty while the model thinks, and the text that follows arrives evenly
// rather than in the lumps the network delivered.
await page.fill("textarea[placeholder*='Ask about']", "and emmener?");
await page.click("button:text-is('Send')");

await page.waitForSelector(".tutor-dot", { timeout: 4000 });
const dotsBeforeText = await page.evaluate(() => {
  const dots = document.querySelectorAll(".tutor-dot").length;
  return { dots, lumpShowing: /the thing walks/.test(document.body.innerText) };
});
ck(
  "while the model is thinking the bubble shows activity, not an empty box",
  dotsBeforeText.dots === 3 && !dotsBeforeText.lumpShowing,
  JSON.stringify(dotsBeforeText)
);

// Sample the bubble as it fills and record how much appears between frames.
const jumps = await page.evaluate(() => {
  return new Promise((resolve) => {
    const steps = [];
    let last = 0;
    const started = Date.now();
    const tick = () => {
      const el = [...document.querySelectorAll("div")]
        .filter((d) => /Amener is for people/.test(d.textContent) && d.children.length <= 2)
        .pop();
      const n = el ? el.textContent.length : 0;
      if (n !== last) { steps.push(n - last); last = n; }
      if (/the thing walks/.test(document.body.innerText) || Date.now() - started > 8000) {
        return resolve({ steps, total: last });
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
});
const biggest = Math.max(...jumps.steps, 0);
ck(
  "the answer is revealed over many frames, not pasted in at once",
  jumps.steps.length >= 8,
  `${jumps.steps.length} steps for ${jumps.total} chars`
);
// The buffer takes a tenth of its backlog per frame, so the first step off a
// full lump is the largest; nothing should ever land as one paint.
ck(
  "no single frame dumps the whole answer",
  biggest < jumps.total * 0.5,
  `biggest step ${biggest} of ${jumps.total}`
);

server.close();
await finish(browser, ck);
