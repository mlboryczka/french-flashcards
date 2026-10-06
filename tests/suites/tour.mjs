// The first-visit tour (src/Tour.jsx, steps in src/lib/tourSteps.js).
//
// What the owner asked for (2026-10-06): a brand-new student is walked through
// the app, one part at a time, everything else dimmed, with a caption saying
// what to do; steps that ask the student to do something move on once they
// have; highlights appear in place rather than flying in; and the tour comes
// up only the first time, never again on that account, with "Take the tour
// again" to bring it back.
//
// The new student here starts with an empty deck, as a real one does: the
// lesson sync fills it with every lesson's cards, unanswered, and with no
// lesson switched on Cards has nothing to deal.

import { openApp, finish, checker } from "../harness.mjs";
import { LESSONS } from "../../src/data/lessons/index.js";
import { TOUR_LESSON } from "../../src/lib/tourSteps.js";

const ck = checker();
const LESSON = LESSONS.find((l) => l.id === TOUR_LESSON);
const USER_ID = "00000000-0000-0000-0000-000000000001";

// A stand-in for the student's rows and account: the deck keeps what the
// lesson sync writes; the account keeps what the app saves to user_metadata.
function makeStudent({ metadata = {} } = {}) {
  const rows = [];
  let nextId = 1;
  const meta = { ...metadata };
  const userWrites = [];
  const install = async (page) => {
    await page.route("**/rest/v1/user_cards**", async (route) => {
      const req = route.request();
      const json = (body) => route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body),
      });
      if (req.method() === "GET") return json(rows);
      if (req.method() === "POST") {
        for (const row of JSON.parse(req.postData() || "[]")) {
          const existing = rows.find((r) => r.front === row.front);
          if (existing) Object.assign(existing, row);
          else rows.push({
            id: nextId++, dates: [], flagged_for_review: false, batch_id: null,
            next_due_at: null, lapses: 0, stability: null, difficulty: null,
            fsrs_state: 0, reps: 0, last_review: null, last_answer_correct: null, ...row,
          });
        }
        return json([]);
      }
      return json([]);
    });
    await page.route("**/auth/v1/user**", async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.continue();
      if (req.method() === "PUT") {
        const data = JSON.parse(req.postData() || "{}").data || {};
        userWrites.push(data);
        Object.assign(meta, data);
      }
      await route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ id: USER_ID, email: "test@example.com", aud: "authenticated", user_metadata: meta }),
      });
    });
  };
  return { rows, meta, userWrites, install };
}

// The caption on screen, once it is showing.
const caption = (page) => page.evaluate(() => {
  const box = document.querySelector("[data-tour-box]");
  if (!box || getComputedStyle(box).visibility !== "visible") return null;
  return { title: box.querySelector("#tour-title")?.textContent, text: box.innerText };
});
async function waitForTitle(page, title, timeout = 6000) {
  await page.waitForFunction((t) => {
    const box = document.querySelector("[data-tour-box]");
    return box && getComputedStyle(box).visibility === "visible" && box.querySelector("#tour-title")?.textContent === t;
  }, title, { timeout }).catch(() => {});
  return (await caption(page))?.title;
}
// Is the element inside the lit part (allowing for rounding)?
const lit = (page, selector) => page.evaluate((sel) => {
  const hole = document.querySelector("[data-tour-hole]")?.getBoundingClientRect();
  const el = document.querySelector(sel)?.getBoundingClientRect();
  if (!hole || !el || !hole.width) return false;
  return el.left >= hole.left - 1 && el.top >= hole.top - 1 && el.right <= hole.right + 1 && el.bottom <= hole.bottom + 1;
}, selector);
const pulsing = (page, selector) => page.evaluate((sel) => {
  const ring = document.querySelector("[data-tour-pulse]")?.getBoundingClientRect();
  const el = document.querySelector(sel)?.getBoundingClientRect();
  if (!ring || !el) return false;
  return el.left >= ring.left && el.top >= ring.top && el.right <= ring.right && el.bottom <= ring.bottom;
}, selector);
const next = (page) => page.click("[data-tour-next]");
const centre = (page, selector) => page.evaluate((sel) => {
  const b = document.querySelector(sel)?.getBoundingClientRect();
  return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
}, selector);

// ── A brand-new student ───────────────────────────────────────────────
console.log("\n  A brand-new student's first sign-in");
const student = makeStudent();
let { browser, page } = await openApp({
  studyMode: null, tour: true, route: student.install, ready: "[data-tour-box]",
});
ck("the tour comes up by itself", (await waitForTitle(page, "Welcome to Déjà Review")) === "Welcome to Déjà Review");
ck("that it was shown is saved to the account", student.userWrites.some((w) => w.tour_shown === true),
  JSON.stringify(student.userWrites));
ck("nothing is lit on the first box", await page.evaluate(() => {
  const h = document.querySelector("[data-tour-hole]").getBoundingClientRect();
  return h.width === 0 && h.height === 0;
}));

// Highlights appear in place: sampled every frame from the press of Start,
// the lit part is either nothing or exactly where it ends up.
await page.evaluate(() => {
  window.__holes = [];
  const sample = () => {
    const h = document.querySelector("[data-tour-hole]");
    if (!h) return;
    const b = h.getBoundingClientRect();
    window.__holes.push([Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(","));
    if (window.__holes.length < 60) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
await next(page);
ck("Start the tour points at Lessons", (await waitForTitle(page, "Start with a lesson")) === "Start with a lesson");
await page.waitForTimeout(800);
const holes = await page.evaluate(() => window.__holes);
const final = holes[holes.length - 1];
const between = [...new Set(holes)].filter((h) => h !== final && !/,0,0$/.test(h));
ck("the highlight appears in place, without sliding there", between.length === 0, `in-between frames: ${between.slice(0, 3).join(" | ")}`);
ck("Lessons is lit and outlined", (await lit(page, '[data-tour="nav-lessons"]')) && (await pulsing(page, '[data-tour="nav-lessons"]')));

const stats = await centre(page, '[data-tour="nav-stats"]');
await page.mouse.click(stats.x, stats.y);
await page.waitForTimeout(400);
ck("a click on the dimmed part does nothing", (await caption(page))?.title === "Start with a lesson"
  && (await page.$("[data-tour-lesson]")) === null);

await page.click('[data-tour="nav-lessons"]');
ck("clicking Lessons moves the tour on to the lesson", (await waitForTitle(page, LESSON.title)) === LESSON.title);
ck("the lesson is lit, its Study button outlined",
  (await lit(page, `[data-tour-lesson="${LESSON.id}"]`)) && (await pulsing(page, `[data-tour-study="${LESSON.id}"]`)));

await page.click(`[data-tour-study="${LESSON.id}"]`);
ck("pressing Study asks for an answer", (await waitForTitle(page, "Answer the card")) === "Answer the card");
const prompt = await page.evaluate(() => document.querySelector('[data-tour="card"]')?.innerText || "");
const asked = (await caption(page))?.text || "";
ck("the caption names the card on screen", asked.split("\n").some((l) => /Type the answer to /.test(l)) &&
  prompt.split("\n").some((l) => l.trim() && asked.includes(l.trim())), asked.replace(/\n/g, " / "));
ck("the card and the answer box are lit", (await lit(page, '[data-tour="card"]')) && (await lit(page, '[data-tour="answer-row"]')));

await page.fill('[data-tour="answer-row"] input', "zzzz");
await page.keyboard.press("Enter");
ck("a wrong answer: the tour says so", (await waitForTitle(page, "Not this time")) === "Not this time");
ck("Continue is outlined", await pulsing(page, '[data-tour="continue"]'));
await page.click("[data-tour-back]");
await page.waitForTimeout(1500);
const backTo = (await caption(page))?.title;
ck("Back from the result goes back past the answered card, and stays there",
  backTo === LESSON.title, `caption: ${backTo}`);
await next(page);
const again = await page.waitForFunction(() => {
  const t = document.querySelector("[data-tour-box]")?.querySelector("#tour-title")?.textContent;
  return (t === "Answer the card" || t === "Not this time") && getComputedStyle(document.querySelector("[data-tour-box]")).visibility === "visible" ? t : null;
}, null, { timeout: 6000 }).then((h) => h.jsonValue()).catch(() => null);
if (again === "Answer the card") {
  await page.fill('[data-tour="answer-row"] input', "zzzz");
  await page.keyboard.press("Enter");
}
ck("…and Next leads back to the result", (await waitForTitle(page, "Not this time")) === "Not this time");
await page.click('[data-tour="continue"]');
ck("Continue leads to Show answer", (await waitForTitle(page, "Don’t know it?")) === "Don’t know it?");
ck("Show answer is outlined", await pulsing(page, '[data-tour="show-answer"]'));
await page.click('[data-tour="show-answer"]');
ck("then how cards come back, about the card just missed", (await waitForTitle(page, "How cards come back")) === "How cards come back"
  && /like this one/.test((await caption(page))?.text || ""));

const counterBefore = await page.evaluate(() => document.querySelector('[data-tour="well"]')?.innerText);
await page.keyboard.press("Enter");
ck("Enter on a step that explains moves the tour on", (await waitForTitle(page, "Lesson notes")) === "Lesson notes");
ck("…and leaves the card alone", (await page.$('[data-tour="continue"]')) !== null &&
  (await page.evaluate(() => document.querySelector('[data-tour="well"]')?.innerText)) === counterBefore);

await page.click("[data-lesson-toggle]");
ck("clicking Lesson notes opens them, lit", (await waitForTitle(page, "The rules, beside your cards")) === "The rules, beside your cards"
  && (await lit(page, '[data-tour="notes"]')));
await next(page);
ck("Settings opens the settings menu, lit", (await waitForTitle(page, "Settings")) === "Settings"
  && (await page.evaluate(() => getComputedStyle(document.querySelector("[data-settings-menu]")).display !== "none"))
  && (await lit(page, "[data-settings-menu]")));
await page.waitForTimeout(500);
ck("the notes have closed", (await page.$('[data-tour="notes"]')) === null ||
  (await page.evaluate(() => document.querySelector('[data-tour="notes"]').getBoundingClientRect().left >= window.innerWidth - 1)));
await next(page);
ck("the lesson switch, on the Lessons page", (await waitForTitle(page, "Lessons in your daily cards")) === "Lessons in your daily cards"
  && (await lit(page, `[data-lesson-include="${LESSON.id}"]`)));
ck("the settings menu has closed", await page.evaluate(() => {
  const m = document.querySelector("[data-settings-menu]");
  return !m || getComputedStyle(m).display === "none";
}));
ck("studying the lesson switched it on, and the caption says so",
  (await page.getAttribute(`[data-lesson-include="${LESSON.id}"]`, "aria-checked")) === "true"
  && /is now switched on/.test((await caption(page))?.text || ""));
await next(page);
ck("Cards, to come back to every day", (await waitForTitle(page, "Come back every day")) === "Come back every day"
  && (await lit(page, '[data-tour="nav-cards"]')));
await next(page);
ck("Stats", (await waitForTitle(page, "Your progress")) === "Your progress" && (await lit(page, '[data-tour="nav-stats"]')));
await next(page);
ck("the tutor", (await waitForTitle(page, "Ask the tutor")) === "Ask the tutor" && (await lit(page, '[data-tour="nav-tutor"]')));
await next(page);
const uploadTitle = await waitForTitle(page, "Add your class notes");
const uploadMarked = (await page.$('[data-tour="upload"][data-tour-mark]')) !== null;
const menuLit = await lit(page, '[data-tour="profile-menu"]');
ck("uploading class notes: the menu open, Upload document marked",
  uploadTitle === "Add your class notes" && uploadMarked && menuLit, `title ${uploadTitle}, marked ${uploadMarked}, lit ${menuLit}`);
const outside = await centre(page, '[data-tour="card"]') || { x: 900, y: 400 };
await page.mouse.click(outside.x, outside.y);
await page.waitForTimeout(300);
ck("a click on the dimmed part leaves the menu open", (await page.$('[data-tour="profile-menu"]')) !== null);
const upload = await centre(page, '[data-tour="upload"]');
await page.mouse.click(upload.x, upload.y);
await page.waitForTimeout(400);
ck("the lit menu is only to look at: Upload document opens nothing under the dimming",
  (await page.$('[data-tour="profile-menu"]')) !== null && (await page.evaluate(() => document.body.innerText.includes("Paste text"))) === false);
await next(page);
const fbTitle = await waitForTitle(page, "Tell us what’s wrong");
const menuGone = (await page.$('[data-tour="profile-menu"]')) === null;
const fbLit = await lit(page, "[data-feedback-toggle]");
ck("Send feedback, with the menu closed again", fbTitle === "Tell us what’s wrong" && menuGone && fbLit,
  `title ${fbTitle}, menu gone ${menuGone}, lit ${fbLit}`);
await next(page);
ck("the last box", (await waitForTitle(page, "You’re ready")) === "You’re ready");
await next(page);
await page.waitForTimeout(400);
ck("Finish closes the tour, back in the lesson", (await page.$("[data-tour-root]")) === null && (await page.$("[data-lesson-toggle]")) !== null);

await page.reload({ waitUntil: "commit" });
await page.waitForSelector('[data-tour="nav-cards"]', { timeout: 20000 });
await page.waitForTimeout(3000);
ck("it doesn't come back on a reload", (await page.$("[data-tour-root]")) === null);
await browser.close();

// ── The same account on another computer ──────────────────────────────
console.log("\n  The same account, signed in on another computer");
({ browser, page } = await openApp({
  studyMode: null, tour: true, route: student.install,
  ready: '[data-tour="nav-cards"]',
}));
await page.waitForTimeout(3000);
ck("the account says it was shown, so it doesn't come up", (await page.$("[data-tour-root]")) === null,
  `account: ${JSON.stringify(student.meta)}`);
await page.click('[data-tour="avatar"]');
await page.click("[data-tour-again]");
ck("Take the tour again brings it back", (await waitForTitle(page, "Welcome to Déjà Review")) === "Welcome to Déjà Review");
await page.click("[data-tour-back]");
await page.waitForTimeout(300);
ck("Not now closes it", (await page.$("[data-tour-root]")) === null);
await browser.close();

// ── A student who has studied before ──────────────────────────────────
// Every student sees it once, not only new ones (owner, 2026-10-06), even
// one the tour's first version marked with tour_seen without showing it.
console.log("\n  A student who already has answers");
const studied = makeStudent({ metadata: { tour_seen: true } });
studied.rows.push({
  id: 999, user_id: USER_ID, front: "la maison", back: "the house", category: "vocab", dates: [],
  flagged_for_review: false, batch_id: null, box: 1, lapses: 0, stability: 4, difficulty: 5,
  fsrs_state: 2, reps: 2, last_answer_correct: true,
  next_due_at: new Date(Date.now() + 3 * 86400000).toISOString(),
  last_review: new Date(Date.now() - 86400000).toISOString(),
});
({ browser, page } = await openApp({ tour: true, route: studied.install, ready: "[data-tour-box]" }));
ck("sees it too", (await waitForTitle(page, "Welcome to Déjà Review")) === "Welcome to Déjà Review");
ck("and that it was shown is saved to the account", studied.userWrites.some((w) => w.tour_shown === true),
  JSON.stringify(studied.userWrites));
ck("their answered card is untouched", studied.rows.find((r) => r.id === 999)?.reps === 2);
await browser.close();

// ── Keys during a step, for a student who flips ───────────────────────
// A key pressed to move the tour on must never turn or grade the card behind
// the dimming: only the steps where the student works the card hand keys to
// the app.
console.log("\n  Taking the tour again, flipping cards");
({ browser, page } = await openApp({ studyMode: "flip" }));
await page.click('[data-tour="avatar"]');
await page.click("[data-tour-again]");
await waitForTitle(page, "Welcome to Déjà Review");
await page.keyboard.press("Enter");
ck("Enter on the first box starts the tour", (await waitForTitle(page, "Start with a lesson")) === "Start with a lesson");
for (const key of ["Space", "ArrowRight", "ArrowLeft"]) {
  if ((await caption(page))?.title !== "Start with a lesson") {
    await page.click("[data-tour-back]").catch(() => {});
    await waitForTitle(page, "Start with a lesson");
  }
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
}
ck("keys pressed on a step that waits for a click never turn the card", (await page.$("[data-show-answer]")) !== null
  && (await page.$('[data-tour="grade"]')) === null);

await finish(browser, ck);
