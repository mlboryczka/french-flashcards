-- migration_008: an accepted answer belongs to the person who earned it
--
-- WHAT WAS WRONG
--
-- card_alternates had no user_id. /api/review-answer wrote it with the
-- service role (bypassing the admin-only write policy), and the client read
-- the whole table with no filter. card_id is the lowercased front text, which
-- is shared across everyone's decks — so when any student clicked "my answer
-- should have been accepted" and Claude agreed, that answer became accepted
-- for EVERY student holding that card. One learner's loose synonym silently
-- loosened everyone else's grading.
--
-- THE EXISTING ROWS ARE DELETED
--
-- Nothing ever recorded who made them. The source_feedback_id column could
-- have carried it, but only an old admin-approval path ever set it and that
-- path is no longer wired up, so in practice every row is anonymous. They
-- cannot be attributed, and assigning them all to one account would hand that
-- person leniencies they never earned while taking them from students who
-- did.
--
-- So they go. Nothing is lost but leniency: an answer that used to be
-- accepted may be marked wrong once more, and one click re-accepts it — this
-- time owned by whoever clicked.
--
-- Idempotent: safe to re-run.

-- 1. The column, nullable for the moment so the existing rows survive it.
alter table public.card_alternates
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- 2. Drop the anonymous history.
delete from public.card_alternates where user_id is null;

-- 3. From here the owner is required. Without this a future writer that
--    forgets user_id recreates the original bug in silence.
alter table public.card_alternates
  alter column user_id set not null;

-- 4. Uniqueness is per person now. The old global constraint would have
--    stopped two students accepting the same answer on the same card.
alter table public.card_alternates
  drop constraint if exists card_alternates_card_id_direction_alternate_text_key;

create unique index if not exists card_alternates_owner_key
  on public.card_alternates (user_id, card_id, direction, alternate_text);

create index if not exists card_alternates_user_id_idx
  on public.card_alternates (user_id);

-- 5. You see and manage your own, nobody else's. The old pair let every
--    signed-in user READ every row, and gave writes to a hard-coded admin
--    address that the service-role writer bypassed anyway.
drop policy if exists "Authenticated users can read alternates" on public.card_alternates;
drop policy if exists "Admin can manage alternates" on public.card_alternates;

create policy "Users read their own alternates"
  on public.card_alternates for select
  using (auth.uid() = user_id);

create policy "Users manage their own alternates"
  on public.card_alternates for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
