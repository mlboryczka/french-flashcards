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
  if (requests.length === 2) {
    setTimeout(() => {
      send({ type: "text", delta: LUMP });
      send({ type: "done" });
      res.end();
    }, 600);
    return;
  }

  // Third: proposes a card the deck already has, under a different gloss.
  if (requests.length === 3) {
    send({ type: "text", delta: "Think of what you would climb on a walk. **Feminine**, too." });
    send({ type: "cards", cards: [{ front: target.front, back: "a small mountain", category: "vocab" }] });
    send({ type: "done" });
    res.end();
    return;
  }

  // Fourth: the function dies mid-answer. No "done", no error — just the end.
  send({ type: "text", delta: "The short answer is that it depends on" });
  setTimeout(() => res.end(), 200);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ── Drive it ───────────────────────────────────────────────────────────────
const adds = [];
let deckGets = 0;
const { browser, page } = await openApp({
  route: async (p) => {
    // continue() rather than fulfill(): fulfill buffers the whole body, which
    // would make every stream arrive in one piece and quietly defeat the point.
    await p.route("**/api/chat", (r) =>
      r.continue({ url: `http://127.0.0.1:${PORT}/chat` })
    );
    // Catch the deck write without needing the mock to grow a POST handler.
    await p.route("**/rest/v1/user_cards*", async (r) => {
      if (r.request().method() === "GET") deckGets++;
      if (r.request().method() !== "POST") return r.continue();
      const row = JSON.parse(r.request().postData() || "null");
      adds.push(row);
      // Answer the way PostgREST does for insert().select(): the written row,
      // with the id the database gave it.
      await r.fulfill({
        status: 201,
        headers: { "Access-Control-Allow-Origin": "*" },
        contentType: "application/json",
        body: JSON.stringify([{ id: 990000 + adds.length, created_at: new Date().toISOString(), ...row }]),
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
const getsBeforeAdd = deckGets;
await page.click("[data-proposed-card] button:text-is('Add')");
await page.waitForSelector("[data-proposed-card] button:text-is('Added')", { timeout: 8000 });
await page.waitForTimeout(800);
// Adding used to refetch the entire deck on every click.
ck("adding a card does not refetch the deck", deckGets === getsBeforeAdd, `${deckGets - getsBeforeAdd} refetch(es)`);

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

// ── What the next turn carries back ────────────────────────────────────────
// Deck context rides on the latest question only, so earlier turns have to
// keep what grounded them or a follow-up loses its subject.
{
  const second = requests[1] || {};
  const firstQ = second.messages?.[0] || {};
  const firstA = second.messages?.[1] || {};
  ck(
    "an earlier question goes back with the card that was on screen",
    typeof firstQ.about === "string" && firstQ.about.length > 0,
    JSON.stringify(firstQ).slice(0, 160)
  );
  ck(
    "an earlier answer goes back with the cards it proposed",
    (firstA.cards || []).some((c) => c.front === PROPOSED.front),
    JSON.stringify(firstA).slice(0, 160)
  );
}

// ── Focus stays in the box ─────────────────────────────────────────────────
// The box used to be disabled while the answer streamed, which dropped focus,
// and nothing gave it back: every follow-up needed a click first.
ck(
  "after an answer the question box still has focus",
  await page.evaluate(() => document.activeElement?.matches?.("[data-tutor-panel] textarea")),
  await page.evaluate(() => document.activeElement?.tagName)
);

// ── New chat ───────────────────────────────────────────────────────────────
await page.click("[data-tutor-new-chat]");
await page.waitForTimeout(200);
ck(
  "New chat clears the thread",
  await page.locator("[data-proposed-card]").count() === 0 &&
    !(await page.evaluate(() => /the thing walks/.test(document.body.innerText))),
  ""
);

// ── The card on screen, beside the panel ───────────────────────────────────
// Studying with the tutor open: the header shows what the card ASKS, never its
// answer, and the study keys still work while you're not using the panel.
const chip = () => page.locator("[data-tutor-context]").innerText().catch(() => "");
// Answer until the card on screen is an English-prompt card: the case where
// the header used to show the French answer.
await page.click("button:text-is('EN→FR')");
await page.waitForTimeout(500);
// The last click was outside the panel (the direction button), so the key is
// the card's.
{
  const beforeKey = await chip();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  ck(
    "with the tutor beside the card, the arrow key still grades and moves on",
    (await chip()) !== beforeKey,
    `${beforeKey} → ${await chip()}`
  );
}
let enCard = null;
for (let i = 0; i < 25 && !enCard; i++) {
  const shown = (await chip()).trim();
  enCard = deck.find((c) => c.back && shown.length > 1 && c.back.replace(/\.$/, "").startsWith(shown)) || null;
  if (enCard) break;
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
}
if (!enCard) {
  ck("found an English-prompt card to check the header against", false, "none within 25 cards");
} else {
  const shown = await chip();
  ck(
    "on an English-prompt card the header shows the English, not the French answer",
    !shown.includes(enCard.front),
    `header: ${JSON.stringify(shown)}`
  );

  // Ask about it before answering: the tutor is told it is unanswered.
  await page.fill("[data-tutor-panel] textarea", "hint please");
  await page.click("button:text-is('Send')");
  await page.waitForSelector("[data-already-in-deck]", { timeout: 8000 }).catch(() => {});
  const cc = requests[2]?.context?.currentCard || {};
  ck("the tutor is told the card has not been answered", cc.answered === false, JSON.stringify(cc));
  ck("and what it asks, as the card shows it", cc.prompt === shown.trim(), `${JSON.stringify(cc.prompt)} vs ${JSON.stringify(shown)}`);

  // Bold in the answer is emphasis, not asterisks. Checked once the reveal
  // has finished drawing it.
  await page.waitForFunction(
    () => /Feminine, too/.test(document.querySelector("[data-tutor-panel]")?.innerText || ""),
    null,
    { timeout: 8000 }
  ).catch(() => {});
  ck(
    "bold in an answer renders as bold",
    await page.evaluate(() => [...document.querySelectorAll("[data-tutor-panel] strong")].some((e) => e.textContent === "Feminine")) &&
      !(await page.evaluate(() => /\*\*Feminine/.test(document.querySelector("[data-tutor-panel]").innerText))),
    ""
  );

  // A proposal whose front the deck already holds.
  ck(
    "a proposal already in the deck says so",
    await page.locator("[data-already-in-deck]").count() === 1,
    ""
  );
  ck(
    "and offers Replace, not Add",
    await page.locator("[data-proposed-card] button:text-is('Replace')").count() === 1 &&
      await page.locator("[data-proposed-card] button:text-is('Add')").count() === 0,
    ""
  );

  // A click inside the panel hands it the keyboard: an arrow must not grade
  // the card behind it.
  await page.click("[data-tutor-panel] header");
  const beforeKey = await chip();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  ck("after a click in the panel, the arrow key leaves the card alone", (await chip()) === beforeKey, `${beforeKey} → ${await chip()}`);
}

// ── An answer that never finished ──────────────────────────────────────────
await page.fill("[data-tutor-panel] textarea", "is it always feminine?");
await page.click("button:text-is('Send')");
await page.waitForFunction(
  () => /cut off/i.test(document.querySelector("[data-tutor-panel]")?.innerText || ""),
  null,
  { timeout: 8000 }
).catch(() => {});
ck(
  "a stream that ends without done is reported as cut off",
  await page.evaluate(() => /cut off/i.test(document.querySelector("[data-tutor-panel]")?.innerText || "")),
  ""
);

server.close();
await finish(browser, ck);
