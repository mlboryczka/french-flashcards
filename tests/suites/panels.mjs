// The tutor and feedback panels: mutually exclusive, dismissed by an outside
// click, and each reflowing the page along its own axis.
import { openApp, finish, checker, layoutProbe } from "../harness.mjs";

const ck = checker();
const { browser, page } = await openApp();

console.log("\n  clicking outside closes the feedback panel");
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(700);
ck("open", !!(await layoutProbe(page)).sheet);
await page.mouse.click(80, 700);
await page.waitForTimeout(600);
const after = await layoutProbe(page);
ck("closed", !after.sheet);
ck("and the page released the space", after.padBottom === 0, `padding ${after.padBottom}`);

console.log("\n  only one panel at a time");
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(500);
ck("feedback open", !!(await layoutProbe(page)).sheet);

await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);
const tutor = await layoutProbe(page);
ck("opening the tutor closed the feedback panel", !tutor.sheet);
ck("the tutor is open", tutor.tutorOpen);
ck(
  "the page reflowed sideways instead",
  tutor.padRight > 0 && tutor.padBottom === 0,
  `right ${tutor.padRight}, bottom ${tutor.padBottom}`
);

// This click used to do nothing: ChatPanel swallows the click that dismisses
// it, so the card underneath doesn't flip — and that was eating the button.
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(800);
const back = await layoutProbe(page);
ck("opening feedback closed the tutor", !back.tutorOpen);
ck("feedback is open", !!back.sheet);
ck(
  "the page reflowed downward instead",
  back.padBottom > 0 && back.padRight === 0,
  `right ${back.padRight}, bottom ${back.padBottom}`
);

await finish(browser, ck);
