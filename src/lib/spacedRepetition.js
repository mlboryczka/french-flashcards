// Single source of truth for spaced-repetition tuning, now backed by FSRS
// (Free Spaced Repetition Scheduler) instead of a fixed Leitner ladder.
//
// Why the change: the old ladder capped intervals at 21 days, gave the same
// credit for an answer whether it was on time or three weeks late, and reset
// a card to day one on a single miss. FSRS models each card's *stability*
// (how slowly you forget it) and *difficulty* (how hard it is for you), so
// intervals keep growing, a late-but-correct answer earns a longer gap, and
// a lapse cuts stability proportionally rather than wiping it.
//
// See migrations/migration_006_fsrs.sql for the columns this reads and
// writes, and for how existing Leitner boxes were seeded into FSRS state.

import { fsrs, State, Rating } from "ts-fsrs";

export { State, Rating };

// Tuning knobs.
//
//   requestRetention — the probability you want of recalling a card at the
//     moment it comes up. This is *the* dial: it trades daily review count
//     against how much you remember. 0.9 is the FSRS default and the right
//     starting point; drop to 0.85 if the daily load feels too heavy.
//
//   enableShortTerm — OFF deliberately. With it on, FSRS inserts minute-scale
//     learning steps (see a new card again in 10 minutes), which suits an app
//     you dip into all day. This app is session-shaped: you sit down, work a
//     queue, and leave. Same-session repetition is already handled by
//     re-queueing wrong answers (RE_QUEUE_OFFSET below), so minute-scale
//     steps would just mean cards the session builder can't schedule properly.
//
//   maximumInterval — 10 years. Effectively "no ceiling", which is the whole
//     point; the old 21-day cap is what made you re-review words you'd known
//     for a year.
//
//   enableFuzz — spreads due dates by a few percent so cards learned on the
//     same day don't clump into one giant review day months later.
export const FSRS_CONFIG = Object.freeze({
  requestRetention: 0.9,
  maximumInterval: 3650,
  enableFuzz: true,
  enableShortTerm: false,
});

export const scheduler = fsrs({
  request_retention: FSRS_CONFIG.requestRetention,
  maximum_interval: FSRS_CONFIG.maximumInterval,
  enable_fuzz: FSRS_CONFIG.enableFuzz,
  enable_short_term: FSRS_CONFIG.enableShortTerm,
});

// When a wrong-answer card is re-queued in the same session, insert it this
// many positions after the current index.
//
// This was 5, which is close to massed practice — five cards later you're
// still holding the answer in your head, so getting it "right" proves
// nothing. Karpicke & Roediger (2007) found that what makes a retrieval
// stick is having to work for it. 20 puts real cards in between.
export const RE_QUEUE_OFFSET = 20;

// A card counts as "well known" for spot-check purposes once FSRS thinks
// you'd still recall it well over two months from now.
//
// This used to be called MASTERED_STABILITY_DAYS, and the Stats page showed
// cards past it as "mastered" — a Leitner-era word re-attached to a threshold
// chosen for a different question (which cards are safe to skip). It is only a
// scheduling parameter now; progress is seen / about remembered.
export const SPOT_CHECK_MIN_STABILITY_DAYS = 60;

// ── Conversion between the DB row shape and ts-fsrs's Card ─────────────
//
// useUserDeck shapes rows into { ...stability, difficulty, fsrs_state, reps,
// lapses, next_due_at, last_review }. ts-fsrs wants a Card with Date objects
// and its own field names. These two functions are the only place that
// mapping lives.

export function toFsrsCard(card) {
  const state = card.fsrs_state ?? State.New;
  const lastReview = card.last_review ? new Date(card.last_review) : undefined;
  return {
    due: card.next_due_at ? new Date(card.next_due_at) : new Date(),
    stability: card.stability ?? 0,
    difficulty: card.difficulty ?? 0,
    // elapsed_days / scheduled_days / learning_steps are outputs — ts-fsrs
    // recomputes elapsed time from last_review and the review timestamp, so
    // seeding them with 0 is correct, not a shortcut.
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: card.reps ?? 0,
    lapses: card.lapses ?? 0,
    state,
    last_review: lastReview,
  };
}

// The inverse: an FSRS Card back into the exact column set that
// user_cards accepts, ready for a Supabase .update().
//
// `got` is carried through as last_answer_correct because FSRS itself can't
// tell us. Its Relearning state would be the natural place to read "you just
// missed this", but that state only exists when short-term relearning steps
// are enabled — and those reschedule in minutes, which this app can't use
// (see enableShortTerm above). So the miss is recorded explicitly. The
// session builder reads it to surface recently-missed cards first.
export function fromFsrsCard(fsrsCard, got) {
  return {
    last_answer_correct: got,
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    fsrs_state: fsrsCard.state,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    next_due_at: new Date(fsrsCard.due).toISOString(),
    last_review: fsrsCard.last_review
      ? new Date(fsrsCard.last_review).toISOString()
      : null,
  };
}
