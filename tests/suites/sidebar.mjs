// The sidebar minimizes to a rail of icons.
//
// Requirements, from the owner: a button minimizes the sidebar to a narrower
// one; the nav keeps its icons and its marker; "Send feedback" becomes an icon
// under the avatar; opening feedback widens the sidebar (the panel lives in it
// and needs the room) and closing it puts the sidebar back; the choice is
// remembered. Phones are untouched — their nav is the bottom bar.
import { openApp, finish, checker, settled } from "../harness.mjs";
const ck = checker();

const { browser, page } = await openApp({ width: 1400, height: 900 });

const probe = () => page.evaluate(() => {
  const aside = document.querySelector("[data-sidebar]");
  const nav = [...aside.querySelectorAll("nav button")];
  const avatar = [...aside.querySelectorAll("button")].find((b) => /^[A-Z]$/.test(b.textContent.trim()));
  const fb = aside.querySelector("[data-feedback-toggle]");
  const a = avatar?.getBoundingClientRect();
  const f = fb?.getBoundingClientRect();
  return {
    width: Math.round(aside.getBoundingClientRect().width),
    mainLeft: Math.round(document.querySelector("main").getBoundingClientRect().left),
    labels: nav.map((b) => b.textContent.trim()).filter(Boolean),
    titled: nav.map((b) => b.getAttribute("title")).filter(Boolean),
    marked: nav.filter((b) => getComputedStyle(b).borderRightColor !== "rgba(0, 0, 0, 0)").length,
    fbBelowAvatar: a && f ? f.top >= a.bottom : null,
    fbCentred: a && f ? Math.abs((f.left + f.width / 2) - (a.left + a.width / 2)) <= 1 : null,
    sheet: !!document.querySelector("[data-feedback-sheet]"),
    docW: document.documentElement.scrollWidth,
    winW: innerWidth,
  };
});

console.log("\n  full width by default");
{
  const p = await probe();
  ck("the sidebar starts full width", p.width === 256, `${p.width}px`);
  ck("with its labels", p.labels.includes("Cards") && p.labels.includes("Tutor"), p.labels.join(", "));
}

console.log("\n  minimized");
await page.click("[data-sidebar-toggle]");
await settled(page);
{
  const p = await probe();
  ck("the sidebar narrows to a rail", p.width === 64, `${p.width}px`);
  ck("the page takes the room", p.mainLeft === 64, `main starts at ${p.mainLeft}px`);
  ck("the nav shows icons, no labels", p.labels.length === 0, p.labels.join(", "));
  ck("each icon still names its page on hover", ["Cards", "Lessons", "Stats", "Tutor"].every((t) => p.titled.includes(t)), p.titled.join(", "));
  ck("exactly one item is still marked", p.marked === 1, `${p.marked}`);
  ck("the feedback icon sits under the avatar", p.fbBelowAvatar === true);
  ck("centred under it", p.fbCentred === true);
  ck("nothing scrolls sideways", p.docW === p.winW, `${p.docW} vs ${p.winW}`);
}

console.log("\n  remembered");
await page.reload();
await page.waitForSelector('button:has-text("Previous card")');
await settled(page);
ck("still minimized after a reload", (await probe()).width === 64);

console.log("\n  feedback widens it, and closing puts it back");
await page.click("[data-feedback-toggle]");
await settled(page);
{
  const p = await probe();
  ck("opening feedback widens the sidebar", p.width === 256, `${p.width}px`);
  ck("with the panel open in it", p.sheet);
}
await page.click("[data-feedback-toggle]");
await settled(page);
{
  const p = await probe();
  ck("closing feedback minimizes it again", p.width === 64 && !p.sheet, `${p.width}px, sheet ${p.sheet}`);
}

console.log("\n  the account menu is not clipped by the rail");
{
  await page.locator("[data-sidebar] button", { hasText: /^[A-Z]$/ }).click();
  await page.waitForTimeout(300);
  const onTop = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign out");
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.right - 10, r.top + r.height / 2);
    return hit === b || b.contains(hit);
  });
  ck("Sign out is visible and clickable past the rail's edge", onTop);
  await page.mouse.click(900, 40);
  await page.waitForTimeout(200);
}

console.log("\n  expanding restores it");
await page.click("[data-sidebar-toggle]");
await settled(page);
{
  const p = await probe();
  ck("full width again", p.width === 256 && p.labels.includes("Cards"), `${p.width}px`);
}

console.log("\n  phones are untouched");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
ck("no minimize button on a phone", (await page.locator("[data-sidebar-toggle]").count()) === 0);

// Leave the preference as it was found, for the suites that follow.
await page.evaluate(() => { try { localStorage.removeItem("sidebar:minimized"); } catch {} });
await finish(browser, ck);
