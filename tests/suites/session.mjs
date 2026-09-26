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

import { openApp, finish, checker, servedDeck, settled, sessionCounter, cardBox, firstBlockItems } from "../harness.mjs";

const ck = checker();
const deck = await servedDeck();
// Read from the fixture, never hard-coded. A block is made of cards asked one
// way round, so a word can be in it twice: this is the first block's size.
const DECK_SIZE = firstBlockItems(deck).length;

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
const cardOnScreen = async () => !(await page.$("[data-checkpoint]")) && (await cardBox(page)) !== null;
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
// Got It is only offered once the card is turned, so each answer is a tap to
// turn it and a click on Got It.
async function workTheQueue(limit = DECK_SIZE * 3) {
  let taps = 0;
  while (taps < limit && (await cardOnScreen())) {
    if (!(await gotItButton())) {
      await tapCard();
      await page.waitForTimeout(120);
    }
    const btn = await gotItButton();
    if (!btn) break;
    await btn.click();
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
ck("the queue ran out instead of looping", taps <= DECK_SIZE, `${taps} answers for ${DECK_SIZE} questions`);
ck("a checkpoint replaces the card", await checkpointShown());
ck("the card is gone, not left sitting there", (await cardBox(page)) === null);
ck(
  "it says how the block went, counting first answers in either mode",
  await bodyHas(new RegExp(`${DECK_SIZE} answers, ${DECK_SIZE} right first time`)),
  `expected "${DECK_SIZE} answers, ${DECK_SIZE} right first time"`
);
// The fixture is smaller than a block, so working it through leaves nothing
// due and nothing new. Offering another block would deal an empty one.
ck("with everything done, it says so", await bodyHas(/all caught up/i));
ck("and offers no Continue into an empty block", !(await continueButton()));
ck(
  "one scheduler write per card per way round, no more",
  writes.length === DECK_SIZE,
  `${writes.length} writes for ${DECK_SIZE} questions`
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
// mock serves the fixture's original state, which is a fresh block. A reload
// comes back to the set you were in — here, its checkpoint — so the kept place
// is cleared first, once its last save has been written.
await workTheQueue();
await page.waitForTimeout(700);
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("study-place:")) localStorage.removeItem(k); });
await page.reload();
await page.waitForTimeout(2000);

// Baseline: with nothing layered over the study view, the shortcuts work.
// Without this the next two checks would pass on a broken app that had simply
// stopped listening altogether.
{
  // An unturned card is never graded: the first press turns it over, and only
  // the second, with the answer showing, records anything.
  const before = writes.length;
  ck("before the card is turned, Got It is not offered", !(await gotItButton()));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  ck("on an unturned card, ArrowRight turns it and records nothing", writes.length === before && !!(await gotItButton()),
     `${writes.length - before} writes`);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  ck("with the answer showing, ArrowRight grades the card", writes.length === before + 1, `${writes.length - before} writes`);
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
  // One answer: the first press turns the card, the second grades it.
  const press = async (key) => {
    for (let i = 0; i < 2; i++) { await page.keyboard.press(key); await page.waitForTimeout(150); }
  };

  ck("a session is on screen", (await sessionCounter(page))?.total === DECK_SIZE, JSON.stringify(await sessionCounter(page)));
  // French side up only, so the block is one question per card and shorter
  // than a retry's 20-card gap: the checks below rely on a miss coming back
  // as the block's last card.
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "FR→EN")?.click());
  await page.waitForTimeout(500);
  const total = (await sessionCounter(page))?.total;
  ck("French side up, one question per card", total === firstBlockItems(deck, "fr").length,
     `${total} vs ${firstBlockItems(deck, "fr").length}`);

  // Miss the first card. Its retry takes the last place in the block, and the
  // card that was there waits for the next block: the block stays `total`
  // answers long, with no tail of retries after it.
  await press("ArrowLeft");
  for (let i = 1; i < total - 1; i++) await press("ArrowRight");
  const onRetry = await sessionCounter(page);
  ck("the last card in the block is the missed card, back for its retry",
     onRetry?.index === total && onRetry?.total === total && !!(await page.$("[data-retry]")),
     JSON.stringify(onRetry));
  ck("every card so far written once: one of them made way for the retry",
     oneADay.length === total - 1, `${oneADay.length} writes for ${total - 1} cards shown`);

  await press("ArrowRight"); // get the retry right
  ck("answering the retry ends the block, at exactly its length", !!(await page.$("[data-checkpoint]")));
  ck("and writes nothing: that card already had today's review",
     oneADay.length === total - 1, `${oneADay.length} writes`);

  // Stepping back from the end lands on the last card before the retry, with
  // the retry still after it — two answers to finish, both cards already
  // reviewed today.
  await page.click('button:has-text("Previous card")');
  await page.waitForTimeout(400);
  ck("Previous card puts an answered card back on screen", !(await page.$("[data-checkpoint]")));
  await press("ArrowRight");
  await press("ArrowRight");
  ck("answering both again is graded on screen", !!(await page.$("[data-checkpoint]")));
  ck("but writes nothing either", oneADay.length === total - 1, `${oneADay.length} writes`);

  await browser.close();
}

console.log("\n  Continue deals the next block, and never the same card twice");
// A backlog bigger than two blocks: 110 due cards and 3 new ones. The mock is
// told to serve these instead of its fixture; it still answers every write.
{
  // Due in French; in English, known and not due for weeks — so each is one
  // question in this backlog, as the counts below assume.
  const base = {
    ...deck.find((r) => r.fsrs_state === 2 && r.last_answer_correct === true),
    en_fsrs_state: 2, en_stability: 30, en_difficulty: 5, en_reps: 3,
    en_next_due_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    en_last_review: new Date(Date.now() - 20 * 86400000).toISOString(), en_last_answer_correct: true,
  };
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
  const press = async (key) => {
    for (let i = 0; i < 2; i++) { await page.keyboard.press(key); await page.waitForTimeout(90); }
  };
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
  ck("says how the block went", await has(/50 answers, 50 right first time/), "expected \"50 answers, 50 right first time\"");
  ck("and what it moved", await has(/Older classes/));
  ck("the count has no full stop after it", !(await has(/right first time\./)));
  ck("and offers Continue", await clickContinue());

  const b2 = await workBlock();
  ck("Continue deals the next 50", b2?.index === 1 && b2?.total === 50, JSON.stringify(b2));
  await clickContinue();

  const b3 = await workBlock();
  ck("the last block is the 10 due plus the 3 new", b3?.total === 13, JSON.stringify(b3));
  ck("working it ends in all caught up", await has(/all caught up/i));
  ck("113 cards, 113 reviews: no card was dealt twice", written.length === 113, `${written.length} writes`);
  await browser.close();
}

console.log("\n  switching between flipping and typing waits once the answer is seen");
// Switching used to reset the card, so an answer seen one way could be given
// the other: flip, switch to typing, type what you just read (a recall that
// never happened); or Show answer, switch to flipping, press Got It (a miss
// turned into a hit). Judged by what was written, not by what is on screen.
{
  const writes = [];
  const { browser, page } = await openApp({
    route: (p) => p.route("**/rest/v1/user_cards*", async (r) => {
      if (r.request().method() === "PATCH") writes.push(JSON.parse(r.request().postData() || "{}"));
      await r.continue();
    }),
  });
  const click = (t) => page.evaluate((x) => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === x)?.click(), t);
  const has = (re) => page.evaluate(([s, f]) => new RegExp(s, f).test(document.body.innerText), [re.source, re.flags]);
  const typing = () => page.evaluate(() => !!document.querySelector("input[placeholder^='Type ']"));
  const wait = (ms = 350) => page.waitForTimeout(ms);

  await click("Type answer"); await wait();
  ck("before the answer is seen, switching is immediate", await typing());
  await click("Type answer"); await wait();
  await page.keyboard.press(" "); await wait(700);
  await click("Type answer"); await wait();
  ck("after flipping, the switch to typing waits for the next card",
     !(await typing()) && await has(/Typing starts from the next card/));
  await click("Type answer"); await wait();
  ck("pressing again cancels it", !(await has(/starts from the next card/)));
  await click("Type answer"); await wait();
  await click("Got It"); await wait(600);
  ck("the next card is typed", await typing());
  await click("Show answer"); await wait(500);
  await click("Type answer"); await wait();
  ck("after Show answer, the switch to flipping waits, and Got It is not offered",
     await has(/Flipping starts from the next card/) && !(await has(/Got It/)));
  await click("Continue →"); await wait(600);
  const grades = writes.map((w) => w.last_answer_correct ?? w.en_last_answer_correct);
  ck("so the flip was recorded as right and Show answer as a miss",
     JSON.stringify(grades) === "[true,false]", JSON.stringify(grades));
  ck("and the card after is flipped", !(await typing()) && !(await has(/starts from the next card/)));
  await browser.close();
}

await finish(null, ck);
