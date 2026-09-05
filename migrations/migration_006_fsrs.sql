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
-- migration reversible. Nothing reads it after this.

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

-- ── Seed FSRS state from existing Leitner boxes ───────────────────────
--
-- Without this every card would restart as brand new and a year of review
-- history would be thrown away. Instead, treat the box a card reached as
-- evidence of how stable it already is.
--
-- A card sitting in box N was scheduled at that box's interval, and at 90%
-- target retention FSRS's stability is approximately equal to the scheduling
-- interval. So box interval -> initial stability is a reasonable estimate,
-- and FSRS corrects it from the next answer onward.
--
--   box 2 -> 1 day     box 3 -> 3 days
--   box 4 -> 7 days    box 5 -> 21 days
--
-- Difficulty starts at the FSRS-neutral 5 and is nudged up by past lapses:
-- a card you've missed four times is genuinely harder for you than one you
-- never have. Clamped to the valid 1-10 range.
--
-- last_answer_correct is deliberately left NULL for existing cards: the old
-- schema never recorded whether the last answer was right, and guessing from
-- the box would be fiction. NULL reads as "unknown", which the session
-- builder treats as not-a-lapse. It populates itself from the next answer.
--
-- Only rows that have actually been reviewed are seeded. A card still in
-- box 1 with no lapses and no review dates has never been answered, so it
-- correctly stays state 0 (New) with null stability.

update public.user_cards
set
  fsrs_state = 2,                                  -- Review
  stability = case box
    when 5 then 21.0
    when 4 then 7.0
    when 3 then 3.0
    when 2 then 1.0
    else 1.0                                       -- box 1 but previously seen
  end,
  difficulty = least(10.0, greatest(1.0, 5.0 + coalesce(lapses, 0))),
  reps = greatest(1, coalesce(array_length(dates, 1), 1)),
  -- Back-date the last review by one interval so FSRS's elapsed-time maths
  -- lines up with the due date the card already has.
  last_review = coalesce(next_due_at, now()) - (
    case box
      when 5 then interval '21 days'
      when 4 then interval '7 days'
      when 3 then interval '3 days'
      when 2 then interval '1 day'
      else interval '1 day'
    end
  )
where
  fsrs_state = 0                                   -- don't re-seed on re-run
  and (
    coalesce(box, 1) > 1
    or coalesce(lapses, 0) > 0
    or coalesce(array_length(dates, 1), 0) > 0
  );

-- The scheduler's hot query is "which of my cards are due now".
create index if not exists idx_user_cards_due
  on public.user_cards (user_id, next_due_at);

-- Spot-checks sample well-known cards by stability regardless of due date.
create index if not exists idx_user_cards_stability
  on public.user_cards (user_id, stability);
