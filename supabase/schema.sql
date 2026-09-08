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

-- ═══════════════════════════════════════════════════════════════════════════
-- FEEDBACK: user-reported "this should have been accepted" submissions
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  user_email text not null,
  card_id text not null,
  card_front text not null,
  card_back text not null,
  direction text not null, -- 'fr' or 'en' — which way the card was shown
  user_answer text not null,
  llm_verdict text, -- 'accept' | 'reject' | 'uncertain' | null (pending review)
  llm_reasoning text,
  status text not null default 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists feedback_submissions_status_idx
  on public.feedback_submissions(status, created_at desc);

alter table public.feedback_submissions enable row level security;

-- Anyone signed in can insert their own feedback
create policy "Users can submit feedback"
  on public.feedback_submissions for insert
  with check (auth.uid() = user_id);

-- Users can read their own submissions
create policy "Users can read own feedback"
  on public.feedback_submissions for select
  using (auth.uid() = user_id);

-- Admin can read all feedback. 
-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ BEFORE RUNNING: replace YOUR_EMAIL_HERE@example.com on the next  ║
-- ║ two policies with the email you log in with.                     ║
-- ╚══════════════════════════════════════════════════════════════════╝
create policy "Admin can read all feedback"
  on public.feedback_submissions for select
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

-- Admin can update any feedback (to approve/reject)
create policy "Admin can update feedback"
  on public.feedback_submissions for update
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

-- ═══════════════════════════════════════════════════════════════════════════
-- CARD ALTERNATES: approved-via-feedback alternative answers
-- ═══════════════════════════════════════════════════════════════════════════
-- When you approve a feedback submission, a row lands here. The client fetches
-- these on load and treats them as additional acceptable answers during
-- matching. This means approved feedback goes live without redeploying.

-- Alternates are PER USER. card_id is the lowercased front text, which is
-- shared across everyone's decks, so a table without user_id meant one
-- learner's accepted answer became an accepted answer for every learner.
-- See migration_008.
create table if not exists public.card_alternates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null,
  direction text not null, -- 'fr' = alternate for English side, 'en' = alternate for French side
  alternate_text text not null,
  source_feedback_id uuid references public.feedback_submissions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, card_id, direction, alternate_text)
);

create index if not exists card_alternates_user_id_idx
  on public.card_alternates(user_id);

create index if not exists card_alternates_card_id_idx
  on public.card_alternates(card_id);

alter table public.card_alternates enable row level security;

-- You see and manage your own alternates, nobody else's. No email to fill in:
-- the previous version of this file hard-coded the admin address into a
-- policy, which is both a manual step and the wrong boundary.
create policy "Users read their own alternates"
  on public.card_alternates for select
  using (auth.uid() = user_id);

create policy "Users manage their own alternates"
  on public.card_alternates for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- USER CARDS: the deck itself
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per card per user. Written by the cahier parser (service role), by
-- the tutor chat, and by the multi-sense split tool; read by useUserDeck.
--
-- This table is the app. It was missing from this file for a long time, which
-- meant a fresh deploy that followed the README got as far as signing in and
-- then failed on every query — nothing else here works without it.
--
-- Scheduling columns live in the migrations, not here, so that a project set
-- up today and one that has been running since the Leitner era converge on
-- the same shape:
--   migration_002 → batch_id
--   migration_005 → box, next_due_at, lapses
--   migration_006 → stability, difficulty, fsrs_state, reps, last_review,
--                   last_answer_correct
-- Run this file first, then the migrations in order.

create table if not exists public.user_cards (
  id bigint generated by default as identity primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  front text not null,
  back text not null,
  -- Cahier section codes: V vocab, E expression, G grammar, P pronunciation.
  -- See src/lib/cardCategories.js.
  category text not null default 'V',
  -- The LESSON dates this word appeared on in the notebook — not review
  -- history. Every parsed card has them, which is exactly the mistake
  -- migration_006 originally made; see migration_007 for the repair.
  dates jsonb not null default '[]'::jsonb,
  source text,
  flagged_for_review boolean not null default false,
  created_at timestamptz not null default now(),
  -- Every writer upserts on (user_id, front): re-uploading a cahier must
  -- update the card you already have rather than duplicate it, and the
  -- constraint is what makes `onConflict: "user_id,front"` resolvable.
  unique (user_id, front)
);

create index if not exists user_cards_user_id_idx
  on public.user_cards(user_id);

alter table public.user_cards enable row level security;

-- Owner-only access. migration_003 re-declares these (and adds the admin
-- policies) idempotently, so running both is safe.
drop policy if exists "Users can read own cards" on public.user_cards;
create policy "Users can read own cards"
  on public.user_cards for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own cards" on public.user_cards;
create policy "Users can insert own cards"
  on public.user_cards for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own cards" on public.user_cards;
create policy "Users can update own cards"
  on public.user_cards for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own cards" on public.user_cards;
create policy "Users can delete own cards"
  on public.user_cards for delete
  using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- USER REVIEW DATES: one row per day you studied
-- ═══════════════════════════════════════════════════════════════════════════
-- Drives the day-streak counter in Stats. A day is either in here or it
-- isn't, so the primary key doubles as the dedupe: the app upserts with
-- ignoreDuplicates on every answer and the repeats are no-ops server-side.

create table if not exists public.user_review_dates (
  user_id uuid references auth.users(id) on delete cascade not null,
  review_date date not null,
  primary key (user_id, review_date)
);

alter table public.user_review_dates enable row level security;

create policy "Users can read own review dates"
  on public.user_review_dates for select
  using (auth.uid() = user_id);

create policy "Users can insert own review dates"
  on public.user_review_dates for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own review dates"
  on public.user_review_dates for delete
  using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- BETA FEEDBACK: the "Send feedback" sheet
-- ═══════════════════════════════════════════════════════════════════════════
-- Distinct from feedback_submissions above, which is specifically "my typed
-- answer should have been accepted". This one is free-form: a message, and
-- optionally a screenshot and a snapshot of whichever card was on screen.
--
-- screenshot and card_context are nullable and the client retries without
-- them if the insert complains, so an older database still accepts feedback.

create table if not exists public.beta_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  message text not null,
  page text,
  user_agent text,
  -- Data URL of a pasted or dropped screenshot.
  screenshot text,
  -- { card_id, front, back, category, shown_dir } for the card on screen.
  card_context jsonb,
  created_at timestamptz not null default now()
);

create index if not exists beta_feedback_created_at_idx
  on public.beta_feedback(created_at desc);

alter table public.beta_feedback enable row level security;

create policy "Users can submit beta feedback"
  on public.beta_feedback for insert
  with check (auth.role() = 'authenticated');

create policy "Users can read own beta feedback"
  on public.beta_feedback for select
  using (auth.uid() = user_id);

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ BEFORE RUNNING: replace YOUR_EMAIL_HERE@example.com on the next  ║
-- ║ two policies with the email you log in with.                     ║
-- ╚══════════════════════════════════════════════════════════════════╝
create policy "Admin can read all beta feedback"
  on public.beta_feedback for select
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

-- The admin feedback view deletes rows. Without this policy the delete is
-- silently blocked by RLS — success, zero rows affected — and the entry
-- reappears on refresh.
create policy "Admin can delete beta feedback"
  on public.beta_feedback for delete
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');
