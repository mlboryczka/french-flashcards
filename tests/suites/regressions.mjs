// Bugs found by driving the app, each with the check that would have caught
// it. Written from the requirement — what the user should see — not from the
// shape of the fix.
import { openApp, checker, finish, settled } from "../harness.mjs";

const ck = checker();

// ── Leaving a lesson gives the page its column back ──────────────────────
//
// Enter a lesson, open its notes, then leave the lesson WITHOUT closing them.
// The panel goes (it renders nothing without a lesson) but the page went on
// reserving its 460px: a dead strip down the right with nothing in it, and
// no control left on screen to clear it.
{
  const { browser, page } = await openApp({ width: 1600, height: 900 });
  const padRight = () =>
    page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector("main")).paddingRight)
    );
  const panelInDom = () =>
    page.evaluate(() => !!document.querySelector("[data-lesson-panel]"));

  const lesson = page.locator('aside button[title^="Study "]').first();
  if (await lesson.count()) {
    await lesson.click();
    await settled(page);
    await page.locator("[data-lesson-toggle]").click();
    await settled(page);
    ck("the notes panel makes room for itself", (await padRight()) > 400,
       `${await padRight()}px`);

    // Leave the lesson with the notes still open. This used to be reachable
    // two ways — the lesson chip's × and the Cards nav item — and the × has
    // since gone: the chip was a label sitting beside the notes toggle looking
    // like a second switch. Cards is now the way back, so it is what this
    // guards. The requirement never changed: no dead strip afterwards.
    await page.evaluate(() => {
      [...document.querySelectorAll("aside button")]
        .find((b) => b.textContent.trim() === "Cards")?.click();
    });
    await settled(page);
    ck("leaving the lesson gives the column back",
       (await padRight()) < 1 && !(await panelInDom()),
       `padding ${await padRight()}px, panel in DOM: ${await panelInDom()}`);

    // And the lesson name is not a control any more — nothing in the bar
    // offers to take you out of the lesson, so nothing can half-do it.
    await page.locator('aside button[title^="Study "]').first().click();
    await settled(page);
    const exits = await page.evaluate(() =>
      [...document.querySelectorAll(".chip-row button")]
        .filter((b) => /^(×|✕)$/.test(b.textContent.trim())).length);
    ck("the lesson name in the bar is a label, not an exit", exits === 0,
       `${exits} dismiss controls in the bar`);
  } else {
    ck("a lesson exists to test with", false, "no lesson sub-items in the sidebar");
  }
  await browser.close();
}

// The lesson notes are rendered into <body> like the other two slide-overs,
// rather than in place inside the app shell. There is deliberately NO check
// for that here.
//
// The reasoning for the change was that the shell sets overflow:hidden, and a
// fixed element stops ignoring that the moment an ancestor gains a transform
// or filter. True in general — but measured here, the shell is exactly the
// viewport (1600x900 in a 1600x900 window), so making it the containing block
// moves and clips nothing. A check written for it passed with the change
// reverted, which makes it worse than no check.
//
// The change stands on consistency: three panels, one mechanism. If the shell
// ever stops being viewport-sized, this becomes testable and should get a
// check then.

// ── The retry counter counts the retries that exist ──────────────────────
//
// Miss one card and the tail read "Retry 1 of 2": the total added your
// position within the tail to the number of re-queued cards, counting the
// card in front of you twice.
{
  const { browser, page } = await openApp({ width: 1400, height: 900 });
  const counter = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("span")].find((s) =>
        /^(Card|Retry) \d+ of \d+/.test(s.textContent || "")
      );
      return el ? el.textContent.split("·")[0].trim() : null;
    });

  const total = Number((await counter()).match(/of (\d+)/)[1]);
  await page.keyboard.press("ArrowLeft"); // miss card 1 — the only miss
  await settled(page);
  for (let i = 1; i < total; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
  }
  const tail = await counter();
  ck("one card missed reads as one retry", tail === "Retry 1 of 1",
     `${tail} after exactly 1 miss in a ${total}-card session`);
  await browser.close();
}

await finish({ close: async () => {} }, ck);
