// Spaced-repetition block builder. Pure: no React, no Supabase.
//
// Inputs are the candidate cards (the whole deck, or one lesson's or one
// type's cards when the student has narrowed it) plus tuning knobs. Output is
// one BLOCK: up to 50 cards, after which the student sees how it went and can
// carry on with the next.
//
// FSRS decides when a card the student has seen comes back. It has no opinion
// on which new card comes next or how many — those are this file's decisions,
// agreed with the owner on 2026-09-12 (see the context doc's History).
//
// What goes in, in this order:
//   1. Lapses       missed last time, due today.
//   2. Reviews      due today, most overdue first.
//   3. New          ONLY once the due cards run out. A student who isn't
//                   keeping up with reviews gets no new cards on top; one
//                   who learned a lot yesterday gets review-heavy blocks
//                   until those are done. That is the whole of the new-card
//                   limit — no daily number, no forecast.
//   4. Spot-checks  two well-known cards, ignoring due date — cheap
//                   insurance against FSRS being over-confident.
//
// "Due today" means due any time before the end of the student's own day, so
// the day's work doesn't grow while they study.
//
// This replaces the old rule of reserving new-card slots BEFORE due work.
// That rule existed so a 1,300-card backlog wouldn't starve new material; the
// owner's call is that a backlog is exactly when new material should wait.
//
// ORDER within the block is then randomised. Priority decides *which* cards
// make the block; presenting them in fixed runs (all lapses, then all new) is
// blocked practice, which tests worse than interleaved practice for long-term
// retention. So: pick by priority, then shuffle.
//
// Each entry is { ...card, _bucket: "lapse" | "review" | "new" | "spot" }.
// FlashcardApp uses _bucket only for the counter; scoring is driven entirely
// by FSRS state in applyAnswer().

import {
  scheduler,
  toFsrsCard,
  fromFsrsCard,
  State,
  Rating,
  SPOT_CHECK_MIN_STABILITY_DAYS,
} from "./spacedRepetition.js";
import { endOfLocalDay, localISODate, localISODateDaysAgo, reviewedToday } from "./studyDay.js";
import { lessonIdOf } from "./lessonSource.js";

const DEFAULTS = Object.freeze({
  target: 50,
  spotCheckSlots: 2,
  // A class within this many days is "recent": what the student is being
  // taught right now, so its words come before the older pile.
  recentDays: 14,
});

function isNewCard(card) {
  // Never answered. fsrs_state is the only authority.
  //
  // This used to also require an empty `dates` array, on the assumption that
  // dates recorded past reviews. They don't — they're the LESSON dates a word
  // appeared on in the cahier, so every parsed card has them and no card ever
  // qualified as new. migration_007 fixes the stored data; this fixes the reader.
  return (card.fsrs_state ?? State.New) === State.New;
}

function dueMs(card) {
  if (!card.next_due_at) return 0;
  const t = new Date(card.next_due_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isWellKnown(card) {
  return (card.stability ?? 0) >= SPOT_CHECK_MIN_STABILITY_DAYS;
}

function shuffleInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// The classes a card came up in, as YYYY-MM-DD strings.
//
// Notes cards carry them in `dates`. A card the student added from the tutor
// chat came up in no class, so it is dated by the day it was added: it counts
// as recent for two weeks, then joins the older pile as a word seen once.
export function classDaysOf(card) {
  if (card?.source === "tutor-chat" && card.created_at) {
    const t = new Date(card.created_at);
    if (!Number.isNaN(t.getTime())) return [localISODate(t)];
  }
  return (Array.isArray(card?.dates) ? card.dates : []).filter(
    (d) => typeof d === "string" && ISO_DAY.test(d)
  );
}

// The order a student meets never-seen cards in.
//
// Inside a lesson: the lesson's teaching order, via `lessonRank`.
//
// Otherwise, from their notes:
//   1. Recent classes (the last `recentDays`), newest class first — this
//      week's words are the most useful now, and will come up again in class.
//   2. Earlier notes, the words that came up in the most classes first, the
//      older class first on a tie. Undated cards last.
//   3. Then unseen lesson cards, in lesson order. A student with notes will
//      rarely get this far; one with no notes yet still has something to
//      learn in normal study instead of an empty screen.
//
// Cards still tied after that are in random order (shuffled, then a stable
// sort), so two words from the same class don't always arrive in the same
// sequence.
export function orderNewCards(fresh, {
  now = Date.now(),
  lessonMode = false,
  lessonRank = () => null,
  recentDays = DEFAULTS.recentDays,
  rng = Math.random,
} = {}) {
  const pool = shuffleInPlace([...fresh], rng);
  const rankOf = (c) => {
    const r = lessonRank(c);
    return Number.isFinite(r) ? r : Infinity;
  };
  if (lessonMode) return pool.sort((a, b) => rankOf(a) - rankOf(b));

  const cutoff = localISODateDaysAgo(recentDays, new Date(now));
  const recent = [];
  const earlier = [];
  const undated = [];
  const lessons = [];
  for (const c of pool) {
    if (lessonIdOf(c)) { lessons.push(c); continue; }
    const days = classDaysOf(c);
    if (days.length === 0) { undated.push(c); continue; }
    const sorted = [...days].sort();
    const entry = { c, first: sorted[0], latest: sorted[sorted.length - 1], count: days.length };
    (entry.latest >= cutoff ? recent : earlier).push(entry);
  }
  recent.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : b.count - a.count));
  earlier.sort((a, b) => b.count - a.count || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  lessons.sort((a, b) => rankOf(a) - rankOf(b));
  return [
    ...recent.map((e) => e.c),
    ...earlier.map((e) => e.c),
    ...undated,
    ...lessons,
  ];
}

export function buildSession(cards, opts = {}) {
  const { target, spotCheckSlots, recentDays } = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  const endOfToday = endOfLocalDay(new Date(now));

  const lapses = [];
  const reviews = [];
  const fresh = [];
  const wellKnown = [];

  for (const c of cards) {
    const state = c.fsrs_state ?? State.New;
    if (isNewCard(c)) {
      fresh.push(c);
    } else if (dueMs(c) <= endOfToday) {
      // A card you missed last time. FSRS's Relearning state would say this
      // for us, but it only exists with minute-scale relearning steps turned
      // on, which this app doesn't use — so applyAnswer records the miss on
      // the row instead. (State is still checked for robustness in case the
      // scheduler config ever changes.)
      const missedLastTime =
        c.last_answer_correct === false ||
        state === State.Relearning ||
        state === State.Learning;
      if (missedLastTime) lapses.push(c);
      else reviews.push(c);
    } else if (isWellKnown(c) && !reviewedToday(c.last_review, new Date(now))) {
      // Not due, but known well enough that we can afford to sample it. Not
      // one already answered today: FSRS would not record the answer.
      wellKnown.push(c);
    }
  }

  // Most overdue first, so the oldest reviews survive the cut.
  reviews.sort((a, b) => dueMs(a) - dueMs(b));
  shuffleInPlace(wellKnown, rng);

  const due = [
    ...lapses.map((c) => ({ ...c, _bucket: "lapse" })),
    ...reviews.map((c) => ({ ...c, _bucket: "review" })),
  ];
  const spotSlots = Math.min(spotCheckSlots, wellKnown.length);
  const dueTaken = due.slice(0, Math.max(0, target - spotSlots));

  // New cards only in the room the due cards left.
  const newSlots = Math.max(0, target - spotSlots - dueTaken.length);
  const newTaken = newSlots > 0
    ? orderNewCards(fresh, {
        now,
        lessonMode: !!opts.lessonMode,
        lessonRank: opts.lessonRank,
        recentDays,
        rng,
      }).slice(0, newSlots).map((c) => ({ ...c, _bucket: "new" }))
    : [];

  // Spot-checks ride along with real work. With nothing due and nothing new
  // the student is caught up, and a block of two random known cards would
  // only be noise.
  const spots = dueTaken.length + newTaken.length > 0
    ? wellKnown.slice(0, spotSlots).map((c) => ({ ...c, _bucket: "spot" }))
    : [];

  const tagged = [...dueTaken, ...newTaken, ...spots];

  // Interleave: selection above was by priority, presentation is mixed.
  shuffleInPlace(tagged, rng);

  const counts = { lapse: 0, review: 0, new: 0, spot: 0 };
  for (const c of tagged) counts[c._bucket]++;

  return {
    queue: tagged,
    counts,
    // How much due work is left beyond this block. The checkpoint (stage 4)
    // uses it to say "the next blocks are reviews only".
    dueRemaining: due.length - dueTaken.length,
    newAvailable: fresh.length,
  };
}

// Compute the new scheduling state for a card after an answer.
//
// The app grades binary — you typed it right or you didn't — so we map onto
// two of FSRS's four ratings: Again for a miss, Good for a hit. Hard and Easy
// exist for apps where the user self-rates their own recall; here the typing
// check is the grade, and inventing a confidence signal the user never gave
// would only feed FSRS noise.
//
// Returns the exact column set user_cards accepts, so callers can use the
// same object for the DB update and the optimistic in-memory patch.
export function applyAnswer(card, got, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const { card: next } = scheduler.next(
    toFsrsCard(card),
    now,
    got ? Rating.Good : Rating.Again
  );
  return fromFsrsCard(next, got);
}
