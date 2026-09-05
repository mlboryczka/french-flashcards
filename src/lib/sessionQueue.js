// Spaced-repetition session builder. Pure: no React, no Supabase.
//
// Inputs are the user's full deck (from useUserDeck) plus tuning knobs.
// Output is a tagged queue of cards to study this session.
//
// Selection is by priority, in this order:
//   1. Lapses       cards you're relearning after a miss, due now.
//   2. Reviews      cards in normal rotation, due now, oldest-due first.
//   3. New          never-seen cards, capped at newCap.
//   4. Spot-checks  a random sample of well-known cards, ignoring due date —
//                   cheap insurance against FSRS being over-confident.
//
// ORDER is then randomised. Those are two different decisions and it matters
// that they're separate: priority decides *which* cards you see when the
// queue is longer than the target, but presenting them in fixed blocks
// (all lapses, then all reviews, then all new) is blocked practice, which
// tests worse than interleaved practice for long-term retention. So we pick
// by priority, then shuffle the result.
//
// Each entry is { ...card, _bucket: "lapse" | "review" | "new" | "spot" }.
// FlashcardApp uses _bucket only for the session-counter UI; scoring logic
// is bucket-independent (driven entirely by FSRS state in applyAnswer()).

import {
  scheduler,
  toFsrsCard,
  fromFsrsCard,
  State,
  Rating,
  MASTERED_STABILITY_DAYS,
} from "./spacedRepetition";

const DEFAULTS = Object.freeze({
  target: 75,
  newCap: 20,
  spotCheckSlots: 5,
});

function isNewCard(card) {
  // Never reviewed. FSRS state is the authority; the dates/lapses checks
  // catch pre-FSRS rows that migration_006 didn't seed for some reason.
  return (
    (card.fsrs_state ?? State.New) === State.New &&
    (!Array.isArray(card.dates) || card.dates.length === 0) &&
    (card.lapses ?? 0) === 0
  );
}

function dueMs(card) {
  if (!card.next_due_at) return 0;
  const t = new Date(card.next_due_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isMastered(card) {
  return (card.stability ?? 0) >= MASTERED_STABILITY_DAYS;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function buildSession(cards, opts = {}) {
  const { target, newCap, spotCheckSlots } = { ...DEFAULTS, ...opts };
  const now = Date.now();

  const lapses = [];
  const reviews = [];
  const fresh = [];
  const mastered = [];

  for (const c of cards) {
    const state = c.fsrs_state ?? State.New;
    if (isNewCard(c)) {
      fresh.push(c);
    } else if (dueMs(c) <= now) {
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
    } else if (isMastered(c)) {
      // Not due, but known well enough that we can afford to sample it.
      mastered.push(c);
    }
  }

  // Oldest-due first, so the most overdue reviews survive the target cut.
  reviews.sort((a, b) => dueMs(a) - dueMs(b));
  shuffleInPlace(fresh);
  shuffleInPlace(mastered);

  const tagged = [
    ...lapses.map((c) => ({ ...c, _bucket: "lapse" })),
    ...reviews.map((c) => ({ ...c, _bucket: "review" })),
    ...fresh.slice(0, newCap).map((c) => ({ ...c, _bucket: "new" })),
    ...mastered.slice(0, spotCheckSlots).map((c) => ({ ...c, _bucket: "spot" })),
  ].slice(0, target);

  // Interleave: selection above was by priority, presentation is mixed.
  shuffleInPlace(tagged);

  const counts = { lapse: 0, review: 0, new: 0, spot: 0 };
  for (const c of tagged) counts[c._bucket]++;

  return { queue: tagged, counts };
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
