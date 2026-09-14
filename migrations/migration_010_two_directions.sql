-- migration_010: French → English and English → French are scheduled apart,
-- and every answer is kept
--
-- WHAT WAS WRONG
--
-- A word or phrase card is asked either way round: "la pomme → ?" (recognise
-- it) and "apple → ?" (produce it). Both answers fed the one FSRS state on the
-- row, though they are different skills and which is harder differs per
-- student and per card. A word easy to recognise was pushed weeks out while it
-- still couldn't be produced, and in Mixed mode the grade depended on a coin
-- toss.
--
-- And only the current FSRS state was stored, never the answers that produced
-- it — which is why nobody can now say which way round any past answer was.
--
-- WHAT THIS ADDS
--
-- 1. A second FSRS state on user_cards, for English → French, with the same
--    meaning as migration_006's columns. The existing columns are French →
--    English (grammar and pronunciation cards, always shown as written, use
--    only those). Every en_ column starts as New.
--
-- 2. card_reviews: one row per answer — which card, which way round, when,
--    right or wrong, and whether it was the one FSRS counted for the day.
--    Written by the app; the id is chosen by the app too, so a save that is
--    retried, or a grade corrected with Previous card, overwrites its own row
--    rather than adding another.
--
-- Additive only. Nothing existing is rewritten, code that predates it ignores
-- the new columns, and reverting the code leaves every French → English
-- schedule intact. Re-runnable.

alter table public.user_cards
  add column if not exists en_stability real,
  add column if not exists en_difficulty real,
  add column if not exists en_fsrs_state smallint not null default 0,
  add column if not exists en_reps integer not null default 0,
  add column if not exists en_lapses integer not null default 0,
  add column if not exists en_next_due_at timestamptz,
  add column if not exists en_last_review timestamptz,
  add column if not exists en_last_answer_correct boolean;

alter table public.user_cards
  drop constraint if exists user_cards_en_fsrs_state_check;
alter table public.user_cards
  add constraint user_cards_en_fsrs_state_check check (en_fsrs_state between 0 and 3);

create index if not exists idx_user_cards_en_due
  on public.user_cards (user_id, en_next_due_at);

create table if not exists public.card_reviews (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id bigint not null references public.user_cards(id) on delete cascade,
  -- The side that was SHOWN: 'fr' is "la pomme → ?", 'en' is "apple → ?".
  direction text not null check (direction in ('fr', 'en')),
  answered_at timestamptz not null,
  correct boolean not null,
  -- FSRS takes one answer per card per direction per day. A retry, or a card
  -- already answered today, is still an answer, and is kept with counted
  -- false and no FSRS figures.
  counted boolean not null,
  -- 1 Again, 3 Good: the app grades binary. Null when not counted.
  rating smallint check (rating between 1 and 4),
  -- That direction's FSRS state just before and just after the answer.
  state_before smallint,
  stability_before real,
  difficulty_before real,
  last_review_before timestamptz,
  stability_after real,
  difficulty_after real,
  due_after timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists card_reviews_user_time_idx
  on public.card_reviews (user_id, answered_at);
create index if not exists card_reviews_card_idx
  on public.card_reviews (card_id, direction, answered_at);

alter table public.card_reviews enable row level security;

drop policy if exists "Users can read own reviews" on public.card_reviews;
create policy "Users can read own reviews"
  on public.card_reviews for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own reviews" on public.card_reviews;
create policy "Users can insert own reviews"
  on public.card_reviews for insert
  with check (auth.uid() = user_id);

-- A corrected grade, or a retried save, rewrites its own row.
drop policy if exists "Users can update own reviews" on public.card_reviews;
create policy "Users can update own reviews"
  on public.card_reviews for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy: the record is not something the app removes. Deleting a
-- card removes its answers with it (the foreign key), and "Reset all progress"
-- resets schedules but leaves this history alone.
