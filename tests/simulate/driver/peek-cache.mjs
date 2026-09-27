// Reads the app's localStorage caches in a profile without running the app
// (opens a same-origin URL that serves no app code).
import { chromium } from "playwright-core";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const prof = process.argv[2];
const ctx = await chromium.launchPersistentContext(prof, { executablePath: CHROME, headless: true, timezoneId: "America/New_York" });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("http://127.0.0.1:5190/assets/index-CpdmZ51d.css").catch(() => {});
const out = await page.evaluate(() => {
  const res = {};
  for (const k of Object.keys(localStorage)) {
    const v = localStorage.getItem(k);
    res[k] = { bytes: v.length };
    if (k.startsWith("deck-cache:")) {
      const d = JSON.parse(v);
      const st = {};
      for (const c of d.cards) { const key = `${c.fsrs_state}/${c.en_fsrs_state}`; st[key] = (st[key] || 0) + 1; }
      res[k].cards = d.cards.length; res[k].states = st;
      res[k].lastReviews = d.cards.map((c) => c.last_review).filter(Boolean).sort().slice(-3);
    }
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await ctx.close();
