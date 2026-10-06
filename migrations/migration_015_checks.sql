-- migration_015: keeping what the app's checks need (2026-10-06)
--
-- WHAT WAS MISSING
--
-- 1. Claude's verdicts on "My answer should have been accepted". Only its
--    yeses were kept, as the student's accepted answers (card_alternates). Its
--    noes were thrown away, so nobody could tell how often it refused an
--    answer it should have accepted, or accepted one it shouldn't.
--
-- 2. A record of each test of Claude's work, to compare one with the next:
--    "agreed with you every time on 37 of 40" before a change to how it is
--    asked, and after.
--
-- 3. The status check on every student. It ran only on the admin's own
--    record, in the admin's browser, while the app was open.
--
-- WHAT THIS ADDS
--
-- 1. answer_reviews: one row per verdict, written by /api/review-answer — the
--    card's two sides, what Claude was given as the expected answer, what was
--    typed, the verdict and Claude's one-line reason, the model and the
--    version of the question, and whether the student then pressed "Accept
--    anyway" (`overridden`). `owner_says` is the owner's call, set from the
--    Status window: what Claude should have said.
--    The accepted answers already kept are copied in once, as `source` 'kept'
--    with verdict 'accept': Claude accepted them, or the student did with
--    "Accept anyway" — the old record doesn't say which.
--
-- 2. eval_runs: one row per test run. `kind` 'answers' (Claude's marking) or
--    'notes' (Claude turning class notes into cards); `cases` how many were
--    tested and `passed` how many Claude got right every time; `results` each
--    case's answers.
--
-- 3. status_reports: one row per student per run of the daily status check
--    (/api/cahier-daily's second schedule): whether every check passed and
--    the report itself.
--
-- All three are read and written only by the server, with the service role:
-- row level security is on and no policy lets a student's browser in. Nothing
-- existing is changed; card_alternates is only read. The app keeps working
-- before this is run. Re-runnable.

create table if not exists public.answer_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  -- The app's card id: the card's French side, lowercased.
  card_id text not null,
  -- 'fr' the French side was shown and English typed; 'en' the other way.
  direction text not null check (direction in ('fr', 'en')),
  front text,
  back text,
  expected text,
  typed text not null,
  verdict text not null check (verdict in ('accept', 'reject', 'uncertain')),
  reasoning text,
  model text,
  prompt_version text,
  -- 'asked' a verdict saved as Claude gave it; 'kept' an accepted answer
  -- copied from card_alternates by this migration.
  source text not null default 'asked' check (source in ('asked', 'kept')),
  overridden boolean not null default false,
  owner_says text check (owner_says in ('accept', 'reject')),
  marked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists answer_reviews_created_idx
  on public.answer_reviews (created_at desc);

alter table public.answer_reviews enable row level security;

insert into public.answer_reviews
  (user_id, user_email, card_id, direction, front, back, expected, typed, verdict, source, created_at)
select
  ca.user_id,
  u.email,
  ca.card_id,
  ca.direction,
  uc.front,
  uc.back,
  case when ca.direction = 'en' then uc.front else uc.back end,
  ca.alternate_text,
  'accept',
  'kept',
  ca.created_at
from public.card_alternates ca
join auth.users u on u.id = ca.user_id
join lateral (
  select front, back from public.user_cards c
  where c.user_id = ca.user_id and lower(trim(c.front)) = ca.card_id
  order by c.id
  limit 1
) uc on true
where ca.direction in ('fr', 'en')
  and not exists (
    select 1 from public.answer_reviews r
    where r.source = 'kept' and r.user_id = ca.user_id and r.card_id = ca.card_id
      and r.direction = ca.direction and r.typed = ca.alternate_text
  );

create table if not exists public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('answers', 'notes')),
  ran_at timestamptz not null default now(),
  version text,
  model text,
  cases integer not null default 0,
  passed integer not null default 0,
  summary jsonb,
  results jsonb not null default '[]'::jsonb
);

create index if not exists eval_runs_kind_time_idx
  on public.eval_runs (kind, ran_at desc);

alter table public.eval_runs enable row level security;

create table if not exists public.status_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  checked_at timestamptz not null default now(),
  ok boolean,
  failing integer,
  -- How many answers the checks judged.
  answers integer,
  report jsonb,
  -- Set when the check couldn't run for this student.
  error text
);

create index if not exists status_reports_user_time_idx
  on public.status_reports (user_id, checked_at desc);

alter table public.status_reports enable row level security;
