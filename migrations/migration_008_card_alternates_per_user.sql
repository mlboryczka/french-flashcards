-- migration_008: card_alternates belongs to a user
--
-- WHAT WAS WRONG
--
-- card_alternates had no user_id. /api/review-answer wrote it with the
-- SERVICE ROLE key (bypassing the admin-only write policy below), and
-- FlashcardApp read the whole table with no filter. So when any user clicked
-- "my answer should have been accepted" and Claude agreed, that alternate
-- became an accepted answer for EVERY user's copy of that card — card_id is
-- the lowercased front text, which is shared across decks.
--
-- One learner's loose synonym silently loosened everyone else's grading.
--
-- Idempotent: safe to re-run.

-- 1. The column. Nullable at first so existing rows survive the add.
alter table public.card_alternates
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- 2. Existing rows have no owner and cannot be attributed after the fact.
--    They were created under the old global behaviour, so treat them as the
--    admin's: they stay in the admin's deck and stop applying to everyone.
--    Set ADMIN_USER_ID below before running, or delete them instead.
--
--    To find it:  select id, email from auth.users order by created_at;
--
-- update public.card_alternates
--   set user_id = 'PASTE-ADMIN-USER-UUID-HERE'
--   where user_id is null;
--
--    Or, to simply drop the shared history (nothing is lost but leniency):
-- delete from public.card_alternates where user_id is null;

-- 3. Uniqueness is per user now, not global. The old constraint would stop
--    two people accepting the same alternate for the same card.
alter table public.card_alternates
  drop constraint if exists card_alternates_card_id_direction_alternate_text_key;

create unique index if not exists card_alternates_owner_key
  on public.card_alternates (user_id, card_id, direction, alternate_text);

create index if not exists card_alternates_user_id_idx
  on public.card_alternates (user_id);

-- 4. Policies. The old pair let every authenticated user READ every row and
--    only the admin write — which the service-role writer bypassed anyway.
--    Replace both with ownership.
drop policy if exists "Authenticated users can read alternates" on public.card_alternates;
drop policy if exists "Admin can manage alternates" on public.card_alternates;

create policy "Users read their own alternates"
  on public.card_alternates for select
  using (auth.uid() = user_id);

create policy "Users manage their own alternates"
  on public.card_alternates for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
