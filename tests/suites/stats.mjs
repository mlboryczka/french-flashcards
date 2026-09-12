// The Stats page: seen, about remembered and not yet seen, per area; today's
// answers; and what's coming up. Every expected figure is counted from the
// served fixture here, independently of the app's own calculation, so the
// check can't just agree with the code.
import { openApp, finish, checker, gotoStats } from "../harness.mjs";
import LESSON from "../../src/data/lessons/imperatif.js";
import { lessonCardKey } from "../../src/lib/lessonSource.js";

const ck = checker();
const DAY = 86400000;
const now = Date.now();
const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return localDay(d); };

// 60 notes cards (20 from recent classes, 40 older; two thirds seen), and the
// lesson with its first 30 cards seen.
let id = 1;
const rows = [];
for (let i = 0; i < 60; i++) {
  const seen = i % 3 !== 0;
  rows.push({
    id: id++, front: `mot ${i}`, back: `word ${i}`, category: "V",
    dates: i < 20 ? [daysAgo(i % 10)] : [daysAgo(40 + i)],
    flagged_for_review: false, batch_id: null, source: "cahier-upload",
    fsrs_state: seen ? 2 : 0, stability: seen ? 10 : null, difficulty: seen ? 5 : null, reps: seen ? 3 : 0, lapses: 0,
    // A third of the seen cards were answered today, one in four of those wrong.
    last_review: seen ? new Date(now - (i % 3 === 1 ? 60000 : 3 * DAY)).toISOString() : null,
    last_answer_correct: seen ? i % 4 !== 1 : null,
    next_due_at: seen ? new Date(now + ((i % 8) + 1) * DAY).toISOString() : null,
  });
}
LESSON.cards.forEach(([front, back, category], i) => {
  const seen = i < 30;
  rows.push({
    id: id++, front, back, category, dates: [], flagged_for_review: false, batch_id: null,
    source: `lesson:${LESSON.id}#${lessonCardKey(front)}`,
    fsrs_state: seen ? 2 : 0, stability: seen ? 5 : null, difficulty: seen ? 5 : null, reps: seen ? 2 : 0, lapses: 0,
    last_review: seen ? new Date(now - 2 * DAY).toISOString() : null, last_answer_correct: seen ? true : null,
    next_due_at: seen ? new Date(now + ((i % 3) + 1) * DAY).toISOString() : null,
  });
});

const isSeen = (r) => r.fsrs_state !== 0;
const today = localDay(now);
const answeredToday = rows.filter((r) => r.last_review && localDay(r.last_review) === today);
const rightToday = answeredToday.filter((r) => r.last_answer_correct === true);
const notes = rows.filter((r) => !r.source.startsWith("lesson:"));
const recent = notes.filter((r) => r.dates[0] >= daysAgo(14));
const earlier = notes.filter((r) => r.dates[0] < daysAgo(14));
const lesson = rows.filter((r) => r.source.startsWith("lesson:"));
const tomorrow = (() => { const d = new Date(now); d.setDate(d.getDate() + 1); return localDay(d); })();
const dueTomorrow = rows.filter((r) => isSeen(r) && localDay(r.next_due_at) === tomorrow).length;

const { browser, page } = await openApp({
  width: 1400, height: 1000,
  route: async (p) => {
    await p.route("**/rest/v1/user_cards*", async (r) => r.request().method() !== "GET" ? r.continue() :
      r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) }));
  },
});
await page.waitForTimeout(2500);
await gotoStats(page);
await page.waitForTimeout(800);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const within = (marker) => page.evaluate((m) => document.querySelector(m)?.innerText.replace(/\s+/g, " ") || "", marker);

console.log("\n  today");
ck("cards answered today, counted off each card's last review",
   text.includes(`TODAY ${answeredToday.length} cards answered`) || text.includes(`Today ${answeredToday.length} cards answered`),
   `expected ${answeredToday.length}`);
ck("right first time today",
   text.includes(`${rightToday.length} of ${answeredToday.length}`), `expected ${rightToday.length} of ${answeredToday.length}`);

console.log("\n  all cards, and each area");
const all = await within("[data-stats-all]");
ck("the whole deck's seen and not-yet-seen counts",
   all.includes(`${rows.length - rows.filter(isSeen).length} not yet seen`), all);
const areas = await within("[data-stats-areas]");
const row = (label, list) =>
  ck(`${label}: ${list.filter(isSeen).length} seen of ${list.length}`,
     new RegExp(`${label.replace(/[()']/g, ".")}.*?${list.filter(isSeen).length} seen · about \\d+ remembered · ${list.length} cards`).test(areas), areas);
row(LESSON.title, lesson);
row("Your recent classes", recent);
row("Your earlier notes", earlier);

console.log("\n  coming up");
const coming = await within("[data-stats-coming-up]");
ck("cards due tomorrow", coming.includes(`${dueTomorrow} due tomorrow`), coming.slice(0, 120));

console.log("\n  the old vocabulary is gone");
ck("no \"mastered\" anywhere on the page", !/mastered/i.test(text));
ck("no \"learning\" stage label", !/\d+ learning\b/i.test(text));

await finish(browser, ck);
