// The end of a session, and what the keyboard is allowed to touch.
//
// Both of these were bugs you could only find by working the app the way a
// person does — clicking through to the end of a queue, or pressing Enter in
// a dialog. The assertions are written from what the app owes the user, not
// from how it happens to be implemented:
//
//   "a block that has been worked to the end says how it went, and offers the
//    next block only when there is one"
//   "a card is graded once per answer, and only when it is the card you are
//    looking at"
//
// The second is the one with teeth. Every stray grade is an FSRS review
// written for a card the user never answered, which pushes its due date out
// on evidence that doesn't exist — invisible in the UI, and not undoable. So
// the check counts the actual PATCHes to user_cards rather than watching the
// counter, which only shows where you are, not what was written.

import { openApp, finish, checker, servedDeck, settled, sessionCounter, cardBox } from "../harness.mjs";

const ck = checker();
const deck = await servedDeck();
const DECK_SIZE = deck.length; // read from the fixture, never hard-coded

// Every scheduler write the app makes, in order. A PATCH to user_cards is one
// graded answer.
const writes = [];
const { browser, page } = await openApp({
  route: (p) =>
    p.route("**/rest/v1/user_cards*", async (r) => {
      if (r.request().method() === "PATCH") writes.push(r.request().postData());
      await r.continue();
    }),
});

const bodyHas = (re) => page.evaluate(([s, f]) => new RegExp(s, f).test(document.body.innerText), [re.source, re.flags]);
const checkpointShown = () => page.evaluate(() => !!document.querySelector("[data-checkpoint]"));
const continueButton = () => page.$('[data-checkpoint] button:has-text("Continue")');

// Click a panel's own heading, drop focus, then press the study shortcuts.
//
// Clicking somewhere inert inside the panel is what a person does before
// typing, and it is the case the guard has to survive: the event target is
// neither an input nor a textarea, so a target-tag check alone waves it
// through. The blur is not cosmetic — a focused button treats Space as its
// own activation, which closed the panel mid-check and let the remaining
// keys reach the card for real.
async function pressInto(headingRe) {
  await page.evaluate((src) => {
    const re = new RegExp(src);
    const el = [...document.querySelectorAll("*")].find(
      (n) => n.children.length === 0 && re.test((n.textContent || "").trim())
    );
    el?.click();
    document.activeElement?.blur?.();
  }, headingRe.source);
  for (const key of ["Enter", " ", "ArrowRight", "ArrowLeft"]) await page.keyboard.press(key);
  await page.waitForTimeout(500);
}
const gotItButton = () => page.$('button:has-text("Got It")');
const tapCard = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => getComputedStyle(d).transformStyle === "preserve-3d"
    );
    if (el) el.click();
  });

// Flip through the queue until there is nothing left to grade. Guarded well
// above the deck size: if the session never ends, that IS the bug, and the
// guard is what stops the suite hanging instead of reporting it.
async function workTheQueue(limit = DECK_SIZE * 3) {
  let taps = 0;
  while (taps < limit) {
    const btn = await gotItButton();
    if (!btn) break;
    await tapCard();
    await page.waitForTimeout(90);
    const still = await gotItButton();
    if (!still) break;
    await still.click();
    await page.waitForTimeout(200);
    taps++;
  }
  return taps;
}

console.log("\n  a flip-mode block reaches an end");
// Flip mode is the default — no typing — and it used to have no end at all:
// the completion notice was gated on the count of TYPED answers, so it never
// showed, and the last card stayed live under your cursor.
const taps = await workTheQueue();
ck("the queue ran out instead of looping", taps <= DECK_SIZE, `${taps} answers for ${DECK_SIZE} cards`);
ck("a checkpoint replaces the card", await checkpointShown());
ck("the card is gone, not left sitting there", (await cardBox(page)) === null);
ck(
  "it says how the block went, counting first answers in either mode",
  await bodyHas(new RegExp(`${DECK_SIZE} cards, ${DECK_SIZE} right first time`)),
  `expected "${DECK_SIZE} cards, ${DECK_SIZE} right first time"`
);
// The fixture is smaller than a block, so working it through leaves nothing
// due and nothing new. Offering another block would deal an empty one.
ck("with everything done, it says so", await bodyHas(/all caught up/i));
ck("and offers no Continue into an empty block", !(await continueButton()));
ck(
  "one scheduler write per card, no more",
  writes.length === DECK_SIZE,
  `${writes.length} writes for ${DECK_SIZE} cards`
);

console.log("\n  a finished session doesn't keep grading");
const afterFinish = writes.length;
for (const key of ["Enter", "ArrowRight", "ArrowLeft", " "]) await page.keyboard.press(key);
await page.waitForTimeout(500);
ck("keys do nothing once the queue is empty", writes.length === afterFinish, `${writes.length} vs ${afterFinish}`);

console.log("\n  you can step back into the block you finished");
await page.click('button:has-text("Previous card")');
await page.waitForTimeout(500);
ck("Previous card puts you back in the block", !(await checkpointShown()));
ck("with the card back", (await cardBox(page)) !== null);

console.log("\n  the keyboard reaches the card only when the card is what you're looking at");
// Previous card left the block live again, so finish it, then reload: the
// mock serves the fixture's original state, which is a fresh block.
await workTheQueue();
await page.reload();
await page.waitForTimeout(2000);

// Baseline: with nothing layered over the study view, the shortcuts work.
// Without this the next two checks would pass on a broken app that had simply
// stopped listening altogether.
{
  const before = writes.length;
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  ck("with nothing open, ArrowRight grades the card", writes.length === before + 1, `${writes.length - before} writes`);
}

// A modal. Enter is how you submit in a dialog; it used to also mark the card
// hidden behind that dialog as known.
await page.evaluate(() => {
  [...document.querySelectorAll("aside button")].find((b) => b.innerText.trim() === "T").click();
});
await page.waitForTimeout(250);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Upload document").click();
});
await page.waitForTimeout(500);
{
  const before = writes.length;
  await pressInto(/Upload your cahier/);
  ck("a modal is open: the card behind it is not graded", writes.length === before, `${writes.length - before} stray writes`);
  ck("and the modal is still open, so that proved something", await bodyHas(/Upload your cahier/));
}
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Cancel").click();
});
await page.waitForTimeout(400);

// The tutor. It reflows the page rather than covering it, so the card stays
// visible — which is exactly why a stray grade here is invisible.
await page.click("aside button[data-tutor-toggle]");
await settled(page);
ck("the tutor is open", await page.evaluate(() => !!document.querySelector("[data-tutor-panel]")));
{
  const before = writes.length;
  await pressInto(/^Ask the tutor$/);
  ck("the tutor is open: the card beside it is not graded", writes.length === before, `${writes.length - before} stray writes`);
  ck("and the tutor is still open, so that proved something", await page.evaluate(() => !!document.querySelector("[data-tutor-panel]")));
}
// Leave the app in a known state for the next section.
await page.click("aside button[data-tutor-toggle]");
await settled(page);

console.log("\n  the profile menu can be put away");
const menuOpen = () => bodyHas(/Upload document/);
const openMenu = async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll("aside button")].find((b) => b.innerText.trim() === "T").click();
  });
  await page.waitForTimeout(250);
};

await openMenu();
ck("it opens", await menuOpen());
await page.mouse.click(900, 300);
await page.waitForTimeout(300);
ck("a click outside closes it", !(await menuOpen()));

await openMenu();
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
ck("Escape closes it", !(await menuOpen()));

// Dismissal must not eat the menu's own clicks — closing on mousedown is only
// correct if the items still fire.
await openMenu();
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Upload document").click();
});
await page.waitForTimeout(700);
ck("its own items still work", await bodyHas(/Upload your cahier/));
await browser.close();

console.log("\n  FSRS gets one answer per card per day");
// The retry after a miss, and a card revisited with Previous card, are both
// still answerable — but the first answer of the day is the review. Counted
// as PATCHes to user_cards, for the same reason as above: the counter shows
// where you are, not what was written.
{
  const oneADay = [];
  const { browser, page } = await openApp({
    route: (p) =>
      p.route("**/rest/v1/user_cards*", async (r) => {
        if (r.request().method() === "PATCH") oneADay.push(r.request().postData());
        await r.continue();
      }),
  });
  const has = (re) => page.evaluate(([s, f]) => new RegExp(s, f).test(document.body.innerText), [re.source, re.flags]);
  const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(150); };

  const total = (await sessionCounter(page))?.total;
  ck("a session is on screen", total === DECK_SIZE, JSON.stringify(await sessionCounter(page)));

  await press("ArrowLeft"); // miss the first card
  for (let i = 1; i < total; i++) await press("ArrowRight");
  ck("the missed card comes back as a retry, so the next check proves something",
     await has(/Retry 1 of 1/i));
  ck("every card so far written once", oneADay.length === total, `${oneADay.length} writes for ${total} cards`);

  await press("ArrowRight"); // get the retry right
  ck("answering the retry ends the block", !!(await page.$("[data-checkpoint]")));
  ck("and writes nothing: that card already had today's review",
     oneADay.length === total, `${oneADay.length} writes for ${total} cards`);

  // Stepping back from the end lands on the last original card, with the
  // retry still after it — two answers to finish, both cards already
  // reviewed today.
  await page.click('button:has-text("Previous card")');
  await page.waitForTimeout(400);
  ck("Previous card puts an answered card back on screen", !(await page.$("[data-checkpoint]")));
  await press("ArrowRight");
  await press("ArrowRight");
  ck("answering both again is graded on screen", !!(await page.$("[data-checkpoint]")));
  ck("but writes nothing either", oneADay.length === total, `${oneADay.length} writes for ${total} cards`);

  await browser.close();
}

console.log("\n  Continue deals the next block, and never the same card twice");
// A backlog bigger than two blocks: 110 due cards and 3 new ones. The mock is
// told to serve these instead of its fixture; it still answers every write.
{
  const base = deck.find((r) => r.fsrs_state === 2 && r.last_answer_correct === true);
  const fresh = deck.find((r) => r.fsrs_state === 0);
  const big = [
    ...Array.from({ length: 110 }, (_, i) => ({ ...base, id: 1000 + i, front: `carte ${i + 1}`, back: `card ${i + 1}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ ...fresh, id: 2000 + i, front: `nouveau ${i + 1}`, back: `new ${i + 1}` })),
  ];
  const written = [];
  const { browser, page } = await openApp({
    route: async (p) => {
      await p.route("**/rest/v1/user_cards*", async (r) => {
        const m = r.request().method();
        if (m === "PATCH") { written.push(r.request().url()); return r.continue(); }
        if (m !== "GET") return r.continue();
        await r.fulfill({
          status: 200, contentType: "application/json",
          headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(big),
        });
      });
    },
  });
  // Let the load-time lesson sync finish before answering: its reload would
  // re-serve this fixture's original state over the answers.
  await page.waitForTimeout(2500);
  const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(110); };
  const has = (re) => page.evaluate(([s, f]) => new RegExp(s, f).test(document.body.innerText), [re.source, re.flags]);
  const workBlock = async () => {
    const c = await sessionCounter(page);
    for (let i = 0; i < (c?.total || 0); i++) await press("ArrowRight");
    return c;
  };
  const clickContinue = async () => {
    const cont = await page.$('[data-checkpoint] button:has-text("Continue")');
    if (cont) await cont.click();
    await page.waitForTimeout(800);
    return !!cont;
  };

  const b1 = await workBlock();
  ck("a 110-card backlog deals a block of 50", b1?.total === 50, JSON.stringify(b1));
  ck("after 50 answers, the checkpoint", !!(await page.$("[data-checkpoint]")));
  ck("says how the block went", await has(/50 cards, 50 right first time/), "expected \"50 cards, 50 right first time\"");
  ck("and what it moved", await has(/Your earlier notes/));
  ck("60 still due, so it says the next blocks are reviews only", await has(/review phase/i) && await has(/60 cards/));
  ck("and offers Continue", await clickContinue());

  const b2 = await workBlock();
  ck("Continue deals the next 50", b2?.index === 1 && b2?.total === 50, JSON.stringify(b2));
  ck("10 due and 3 new left: new cards fit, so no review-phase message", !(await has(/review phase/i)));
  await clickContinue();

  const b3 = await workBlock();
  ck("the last block is the 10 due plus the 3 new", b3?.total === 13, JSON.stringify(b3));
  ck("working it ends in all caught up", await has(/all caught up/i));
  ck("113 cards, 113 reviews: no card was dealt twice", written.length === 113, `${written.length} writes`);
  await browser.close();
}

await finish(null, ck);
