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

    // Leave via the chip's ×, notes still open.
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.getAttribute("title") === "Back to the whole deck")?.click();
    });
    await settled(page);
    ck("leaving the lesson gives the column back",
       (await padRight()) < 1 && !(await panelInDom()),
       `padding ${await padRight()}px, panel in DOM: ${await panelInDom()}`);

    // And again via the Cards nav item, which clears the same state.
    await page.locator('aside button[title^="Study "]').first().click();
    await settled(page);
    await page.locator("[data-lesson-toggle]").click();
    await settled(page);
    await page.evaluate(() => {
      [...document.querySelectorAll("aside button")]
        .find((b) => b.textContent.trim() === "Cards")?.click();
    });
    await settled(page);
    ck("and the same when you leave via Cards", (await padRight()) < 1,
       `${await padRight()}px`);
  } else {
    ck("a lesson exists to test with", false, "no lesson sub-items in the sidebar");
  }
  await browser.close();
}

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
