-- migration_016: no card made twice from the same notes (2026-10-06)
--
-- WHAT WAS MISSING
--
-- The owner: "there should be NO duplicates from reuploading an updated
-- cahier". On 2026-10-06, 73 cards in the owner's deck repeated another card,
-- and two other students had a few. They came from three gaps:
--
-- 1. Nothing remembered which lines of a student's notes had been read. Every
--    upload asked Claude to read every class again, and Claude writes the same
--    line a little differently each time ("Je pars." / "Je pars", "soulagé
--    (adj)" / "soulagé"), so each new spelling became a new card. The linked
--    notebook kept a list of class dates on its link row, which Unlink erased.
--
-- 2. Saving the cards and noting the class as read were two separate writes.
--    When the second failed, the cards stayed and the class was read again
--    the next time, in new spellings. Two runs at once (the daily check and
--    the app opening, or two devices) could also read one class twice.
--
-- 3. Deleting a card erased the row and every answer on it, and nothing
--    remembered it, so the next upload made it again ("Naza", deleted in
--    April, was back on 4 September). A card taken out of study had no record
--    of why.
--
-- WHAT THIS ADDS
--
-- 1. notes_read: one row per student. `classes` is every line of their notes
--    already read, as a short fingerprint per line, grouped by class date:
--    { "2026-09-24": ["k3j9x2", ...] } (src/lib/notesLines.js). The upload and
--    the linked notebook share it, and Unlink doesn't touch it. `run_id`,
--    `run_kind` and `run_expires_at` say whose turn it is to read: one run at
--    a time per student, and a turn that is never given back runs out by
--    itself (a few minutes for the sync, twenty for an upload).
--
-- 2. Two functions, which only the server may call:
--    claim_notes_reading  takes the student's turn, or says who has it. An
--                         upload, which spans several requests, renews its
--                         own turn and nobody else's: if its turn ran out and
--                         another reading came and went meanwhile, the
--                         upload has lost it and saves nothing.
--    save_notes_reading   in one step: adds the new cards, adds class dates to
--                         cards the student already has (and nothing else
--                         about them), takes out of study or brings back what
--                         "Replace my existing deck" decided, keeps Claude's
--                         verdicts, writes the record of lines read, and gives
--                         the turn back. Either all of it is saved or none. A
--                         card the database can't hold (a French side too
--                         long for the deck's index) is left out and named
--                         in the reply, inside that same step.
--
-- 3. On user_cards, why a card is out of study:
--      archived_reason  'removed'   the student removed it (Delete used to
--                                   erase it)
--                       'replaced'  "Replace my existing deck" took it out;
--                                   the only kind that comes back, when a
--                                   Replace upload has its class again
--                       'duplicate' put away as a repeat of another card
--                       anything else names whatever took it out; null on
--                       cards archived before this, whose reason wasn't kept
--      archived_at      when
--      merged_into      for a 'duplicate', the card it repeats
--    A card that comes back into study by any path loses its reason and time
--    (a trigger), so no card in study says it was removed.
--
-- 4. card_pairs: every same-or-different question Claude answered about two
--    look-alike cards (api/_lib/sameCardQuestion.js): the two cards (ids, and
--    their text as Claude saw it, since a card judged "same" is never saved
--    and has no id), the verdict, and the version of the question. The
--    upload and the sync keep the verdicts they ask for, and the morning
--    check asks about cards already in study that look alike (source
--    'check', api/_lib/statusDaily.js); "No card is in your deck twice"
--    fails on two cards in study Claude judged the same.
--
-- 5. eval_runs.kind may be 'repeats' too: the test of Claude's
--    same-or-different question (api/_lib/repeatsChecks.js), whose cases are
--    the cards put away as a repeat (archived_reason 'duplicate', with
--    merged_into) and fixed pairs that must stay apart.
--
-- Nothing existing is changed or deleted: new columns are empty, new tables
-- are empty. The app works before this is run (it then knows classes by date
-- only, as before), and after. Read and written only by the server: row level
-- security is on and no policy lets a student's browser in. Re-runnable.

-- 1. The record of lines read ---------------------------------------------

create table if not exists public.notes_read (
  user_id uuid primary key references auth.users(id) on delete cascade,
  classes jsonb not null default '{}'::jsonb,
  run_id uuid,
  run_kind text,
  run_started_at timestamptz,
  run_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.notes_read enable row level security;

-- 3. Why a card is out of study (before the functions, which write them) ---

alter table public.user_cards add column if not exists archived_reason text;
alter table public.user_cards add column if not exists archived_at timestamptz;
alter table public.user_cards add column if not exists merged_into bigint
  references public.user_cards(id) on delete set null;

-- A reason belongs to a card out of study. A card that comes back by any
-- path (the tutor adding the same French, Revert in View feedback, a lesson)
-- loses it, so no card in study says it was removed.
create or replace function public.user_cards_clear_archived_reason()
returns trigger
language plpgsql
as $$
begin
  if new.source is null or new.source not like 'archived:%' then
    new.archived_reason := null;
    new.archived_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists user_cards_clear_archived_reason on public.user_cards;
create trigger user_cards_clear_archived_reason
  before update of source on public.user_cards
  for each row execute function public.user_cards_clear_archived_reason();

-- 4. Claude's verdicts on look-alike cards ----------------------------------

create table if not exists public.card_pairs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The card the student already had, and the new one once saved. A new card
  -- judged "same" is never saved: card_b stays empty and b_front/b_back say
  -- what it was.
  card_a bigint references public.user_cards(id) on delete set null,
  card_b bigint references public.user_cards(id) on delete set null,
  a_front text,
  a_back text,
  b_front text,
  b_back text,
  verdict text not null check (verdict in ('same', 'different')),
  version text,
  model text,
  -- 'upload', 'sync', or 'check' (the morning check)
  source text,
  asked_at timestamptz not null default now()
);

create index if not exists card_pairs_user_time_idx
  on public.card_pairs (user_id, asked_at desc);

alter table public.card_pairs enable row level security;

-- 2. The two functions ------------------------------------------------------

-- An earlier draft of this file had claim_notes_reading without p_renew;
-- dropped so a second run leaves one function, not two.
drop function if exists public.claim_notes_reading(uuid, uuid, text, integer);

create or replace function public.claim_notes_reading(
  p_user_id uuid,
  p_run_id uuid,
  p_kind text,
  p_lease_seconds integer default 600,
  -- true: only renew this run's own turn, never take a free one
  p_renew boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r public.notes_read%rowtype;
begin
  insert into public.notes_read (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  -- Ours already, or (for a new run) free or run out: take it. Two runs
  -- asking at once queue on the row, and the second finds it taken. A run
  -- renewing its turn finds it gone if another reading took it, even one that
  -- has finished since: the record may have changed under it.
  update public.notes_read
     set run_id = p_run_id,
         run_kind = p_kind,
         run_started_at = case when run_id = p_run_id then run_started_at else now() end,
         run_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 30))
   where user_id = p_user_id
     and (run_id = p_run_id
          or (not coalesce(p_renew, false)
              and (run_id is null or run_expires_at is null or run_expires_at < now())))
  returning * into r;

  if not found then
    select * into r from public.notes_read where user_id = p_user_id;
    return jsonb_build_object('claimed', false, 'run_kind', r.run_kind,
      'run_started_at', r.run_started_at, 'run_expires_at', r.run_expires_at);
  end if;
  return jsonb_build_object('claimed', true, 'classes', r.classes);
end;
$$;

create or replace function public.save_notes_reading(
  p_user_id uuid,
  p_run_id uuid,
  -- [{front, back, category, dates, source, batch_id}]
  p_inserts jsonb default '[]'::jsonb,
  -- [{id, dates}]: class dates to add to cards the student already has
  p_dates jsonb default '[]'::jsonb,
  -- [{id, reason}]: cards to take out of study
  p_archive jsonb default '[]'::jsonb,
  -- [id]: cards "Replace" took out, to bring back
  p_restore jsonb default '[]'::jsonb,
  -- Claude's verdicts, as card_pairs rows; a new card is named by its front
  -- (a_new_front, b_new_front) and its id looked up once it is saved
  p_pairs jsonb default '[]'::jsonb,
  -- the whole record of lines read; null leaves it as it is
  p_classes jsonb default null,
  -- give the turn back
  p_finish boolean default true
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_inserted integer := 0;
  v_joined integer := 0;
  v_dated integer := 0;
  v_archived integer := 0;
  v_restored integer := 0;
  v_pairs integer := 0;
  v_refused jsonb := '[]'::jsonb;
  v_fresh boolean;
  v_card record;
begin
  -- Only the run whose turn it is may save. One that ran out of time and lost
  -- its turn saves nothing.
  perform 1 from public.notes_read
    where user_id = p_user_id and run_id = p_run_id
    for update;
  if not found then
    raise exception 'This reading of the notes lost its turn: another one started after it ran out of time.'
      using errcode = 'NR409';
  end if;

  -- New cards. A card that already holds the same French (written meanwhile
  -- by something else) only gains the class dates: nothing about it is
  -- written over.
  --
  -- All at once, and if the database refuses any card (a French side too
  -- long for the deck's index, say), one at a time: the others are saved and
  -- the refused ones named in the reply. Both happen inside this one step, so
  -- a refused card can never leave the rest saved and the lines unread. That
  -- used to be possible, and the next reading then added Claude's new
  -- spellings beside the saved cards.
  begin
    with incoming as (
      select x.front, x.back, coalesce(x.category, 'V') as category,
             coalesce(x.dates, '[]'::jsonb) as dates, x.source, x.batch_id
      from jsonb_to_recordset(coalesce(p_inserts, '[]'::jsonb))
        as x(front text, back text, category text, dates jsonb, source text, batch_id uuid)
    ), written as (
      insert into public.user_cards as c (user_id, front, back, category, dates, source, batch_id)
      select p_user_id, front, back, category, dates, source, batch_id from incoming
      on conflict (user_id, front) do update
        set dates = (select coalesce(jsonb_agg(d order by d), '[]'::jsonb)
                     from (select distinct jsonb_array_elements_text(c.dates || excluded.dates) as d) s)
      returning (xmax = 0) as fresh
    )
    select count(*) filter (where fresh), count(*) filter (where not fresh)
      into v_inserted, v_joined
      from written;
  exception
    when data_exception or integrity_constraint_violation or program_limit_exceeded or cardinality_violation then
      v_inserted := 0;
      v_joined := 0;
      for v_card in
        select r.front, r.back, coalesce(r.category, 'V') as category,
               coalesce(r.dates, '[]'::jsonb) as dates, r.source, r.batch_id
        from jsonb_to_recordset(coalesce(p_inserts, '[]'::jsonb))
          as r(front text, back text, category text, dates jsonb, source text, batch_id uuid)
      loop
        begin
          insert into public.user_cards as c (user_id, front, back, category, dates, source, batch_id)
          values (p_user_id, v_card.front, v_card.back, v_card.category, v_card.dates, v_card.source, v_card.batch_id)
          on conflict (user_id, front) do update
            set dates = (select coalesce(jsonb_agg(d order by d), '[]'::jsonb)
                         from (select distinct jsonb_array_elements_text(c.dates || excluded.dates) as d) s)
          returning (xmax = 0) into v_fresh;
          if v_fresh then v_inserted := v_inserted + 1; else v_joined := v_joined + 1; end if;
        exception
          when data_exception or integrity_constraint_violation or program_limit_exceeded or cardinality_violation then
            v_refused := v_refused || jsonb_build_array(
              jsonb_build_object('front', v_card.front, 'error', sqlerrm, 'code', sqlstate));
        end;
      end loop;
  end;

  -- Class dates added to cards the student already has.
  with u as (
    select x.id, x.dates
    from jsonb_to_recordset(coalesce(p_dates, '[]'::jsonb)) as x(id bigint, dates jsonb)
  ), done as (
    update public.user_cards c
       set dates = (select coalesce(jsonb_agg(d order by d), '[]'::jsonb)
                    from (select distinct jsonb_array_elements_text(c.dates || u.dates) as d) s)
      from u
     where c.id = u.id and c.user_id = p_user_id
    returning c.id
  )
  select count(*) into v_dated from done;

  -- Out of study, kept, with the reason.
  with a as (
    select x.id, x.reason
    from jsonb_to_recordset(coalesce(p_archive, '[]'::jsonb)) as x(id bigint, reason text)
  ), done as (
    update public.user_cards c
       set source = 'archived:' || coalesce(c.source, ''),
           archived_reason = a.reason,
           archived_at = now()
      from a
     where c.id = a.id and c.user_id = p_user_id
       and (c.source is null or c.source not like 'archived:%')
    returning c.id
  )
  select count(*) into v_archived from done;

  -- Back into study: only cards a Replace took out.
  with done as (
    update public.user_cards c
       set source = nullif(substr(c.source, 10), ''),
           archived_reason = null,
           archived_at = null
     where c.user_id = p_user_id
       and c.id in (select (jsonb_array_elements_text(coalesce(p_restore, '[]'::jsonb)))::bigint)
       and c.source like 'archived:%'
       and c.archived_reason = 'replaced'
    returning c.id
  )
  select count(*) into v_restored from done;

  -- Claude's verdicts.
  insert into public.card_pairs
    (user_id, card_a, card_b, a_front, a_back, b_front, b_back, verdict, version, model, source)
  select p_user_id,
         coalesce(x.card_a, (select c.id from public.user_cards c where c.user_id = p_user_id and c.front = x.a_new_front)),
         coalesce(x.card_b, (select c.id from public.user_cards c where c.user_id = p_user_id and c.front = x.b_new_front)),
         x.a_front, x.a_back, x.b_front, x.b_back, x.verdict, x.version, x.model, x.source
    from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb))
      as x(card_a bigint, a_new_front text, card_b bigint, b_new_front text,
           a_front text, a_back text, b_front text, b_back text,
           verdict text, version text, model text, source text)
   where x.verdict in ('same', 'different')
     and (x.card_a is null or exists (select 1 from public.user_cards c where c.id = x.card_a and c.user_id = p_user_id));
  get diagnostics v_pairs = row_count;

  -- The record of lines read, and the turn.
  update public.notes_read
     set classes = coalesce(p_classes, classes),
         run_id = case when p_finish then null else run_id end,
         run_kind = case when p_finish then null else run_kind end,
         run_expires_at = case when p_finish then null else run_expires_at end,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object('inserted', v_inserted, 'joined', v_joined, 'dated', v_dated,
    'archived', v_archived, 'restored', v_restored, 'pairs', v_pairs, 'refused', v_refused);
end;
$$;

-- Supabase gives the server's role these by default; said here so the
-- functions work wherever this is run.
grant all on table public.notes_read, public.card_pairs to service_role;

revoke all on function public.claim_notes_reading(uuid, uuid, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.save_notes_reading(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.claim_notes_reading(uuid, uuid, text, integer, boolean) to service_role;
grant execute on function public.save_notes_reading(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) to service_role;

-- 5. The checks for repeated cards keep their runs with the others ---------

do $$
begin
  if to_regclass('public.eval_runs') is not null then
    alter table public.eval_runs drop constraint if exists eval_runs_kind_check;
    alter table public.eval_runs add constraint eval_runs_kind_check
      check (kind in ('answers', 'notes', 'repeats'));
  end if;
end;
$$;

-- PostgREST picks up the new functions and columns.
notify pgrst, 'reload schema';
