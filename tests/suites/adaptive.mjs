// A student's own FSRS settings: the target's rules, the answer histories the
// fitting reads, and api/fsrs-fit.js run against a stand-in database with the
// real optimizer, on a simulated student whose memory is NOT what the starting
// settings assume. No browser, nothing leaves the machine.
//
// The rules under test are the owner's (2026-09-26): a student's settings are
// fitted from their own answers once there are about 1,000, and used only if
// they predict the student's latest answers better; whenever the settings in
// use change, every card's estimate is worked out again from its answers, and
// no due date moves; the target is the student's choice, or automatic —
// easing from 90% towards 85% while they're behind.
process.env.TZ = "America/New_York";

import { checker } from "../check.mjs";
import {
  STARTING_WEIGHTS, STARTING_VERSION, DEFAULT_TARGET, AUTO_FLOOR, FIRST_FIT,
  targetOf, recordStudyDay, nextAutoTarget, fitDue, usableWeights,
} from "../../src/lib/fsrsSettings.js";
import { buildHistories, fittingSequences, replayHistory, studyDayNumber } from "../../src/lib/fsrsHistory.js";
import { makeScheduler, scheduleAnswer, applySettings, scheduler as live, Rating } from "../../src/lib/spacedRepetition.js";
import { endOfLocalDay } from "../../src/lib/studyDay.js";
import { fitUser } from "../../api/fsrs-fit.js";
import * as binding from "@open-spaced-repetition/binding";
import { createEmptyCard } from "ts-fsrs";

const ck = checker();
const TZ = "America/New_York";
const DAY = 86400000;

// ── The target ──────────────────────────────────────────────────────────
console.log("\n  the target: the student's choice, or automatic");
{
  ck("no settings yet: 90%", targetOf(null) === DEFAULT_TARGET);
  ck("a target read back from the database as 0.8500000238 is 85%", targetOf({ target: 0.8500000238418579 }) === 0.85);
  const week = (behind) => Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-0${i + 1}`, behind: behind(i) }));
  ck("behind on 5 of the last 7 study days: two points lower",
     nextAutoTarget({ target: 0.9, days: week((i) => i < 5), today: "2026-10-08" }) === 0.88);
  ck("behind on 4 of 7: no change", nextAutoTarget({ target: 0.9, days: week((i) => i < 4), today: "2026-10-08" }) === 0.9);
  ck("never below 85%", nextAutoTarget({ target: AUTO_FLOOR, days: week(() => true), today: "2026-10-08" }) === AUTO_FLOOR);
  ck("keeping up on 5 of 7: two points back up",
     nextAutoTarget({ target: 0.86, days: week((i) => i >= 5), today: "2026-10-08" }) === 0.88);
  ck("but never above 90%", nextAutoTarget({ target: 0.9, days: week(() => false), today: "2026-10-08" }) === 0.9);
  ck("not two steps in one week",
     nextAutoTarget({ target: 0.88, days: week(() => true), changedAt: "2026-10-04T10:00:00Z", today: "2026-10-08" }) === 0.88);
  ck("fewer than 7 study days on record: no change",
     nextAutoTarget({ target: 0.9, days: week(() => true).slice(0, 6), today: "2026-10-08" }) === 0.9);
  const days = recordStudyDay(recordStudyDay([], "2026-10-01", true), "2026-10-01", false);
  ck("a study day is recorded once: the first open of the day wins", days.length === 1 && days[0].behind === true, JSON.stringify(days));
  const many = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`).reduce((d, date) => recordStudyDay(d, date, false), []);
  ck("and only the last 14 are kept", many.length === 14 && many[0].date === "2026-10-07", `${many.length} from ${many[0].date}`);
}

console.log("\n  when a fit is tried");
{
  ck(`not before ${FIRST_FIT} answers`, !fitDue({ answers: FIRST_FIT - 1 }));
  ck(`at ${FIRST_FIT}, the first time`, fitDue({ answers: FIRST_FIT }));
  const checkedAt = "2026-10-01T12:00:00Z";
  ck("again only with 500 more answers", !fitDue({ answers: 1400, checkedAt, checkedAnswers: 1000, now: Date.parse("2026-12-01") }));
  ck("and a month on", !fitDue({ answers: 1600, checkedAt, checkedAnswers: 1000, now: Date.parse("2026-10-20") }));
  ck("with both, again", fitDue({ answers: 1600, checkedAt, checkedAnswers: 1000, now: Date.parse("2026-11-02") }));
  ck("the starting settings are 21 usable numbers", usableWeights(STARTING_WEIGHTS)?.length === 21);
}

// ── Histories ───────────────────────────────────────────────────────────
console.log("\n  the answers a history is made of");
{
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  ck("9pm and 7:30am the next morning are one day apart in New York",
     studyDayNumber(Date.parse(at(5, 7, 30)), TZ) - studyDayNumber(Date.parse(at(4, 21)), TZ) === 1);
  ck("11:30pm and 12:30am are the same day", studyDayNumber(Date.parse(at(5, 0, 30)), TZ) === studyDayNumber(Date.parse(at(4, 23, 30)), TZ));
  const r = (card, dir, when, correct, extra = {}) => ({ card_id: card, direction: dir, answered_at: when, correct, counted: true, state_before: 2, ...extra });
  const rows = [
    r(1, "fr", at(3, 10), false, { state_before: 0 }),
    r(1, "fr", at(1, 10), true, { state_before: 0 }),     // before a reset
    r(1, "fr", at(2, 10), true),
    r(1, "fr", at(4, 10), true, { counted: false }),      // a retry: not FSRS's answer
    r(1, "fr", at(5, 10), true),
    r(1, "en", at(4, 21), true, { state_before: 0 }),
    r(2, "fr", at(2, 9), true, { state_before: 2, stability_before: 12, difficulty_before: 4, last_review_before: at(1, 9) }),
  ];
  const hs = buildHistories(rows);
  const h1 = hs.find((h) => h.key === "1:fr");
  ck("one history per card per way round", hs.length === 3, hs.map((h) => h.key).join(" "));
  ck("only the answers FSRS counted, in the order they were given",
     h1.answers.length === 2 && h1.answers[0].at === Date.parse(at(3, 10)), JSON.stringify(h1.answers));
  ck("after Reset all progress the history starts again at the card's first new answer", h1.fresh && !h1.answers[0].got);
  const h2 = hs.find((h) => h.key === "2:fr");
  ck("a card learned before answers were kept starts from its state then", !h2.fresh && h2.seed.stability === 12);
  const seqs = fittingSequences(hs, TZ);
  ck("the fitting sees only histories from a card's first answer", seqs.length === 1, JSON.stringify(seqs));
  ck("as right (3) and wrong (1), days apart", JSON.stringify(seqs[0].map((x) => [x.rating, x.deltaT])) === "[[1,0],[3,2]]", JSON.stringify(seqs[0]));
}

// ── A simulated student ─────────────────────────────────────────────────
// Studies every evening at 8:30pm or the next morning at 7:30am — the two
// sides of UTC's midnight — for 120 days: every card due, then 12 new ones.
// Their memory runs on FSRS with weights of its own (a faster forgetter than
// the starting settings assume); the app schedules them with whatever
// settings are in use, exactly as it does in the browser, and keeps the
// answers as card_reviews rows.
function rng(seed) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const HIDDEN = [...STARTING_WEIGHTS];
HIDDEN[0] = 0.1; HIDDEN[2] = 1.2; HIDDEN[8] = 1.2; HIDDEN[20] = 0.4;
function simulate({ days = 120, newPerDay = 12, seed = 7 } = {}) {
  const truth = makeScheduler({ weights: HIDDEN });
  const rand = rng(seed);
  const cards = [], reviews = [], hidden = new Map();
  let id = 1;
  const answer = (c, at) => {
    const before = { fsrs_state: c.fsrs_state, stability: c.stability, difficulty: c.difficulty, last_review: c.last_review };
    const h = hidden.get(c.id);
    const p = h.state === 0 ? 0.3 : truth.forgetting_curve((at - h.last_review.getTime()) / DAY, h.stability);
    const got = rand() < p;
    hidden.set(c.id, truth.next(h, new Date(at), got ? Rating.Good : Rating.Again).card);
    Object.assign(c, scheduleAnswer(c, got, at));
    reviews.push({
      id: `${c.id}-${reviews.length}`, user_id: "u1", card_id: c.id, direction: "fr", answered_at: new Date(at).toISOString(),
      correct: got, counted: true, state_before: before.fsrs_state, stability_before: before.stability,
      difficulty_before: before.difficulty, last_review_before: before.last_review,
    });
  };
  for (let d = 0; d < days; d++) {
    const at = new Date(2026, 5, 1 + d, d % 2 ? 20 : 7, 30).getTime();
    let t = at;
    for (const c of cards) if (Date.parse(c.next_due_at) <= endOfLocalDay(new Date(at))) answer(c, (t += 20000));
    for (let k = 0; k < newPerDay; k++) {
      const c = { id: id++, user_id: "u1", fsrs_state: 0, stability: null, difficulty: null, reps: 0, lapses: 0, next_due_at: null, last_review: null, last_answer_correct: null, en_fsrs_state: 0, en_last_review: null };
      cards.push(c);
      hidden.set(c.id, createEmptyCard(new Date(t)));
      answer(c, (t += 20000));
    }
  }
  return { cards, reviews };
}

// The database, as fitUser reads and writes it.
function standIn({ cards, reviews, settings = [], noTable = false }) {
  const tables = { user_cards: cards, card_reviews: reviews, fsrs_settings: settings };
  const calls = { rpc: 0, upserts: [] };
  const query = (name) => {
    const filters = [];
    let order = [];
    const run = () => {
      let rows = tables[name].filter((r) => filters.every(([k, v]) => r[k] === v));
      for (const [k, asc] of [...order].reverse()) rows = [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
      return rows;
    };
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push([k, v]); return q; },
      order: (k, o = {}) => { order.push([k, o.ascending !== false]); return q; },
      range: async (a, b) => ({ data: run().slice(a, b + 1).map((r) => ({ ...r })), error: null }),
      maybeSingle: async () => noTable && name === "fsrs_settings"
        ? { data: null, error: { code: "PGRST205", message: "Could not find the table" } }
        : { data: run()[0] ? { ...run()[0] } : null, error: null },
      upsert: async (row) => {
        calls.upserts.push(row);
        const i = tables[name].findIndex((r) => r.user_id === row.user_id);
        if (i >= 0) tables[name][i] = { ...tables[name][i], ...row }; else tables[name].push({ ...row });
        return { error: null };
      },
    };
    return q;
  };
  return {
    tables, calls,
    from: query,
    // As migration_012's function: stability and difficulty only, and only
    // where the card's last answer is still the one the estimate came from.
    rpc: async (fn, { p_user_id, p_rows }) => {
      calls.rpc++;
      let n = 0;
      for (const x of p_rows) {
        const c = cards.find((r) => r.id === x.id && r.user_id === p_user_id);
        if (!c) continue;
        const last = x.direction === "en" ? c.en_last_review : c.last_review;
        if (!last || Date.parse(last) !== Date.parse(x.last_review)) continue;
        if (x.direction === "en") Object.assign(c, { en_stability: x.stability, en_difficulty: x.difficulty });
        else Object.assign(c, { stability: x.stability, difficulty: x.difficulty });
        n++;
      }
      return { data: n, error: null };
    },
  };
}

console.log("\n  a card's estimate, worked out again from its answers");
{
  applySettings({});
  const { cards, reviews } = simulate({ days: 30, newPerDay: 5, seed: 3 });
  const hs = buildHistories(reviews);
  let same = 0, n = 0, worst = 0;
  for (const h of hs) {
    const c = cards.find((x) => x.id === h.cardId);
    const e = replayHistory(h, { sched: live, timeZone: TZ });
    n++;
    const diff = Math.abs(e.stability - c.stability) / c.stability;
    worst = Math.max(worst, diff);
    if (diff < 1e-6 && Math.abs(e.difficulty - c.difficulty) < 1e-6) same++;
  }
  ck("replaying a card's answers gives exactly what the app scheduled, answer by answer", same === n && n > 50, `${same} of ${n}, worst ${worst}`);
}

console.log("\n  the server: waiting, fitting, keeping, and never moving a due date");
{
  applySettings({});
  const small = simulate({ days: 12, newPerDay: 10, seed: 11 });
  const db = standIn(small);
  const dues = new Map(small.cards.map((c) => [c.id, c.next_due_at]));
  const first = await fitUser({ admin: db, userId: "u1", timeZone: TZ, optimizer: binding });
  ck(`under ${FIRST_FIT} answers: waiting, and no fit tried`, first.status === "waiting" && first.answers < FIRST_FIT && !db.tables.fsrs_settings[0]?.weights, JSON.stringify(first));
  ck("but a first visit brings every card's estimate in line with the starting settings",
     first.recomputed > 0 && db.tables.fsrs_settings[0]?.computed_with === `start:${STARTING_VERSION}`, JSON.stringify(first));
  ck("without moving a single due date", small.cards.every((c) => c.next_due_at === dues.get(c.id)));
  const again = await fitUser({ admin: db, userId: "u1", timeZone: TZ, optimizer: binding });
  ck("a second visit the same day does nothing", again.recomputed === 0 && again.status === "waiting", JSON.stringify(again));

  const big = simulate({ days: 120, newPerDay: 12, seed: 5 });
  const bigDues = new Map(big.cards.map((c) => [c.id, c.next_due_at]));
  // One card answered after its answers were read: its row has moved on.
  const moved = big.cards[10];
  moved.last_review = new Date(Date.parse(moved.last_review) + 3 * DAY).toISOString();
  const movedS = moved.stability;
  const db2 = standIn(big);
  const fit = await fitUser({ admin: db2, userId: "u1", timeZone: TZ, optimizer: binding });
  const row = db2.tables.fsrs_settings[0];
  ck(`at ${FIRST_FIT}+ answers a fit is tried`, fit.answers >= FIRST_FIT && !!fit.fit, JSON.stringify(fit.fit));
  ck("and used, because it predicts the student's latest answers better than the starting settings",
     fit.status === "fitted" && fit.fit.lossFitted < fit.fit.lossInUse && usableWeights(row.weights)?.length === 21, JSON.stringify(fit.fit));
  ck("every card's estimate is worked out again under the student's own settings", fit.recomputed > 100 && row.computed_with === `fit:${row.fitted_at}`, `${fit.recomputed}`);
  const mine = makeScheduler({ weights: row.weights });
  const h = buildHistories(big.reviews).find((x) => x.cardId === big.cards[3].id);
  ck("an estimate is the card's own answers played through those settings",
     Math.abs(replayHistory(h, { sched: mine, timeZone: TZ }).stability - big.cards[3].stability) < 1e-3 * big.cards[3].stability);
  ck("no due date moved", big.cards.every((c) => c.next_due_at === bigDues.get(c.id)));
  ck("and a card answered meanwhile is left alone", moved.stability === movedS);

  // A fit that predicts worse is not used.
  const worse = { ...binding, computeParameters: async () => { const w = [...STARTING_WEIGHTS]; w[0] = w[1] = w[2] = w[3] = 90; return w; } };
  const db3 = standIn(simulate({ days: 120, newPerDay: 12, seed: 9 }));
  const kept = await fitUser({ admin: db3, userId: "u1", timeZone: TZ, optimizer: worse });
  ck("a fit that predicts the latest answers worse is not used", kept.status === "kept" && !db3.tables.fsrs_settings[0].weights && kept.fit.lossFitted > kept.fit.lossInUse, JSON.stringify(kept.fit));
  ck("and the next try waits for 500 more answers and a month",
     db3.tables.fsrs_settings[0].fit_checked_answers === kept.answers && !!db3.tables.fsrs_settings[0].fit_checked_at);

  const none = await fitUser({ admin: standIn({ ...small, noTable: true }), userId: "u1", timeZone: TZ, optimizer: binding });
  ck("before migration_012 is run, nothing is done", none.status === "not-set-up", JSON.stringify(none));
}

applySettings({});
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
