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
//
// `settings` ({ target, weights }, from settingsInUse()) and `timeZone` are
// what a counted answer was scheduled with (migration_013), so the status check
// can work it out again exactly on a day the settings changed. Together with
// the card's counts before the answer they are the row's EXTRAS: columns a
// database without migration_013 doesn't have, left out when it refuses them.
export function reviewRow({ id, userId, cardId, dir, got, before, after, at = new Date(), settings = null, timeZone = null }) {
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
    target: counted && Number.isFinite(settings?.target) ? settings.target : null,
    weights: counted && Array.isArray(settings?.weights) ? settings.weights : null,
    time_zone: counted && timeZone ? timeZone : null,
    reps_before: b ? b.reps : null,
    lapses_before: b ? b.lapses : null,
  };
}

export const REVIEW_EXTRAS = Object.freeze(["target", "weights", "time_zone", "reps_before", "lapses_before"]);

export function withoutExtras(row) {
  const out = { ...row };
  for (const k of REVIEW_EXTRAS) delete out[k];
  return out;
}

// PostgREST's "column not in the schema cache", or Postgres's "no such
// column": the database hasn't had migration_013 yet.
export const missingColumn = (error) => !!error && (error.code === "PGRST204" || error.code === "42703");
