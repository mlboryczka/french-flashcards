// Layout: the card fits the window, and a panel makes room by moving the
// CONTENT COLUMN — never the sidebar.
import { openApp, finish, checker, gotoStats, layoutProbe, cardBox } from "../harness.mjs";

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

await finish(browser, ck);
