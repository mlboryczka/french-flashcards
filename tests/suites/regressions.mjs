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

// ── A missed card's retry stays inside the block ─────────────────────────
//
// Retries used to be appended after the block. With blocks of 50, every miss
// after card 30 landed past the end: a block with 21 misses ran to 71 cards
// and read "Retry 1 of 21" before its checkpoint. The requirement is that the
// block is its own length in answers, retries included.
{
  const { browser, page } = await openApp({ width: 1400, height: 900 });
  const counter = () =>
    page.evaluate(() => {
      const m = document.body.innerText.match(/(?:Card|Retry) (\d+) of (\d+)/i);
      return m ? { text: m[0], index: +m[1], total: +m[2] } : null;
    });

  const start = await counter();
  const total = start.total;
  await page.keyboard.press("ArrowLeft"); // miss card 1 — the only miss
  await settled(page);
  const afterMiss = await counter();
  ck("a miss does not lengthen the block", afterMiss.total === total, `${start.text} → ${afterMiss.text}`);
  let answers = 1;
  while (!(await page.$("[data-checkpoint]")) && answers < total * 3) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    answers++;
  }
  ck("the checkpoint comes after exactly the block's length in answers", answers === total,
     `${answers} answers for a ${total}-card block`);
  ck("and no counter ever read Retry", !/Retry \d+ of/i.test(await page.evaluate(() => document.body.innerText)));
  await browser.close();
}

await finish({ close: async () => {} }, ck);
