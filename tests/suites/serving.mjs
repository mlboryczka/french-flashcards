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

import { buildSession, orderNewCards, classDaysOf, placeRetry, applyAnswer } from "../../src/lib/sessionQueue.js";
import { SIDE_FIELDS, sideOf, itemKey } from "../../src/lib/directions.js";
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


// ── Each way round is its own schedule ─────────────────────────────────
//
// Agreed with the owner, 2026-09-14: a word or phrase card is asked both ways,
// "la pomme → ?" and "apple → ?", each scheduled by FSRS from its own answers.
// Neither way waits for the other. Grammar and pronunciation cards are only
// ever asked as written. The direction setting chooses which ways of words and
// phrases are dealt; grammar comes up in every setting.
const en = (side) => Object.fromEntries(Object.entries(side).map(([k, v]) => [`en_${k}`, v]));
const DUE = { fsrs_state: 2, stability: 5, difficulty: 5, reps: 3, lapses: 0,
  next_due_at: new Date(NOW - DAY).toISOString(), last_review: new Date(NOW - 6 * DAY).toISOString(), last_answer_correct: true };
const LATER = { ...DUE, next_due_at: new Date(NOW + 10 * DAY).toISOString() };
const word = (fr, enSide, extra = {}) => ({
  row_id: nextId, id: `card-${nextId++}`, f: `mot ${nextId}`, b: "word", cat: "vocab",
  dates: ["2026-01-10"], source: "cahier-upload", fsrs_state: 0, ...fr, ...(enSide ? en(enSide) : {}), ...extra,
});
const rule = (fr = {}) => ({ ...word(fr), cat: "gram" });
const ways = (queue, card) => queue.filter((e) => e.row_id === card.row_id).map((e) => e.shownDir).sort().join("+");

console.log("\n  a word is asked both ways, each on its own schedule");
{
  const both = word(DUE, DUE);
  const { queue } = build([both]);
  ck("due both ways: both ways are in the block", ways(queue, both) === "en+fr", ways(queue, both));
  const frOnly = word(DUE, LATER);
  const enOnly = word(LATER, DUE);
  const q2 = build([frOnly, enOnly]).queue;
  ck("due only in French: only the French way is dealt", ways(q2, frOnly) === "fr", ways(q2, frOnly));
  ck("due only in English: only the English way is dealt", ways(q2, enOnly) === "en", ways(q2, enOnly));
  const g = rule(DUE);
  ck("a grammar card is dealt once, as written", ways(build([g]).queue, g) === "fr");
  const missedEn = word(LATER, { ...DUE, last_answer_correct: false });
  const q3 = build([missedEn, ...many(3, () => word(DUE))]);
  ck("missed last time in English is relearning in English only",
     q3.queue.find((e) => e.row_id === missedEn.row_id)?._bucket === "lapse" && ways(q3.queue, missedEn) === "en",
     JSON.stringify(q3.queue.filter((e) => e.row_id === missedEn.row_id).map((e) => [e.shownDir, e._bucket])));
}

console.log("\n  neither way waits for the other");
{
  const seenInFrench = word(DUE);
  const { queue } = build([seenInFrench]);
  ck("a word due in French and never asked in English gets both: a review and a new card",
     ways(queue, seenInFrench) === "en+fr", ways(queue, seenInFrench));
  const seenInEnglish = word({}, DUE);
  ck("and the same the other way round", ways(build([seenInEnglish]).queue, seenInEnglish) === "en+fr");
  const brandNew = many(40, () => word({}));
  const firsts = build(brandNew).queue;
  const dirs = new Set(firsts.map((e) => e.shownDir));
  ck("brand-new words are met either way first, not always the same way", dirs.has("fr") && dirs.has("en"), [...dirs].join(","));
}

console.log("\n  a word's two first meetings are kept apart");
{
  const brandNew = word({});
  const { queue } = build([brandNew]);
  ck("a brand-new word is dealt one way only in a block", queue.length === 1, ways(queue, brandNew));
  const metToday = word({ ...LATER, reps: 1, last_review: new Date(NOW - 3600000).toISOString() });
  ck("met for the first time this morning in French: not asked in English until tomorrow",
     ways(build([metToday]).queue, metToday) === "", ways(build([metToday]).queue, metToday));
  const metYesterday = word({ ...LATER, reps: 1, last_review: new Date(NOW - DAY).toISOString() });
  ck("met for the first time yesterday: asked in English today", ways(build([metYesterday]).queue, metYesterday) === "en");
  const knownAnsweredToday = word({ ...LATER, reps: 4, last_review: new Date(NOW - 3600000).toISOString() });
  ck("a word known for a while, answered in French today, can still be met in English today",
     ways(build([knownAnsweredToday]).queue, knownAnsweredToday) === "en");
  const enToday = word({}, { ...LATER, reps: 1, last_review: new Date(NOW - 3600000).toISOString() });
  ck("and met first in English this morning: French waits too", ways(build([enToday]).queue, enToday) === "");
  const twoDue = word({ ...DUE, reps: 1 }, { ...DUE, reps: 1 });
  ck("the rule is only about first meetings: two due reviews share a block", ways(build([twoDue]).queue, twoDue) === "en+fr");
}

console.log("\n  the direction setting");
{
  const w = word(DUE, DUE);
  const g = rule(DUE);
  const inSetting = (direction) => build([w, g], { direction }).queue;
  ck("FR→EN: words are asked in French", ways(inSetting("fr"), w) === "fr");
  ck("EN→FR: words are asked in English", ways(inSetting("en"), w) === "en");
  ck("Mixed: both", ways(inSetting("mix"), w) === "en+fr");
  ck("grammar is asked in every setting, as written",
     ["fr", "en", "mix"].every((d) => ways(inSetting(d), g) === "fr"),
     ["fr", "en", "mix"].map((d) => ways(inSetting(d), g)).join(" | "));
  const freshWord = word({});
  ck("EN→FR: a brand-new word is met in English", ways(build([freshWord], { direction: "en" }).queue, freshWord) === "en");
}

console.log("\n  one answer a day, per way round");
{
  const knownBoth = word({ ...DUE, stability: 90, next_due_at: new Date(NOW + 40 * DAY).toISOString(), last_review: new Date(NOW - 3600000).toISOString() },
    { ...DUE, stability: 90, next_due_at: new Date(NOW + 40 * DAY).toISOString() });
  const { queue } = build([...many(10, () => word(DUE)), knownBoth], { direction: "mix" });
  const spots = queue.filter((e) => e._bucket === "spot" && e.row_id === knownBoth.row_id).map((e) => e.shownDir);
  ck("answered today in French: may be spot-checked in English, never again in French",
     !spots.includes("fr"), spots.join(",") || "not spot-checked");
}

console.log("\n  re-dealing the rest of a block keeps what is already in it");
{
  const a = word(DUE, DUE);
  const b = word({});
  const staying = [{ ...a, shownDir: "fr", flippable: true, _bucket: "review" }, { ...b, shownDir: "en", flippable: true, _bucket: "new" }];
  const { queue } = build([a, b], { inBlock: staying });
  const keys = queue.map(itemKey);
  ck("an entry already in the block is not dealt again", !keys.includes(itemKey(staying[0])), keys.join(" "));
  ck("a word whose first meeting is in the block gets no second one", !queue.some((e) => e.row_id === b.row_id), keys.join(" "));
  ck("the other way of a due word still comes", keys.includes(`${a.row_id}:en`), keys.join(" "));
}

// ── The write: an answer lands on the way round it was asked ────────────
//
// The check that matters most. A write to the other way's columns would
// silently corrupt a schedule nothing on screen shows.
console.log("\n  an answer is recorded to the way round it was shown, and only that way");
{
  const card = word({ ...DUE, stability: 7 }, { ...DUE, stability: 30, reps: 9 });
  const enCols = SIDE_FIELDS.map((f) => `en_${f}`);
  const frWrite = applyAnswer({ ...card, shownDir: "fr" }, true, NOW);
  ck("shown in French: every field written is a French-side column",
     Object.keys(frWrite).length === SIDE_FIELDS.length && Object.keys(frWrite).every((k) => SIDE_FIELDS.includes(k)),
     Object.keys(frWrite).join(","));
  const enWrite = applyAnswer({ ...card, shownDir: "en" }, false, NOW);
  ck("shown in English: every field written is an English-side column",
     Object.keys(enWrite).length === enCols.length && Object.keys(enWrite).every((k) => enCols.includes(k)),
     Object.keys(enWrite).join(","));
  ck("each is computed from its own side's state: English reps 9 → 10, French 3 → 4",
     enWrite.en_reps === 10 && frWrite.reps === 4, `en ${enWrite.en_reps}, fr ${frWrite.reps}`);
  ck("a miss in English counts against English only", enWrite.en_lapses === 1 && enWrite.en_last_answer_correct === false);
  const after = { ...card, ...enWrite };
  ck("and leaves the French side exactly as it was",
     JSON.stringify(sideOf(after, "fr")) === JSON.stringify(sideOf(card, "fr")));
  ck("an explicit direction wins over the entry's own",
     Object.keys(applyAnswer({ ...card, shownDir: "fr" }, true, NOW, "en")).every((k) => k.startsWith("en_")));
  const g = applyAnswer({ ...rule(DUE) }, true, NOW);
  ck("a grammar card, shown as written, writes the French-side columns",
     Object.keys(g).every((k) => SIDE_FIELDS.includes(k)));
}

// ── Retries stay inside the block ───────────────────────────────────────
console.log("\n  a missed card is retried inside the block, never after it");
{
  const block = (n) => Array.from({ length: n }, (_, i) => ({ id: `b${i}` }));
  const at = (deck, id) => deck.findIndex((c) => c.id === id && c._retry);

  const d1 = placeRetry(block(50), 5, { id: "b5" }, 20);
  ck("the block stays 50 long", d1.length === 50, `${d1.length}`);
  ck("the retry comes 20 cards later", at(d1, "b5") === 26, `${at(d1, "b5")}`);
  ck("and the block's last unseen card makes way, for the next block", !d1.some((c) => c.id === "b49"));

  const d2 = placeRetry(block(50), 40, { id: "b40" }, 20);
  ck("a miss at card 41 is retried at the end, not past it", d2.length === 50 && at(d2, "b40") === 49, `${at(d2, "b40")}`);

  // 21 misses in a 50-card block, the case that ran to 71 cards: every
  // card missed, retries included, until 21 retries have been placed.
  let d = block(50), placed = 0;
  for (let i = 0; i < 50 && placed < 21; i++) {
    const before = d;
    d = placeRetry(d, i, d[i], 20);
    if (d !== before) placed++;
  }
  ck("21 misses placed, still 50 answers to the checkpoint", placed === 21 && d.length === 50, `${placed} placed, ${d.length} long`);

  ck("a miss on the last card has no room, and the block does not grow",
     placeRetry(block(50), 49, { id: "b49" }, 20).length === 50 && at(placeRetry(block(50), 49, { id: "b49" }, 20), "b49") === -1);
  ck("nor on the second-to-last: a retry straight after the miss proves nothing",
     at(placeRetry(block(50), 48, { id: "b48" }, 20), "b48") === -1);
  const allRetries = [...block(10), { id: "x", _retry: true }, { id: "y", _retry: true }];
  ck("a retry never displaces another retry",
     placeRetry(allRetries, 9, { id: "b9" }, 20) === allRetries);
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
