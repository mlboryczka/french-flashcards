-- migration_009: feedback that has been dealt with leaves the list
--
-- WHAT WAS MISSING
--
-- beta_feedback had no state. An entry stayed in the admin list until someone
-- deleted it, so the list mixed feedback that had been fixed with feedback
-- nobody had looked at, and the only way to clear a fixed item was to destroy
-- the record of it.
--
-- WHAT THIS ADDS
--
--   resolved_at  when the feedback was dealt with; null means still open
--   resolution   what was done about it, in a sentence
--
-- Both admin views list only rows with resolved_at null, and each entry has a
-- "Mark resolved" button. scripts/resolve-feedback.mjs does the same from a
-- terminal, which is how a fix session clears what it fixed. Resolved rows stay
-- in the table until deleted:
--
--   delete from public.beta_feedback where resolved_at is not null;
--
-- Re-runnable.
--
-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ BEFORE RUNNING: replace YOUR_EMAIL_HERE@example.com below with   ║
-- ║ the email you log in with — the same one as migration_003.       ║
-- ╚══════════════════════════════════════════════════════════════════╝

alter table public.beta_feedback
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution text;

create index if not exists beta_feedback_open_idx
  on public.beta_feedback(created_at desc)
  where resolved_at is null;

-- Without an UPDATE policy, "Mark resolved" is silently blocked by RLS:
-- success, zero rows affected, and the entry is back on the next load.
drop policy if exists "Admin can resolve beta feedback" on public.beta_feedback;
create policy "Admin can resolve beta feedback"
  on public.beta_feedback for update
  using (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com')
  with check (auth.jwt() ->> 'email' = 'YOUR_EMAIL_HERE@example.com');
