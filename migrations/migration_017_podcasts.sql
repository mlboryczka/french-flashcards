-- migration_017: podcasts, the second part of the app (2026-10-09)
--
-- WHAT WAS MISSING
--
-- The owner approved a Podcasts module on 2026-10-09 ("i like it build it"):
-- beside Flashcards, a student follows RFI's learner podcasts (Journal en
-- français facile, Les mots de l'info, Un mot, une histoire), added by
-- pasting a Spotify link. Each episode gets questions on passages of RFI's
-- own transcript: "What's being said here? Give the idea in English." or
-- "Translate into English.", with a Listen button that plays RFI's recording
-- of that passage. Claude marks each answer "Got it", "Partly" or "Missed",
-- and a passage not fully understood comes back three days later. Nothing in
-- the database could hold any of it: which podcasts a student follows, the
-- episodes with their transcripts and questions, or the answers.
--
-- Owner only until the owner has tried it (2026-10-09): the app shows
-- Podcasts to the owner alone and the server refuses everyone else. That is
-- decided in code (isAdmin), not here: no policy below names an email
-- (migration_008 explains why an email in a policy is the wrong boundary).
--
-- WHAT THIS ADDS
--
-- 1. podcast_episodes: every episode of a podcast anyone follows, kept once
--    for everyone. The first table every signed-in student may read: an
--    episode's transcript and questions are the same for all, and writing
--    them costs a call to Claude, made once per episode, not once per
--    student. Only the server writes it, with the service role; no policy
--    lets a browser write.
--      podcast, guid          which podcast (a slug from the code's catalogue,
--                             src/lib/podcastCatalogue.js) and RFI's own id
--                             for the episode; one row per pair
--      title, published_at, page_url, audio_url, duration_seconds
--                             from the RSS feed. A feed read writes only these,
--                             so reading the feed again never blanks what
--                             was read or written later.
--      transcript             RFI's transcript, one string per paragraph:
--                             ["Bonjour à toutes et à tous.", ...]; empty
--                             until the episode's page is first read
--      stories                RFI's stories with their start times:
--                             [{ "t": 78, "title": "Mouvement lycéen : ...",
--                                "p": 7 }], t in seconds, p the story's first
--                             paragraph (or null). [] for a podcast without
--                             stories.
--      page_read_at, page_error   when the page was read, and why it couldn't
--                             be (in plain words)
--      questions              the passages asked, written once by Claude:
--                             { "passages": [{ "key": "s1-3fa2c1d0",
--                               "story": 1, "kind": "gist", "fr": "...",
--                               "start": 83.4, "end": 101.0, "answer": "...",
--                               "ideas": [...], "phrases": [...] }],
--                               "storyStarts": [0, 7, 12] }
--                             A passage's key comes from its own French, so
--                             questions written again never pin an old answer
--                             on a different passage.
--      questions_version, questions_model, questions_at, questions_error
--                             which prompt and model wrote them, when, and
--                             why the last try failed, as a short code
--                             ("busy:429", "unreadable"), never Claude's own
--                             message, since every signed-in student can
--                             read this table
--      questions_lease_until  a turn: the one request writing the questions
--                             holds it for a few minutes, so two students
--                             opening a new episode at once pay Claude once;
--                             a turn never given back runs out by itself
--
-- 2. podcast_follows: the podcasts each student follows, one row per podcast,
--    with the Spotify link it was added from. A student reads, adds and
--    removes only their own.
--
-- 3. podcast_answers: every answer to a passage, one row each, kept like
--    card_reviews: the passage's key and its French as shown (so the record
--    stands alone if the questions are ever written again), what the student
--    typed, Claude's verdict ('got', 'partly', 'missed') and feedback
--    ({ "caught": [...], "missed": [...], "note": "..." }), the model and
--    prompt version, and due_at: when a passage not fully got comes back
--    (three days on; empty for 'got'). A passage's state is its latest answer.
--    The server writes them with the service role; a student reads only their
--    own; nobody updates or deletes one. An episode with answers can't be
--    deleted (no cascade), so clearing old episodes can never take a
--    student's answers with it.
--
-- Nothing existing is changed or deleted: three new, empty tables. Flashcards
-- works before this is run and after; until it is run the Podcasts pages say
-- "Podcasts need a database update first". Re-runnable.

-- 1. Episodes, shared ----------------------------------------------------------

create table if not exists public.podcast_episodes (
  id uuid primary key default gen_random_uuid(),
  podcast text not null,
  guid text not null,
  title text not null,
  published_at timestamptz,
  page_url text,
  audio_url text,
  duration_seconds integer,
  -- ["paragraph", ...]; null until the page is read
  transcript jsonb,
  -- [{ "t": 78, "title": "...", "p": 7 }]
  stories jsonb not null default '[]'::jsonb,
  page_read_at timestamptz,
  page_error text,
  -- { "passages": [...], "storyStarts": [...] }; null until written
  questions jsonb,
  questions_version text,
  questions_model text,
  questions_at timestamptz,
  questions_error text,
  questions_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (podcast, guid)
);

create index if not exists podcast_episodes_podcast_time_idx
  on public.podcast_episodes (podcast, published_at desc);

alter table public.podcast_episodes enable row level security;

-- Any signed-in student may read every episode; nobody's browser may write.
drop policy if exists "Signed-in users can read podcast episodes" on public.podcast_episodes;
create policy "Signed-in users can read podcast episodes"
  on public.podcast_episodes for select
  using (auth.role() = 'authenticated');

-- 2. Who follows what ----------------------------------------------------------

create table if not exists public.podcast_follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- a slug from src/lib/podcastCatalogue.js
  podcast text not null,
  -- the Spotify link as pasted
  added_from text,
  followed_at timestamptz not null default now(),
  primary key (user_id, podcast)
);

alter table public.podcast_follows enable row level security;

drop policy if exists "Users can read own podcasts" on public.podcast_follows;
create policy "Users can read own podcasts"
  on public.podcast_follows for select
  using (auth.uid() = user_id);

drop policy if exists "Users can follow podcasts" on public.podcast_follows;
create policy "Users can follow podcasts"
  on public.podcast_follows for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can unfollow podcasts" on public.podcast_follows;
create policy "Users can unfollow podcasts"
  on public.podcast_follows for delete
  using (auth.uid() = user_id);

-- 3. Every answer ----------------------------------------------------------

create table if not exists public.podcast_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- No cascade: an episode with answers can't be deleted.
  episode_id uuid not null references public.podcast_episodes(id),
  passage_key text not null,
  -- 'gist' "What's being said here? Give the idea in English."
  -- 'translate' "Translate into English."
  kind text not null check (kind in ('gist', 'translate')),
  -- the passage's French as shown
  fr text not null,
  typed text not null,
  verdict text not null check (verdict in ('got', 'partly', 'missed')),
  -- { "caught": [...], "missed": [...], "note": "..." }
  feedback jsonb not null default '{}'::jsonb,
  model text,
  prompt_version text,
  answered_at timestamptz not null default now(),
  -- when the passage comes back; null for 'got'
  due_at timestamptz,
  time_zone text,
  created_at timestamptz not null default now()
);

create index if not exists podcast_answers_user_time_idx
  on public.podcast_answers (user_id, answered_at);

create index if not exists podcast_answers_user_episode_idx
  on public.podcast_answers (user_id, episode_id);

alter table public.podcast_answers enable row level security;

-- A student reads their own answers. No insert, update or delete policy: the
-- server writes each answer with the service role, and an answer is a record,
-- like card_reviews.
drop policy if exists "Users can read own podcast answers" on public.podcast_answers;
create policy "Users can read own podcast answers"
  on public.podcast_answers for select
  using (auth.uid() = user_id);

-- Supabase gives these by default; said here so the tables work wherever this
-- is run. What a student's browser may do is still only what the policies
-- above allow.
grant all on table public.podcast_episodes, public.podcast_follows, public.podcast_answers to service_role;
grant select on table public.podcast_episodes to authenticated;
grant select, insert, delete on table public.podcast_follows to authenticated;
grant select on table public.podcast_answers to authenticated;

-- PostgREST picks up the new tables.
notify pgrst, 'reload schema';
