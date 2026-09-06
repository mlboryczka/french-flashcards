// Shared setup for the browser suites.
//
// Every suite drives the real built app in headless Chromium against the mock
// Supabase in tests/mock-supabase.mjs, and asserts on MEASURED values —
// geometry, computed styles, request payloads — not on intent.
//
// Two rules learned the hard way, both from checks that passed while the app
// was wrong (or failed while it was right):
//
//   1. Write the assertion from the REQUIREMENT, not from the implementation.
//      A check derived from the code you just wrote can only confirm that
//      code. "The sidebar shrinks when the panel opens" passed for weeks; the
//      sidebar shrinking WAS the bug.
//   2. Never bake in a magic number that describes fixture data. Read it back
//      from the fixture. A hard-coded deck size silently goes stale and then
//      reports a failure the app didn't cause.

import { chromium } from "playwright-core";

export { checker } from "./check.mjs";

const CHROME =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export const APP = process.env.APP_URL || "http://localhost:5173";
export const MOCK = process.env.MOCK_URL || "http://127.0.0.1:5999";

// A JWT-shaped token whose payload decodes to the mock user. The app only
// base64-decodes the middle segment, so it needs no signature.
const SESSION = {
  access_token:
    "h.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.s",
  refresh_token: "r",
  token_type: "bearer",
  user: {
    id: "00000000-0000-0000-0000-000000000001",
    email: "test@example.com",
    aud: "authenticated",
  },
};

export async function openApp({ width = 1400, height = 900, route } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 180)));
  page.on("dialog", (d) => d.accept());

  await page.goto(APP);
  await page.evaluate((s) => {
    localStorage.setItem(
      "sb-127-auth-token",
      JSON.stringify({
        ...s,
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        expires_in: 7200,
      })
    );
  }, SESSION);
  // Routes must be registered before the reload that loads the deck.
  if (route) await route(page);
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await page.waitForTimeout(600);
  return { browser, page };
}

// The deck the mock actually served, so suites never hard-code a card count.
export async function servedDeck() {
  const res = await fetch(`${MOCK}/rest/v1/user_cards`);
  return res.json();
}

export async function finish(browser, ck) {
  await browser.close();
  const n = ck.fails();
  console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
  process.exit(n ? 1 : 0);
}

// Switch to the Stats view. Clicking the text node alone doesn't navigate —
// the handler is on an ancestor — so walk up until the view actually changes.
export async function gotoStats(page) {
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("aside *")].filter(
      (x) => x.textContent.trim() === "Stats"
    );
    const target = items[items.length - 1];
    for (let el = target; el; el = el.parentElement) {
      el.click();
      if (document.body.innerText.includes("Progress")) return;
    }
  });
  await page.waitForFunction(() => /Progress/.test(document.body.innerText), null, {
    timeout: 8000,
  });
  await page.waitForTimeout(400);
}

// Geometry of the pieces the layout suites care about.
export function layoutProbe(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const shell = main.parentElement;
    const cs = getComputedStyle(main);
    const aside = document.querySelector("aside");
    // Identified by a marker the component owns. Matching on a line of copy
    // broke when the subtitle was removed; matching on "a fixed panel with a
    // textarea" then matched the tutor as well.
    const sheet = document.querySelector("[data-feedback-sheet]");
    const r = sheet ? sheet.getBoundingClientRect() : null;
    const mainRect = main.getBoundingClientRect();
    const pb = parseFloat(cs.paddingBottom) || 0;
    const account = [...document.querySelectorAll("aside *")].find((n) =>
      /@example\.com/.test(n.textContent || "")
    );
    return {
      padBottom: Math.round(pb),
      padRight: Math.round(parseFloat(cs.paddingRight) || 0),
      boxSizing: cs.boxSizing,
      shellHeight: Math.round(shell.getBoundingClientRect().height),
      mainContentBottom: Math.round(mainRect.bottom - pb),
      sidebarBottom: Math.round(aside.getBoundingClientRect().bottom),
      accountTop: account ? Math.round(account.getBoundingClientRect().top) : null,
      sheet: r
        ? { height: Math.round(r.height), width: Math.round(r.width), top: Math.round(r.top), left: Math.round(r.left) }
        : null,
      tutorOpen: /Ask about a word/i.test(document.body.innerText),
      viewport: window.innerHeight,
    };
  });
}

// The flashcard element, found by the property that makes it the card.
export function cardBox(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => getComputedStyle(d).transformStyle === "preserve-3d"
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
      centreX: Math.round(r.left + r.width / 2),
      front: el.children[0]?.innerText.split("\n")[0] || "",
      back: el.children[1]?.innerText.split("\n")[0] || "",
    };
  });
}

// "CARD 4 OF 75" / "RETRY 2 OF 12" — the counter reads both ways.
export function sessionCounter(page) {
  return page.evaluate(() => {
    const m = document.body.innerText.match(/(?:CARD|RETRY) (\d+) OF (\d+)/i);
    return m ? { index: +m[1], total: +m[2] } : null;
  });
}

// Wait until nothing is animating before measuring.
//
// Sampling repeatedly until the value "stops changing" is not good enough: the
// panel easing (cubic-bezier(0.22, 0.61, 0.24, 1)) crawls at the end, so three
// consecutive samples can read identical while the element is still 12px from
// where it lands. Ask the browser instead — getAnimations() knows.
export async function settled(page) {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== "running"),
    null,
    { timeout: 5000 }
  ).catch(() => {});
  await page.waitForTimeout(50);
}

export async function enableTypeMode(page) {
  if (!(await page.$('input[placeholder^="Type"]'))) {
    await page.click('button:has-text("Type answer")');
  }
  await page.waitForSelector('input[placeholder^="Type"]', { timeout: 5000 });
}
