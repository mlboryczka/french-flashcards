-- French Flashcards — database schema
-- Run this in the Supabase SQL Editor once when setting up a new project.
-- Dashboard → SQL Editor → New Query → paste → Run.

create table if not exists public.card_progress (
  user_id uuid references auth.users(id) on delete cascade not null,
  card_id text not null,
  score integer not null default 0,
  seen integer not null default 0,
  got integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

-- Enable row-level security so users can only see/modify their own progress
alter table public.card_progress enable row level security;

-- Policy: users can read their own progress
create policy "Users can read own progress"
  on public.card_progress
  for select
  using (auth.uid() = user_id);

-- Policy: users can insert rows for themselves
create policy "Users can insert own progress"
  on public.card_progress
  for insert
  with check (auth.uid() = user_id);

-- Policy: users can update their own rows
create policy "Users can update own progress"
  on public.card_progress
  for update
  using (auth.uid() = user_id);

-- Policy: users can delete their own rows (used by Reset All)
create policy "Users can delete own progress"
  on public.card_progress
  for delete
  using (auth.uid() = user_id);

-- Index for fast lookups when loading all progress for a user
create index if not exists card_progress_user_id_idx
  on public.card_progress(user_id);
