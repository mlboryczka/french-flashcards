// The Stats page: today's cards (new, reviews, retries), ~N remembered over
// time, seen / ~N remembered / not yet seen per area with each one's last 7
// days, and the days studied. Every expected figure is counted from the
// served fixture here, independently of the app's own calculation, so the
// check can't just agree with the code.
import { openApp, finish, checker, gotoStats } from "../harness.mjs";
import LESSON from "../../src/data/lessons/imperatif.js";
import { lessonCardKey } from "../../src/lib/lessonSource.js";

const ck = checker();
const DAY = 86400000;
const now = Date.now();
// The student's day, which runs from 4am to 4am (lib/studyDay.js): 1am
// belongs to the day before.
const localDay = (t) => {
  const d = new Date(t);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
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

// Asked in English too. A word is two schedules, and every figure below counts
// the two apart: 12 of the notes words have been asked in English — a third
// of them today, one in three of those wrong — due back over the next days.
for (let i = 0; i < 12; i++) {
  const r = rows[i * 4 + 1];
  Object.assign(r, {
    en_fsrs_state: 2, en_stability: 4, en_difficulty: 6, en_reps: 2, en_lapses: i % 5 === 0 ? 2 : 0,
    en_last_review: new Date(now - (i % 3 === 0 ? 120000 : 2 * DAY)).toISOString(),
    en_last_answer_correct: i % 9 !== 0,
    en_next_due_at: new Date(now + ((i % 4) + 1) * DAY).toISOString(),
  });
}

// Each card, each way round it is asked, under plain names: grammar only as
// written, words and phrases both ways.
const twoWay = (r) => r.category === "V" || r.category === "E";
const sides = rows.flatMap((r) => [
  { r, fsrs_state: r.fsrs_state, last_review: r.last_review, last_answer_correct: r.last_answer_correct, next_due_at: r.next_due_at },
  ...(twoWay(r) ? [{ r, fsrs_state: r.en_fsrs_state ?? 0, last_review: r.en_last_review, last_answer_correct: r.en_last_answer_correct, next_due_at: r.en_next_due_at }] : []),
]);
const isSeen = (r) => r.fsrs_state !== 0 || (twoWay(r) && (r.en_fsrs_state ?? 0) !== 0);
const today = localDay(now);
const answeredToday = sides.filter((x) => x.last_review && localDay(x.last_review) === today);
const rightToday = answeredToday.filter((x) => x.last_answer_correct === true);
// The record of answers, matching the cards: each way round a card has been
// answered has a counted answer at its last review. Ten of the notes cards
// answered today were met today for the first time; every other seen card was
// first met ten days ago (notes) or two days ago (the lesson). Three retries
// today on top: answers, but not first tries.
const newToday = new Set(rows.slice(0, 60).filter((r, i) => i % 3 === 1 && i % 2 === 0).map((r) => r.id));
const records = [];
let rid = 1;
const record = (r, dir, at, stateBefore, correct, stability, counted = true) => records.push({
  id: `rec${rid++}`, card_id: r.id, direction: dir, answered_at: new Date(at).toISOString(),
  correct, counted, state_before: counted ? stateBefore : null, stability_after: counted ? stability : null,
});
for (const r of rows) {
  if (r.fsrs_state !== 0) {
    const last = Date.parse(r.last_review);
    if (newToday.has(r.id)) record(r, "fr", last, 0, r.last_answer_correct, r.stability);
    else {
      const first = r.source.startsWith("lesson:") ? last : now - 10 * DAY;
      record(r, "fr", first, 0, true, 3);
      if (last !== first) record(r, "fr", last, 2, r.last_answer_correct, r.stability);
    }
  }
  if ((r.en_fsrs_state ?? 0) !== 0) record(r, "en", Date.parse(r.en_last_review), 0, r.en_last_answer_correct, r.en_stability);
}
const retriesToday = 3;
for (let i = 0; i < retriesToday; i++) record(rows[i * 3 + 1], "fr", now - 30000, null, true, null, false);
const todays = records.filter((x) => localDay(x.answered_at) === localDay(now));
const freshToday = todays.filter((x) => x.counted && newToday.has(x.card_id)).length;
const reviewsToday = todays.filter((x) => x.counted).length - freshToday;
const notes = rows.filter((r) => !r.source.startsWith("lesson:"));
const recent = notes.filter((r) => r.dates[0] >= daysAgo(14));
const earlier = notes.filter((r) => r.dates[0] < daysAgo(14));
const lesson = rows.filter((r) => r.source.startsWith("lesson:"));

const { browser, page } = await openApp({
  width: 1400, height: 1000,
  route: async (p) => {
    await p.route("**/rest/v1/user_cards*", async (r) => r.request().method() !== "GET" ? r.continue() :
      r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) }));
    await p.route("**/rest/v1/card_reviews*", async (r) => r.request().method() !== "GET" ? r.continue() :
      r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(records) }));
  },
});
await page.waitForTimeout(2500);
await gotoStats(page);
await page.waitForTimeout(800);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const within = (marker) => page.evaluate((m) => document.querySelector(m)?.innerText.replace(/\s+/g, " ") || "", marker);

console.log("\n  today");
// Every card studied today, in three, adding up: new + reviews + retries.
ck("today: every card, retries included",
   new RegExp(`Today ${todays.length} cards`, "i").test(text), `expected ${todays.length}: ${/today \S+ \S+/i.exec(text)?.[0]}`);
ck("today's cards in three: new, reviews, retries",
   text.includes(`${freshToday} new · ${reviewsToday} reviews · ${retriesToday} retries`),
   `expected ${freshToday} new · ${reviewsToday} reviews · ${retriesToday} retries`);
ck("the record agrees with the cards: one first try per way round answered today",
   freshToday + reviewsToday === answeredToday.length, `${freshToday} + ${reviewsToday} vs ${answeredToday.length}`);
ck("right first time today, out of the new cards and reviews",
   text.includes(`${rightToday.length} of ${answeredToday.length} cards (${freshToday} new + ${reviewsToday} reviews)`),
   `expected ${rightToday.length} of ${answeredToday.length} cards (${freshToday} new + ${reviewsToday} reviews)`);

console.log("\n  over time");
{
  const trend = await within("[data-stats-trend]");
  // Met in the last 7 days: cards whose first answer, either way round, came
  // after the end of the day a week ago (the cards met today, the lesson's 30
  // two days ago, and the words so far met only in English).
  const firstAt = new Map();
  for (const x of records) if (x.counted) {
    const t = Date.parse(x.answered_at);
    if (!firstAt.has(x.card_id) || t < firstAt.get(x.card_id)) firstAt.set(x.card_id, t);
  }
  const weekAgoEnd = (() => { const d = new Date(now); if (d.getHours() < 4) d.setDate(d.getDate() - 1); d.setHours(4, 0, 0, 0); d.setDate(d.getDate() - 6); return d.getTime() - 1; })();
  const met = [...firstAt.values()].filter((t) => t > weekAgoEnd).length;
  ck("the chart says what the last 7 days added, and how many new cards were met",
     /In the last 7 days: ~\d+ more remembered/.test(trend) && trend.includes(`, ${met} new cards met.`), trend.slice(0, 200));
  ck("the chart is drawn", await page.evaluate(() => !!document.querySelector("[data-stats-chart] path")));
  const days = await within("[data-stats-days]");
  const studied = new Set(records.map((x) => localDay(x.answered_at))).size;
  ck(`days studied: ${studied} of 11, since the first answer ten days ago`,
     days.includes(`${studied} of 11 days`), days.slice(0, 120));
  ck("the calendar says what its shades mean", /Didn't study.*Under 50 cards.*50 to 69 cards.*70 cards or more/.test(days), days);
}

console.log("\n  all cards, and each area");
const all = await within("[data-stats-all]");
ck("the whole deck's seen and not-yet-seen counts",
   all.includes(`${rows.length - rows.filter(isSeen).length} not yet seen`), all);
// A word or phrase is remembered only as far as it is remembered both ways,
// so the figure can never exceed the cards that could count at all: grammar
// seen, and words and phrases seen from French AND from English. Words seen
// one way — most of this fixture — must add nothing.
{
  const couldCount = rows.filter((r) => twoWay(r) ? r.fsrs_state !== 0 && (r.en_fsrs_state ?? 0) !== 0 : r.fsrs_state !== 0).length;
  const n = Number(/~(\d+) remembered/.exec(all)?.[1]);
  ck("~N remembered counts a word only once it is known both ways",
     Number.isFinite(n) && n > 0 && n <= couldCount, `${n} remembered, at most ${couldCount} could count; ${rows.filter(isSeen).length} seen`);
}
ck("students are never shown the two ways apart",
   !/understand|could say|shown in (French|English)|English → French|French → English/i.test(text), text.slice(0, 300));
const areas = await within("[data-stats-areas]");
const row = (label, list) =>
  ck(`${label}: ${list.filter(isSeen).length} seen of ${list.length}`,
     new RegExp(`${label.replace(/[()']/g, ".")}.*?${list.filter(isSeen).length} seen · ~\\d+ remembered · ${list.length} cards.*?(remembered in 7 days|no change in 7 days)`).test(areas), areas);
row(LESSON.title, lesson);
row("Last two weeks of class", recent);
row("Older classes", earlier);
{
  // Each group says which classes it holds, in dates.
  const long = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  ck("the recent group gives the date it starts", areas.includes(`Classes since ${long(daysAgo(14))}`), areas.slice(0, 300));
  const firstOlder = earlier.flatMap((r) => r.dates).sort()[0];
  const monthYear = new Date(`${firstOlder}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  ck("the older group runs from its first class to the day before", areas.includes(`${monthYear} to ${long(daysAgo(15))}`), areas.slice(0, 400));
}

// No forecast of cards due each day (owner, 2026-09-30): it counted each way
// round as a card, and a session deals due cards by itself.
ck("no \"Coming up\" forecast", !/coming up|due tomorrow/i.test(text), text.slice(0, 300));

console.log("\n  removed sections stay removed");
// By type and Hardest cards went on 2026-10-06 (owner).
ck("no By type section", !/By type|Progress by Type/i.test(text));
ck("no Hardest cards", !/Hardest cards/i.test(text));
ck("Progress by Lesson is the heading", /Progress by Lesson/.test(areas), areas.slice(0, 80));

console.log("\n  the old vocabulary is gone");
ck("no \"mastered\" anywhere on the page", !/mastered/i.test(text));
ck("no \"learning\" stage label", !/\d+ learning\b/i.test(text));

await finish(browser, ck);
