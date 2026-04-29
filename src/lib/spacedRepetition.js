// Single source of truth for spaced-repetition tuning constants.
// Imported by both the session-queue builder and FlashcardApp's answer()
// so that scheduling stays consistent across queue inspection and mutation.

// Box → days until the card is due again.
//   1 → same session (re-queued in-memory by FlashcardApp on wrong answers)
//   2 → 1 day
//   3 → 3 days
//   4 → 7 days
//   5 → 21 days (with random spot-checks regardless of due date)
export const BOX_INTERVAL_DAYS = Object.freeze({
  1: 0,
  2: 1,
  3: 3,
  4: 7,
  5: 21,
});

// When a wrong-answer card is re-queued in the same session, insert it
// this many positions after the current index. Falls back to end-of-deck
// when the deck is shorter than this offset.
export const RE_QUEUE_OFFSET = 5;
