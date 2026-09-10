// The end of a session, and what the keyboard is allowed to touch.
//
// Both of these were bugs you could only find by working the app the way a
// person does — clicking through to the end of a queue, or pressing Enter in
// a dialog. The assertions are written from what the app owes the user, not
// from how it happens to be implemented:
//
//   "a session that has been worked to the end says so and offers a new one"
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

const bodyHas = (re) => page.evaluate((s) => new RegExp(s).test(document.body.innerText), re.source);

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

console.log("\n  a flip-mode session reaches an end");
// Flip mode is the default — no typing — and it used to have no end at all:
// the completion notice was gated on the count of TYPED answers, so it never
// showed, and the last card stayed live under your cursor.
const taps = await workTheQueue();
ck("the queue ran out instead of looping", taps <= DECK_SIZE, `${taps} answers for ${DECK_SIZE} cards`);
ck("it says the session is complete", await bodyHas(/Session complete/));
ck("and offers a new one", !!(await page.$('button:has-text("New Session")')));
ck("the card is gone, not left sitting there", (await cardBox(page)) === null);
ck(
  "it reports what you did, without inventing an accuracy for untyped answers",
  await bodyHas(new RegExp(`${DECK_SIZE} cards reviewed`)),
  `expected "${DECK_SIZE} cards reviewed"`
);
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

console.log("\n  and you can start another, or step back into the last one");
await page.click('button:has-text("New Session")');
await page.waitForTimeout(1200);
const restarted = await sessionCounter(page);
ck("New Session deals a fresh queue", restarted?.index === 1, JSON.stringify(restarted));
ck("with a card on screen", (await cardBox(page)) !== null);

await workTheQueue();
ck("second session ends too", await bodyHas(/Session complete/));
await page.click('button:has-text("Previous card")');
await page.waitForTimeout(500);
ck("Previous card puts you back in the session", !(await bodyHas(/Session complete/)));
ck("with the card back", (await cardBox(page)) !== null);

console.log("\n  the keyboard reaches the card only when the card is what you're looking at");
// Previous card left the session live again, so finish it before restarting.
await workTheQueue();
await page.click('button:has-text("New Session")');
await page.waitForTimeout(1200);

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

await finish(browser, ck);
