// The record of every answer (card_reviews, migration_010). Pure.
//
// Only the current FSRS state used to be kept, never the answers that
// produced it — which is why nobody could say which way round any past answer
// had been, and why FSRS could never be tuned to how this student forgets.
// Now each answer is a row: the card, which way round, when, right or wrong,
// and whether it was the answer FSRS counted for the day.
//
// The id is made here, not by the database. A save that fails is retried with
// the same row, and a grade corrected with Previous card rewrites its own row,
// so neither leaves a second record of one answer.

import { Rating } from "./spacedRepetition.js";
import { sideOf } from "./directions.js";

export function newReviewId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Only reached outside a secure context; the app is served over https.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// `before` and `after` are the shown direction's columns (as applyAnswer
// returns them), or null when FSRS did not count the answer: a retry, or a
// card already answered that way today.
export function reviewRow({ id, userId, cardId, dir, got, before, after, at = new Date() }) {
  const counted = !!before && !!after;
  const b = counted ? sideOf(before, dir) : null;
  const a = counted ? sideOf(after, dir) : null;
  return {
    id,
    user_id: userId,
    card_id: cardId,
    direction: dir,
    answered_at: new Date(at).toISOString(),
    correct: !!got,
    counted,
    rating: counted ? (got ? Rating.Good : Rating.Again) : null,
    state_before: b ? b.fsrs_state : null,
    stability_before: b ? b.stability : null,
    difficulty_before: b ? b.difficulty : null,
    last_review_before: b ? b.last_review : null,
    stability_after: a ? a.stability : null,
    difficulty_after: a ? a.difficulty : null,
    due_after: a ? a.next_due_at : null,
  };
}
