-- Migration: add feedback + alternates tables to an existing deployment.
-- Safe to run multiple times (uses `if not exists` everywhere).
--
-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ BEFORE RUNNING: search-and-replace YOUR_EMAIL_HERE@example.com   ║
-- ║ throughout this file with the email you log in with.             ║
-- ╚══════════════════════════════════════════════════════════════════╝

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
  direction text not null,
  user_answer text not null,
  llm_verdict text,
  llm_reasoning text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists feedback_submissions_status_idx
  on public.feedback_submissions(status, created_at desc);

alter table public.feedback_submissions enable row level security;

drop policy if exists "Users can submit feedback" on public.feedback_submissions;
create policy "Users can submit feedback"
  on public.feedback_submissions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can read own feedback" on public.feedback_submissions;
create policy "Users can read own feedback"
  on public.feedback_submissions for select
  using (auth.uid() = user_id);

drop policy if exists "Admin can read all feedback" on public.feedback_submissions;
create policy "Admin can read all feedback"
  on public.feedback_submissions for select
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

drop policy if exists "Admin can update feedback" on public.feedback_submissions;
create policy "Admin can update feedback"
  on public.feedback_submissions for update
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

-- ═══════════════════════════════════════════════════════════════════════════
-- CARD ALTERNATES: approved-via-feedback alternative answers
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.card_alternates (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  direction text not null,
  alternate_text text not null,
  source_feedback_id uuid references public.feedback_submissions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (card_id, direction, alternate_text)
);

create index if not exists card_alternates_card_id_idx
  on public.card_alternates(card_id);

alter table public.card_alternates enable row level security;

drop policy if exists "Authenticated users can read alternates" on public.card_alternates;
create policy "Authenticated users can read alternates"
  on public.card_alternates for select
  using (auth.role() = 'authenticated');

drop policy if exists "Admin can manage alternates" on public.card_alternates;
create policy "Admin can manage alternates"
  on public.card_alternates for all
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');
