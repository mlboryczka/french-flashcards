import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { missingTable } from "./lib/dealLog";
import { podcastBySlug } from "./lib/podcastCatalogue";
import { podcastCall } from "./lib/podcastApi";

// The Podcasts module's reads (owner-approved build, 2026-10-09).
//
// Everything here is read straight from Supabase under row-level security,
// the way the deck is: the student's own follows and answers, and the shared
// episode cache, which any signed-in user may read (migration_017). Writes go
// through POST /api/podcasts instead (src/lib/podcastApi.js), because the
// episode cache and the answer record are written by the server alone.
//
// Before the owner runs migration_017 every podcast_* table answers "not in
// the schema cache" (PGRST205) or "relation does not exist" (42P01). That is
// a state, not a failure: each hook reports `missing`, the pages say plainly
// that a database update is waiting, and nothing on the Flashcards side
// notices (owner rule: the app keeps working before a migration is run).
//
// The pages unmount whenever the student switches back to Flashcards, so the
// last lists read are kept here, outside React, per user: coming back paints
// them at once while the fresh read runs, instead of an empty page. Like the
// tutor's thread (src/lib/tutorThreads.js), they live in memory only and
// sign-out drops them (clearPodcastDrafts below, called from App.jsx).

// ── Kept in memory between visits ─────────────────────────────────────────
const followsCache = new Map();   // userId -> follows
const episodesCache = new Map();  // userId -> { key, episodes }
const answersCache = new Map();   // userId -> rows
const refreshedAt = new Map();    // userId -> { at, key }
const followsRead = new Map();    // userId -> "read" | "failed", once a read has come back
const drafts = new Map();         // `${userId}|${episodeId}|${passageKey}` -> text

// Unsent answers survive the page unmounting (a switch to Flashcards and
// back, or opening another episode), the way a half-typed tutor question
// does. Keyed by user, so one student's draft never shows to another on a
// shared computer.
const draftKey = (userId, episodeId, key) => `${userId}|${episodeId}|${key}`;
export const readDraft = (userId, episodeId, key) => drafts.get(draftKey(userId, episodeId, key)) || "";
export function writeDraft(userId, episodeId, key, text) {
  if (!userId) return;
  const k = draftKey(userId, episodeId, key);
  if (text) drafts.set(k, text);
  else drafts.delete(k);
}

// What "Add to my cards" last answered for a phrase, per user, so "Added ✓"
// stays on the button when the student moves between the Questions and
// Words to learn tabs, or leaves the episode and comes back. After a reload
// the deck itself says "In your deck", which is the same fact read fresh.
const cardAdds = new Map();       // `${userId}|${french, lower-cased}` -> { state, message, code }
const addKey = (userId, front) => `${userId}|${String(front || "").trim().toLowerCase()}`;
export const readCardAdd = (userId, front) => cardAdds.get(addKey(userId, front)) || null;
export function writeCardAdd(userId, front, value) {
  if (!userId) return;
  if (value) cardAdds.set(addKey(userId, front), value);
  else cardAdds.delete(addKey(userId, front));
}

// Sign-out: forget everything this file holds for the user (drafts, card
// adds and the lists kept for a quick repaint).
export function clearPodcastDrafts(userId) {
  for (const k of [...drafts.keys()]) if (k.startsWith(`${userId}|`)) drafts.delete(k);
  for (const k of [...cardAdds.keys()]) if (k.startsWith(`${userId}|`)) cardAdds.delete(k);
  followsCache.delete(userId);
  followsRead.delete(userId);
  episodesCache.delete(userId);
  answersCache.delete(userId);
  refreshedAt.delete(userId);
}

// How the last read of the follows went for this user: "unknown" until one
// has come back, then "read" or "failed". Until then the Episodes page can't
// tell "follows nothing" from "not read yet" and says neither (a page
// reloaded straight onto Podcasts would otherwise flash "Add a podcast under
// My podcasts…"); after a failure it says the read failed rather than that.
export const followsState = (userId) => followsRead.get(userId) || "unknown";

// ── Followed podcasts ─────────────────────────────────────────────────────
// The sidebar lists these under "My podcasts", so FlashcardApp loads them
// (enabled only for the owner while the module is theirs alone). Only
// podcasts the app's catalogue knows are kept (src/lib/podcastCatalogue.js):
// a follow of one taken out of the catalogue would have no name and no feed.
// Oldest first, so a podcast added from a Spotify link joins the end of the
// list rather than reshuffling it.
//
//   → { follows: [{ podcast, followed_at }], missing, loading, reload }
//   reload() reads again and resolves once the new list is in.
export function usePodcastFollows(user, { enabled = true } = {}) {
  const userId = user?.id ?? null;
  const on = !!(enabled && userId);
  const [state, setState] = useState(() => ({
    follows: (on && followsCache.get(userId)) || [],
    missing: false,
    loading: on && !followsCache.has(userId),
  }));
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!on) {
      // A student's app (enabled is false) starts in exactly this state, so
      // nothing changes and it doesn't render again for it.
      setState((s) => (s.follows.length || s.missing || s.loading ? { follows: [], missing: false, loading: false } : s));
      return [];
    }
    const mine = ++seq.current;
    const { data, error } = await supabase
      .from("podcast_follows")
      .select("podcast, followed_at")
      .eq("user_id", userId)
      .order("followed_at", { ascending: true });
    if (mine !== seq.current) return followsCache.get(userId) || [];
    if (error) {
      const missing = missingTable(error);
      followsRead.set(userId, missing ? "read" : "failed");
      if (!missing) console.error("[podcasts] reading followed podcasts failed:", error);
      setState((s) => ({ follows: missing ? [] : s.follows, missing, loading: false }));
      return [];
    }
    const follows = (data || [])
      .filter((r) => r && podcastBySlug(r.podcast))
      .map((r) => ({ podcast: r.podcast, followed_at: r.followed_at }));
    followsCache.set(userId, follows);
    followsRead.set(userId, "read");
    setState({ follows, missing: false, loading: false });
    return follows;
  }, [on, userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

// ── Episodes of the followed podcasts ─────────────────────────────────────
// The columns the lists show, which leaves out the transcript (only the
// episode page needs it, and it is most of a row's size) and the server's own
// bookkeeping: the lease, the prompt version, and why writing the questions
// last failed, which the page never shows (the episode action says it in
// plain words). `questions` is read because the lists count each episode's
// passages ("3 of 9 passages answered").
//
// Read per podcast, newest first, EPISODES_PER_PODCAST each. One query over
// all of them with a single limit let the Journal (five a week) push the
// weekly podcasts off the end: Un mot, une histoire's latest episodes are
// months old.
export const EPISODES_PER_PODCAST = 60;
const LIST_COLUMNS = "id, podcast, guid, title, published_at, page_url, audio_url, duration_seconds, stories, questions";

// The server reads the feeds at most this often for one student. Following a
// podcast reads its feed straight away, so this only paces the visits.
export const REFRESH_EVERY_MS = 10 * 60 * 1000;

const byNewest = (a, b) => (Date.parse(b.published_at || "") || 0) - (Date.parse(a.published_at || "") || 0);

export function usePodcastEpisodes(user, slugs, { enabled = true } = {}) {
  const userId = user?.id ?? null;
  const key = [...(slugs || [])].sort().join(",");
  const on = !!(enabled && userId);
  const cachedFor = (k) => {
    const c = userId ? episodesCache.get(userId) : null;
    return c && c.key === k ? c.episodes : null;
  };
  const [state, setState] = useState(() => ({
    episodes: cachedFor(key) || [],
    loading: on && !cachedFor(key),
    missing: false,
    error: "",
  }));
  const seq = useRef(0);

  const read = useCallback(async (mine) => {
    const list = key ? key.split(",") : [];
    if (!list.length) return { episodes: [] };
    const results = await Promise.all(list.map((slug) =>
      supabase
        .from("podcast_episodes")
        .select(LIST_COLUMNS)
        .eq("podcast", slug)
        .order("published_at", { ascending: false })
        .limit(EPISODES_PER_PODCAST)
    ));
    if (mine !== seq.current) return null;
    const failed = results.find((r) => r.error);
    if (failed) return { error: failed.error };
    return { episodes: results.flatMap((r) => r.data || []).sort(byNewest) };
  }, [key]);

  const apply = useCallback((out) => {
    if (!out) return;
    if (out.error) {
      const missing = missingTable(out.error);
      if (!missing) console.error("[podcasts] reading episodes failed:", out.error);
      setState((s) => ({ ...s, loading: false, missing, error: missing ? "" : "Couldn’t read the episodes. Try again in a minute." }));
      return;
    }
    episodesCache.set(userId, { key, episodes: out.episodes });
    setState({ episodes: out.episodes, loading: false, missing: false, error: "" });
  }, [userId, key]);

  // Read what the database has, then (at most every REFRESH_EVERY_MS) ask the
  // server to read the feeds for new episodes, and read again. `force` skips
  // the pacing; reload() uses it after following a podcast.
  const load = useCallback(async ({ force = false } = {}) => {
    if (!on) return;
    const mine = ++seq.current;
    const first = await read(mine);
    apply(first);
    if (!first || first.error) return;
    const last = refreshedAt.get(userId);
    const fresh = last && last.key === key && Date.now() - last.at < REFRESH_EVERY_MS;
    if (!key || (fresh && !force)) return;
    refreshedAt.set(userId, { at: Date.now(), key });
    try {
      await podcastCall({ action: "refresh" }, { supabase, user: { id: userId } });
    } catch (e) {
      // The list already on screen stays; RFI being slow is not worth an
      // alarm. Shown only when there is nothing else to show.
      console.warn("[podcasts] refreshing the feeds failed:", e?.message || e);
      if (mine === seq.current) {
        setState((s) => (s.episodes.length ? s : { ...s, error: e?.message || "Couldn’t read the podcasts’ feeds. Try again in a minute." }));
      }
      return;
    }
    if (mine !== seq.current) return;
    apply(await read(mine));
  }, [on, userId, key, read, apply]);

  useEffect(() => {
    const cached = cachedFor(key);
    setState((s) => ({ ...s, episodes: cached || (key ? s.episodes.filter((e) => key.split(",").includes(e.podcast)) : []), loading: on && !cached }));
    load();
    // cachedFor reads module state only; key and load cover what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const reload = useCallback(() => load({ force: true }), [load]);

  // An episode opened since the list was read may have gained its questions
  // (the first open writes them). Put them on the listed row too, so the list
  // counts its passages without a fresh read. Never the transcript: the list
  // stays light.
  const patch = useCallback((id, fields) => {
    if (!userId || id == null || !fields) return;
    setState((s) => {
      if (!s.episodes.some((e) => e.id === id)) return s;
      const episodes = s.episodes.map((e) => (e.id === id ? { ...e, ...fields } : e));
      episodesCache.set(userId, { key, episodes });
      return { ...s, episodes };
    });
  }, [userId, key]);

  return { ...state, reload, patch };
}

// ── The student's answers ─────────────────────────────────────────────────
// Their own rows only (row-level security says so as well). Oldest first, so
// latestAnswers (src/lib/podcastProgress.js) settles ties in the order they
// were given. add() puts a just-marked answer in without a refetch.
//
// Read a page at a time, every page, as the deck is (src/useUserDeck.js):
// Supabase hands back at most 1,000 rows per request whatever .limit() asks
// for, and oldest first means the rows cut off would be the NEWEST. A
// passage's state is its latest answer, so after about a thousand answers
// (twenty weeks or so of the daily Journal) a passage just got would have
// shown unanswered again, "Back for another try", after a reload. The id
// after the time keeps the order the same from one page to the next.
const ANSWER_COLUMNS = "id, episode_id, passage_key, kind, fr, typed, verdict, feedback, answered_at, due_at";
const ANSWER_PAGE = 1000;

async function readAnswers(userId) {
  const rows = [];
  for (let from = 0; ; from += ANSWER_PAGE) {
    const { data, error } = await supabase
      .from("podcast_answers")
      .select(ANSWER_COLUMNS)
      .eq("user_id", userId)
      .order("answered_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ANSWER_PAGE - 1);
    if (error) return { error };
    rows.push(...(data || []));
    if (!data || data.length < ANSWER_PAGE) return { data: rows };
  }
}

export function usePodcastAnswers(user, { enabled = true } = {}) {
  const userId = user?.id ?? null;
  const on = !!(enabled && userId);
  const [state, setState] = useState(() => ({
    rows: (on && answersCache.get(userId)) || [],
    loading: on && !answersCache.has(userId),
    missing: false,
  }));
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!on) return;
    const mine = ++seq.current;
    const { data, error } = await readAnswers(userId);
    if (mine !== seq.current) return;
    if (error) {
      const missing = missingTable(error);
      if (!missing) console.error("[podcasts] reading answers failed:", error);
      setState((s) => ({ ...s, loading: false, missing }));
      return;
    }
    // An answer marked while this read was on its way is kept.
    const local = (answersCache.get(userId) || []).filter((r) => r._local);
    const ids = new Set((data || []).map((r) => r.id));
    const rows = [...(data || []), ...local.filter((r) => !ids.has(r.id))];
    answersCache.set(userId, rows);
    setState({ rows, loading: false, missing: false });
  }, [on, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback((row) => {
    if (!row || !userId) return;
    const next = [...(answersCache.get(userId) || []).filter((r) => r.id !== row.id), { ...row, _local: true }];
    answersCache.set(userId, next);
    setState((s) => ({ ...s, rows: next }));
  }, [userId]);

  return { ...state, add, reload: load };
}
