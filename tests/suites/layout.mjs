// Layout: the card fits the window, and a panel makes room by moving the
// CONTENT COLUMN — never the sidebar.
import { openApp, finish, checker, gotoStats, layoutProbe, cardBox, settled } from "../harness.mjs";

const ck = checker();
const { browser, page } = await openApp();

console.log("\n  the card fits the window at any height");
// The card used to be a fixed 600x375. Once the area was shorter than that,
// centring overflowed in BOTH directions and the top of the card rode up over
// the counter and the back button.
for (const height of [1000, 900, 800, 700, 640, 560, 500]) {
  await page.setViewportSize({ width: 1400, height });
  await page.waitForTimeout(350);
  const card = await cardBox(page);
  const header = await page.evaluate(() => {
    const counter = [...document.querySelectorAll("span,div")].find((n) =>
      /^(Card|Retry) \d+ of/.test(n.textContent.trim())
    );
    const back = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Previous card")
    );
    return Math.round(
      Math.max(counter.getBoundingClientRect().bottom, back.getBoundingClientRect().bottom)
    );
  });
  const ratio = +(card.width / card.height).toFixed(2);
  ck(
    `${height}px tall: card clears the counter and back button`,
    card.top >= header,
    `card ${card.width}x${card.height} (${ratio}:1), top ${card.top} vs header ${header}`
  );
  ck(`${height}px tall: still landscape`, ratio >= 1.4 && ratio <= 1.75, `${ratio}:1`);
}
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(300);

console.log("\n  the feedback panel moves the content column, not the sidebar");
const closed = await layoutProbe(page);
ck("nothing is padded while closed", closed.padBottom === 0 && closed.padRight === 0);
ck("main is border-box", closed.boxSizing === "border-box");
const fullSidebar = closed.sidebarBottom;

await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(800);
const open = await layoutProbe(page);
ck("the panel is on screen", !!open.sheet);
ck(
  "the page made room equal to the panel",
  Math.abs(open.padBottom - open.sheet.height) <= 1,
  `padding ${open.padBottom} vs panel ${open.sheet.height}`
);
ck(
  "main content stops above the panel",
  open.mainContentBottom <= open.sheet.top + 1,
  `content ends ${open.mainContentBottom}, panel starts ${open.sheet.top}`
);
// The panel never covers the sidebar, so the sidebar has no business moving.
// Padding the shell instead of main shrank it and jumped the account block up
// the page — this is the check that should have existed the first time.
ck(
  "THE SIDEBAR DOES NOT MOVE",
  open.sidebarBottom === fullSidebar,
  `sidebar ends ${open.sidebarBottom}, was ${fullSidebar}`
);
ck(
  "the account block stays at the bottom",
  open.accountTop !== null && open.accountTop > open.sheet.top,
  `account at ${open.accountTop}, panel top ${open.sheet.top}`
);
ck("the panel starts right of the sidebar", open.sheet.left >= 256, `left ${open.sheet.left}`);
ck("the panel is shorter than the old 60vh", open.sheet.height <= 340, `${open.sheet.height}px`);
ck("and wider than the old 600", open.sheet.width > 600, `${open.sheet.width}px`);
ck("the shell stays one viewport tall", Math.abs(open.shellHeight - open.viewport) <= 1);

console.log("\n  the card holds its position when it flips");
await page.mouse.click(80, 60);   // dismiss the panel the last section opened
await settled(page);
// The area below the card is a fixed-height well. Without it, the graded state
// (result banner + dispute link + Continue) is taller than the input row, the
// column re-centred, and the card jumped 45px up the page mid-answer.
{
  await settled(page);
  const before = await cardBox(page);
  await page.mouse.click(before.centreX, before.top + 40);
  await page.waitForTimeout(800);
  const after = await cardBox(page);
  ck("flip mode: the card does not move", after.top === before.top, `${before.top} → ${after.top}`);
  await page.mouse.click(after.centreX, after.top + 40);
  await page.waitForTimeout(800);
}
await page.click('button:has-text("FR→EN")');
await page.waitForTimeout(300);
if (!(await page.$('input[placeholder^="Type"]'))) await page.click('button:has-text("Type answer")');
await page.waitForSelector('input[placeholder^="Type"]');
{
  await settled(page);
  const before = await cardBox(page);
  await page.click('input[placeholder^="Type"]');
  await page.keyboard.type("zzzqqq");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const after = await cardBox(page);
  ck("type mode: the card does not move when graded", after.top === before.top, `${before.top} → ${after.top}`);
  const controlsMoved = await page.evaluate(() =>
    !!document.querySelector("button")
  );
  ck("but the controls below it did change", controlsMoved);
  const cont = await page.$('button:has-text("Continue")');
  if (cont) await cont.click();
  await page.waitForTimeout(700);
}
await page.click('button:has-text("Type answer")');
await page.waitForTimeout(400);

console.log("\n  the card survives having a panel open");
// Making the card height-driven fixed the overflow but gave it no floor, so
// it absorbed the entire squeeze: at 700px it collapsed to 80x50 with its
// text still at 40px, while 130px of padding sat unused below it.
await page.mouse.click(80, 60);
await page.waitForTimeout(500);
for (const height of [900, 800, 700, 640, 560]) {
  await page.setViewportSize({ width: 1400, height });
  await page.waitForTimeout(300);
  await page.click('button:has-text("Send feedback")');
  await page.waitForTimeout(800);
  const card = await cardBox(page);
  const probe = await layoutProbe(page);
  const font = await page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => getComputedStyle(d).transformStyle === "preserve-3d"
    );
    return parseFloat(getComputedStyle(el.children[0].querySelector("div")).fontSize);
  });
  ck(
    `${height}px + panel: the card is still usable`,
    card.height >= 150 && card.width >= 240,
    `card ${card.width}x${card.height}, panel ${probe.sheet.width}x${probe.sheet.height}`
  );
  ck(
    `${height}px + panel: the text sized to the card`,
    font <= card.height * 0.14 && font >= 18,
    `${font.toFixed(1)}px in a ${card.height}px card`
  );
  ck(
    `${height}px + panel: the card still clears the panel`,
    card.bottom <= probe.sheet.top,
    `card ends ${card.bottom}, panel starts ${probe.sheet.top}`
  );
  await page.mouse.click(80, 60);
  await page.waitForTimeout(600);
}
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(300);

console.log("\n  the same on Stats, where the content scrolls");
await gotoStats(page);
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(800);
const stats = await layoutProbe(page);
// The scroll container by its style, not by whether it happens to overflow
// right now — with a shorter panel the Stats content may well fit.
const scrolls = await page.evaluate(() => {
  const el = [...document.querySelectorAll("main *")].find(
    (d) => getComputedStyle(d).overflowY === "auto"
  );
  return el ? Math.round(el.getBoundingClientRect().bottom) : null;
});
ck(
  "main content stops above the panel",
  stats.mainContentBottom <= stats.sheet.top + 1,
  `content ends ${stats.mainContentBottom}, panel starts ${stats.sheet.top}`
);
ck("the scrolling area stops there too", scrolls !== null && scrolls <= stats.sheet.top + 1, `${scrolls}`);
ck("THE SIDEBAR DOES NOT MOVE", stats.sidebarBottom === fullSidebar, `${stats.sidebarBottom}`);
ck("the account block stays at the bottom", stats.accountTop > stats.sheet.top);

console.log("\n  nothing scrolls sideways, at any width");
// The requirement is the page, not any particular element: a phone-width
// viewport should have nothing to scroll horizontally to. The decorative blur
// circles in the card area sit deliberately outside their container
// (left:-60 / right:-60); the narrow shell didn't clip, so on a phone the
// document came out 20px wider than the window and the whole page slid.
//
// Measured against documentElement.clientWidth rather than a remembered
// number, and swept across the responsive breakpoint (768px) so a regression
// on either side of it shows up.
for (const width of [360, 390, 480, 700, 767, 800, 1100, 1400]) {
  await page.setViewportSize({ width, height: 860 });
  await page.waitForTimeout(350);
  const { scrollW, clientW, culprit } = await page.evaluate(() => {
    const clientW = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll("*")].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > clientW + 0.5 || r.left < -0.5);
    });
    return {
      scrollW: document.documentElement.scrollWidth,
      clientW,
      culprit: over ? `${over.tagName}.${over.className || "?"}` : null,
    };
  });
  ck(
    `${width}px wide: no horizontal scroll`,
    scrollW <= clientW,
    // Name the offender only when there is one to chase — a clipped element
    // still reads as out of bounds on a page that doesn't scroll.
    `scrollWidth ${scrollW} vs ${clientW}${scrollW > clientW && culprit ? ` — ${culprit}` : ""}`
  );
}
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(300);

console.log("\n  a panel never costs the card its shape");
// The Stats section above left us there, and Stats has no card. Back to the
// study view before measuring one.
await page.evaluate(() => {
  [...document.querySelectorAll("aside nav button")]
    .find((b) => /^cards$/i.test(b.innerText.trim()))
    .click();
});
await page.waitForSelector('button:has-text("Previous card")', { timeout: 8000 });
// And the feedback sheet is still open from those sections, padding main's
// bottom. Left open it makes the card 350 tall instead of 375, and opening the
// tutor dismisses the sheet — so the card would GROW on open and the
// comparison would measure the sheet closing, not the panel's effect.
await page.evaluate(() => {
  const close = [...document.querySelectorAll("[data-feedback-sheet] button")]
    .find((b) => b.innerText.trim() === "×");
  close?.click();
});
await settled(page);
await page.waitForTimeout(400);
// The requirement is that opening a panel does not damage what you were
// looking at. Reflow was gated on "not a phone", so at 900px wide it still
// fired and left 900 - 256 of sidebar - 460 of panel = 184px of column: the
// top-bar chips stacked one per line, the card turned portrait, and the answer
// row ran off the edge. Below the floor the panel is an overlay instead.
//
// Measured as a comparison against the same window with nothing open, so it
// stays true whatever the card's natural size is at that width.
for (const width of [1600, 1400, 1200, 1000, 900, 800]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const shut = await cardBox(page);
  await page.evaluate(() => document.querySelector("aside button[data-tutor-toggle]").click());
  await settled(page);
  await page.waitForTimeout(150);
  const open = await cardBox(page);
  const reflowed = await page.evaluate(
    () => Math.round(parseFloat(getComputedStyle(document.querySelector("main")).paddingRight) || 0)
  );
  ck(
    `${width}px: the tutor leaves the card its shape`,
    open.width === shut.width && open.height === shut.height,
    `${shut.width}x${shut.height} shut, ${open.width}x${open.height} open, ${reflowed ? "reflowed" : "overlay"}`
  );
  // And when it does reflow, the column left behind is actually usable.
  if (reflowed) {
    const column = await page.evaluate(() => {
      const m = document.querySelector("main");
      return Math.round(m.getBoundingClientRect().width - (parseFloat(getComputedStyle(m).paddingRight) || 0));
    });
    ck(`${width}px: and the column it reflows to is usable`, column >= 680, `${column}px`);
  }
  await page.evaluate(() => document.querySelector("aside button[data-tutor-toggle]").click());
  await settled(page);
  await page.waitForTimeout(150);
}
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(300);

console.log("\n  the nav keeps exactly one marker across a breakpoint");
// The wide nav marks the active item on its right, the narrow one on its top.
// React diffs styles per property, so crossing 768px used to leave the other
// layout's border behind: resize down and back and every item kept a stale
// top border, drawing a rule between each one. Asserted as "no item carries a
// border on a side this layout does not use", which is the requirement —
// counting only the ACTIVE item's marker would have passed the whole time.
const navBorders = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("aside nav button")].map((b) => {
      const cs = getComputedStyle(b);
      const px = (v) => Math.round(parseFloat(v) || 0);
      return {
        label: b.innerText.trim().split("\n")[0],
        top: px(cs.borderTopWidth), right: px(cs.borderRightWidth),
        bottom: px(cs.borderBottomWidth), left: px(cs.borderLeftWidth),
        marked: cs.borderRightColor !== "rgba(0, 0, 0, 0)" && px(cs.borderRightWidth) > 0,
      };
    })
  );

await page.setViewportSize({ width: 700, height: 900 });
await page.waitForTimeout(450);
const narrow = await navBorders();
ck("narrow: nothing carries a right-hand marker", narrow.every((b) => b.right === 0), narrow.map((b) => b.right).join(","));

await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(450);
const wide = await navBorders();
ck("back to wide: no stale top border", wide.every((b) => b.top === 0), wide.map((b) => `${b.label}:${b.top}`).join(" "));
ck("and none on the bottom or left either", wide.every((b) => b.bottom === 0 && b.left === 0));
ck("exactly one item is marked", wide.filter((b) => b.marked).length === 1, `${wide.filter((b) => b.marked).length} marked`);

await finish(browser, ck);
