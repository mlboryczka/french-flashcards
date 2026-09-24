-- migration_011: the cahier keeps the deck up to date
--
-- WHAT WAS MISSING
--
-- A cahier is uploaded once. Laura and each student keep the real cahier in a
-- Google Doc and add a class to it after every lesson, so the deck drifts
-- behind the teaching: on 2026-09-24 the owner's deck stopped at the
-- 5 September class, twelve classes and ~250 cards ago.
--
-- The app can already read a Google Doc (parse-cahier's "url" mode) and slice
-- it into one block per class. What it has no memory of is which classes it has
-- already turned into cards, so the only thing it can do is re-read the whole
-- year.
--
-- WHAT THIS ADDS
--
-- One row per student: the doc they study from, and a fingerprint of every
-- class it has already read. A class the app has not seen before is parsed;
-- everything else is left alone. Editing an old class in the doc changes
-- nothing in the deck — the owner's decision on 2026-09-24 — because those
-- cards carry the student's own history, and deleting or rewriting them
-- behind their back is worse than a stale card.
--
--   doc_id / doc_url  the document, and the link as pasted
--   classes           { "2026-09-24": "<fingerprint>" } — one entry per class
--                     already read, whether or not it produced cards
--   last_checked_at   the last time the doc was read at all (cheap, no parse)
--   last_synced_at    the last time a class was actually turned into cards
--   last_result       what that sync did: { dates: [...], cards: n }
--   last_error        why the last check failed, for the app to show — a doc
--                     whose sharing was turned off must say so, not go quiet
--
-- The doc has to be readable by anyone with the link: that is how it is read
-- without anyone signing in to Google. Nothing here stores Google credentials.
--
-- Re-runnable.

create table if not exists public.cahier_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  doc_id text not null,
  doc_url text not null,
  linked_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  classes jsonb not null default '{}'::jsonb,
  last_result jsonb
);

alter table public.cahier_links enable row level security;

drop policy if exists "Users can read own cahier link" on public.cahier_links;
create policy "Users can read own cahier link"
  on public.cahier_links for select
  using (auth.uid() = user_id);

drop policy if exists "Users can link own cahier" on public.cahier_links;
create policy "Users can link own cahier"
  on public.cahier_links for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own cahier link" on public.cahier_links;
create policy "Users can update own cahier link"
  on public.cahier_links for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can unlink own cahier" on public.cahier_links;
create policy "Users can unlink own cahier"
  on public.cahier_links for delete
  using (auth.uid() = user_id);

-- The daily check walks every linked doc, oldest check first, so a doc that
-- has not been read for a while is read before one read an hour ago.
create index if not exists cahier_links_checked_idx
  on public.cahier_links (last_checked_at nulls first);
