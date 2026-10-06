// The status check in the app: the Status line in the profile menu, only for
// the admin; its alert on the avatar and the line while a check fails; its
// dialog. And the records it reads, as the app writes them: an answer's
// settings, saved without them (never not at all) before migration_013, and
// each set dealt.
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
// status check reads back as the student's answers. `verdicts`: Claude's
// verdicts that "Claude's marking" lists, served by a stand-in for
// /api/review-answer, which records every request in `checks`.
// `students`: the kept daily reports "All students" reads from a stand-in
// /api/admin-users?view=status.
async function open({ admin = true, migrated = true, record = [], verdicts = [], students = [] } = {}) {
  const reviews = [];   // every card_reviews write: { body, status }
  const deals = [];     // every dealt_sets write
  const checks = [];    // every answerChecks request
  const studentCalls = []; // every /api/admin-users?view=status request
  const { browser, page } = await openApp({
    app: admin ? ADMIN_APP : APP,
    route: async (p) => {
      await p.route("**/rest/v1/card_reviews*", async (r) => {
        const req = r.request();
        if (req.method() === "GET") {
          // The status check reads everything; checking for answers given
          // elsewhere reads only ids.
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
      await p.route("**/api/admin-users*", async (r) => {
        const url = new URL(r.request().url());
        studentCalls.push(url.search);
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reports: students }) });
      });
      await p.route("**/api/review-answer", async (r) => {
        const body = JSON.parse(r.request().postData() || "{}").answerChecks || {};
        checks.push(body);
        const json = (x) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(x) });
        if (body.action === "list") return json({ reviews: verdicts, runs: [], version: "abc1234" });
        if (body.action === "mark") return json({ ok: true });
        if (body.action === "test") {
          return json({ results: body.ids.map((id) => ({ id, says: verdicts.find((v) => v.id === id)?.owner_says, got: ["accept", "accept", "reject"] })) });
        }
        if (body.action === "save-run") return json({ ok: true, summary: { cases: body.cases.length, every: 0, sometimes: body.cases.length, never: 0 } });
        return r.fulfill({ status: 400, body: "{}" });
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
  return { browser, page, reviews, deals, checks, studentCalls, wait, click, grade, menu, counterTotal };
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
  await t.menu();
  ck("the admin has a Status line in the profile menu", (await t.page.locator("[data-status-toggle]").count()) === 1);
  ck("with no alert: nothing has failed", (await t.page.locator("[data-status-alert]").count()) === 0);
  await t.page.locator("[data-status-toggle]").click();
  await t.page.waitForSelector("[data-status]", { timeout: 5000 });
  await t.page.waitForSelector("[data-status-check]", { timeout: 10000 }).catch(() => null);
  const setCheck = await t.page.locator('[data-status-check="due-first"]').innerText().catch(() => "");
  ck("the checks that need the dealt sets say they're waiting for the update", /Waiting for the database update/.test(setCheck), setCheck.replace(/\s+/g, " "));
  ck("and none of them fails for it", (await t.page.locator('[data-status-result="fail"]').count()) === 0);
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

console.log("\n  a failed check shows: a dot on the avatar, a mark on the Status line, the details in the dialog");
{
  // An answer today whose schedule isn't the one the card now has.
  const now = Date.now();
  const record = [{
    id: "r-1", user_id: "00000000-0000-0000-0000-000000000001", card_id: 1, direction: "fr",
    answered_at: new Date(now - 3600000).toISOString(), correct: true, counted: true, rating: 3,
    state_before: 2, stability_before: 21, difficulty_before: 5, last_review_before: new Date(now - 22 * DAY).toISOString(),
    stability_after: 60, difficulty_after: 5, due_after: new Date(now + 40 * DAY).toISOString(),
  }];
  const t = await open({ migrated: true, record });
  await t.page.waitForSelector('[data-status-alert="avatar"]', { timeout: 12000 }).catch(() => null);
  ck("the avatar carries the alert", (await t.page.locator('[data-status-alert="avatar"]').count()) === 1);
  await t.menu();
  ck("and so does the Status line", (await t.page.locator('[data-status-alert="menu"]').count()) === 1);
  await t.page.locator("[data-status-toggle]").click();
  await t.page.waitForSelector("[data-status-check]", { timeout: 10000 }).catch(() => null);
  const kept = await t.page.locator('[data-status-check="kept"]').innerText().catch(() => "");
  ck("the dialog shows the failed check, naming the card", /une colline/.test(kept) && (await t.page.locator('[data-status-check="kept"][data-status-result="fail"]').count()) === 1,
     kept.replace(/\s+/g, " ").slice(0, 160));
  ck("with a button to copy the details for Claude", (await t.page.locator("[data-status-copy]").count()) === 1);
  await t.browser.close();
}

console.log("\n  All students: a student's failed check lights the alert, and the tab names it");
{
  const now = new Date().toISOString();
  const students = [
    { user_id: "a", user_email: "fine@example.com", checked_at: now, ok: true, failing: 0, answers: 40, report: { results: [] } },
    { user_id: "b", user_email: "faulty@example.com", checked_at: now, ok: false, failing: 1, answers: 25, report: { results: [
      { id: "not-early", title: "Nothing was asked before it was due", status: "fail", summary: "1 card was asked before it was due.",
        details: ["“une grenouille” was asked on Oct 5, but wasn't due until Oct 9."] },
    ] } },
  ];
  const t = await open({ migrated: true, students });
  await t.page.waitForSelector('[data-status-alert="avatar"]', { timeout: 12000 }).catch(() => null);
  ck("the avatar carries the alert, though the admin's own checks pass", (await t.page.locator('[data-status-alert="avatar"]').count()) === 1);
  await t.menu();
  await t.page.locator("[data-status-toggle]").click();
  await t.page.locator('[data-status-tab="students"]').click();
  await t.page.waitForSelector("[data-student-report]", { timeout: 5000 }).catch(() => null);
  const rows = await t.page.locator("[data-student-report]").evaluateAll((ns) => ns.map((n) => `${n.dataset.studentReport}:${n.dataset.studentOk}`));
  ck("every student is listed, the failing one first", rows.join() === "faulty@example.com:no,fine@example.com:yes", rows.join());
  await t.page.locator('[data-student-report="faulty@example.com"] button').click();
  const detail = (await t.page.locator('[data-student-report="faulty@example.com"]').innerText()).replace(/\s+/g, " ");
  ck("its details name the check and the card", /Nothing was asked before it was due/.test(detail) && /une grenouille/.test(detail), detail);
  await t.page.locator("[data-status-students] button", { hasText: "Check everyone now" }).click();
  await t.wait(400);
  ck("Check everyone now asks the server to check them all", t.studentCalls.some((q) => /view=status/.test(q) && /run=1/.test(q)), t.studentCalls.join(" "));
  await t.browser.close();
}

console.log("\n  Claude's marking: every verdict listed, the owner's call saved, the test run in batches");
{
  const verdicts = [
    { id: "v1", source: "asked", direction: "fr", front: "une grenouille", back: "a frog", expected: "a frog", typed: "a toad",
      verdict: "accept", reasoning: "close enough", user_email: "student@example.com", created_at: new Date().toISOString(), owner_says: null },
    { id: "v2", source: "asked", direction: "en", front: "un crapaud", back: "a toad", expected: "un crapaud", typed: "une crapaud",
      verdict: "reject", reasoning: "wrong gender", user_email: "student@example.com", created_at: new Date().toISOString(), owner_says: "reject" },
    { id: "v3", source: "kept", direction: "fr", front: "le ménage", back: "housework", expected: "housework", typed: "the housework",
      verdict: "accept", reasoning: null, user_email: "test@example.com", created_at: new Date().toISOString(), owner_says: null },
  ];
  const t = await open({ migrated: true, verdicts });
  await t.menu();
  await t.page.locator("[data-status-toggle]").click();
  await t.page.waitForSelector("[data-status]", { timeout: 5000 });
  ck("the Status window opens on your cards", (await t.page.locator('[data-status-tab="cards"][aria-selected="true"]').count()) === 1);
  await t.page.locator('[data-status-tab="answers"]').click();
  await t.page.waitForSelector("[data-answer-review]", { timeout: 5000 }).catch(() => null);
  ck("Claude's marking lists the verdicts not yet marked", (await t.page.locator("[data-answer-review]").count()) === 2,
     String(await t.page.locator("[data-answer-review]").count()));
  const first = (await t.page.locator('[data-answer-review="v1"]').innerText()).replace(/\s+/g, " ");
  ck("each says what was asked, what the card says, what was typed and what Claude decided",
     /Asked for the English of une grenouille/.test(first) && /The card says a frog/.test(first) && /Typed: a toad/.test(first) && /Claude: Accepted\. close enough/.test(first), first);
  const kept = (await t.page.locator('[data-answer-review="v3"]').innerText()).replace(/\s+/g, " ");
  ck("an answer accepted before verdicts were kept says so", /before verdicts were kept/.test(kept), kept);
  await t.page.locator('[data-answer-review="v1"] [data-says="reject"]').click();
  await t.wait(300);
  ck("marking sends the owner's call", t.checks.some((c) => c.action === "mark" && c.id === "v1" && c.says === "reject"), JSON.stringify(t.checks.at(-1)));
  ck("and the figures say how often Claude agreed with what's marked",
     /agreed with you on 1 of the 2 you've marked/.test(await t.page.locator("[data-status-answers]").innerText()));
  await t.page.locator("[data-answers-test] button").click();
  await t.page.waitForSelector("[data-answers-result]", { timeout: 5000 }).catch(() => null);
  const tested = t.checks.filter((c) => c.action === "test").flatMap((c) => c.ids);
  ck("the test asks about the marked answers only", tested.sort().join() === "v1,v2", tested.join());
  ck("and saves the run", t.checks.some((c) => c.action === "save-run" && c.cases.length === 2));
  const result = (await t.page.locator("[data-answers-result]").innerText().catch(() => "")).replace(/\s+/g, " ");
  ck("the result says how often Claude agreed, naming the answers it wavered on",
     /agreed with you every time on 0 of 2/.test(result) && /“a toad” for “a frog”: you say refuse; Claude agreed 1 of 3 times/.test(result), result);
  await t.browser.close();
}

console.log("\n  a student has no Status line");
{
  const t = await open({ admin: false });
  await t.menu();
  ck("not in the profile menu", (await t.page.locator("[data-status-toggle]").count()) === 0);
  ck("and never an alert", (await t.page.locator("[data-status-alert]").count()) === 0);
  await t.browser.close();
}

stop();
await finish(null, ck);
