// The Podcasts module's server work (2026-10-09): following a podcast,
// reading its feed, opening an episode (its transcript, and its questions,
// written once by Claude for everyone), marking an answer, and adding a word
// from a passage to the student's cards.
//
// Reached through /api/podcasts (api/podcasts.js) with { action, ... },
// because Vercel's Hobby plan deploys at most 12 routes and this is the
// eleventh. The route only checks who is asking; everything else is here,
// with the store, the fetch of RFI and Spotify, and Claude's same-card
// question passed in, so tests/suites/podcast-marking.mjs can run it with no
// database and nothing leaving the machine.
//
//   follow    { link } a Spotify link to an episode or a show, or { slug }
//             -> { podcast, episodeId? }
//   refresh   {} -> { ok, count }: the followed podcasts' feeds read again
//   episode   { episodeId } -> { episode }, or 202 { status: "preparing" }
//   mark      { episodeId, key, typed, timeZone } -> { answer, saved }
//   add-card  { episodeId, front, back } -> { added, have, removed, waiting }
//
// THE OWNER ONLY, until the owner has tested it (2026-10-09). Every action
// answers 403 "Admin only" to anyone else, here and in the route. The
// client's switch is hidden from students too, but the client's admin check
// reads a public address and only hides things.
//
// WHO PAYS. Only three things call Claude: writing an episode's questions
// (the first time anyone opens it), marking an answer, and the same-card
// question when a word to add looks like one the student has. Only those ask
// for the key that pays (`apiKey`, resolved the way every route resolves it,
// api/_lib/anthropicKey.js), so following a podcast or opening an episode
// whose questions exist costs nothing and needs no key.
//
// THE QUESTIONS ARE WRITTEN ONCE. podcast_episodes is shared by every
// student. The first open of an episode takes a lease on it
// (questions_lease_until, three minutes), asks Claude, checks and saves the
// set, and gives the lease back; anyone opening it meanwhile gets 202
// "preparing" and the page asks again every few seconds. Without the lease,
// two students opening a new episode together would both pay, and could
// see different questions. If Claude fails, a short code for the failure is
// saved on the row ("busy:429", never Claude's own message, since every
// signed-in student can read the row), the lease is given back, and the next
// open tries again.
//
// A PASSAGE'S KEY is its story and a hash of its French, so it stays the same
// if the questions are ever written again, and a student's old answer can
// never be shown against a different passage (podcast_answers.passage_key).
//
// MARKING. Claude says which of the passage's ideas the answer holds
// (api/_lib/podcastQuestions.js). The answer is saved for that student only,
// with the model and prompt version, and a passage not fully understood comes
// back RETRY_DAYS later (owner, 2026-10-09: "missed or partly-right passages
// come back after 3 days"). A failed save still gives the student Claude's
// verdict, saying it wasn't saved.
//
// ADDING A CARD never touches anything the student has (owner's rule:
// updates never reset progress). The word goes through the rule every
// card-writer uses (src/lib/cardMatch.js): a card they already have, in
// study or not, means nothing is added ("In your deck"); one they removed
// stays removed ("You removed this card earlier"; whether an explicit Add
// should bring a removed card back is the owner's decision, not made yet);
// a near look-alike is put to Claude, and if that question can't be answered
// nothing is added on a guess ("Couldn’t check this one. Try again."). A new
// card is inserted with ignoreDuplicates, never upserted over a row, with no
// class dates (a date on a card counts as a class already read,
// src/lib/notesLines.js) and the source "podcast:<episode id>", which
// src/lib/sessionQueue.js's addedByStudent dates by the day it was added, as
// a tutor card is. No schedule column is written: the card starts New, both
// ways round.
//
// BEFORE migration_017 none of the podcast tables exist. Every action says so
// plainly (503, code "not_set_up"), and nothing on the Flashcards side is
// touched.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { missingTable } from "../../src/lib/dealLog.js";
import { isArchived } from "../../src/lib/archive.js";
import { matchNewCards, plannedWrites } from "../../src/lib/cardMatch.js";
import { PODCASTS, podcastBySlug, RETRY_DAYS, MAX_PASSAGES } from "../../src/lib/podcastCatalogue.js";
import { estimatePassageTimes, findPassage, normalizePassage } from "../../src/lib/podcastTiming.js";
import {
  fetchText as fetchFromWeb, parseFeed, parseEpisodePage, parseSpotifyLink, spotifyTitle, matchTitle,
} from "./podcastSource.js";
import {
  askQuestions, askMark, readMark, dropRepeatedAnswer, UnreadableReply,
  QUESTIONS_MODEL, QUESTIONS_VERSION, MARK_MODEL, MARK_VERSION, MIN_PASSAGES, KINDS, IDEAS, PHRASES,
} from "./podcastQuestions.js";
import { readDeck } from "./notesReading.js";
import { askSameCard } from "./sameCardQuestion.js";
import { cleanFrenchFront } from "../parse-cahier.js";

const DAY_MS = 86400000;
// How long one request may hold an episode while Claude writes its questions:
// longer than the call's own limit (QUESTIONS_TIME_MS, 150 s), so a lease
// never runs out under a call still going, and short enough that a request
// that died doesn't hold the episode for long.
export const LEASE_MS = 3 * 60 * 1000;
// A page read that found no transcript is not read again for this long: RFI
// often publishes the transcript a little after the episode.
export const PAGE_RETRY_MS = 15 * 60 * 1000;
// How long the same-card question may take when adding a card.
export const SAME_CARD_TIME_MS = 60 * 1000;
export const MAX_TYPED = 2000;
const MAX_FRONT = 200;
const MAX_BACK = 300;

// The student-facing sentences, in one place (plain, short, British).
export const MESSAGES = Object.freeze({
  notSetUp: "Podcasts need a database update first: run migrations/migration_017_podcasts.sql in Supabase.",
  adminOnly: "Admin only",
  badLink: "That doesn’t look like a Spotify link.",
  notRfi: "Only RFI’s learner podcasts can be added for now, such as Journal en français facile.",
  spotifyDown: "Couldn’t read that link on Spotify. Check it and try again.",
  rfiDown: "Couldn’t reach RFI just now. Try again in a minute.",
  noEpisode: "That episode isn’t in your podcasts.",
  noTranscript: "RFI hasn’t published a transcript for this episode.",
  noPassage: "That passage isn’t in this episode’s questions any more. Open the episode again.",
  emptyAnswer: "Type your answer first.",
  longAnswer: "That answer is too long. Keep it under 2,000 characters.",
  badCard: "A card needs its French and its English.",
  longCard: "That card is too long to add.",
  badQuestions: "Claude’s questions for this episode didn’t check out. Try again.",
  unknownAction: "Unknown action.",
});

const reply = (status, json) => ({ status, json });
const notSetUp = () => reply(503, { error: MESSAGES.notSetUp, code: "not_set_up" });

// What went wrong with a call to Claude, said plainly (as api/chat.js does).
// The raw API message goes to the log, never to the student.
export function claudeError(err, what) {
  if (err instanceof Anthropic.AuthenticationError) {
    return reply(401, { error: "Anthropic rejected that API key. Check it in your profile menu.", code: "bad_key" });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return reply(429, { error: "Claude is busy. Try again in a minute.", code: "busy" });
  }
  if (err instanceof Anthropic.APIError && err.status === 529) {
    return reply(503, { error: "Claude is overloaded right now. Give it a minute and try again.", code: "overloaded" });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError ||
      err?.name === "TimeoutError" || err?.name === "AbortError") {
    return reply(504, { error: `Claude took too long to ${what}. Try again.`, code: "timeout" });
  }
  if (err instanceof UnreadableReply) {
    return reply(502, { error: `Claude’s reply couldn’t be used when it tried to ${what}. Try again.`, code: "unreadable" });
  }
  if (err instanceof Anthropic.APIError) {
    return reply(502, { error: `Claude couldn’t ${what} (error ${err.status ?? "unknown"}). Try again.`, code: "claude_failed" });
  }
  return reply(502, { error: `Claude couldn’t ${what}. Try again.`, code: "claude_failed" });
}

// What is saved on the episode when its questions couldn't be written
// (podcast_episodes.questions_error): the failure's code, with the HTTP status
// when Anthropic answered with one ("busy:429", "claude_failed:500",
// "unreadable", "timeout"). Never the error's own message: the SDK builds that
// from Anthropic's raw reply, which can name the owner's organisation, its
// rate limits or its billing, and every signed-in student can read this row
// (migration_017). The full message goes to the server's log only.
function failureCode(err, failed) {
  const code = typeof failed?.json?.code === "string" ? failed.json.code : "claude_failed";
  return err instanceof Anthropic.APIError && Number.isInteger(err.status) ? `${code}:${err.status}` : code;
}

// The key that pays, only when an action is about to call Claude. `apiKey` is
// a key, null (no key: refused as the route would), or a function returning
// what resolveAnthropicKey returns ({ key } or { error, code, status }).
function keyFrom(apiKey) {
  const r = typeof apiKey === "function" ? apiKey() : apiKey ? { key: apiKey } : null;
  if (r?.key) return { key: r.key };
  return {
    error: r?.error || "Connect your own Claude account to use this. Add an Anthropic API key in your profile menu.",
    code: r?.code || "byok_required",
    status: r?.status || 402,
  };
}

const iso = (ms) => new Date(ms).toISOString();
// api/_lib/podcastSource.js's failures are plain sentences with a `code`
// ("Spotify couldn’t find that episode or show."); anything else (a bug, a
// raw library error) is replaced with our own sentence.
const plainFrom = (e, fallback) => (e?.code && typeof e.message === "string" && e.message ? e.message : fallback);
const text = (v) => (typeof v === "string" ? v : "");
const uuidish = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;

// ── The questions: checked, keyed and timed ─────────────────────────────

// A passage's key: its story (or "x") and the first eight hex characters of
// the sha1 of its French, normalised the way the transcript check compares.
export const passageKey = (story, fr) =>
  `s${Number.isInteger(story) && story >= 0 ? story : "x"}-${createHash("sha1").update(normalizePassage(fr)).digest("hex").slice(0, 8)}`;

// Claude's first paragraph for each story, kept only when there is one per
// story, in order, inside the transcript.
function validStarts(starts, storyCount, paragraphCount) {
  if (!Array.isArray(starts) || !storyCount || starts.length !== storyCount) return null;
  for (let i = 0; i < starts.length; i++) {
    const p = starts[i];
    if (!Number.isInteger(p) || p < 0 || p >= paragraphCount) return null;
    if (i && p < starts[i - 1]) return null;
  }
  return starts;
}

// The story a passage is in: Claude's number when the passage's paragraph is
// inside that story, else the story whose paragraphs hold it, else Claude's
// number if it names a story, else none.
function storyOf(paragraph, claimed, starts, storyCount) {
  const okClaim = Number.isInteger(claimed) && claimed >= 0 && claimed < storyCount ? claimed : null;
  if (!starts) return okClaim;
  const end = (s) => (s + 1 < starts.length ? starts[s + 1] : Infinity);
  if (okClaim !== null && paragraph >= starts[okClaim] && paragraph < end(okClaim)) return okClaim;
  let s = null;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= paragraph) s = i;
  return s;
}

const noFullStop = (s) => s.replace(/(?<!\.)\.\s*$/, "").trim();
const clean = (s) => text(s).replace(/\s+/g, " ").trim();
const isHeadlines = (story) => /^\s*les\s+titres\s*$/i.test(text(story?.title));
// The French as a card's front: an English gloss in brackets taken off (the
// notes reader's rule, api/parse-cahier.js), curly apostrophes made straight
// as the notes cards have them, and no full stop at the end (a "?" or "!"
// stays). The English loses a final full stop too.
const cardFront = (front, back) => noFullStop(clean(cleanFrenchFront(front, back)).replace(/[’‘ʼ]/g, "'"));
const cardBack = (back) => noFullStop(clean(back));

// A gist idea is shown in a sentence ("You caught that X and that Y."), so it
// always starts with "that" and has no full stop.
const ideaOf = (kind, idea) => {
  const i = noFullStop(clean(idea));
  if (!i || kind !== "gist") return i;
  return /^that\b/i.test(i) ? i.replace(/^that\b/i, "that") : `that ${i}`;
};

// Where `words` sit in `fr`, as `fr` writes them: exactly, then after the
// transcript's normalising, then ignoring case. Null when not there.
function inPassage(fr, words) {
  const w = clean(words);
  if (!w) return null;
  if (fr.includes(w)) return w;
  const nf = normalizePassage(fr);
  const nw = normalizePassage(w);
  let at = nf.indexOf(nw);
  if (at < 0) at = nf.toLowerCase().indexOf(nw.toLowerCase());
  if (at < 0) return null;
  // normalizePassage only changes the length of whitespace runs, and RFI's
  // paragraphs have none, so the offsets carry over when the lengths agree.
  return nf.length === fr.length ? fr.slice(at, at + nw.length) : nf.slice(at, at + nw.length);
}

// Claude's set for one episode, kept only as far as it checks out:
//   - a passage must be word for word in one paragraph of the transcript
//     (whitespace and apostrophes aside), and is stored as RFI wrote it;
//   - it needs a kind, a good answer and at least one idea;
//   - none from the headlines;
//   - each gets its key and its start and end in the recording;
//   - in the order of the episode, no passage twice, and never more than
//     MAX_PASSAGES (a story's second passage goes first).
// Returns { passages, storyStarts, dropped }.
export function checkQuestions(raw, { paragraphs = [], stories = [], duration = null } = {}) {
  const storyCount = stories.length;
  const starts = validStarts(raw?.storyStarts, storyCount, paragraphs.length);
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const p of Array.isArray(raw?.passages) ? raw.passages : []) {
    const kind = KINDS.includes(p?.kind) ? p.kind : null;
    const answer = clean(p?.answer);
    const ideas = [...new Set((Array.isArray(p?.ideas) ? p.ideas : []).map((i) => ideaOf(kind, i)).filter(Boolean))].slice(0, IDEAS[kind]?.max ?? 0);
    const claimed = Number.isInteger(p?.story) ? p.story : null;
    const prefer = starts && claimed !== null && claimed >= 0 && claimed < storyCount
      ? [starts[claimed], claimed + 1 < starts.length ? starts[claimed + 1] : paragraphs.length]
      : null;
    const found = kind && answer && ideas.length ? findPassage(paragraphs, text(p?.fr), prefer) : null;
    if (!found) { dropped++; continue; }
    // As RFI wrote it, when the paragraph's offsets line up with the
    // normalised text (they do: the page reader collapses whitespace).
    const para = String(paragraphs[found.paragraph] ?? "");
    const normal = normalizePassage(para);
    const fr = normal.length === para.length
      ? para.slice(found.offset, found.offset + found.length)
      : normal.slice(found.offset, found.offset + found.length);
    const story = storyOf(found.paragraph, claimed, starts, storyCount);
    if (story !== null && isHeadlines(stories[story])) { dropped++; continue; }
    const key = passageKey(story, fr);
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    const phrases = [];
    for (const ph of Array.isArray(p?.phrases) ? p.phrases : []) {
      // The French exactly as "Add to my cards" will write it, so the page's
      // "In your deck" check before any click compares like with like.
      const pfr = cardFront(clean(ph?.fr), clean(ph?.en));
      const pen = noFullStop(clean(ph?.en));
      if (!pfr || !pen || phrases.some((x) => x.fr === pfr)) continue;
      phrases.push({ fr: pfr, en: pen, inText: inPassage(fr, ph?.inText) ?? inPassage(fr, pfr) });
      if (phrases.length >= PHRASES.max) break;
    }
    const { start, end } = estimatePassageTimes({
      paragraphs, stories, storyStarts: starts || [], duration, passage: { story, fr },
    });
    out.push({ key, story, kind, fr, start, end, answer, ideas, phrases, _at: [found.paragraph, found.offset] });
  }
  out.sort((a, b) => a._at[0] - b._at[0] || a._at[1] - b._at[1]);
  // Over the cap: a story's later passage goes first, from the end; then
  // simply the last.
  while (out.length > MAX_PASSAGES) {
    const count = new Map();
    for (const q of out) count.set(q.story, (count.get(q.story) || 0) + 1);
    let i = out.length - 1;
    while (i >= 0 && !(out[i].story !== null && count.get(out[i].story) > 1)) i--;
    out.splice(i >= 0 ? i : out.length - 1, 1);
    dropped++;
  }
  for (const q of out) delete q._at;
  return { passages: out, storyStarts: starts || [], dropped };
}

const longDate = (published) => {
  const t = Date.parse(published || "");
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris",
  });
};

// The episode as the page gets it.
const episodeJson = (row) => ({
  id: row.id,
  podcast: row.podcast,
  title: row.title,
  published_at: row.published_at ?? null,
  audio_url: row.audio_url ?? null,
  duration_seconds: row.duration_seconds ?? null,
  transcript: row.transcript ?? null,
  stories: Array.isArray(row.stories) ? row.stories : [],
  questions: row.questions ?? null,
});

// ── Feeds ────────────────────────────────────────────────────────────────

// One podcast's feed, read and saved: episode rows with the feed's own
// columns only, so a transcript or questions already saved are never blanked.
async function readFeed(slug, { store, fetchText, now }) {
  const podcast = podcastBySlug(slug);
  if (!podcast) return { items: [], rows: [] };
  const feed = parseFeed(await fetchText(podcast.feed));
  return saveFeed(slug, feed, { store, now });
}

async function saveFeed(slug, feed, { store, now }) {
  const items = (feed?.items || []).filter((it) => it?.guid && it?.title);
  if (!items.length) return { items, rows: [] };
  const saved = await store.saveFeed(slug, items.map((it) => ({
    podcast: slug,
    guid: String(it.guid),
    title: String(it.title),
    published_at: it.published_at ?? null,
    page_url: it.page_url ?? null,
    audio_url: it.audio_url ?? null,
    duration_seconds: Number.isFinite(it.duration_seconds) ? Math.round(it.duration_seconds) : null,
    updated_at: iso(now),
  })));
  if (saved.missing) return { missing: true };
  return { items, rows: saved.rows || [] };
}

// ── The handler ──────────────────────────────────────────────────────────

export async function handlePodcastRequest({
  body, user, isAdmin, store, apiKey = null, now = Date.now(), fetchText = fetchFromWeb, ask = null,
}) {
  if (!isAdmin) return reply(403, { error: MESSAGES.adminOnly });
  const action = body?.action;
  const deps = { body: body || {}, user, store, apiKey, now, fetchText, ask };
  if (action === "follow") return follow(deps);
  if (action === "refresh") return refresh(deps);
  if (action === "episode") return openEpisode(deps);
  if (action === "mark") return mark(deps);
  if (action === "add-card") return addCard(deps);
  return reply(400, { error: MESSAGES.unknownAction, code: "bad_action" });
}

// follow { link } | { slug }
async function follow({ body, user, store, now, fetchText }) {
  let slug = null;
  let feed = null;
  let item = null;
  let addedFrom = null;
  if (body.slug != null && body.link == null) {
    slug = podcastBySlug(body.slug)?.slug || null;
    if (!slug) return reply(404, { error: MESSAGES.notRfi, code: "not_rfi" });
  } else {
    const link = text(body.link).trim().slice(0, 500);
    const parsed = parseSpotifyLink(link);
    if (!parsed) return reply(400, { error: MESSAGES.badLink, code: "bad_link" });
    addedFrom = link;
    let title;
    try {
      // The canonical form of the link, so nothing from the request is ever
      // fetched as it was typed.
      title = await spotifyTitle(`https://open.spotify.com/${parsed.type}/${parsed.id}`, { fetchText });
    } catch (e) {
      console.warn("[podcasts] Spotify oEmbed failed:", e?.message || e);
      if (e?.code === "not_found") return reply(404, { error: plainFrom(e, MESSAGES.spotifyDown), code: "spotify_not_found" });
      return reply(502, { error: plainFrom(e, MESSAGES.spotifyDown), code: "spotify_unreachable" });
    }
    if (!clean(title)) return reply(502, { error: MESSAGES.spotifyDown, code: "spotify_unreachable" });
    // Every catalogue feed, since a show link's title is its latest episode's
    // (Spotify's oEmbed, checked 2026-10-09), not the show's name.
    const feeds = {};
    const unread = [];
    await Promise.all(PODCASTS.map(async (p) => {
      try {
        feeds[p.slug] = parseFeed(await fetchText(p.feed));
      } catch (e) {
        unread.push(p.slug);
        console.warn(`[podcasts] feed ${p.slug} unreadable:`, e?.message || e);
      }
    }));
    const match = matchTitle(title, feeds);
    // "Not one of RFI's" only once every feed was read and none has the
    // title. With a feed unread, the link may well be from that podcast: a
    // Journal link while the Journal's feed was down was told "Only RFI's
    // learner podcasts… such as Journal en français facile" (found
    // 2026-10-09). Say RFI couldn't be reached instead, so trying again later
    // is what the owner does.
    if (!match?.slug && unread.length) return reply(502, { error: MESSAGES.rfiDown, code: "rfi_unreachable" });
    if (!match?.slug) return reply(404, { error: MESSAGES.notRfi, code: "not_rfi" });
    slug = match.slug;
    feed = feeds[slug];
    item = parsed.type === "episode" ? match.item || null : null;
  }

  const followed = await store.follow({ userId: user.id, podcast: slug, addedFrom });
  if (followed.missing) return notSetUp();

  // The podcast's episodes, so its page isn't empty. A feed that can't be
  // read now is read on the next refresh; the follow stands.
  let saved = { rows: [] };
  try {
    saved = feed ? await saveFeed(slug, feed, { store, now }) : await readFeed(slug, { store, fetchText, now });
  } catch (e) {
    console.warn(`[podcasts] feed ${slug} not saved after a follow:`, e?.message || e);
  }
  if (saved.missing) return notSetUp();
  const episodeId = item ? saved.rows.find((r) => r.guid === String(item.guid))?.id ?? null : null;
  return reply(200, { podcast: slug, ...(episodeId ? { episodeId } : null) });
}

// refresh {}
async function refresh({ user, store, now, fetchText }) {
  const follows = await store.follows(user.id);
  if (follows.missing) return notSetUp();
  const slugs = [...new Set((follows.rows || []).map((r) => r.podcast))].filter((s) => podcastBySlug(s));
  let count = 0;
  let failed = 0;
  for (const slug of slugs) {
    try {
      const r = await readFeed(slug, { store, fetchText, now });
      if (r.missing) return notSetUp();
      count += r.rows.length || r.items.length;
    } catch (e) {
      failed++;
      console.warn(`[podcasts] feed ${slug} unreadable:`, e?.message || e);
    }
  }
  if (slugs.length && failed === slugs.length) return reply(502, { error: MESSAGES.rfiDown, code: "rfi_unreachable" });
  return reply(200, { ok: true, count });
}

// episode { episodeId }
async function openEpisode({ body, store, apiKey, now, fetchText }) {
  if (!uuidish(body.episodeId)) return reply(400, { error: MESSAGES.noEpisode, code: "no_episode" });
  const got = await store.episode(body.episodeId);
  if (got.missing) return notSetUp();
  let row = got.row;
  if (!row) return reply(404, { error: MESSAGES.noEpisode, code: "no_episode" });

  // 1. The transcript and the stories, read once from RFI's page.
  if (!Array.isArray(row.transcript) || !row.transcript.length) {
    const readAt = Date.parse(row.page_read_at || "");
    const recentlyEmpty = row.page_error && Number.isFinite(readAt) && now - readAt < PAGE_RETRY_MS;
    if (!row.page_url || recentlyEmpty) return reply(422, { error: MESSAGES.noTranscript, code: "no_transcript" });
    let page;
    try {
      page = parseEpisodePage(await fetchText(row.page_url));
    } catch (e) {
      console.warn(`[podcasts] page of ${row.id} unreadable:`, e?.message || e);
      return reply(502, { error: plainFrom(e, MESSAGES.rfiDown), code: "rfi_unreachable" });
    }
    const paragraphs = (page?.paragraphs || []).filter((p) => typeof p === "string" && p.trim());
    const stories = (page?.stories || [])
      .filter((s) => Number.isFinite(s?.t))
      .map((s) => ({ t: s.t, title: text(s.title), p: null }));
    const patch = paragraphs.length
      ? { transcript: paragraphs, stories, page_read_at: iso(now), page_error: null }
      : { transcript: null, page_read_at: iso(now), page_error: "no_transcript" };
    await store.savePage(row.id, { ...patch, updated_at: iso(now) });
    row = { ...row, ...patch };
    if (!paragraphs.length) return reply(422, { error: MESSAGES.noTranscript, code: "no_transcript" });
  }

  // 2. The questions, written once for everyone.
  if (row.questions == null) {
    const key = keyFrom(apiKey);
    if (!key.key) return reply(key.status, { error: key.error, code: key.code });
    const lease = await store.takeLease(row.id, iso(now), iso(now + LEASE_MS));
    if (lease.missing) return notSetUp();
    if (!lease.taken) return reply(202, { status: "preparing" });
    const stories = Array.isArray(row.stories) ? row.stories : [];
    const paragraphs = row.transcript;
    let set;
    try {
      const raw = await askQuestions({
        apiKey: key.key,
        episode: {
          podcast: podcastBySlug(row.podcast)?.name || row.podcast,
          title: row.title,
          date: longDate(row.published_at),
          duration: row.duration_seconds,
          stories,
          paragraphs,
        },
      });
      set = checkQuestions(raw, { paragraphs, stories, duration: row.duration_seconds });
      if (set.passages.length < MIN_PASSAGES) {
        throw new UnreadableReply(`only ${set.passages.length} usable passages (${set.dropped} dropped)`);
      }
    } catch (e) {
      console.error(`[podcasts] questions for ${row.id} failed:`, e?.message || e);
      const failed = e instanceof UnreadableReply
        ? reply(502, { error: MESSAGES.badQuestions, code: "unreadable" })
        : claudeError(e, "write this episode’s questions");
      await store.failQuestions(row.id, { error: failureCode(e, failed), at: iso(now) });
      return failed;
    }
    if (set.dropped) console.log(`[podcasts] ${row.id}: ${set.passages.length} passages kept, ${set.dropped} dropped`);
    const questions = { passages: set.passages, storyStarts: set.storyStarts };
    const storiesWithStarts = stories.map((s, i) => ({ ...s, p: set.storyStarts[i] ?? null }));
    const saved = await store.saveQuestions(row.id, {
      questions,
      stories: storiesWithStarts,
      questions_version: QUESTIONS_VERSION,
      questions_model: QUESTIONS_MODEL,
      questions_at: iso(now),
      updated_at: iso(now),
    });
    if (saved.written) {
      row = { ...row, questions, stories: storiesWithStarts };
    } else {
      // Another request saved a set first (this one's lease had run out):
      // everyone gets that one.
      const again = await store.episode(row.id);
      row = again.row || { ...row, questions, stories: storiesWithStarts };
    }
  }
  return reply(200, { episode: episodeJson(row) });
}

// mark { episodeId, key, typed, timeZone }
async function mark({ body, user, store, apiKey, now }) {
  const typed = text(body.typed).trim();
  if (!typed) return reply(400, { error: MESSAGES.emptyAnswer, code: "empty" });
  if (typed.length > MAX_TYPED) return reply(400, { error: MESSAGES.longAnswer, code: "too_long" });
  if (!uuidish(body.episodeId)) return reply(400, { error: MESSAGES.noEpisode, code: "no_episode" });
  const got = await store.episode(body.episodeId);
  if (got.missing) return notSetUp();
  if (!got.row) return reply(404, { error: MESSAGES.noEpisode, code: "no_episode" });
  const passage = (got.row.questions?.passages || []).find((p) => p.key === body.key);
  if (!passage) return reply(404, { error: MESSAGES.noPassage, code: "no_passage" });

  const key = keyFrom(apiKey);
  if (!key.key) return reply(key.status, { error: key.error, code: key.code });
  let marked;
  try {
    marked = readMark(await askMark({ apiKey: key.key, passage, typed }), passage.ideas);
    if (!marked) throw new UnreadableReply("no idea lists in the reply");
  } catch (e) {
    console.error(`[podcasts] marking ${got.row.id}/${passage.key} failed:`, e?.message || e);
    return claudeError(e, "mark this answer");
  }
  if (marked.claimed && marked.claimed !== marked.verdict) {
    console.log(`[podcasts] ${passage.key}: Claude said ${marked.claimed}, its ideas say ${marked.verdict}`);
  }
  const feedback = { caught: marked.caught, missed: marked.missed, note: dropRepeatedAnswer(marked.note, passage.answer) };
  const answeredAt = iso(now);
  const dueAt = marked.verdict === "got" ? null : iso(now + RETRY_DAYS * DAY_MS);
  const timeZone = typeof body.timeZone === "string" && body.timeZone.length <= 64 ? body.timeZone : null;
  const saved = await store.saveAnswer({
    user_id: user.id,
    episode_id: got.row.id,
    passage_key: passage.key,
    kind: passage.kind,
    fr: passage.fr,
    typed,
    verdict: marked.verdict,
    feedback,
    model: MARK_MODEL,
    prompt_version: MARK_VERSION,
    answered_at: answeredAt,
    due_at: dueAt,
    time_zone: timeZone,
  });
  if (saved.error || saved.missing) {
    console.error(`[podcasts] answer to ${passage.key} not saved:`, saved.missing ? "no podcast_answers table" : saved.error);
  }
  const row = saved.row || null;
  return reply(200, {
    answer: {
      id: row?.id ?? null,
      passage_key: passage.key,
      verdict: marked.verdict,
      feedback,
      answered_at: row?.answered_at ?? answeredAt,
      due_at: row ? row.due_at ?? null : dueAt,
    },
    saved: !!row,
  });
}

// add-card { episodeId, front, back }
async function addCard({ body, user, store, apiKey, ask }) {
  const rawFront = clean(body.front);
  const rawBack = clean(body.back);
  if (!rawFront || !rawBack) return reply(400, { error: MESSAGES.badCard, code: "bad_card" });
  if (rawFront.length > MAX_FRONT || rawBack.length > MAX_BACK) return reply(400, { error: MESSAGES.longCard, code: "bad_card" });
  if (!uuidish(body.episodeId)) return reply(400, { error: MESSAGES.noEpisode, code: "no_episode" });
  const ep = await store.episode(body.episodeId, { light: true });
  if (ep.missing) return notSetUp();
  if (!ep.row) return reply(404, { error: MESSAGES.noEpisode, code: "no_episode" });

  const front = cardFront(rawFront, rawBack);
  const back = cardBack(rawBack);
  if (!front || !back) return reply(400, { error: MESSAGES.badCard, code: "bad_card" });
  const deck = await store.deck(user.id);

  // Claude is asked only about a near look-alike, and only then is the key
  // that pays worked out. Without one, or if the call fails, the card waits.
  let keyProblem = null;
  const question = ask || ((pairs) => {
    const key = keyFrom(apiKey);
    if (!key.key) {
      keyProblem = key;
      return Promise.reject(new Error(key.error));
    }
    // A deadline on the real clock: `now` is the time the answer is recorded
    // at, which tests set to a fixed moment.
    return askSameCard({ apiKey: key.key, pairs, deadline: Date.now() + SAME_CARD_TIME_MS });
  });
  const incoming = [{ front, back, category: "V", dates: [], source: `podcast:${ep.row.id}` }];
  const { decisions, askError } = await matchNewCards({ incoming, deck: deck.rows || [], ask: question });

  const have = [];
  let removed = false;
  for (const d of decisions) {
    if (d.action !== "join") continue;
    const out = isArchived(d.row);
    const reason = d.row.archived_reason ?? null;
    if (out && reason === "removed") removed = true;
    have.push({ front: d.row.front, back: d.row.back, inStudy: !out, reason });
  }
  if (decisions.some((d) => d.action === "wait")) {
    if (askError) console.warn("[podcasts] same-card question unanswered; nothing added:", askError);
    return reply(200, {
      added: [], have: [], removed: false, waiting: true,
      ...(keyProblem ? { code: keyProblem.code, error: keyProblem.error } : null),
    });
  }
  if (removed) return reply(200, { added: [], have, removed: true, waiting: false });

  // dates are [] so no card already there gains anything: inserts only.
  const { inserts } = plannedWrites(decisions);
  let added = [];
  if (inserts.length) {
    const rows = inserts.map((c) => ({
      user_id: user.id, front: c.front, back: c.back, category: c.category || "V", dates: [], source: c.source,
    }));
    const saved = await store.addCards(rows);
    if (saved.error) throw new Error(`Couldn't add the card: ${saved.error.message || saved.error}`);
    added = saved.rows || [];
    // A front written by someone else between reading the deck and now is
    // left as it is, and counts as one they have.
    for (const r of rows) {
      if (!added.some((a) => a.front === r.front)) have.push({ front: r.front, back: r.back, inStudy: true, reason: null });
    }
  }
  return reply(200, { added, have, removed: false, waiting: false });
}

// ── The store, on Supabase with the service role ────────────────────────
//
// The service role ignores RLS, so every per-student read and write is held to
// the student's user_id here. A missing table (before migration_017) is
// {missing: true}; any other database error is thrown, and the route says it
// plainly.

const EPISODE_COLUMNS =
  "id,podcast,guid,title,published_at,page_url,audio_url,duration_seconds,transcript,stories,page_read_at,page_error," +
  "questions,questions_version,questions_model,questions_at,questions_error,questions_lease_until";

export function supabasePodcastStore(db) {
  const fail = (what, error) => { throw new Error(`Couldn't ${what}: ${error.message || error.code || error}`); };
  return {
    async follows(userId) {
      const { data, error } = await db.from("podcast_follows").select("podcast,followed_at,added_from").eq("user_id", userId);
      if (missingTable(error)) return { missing: true };
      if (error) fail("read your podcasts", error);
      return { rows: data || [] };
    },

    async follow({ userId, podcast, addedFrom }) {
      const { error } = await db.from("podcast_follows")
        .upsert({ user_id: userId, podcast, added_from: addedFrom ?? null }, { onConflict: "user_id,podcast", ignoreDuplicates: true });
      if (missingTable(error)) return { missing: true };
      if (error) fail("follow the podcast", error);
      return { ok: true };
    },

    // Feed columns only: transcript, stories and questions are never in the
    // payload, so a feed read can't blank what an earlier open saved.
    async saveFeed(podcast, rows) {
      const { data, error } = await db.from("podcast_episodes")
        .upsert(rows, { onConflict: "podcast,guid", ignoreDuplicates: false })
        .select("id,podcast,guid");
      if (missingTable(error)) return { missing: true };
      if (error) fail(`save the episodes of ${podcast}`, error);
      return { rows: data || [] };
    },

    async episode(id, { light = false } = {}) {
      const { data, error } = await db.from("podcast_episodes")
        .select(light ? "id,podcast,title" : EPISODE_COLUMNS).eq("id", id).maybeSingle();
      if (missingTable(error)) return { missing: true };
      // A malformed id is no episode, not a failure.
      if (error && error.code === "22P02") return { row: null };
      if (error) fail("read the episode", error);
      return { row: data || null };
    },

    async savePage(id, patch) {
      const { error } = await db.from("podcast_episodes").update(patch).eq("id", id);
      if (error) fail("save the transcript", error);
      return { ok: true };
    },

    // The lease, taken only while the episode has no questions and nobody
    // holds it (no lease, or one run out). Each statement is one conditional
    // update, so two requests can't both take it.
    async takeLease(id, nowIso, untilIso) {
      const patch = { questions_lease_until: untilIso, updated_at: nowIso };
      const free = await db.from("podcast_episodes").update(patch)
        .eq("id", id).is("questions", null).is("questions_lease_until", null).select("id");
      if (missingTable(free.error)) return { missing: true };
      if (free.error) fail("start writing the questions", free.error);
      if (free.data?.length) return { taken: true };
      const lapsed = await db.from("podcast_episodes").update(patch)
        .eq("id", id).is("questions", null).lt("questions_lease_until", nowIso).select("id");
      if (lapsed.error) fail("start writing the questions", lapsed.error);
      return { taken: !!lapsed.data?.length };
    },

    // Saved only over no questions, so a request whose lease ran out can't
    // replace a set someone else saved; `written` says whether this one was.
    async saveQuestions(id, fields) {
      const { data, error } = await db.from("podcast_episodes")
        .update({ ...fields, questions_error: null, questions_lease_until: null })
        .eq("id", id).is("questions", null).select("id");
      if (error) fail("save the questions", error);
      return { written: !!data?.length };
    },

    async failQuestions(id, { error: why, at }) {
      const { error } = await db.from("podcast_episodes")
        .update({ questions_error: why, questions_lease_until: null, updated_at: at })
        .eq("id", id).is("questions", null);
      if (error) console.error("[podcasts] couldn't record a failed question run:", error.message || error);
      return { ok: !error };
    },

    // One answer, for one student. Never throws: the verdict is shown whether
    // or not it saved.
    async saveAnswer(row) {
      const { data, error } = await db.from("podcast_answers").insert(row)
        .select("id,passage_key,verdict,feedback,answered_at,due_at").single();
      if (missingTable(error)) return { missing: true };
      if (error) return { error: error.message || String(error) };
      return { row: data };
    },

    // Every card the student has, archived and lesson cards too
    // (api/_lib/notesReading.js), since a new card is compared with all of
    // them.
    deck: (userId) => readDeck(db, userId),

    // New cards only. ignoreDuplicates: a front already in the deck is left
    // exactly as it is, never written over (a plain upsert would rewrite its
    // English and bring an archived card back).
    async addCards(rows) {
      const { data, error } = await db.from("user_cards")
        .upsert(rows, { onConflict: "user_id,front", ignoreDuplicates: true })
        .select();
      if (error) return { error };
      return { rows: data || [] };
    },
  };
}
