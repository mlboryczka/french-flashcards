-- migration_005_spaced_repetition.sql
--
-- Adds Leitner-style spaced repetition fields to user_cards. Replaces the
-- "shuffle the entire deck every session" model with a working set of due
-- cards + a small ration of new cards + occasional spot-checks of mastered
-- ones.
--
--   box (1-5)        mastery level. New cards start at 1. Promote on a
--                    correct answer. Drop to 1 on wrong (or to 2 if the
--                    card was previously mastered = box 5 — knew it once).
--   next_due_at      when this card is eligible for review again. Cards
--                    in the past are surfaced; future-dated are skipped
--                    (except for the random spot-check sample).
--   lapses           cumulative wrong-answer count. Telemetry only — does
--                    not affect scheduling.
--
-- Box → review interval (encoded in app code, not the DB):
--   1 → same session   2 → 1 day   3 → 3 days   4 → 7 days   5 → 21 days

alter table public.user_cards
  add column if not exists box smallint not null default 1,
  add column if not exists next_due_at timestamptz not null default now(),
  add column if not exists lapses integer not null default 0;

alter table public.user_cards
  drop constraint if exists user_cards_box_check;
alter table public.user_cards
  add constraint user_cards_box_check check (box between 1 and 5);

create index if not exists idx_user_cards_due
  on public.user_cards (user_id, next_due_at);
