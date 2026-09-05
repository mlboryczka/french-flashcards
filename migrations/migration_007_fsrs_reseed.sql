-- migration_007_fsrs_reseed.sql
--
-- Corrects the FSRS seeding done by migration_006.
--
-- WHAT WENT WRONG
--
-- migration_006 treated a non-empty `dates` array as evidence that a card had
-- been reviewed. It isn't. `dates` holds the LESSON dates a word appeared on
-- in the cahier — every card parsed from a document has them, whether or not
-- it has ever been answered in the app. The result was that every card was
-- seeded as state 2 (Review) with a token stability, and no card was left in
-- state 0 (New).
--
-- The practical damage: buildSession's new-card cap only applies to cards in
-- state New, so with nothing in that state the session fills entirely with
-- "reviews" and new material stops being paced in.
--
-- WHAT ACTUALLY RECORDS A REVIEW
--
-- Three signals, any of which means the card has really been answered:
--
--   card_progress.seen > 0   the app's own per-card answer counter, keyed by
--                            the lowercased front. This is the real record.
--   user_cards.box > 1       promoted up the old Leitner ladder, so it was
--                            answered correctly at least once.
--   user_cards.lapses > 0    missed at least once under the old scheduler.
--
-- Everything else has never been answered and belongs in state New.
--
-- This migration is safe to run more than once: both statements are driven by
-- those three signals rather than by current FSRS state, so a second run
-- computes the same answer.

-- ── Step 1: cards with no review history go back to New ───────────────
--
-- next_due_at is left alone: it is NOT NULL with a default, and the session
-- builder reads fsrs_state first for new cards, so its value is irrelevant
-- until the card is first answered.

update public.user_cards uc
set
  fsrs_state = 0,
  stability = null,
  difficulty = null,
  reps = 0,
  last_review = null,
  last_answer_correct = null
where
  coalesce(uc.box, 1) <= 1
  and coalesce(uc.lapses, 0) = 0
  and not exists (
    select 1
    from public.card_progress cp
    where cp.user_id = uc.user_id
      and cp.card_id = lower(btrim(uc.front))
      and cp.seen > 0
  );

-- ── Step 2: re-seed the cards that DO have history ────────────────────
--
-- Stability (days until recall decays to the 0.9 target) is estimated from
-- whichever record is better:
--
--   box > 1   The old ladder actually scheduled this card at that interval,
--             and at 90% target retention FSRS stability is approximately
--             the scheduling interval. Use the ladder: 2->1d 3->3d 4->7d 5->21d.
--
--   else      The card was answered before the box ladder existed, so fall
--             back to card_progress.score (0-5, +1 per correct, -1 per miss).
--             A conservative ladder — under-estimating stability costs one
--             extra review, over-estimating costs a forgotten word.
--
-- Difficulty (1-10, how hard this card is for this person) comes from real
-- accuracy where we have it: got/seen. 100% accurate lands at 4 (easier than
-- the 5 neutral), 0% at 9. Without a card_progress row, fall back to the
-- lapse count.
--
-- last_review is set one stability-period back and next_due_at to now, which
-- says "due right now, at exactly the target recall probability" — the
-- honest description of a card that was in rotation under the old scheduler.
--
-- last_answer_correct stays NULL: the old schema never recorded whether the
-- most recent answer was right, and inferring it would be fiction. It fills
-- in from the next answer.

update public.user_cards uc
set
  fsrs_state = 2,
  stability = s.stability,
  difficulty = s.difficulty,
  reps = s.reps,
  next_due_at = now(),
  last_review = now() - make_interval(days => greatest(1, round(s.stability)::int))
from (
  select
    uc2.id,
    (case
       when coalesce(uc2.box, 1) > 1 then
         case uc2.box
           when 5 then 21.0
           when 4 then 7.0
           when 3 then 3.0
           else 1.0
         end
       else
         case coalesce(cp.score, 0)
           when 5 then 12.0
           when 4 then 7.0
           when 3 then 4.0
           when 2 then 2.0
           else 1.0
         end
     end)::real as stability,
    (case
       when coalesce(cp.seen, 0) > 0 then
         least(10.0, greatest(1.0,
           4.0 + 5.0 * (1.0 - (cp.got::numeric / cp.seen))))
       else
         least(10.0, greatest(1.0, 5.0 + coalesce(uc2.lapses, 0)))
     end)::real as difficulty,
    greatest(1, coalesce(cp.seen, 1)) as reps
  from public.user_cards uc2
  left join public.card_progress cp
    on cp.user_id = uc2.user_id
   and cp.card_id = lower(btrim(uc2.front))
  where
    coalesce(uc2.box, 1) > 1
    or coalesce(uc2.lapses, 0) > 0
    or coalesce(cp.seen, 0) > 0
) s
where s.id = uc.id;
