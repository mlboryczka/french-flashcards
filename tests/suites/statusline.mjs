// The records the status check reads, as the app writes them: an answer's
// settings, saved without them (never not at all) before migration_013, and
// each set dealt. The checks themselves run outside the app now (each morning,
// scripts/status-check.mjs --everyone), so nobody, the admin included, has a
// Status line in the profile menu or an alert on the avatar.
//
// Runs a second dev server with the test account as the admin, against the
// same mock Supabase; the usual one (APP_URL, default :5173) is the student.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openApp, finish, checker, sessionCounter, APP } from "../harness.mjs";

const ck = checker();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.ADMIN_APP_PORT || 5176);
const ADMIN_APP = `http://localhost:${PORT}`;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
const DAY = 86400000;

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT, detached: true, stdio: "ignore",
  env: {
    ...process.env,
    VITE_ADMIN_EMAIL: "test@example.com",
    VITE_SUPABASE_URL: process.env.MOCK_URL || "http://127.0.0.1:5999",
    VITE_SUPABASE_ANON_KEY: "test.key",
  },
});
const stop = () => { try { process.kill(-vite.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let i = 0; i < 150; i++) {
  try { await fetch(ADMIN_APP); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

// `migrated`: whether the database has had migration_013. `record`: what the
// app reads back as the student's answers.
async function open({ admin = true, migrated = true, record = [] } = {}) {
  const reviews = [];   // every card_reviews write: { body, status }
  const deals = [];     // every dealt_sets write
  const { browser, page } = await openApp({
    app: admin ? ADMIN_APP : APP,
    route: async (p) => {
      await p.route("**/rest/v1/card_reviews*", async (r) => {
        const req = r.request();
        if (req.method() === "GET") {
          const all = /select=\*/.test(req.url());
          return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(all ? record : []) });
        }
        if (req.method() === "POST") {
          const body = JSON.parse(req.postData() || "{}");
          const refused = !migrated && "target" in body;
          reviews.push({ body, status: refused ? 400 : 201 });
          if (refused) {
            return r.fulfill({ status: 400, contentType: "application/json", headers: CORS, body: JSON.stringify({ code: "PGRST204", message: "Could not find the 'lapses_before' column of 'card_reviews' in the schema cache" }) });
          }
          return r.fulfill({ status: 201, headers: CORS, body: "" });
        }
        return r.continue();
      });
      await p.route("**/rest/v1/dealt_sets*", async (r) => {
        const req = r.request();
        if (!migrated) {
          if (req.method() === "POST") deals.push({ body: JSON.parse(req.postData() || "{}"), status: 404 });
          return r.fulfill({ status: 404, contentType: "application/json", headers: CORS, body: JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.dealt_sets' in the schema cache" }) });
        }
        if (req.method() === "POST") {
          deals.push({ body: JSON.parse(req.postData() || "{}"), status: 201 });
          return r.fulfill({ status: 201, headers: CORS, body: "" });
        }
        return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" });
      });
    },
  });
  const wait = (ms = 400) => page.waitForTimeout(ms);
  const click = (t) => page.evaluate((x) => {
    const b = [...document.querySelectorAll("button")].find((n) => n.innerText.trim() === x);
    b?.click();
    return !!b;
  }, t);
  const grade = async (label) => {
    await page.keyboard.press(" ");
    await page.waitForSelector(`button:text-is("${label}")`, { timeout: 8000 }).catch(() => null);
    await click(label);
    await wait(700);
  };
  const menu = async () => {
    await page.locator("[data-sidebar] button", { hasText: /^[A-Z]$/ }).click();
    await wait(250);
  };
  const counterTotal = async () => (await sessionCounter(page))?.total ?? null;
  return { browser, page, reviews, deals, wait, click, grade, menu, counterTotal };
}

console.log("\n  before the database update: answers still save, without the extra details");
{
  const t = await open({ migrated: false });
  await t.grade("Got It");
  await t.grade("Got It");
  await t.wait(800);
  const [first, second, third, ...rest] = t.reviews;
  ck("the first answer's record is sent with its settings, and refused", first && "target" in first.body && first.status === 400, JSON.stringify(first?.status));
  ck("then sent again without them, and saved", second && !("target" in second.body) && second.status === 201 && second.body.id === first.body.id,
     JSON.stringify(second && Object.keys(second.body)));
  ck("the next answer goes straight to the form the database accepts", third && !("target" in third.body) && third.status === 201 && rest.length === 0,
     `${t.reviews.length} writes`);
  ck("and no answer is left unsaved", !(await t.page.evaluate(() => /not saved yet/.test(document.body.innerText))));
  ck("the set's record is tried once, and not again once refused", t.deals.length === 1, `${t.deals.length} tries`);
  await t.browser.close();
}

console.log("\n  after it: every counted answer says what it was scheduled with, and every set is recorded");
{
  const t = await open({ migrated: true });
  const total = await t.counterTotal();
  await t.grade("Got It");
  await t.wait(600);
  const saved = t.reviews.find((w) => w.body.counted);
  const b = saved?.body || {};
  ck("the answer records the target, the 21 weights, the time zone and the card's counts before it",
     Number.isFinite(b.target) && Array.isArray(b.weights) && b.weights.length === 21 && typeof b.time_zone === "string" && b.time_zone.length > 0 && Number.isInteger(b.reps_before),
     JSON.stringify({ target: b.target, w: b.weights?.length, tz: b.time_zone, reps: b.reps_before }));
  const set = t.deals.find((d) => d.body.kind === "new");
  ck("the set dealt is recorded, one entry per card in it", set && Array.isArray(set.body.items) && set.body.items.length === total,
     `${set?.body.items?.length} recorded, ${total} in the set`);
  ck("each with its card, its way round and why it was dealt",
     set && set.body.items.every((x) => Number.isFinite(x.c) && (x.d === "fr" || x.d === "en") && ["lapse", "review", "new"].includes(x.b)),
     JSON.stringify(set?.body.items?.[0]));
  await t.browser.close();
}

console.log("\n  no Status line and no alert, even on a record a check would fail");
{
  // An answer today whose schedule isn't the one the card now has.
  const now = Date.now();
  const record = [{
    id: "r-1", user_id: "00000000-0000-0000-0000-000000000001", card_id: 1, direction: "fr",
    answered_at: new Date(now - 3600000).toISOString(), correct: true, counted: true, rating: 3,
    state_before: 2, stability_before: 21, difficulty_before: 5, last_review_before: new Date(now - 22 * DAY).toISOString(),
    stability_after: 60, difficulty_after: 5, due_after: new Date(now + 40 * DAY).toISOString(),
  }];
  for (const admin of [true, false]) {
    const t = await open({ admin, record });
    await t.wait(4000);
    const who = admin ? "the admin" : "a student";
    ck(`${who}: no alert on the avatar`, (await t.page.locator("[data-status-alert]").count()) === 0);
    await t.menu();
    const items = await t.page.locator('[data-tour="profile-menu"] button').allInnerTexts();
    ck(`${who}: no Status line in the profile menu`, items.length > 0 && !items.some((x) => /Status/.test(x)), items.join(" | "));
    ck(`${who}: and no Status window`, (await t.page.locator("[data-status]").count()) === 0);
    await t.browser.close();
  }
}

stop();
await finish(null, ck);
