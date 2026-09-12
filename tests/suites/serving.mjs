// Which cards make a block, and the order new cards arrive in.
//
// Every check is a rule from the serving strategy agreed with the owner on
// 2026-09-12 (context doc, History), stated as the case that shows it. No
// browser: buildSession and orderNewCards are pure.
//
// Pinned to a timezone for the same reason as `dates`: "due today" and
// "recent classes" are the student's own day, and a suite run in UTC would
// wave through a UTC bug.
process.env.TZ = "America/New_York";

import { buildSession, orderNewCards, classDaysOf } from "../../src/lib/sessionQueue.js";
import { localISODate, localISODateDaysAgo } from "../../src/lib/studyDay.js";
import { lessonRank } from "../../src/data/lessons/index.js";
import LESSON from "../../src/data/lessons/imperatif.js";
import { lessonCardKey } from "../../src/lib/lessonSource.js";
import { checker } from "../check.mjs";

const ck = checker();
const DAY = 86400000;

// Saturday 12 September 2026, 10am in New York.
const NOW = new Date("2026-09-12T14:00:00Z").getTime();
ck("the timezone actually applied", new Date(NOW).getHours() === 10, `hour ${new Date(NOW).getHours()}`);

// A seeded generator, so a failure reproduces. Ties are meant to be random;
// the checks below never depend on how a tie falls.
function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

let nextId = 1;
const newCard = (extra = {}) => ({
  row_id: nextId, id: `card-${nextId++}`, f: `mot ${nextId}`, b: "word",
  fsrs_state: 0, dates: [], source: "cahier-upload", ...extra,
});
const reviewCard = (dueInMs, extra = {}) => ({
  row_id: nextId, id: `card-${nextId++}`, f: `mot ${nextId}`, b: "word",
  fsrs_state: 2, stability: 5, difficulty: 5, reps: 3,
  next_due_at: new Date(NOW + dueInMs).toISOString(),
  last_review: new Date(NOW - 5 * DAY).toISOString(),
  last_answer_correct: true, dates: ["2026-01-10"], source: "cahier-upload", ...extra,
});
const knownCard = (extra = {}) =>
  reviewCard(40 * DAY, { stability: 90, ...extra });
const many = (n, make) => Array.from({ length: n }, () => make());
const build = (cards, opts = {}) => buildSession(cards, { now: NOW, rng: rng(), ...opts });
const ids = (cards) => new Set(cards.map((c) => c.id));

// ── A block is 50 cards ─────────────────────────────────────────────────
console.log("\n  a block is at most 50 cards");
{
  const { queue } = build([...many(80, () => reviewCard(-DAY)), ...many(80, () => newCard())]);
  ck("a big deck deals exactly 50", queue.length === 50, `${queue.length}`);
  const small = build([...many(6, () => reviewCard(-DAY)), ...many(3, () => newCard())]);
  ck("a deck with less to do deals less, rather than padding", small.queue.length === 9, `${small.queue.length}`);
}

// ── Due means due any time today ────────────────────────────────────────
console.log("\n  due means due any time today, on the student's clock");
{
  const tonight = reviewCard(11 * 3600000); // 9pm today in New York
  const tomorrow = reviewCard(15 * 3600000); // 1am tomorrow
  const { queue } = build([tonight, tomorrow]);
  ck("a card due at 9pm is in a 10am block", ids(queue).has(tonight.id));
  ck("a card due at 1am tomorrow is not", !ids(queue).has(tomorrow.id));
}

// ── Due before new ──────────────────────────────────────────────────────
console.log("\n  due cards first, new cards only once they run out");
{
  const due = many(200, () => reviewCard(-DAY));
  const fresh = many(40, () => newCard({ dates: [localISODateDaysAgo(1, new Date(NOW))] }));
  const { queue, counts, dueRemaining } = build([...due, ...fresh]);
  ck("200 cards due: no new cards at all", counts.new === 0, JSON.stringify(counts));
  ck("the block is all due work", counts.review === 50, JSON.stringify(counts));
  ck("and it reports what's left beyond the block", dueRemaining === 150, `${dueRemaining}`);
}
{
  const due = many(30, () => reviewCard(-DAY));
  const fresh = many(100, () => newCard());
  const { counts } = build([...due, ...fresh]);
  ck("30 due: all 30 are in, and new cards fill the other 20", counts.review === 30 && counts.new === 20, JSON.stringify(counts));
}
{
  const { counts } = build(many(120, () => newCard()));
  ck("a brand-new student gets a block of new cards", counts.new === 50, JSON.stringify(counts));
}
{
  const missed = many(5, () => reviewCard(-DAY, { last_answer_correct: false }));
  const overdue = reviewCard(-30 * DAY);
  const rest = many(80, () => reviewCard(-DAY));
  const { queue } = build([...rest, overdue, ...missed]);
  const got = ids(queue);
  ck("every card missed last time makes the cut", missed.every((c) => got.has(c.id)));
  ck("the most overdue review makes the cut", got.has(overdue.id));
}

// ── Spot checks ─────────────────────────────────────────────────────────
console.log("\n  spot checks ride along with real work");
{
  const known = many(10, () => knownCard());
  const { counts } = build([...many(10, () => reviewCard(-DAY)), ...known]);
  ck("two well-known cards join a block", counts.spot === 2, JSON.stringify(counts));
  const caughtUp = build(known);
  ck("with nothing due and nothing new, there is no block of spot checks alone", caughtUp.queue.length === 0, `${caughtUp.queue.length}`);
  const answeredToday = knownCard({ last_review: new Date(NOW - 3600000).toISOString() });
  const { queue } = build([...many(10, () => reviewCard(-DAY)), answeredToday]);
  ck("a known card already answered today is not spot-checked again", !ids(queue).has(answeredToday.id));
}

// ── The order new cards come in, from notes ─────────────────────────────
console.log("\n  new cards from notes: recent classes first, newest first");
const daysAgo = (n) => localISODateDaysAgo(n, new Date(NOW));
{
  const thisWeek = newCard({ dates: [daysAgo(3)] });
  const yearOldButFrequent = newCard({ dates: ["2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"] });
  const lastWeek = newCard({ dates: [daysAgo(9)] });
  const order = orderNewCards([yearOldButFrequent, lastWeek, thisWeek], { now: NOW, rng: rng() }).map((c) => c.id);
  ck("this week's word comes before a year-old word from six classes",
     order.indexOf(thisWeek.id) < order.indexOf(yearOldButFrequent.id), order.join(" "));
  ck("the newest class comes first among recent ones",
     order.indexOf(thisWeek.id) < order.indexOf(lastWeek.id), order.join(" "));
  const taughtAgain = newCard({ dates: ["2025-10-01", daysAgo(2)] });
  const o2 = orderNewCards([yearOldButFrequent, taughtAgain], { now: NOW, rng: rng() }).map((c) => c.id);
  ck("an old word that came up again this week counts as recent",
     o2[0] === taughtAgain.id, o2.join(" "));
  const edge = newCard({ dates: [daysAgo(14)] });
  const past = newCard({ dates: [daysAgo(15)] });
  const o3 = orderNewCards([past, edge, yearOldButFrequent], { now: NOW, rng: rng() }).map((c) => c.id);
  ck("14 days ago is still recent, 15 is not",
     o3[0] === edge.id && o3.indexOf(yearOldButFrequent.id) < o3.indexOf(past.id), o3.join(" "));
}

console.log("\n  then earlier notes: most classes first, older class on a tie");
{
  const once = newCard({ dates: ["2026-03-01"] });
  const fourTimes = newCard({ dates: ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"] });
  const twiceLater = newCard({ dates: ["2026-04-01", "2026-05-01"] });
  const twiceEarlier = newCard({ dates: ["2026-01-01", "2026-05-01"] });
  const undated = newCard({ dates: [] });
  const order = orderNewCards([undated, once, twiceLater, fourTimes, twiceEarlier], { now: NOW, rng: rng() }).map((c) => c.id);
  ck("a word from four classes comes first", order[0] === fourTimes.id, order.join(" "));
  ck("two words from two classes: the one first taught earlier goes first",
     order.indexOf(twiceEarlier.id) < order.indexOf(twiceLater.id), order.join(" "));
  ck("a word from one class comes after both", order.indexOf(once.id) > order.indexOf(twiceLater.id), order.join(" "));
  ck("a card with no class date comes last", order[order.length - 1] === undated.id, order.join(" "));
}

console.log("\n  tutor chat cards are dated by the day they were added");
{
  const addedYesterday = newCard({ source: "tutor-chat", dates: [], created_at: new Date(NOW - DAY).toISOString() });
  const addedLastMonth = newCard({ source: "tutor-chat", dates: [], created_at: new Date(NOW - 30 * DAY).toISOString() });
  ck("its class day is the local day it was added",
     classDaysOf(addedYesterday)[0] === localISODate(new Date(NOW - DAY)), JSON.stringify(classDaysOf(addedYesterday)));
  const twoClassesOld = newCard({ dates: ["2026-02-01", "2026-03-01"] });
  const oneClassOld = newCard({ dates: ["2026-01-01"] });
  const order = orderNewCards([twoClassesOld, addedLastMonth, oneClassOld, addedYesterday], { now: NOW, rng: rng() }).map((c) => c.id);
  ck("added yesterday: it is a recent card and comes first", order[0] === addedYesterday.id, order.join(" "));
  ck("added a month ago: a word seen once, after the two-class word",
     order.indexOf(twoClassesOld.id) < order.indexOf(addedLastMonth.id), order.join(" "));
}

// ── Lessons ─────────────────────────────────────────────────────────────
const lessonCards = LESSON.cards.map(([front, back, category, section]) =>
  newCard({ f: front, b: back, cat: category, section, source: `lesson:${LESSON.id}#${lessonCardKey(front)}` })
);
const sectionIndex = (c) => LESSON.teachingOrder.indexOf(c.section);

console.log("\n  inside a lesson, new cards follow the lesson's teaching order");
{
  // Presented backwards, so the result can't be the input order by accident.
  const order = orderNewCards([...lessonCards].reverse(), { now: NOW, lessonMode: true, lessonRank, rng: rng() });
  ck("every lesson card has a place in the order", lessonCards.every((c) => lessonRank(c) !== null));
  ck("the first new card is from the first section taught",
     order[0].section === LESSON.teachingOrder[0], order[0].section);
  const seq = order.map(sectionIndex);
  const outOfOrder = seq.findIndex((v, i) => i > 0 && v < seq[i - 1]);
  ck("sections never go backwards", outOfOrder === -1,
     outOfOrder === -1 ? "" : `${order[outOfOrder - 1].section} then ${order[outOfOrder].section}`);
  ck("each exercise follows its own rule, not every rule",
     order.findIndex((c) => c.section === "ex1") < order.findIndex((c) => c.section === "ind2imp"));
  ck("within a section, the lesson's own card order is kept",
     order.filter((c) => c.section === "forms").map((c) => c.f).join("|") ===
       lessonCards.filter((c) => c.section === "forms").map((c) => c.f).join("|"));
  const unkeyed = newCard({ f: LESSON.cards[0][0], source: `lesson:${LESSON.id}` });
  ck("a row written before lesson keys existed is still placed, by its front", lessonRank(unkeyed) === lessonRank(lessonCards[0]));
  const { counts, queue } = build(lessonCards, { lessonMode: true, lessonRank });
  ck("a first block in a lesson is its first 50 cards in order, shuffled for presentation",
     counts.new === 50 && queue.every((c) => sectionIndex(c) <= sectionIndex(order[49])), JSON.stringify(counts));
}

console.log("\n  outside a lesson, unseen lesson cards wait behind the notes");
{
  const notes = many(10, () => newCard({ dates: ["2026-01-01"] }));
  const order = orderNewCards([...lessonCards.slice(0, 5), ...notes], { now: NOW, lessonRank, rng: rng() });
  ck("notes cards come first", order.slice(0, 10).every((c) => c.source === "cahier-upload"));
  const first50 = new Set(orderNewCards(lessonCards, { now: NOW, lessonMode: true, lessonRank, rng: rng() }).slice(0, 50).map((c) => c.id));
  const onlyLesson = build(lessonCards, { lessonRank });
  ck("a student with no notes yet still gets the lesson, not an empty screen, in lesson order",
     onlyLesson.counts.new === 50 && onlyLesson.queue.every((c) => first50.has(c.id)), JSON.stringify(onlyLesson.counts));
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
