-- migration_013: what each answer was scheduled with, and each set dealt
--
-- WHAT WAS MISSING
--
-- The status check in the profile menu (src/lib/statusChecks.js) works out
-- again, from the record of answers, what FSRS and the app's rules should
-- have done, and compares. Two things it needs were never kept:
--
--   1. Which settings an answer was scheduled with. Since migration_012 they
--      change over time — a student's own fitted weights replace the starting
--      ones, the automatic target moves, the student picks their own target —
--      and only the current ones are stored. Nor was the student's time zone,
--      which decides where their day starts, or the card's count of answers
--      before this one, which ts-fsrs uses to draw the spread of the due date.
--      Without them an answer can't be worked out again exactly.
--
--   2. Which cards the app dealt. card_reviews says what was answered, not
--      what was in the set: from it alone nobody can tell whether a due card
--      was left out, or whether missed cards were picked first.
--
-- WHAT THIS ADDS
--
-- 1. On card_reviews, for each answer FSRS counted:
--      target         the target in use (0.85 = 85%)
--      weights        the 21 FSRS weights in use
--      time_zone      the student's time zone (IANA name)
--      reps_before,
--      lapses_before  the card's counts that way round before the answer
--
-- 2. dealt_sets: one row each time the app deals cards — a new set of 50, the
--    rest of a set dealt again (the deck came fresh, the day turned, the
--    student came back to a set), or the rest dealt again for a new direction
--    setting. `items` are the cards dealt, each with what the app believed of
--    it then (due date, missed last time); `kept` are the entries already in
--    the set, which were not dealt again.
--
-- Additive only. Nothing existing is rewritten, and the app keeps working
-- before this is run: it leaves the new details out rather than fail to save
-- an answer. Re-runnable.

alter table public.card_reviews
  add column if not exists target real,
  add column if not exists weights double precision[],
  add column if not exists time_zone text,
  add column if not exists reps_before integer,
  add column if not exists lapses_before integer;

create table if not exists public.dealt_sets (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  dealt_at timestamptz not null,
  -- 'new' a new set; 'rest' the rest of a set dealt again; 'direction' the
  -- rest dealt again for a new direction setting.
  kind text not null check (kind in ('new', 'rest', 'direction')),
  -- Which set: the type filter and the lesson, as the app keys its sets.
  scope text not null,
  direction text not null check (direction in ('fr', 'en', 'mix')),
  -- How many places there were to fill.
  slots integer not null,
  items jsonb not null default '[]'::jsonb,
  kept jsonb not null default '[]'::jsonb,
  -- Due cards left over once the places were filled, and new cards available.
  due_left integer,
  new_available integer,
  time_zone text,
  created_at timestamptz not null default now()
);

create index if not exists dealt_sets_user_time_idx
  on public.dealt_sets (user_id, dealt_at);

alter table public.dealt_sets enable row level security;

drop policy if exists "Users can read own dealt sets" on public.dealt_sets;
create policy "Users can read own dealt sets"
  on public.dealt_sets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own dealt sets" on public.dealt_sets;
create policy "Users can insert own dealt sets"
  on public.dealt_sets for insert
  with check (auth.uid() = user_id);

-- No update or delete: a dealt set is a record, like an answer.
