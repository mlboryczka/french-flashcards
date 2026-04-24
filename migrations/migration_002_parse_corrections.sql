-- Migration 002: parse corrections ledger + upload batches
--
-- Adds three pieces of state that let us learn from admin edits to the
-- Claude-parsed cahier output:
--
--   1. upload_batches        — one row per cahier upload. Tracks what
--                              few-shot guidance we injected, and how many
--                              cards survived/were edited post-parse.
--   2. parse_corrections     — one row per admin correction (edit, delete,
--                              alternate approval, etc.). The "ledger" used
--                              to build the few-shot prompt on the next
--                              upload.
--   3. correction_patterns_90d
--                            — a view that aggregates corrections by
--                              category over the last 90 days for
--                              dashboard display.
--
-- Also: adds a nullable batch_id column to user_cards so we can trace each
-- card back to the upload that produced it. Legacy cards stay NULL — we do
-- NOT backfill; there is no meaningful batch to attribute them to.
--
-- Safe to run multiple times: uses `if not exists` everywhere and
-- `drop policy if exists` before policy creation.
--
-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ BEFORE RUNNING: search-and-replace YOUR_EMAIL_HERE@example.com   ║
-- ║ throughout this file with the admin email used to log in.        ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- UPLOAD BATCHES
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.upload_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  source text,                             -- 'paste' | 'file' | 'link' | 'pdf' etc.
  input_chars integer,
  cards_parsed integer not null default 0, -- count returned by Claude
  cards_accepted integer,                  -- count actually inserted (set by client after commit)
  cards_edited_post_parse integer not null default 0,
  few_shot_correction_ids uuid[] not null default '{}',
  model text,                              -- 'claude-haiku-4-5' etc.
  notes text
);

create index if not exists upload_batches_user_id_idx
  on public.upload_batches(user_id, created_at desc);

alter table public.upload_batches enable row level security;

drop policy if exists "Users can read own batches" on public.upload_batches;
create policy "Users can read own batches"
  on public.upload_batches for select
  using (auth.uid() = user_id);

drop policy if exists "Admin can read all batches" on public.upload_batches;
create policy "Admin can read all batches"
  on public.upload_batches for select
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

-- ═══════════════════════════════════════════════════════════════════════════
-- PARSE CORRECTIONS LEDGER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Each row represents one admin-visible correction to a parsed card. Rows
-- feed the few-shot prompt on subsequent uploads (the "learn from my
-- edits" behavior).
--
-- Categories (enforced by CHECK constraint — keep in sync with
-- CORRECTION_CATEGORIES in src/lib/parseCorrections.js):
--   should_split_polysemy  — single card should have been two (voler = steal / fly)
--   should_merge_gendered  — two cards that should have been one gender pair
--   wrong_disambiguator    — polysemy split produced a bad parenthetical hint
--   wrong_card_type        — mislabeled category (vocab vs grammar etc.)
--   reversed_front_back    — front/back swapped
--   duplicate_detected     — duplicate of another card
--   spelling_correction    — typo in front or back
--   alternate_answer       — an accepted alternate translation
--   front_text_edit        — front text edited in the card editor
--   back_text_edit         — back text edited in the card editor
--   other                  — catch-all

create table if not exists public.parse_corrections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  batch_id uuid references public.upload_batches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  card_id uuid,                     -- references user_cards(id); NOT a FK so deletes don't cascade away the ledger entry
  category text not null,
  action text,                      -- 'edit' | 'delete' | 'approve_alternate' | 'merge' | 'split' | 'reclassify' | 'other'
  original_front text,
  original_back text,
  corrected_front text,
  corrected_back text,
  notes text,
  used_in_few_shot boolean not null default false,
  promoted_to_rule boolean not null default false,

  constraint parse_corrections_category_chk check (category in (
    'should_split_polysemy',
    'should_merge_gendered',
    'wrong_disambiguator',
    'wrong_card_type',
    'reversed_front_back',
    'duplicate_detected',
    'spelling_correction',
    'alternate_answer',
    'front_text_edit',
    'back_text_edit',
    'other'
  ))
);

create index if not exists parse_corrections_created_at_idx
  on public.parse_corrections(created_at desc);

create index if not exists parse_corrections_category_idx
  on public.parse_corrections(category, created_at desc);

-- Partial index: the few-shot fetch always filters promoted_to_rule = false.
create index if not exists parse_corrections_unpromoted_idx
  on public.parse_corrections(created_at desc)
  where promoted_to_rule = false;

alter table public.parse_corrections enable row level security;

drop policy if exists "Admin can read all corrections" on public.parse_corrections;
create policy "Admin can read all corrections"
  on public.parse_corrections for select
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

drop policy if exists "Admin can insert corrections" on public.parse_corrections;
create policy "Admin can insert corrections"
  on public.parse_corrections for insert
  with check (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

drop policy if exists "Admin can update corrections" on public.parse_corrections;
create policy "Admin can update corrections"
  on public.parse_corrections for update
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

drop policy if exists "Admin can delete corrections" on public.parse_corrections;
create policy "Admin can delete corrections"
  on public.parse_corrections for delete
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');

-- ═══════════════════════════════════════════════════════════════════════════
-- USER_CARDS: batch_id column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nullable on purpose. Cards that predate this migration stay NULL — there
-- is no retroactive batch to assign them to, and we do NOT backfill. New
-- uploads will populate batch_id via the CahierUpload accept path.

alter table public.user_cards
  add column if not exists batch_id uuid references public.upload_batches(id) on delete set null;

create index if not exists user_cards_batch_id_idx
  on public.user_cards(batch_id)
  where batch_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION PATTERNS 90-DAY VIEW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Aggregates corrections by category over the last 90 days. Used by the
-- admin dashboard / aggregate endpoint.

create or replace view public.correction_patterns_90d as
  select
    category,
    count(*)::integer as total,
    count(*) filter (where used_in_few_shot)::integer as used_count,
    count(*) filter (where promoted_to_rule)::integer as promoted_count,
    max(created_at) as most_recent
  from public.parse_corrections
  where created_at >= now() - interval '90 days'
  group by category
  order by total desc;

-- Ensure the view runs with the querying user's privileges (respects RLS on
-- the underlying table) rather than the view owner's.
alter view public.correction_patterns_90d set (security_invoker = on);
