// A simulated student studying with the app's own rules, fast: no browser, no
// database. Every set is dealt by the app's buildSession, every answer
// scheduled by its applyAnswer, and every record written by its reviewRow and
// dealRow — so what comes out is shaped exactly like card_reviews, dealt_sets,
// user_cards and fsrs_settings, and the status check (src/lib/statusChecks.js)
// can be run on it.
//
// The student's memory is deliberately NOT FSRS (from the 2026-09-25 test):
// each card has its own hidden stability, which grows when it is recalled and
// collapses when it isn't, by rules FSRS doesn't share. Otherwise FSRS would
// only be graded against its own assumptions.
//
// Needs TZ set before any date is made (the runners set America/New_York).

import { buildSession, placeRetry, applyAnswer, BLOCK_SIZE } from "../../src/lib/sessionQueue.js";
import { RE_QUEUE_OFFSET, State, applySettings, settingsInUse, makeScheduler } from "../../src/lib/spacedRepetition.js";
import { sideOf, sideColumns, isTwoWay, otherDirection, directionsOf } from "../../src/lib/directions.js";
import { reviewedToday, localISODate, startOfLocalDay } from "../../src/lib/studyDay.js";
import { reviewRow } from "../../src/lib/reviewLog.js";
import { dealRow } from "../../src/lib/dealLog.js";
import { DEFAULT_TARGET, recordStudyDay, nextAutoTarget } from "../../src/lib/fsrsSettings.js";
import { RAW } from "../../src/data/cards.js";
import { LESSONS, lessonRank } from "../../src/data/lessons/index.js";
import { lessonSource, lessonCardKey, lessonIdOf } from "../../src/lib/lessonSource.js";
import { CAT_DB_TO_UI, CAT_UI_TO_DB } from "../../src/lib/cardCategories.js";

export const TIME_ZONE = "America/New_York";
export const USER_ID = "00000000-0000-0000-0000-00000000beef";
const DAY = 86400000;
const HOUR = 3600000;

// ── Seeded randomness ──────────────────────────────────────────────────
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng) {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;

// ── The deck ───────────────────────────────────────────────────────────
// A card never answered, either way.
const BLANK = {
  next_due_at: null, lapses: 0, stability: null, difficulty: null, fsrs_state: 0, reps: 0,
  last_review: null, last_answer_correct: null,
  en_next_due_at: null, en_lapses: 0, en_stability: null, en_difficulty: null, en_fsrs_state: 0,
  en_reps: 0, en_last_review: null, en_last_answer_correct: null,
};

// The demo deck and the lessons, shaped as useUserDeck shapes rows. Class
// dates are moved so the latest class was the day before the student starts,
// as a real notebook's would be: some classes are "recent", most older.
export function makeDeck({ start, cards: limit = Infinity } = {}) {
  const latest = RAW.flatMap((r) => r[3] || []).sort().pop();
  const shift = Math.round((start - DAY - Date.parse(`${latest}T12:00:00`)) / DAY);
  const move = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + shift);
    return localISODate(d);
  };
  const created = new Date(start - 30 * DAY).toISOString();
  const blank = BLANK;
  const seen = new Set();
  const cards = [];
  let rowId = 1;
  for (const [f, b, cat, dates] of RAW) {
    const id = f.toLowerCase().trim();
    if (seen.has(id) || cards.length >= limit) continue;
    seen.add(id);
    const ds = (dates || []).map(move);
    cards.push({ f, b, cat, dates: ds, freq: ds.length, id, row_id: rowId++, source: "cahier-upload", created_at: created, ...blank });
  }
  for (const lesson of LESSONS) {
    for (const [front, back, cat, , was] of lesson.cards) {
      const id = front.toLowerCase().trim();
      if (seen.has(id)) continue;
      seen.add(id);
      cards.push({
        f: front, b: back, cat: CAT_DB_TO_UI[cat] || "gram", dates: [], freq: 0, id, row_id: rowId++,
        source: lessonSource(lesson.id, lessonCardKey(was ?? front)), created_at: created, ...blank,
      });
    }
  }
  return cards;
}

// A shaped card back into a user_cards row, as the database would hold it:
// stability and difficulty are single precision there.
const f32 = (x) => (x == null ? x : Math.fround(x));
export function userCardRow(c) {
  return {
    id: c.row_id, user_id: USER_ID, front: c.f, back: c.b, category: CAT_UI_TO_DB[c.cat] || "V",
    dates: c.dates, source: c.source, created_at: c.created_at, flagged_for_review: false,
    next_due_at: c.next_due_at, lapses: c.lapses, stability: f32(c.stability), difficulty: f32(c.difficulty),
    fsrs_state: c.fsrs_state, reps: c.reps, last_review: c.last_review, last_answer_correct: c.last_answer_correct,
    en_next_due_at: c.en_next_due_at, en_lapses: c.en_lapses, en_stability: f32(c.en_stability),
    en_difficulty: f32(c.en_difficulty), en_fsrs_state: c.en_fsrs_state, en_reps: c.en_reps,
    en_last_review: c.en_last_review, en_last_answer_correct: c.en_last_answer_correct,
  };
}
// What the app reads back when it loads the deck: the same, single precision.
function reload(deck) {
  for (const c of deck) {
    c.stability = f32(c.stability); c.difficulty = f32(c.difficulty);
    c.en_stability = f32(c.en_stability); c.en_difficulty = f32(c.en_difficulty);
  }
}
// An answer's record as card_reviews holds it: its real columns single
// precision, the weights double.
function stored(row) {
  return {
    ...row,
    stability_before: f32(row.stability_before), difficulty_before: f32(row.difficulty_before),
    stability_after: f32(row.stability_after), difficulty_after: f32(row.difficulty_after),
    target: f32(row.target),
  };
}

// ── The student ────────────────────────────────────────────────────────
// kRight/kWrong: first stability after a first meeting right or wrong;
// gBase/gSlope: how much a recall grows it, more when it was harder.
export const STUDENTS = {
  weak: { kRight: 1.2, kWrong: 0.4, gBase: 1.5, gSlope: 4.0 },
  typical: { kRight: 2.4, kWrong: 0.5, gBase: 1.8, gSlope: 14.0 },
  strong: { kRight: 4.0, kWrong: 0.8, gBase: 2.2, gSlope: 18.0 },
};

class Student {
  constructor(seed, params) {
    this.rng = mulberry32(seed);
    this.p = params;
    this.items = new Map();
  }
  key(card, dir) { return `${card.row_id}:${dir}`; }
  trait(card, dir) {
    const k = this.key(card, dir);
    let it = this.items.get(k);
    if (!it) {
      // Drawn per card, so every variant meets the same card the same way.
      const r = mulberry32((card.row_id * 7919 + (dir === "en" ? 1 : 0)) ^ 0x51ed27);
      const m = Math.min(2.8, Math.max(0.35, Math.exp(0.45 * normal(r))));
      const twoWay = isTwoWay(card);
      const dirF = !twoWay ? 0.7 : dir === "en" ? 0.55 : 1.0;
      const catF = card.cat === "expr" ? 0.8 : 1.0;
      const b = !twoWay ? 0.12 : dir === "en" ? 0.08 : 0.22;
      const n = Math.max(1, (card.dates || []).length);
      it = { m, dirF, catF, pFirst: Math.min(0.8, 1 - Math.pow(1 - b, n)), S: null, last: null };
      this.items.set(k, it);
    }
    return it;
  }
  prob(card, dir, now) {
    const it = this.trait(card, dir);
    if (it.last === null) return { p: it.pFirst, first: true, t: null };
    const t = (now - it.last) / DAY;
    let p = Math.pow(0.9, t / it.S);
    if (isTwoWay(card)) {
      const o = this.items.get(this.key(card, otherDirection(dir)));
      if (o && o.last !== null && now - o.last <= 12 * HOUR) p = 1 - (1 - p) * 0.35;
    }
    if (now - it.last <= 2 * HOUR) p = Math.max(p, 0.85);
    return { p, first: false, t };
  }
  answer(card, dir, now) {
    const it = this.trait(card, dir);
    const pr = this.prob(card, dir, now);
    const got = this.rng() < pr.p;
    if (pr.first) it.S = (got ? this.p.kRight : this.p.kWrong) * it.m * it.dirF * it.catF;
    else if (pr.t >= 0.5) it.S = got ? it.S * (this.p.gBase + this.p.gSlope * (1 - pr.p)) : Math.max(0.3, it.S * 0.3);
    it.last = now;
    return { got, first: pr.first };
  }
  recall(card, dir, now) {
    const it = this.items.get(this.key(card, dir));
    if (!it || it.last === null) return 0;
    return Math.pow(0.9, (now - it.last) / DAY / it.S);
  }
}

// Seconds an answer takes: a new card is read and typed, a miss is read again.
export const SECONDS = { new: 20, right: 8, wrong: 16, retry: 10, checkpoint: 10 };

// ── A run ──────────────────────────────────────────────────────────────
//
//   days      how long
//   seed      the student's luck, calendar and shuffles
//   student   STUDENTS key, or params
//   target    "auto", or a fixed target (0.85, 0.9, 0.95)
//   start     the first day (ms)
//   cards     how many notebook cards (the lessons are always in)
//   lessons   how often a study day begins with a lesson's set
//   directions how often the direction setting is each of mix / fr / en
//   blocks    [p1, p2]: chance of 1 set, of up to 2, else 3
//   study     chance of studying on a given day
//   habit     "sets": that many sets and stop, whatever is due; "due": keep
//             going while sets still bring due cards, up to 6 sets a day
//   messy     the chance, each study day, of each of the habits the owner's
//             real record showed (2026-09-30 to 10-01) and a tidy student
//             never has: see below. 0, the default, leaves a run exactly as
//             it was before they were added.
export function simulate({
  days = 60, seed = 1, student = "typical", target = "auto", start = Date.parse("2026-09-27T00:00:00"),
  cards: limit = Infinity, lessons = 0.15, directions = { mix: 0.8, fr: 0.1, en: 0.1 },
  blocks = [0.55, 0.9], study = 0.85, habit = "sets", messy = 0,
} = {}) {
  uuidN = 0;
  const deck = makeDeck({ start, cards: limit });
  const byRow = new Map(deck.map((c) => [c.row_id, c]));
  const s = new Student(seed, typeof student === "string" ? STUDENTS[student] : student);
  const cal = mulberry32(seed * 31 + 7);
  const shuffle = mulberry32(seed * 17 + 3);
  const TIMES = [[7, 30], [12, 15], [18, 0], [20, 45], [22, 30], [23, 40]];
  const answers = [];
  const deals = [];
  const settings = {
    user_id: USER_ID, weights: null, fitted_at: null, target_mode: target === "auto" ? "auto" : "fixed",
    target: target === "auto" ? DEFAULT_TARGET : target, target_changed_at: null, days: [],
  };
  const m = { seconds: 0, answers: 0, counted: 0, newMet: 0, reviews: 0, reviewsRight: 0, dueLeft: [], targets: [] };
  // The messy habits draw on their own randomness, so a tidy run is the same
  // run it always was. `habits` counts each one as it happens.
  const mess = mulberry32(seed * 13 + 5);
  const habits = { oldCopy: 0, notes: 0, reload: 0, detour: 0 };
  let copy = null; // the deck as the browser saved it, the last time the page loaded
  let nextRow = Math.max(...deck.map((c) => c.row_id)) + 1;

  for (let day = 0; day < days; day++) {
    const studies = day === 0 || cal() < study;
    const [h, mi] = TIMES[Math.floor(cal() * TIMES.length)];
    const rb = cal();
    const nBlocks = rb < blocks[0] ? 1 : rb < blocks[1] ? 2 : 3;
    const lessonDay = cal() < lessons;
    const rd = cal();
    const direction = rd < directions.mix ? "mix" : rd < directions.mix + directions.fr ? "fr" : "en";
    const dayStart = new Date(start);
    dayStart.setDate(dayStart.getDate() + day);
    let now = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), h, mi).getTime();
    if (!studies) { m.dueLeft.push(dueCount(deck, now)); continue; }

    // Opening the app: the deck comes from the database, and once a study day
    // the automatic target has its say (useFsrsSettings).
    reload(deck);
    const today = localISODate(new Date(now));
    const behind = deck.some((c) => directionsOf(c).some((d) => {
      const x = sideOf(c, d);
      return x.fsrs_state !== State.New && x.next_due_at && Date.parse(x.next_due_at) < startOfLocalDay(new Date(now));
    }));
    settings.days = recordStudyDay(settings.days, today, behind);
    if (settings.target_mode === "auto") {
      const next = nextAutoTarget({ target: settings.target, days: settings.days, changedAt: settings.target_changed_at, today });
      if (next !== settings.target) {
        settings.target = next;
        settings.target_changed_at = new Date(now).toISOString();
      }
    }
    applySettings({ weights: settings.weights, retention: settings.target });
    m.targets.push(settings.target);

    // The messy habits. On opening, the browser's saved copy of the deck,
    // from the last time the page loaded, deals a set; the database's copy
    // arrives seconds later and the set is dealt again before anything in it
    // is answered. Partway through the first set: a class's notes arrive (some
    // notebook cards gain today's date, two new cards are made) and the rest
    // of the set is dealt again; or the page is reloaded and the same happens
    // without the notes; or the student goes into a lesson's set, answers a
    // few cards there, and comes back to the set they left, as they left it.
    const roll = () => messy > 0 && mess() < messy;
    const oldCopy = roll() && copy;
    const notesAt = roll() ? 3 + Math.floor(mess() * 12) : -1;
    const reloadAt = roll() ? 3 + Math.floor(mess() * 25) : -1;
    const detourAt = roll() ? 2 + Math.floor(mess() * 20) : -1;
    const opened = messy > 0 ? deck.map((c) => ({ ...c, dates: [...c.dates] })) : null;

    // One card answered: block[idx], in `block`, which comes back with any
    // retry placed in it.
    const answerAt = (block, idx) => {
      const item = block[idx];
      const card = byRow.get(item.row_id);
      const dir = item.shownDir;
      const side = sideOf(card, dir);
      const counted = !item._retry && !reviewedToday(side.last_review, new Date(now));
      const res = s.answer(card, dir, now);
      let sr = null;
      const before = counted ? sideColumns(side, dir) : null;
      if (counted) {
        sr = applyAnswer(card, res.got, now, dir);
        Object.assign(card, sr);
        m.counted++;
        if (side.fsrs_state === State.New) m.newMet++;
        else { m.reviews++; if (res.got) m.reviewsRight++; }
      }
      answers.push(stored(reviewRow({
        id: uuid(), userId: USER_ID, cardId: card.row_id, dir, got: res.got, before, after: sr, at: now,
        settings: counted ? settingsInUse() : null, timeZone: counted ? TIME_ZONE : null,
      })));
      m.answers++;
      const secs = item._retry ? SECONDS.retry : res.first ? SECONDS.new : res.got ? SECONDS.right : SECONDS.wrong;
      m.seconds += secs;
      if (!res.got) block = placeRetry(block, idx, { ...item, ...card, _rid: String(m.answers) }, RE_QUEUE_OFFSET);
      now += secs * 1000;
      return block;
    };

    // The rest of a set dealt again, as the app's redealRest does: what has
    // been reached and the retries lined up stay, the rest is dealt afresh.
    const redealRest = (block, at, pool, scope, lessonMode) => {
      const head = block.slice(0, at + 1);
      const tail = block.slice(at + 1);
      const kept = new Set(tail.filter((c) => c._retry));
      const room = tail.length - kept.size;
      if (room <= 0) return block;
      const dealt = buildSession(pool, { now, direction, target: room, lessonMode, lessonRank, rng: shuffle, inBlock: [...head, ...kept] });
      deals.push(dealRow({
        id: uuid(), userId: USER_ID, kind: "rest", scope, direction, slots: room, dealt,
        kept: [...head, ...kept], at: now, timeZone: TIME_ZONE,
      }));
      let f = 0;
      return [...head, ...tail.map((c) => (kept.has(c) ? c : dealt.queue[f++])).filter(Boolean)];
    };

    const notesArrive = () => {
      const today = localISODate(new Date(now));
      const notebook = deck.filter((c) => c.source === "cahier-upload" && !c.dates.includes(today));
      for (let i = 0; i < 4 && notebook.length; i++) {
        const c = notebook.splice(Math.floor(mess() * notebook.length), 1)[0];
        c.dates = [...c.dates, today];
        c.freq = c.dates.length;
      }
      const made = new Date(now).toISOString();
      for (let i = 0; i < 2; i++) {
        const f = `un mot nouveau ${day}-${i}`;
        const card = { f, b: `a new word ${day}-${i}`, cat: "vocab", dates: [today], freq: 1, id: f, row_id: nextRow++, source: "cahier-upload", created_at: made, ...BLANK };
        deck.push(card);
        byRow.set(card.row_id, card);
      }
    };

    let moreDue = true;
    for (let b = 0; b < (habit === "due" ? 6 : nBlocks); b++) {
      if (habit === "due" && b >= nBlocks && !moreDue) break;
      const lesson = lessonDay && b === 0 ? LESSONS[Math.floor(shuffle() * LESSONS.length)].id : null;
      const scope = `all|${lesson || "all"}`;
      const pool = (cards) => (lesson ? cards.filter((c) => lessonIdOf(c) === lesson) : cards);
      if (b === 0 && oldCopy) {
        const stale = buildSession(pool(copy), { now, direction, lessonMode: !!lesson, lessonRank, rng: shuffle });
        if (stale.queue.length) {
          deals.push(dealRow({ id: uuid(), userId: USER_ID, kind: "new", scope, direction, slots: BLOCK_SIZE, dealt: stale, at: now, timeZone: TIME_ZONE }));
          habits.oldCopy++;
          now += 12000;
        }
      }
      const dealt = buildSession(pool(deck), { now, direction, lessonMode: !!lesson, lessonRank, rng: shuffle });
      if (!dealt.queue.length) break;
      moreDue = dealt.dueRemaining > 0 || dealt.queue.some((x) => x._bucket !== "new");
      deals.push(dealRow({
        id: uuid(), userId: USER_ID, kind: "new", scope, direction,
        slots: BLOCK_SIZE, dealt, at: now, timeZone: TIME_ZONE,
      }));
      let block = dealt.queue;
      for (let idx = 0; idx < block.length; idx++) {
        if (b === 0 && idx === notesAt) {
          notesArrive();
          block = redealRest(block, idx, pool(deck), scope, !!lesson);
          habits.notes++;
        }
        if (b === 0 && idx === reloadAt) {
          block = redealRest(block, idx, pool(deck), scope, !!lesson);
          habits.reload++;
        }
        if (b === 0 && idx === detourAt && !lesson) {
          const away = LESSONS[Math.floor(mess() * LESSONS.length)].id;
          const there = buildSession(deck.filter((c) => lessonIdOf(c) === away), { now, direction, lessonMode: true, lessonRank, rng: shuffle });
          if (there.queue.length) {
            deals.push(dealRow({ id: uuid(), userId: USER_ID, kind: "new", scope: `all|${away}`, direction, slots: BLOCK_SIZE, dealt: there, at: now, timeZone: TIME_ZONE }));
            let other = there.queue;
            const few = 2 + Math.floor(mess() * 6);
            for (let j = 0; j < Math.min(few, other.length); j++) other = answerAt(other, j);
            now += 30000;
            habits.detour++;
          }
        }
        block = answerAt(block, idx);
      }
      m.seconds += SECONDS.checkpoint;
      now += 60000;
    }
    if (opened) copy = opened;
    m.dueLeft.push(dueCount(deck, now));
  }

  const end = new Date(start);
  end.setDate(end.getDate() + days);
  const endMs = end.getTime();
  let known = 0, bothWays = 0, seen = 0;
  for (const c of deck) {
    const ps = directionsOf(c).map((d) => s.recall(c, d, endMs));
    known += ps.reduce((a, b) => a + b, 0);
    bothWays += ps.length === 2 ? ps[0] * ps[1] : ps[0];
    for (const d of directionsOf(c)) if (sideOf(c, d).fsrs_state !== State.New) seen++;
  }
  return {
    answers, deals, settings,
    cards: deck.map(userCardRow),
    metrics: {
      ...m,
      messy: habits,
      hours: m.seconds / 3600,
      known, bothWays, seen,
      knownPerHour: known / Math.max(1e-9, m.seconds / 3600),
      reviewRetention: m.reviews ? m.reviewsRight / m.reviews : null,
    },
  };
}

// Known, and not fixed (found by the messy student, 2026-10-06): back from a
// detour into a lesson's set, the set left can ask a card that was just
// answered in the lesson again, straight away (not counted, since it was
// answered today). The set comes back as it was left, cards answered elsewhere
// since included. Whether every "asked twice in a row" in a run's status check
// is that, and how many there are, so a test can tell it from anything new.
export function detourRepeats(run, report) {
  const dealt = report.results.find((r) => r.id === "dealt");
  const pairs = [];
  const rows = run.answers;
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    if (a.card_id !== b.card_id || a.direction !== b.direction) continue;
    const at = Date.parse(a.answered_at);
    if (Date.parse(b.answered_at) - at >= 30 * 60000) continue;
    const fromLesson = run.deals.some((d) => d.scope !== "all|all" && Date.parse(d.dealt_at) <= at && at - Date.parse(d.dealt_at) < 10 * 60000);
    pairs.push(fromLesson && b.counted === false);
  }
  const details = dealt.details.length + (dealt.more || 0);
  const onlyThese = dealt.status === "pass" ||
    (pairs.length === details && pairs.every(Boolean) && dealt.details.every((d) => /was asked twice in a row/.test(d)));
  return { onlyThese, count: pairs.length };
}

function dueCount(deck, now) {
  const end = new Date(now);
  if (end.getHours() < 4) end.setDate(end.getDate() - 1);
  end.setDate(end.getDate() + 1);
  end.setHours(4, 0, 0, 0);
  let n = 0;
  for (const c of deck) for (const d of directionsOf(c)) {
    const x = sideOf(c, d);
    if (x.fsrs_state !== State.New && x.next_due_at && Date.parse(x.next_due_at) < end.getTime()) n++;
  }
  return n;
}

export { makeScheduler, lessonRank };
