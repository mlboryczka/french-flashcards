// Spaced-repetition session builder. Pure: no React, no Supabase.
//
// Inputs are the user's full deck (from useUserDeck) plus tuning knobs.
// Output is a tagged queue of cards to study this session, ordered:
//   1. Lapses        box-1 cards that have already been seen and are due now.
//   2. Reviews       boxes 2-4, sorted by oldest-due first.
//   3. New           never-seen cards, capped at NEW_CAP.
//   4. Spot-checks   random sample of mastered (box-5) cards, regardless of
//                    next_due_at — keeps the user honest about retention.
//
// Each entry is { ...card, _bucket: "lapse" | "review" | "new" | "spot" }.
// FlashcardApp uses _bucket only for the session-counter UI; scoring logic
// is bucket-independent (driven entirely by box transitions in answer()).

import { BOX_INTERVAL_DAYS } from "./spacedRepetition";

const DEFAULTS = Object.freeze({
  target: 75,
  newCap: 20,
  spotCheckSlots: 5,
});

function isNewCard(card) {
  // Never seen = box 1, no review history, no lapses.
  return (
    (card.box ?? 1) === 1 &&
    (!Array.isArray(card.dates) || card.dates.length === 0) &&
    (card.lapses ?? 0) === 0
  );
}

function dueMs(card) {
  if (!card.next_due_at) return 0;
  const t = new Date(card.next_due_at).getTime();
  return Number.isFinite(t) ? t : 0;
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
    const box = c.box ?? 1;
    if (box === 5) {
      mastered.push(c);
    } else if (isNewCard(c)) {
      fresh.push(c);
    } else if (box === 1 && dueMs(c) <= now) {
      lapses.push(c);
    } else if (box >= 2 && box <= 4 && dueMs(c) <= now) {
      reviews.push(c);
    }
  }

  reviews.sort((a, b) => dueMs(a) - dueMs(b));
  shuffleInPlace(fresh);
  shuffleInPlace(mastered);

  const tagged = [
    ...lapses.map((c) => ({ ...c, _bucket: "lapse" })),
    ...reviews.map((c) => ({ ...c, _bucket: "review" })),
    ...fresh.slice(0, newCap).map((c) => ({ ...c, _bucket: "new" })),
    ...mastered.slice(0, spotCheckSlots).map((c) => ({ ...c, _bucket: "spot" })),
  ].slice(0, target);

  const counts = { lapse: 0, review: 0, new: 0, spot: 0 };
  for (const c of tagged) counts[c._bucket]++;

  return { queue: tagged, counts };
}

// Compute the next-due timestamp for a card after an answer.
//
//   correct → box += 1 (cap at 5), next_due in BOX_INTERVAL_DAYS[newBox]
//   wrong   → box = 1 (or 2 if previously mastered), next_due = now
//
// Returns { box, next_due_at, lapses } so callers can apply both DB update
// and optimistic in-memory update from the same source of truth.
export function applyAnswer(card, got, nowMs = Date.now()) {
  const prevBox = card.box ?? 1;
  let newBox;
  if (got) {
    newBox = Math.min(5, prevBox + 1);
  } else {
    newBox = prevBox === 5 ? 2 : 1;
  }
  const days = BOX_INTERVAL_DAYS[newBox] ?? 0;
  const nextDueAt = new Date(nowMs + days * 86400 * 1000).toISOString();
  const newLapses = (card.lapses ?? 0) + (got ? 0 : 1);
  return { box: newBox, next_due_at: nextDueAt, lapses: newLapses };
}
