-- migration_006_fsrs.sql
--
-- Replaces the fixed Leitner ladder from migration_005 with FSRS
-- (Free Spaced Repetition Scheduler) state.
--
-- Why: the box ladder capped intervals at 21 days, so a word known cold for
-- a year still came back every three weeks; it gave a card the same credit
-- whether you answered on time or three weeks late; and it reset a card to
-- day one on a single miss. FSRS tracks per-card memory strength instead:
--
--   stability    how many days until recall probability decays to the
--                target retention (0.9). This is what grows without a
--                ceiling — 3d, 14d, 57d, 196d, and on.
--   difficulty   1-10, how hard this specific card is for this person.
--                Drives how fast stability grows on future correct answers.
--   fsrs_state   0 New, 1 Learning, 2 Review, 3 Relearning.
--   reps         total reviews. Input to the FSRS model.
--   last_review  when it was last answered; FSRS derives elapsed time from
--                this, which is how a late-but-correct answer earns a
--                longer next interval than an on-time one.
--   last_answer_correct
--                whether the most recent answer was right. FSRS's own
--                Relearning state would encode this, but that state only
--                exists when minute-scale relearning steps are enabled, and
--                this app schedules in days. The session builder reads this
--                to put recently-missed cards at the front of the queue.
--
-- next_due_at and lapses carry over from migration_005 unchanged — they mean
-- the same thing to FSRS. `box` is deliberately LEFT IN PLACE, not dropped:
-- it is the only record of pre-FSRS scheduling, so keeping it makes this
-- migration reversible, and migration_007 reads it when seeding.
--
-- THIS FILE ONLY ADDS COLUMNS. Populating them from existing review history
-- is migration_007's job. The two were originally one file, and the seeding
-- half was wrong (it read the `dates` array — cahier lesson dates — as if it
-- were review history, which marked every card as already-in-review). Keeping
-- the seeding in its own re-runnable file means running this one again can
-- never undo the correction.

alter table public.user_cards
  add column if not exists stability real,
  add column if not exists difficulty real,
  add column if not exists fsrs_state smallint not null default 0,
  add column if not exists reps integer not null default 0,
  add column if not exists last_review timestamptz,
  add column if not exists last_answer_correct boolean;

alter table public.user_cards
  drop constraint if exists user_cards_fsrs_state_check;
alter table public.user_cards
  add constraint user_cards_fsrs_state_check check (fsrs_state between 0 and 3);

-- The scheduler's hot query is "which of my cards are due now".
create index if not exists idx_user_cards_due
  on public.user_cards (user_id, next_due_at);

-- Spot-checks sample well-known cards by stability regardless of due date.
create index if not exists idx_user_cards_stability
  on public.user_cards (user_id, stability);

-- Next: run migration_007_fsrs_reseed.sql, which fills these columns in.
