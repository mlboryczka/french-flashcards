-- migration_014: Claude's review of each piece of feedback
--
-- WHAT WAS MISSING
--
-- Feedback sat in the admin list until a Claude session was started to work
-- through it. Nothing looked at it in between, and the owner had no way to act
-- on it from the app.
--
-- WHAT THIS ADDS
--
--   review       Claude's review, written by /api/review-answer when the
--                feedback is sent (or when the owner opens View feedback, for
--                anything not yet reviewed). What it holds:
--                  kind       "card"  editing the card fixes it
--                             "app"   it needs a change to the app or a lesson
--                             "none"  nothing should change
--                  reasoning  whether the feedback is right, and why
--                  fix        { front, back } for "card"
--                  brief      for "app": what to tell a coding session
--                  card       the card as Claude saw it: { row_id, front,
--                             back, lesson }; Apply refuses if it has changed
--                             since
--                  model, at
--   reviewed_at  when the review was written
--
-- The owner presses Apply or Dismiss in View feedback. Both resolve the entry
-- (resolved_at and resolution, from migration_009). Apply also corrects the
-- card in place, so it keeps its schedule and its answer history. Nothing is
-- deleted.
--
-- Only the server writes these columns, with the service role. The admin reads
-- them through the existing "Admin can read all beta feedback" policy, so no
-- policy changes.
--
-- Re-runnable.

alter table public.beta_feedback
  add column if not exists review jsonb,
  add column if not exists reviewed_at timestamptz;
