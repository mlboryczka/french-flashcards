import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";
import { podcastBySlug } from "./lib/podcastCatalogue";
import { podcastCall, PodcastError } from "./lib/podcastApi";
import { BYOK_REQUIRED, BAD_KEY } from "./lib/anthropicKey";
import { cardIndex } from "./lib/sameCard";
import { isArchived } from "./lib/archive";
import {
  answerKey, latestAnswers, passageState, passagesOf, episodeProgress, episodeStatus,
  countLine, comeBackLine, podcastDone, feedbackSentence, phraseRanges, transcriptSections,
  listenWindow, longDate, shortDate, clock, storyAt, RFI_TIME_ZONE,
} from "./lib/podcastProgress";
import {
  usePodcastEpisodes, usePodcastAnswers, readDraft, writeDraft, readCardAdd, writeCardAdd, followsState,
} from "./usePodcasts";

export { clearPodcastDrafts } from "./usePodcasts";

// The Podcasts module's pages (owner-approved mockup, 2026-10-09: "i like it
// build it"). The shell (FlashcardApp) owns which module and which of these
// pages is showing, and the sidebar that marks it; everything inside <main>
// is here: Episodes, My podcasts, one podcast's episodes, and the episode
// page with its play bar and its three tabs.
//
// What the owner decided, all 2026-10-09:
//   • RFI's learner podcasts only for now (src/lib/podcastCatalogue.js). A
//     Spotify link to any episode or show of one of them adds it.
//   • No multiple choice. Each question puts a French passage from RFI's own
//     transcript on screen with a Listen button: "What’s being said here?
//     Give the idea in English." (gist) or "Translate into English."
//   • Listen plays RFI's recording, not the browser's voice: from 3 s before
//     the passage to 2 s after it (src/lib/podcastProgress.js listenWindow).
//   • Claude marks each answer: Got it, Partly or Missed, says what was caught
//     and what was missed, then "A good answer: …" and the passage's key
//     phrases highlighted, each with "Add to my cards".
//   • A passage missed or partly got comes back three days later, unanswered,
//     in its episode, and the Episodes page lists it under "To try again".
//   • Add to my cards makes a normal card through the server, by the deck's
//     same-card rule. It never touches a card the student has, its schedule
//     or the set they are in (owner rule: updates never reset progress), and a
//     card they removed stays removed.
//   • Owner only until the owner has tried it. Every server action refuses
//     anyone else; the switch to reach this page is the owner's alone.
//
// Things that look odd and aren't:
//   • The page scrolls itself (S.scroll) rather than the window: the app shell
//     is a fixed-height flex row, like the Stats page. The play bar is sticky
//     INSIDE that scroll, never position:fixed, so when the tutor opens and
//     <main> makes room with its right padding, the bar moves with the page
//     instead of ending up under the panel.
//   • There is ONE <audio> element per episode page, used by the play bar and
//     by every Listen button, so two recordings can never play over each
//     other. It is paused when the page goes (switching to Flashcards, or
//     another page), and it is the only audio here: no browser voice.
//   • No keyboard handler on the window. Cmd/Ctrl+Enter checks an answer from
//     its own box, and every control is a button. The study page's own key
//     handlers grade cards on Space and Enter; anything global here would
//     fight them.
//   • Unsent answers are kept outside React (src/usePodcasts.js), so a switch
//     to Flashcards and back finds them where they were. Sign-out drops them.
//   • Test markers are data-* attributes this file owns (data-episode,
//     data-passage, data-passage-verdict, data-add-to-cards, …), never copy.

// How often to ask again while another request is writing an episode's
// questions (the server answers 202), and for how long before giving up and
// offering "Try again". Writing them takes up to a minute.
const PREPARE_POLL_MS = 4000;
const PREPARE_MAX_MS = 2 * 60 * 1000;
// How long a first open may take before the page says the questions are
// being written: an episode whose questions already exist answers well within
// it, so it never flashes the message.
const SLOW_OPEN_MS = 1200;
// The tutor is told the transcript, clipped to this (api/chat.js clips again).
const TUTOR_TRANSCRIPT_CHARS = 12000;
// The play bar's speeds, in the order the button steps through them.
const SPEEDS = [1, 0.75, 1.25];
// The longest answer the server takes (api/_lib/podcasts.js, 'mark').
const MAX_ANSWER_CHARS = 2000;

const MISSING_TEXT = "Podcasts need a database update first: run migrations/migration_017_podcasts.sql in Supabase.";
const PREPARING_TEXT = "Writing the questions for this episode…";
const INSTRUCTION = {
  gist: "What’s being said here? Give the idea in English.",
  translate: "Translate into English.",
};
const VERDICT_LABEL = { got: "Got it", partly: "Partly", missed: "Missed" };

// Episodes already opened, with their transcripts: shared data (every student
// reads the same episode), kept so going back to one is instant.
const episodeDetails = new Map();

const studentTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

// Re-read "now" every minute, so a passage that comes due while the page is
// open shows up for another try without a reload.
function useNow(everyMs = 60000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const HOME = { view: "episodes", podcast: null, episodeId: null, from: "episodes", tab: "questions" };
const normalView = (view) => {
  const v = { ...HOME, ...(view || {}) };
  if (!["episodes", "mine", "podcast", "episode"].includes(v.view)) return HOME;
  if (v.view === "episode" && !v.episodeId) return HOME;
  if (v.view === "podcast" && !podcastBySlug(v.podcast)) return HOME;
  if (!["questions", "transcript", "words"].includes(v.tab)) v.tab = "questions";
  return v;
};

// The Journal's feed titles list its stories with slashes and a trailing
// "...": "France: contestation lycéenne / Mali: l'armée reprend Kidal / …".
// Shown as the mockup shows them, with middle dots and no dots at the end.
function rowTitle(episode) {
  const t = String(episode?.title || "").trim();
  if (!podcastBySlug(episode?.podcast)?.dated) return t;
  return t.replace(/\s*(?:\.{3}|…)\s*$/, "").replace(/\s+\/\s+/g, " · ");
}

// "Is this phrase a card the student already has?", by the deck's same-card
// rule, as the lesson sync asks it (src/lib/lessonSync.js): the exact French,
// or the sure rule over every card in study and out of it. A card they took
// out themselves (archived as "removed") is still theirs, and is never put
// back by an add here (owner, 2026-10-06/09). Answers "have", "removed" or
// null. Worked out from the deck rather than remembered, so it is right after
// a reload and after a card is removed elsewhere.
function deckLookup(deckCards, archivedCards) {
  const reasons = new Map();
  const rows = [];
  for (const c of deckCards || []) {
    if (c && typeof c.f === "string") rows.push({ front: c.f, back: c.b || "", source: c.source || null });
  }
  for (const c of archivedCards || []) {
    if (!c || typeof c.f !== "string") continue;
    const row = { front: c.f, back: c.b || "", source: c.source || "archived:" };
    reasons.set(row, c.reason ?? null);
    rows.push(row);
  }
  const index = cardIndex(rows);
  const exact = new Map();
  for (const r of rows) {
    const had = exact.get(r.front);
    if (!had || (isArchived(had) && !isArchived(r))) exact.set(r.front, r);
  }
  return (phrase) => {
    const front = String(phrase?.fr || "").trim();
    if (!front) return null;
    let hit = exact.get(front) || null;
    if (!hit) {
      try {
        hit = index.sure({ front, back: String(phrase?.en || "") });
      } catch {
        hit = null;
      }
    }
    if (!hit) return null;
    return isArchived(hit) && reasons.get(hit) === "removed" ? "removed" : "have";
  };
}

// ═══════════════════════════════════════════════════════════════════════════
export default function PodcastsPage({
  user,
  view,
  setView,
  follows = [],
  followsMissing = false,
  reloadFollows,
  deckCards = [],
  archivedCards = [],
  onCardAdded,
  onTutorContext,
  openChat,
  onNeedKey,
}) {
  const v = normalView(view);
  const userId = user?.id ?? null;
  const slugs = useMemo(
    () => (follows || []).map((f) => f?.podcast).filter((s) => podcastBySlug(s)),
    [follows]
  );
  const eps = usePodcastEpisodes(user, slugs, { enabled: !followsMissing });
  const ans = usePodcastAnswers(user, { enabled: !followsMissing });
  const latest = useMemo(() => latestAnswers(ans.rows), [ans.rows]);
  const now = useNow();
  const missing = !!(followsMissing || eps.missing || ans.missing);

  const go = useCallback((patch) => setView((prev) => ({ ...HOME, ...(prev || {}), ...patch })), [setView]);

  // Each page starts at its top; so does each tab of an episode.
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [v.view, v.podcast, v.episodeId, v.tab]);

  // The tutor hears about an episode only while its page is showing.
  const tutorRef = useRef(onTutorContext);
  tutorRef.current = onTutorContext;
  useEffect(() => {
    if (v.view !== "episode") tutorRef.current?.(null);
  }, [v.view]);
  useEffect(() => () => tutorRef.current?.(null), []);

  // "Add to my cards": what the deck says, and what the last click answered.
  const deckHas = useMemo(() => deckLookup(deckCards, archivedCards), [deckCards, archivedCards]);
  const [, setAddsSeen] = useState(0);
  const setAdd = useCallback((front, value) => {
    writeCardAdd(userId, front, value);
    setAddsSeen((n) => n + 1);
  }, [userId]);
  // What a click answered wins (so "Added ✓" isn't replaced by "In your deck"
  // the moment the card reaches the deck); otherwise the deck says.
  const addState = useCallback((phrase) => {
    const local = readCardAdd(userId, phrase?.fr);
    if (local) return local;
    return { state: deckHas(phrase) || "add" };
  }, [userId, deckHas]);
  const addCard = useCallback(async (phrase, episodeId) => {
    const front = String(phrase?.fr || "").trim();
    const back = String(phrase?.en || "").trim();
    if (!front || !back || !userId) return;
    setAdd(front, { state: "adding" });
    try {
      const { data } = await podcastCall({ action: "add-card", episodeId, front, back }, { supabase, user });
      const added = Array.isArray(data?.added) ? data.added : [];
      if (data?.waiting) setAdd(front, { state: "waiting" });
      else if (added.length) {
        setAdd(front, { state: "added" });
        // Into the deck in memory, the way the tutor's adds go: no refetch,
        // so the set being studied stays exactly where it is.
        for (const row of added) onCardAdded?.(row || null);
      } else if (data?.removed) setAdd(front, { state: "removed" });
      else setAdd(front, { state: "have" });
    } catch (e) {
      setAdd(front, { state: "error", message: e?.message || "Couldn’t add this card. Try again.", code: e?.code || "" });
    }
  }, [user, userId, setAdd, onCardAdded]);

  const openEpisode = (episode, from) =>
    go({ view: "episode", podcast: episode.podcast, episodeId: episode.id, from, tab: "questions" });

  const onFollowed = useCallback(async (data) => {
    const slug = podcastBySlug(data?.podcast) ? data.podcast : null;
    const already = slug && slugs.includes(slug);
    await reloadFollows?.();
    // A podcast newly followed changes the list's key, which reads it again
    // (and the server has just read its feed). One followed already is read
    // again here: the link may have been to an episode the list hasn't got.
    if (already || !slug) eps.reload();
    if (slug && data?.episodeId) go({ view: "episode", podcast: slug, episodeId: data.episodeId, from: "podcast", tab: "questions" });
    else if (slug) go({ view: "podcast", podcast: slug, episodeId: null });
  }, [slugs, reloadFollows, eps, go]);

  let body;
  if (missing) {
    const heading = v.view === "mine" ? "My podcasts" : "Episodes";
    body = (
      <>
        <h1 style={S.h1}>{heading}</h1>
        <p style={S.notice} data-podcasts-missing>{MISSING_TEXT}</p>
      </>
    );
  } else if (v.view === "mine") {
    body = (
      <MineView
        user={user}
        slugs={slugs}
        episodes={eps.episodes}
        latest={latest}
        now={now}
        onOpen={(slug) => go({ view: "podcast", podcast: slug, episodeId: null })}
        onFollowed={onFollowed}
      />
    );
  } else if (v.view === "podcast") {
    body = (
      <PodcastView
        podcast={podcastBySlug(v.podcast)}
        episodes={eps.episodes.filter((e) => e.podcast === v.podcast)}
        loading={eps.loading}
        latest={latest}
        now={now}
        onOpen={(e) => openEpisode(e, "podcast")}
      />
    );
  } else if (v.view === "episode") {
    body = (
      <EpisodeView
        key={v.episodeId}
        user={user}
        episodeId={v.episodeId}
        from={v.from}
        tab={v.tab}
        listRow={eps.episodes.find((e) => e.id === v.episodeId) || null}
        latest={latest}
        now={now}
        go={go}
        onPatchList={eps.patch}
        onAnswer={ans.add}
        addState={addState}
        onAdd={addCard}
        onTutorContext={onTutorContext}
        openChat={openChat}
        onNeedKey={onNeedKey}
      />
    );
  } else {
    body = (
      <EpisodesView
        follows={slugs.length > 0 ? "read" : followsState(userId)}
        slugs={slugs}
        episodes={eps.episodes}
        loading={eps.loading}
        error={eps.error}
        latest={latest}
        now={now}
        onOpen={(e) => openEpisode(e, "episodes")}
      />
    );
  }

  return (
    <div ref={scrollRef} style={S.scroll} data-podcasts-page={missing ? "missing" : v.view}>
      <style>{HOVER_CSS}</style>
      <div style={S.page}>{body}</div>
    </div>
  );
}

// ── Lists ──────────────────────────────────────────────────────────────────
function EpisodeRow({ episode, latest, now, withPodcast, onOpen }) {
  const podcast = podcastBySlug(episode.podcast);
  const status = episodeStatus(episodeProgress(episode, latest, now));
  return (
    <button
      type="button"
      style={S.ep}
      data-pod-hover="row"
      data-episode={episode.id}
      onClick={() => onOpen(episode)}
    >
      <span style={S.epDate}>{shortDate(episode.published_at, RFI_TIME_ZONE)}</span>
      <span style={S.epMain}>
        {withPodcast && podcast && <span style={S.epPod} data-episode-podcast>{podcast.name}</span>}
        <span style={S.epTitle}>{rowTitle(episode)}</span>
        <span style={{ ...S.epStatus, ...TONE[status.tone] }} data-episode-status={status.tone}>{status.text}</span>
      </span>
    </button>
  );
}

function EpisodesView({ follows, slugs, episodes, loading, error, latest, now, onOpen }) {
  if (follows === "unknown") return <h1 style={S.h1}>Episodes</h1>;
  if (follows === "failed" && !slugs.length) {
    return (
      <>
        <h1 style={S.h1}>Episodes</h1>
        <p style={S.empty} data-podcasts-error="follows">Couldn’t read your podcasts. Try again in a minute.</p>
      </>
    );
  }
  if (!slugs.length) {
    return (
      <>
        <h1 style={S.h1}>Episodes</h1>
        <p style={S.empty} data-podcasts-empty>Add a podcast under My podcasts to see its episodes here.</p>
      </>
    );
  }
  // Something due again comes first, under its own heading; the rest follow
  // newest first with none.
  const again = [];
  const rest = [];
  for (const e of episodes) (episodeProgress(e, latest, now).due > 0 ? again : rest).push(e);
  return (
    <>
      <h1 style={S.h1}>Episodes</h1>
      {!episodes.length && !loading && <p style={S.empty}>{error || "No episodes to show yet."}</p>}
      <div data-podcast-episodes>
        {again.length > 0 && (
          <section style={S.group} data-try-again>
            <h2 style={S.groupHeading}>To try again</h2>
            {again.map((e) => (
              <EpisodeRow key={e.id} episode={e} latest={latest} now={now} withPodcast onOpen={onOpen} />
            ))}
          </section>
        )}
        <section style={again.length ? S.groupRest : undefined} data-episode-list>
          {rest.map((e) => (
            <EpisodeRow key={e.id} episode={e} latest={latest} now={now} withPodcast onOpen={onOpen} />
          ))}
        </section>
      </div>
    </>
  );
}

function PodcastView({ podcast, episodes, loading, latest, now, onOpen }) {
  return (
    <>
      <h1 style={S.h1}>{podcast.name}</h1>
      <div style={S.byline}>{podcast.by}</div>
      {!episodes.length && !loading && <p style={S.empty}>No episodes to show yet.</p>}
      <div data-podcast-episodes={podcast.slug}>
        {episodes.map((e) => (
          <EpisodeRow key={e.id} episode={e} latest={latest} now={now} onOpen={onOpen} />
        ))}
      </div>
    </>
  );
}

function MineView({ user, slugs, episodes, latest, now, onOpen, onFollowed }) {
  return (
    <>
      <h1 style={S.h1}>My podcasts</h1>
      {slugs.length > 0 && (
        <div style={S.pods}>
          {slugs.map((slug) => {
            const p = podcastBySlug(slug);
            const { done, total } = podcastDone(episodes.filter((e) => e.podcast === slug), latest, now);
            return (
              <button key={slug} type="button" style={S.pod} data-pod-hover="row" data-podcast-card={slug} onClick={() => onOpen(slug)}>
                <span style={S.podName}>{p.name}</span>
                <span style={S.podBy}>{p.by}</span>
                <span style={S.podDone} data-podcast-done>{`${done} of ${total} episodes done`}</span>
              </button>
            );
          })}
        </div>
      )}
      <PasteBox user={user} onFollowed={onFollowed} />
    </>
  );
}

// The Spotify link box (owner, 2026-10-09: on the My podcasts page, not in the
// sidebar). The server reads the link's title from Spotify and matches it to
// an RFI feed; anything else comes back as a plain sentence, shown as is.
function PasteBox({ user, onFollowed }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const link = text.trim();
    if (!link || busy) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await podcastCall({ action: "follow", link }, { supabase, user });
      setText("");
      await onFollowed(data || {});
    } catch (e) {
      setError(e?.message || "Couldn’t add that podcast. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form style={S.paste} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          style={S.pasteInput}
          value={text}
          onChange={(e) => { setText(e.target.value); if (error) setError(""); }}
          placeholder="Paste a Spotify link"
          aria-label="Spotify link"
          data-spotify-link
        />
        <button
          type="submit"
          style={{ ...S.btn, ...(text.trim() && !busy ? null : S.btnOff) }}
          disabled={!text.trim() || busy}
          data-spotify-add
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      {error && <p style={S.error} role="alert" data-follow-error>{error}</p>}
    </>
  );
}

// ── One episode ────────────────────────────────────────────────────────────
function EpisodeView({
  user, episodeId, from, tab, listRow, latest, now, go, onPatchList, onAnswer,
  addState, onAdd, onTutorContext, openChat, onNeedKey,
}) {
  // The episode as the server sends it (with its transcript). Questions are
  // written the first time anyone opens it; meanwhile another request may
  // already be writing them (202), so the page asks again every few seconds.
  const [detail, setDetail] = useState(() =>
    episodeDetails.has(episodeId)
      ? { status: "ready", episode: episodeDetails.get(episodeId), error: "", code: "" }
      : { status: "loading", episode: null, error: "", code: "" }
  );
  const [tries, setTries] = useState(0);
  const [slow, setSlow] = useState(false);
  const patchRef = useRef(onPatchList);
  patchRef.current = onPatchList;
  // The user object is replaced on every token refresh; only who it is
  // matters here, so the fetch below doesn't run again for that.
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id ?? null;

  useEffect(() => {
    if (tries === 0 && episodeDetails.has(episodeId)) return undefined;
    let cancelled = false;
    let timer = null;
    const started = Date.now();
    setSlow(false);
    const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, SLOW_OPEN_MS);
    setDetail((d) => ({ ...d, status: d.episode ? d.status : "loading", error: "", code: "" }));
    const attempt = async () => {
      try {
        const { status, data } = await podcastCall({ action: "episode", episodeId }, { supabase, user: userRef.current });
        if (cancelled) return;
        if (status === 202 || data?.status === "preparing") {
          if (Date.now() - started >= PREPARE_MAX_MS) {
            setDetail((d) => ({ ...d, status: "error", error: "The questions are taking longer than usual. Try again in a minute.", code: "slow" }));
            return;
          }
          setDetail((d) => ({ ...d, status: "preparing" }));
          timer = setTimeout(attempt, PREPARE_POLL_MS);
          return;
        }
        const episode = data?.episode;
        if (!episode || episode.id == null) throw new PodcastError("The episode didn’t come back. Try again.");
        episodeDetails.set(episodeId, episode);
        setDetail({ status: "ready", episode, error: "", code: "" });
        patchRef.current?.(episodeId, { questions: episode.questions ?? null, stories: episode.stories ?? [] });
      } catch (e) {
        if (cancelled) return;
        setDetail((d) => ({ ...d, status: "error", error: e?.message || "Couldn’t open this episode. Try again.", code: e?.code || "" }));
      }
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(slowTimer);
    };
  }, [episodeId, tries, userId]);

  // While the questions are being written, the transcript may already be
  // saved (the server reads RFI's page first): read it under row-level
  // security so the Transcript tab has something to show.
  const [early, setEarly] = useState(null);
  useEffect(() => {
    if (detail.status === "ready" || early) return undefined;
    let cancelled = false;
    const read = async () => {
      const { data, error } = await supabase
        .from("podcast_episodes").select("transcript, stories").eq("id", episodeId).maybeSingle();
      if (cancelled || error || !Array.isArray(data?.transcript) || !data.transcript.length) return;
      setEarly(data);
    };
    const id = setTimeout(read, detail.status === "preparing" ? 0 : SLOW_OPEN_MS);
    return () => { cancelled = true; clearTimeout(id); };
  }, [episodeId, detail.status, early]);

  const ep = useMemo(
    () => (detail.episode ? { ...(listRow || {}), ...detail.episode } : listRow),
    [detail.episode, listRow]
  );
  const podcast = podcastBySlug(ep?.podcast);
  const passages = useMemo(() => passagesOf(ep), [ep]);
  const stories = Array.isArray(ep?.stories) ? ep.stories : [];
  const paragraphs = Array.isArray(detail.episode?.transcript)
    ? detail.episode.transcript
    : Array.isArray(early?.transcript) ? early.transcript : null;
  const progress = useMemo(() => (ep ? episodeProgress(ep, latest, now) : null), [ep, latest, now]);

  // ── The recording ──────────────────────────────────────────────────────
  const audioRef = useRef(null);
  const stopAt = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [listenKey, setListenKey] = useState(null);
  const [rate, setRate] = useState(1);
  const [nowStory, setNowStory] = useState(-1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [audioError, setAudioError] = useState("");
  const [seekSeq, setSeekSeq] = useState(0);
  const duration = Number(ep?.duration_seconds) > 0 ? Number(ep.duration_seconds) : mediaDuration;
  const storiesRef = useRef(stories);
  storiesRef.current = stories;

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return undefined;
    const quiet = () => {
      stopAt.current = null;
      setPlaying(false);
      setListenKey(null);
    };
    const onTime = () => {
      if (stopAt.current != null && a.currentTime >= stopAt.current) {
        a.pause();
        quiet();
      }
      const k = storyAt(storiesRef.current, a.currentTime);
      setNowStory((prev) => (prev === k ? prev : k));
    };
    const onPlay = () => { setPlaying(true); setStarted(true); setAudioError(""); };
    const onDuration = () => { if (Number.isFinite(a.duration) && a.duration > 0) setMediaDuration(a.duration); };
    const onError = () => {
      if (!a.getAttribute("src")) return;
      quiet();
      setAudioError("Couldn’t load RFI’s recording.");
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("seeked", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", quiet);
    a.addEventListener("ended", quiet);
    a.addEventListener("durationchange", onDuration);
    a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("seeked", onTime);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", quiet);
      a.removeEventListener("ended", quiet);
      a.removeEventListener("durationchange", onDuration);
      a.removeEventListener("error", onError);
      // Leaving the episode (another page, or the switch to Flashcards)
      // stops it. An element taken out of the page pauses anyway; this says
      // so rather than relying on it.
      try { a.pause(); } catch { /* nothing to pause */ }
    };
  }, []);

  const start = (a) => {
    a.defaultPlaybackRate = rate;
    a.playbackRate = rate;
    setAudioError("");
    setPlaying(true);
    setStarted(true);
    let p;
    try {
      p = a.play();
    } catch {
      p = null;
    }
    if (p && typeof p.catch === "function") {
      p.catch((e) => {
        if (e?.name === "AbortError") return;
        stopAt.current = null;
        setPlaying(false);
        setListenKey(null);
        setAudioError("Couldn’t play RFI’s recording.");
      });
    }
  };
  const seekTo = (t, { play = true } = {}) => {
    const a = audioRef.current;
    if (!a || !ep?.audio_url) return;
    try { a.currentTime = Math.max(0, t); } catch { /* not seekable yet: it starts there once loaded */ }
    stopAt.current = null;
    setListenKey(null);
    setNowStory(storyAt(stories, t));
    setSeekSeq((n) => n + 1);
    if (play) start(a);
  };
  const togglePlay = () => {
    const a = audioRef.current;
    if (!a || !ep?.audio_url) return;
    if (playing) {
      stopAt.current = null;
      setPlaying(false);
      setListenKey(null);
      a.pause();
      return;
    }
    stopAt.current = null;
    setListenKey(null);
    start(a);
  };
  const cycleRate = () => {
    const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    setRate(next);
    const a = audioRef.current;
    if (a) {
      a.defaultPlaybackRate = next;
      a.playbackRate = next;
    }
  };
  // Listen: the passage, from a little before to a little after, then stop.
  // Pressed again while it plays, it stops.
  const [focusKey, setFocusKey] = useState(null);
  const listen = (passage) => {
    const a = audioRef.current;
    if (!a || !ep?.audio_url) return;
    setFocusKey(passage.key);
    if (listenKey === passage.key) {
      stopAt.current = null;
      setListenKey(null);
      setPlaying(false);
      a.pause();
      return;
    }
    const w = listenWindow(passage, duration);
    if (!w) return;
    try { a.currentTime = w.from; } catch { /* starts there once loaded */ }
    stopAt.current = w.to;
    setListenKey(passage.key);
    setNowStory(storyAt(stories, w.from));
    setSeekSeq((n) => n + 1);
    start(a);
  };

  // ── What the tutor is told ─────────────────────────────────────────────
  const date = longDate(ep?.published_at, RFI_TIME_ZONE);
  const tutorFor = useCallback((key) => {
    if (!ep) return null;
    const p = key ? passages.find((x) => x.key === key) || null : null;
    const answer = p ? latest.get(answerKey(ep.id, p.key)) || null : null;
    const state = passageState(answer, now);
    const answered = !!p && (state === "got" || state === "waiting");
    const transcript = (paragraphs || []).join("\n\n");
    return {
      key: `pod:${ep.id}:${p ? p.key : ""}`,
      episode: { title: String(ep.title || ""), date, show: podcast?.name || "" },
      passage: p
        ? { fr: p.fr, kind: p.kind, answered, typed: answered ? answer.typed || "" : "", verdict: answered ? answer.verdict : null }
        : null,
      transcript: transcript.length > TUTOR_TRANSCRIPT_CHARS ? transcript.slice(0, TUTOR_TRANSCRIPT_CHARS) : transcript,
    };
  }, [ep, passages, latest, now, paragraphs, date, podcast]);
  const sentRef = useRef("");
  const tellTutor = useCallback((ctx) => {
    const sig = ctx ? JSON.stringify(ctx) : "";
    if (sig === sentRef.current) return;
    sentRef.current = sig;
    onTutorContext?.(ctx);
  }, [onTutorContext]);
  const tutorCtx = useMemo(() => tutorFor(focusKey), [tutorFor, focusKey]);
  useEffect(() => { tellTutor(tutorCtx); }, [tutorCtx, tellTutor]);
  // Forget what was sent when the page goes: the parent tells the tutor
  // "nothing" as it does, so a page mounted again (React's development mode
  // mounts everything twice) must send its episode afresh, not skip it as
  // already sent.
  useEffect(() => () => { sentRef.current = ""; }, []);
  const askTutor = openChat
    ? (passage) => {
        setFocusKey(passage.key);
        const ctx = tutorFor(passage.key);
        tellTutor(ctx);
        if (ctx) openChat({ row_id: ctx.key });
      }
    : null;

  // ── The page ───────────────────────────────────────────────────────────
  const back = from === "podcast" && podcast ? podcast.name : "Episodes";
  const goBack = () =>
    from === "podcast" && podcast
      ? go({ view: "podcast", podcast: podcast.slug, episodeId: null })
      : go({ view: "episodes", episodeId: null });

  const waiting = detail.status === "loading" || detail.status === "preparing";
  const pending = !passages.length && (
    detail.status === "preparing" || (detail.status === "loading" && slow)
      ? <p style={S.empty} data-podcasts-preparing>{PREPARING_TEXT}</p>
      : detail.status === "error" || (detail.status === "ready" && !passages.length)
        ? (
          <Problem
            text={detail.status === "error" ? detail.error : "No questions for this episode yet."}
            code={detail.code}
            onRetry={() => setTries((n) => n + 1)}
            onNeedKey={onNeedKey}
          />
        )
        : null
  );

  const tabs = [["questions", "Questions"], ["transcript", "Transcript"], ["words", "Words to learn"]];
  let panel = null;
  if (tab === "transcript") {
    panel = paragraphs ? (
      <TranscriptTab
        sections={transcriptSections(paragraphs, stories, ep?.questions?.storyStarts)}
        nowStory={started ? nowStory : -1}
        canPlay={!!ep?.audio_url}
        onSeek={(t) => seekTo(t)}
      />
    ) : detail.status === "error" ? (
      <Problem text={detail.error} code={detail.code} onRetry={() => setTries((n) => n + 1)} onNeedKey={onNeedKey} />
    ) : waiting && slow ? (
      <p style={S.empty} data-podcasts-preparing>{PREPARING_TEXT}</p>
    ) : null;
  } else if (tab === "words") {
    panel = passages.length ? (
      <WordsTab passages={passages} episodeId={episodeId} addState={addState} onAdd={onAdd} onNeedKey={onNeedKey} />
    ) : pending;
  } else {
    panel = passages.length ? (
      <QuestionsTab
        user={user}
        ep={ep}
        passages={passages}
        stories={stories}
        progress={progress}
        latest={latest}
        now={now}
        nowStory={started ? nowStory : -1}
        canPlay={!!ep?.audio_url}
        listenKey={listenKey}
        onListen={listen}
        onSeek={(t) => seekTo(t)}
        onFocus={setFocusKey}
        onAnswer={onAnswer}
        onAsk={askTutor}
        addState={addState}
        onAdd={onAdd}
        onNeedKey={onNeedKey}
        onWords={() => go({ tab: "words" })}
      />
    ) : pending;
  }

  return (
    <div data-episode-page={episodeId}>
      <button type="button" style={S.back} data-pod-hover="back" data-back onClick={goBack}>
        {ICON.back}
        {back}
      </button>
      {ep && (podcast?.dated ? (
        <>
          <h1 style={S.h1}>{date}</h1>
          <div style={S.byline}>{podcast.name}</div>
        </>
      ) : (
        <>
          <h1 style={{ ...S.h1, ...S.h1Long }}>{ep.title}</h1>
          <div style={S.byline}>{[podcast?.name, date].filter(Boolean).join(" · ")}</div>
        </>
      ))}

      {/* One element for the play bar and every Listen. preload="none":
          nothing is fetched from RFI until the student presses play. */}
      <audio ref={audioRef} src={ep?.audio_url || undefined} preload="none" data-podcast-audio />
      {ep?.audio_url && (
        <PlayBar
          audioRef={audioRef}
          seekSeq={seekSeq}
          duration={duration}
          stories={stories}
          nowTitle={started && nowStory >= 0 ? stories[nowStory]?.title || "" : ""}
          playing={playing}
          rate={rate}
          error={audioError}
          onToggle={togglePlay}
          onSeek={(t) => seekTo(t, { play: false })}
          onRate={cycleRate}
        />
      )}

      <div style={S.tabs} role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            style={tab === key ? { ...S.tab, ...S.tabOn } : S.tab}
            data-pod-hover="tab"
            data-podcast-tab={key}
            onClick={() => go({ tab: key })}
          >
            {label}
          </button>
        ))}
      </div>
      <div data-tab-panel={tab}>{panel}</div>
    </div>
  );
}

// A failure, in the server's own plain sentence, with a way to try again;
// "Connect Claude account" too when the answer was that there's no key.
function Problem({ text, code, onRetry, onNeedKey }) {
  const keyIssue = (code === BYOK_REQUIRED || code === BAD_KEY) && onNeedKey;
  return (
    <div style={S.problem} data-podcasts-error={code || "error"}>
      <p style={S.problemText}>{text}</p>
      <div style={S.problemActions}>
        {keyIssue && (
          <button type="button" style={S.btn} onClick={onNeedKey}>
            {code === BAD_KEY ? "Update your key" : "Connect Claude account"}
          </button>
        )}
        {onRetry && (
          <button type="button" style={S.ghostBtn} data-pod-hover="add" data-podcasts-retry onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

// ── The play bar ───────────────────────────────────────────────────────────
// Sticky at the top of the page's own scroll. The ticks are where RFI's
// stories start; the line above the track names the story playing.
function PlayBar({ audioRef, seekSeq, duration, stories, nowTitle, playing, rate, error, onToggle, onSeek, onRate }) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return undefined;
    const read = () => setTime(a.currentTime || 0);
    read();
    a.addEventListener("timeupdate", read);
    a.addEventListener("seeked", read);
    a.addEventListener("loadedmetadata", read);
    return () => {
      a.removeEventListener("timeupdate", read);
      a.removeEventListener("seeked", read);
      a.removeEventListener("loadedmetadata", read);
    };
  }, [audioRef]);
  // A seek before the recording has loaded fires no event; read it here.
  useEffect(() => {
    const a = audioRef.current;
    if (a) setTime(a.currentTime || 0);
  }, [audioRef, seekSeq]);

  const chaptered = stories.some((s) => Number.isFinite(Number(s?.t)));
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const onTrack = (e) => {
    if (!(duration > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };
  return (
    <div style={S.pwrap} data-audio-bar>
      <div style={S.player}>
        <button
          type="button"
          style={S.pbtn}
          onClick={onToggle}
          aria-label={playing ? "Pause" : "Play"}
          data-audio-play={playing ? "playing" : "paused"}
        >
          {playing ? ICON.pause : ICON.play}
        </button>
        <div style={S.pmid}>
          {chaptered && <div style={S.pnow} data-audio-now>{nowTitle}</div>}
          <div style={S.trackHit} onClick={onTrack} data-audio-track>
            <div style={S.track}>
              {duration > 0 && stories.map((s, i) => (
                Number.isFinite(Number(s?.t)) ? (
                  <span key={i} style={{ ...S.tick, left: `${(Number(s.t) / duration) * 100}%` }} />
                ) : null
              ))}
              <div style={{ ...S.fill, width: `${pct}%` }} />
            </div>
          </div>
          {error && <div style={S.audioError} role="alert">{error}</div>}
        </div>
        <div style={S.ptime} data-audio-time>{`${clock(time)} / ${clock(duration)}`}</div>
        <button type="button" style={S.speed} data-pod-hover="chip" onClick={onRate} data-audio-speed={rate} aria-label="Playback speed">
          {`${rate}×`}
        </button>
      </div>
    </div>
  );
}

const TimeChip = ({ t, onSeek, disabled }) => (
  <button type="button" style={S.at} data-pod-hover="chip" data-story-time={t} onClick={() => onSeek(t)} disabled={disabled}>
    {ICON.playSm}
    {clock(t)}
  </button>
);

// ── Questions ──────────────────────────────────────────────────────────────
// Passages grouped by the RFI story they come from, in the episode's order,
// each story a card headed by its start time and title. An episode with no
// stories (a single short topic) is one card with no heading.
function QuestionsTab({
  user, ep, passages, stories, progress, latest, now, nowStory, canPlay, listenKey,
  onListen, onSeek, onFocus, onAnswer, onAsk, addState, onAdd, onNeedKey, onWords,
}) {
  const groups = [];
  for (const p of passages) {
    const s = Number.isInteger(p.story) && stories[p.story] ? p.story : null;
    const last = groups[groups.length - 1];
    if (last && last.story === s) last.passages.push(p);
    else groups.push({ story: s, passages: [p] });
  }
  const back = comeBackLine(progress, studentTimeZone());
  return (
    <>
      <div style={progress.done ? { ...S.count, ...S.countDone } : S.count} data-podcast-count>{countLine(progress)}</div>
      {groups.map((g, gi) => {
        const story = g.story != null ? stories[g.story] : null;
        const t = Number(story?.t);
        return (
          <section
            key={`${g.story ?? "x"}-${gi}`}
            style={g.story != null && g.story === nowStory ? { ...S.story, ...S.storyNow } : S.story}
            data-story={g.story ?? ""}
          >
            {story && (
              <div style={S.storyHead}>
                {Number.isFinite(t) && <TimeChip t={t} onSeek={onSeek} disabled={!canPlay} />}
                <div style={S.storyTitle}>{story.title}</div>
              </div>
            )}
            {g.passages.map((p, i) => (
              <PassageBlock
                key={p.key}
                first={i === 0}
                user={user}
                episodeId={ep.id}
                passage={p}
                answer={latest.get(answerKey(ep.id, p.key)) || null}
                state={progress.states[p.key] || passageState(null, now)}
                canPlay={canPlay}
                listening={listenKey === p.key}
                onListen={onListen}
                onFocus={onFocus}
                onAnswer={onAnswer}
                onAsk={onAsk}
                addState={addState}
                onAdd={onAdd}
                onNeedKey={onNeedKey}
              />
            ))}
          </section>
        );
      })}
      {progress.done && (
        <div style={S.result} data-podcast-result>
          <div>
            <div style={S.resultBig}>{`${progress.understood} of ${progress.total} passages understood`}</div>
            {back && <div style={S.later} data-come-back>{back}</div>}
          </div>
          <button type="button" style={S.resultBtn} onClick={onWords}>Words to learn</button>
        </div>
      )}
    </>
  );
}

// The French with its key phrases picked out, once the passage is answered
// (before, the highlights would give the answer away).
function PassageText({ fr, phrases, lit }) {
  if (!lit) return fr;
  const out = [];
  let at = 0;
  for (const r of phraseRanges(fr, phrases)) {
    if (r.start > at) out.push(fr.slice(at, r.start));
    out.push(<span key={r.start} style={S.kp} data-phrase-highlight>{fr.slice(r.start, r.end)}</span>);
    at = r.end;
  }
  if (at < fr.length) out.push(fr.slice(at));
  return out;
}

function PassageBlock({
  first, user, episodeId, passage, answer, state, canPlay, listening, onListen, onFocus,
  onAnswer, onAsk, addState, onAdd, onNeedKey,
}) {
  const userId = user?.id ?? null;
  const [draft, setDraft] = useState(() => readDraft(userId, episodeId, passage.key));
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState(null);
  const answered = state === "got" || state === "waiting";
  const kind = passage.kind === "translate" ? "translate" : "gist";
  const phrases = Array.isArray(passage.phrases) ? passage.phrases.filter((ph) => ph && ph.fr) : [];

  const edit = (text) => {
    setDraft(text);
    writeDraft(userId, episodeId, passage.key, text);
    if (problem) setProblem(null);
  };
  const check = async () => {
    const typed = draft.trim();
    if (!typed || checking) return;
    if (typed.length > MAX_ANSWER_CHARS) {
      setProblem({ message: `That’s too long to mark. Keep it under ${MAX_ANSWER_CHARS.toLocaleString("en-GB")} characters.` });
      return;
    }
    onFocus?.(passage.key);
    setChecking(true);
    setProblem(null);
    try {
      const { data } = await podcastCall(
        { action: "mark", episodeId, key: passage.key, typed, timeZone: studentTimeZone() },
        { supabase, user }
      );
      const a = data?.answer;
      if (!a || !VERDICT_LABEL[a.verdict]) throw new PodcastError("Claude’s marking didn’t come back. Try again.");
      onAnswer?.({
        id: a.id ?? `local-${episodeId}-${passage.key}-${Date.now()}`,
        episode_id: episodeId,
        passage_key: passage.key,
        kind,
        fr: passage.fr,
        typed,
        verdict: a.verdict,
        feedback: a.feedback || {},
        answered_at: a.answered_at || new Date().toISOString(),
        due_at: a.due_at ?? null,
        _unsaved: data?.saved === false,
      });
      writeDraft(userId, episodeId, passage.key, "");
      setDraft("");
    } catch (e) {
      // The typed answer stays in the box.
      setProblem({ message: e?.message || "Couldn’t mark that. Try again.", code: e?.code || "" });
    } finally {
      setChecking(false);
    }
  };

  const verdict = answered ? answer.verdict : null;
  return (
    <div style={first ? S.qb : { ...S.qb, ...S.qbNext }} data-passage={passage.key} data-passage-state={state} data-passage-kind={kind}>
      {state === "due" && <div style={S.again} data-passage-again>Back for another try</div>}
      <div style={S.instr} data-passage-instruction>{INSTRUCTION[kind]}</div>
      <div style={S.passage} data-passage-fr>
        <PassageText fr={String(passage.fr || "")} phrases={phrases} lit={answered} />
      </div>
      <div style={S.passageTools}>
        {canPlay && listenWindowOk(passage) && (
          <button
            type="button"
            style={listening ? { ...S.listen, ...S.listenOn } : S.listen}
            onClick={() => onListen(passage)}
            data-passage-listen={listening ? "on" : "off"}
            aria-pressed={listening}
          >
            {ICON.speaker}
            <span>{listening ? "Stop" : "Listen"}</span>
          </button>
        )}
        {onAsk && (
          <button type="button" style={S.ask} data-pod-hover="link" data-passage-ask onClick={() => onAsk(passage)}>
            Ask the tutor
          </button>
        )}
      </div>

      {!answered ? (
        <>
          <div style={S.ansRow}>
            <textarea
              style={S.textarea}
              rows={kind === "gist" ? 3 : 2}
              value={draft}
              placeholder="Your answer"
              aria-label="Your answer"
              onChange={(e) => edit(e.target.value)}
              onFocus={() => onFocus?.(passage.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  check();
                }
              }}
              data-passage-answer
            />
            <button
              type="button"
              style={{ ...S.btn, ...(draft.trim() && !checking ? null : S.btnOff) }}
              disabled={!draft.trim() || checking}
              onClick={check}
              data-passage-check
              aria-busy={checking}
            >
              {checking ? "Checking…" : "Check"}
            </button>
          </div>
          {problem && (
            <div style={S.inlineError} role="alert" data-passage-error>
              {problem.message}
              {(problem.code === BYOK_REQUIRED || problem.code === BAD_KEY) && onNeedKey && (
                <button type="button" style={S.errorAction} onClick={onNeedKey}>
                  {problem.code === BAD_KEY ? "Update your key" : "Connect Claude account"}
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={S.mine} data-passage-typed>{answer.typed}</div>
          <div style={S.fb} data-passage-feedback>
            <span style={{ ...S.verdict, ...VERDICT_STYLE[verdict] }} data-passage-verdict={verdict}>{VERDICT_LABEL[verdict]}</span>
            {feedbackSentence(kind, verdict, answer.feedback)}
          </div>
          {answer._unsaved && (
            <div style={S.unsaved} data-passage-unsaved>This answer was marked but not saved, so it won’t be here next time.</div>
          )}
          {passage.answer && (
            <div style={S.model} data-passage-model>
              <b>A good answer:</b> {passage.answer}
            </div>
          )}
          {phrases.length > 0 && (
            <div style={S.kps}>
              {phrases.map((ph) => (
                <div key={ph.fr} style={S.kpr} data-key-phrase={ph.fr}>
                  <span style={S.kpFr}>{ph.fr}</span>
                  <span style={S.kpEn}>{ph.en}</span>
                  <AddButton phrase={ph} episodeId={episodeId} addState={addState} onAdd={onAdd} onNeedKey={onNeedKey} small />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const listenWindowOk = (passage) => !!listenWindow(passage, Infinity);

// ── Add to my cards ────────────────────────────────────────────────────────
// Its label is the whole answer (owner, 2026-10-09):
//   Add to my cards                    not in the deck yet
//   Added ✓                            added just now
//   In your deck                       the student has this card already
//   You removed this card earlier      it is theirs, out of study by their
//                                      choice, and stays out
//   Couldn’t check this one. Try again.  the same-card question couldn't be
//                                      asked, so nothing was added on a guess
const ADD_LABEL = {
  add: "Add to my cards",
  adding: "Adding…",
  added: "Added ✓",
  have: "In your deck",
  removed: "You removed this card earlier",
  waiting: "Couldn’t check this one. Try again.",
  error: "Add to my cards",
};

function AddButton({ phrase, episodeId, addState, onAdd, onNeedKey, small }) {
  const st = addState(phrase) || { state: "add" };
  const state = ADD_LABEL[st.state] ? st.state : "add";
  const done = state === "added" || state === "have";
  const off = done || state === "removed" || state === "adding";
  const style = {
    ...S.add,
    ...(small ? S.addSmall : null),
    ...(done ? S.addDone : state === "removed" ? S.addRemoved : null),
  };
  return (
    <span style={S.addWrap}>
      <button
        type="button"
        style={style}
        data-pod-hover="add"
        disabled={off}
        onClick={() => onAdd(phrase, episodeId)}
        data-add-to-cards={state}
      >
        {ADD_LABEL[state]}
      </button>
      {state === "error" && (
        <span style={S.addError} role="alert">
          {st.message}
          {(st.code === BYOK_REQUIRED || st.code === BAD_KEY) && onNeedKey && (
            <button type="button" style={S.errorAction} onClick={onNeedKey}>
              {st.code === BAD_KEY ? "Update your key" : "Connect Claude account"}
            </button>
          )}
        </span>
      )}
    </span>
  );
}

// ── Transcript ─────────────────────────────────────────────────────────────
function TranscriptTab({ sections, nowStory, canPlay, onSeek }) {
  if (!sections.length) return <p style={S.empty}>RFI hasn’t published a transcript for this episode.</p>;
  return (
    <div data-transcript>
      {sections.map((sec, i) => (
        <div
          key={`${sec.story ?? "x"}-${i}`}
          style={{ ...S.trSec, ...(i > 0 ? S.trSecNext : null), ...(sec.story != null && sec.story === nowStory ? S.trSecNow : null) }}
          data-transcript-section={sec.story ?? ""}
        >
          {sec.t != null && <TimeChip t={sec.t} onSeek={onSeek} disabled={!canPlay} />}
          <div style={S.trBody}>
            {sec.title && <h4 style={S.trTitle}>{sec.title}</h4>}
            {sec.paragraphs.map((p) => (
              <p key={p.index} style={S.trPara}>{p.text}</p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Words to learn ─────────────────────────────────────────────────────────
// Every key phrase of the episode's passages, once each, answered or not:
// this is the list to pick cards from.
function WordsTab({ passages, episodeId, addState, onAdd, onNeedKey }) {
  const seen = new Set();
  const words = [];
  for (const p of passages) {
    for (const ph of Array.isArray(p.phrases) ? p.phrases : []) {
      const k = String(ph?.fr || "").trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      words.push(ph);
    }
  }
  if (!words.length) return <p style={S.empty}>No words picked out for this episode.</p>;
  return (
    <div data-words>
      {words.map((ph) => (
        <div key={ph.fr} style={S.word} data-word={ph.fr}>
          <div>
            <div style={S.wordFr}>{ph.fr}</div>
            <div style={S.wordEn}>{ph.en}</div>
          </div>
          <AddButton phrase={ph} episodeId={episodeId} addState={addState} onAdd={onAdd} onNeedKey={onNeedKey} />
        </div>
      ))}
    </div>
  );
}

// ── Icons (Lucide-style, as the sidebar's) ─────────────────────────────────
const ICON = {
  back: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3 5 8l5 5" />
    </svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l10.5-6.5z" />
    </svg>
  ),
  pause: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z" />
    </svg>
  ),
  playSm: (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 4v16l14-8z" />
    </svg>
  ),
  speaker: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  ),
};

// ── Styles ─────────────────────────────────────────────────────────────────
// The approved mockup's values (.claude/mockups/podcasts.html), on the theme's
// tokens. Two colours the theme has no token for come from the mockup: the
// green of "understood" and "Added ✓", and the amber of "Partly".
const LINE = "rgba(3,22,50,0.07)";
const OK_INK = "#2f6f5e";
const OK_BG = "#e3efe9";
const PART_INK = "#8a5a00";
const PART_BG = "#fbe9d0";

const TONE = {
  none: {},
  part: { color: T.color.secondary, fontWeight: 600 },
  due: { color: T.color.secondary, fontWeight: 700 },
  done: { color: OK_INK, fontWeight: 700 },
};

const VERDICT_STYLE = {
  got: { background: OK_BG, color: OK_INK },
  partly: { background: PART_BG, color: PART_INK },
  missed: { background: T.color.errorContainer, color: T.color.onErrorContainer },
};

// Hover and focus, which inline styles can't say. Keyed on this file's own
// data-pod-hover markers; !important because the inline style is the base.
const HOVER_CSS = `
[data-pod-hover="row"]:hover { border-color: rgba(3,22,50,0.2) !important; box-shadow: ${T.shadow.focus} !important; }
[data-pod-hover="chip"]:not(:disabled):hover { background: ${T.color.surfaceLow} !important; border-color: rgba(3,22,50,0.18) !important; }
[data-pod-hover="add"]:not(:disabled):hover { background: ${T.color.surfaceLow} !important; border-color: rgba(3,22,50,0.3) !important; }
[data-pod-hover="tab"][aria-selected="false"]:hover { color: ${T.color.primary} !important; }
[data-pod-hover="back"]:hover { background: ${T.color.surfaceLowest} !important; }
[data-pod-hover="link"]:hover { color: ${T.color.primary} !important; }
[data-passage-answer]:focus { border-color: rgba(3,22,50,0.35) !important; }
[data-spotify-link]::placeholder, [data-passage-answer]::placeholder { color: rgba(68,71,77,0.6); }
`;

const S = {
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", boxSizing: "border-box" },
  page: { maxWidth: 720, marginTop: 0, marginRight: "auto", marginBottom: 0, marginLeft: "auto", paddingTop: 36, paddingRight: 32, paddingBottom: 90, paddingLeft: 32, boxSizing: "border-box", fontFamily: T.font.sans, color: T.color.onSurface },

  h1: { fontFamily: T.font.serif, fontWeight: 600, fontSize: 30, color: T.color.primary, letterSpacing: "-0.02em", margin: "0 0 20px", lineHeight: 1.2 },
  h1Long: { fontSize: 24, lineHeight: 1.3 },
  byline: { fontSize: 13, color: T.color.onSurfaceVariant, margin: "-12px 0 20px" },
  empty: { padding: "24px 0", margin: 0, fontSize: 13.5, color: T.color.onSurfaceVariant, lineHeight: 1.5 },
  notice: { margin: 0, padding: "16px 18px", background: T.color.surfaceLowest, border: `1px solid ${LINE}`, borderRadius: T.radius.xl, fontSize: 14, lineHeight: 1.55, color: T.color.primary },
  error: { margin: "10px 0 0", fontSize: 13, color: T.color.error, lineHeight: 1.5 },

  btn: { padding: "10px 18px", border: "none", borderRadius: T.radius.md, background: T.gradient.ink, color: T.color.onPrimary, fontFamily: T.font.sans, fontWeight: 700, fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap", opacity: 1 },
  btnOff: { opacity: 0.35, cursor: "default" },
  ghostBtn: { padding: "9px 16px", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(3,22,50,0.15)", borderRadius: T.radius.md, background: "transparent", color: T.color.primary, fontFamily: T.font.sans, fontWeight: 700, fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap" },

  // Episode rows
  group: { marginBottom: 8 },
  groupHeading: { margin: "0 0 10px", fontFamily: T.font.sans, fontSize: 13, fontWeight: 700, color: T.color.secondary },
  groupRest: { marginTop: 22 },
  ep: { display: "flex", gap: 16, width: "100%", padding: "16px 18px", background: T.color.surfaceLowest, borderWidth: 1, borderStyle: "solid", borderColor: LINE, borderRadius: T.radius.xl, marginBottom: 10, cursor: "pointer", textAlign: "left", fontFamily: T.font.sans, boxShadow: "none", transition: "border-color .15s, box-shadow .15s", boxSizing: "border-box" },
  epDate: { width: 76, flexShrink: 0, fontSize: 12, fontWeight: 700, color: T.color.primary, paddingTop: 2, whiteSpace: "nowrap" },
  epMain: { display: "block", flex: 1, minWidth: 0 },
  epPod: { display: "block", fontSize: 11.5, fontWeight: 700, color: T.color.secondary, marginBottom: 3 },
  epTitle: { display: "block", fontFamily: T.font.serif, fontSize: 14.5, color: T.color.primary, lineHeight: 1.45 },
  epStatus: { display: "block", marginTop: 6, fontSize: 12, color: T.color.onSurfaceVariant },

  // My podcasts
  pods: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 },
  pod: { display: "block", padding: "18px 20px", background: T.color.surfaceLowest, borderWidth: 1, borderStyle: "solid", borderColor: LINE, borderRadius: T.radius.xl, cursor: "pointer", textAlign: "left", fontFamily: T.font.sans, boxShadow: "none", transition: "border-color .15s, box-shadow .15s" },
  podName: { display: "block", fontFamily: T.font.serif, fontSize: 16, fontWeight: 700, color: T.color.primary, lineHeight: 1.3 },
  podBy: { display: "block", fontSize: 12, color: T.color.onSurfaceVariant, marginTop: 4 },
  podDone: { display: "block", fontSize: 12, color: OK_INK, fontWeight: 700, marginTop: 12 },
  paste: { display: "flex", gap: 8, margin: 0 },
  pasteInput: { flex: 1, minWidth: 0, padding: "10px 14px", border: "none", borderRadius: T.radius.lg, background: T.color.surfaceLowest, boxShadow: T.shadow.focus, fontFamily: T.font.sans, fontSize: 13, color: T.color.primary, outline: "none" },

  // Episode page
  back: { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px 6px 11px", marginBottom: 18, background: "transparent", borderWidth: 1, borderStyle: "solid", borderColor: LINE, borderRadius: T.radius.full, cursor: "pointer", fontFamily: T.font.sans, fontSize: 11.5, color: T.color.onSurface, fontWeight: 700, letterSpacing: "0.01em" },
  pwrap: { position: "sticky", top: 0, zIndex: 5, paddingTop: 12, margin: "-12px 0 22px", background: T.color.background },
  player: { display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: T.color.surfaceLowest, borderRadius: T.radius.xl, boxShadow: "0 8px 32px rgba(3,22,50,0.08)" },
  pbtn: { width: 40, height: 40, flexShrink: 0, border: "none", borderRadius: "50%", background: T.gradient.ink, color: T.color.onPrimary, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 },
  pmid: { flex: 1, minWidth: 0 },
  pnow: { fontSize: 12, fontWeight: 600, color: T.color.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 0, minHeight: 16 },
  trackHit: { paddingTop: 8, paddingBottom: 8, cursor: "pointer" },
  track: { position: "relative", height: 6, background: T.color.surfaceHigh, borderRadius: 3 },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, background: T.color.secondary, borderRadius: 3, pointerEvents: "none" },
  tick: { position: "absolute", top: -4, width: 2, height: 14, marginLeft: -1, background: "rgba(3,22,50,0.22)", borderRadius: 1, pointerEvents: "none" },
  ptime: { width: 78, flexShrink: 0, textAlign: "right", fontSize: 12, color: T.color.onSurfaceVariant, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  speed: { flexShrink: 0, padding: "4px 9px", borderWidth: 1, borderStyle: "solid", borderColor: T.color.outlineGhost, borderRadius: T.radius.full, background: "transparent", fontFamily: T.font.sans, fontSize: 11, fontWeight: 700, color: T.color.onSurfaceVariant, cursor: "pointer", fontVariantNumeric: "tabular-nums" },
  audioError: { marginTop: 2, fontSize: 11.5, color: T.color.error },

  tabs: { display: "flex", gap: 26, borderBottom: `1px solid ${LINE}`, marginBottom: 18 },
  // Both tab styles declare the same longhands, so React never strands one
  // side of a border when a tab is selected and then isn't (the 24b55b7
  // sidebar bug, 2026-10-06).
  tab: { padding: "10px 0", borderTopWidth: 0, borderRightWidth: 0, borderLeftWidth: 0, borderBottomWidth: 2, borderBottomStyle: "solid", borderBottomColor: "transparent", marginBottom: -1, background: "transparent", cursor: "pointer", fontFamily: T.font.sans, fontSize: 13, fontWeight: 600, color: T.color.onSurfaceVariant },
  tabOn: { borderBottomColor: T.color.secondary, color: T.color.secondary },

  count: { fontSize: 12, color: T.color.onSurfaceVariant, fontWeight: 400, margin: "0 0 12px", fontVariantNumeric: "tabular-nums" },
  countDone: { color: OK_INK, fontWeight: 700 },

  story: { padding: "18px 20px", background: T.color.surfaceLowest, borderWidth: 1, borderStyle: "solid", borderColor: LINE, borderRadius: T.radius.xl, marginBottom: 12, transition: "border-color .2s" },
  storyNow: { borderColor: "rgba(156,66,52,0.5)" },
  storyHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  storyTitle: { fontFamily: T.font.serif, fontSize: 15, fontWeight: 600, color: T.color.primary, lineHeight: 1.35 },
  at: { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, padding: "4px 10px 4px 8px", borderWidth: 1, borderStyle: "solid", borderColor: T.color.outlineGhost, borderRadius: T.radius.full, background: "transparent", fontFamily: T.font.sans, fontSize: 11, fontWeight: 700, color: T.color.primary, cursor: "pointer", fontVariantNumeric: "tabular-nums" },

  qb: { marginTop: 0, paddingTop: 0, borderTopWidth: 0, borderTopStyle: "solid", borderTopColor: LINE },
  qbNext: { marginTop: 18, paddingTop: 16, borderTopWidth: 1 },
  again: { marginBottom: 8, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em", color: T.color.secondary },
  instr: { fontSize: 13.5, fontWeight: 700, color: T.color.onSurface, margin: "0 0 10px" },
  passage: { padding: "14px 16px", background: T.color.surfaceLow, borderRadius: T.radius.lg, fontFamily: T.font.serif, fontSize: 16, lineHeight: 1.65, color: T.color.primary },
  kp: { background: "rgba(156,66,52,0.14)", borderRadius: 3, padding: "0 2px" },
  passageTools: { display: "flex", alignItems: "center", gap: 12, marginTop: 10 },
  listen: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px 5px 10px", borderWidth: 1, borderStyle: "solid", borderColor: T.color.outlineGhost, borderRadius: T.radius.full, background: T.color.surfaceLowest, fontFamily: T.font.sans, fontSize: 11.5, fontWeight: 700, color: T.color.primary, cursor: "pointer" },
  listenOn: { background: T.color.primary, borderColor: T.color.primary, color: T.color.onPrimary },
  ask: { padding: 0, border: "none", background: "transparent", fontFamily: T.font.sans, fontSize: 11.5, fontWeight: 600, color: T.color.onSurfaceVariant, cursor: "pointer", textDecoration: "underline", textDecorationColor: "rgba(3,22,50,0.25)", textUnderlineOffset: 2 },
  ansRow: { display: "flex", gap: 10, marginTop: 12, alignItems: "flex-end" },
  textarea: { flex: 1, minWidth: 0, resize: "vertical", padding: "10px 12px", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(3,22,50,0.14)", borderRadius: T.radius.lg, background: T.color.surfaceLowest, fontFamily: T.font.sans, fontSize: 14, lineHeight: 1.5, color: T.color.onSurface, outline: "none", boxSizing: "border-box" },
  inlineError: { marginTop: 8, fontSize: 12.5, color: T.color.error, lineHeight: 1.5 },
  errorAction: { marginLeft: 8, padding: "4px 10px", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(3,22,50,0.2)", borderRadius: T.radius.md, background: T.color.surfaceLowest, color: T.color.primary, fontFamily: T.font.sans, fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  mine: { marginTop: 12, paddingLeft: 12, borderLeft: `3px solid ${T.color.surfaceHigh}`, fontSize: 14, lineHeight: 1.5, color: T.color.onSurface, fontStyle: "italic", whiteSpace: "pre-wrap" },
  fb: { marginTop: 12, fontSize: 13.5, lineHeight: 1.6, color: T.color.onSurface },
  verdict: { display: "inline-block", padding: "2px 10px", marginRight: 8, borderRadius: T.radius.full, fontSize: 11.5, fontWeight: 800 },
  unsaved: { marginTop: 6, fontSize: 12, color: T.color.onSurfaceVariant },
  model: { marginTop: 10, padding: "12px 14px", background: T.color.surfaceLowest, border: `1px solid ${LINE}`, borderRadius: T.radius.lg, fontSize: 14, lineHeight: 1.55, color: T.color.primary },
  kps: { display: "flex", flexDirection: "column", gap: 6, marginTop: 10 },
  kpr: { display: "flex", alignItems: "center", gap: 10 },
  kpFr: { fontFamily: T.font.serif, fontSize: 14.5, fontWeight: 700, color: T.color.primary },
  kpEn: { fontSize: 12.5, color: T.color.onSurfaceVariant },

  addWrap: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 },
  add: { flexShrink: 0, padding: "8px 14px", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(3,22,50,0.15)", borderRadius: T.radius.md, background: "transparent", fontFamily: T.font.sans, fontSize: 12, fontWeight: 700, color: T.color.primary, cursor: "pointer", whiteSpace: "nowrap" },
  addSmall: { padding: "6px 12px", fontSize: 11.5 },
  addDone: { background: OK_BG, borderColor: "transparent", color: OK_INK, cursor: "default" },
  addRemoved: { background: T.color.surfaceLow, borderColor: "transparent", color: T.color.onSurfaceVariant, cursor: "default" },
  addError: { fontSize: 11.5, color: T.color.error, maxWidth: 240 },

  result: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "20px 22px", background: T.color.primaryContainer, borderRadius: T.radius.xl, marginTop: 4 },
  resultBig: { fontFamily: T.font.serif, fontSize: 21, fontWeight: 600, color: T.color.background },
  later: { marginTop: 6, fontSize: 12.5, color: "rgba(253,248,246,0.78)" },
  resultBtn: { padding: "10px 16px", border: "none", borderRadius: T.radius.md, background: T.color.background, color: T.color.primary, fontFamily: T.font.sans, fontWeight: 700, fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap" },

  problem: { padding: "18px 20px", background: T.color.surfaceLowest, border: `1px solid ${LINE}`, borderRadius: T.radius.xl },
  problemText: { margin: "0 0 12px", fontSize: 14, lineHeight: 1.55, color: T.color.primary },
  problemActions: { display: "flex", gap: 10, flexWrap: "wrap" },

  // Transcript
  trSec: { display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 12px", margin: "0 -12px", borderRadius: T.radius.lg, borderTopWidth: 0, borderTopStyle: "solid", borderTopColor: LINE, background: "transparent", transition: "background .2s" },
  trSecNext: { borderTopWidth: 1 },
  trSecNow: { background: "rgba(156,66,52,0.06)" },
  trBody: { flex: 1, minWidth: 0 },
  trTitle: { fontFamily: T.font.serif, fontSize: 14.5, fontWeight: 600, color: T.color.primary, margin: "2px 0 6px" },
  trPara: { fontFamily: T.font.serif, fontSize: 15, lineHeight: 1.7, color: T.color.onSurface, margin: "0 0 10px" },

  // Words to learn
  word: { display: "flex", alignItems: "center", gap: 16, padding: "14px 18px", background: T.color.surfaceLowest, border: `1px solid ${LINE}`, borderRadius: T.radius.xl, marginBottom: 8 },
  wordFr: { fontFamily: T.font.serif, fontSize: 16, fontWeight: 700, color: T.color.primary },
  wordEn: { fontSize: 13, color: T.color.onSurfaceVariant, marginTop: 2 },
};
