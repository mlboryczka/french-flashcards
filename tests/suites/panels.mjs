// The tutor and feedback panels: mutually exclusive, and what does and does
// not dismiss each. The feedback sheet goes on an outside
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

console.log("\n  the panel is small, and the whole of it takes a screenshot");
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(700);
const sheet = (await layoutProbe(page)).sheet;
console.log(`  panel ${sheet.width}x${sheet.height}`);
// It was ~300px tall: a subtitle, a 90px textarea, a full-width attach row, a
// full-width dashed dropzone and a footer, for what is really one text field.
ck("well under the 300px it used to be", sheet.height <= 160, `${sheet.height}px`);
ck(
  "the subtitle is gone",
  !(await page.evaluate(() => /Bug, idea, or wrong translation/.test(document.body.innerText)))
);
ck(
  "the message field starts at one line",
  (await page.evaluate(() => {
    const t = document.querySelector('textarea[placeholder]');
    return t ? Math.round(t.getBoundingClientRect().height) : 999;
  })) <= 44
);
// By its marker, not by guessing at whatever French happens to be on the card.
const attachWidth = await page.evaluate(() => {
  const b = document.querySelector("[data-attach-card]");
  return b ? Math.round(b.getBoundingClientRect().width) : null;
});
ck("attach-card is a chip, not a full-width row", attachWidth !== null && attachWidth <= 280, `${attachWidth}px`);
// The dedicated dropzone is gone, so the sheet itself has to accept the file.
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }));
  window.__dt = dt;
  document.querySelector("[data-feedback-sheet]")
    .dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
// React has to re-render before the highlight is on the element.
await page.waitForTimeout(200);
const lit = await page.evaluate(() =>
  /inset/.test(getComputedStyle(document.querySelector("[data-feedback-sheet]")).boxShadow)
);
ck("dragging over the panel lights the whole panel up", lit === true, `${lit}`);
await page.evaluate(() => {
  document.querySelector("[data-feedback-sheet]")
    .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
});
await page.waitForTimeout(500);
ck(
  "and dropping it there attaches the image",
  await page.evaluate(() => !!document.querySelector('img[alt="Attached"]'))
);
await page.mouse.click(80, 60);
await page.waitForTimeout(600);

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

// The requirement the tutor exists for: you ask it about the card in front of
// you, so clicking back onto that card must NOT take the answer away. It used
// to close on any outside click, and on Escape.
await page.click("body", { position: { x: 400, y: 450 } });
await page.waitForTimeout(500);
ck(
  "clicking the card behind it leaves the tutor open",
  (await layoutProbe(page)).tutorOpen
);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
ck("Escape leaves the tutor open", (await layoutProbe(page)).tutorOpen);

// Closing it deliberately still works, both ways in.
await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);
ck("the nav toggle closes it", !(await layoutProbe(page)).tutorOpen);

await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);
await page.click('[data-tutor-panel] button[aria-label="Close"]');
await page.waitForTimeout(800);
ck("the ✕ closes it", !(await layoutProbe(page)).tutorOpen);

// Reopen for the mutual-exclusion check below.
await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);

// Opening another panel is a deliberate act, not an ambient dismissal, so it
// still puts the tutor away.
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
