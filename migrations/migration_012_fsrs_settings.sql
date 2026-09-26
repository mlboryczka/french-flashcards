-- migration_012: each student's own FSRS settings
--
-- WHAT WAS MISSING
--
-- Every student was scheduled with the same settings: FSRS's defaults,
-- measured on people pressing four buttons, and one target (90%). Nothing
-- learned from a student's own answers, though card_reviews has kept every one
-- since migration_010.
--
-- WHAT THIS ADDS
--
-- One row per student (agreed with the owner on 2026-09-26):
--
--   weights              their own 21 FSRS weights, fitted from their answers
--                        by /api/fsrs-fit once there are about 1,000; null
--                        until a fit predicts their answers better than the
--                        starting settings
--   fitted_at / fitted_answers
--                        when those were adopted, and on how many answers
--   fit_checked_at / fit_checked_answers / fit_result
--                        the last fit tried, adopted or not, and how it scored
--   computed_with        which settings the stored memory estimates come from;
--                        when the settings in use change, every card's estimate
--                        is worked out again from its answers
--   target_mode, target  how sure to be of remembering a card when it comes
--                        back: 'auto' (90%, easing to 85% while the student is
--                        behind) or 'fixed' at the student's own choice
--   target_changed_at    when the automatic target last moved
--   days                 the last 14 study days, and whether each began with
--                        due cards left over: [{ "date": "2026-09-26", "behind": true }]
--
-- And apply_memory_estimates(), which writes worked-out estimates back:
-- stability and difficulty only, and only on a card whose last answer is still
-- the one the estimate was worked out from. Due dates, answers and everything
-- else are left alone. Only the server (service role) may call it.
--
-- Re-runnable.

create table if not exists public.fsrs_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  weights double precision[],
  fitted_at timestamptz,
  fitted_answers integer,
  fit_checked_at timestamptz,
  fit_checked_answers integer,
  fit_result jsonb,
  computed_with text,
  target_mode text not null default 'auto',
  target real not null default 0.9,
  target_changed_at timestamptz,
  days jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.fsrs_settings
  drop constraint if exists fsrs_settings_target_mode_check;
alter table public.fsrs_settings
  add constraint fsrs_settings_target_mode_check check (target_mode in ('auto', 'fixed'));
alter table public.fsrs_settings
  drop constraint if exists fsrs_settings_target_check;
alter table public.fsrs_settings
  add constraint fsrs_settings_target_check check (target between 0.8 and 0.97);
alter table public.fsrs_settings
  drop constraint if exists fsrs_settings_weights_check;
alter table public.fsrs_settings
  add constraint fsrs_settings_weights_check check (weights is null or array_length(weights, 1) = 21);

alter table public.fsrs_settings enable row level security;

drop policy if exists "Users can read own FSRS settings" on public.fsrs_settings;
create policy "Users can read own FSRS settings"
  on public.fsrs_settings for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create own FSRS settings" on public.fsrs_settings;
create policy "Users can create own FSRS settings"
  on public.fsrs_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own FSRS settings" on public.fsrs_settings;
create policy "Users can update own FSRS settings"
  on public.fsrs_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.apply_memory_estimates(p_user_id uuid, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_fr integer;
  n_en integer;
begin
  -- One statement per way round: a card can be in the list both ways, and
  -- Postgres applies only one of two updates to the same row in a statement.
  update public.user_cards c
     set stability = x.stability, difficulty = x.difficulty
    from jsonb_to_recordset(p_rows)
         as x(id bigint, direction text, stability real, difficulty real, last_review timestamptz)
   where x.direction = 'fr'
     and c.id = x.id
     and c.user_id = p_user_id
     and c.last_review = x.last_review
     and x.stability > 0
     and x.difficulty between 1 and 10;
  get diagnostics n_fr = row_count;

  update public.user_cards c
     set en_stability = x.stability, en_difficulty = x.difficulty
    from jsonb_to_recordset(p_rows)
         as x(id bigint, direction text, stability real, difficulty real, last_review timestamptz)
   where x.direction = 'en'
     and c.id = x.id
     and c.user_id = p_user_id
     and c.en_last_review = x.last_review
     and x.stability > 0
     and x.difficulty between 1 and 10;
  get diagnostics n_en = row_count;

  return n_fr + n_en;
end
$$;

revoke all on function public.apply_memory_estimates(uuid, jsonb) from public;
revoke all on function public.apply_memory_estimates(uuid, jsonb) from anon, authenticated;
grant execute on function public.apply_memory_estimates(uuid, jsonb) to service_role;
