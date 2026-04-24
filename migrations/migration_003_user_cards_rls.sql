-- Migration 003: ensure user_cards has the RLS policies the app needs.
--
-- Symptom we're fixing: the admin card editor's "Save" button appears to
-- succeed (modal closes, no error) but the change is not persisted. This
-- happens when the user_cards table has row-level security turned ON but
-- is missing an UPDATE policy — PostgREST silently returns success with
-- zero rows affected.
--
-- Safe to run multiple times: each policy is dropped first if it exists.
--
-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ BEFORE RUNNING: search-and-replace mlboryczka@gmail.com   ║
-- ║ with the admin email used to log in.                             ║
-- ╚══════════════════════════════════════════════════════════════════╝

alter table public.user_cards enable row level security;

-- Users can read, insert, update, delete their own rows. The parse
-- endpoints use the service role key (which bypasses RLS) for bulk
-- operations, so these policies cover direct-from-client edits only.

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

-- Admin can read/update/delete any row. Needed for the admin card editor
-- when reviewing cards across users, and for the admin "delete card"
-- action on cards flagged for review.

drop policy if exists "Admin can read all cards" on public.user_cards;
create policy "Admin can read all cards"
  on public.user_cards for select
  using (auth.jwt() ->> 'email' = 'mlboryczka@gmail.com');

drop policy if exists "Admin can update all cards" on public.user_cards;
create policy "Admin can update all cards"
  on public.user_cards for update
  using (auth.jwt() ->> 'email' = 'mlboryczka@gmail.com')
  with check (auth.jwt() ->> 'email' = 'mlboryczka@gmail.com');

drop policy if exists "Admin can delete all cards" on public.user_cards;
create policy "Admin can delete all cards"
  on public.user_cards for delete
  using (auth.jwt() ->> 'email' = 'mlboryczka@gmail.com');
