// Where a student is in each podcast episode, worked out from their answers.
// Pure: no React, no Supabase, no window, so the Podcasts pages and any test
// in Node read the same rule.
//
// The record is podcast_answers (migration_017): one row per answer, never
// changed or deleted, like card_reviews. A passage's state is its LATEST row
// for (episode_id, passage_key):
//
//   unanswered   no row yet
//   got          the latest verdict is "got": done, it never comes back
//   waiting      "partly" or "missed", and its due_at is still ahead
//   due          "partly" or "missed", and its due_at has come: it shows
//                again, unanswered, in its episode, with "Back for another
//                try" above it, and the Episodes page lists the episode under
//                "To try again"
//
// The owner, 2026-10-09: "Missed or partly-right passages come back after
// three days." The server sets due_at when it saves the answer (RETRY_DAYS in
// src/lib/podcastCatalogue.js); this file only reads it, so the client and the
// server can never disagree about how long three days is.
//
// Keys are content-derived ("s1-3fa2c1d0", from the passage's own French), so
// an answer only ever counts for the passage it was given to. If an episode's
// questions are rewritten, old answers simply stop matching and stay in the
// record (owner rule: updates never reset progress).
//
// Every number a student sees names what it counts: "3 of 9 passages
// answered", never "3/9".

import { LISTEN_LEAD, LISTEN_TAIL } from "./podcastTiming.js";

// Listen plays RFI's own recording from a little before the passage to a
// little after it (owner, 2026-10-09: 3 s before, 2 s after). The passage's
// start and end are estimates from the transcript's character counts
// (src/lib/podcastTiming.js), so the lead keeps its first word from being
// clipped and the tail lets its last word finish. The two numbers live in
// podcastTiming.js, next to the estimate they pad, so the page and the server
// can never disagree about them.
export const LISTEN_LEAD_S = LISTEN_LEAD;
export const LISTEN_TAIL_S = LISTEN_TAIL;

// Where Listen starts and stops, in seconds, or null when the passage has no
// usable times. `duration` is the recording's length when known; the stop is
// never past it.
export function listenWindow(passage, duration) {
  const s = Number(passage?.start);
  const e = Number(passage?.end);
  if (passage?.start == null || passage?.end == null || !Number.isFinite(s) || !Number.isFinite(e)) return null;
  const limit = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : Infinity;
  const from = Math.max(0, s - LISTEN_LEAD_S);
  const to = Math.min(limit, Math.max(s, e) + LISTEN_TAIL_S);
  return { from, to: Math.max(from, to) };
}

export const answerKey = (episodeId, passageKey) => `${episodeId}:${passageKey}`;

const stamp = (row) => Date.parse(row?.answered_at || row?.created_at || "") || 0;

// The latest answer row for each passage, keyed by answerKey(episode, key).
// Two rows with the same time: the later one in the list wins, which is the
// order the server returned them in, or the order the page added them.
export function latestAnswers(rows) {
  const out = new Map();
  for (const row of rows || []) {
    if (!row || row.episode_id == null || !row.passage_key) continue;
    const k = answerKey(row.episode_id, row.passage_key);
    const had = out.get(k);
    if (!had || stamp(row) >= stamp(had)) out.set(k, row);
  }
  return out;
}

// One passage's state from its latest answer (see the top of this file).
// A row that wasn't got and has no due date (which the server never writes)
// counts as answered and waiting, so it can't nag forever.
export function passageState(answer, now = Date.now()) {
  if (!answer) return "unanswered";
  if (answer.verdict === "got") return "got";
  const due = Date.parse(answer.due_at || "");
  if (!Number.isFinite(due)) return "waiting";
  return due <= now ? "due" : "waiting";
}

// The passages of an episode's stored questions, in the episode's order.
export const passagesOf = (episode) =>
  Array.isArray(episode?.questions?.passages)
    ? episode.questions.passages.filter((p) => p && typeof p.key === "string" && p.key)
    : [];

// Everything the pages count for one episode.
//   total        passages in the episode
//   answered     answered and not due again (got + waiting)
//   understood   got
//   waiting      not got, coming back later
//   due          not got, back now: shown unanswered
//   done         every passage answered and none due again
//   backAt       the come-back times (ms) of the waiting passages
//   states       { [passage key]: state }
export function episodeProgress(episode, latest, now = Date.now()) {
  const passages = passagesOf(episode);
  const states = {};
  let got = 0;
  let waiting = 0;
  let due = 0;
  const backAt = [];
  for (const p of passages) {
    const answer = latest?.get?.(answerKey(episode.id, p.key)) || null;
    const state = passageState(answer, now);
    states[p.key] = state;
    if (state === "got") got++;
    else if (state === "due") due++;
    else if (state === "waiting") {
      waiting++;
      const t = Date.parse(answer.due_at || "");
      if (Number.isFinite(t)) backAt.push(t);
    }
  }
  const total = passages.length;
  const answered = got + waiting;
  return {
    total,
    answered,
    understood: got,
    waiting,
    due,
    done: total > 0 && answered === total,
    backAt: backAt.sort((a, b) => a - b),
    states,
  };
}

const plural = (n, one, many) => (n === 1 ? one : many);

// The line under an episode's title in the lists. Something due again comes
// first: it is the one thing on the row the student can act on today.
//   tone: "none" | "part" | "done" | "due"
export function episodeStatus(progress) {
  const p = progress || {};
  if (p.due > 0) return { text: `${p.due} ${plural(p.due, "passage", "passages")} to try again`, tone: "due" };
  if (!p.total || !p.answered) return { text: "Not started", tone: "none" };
  if (p.answered < p.total) return { text: `${p.answered} of ${p.total} passages answered`, tone: "part" };
  return { text: `${p.understood} of ${p.total} passages understood`, tone: "done" };
}

// The count above an episode's questions: how many are answered, and once
// every one is, how many were understood.
export function countLine(progress) {
  const p = progress || {};
  return p.done
    ? `${p.understood} of ${p.total} passages understood`
    : `${p.answered || 0} of ${p.total || 0} passages answered`;
}

// "Tuesday 6 October" and "Tue 6 Oct", in English whatever the browser's
// language, built from the date's parts so no locale can slip a comma or a
// year in.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// RFI dates its episodes in Paris: the Journal of Tuesday 6 October goes out
// at 18:00 Paris time, which is already Wednesday in Tokyo. An episode's date
// is read in Paris; a come-back date is read where the student is.
export const RFI_TIME_ZONE = "Europe/Paris";

function dayIn(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(new Date(ms));
    const get = (type) => Number(parts.find((x) => x.type === type)?.value);
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y && m && d) return { y, m, d };
  } catch {
    /* an unknown time zone: fall back to the browser's own */
  }
  const dt = new Date(ms);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

const toMs = (value) => (typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value || ""));

export function longDate(value, timeZone) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return "";
  const { y, m, d } = dayIn(ms, timeZone);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

export function shortDate(value, timeZone) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return "";
  const { y, m, d } = dayIn(ms, timeZone);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday].slice(0, 3)} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

// "a", "a and b", "a, b and c": British, no comma before "and".
export function andList(items) {
  const xs = (items || []).filter(Boolean);
  if (xs.length < 2) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

// The line in the result box once every passage is answered: when the ones
// not fully got come back. Usually one day, because an episode is answered in
// one sitting; when the answers were spread over days, each day is named
// rather than claiming one date for all of them. Null when nothing comes back.
export function comeBackLine(progress, timeZone) {
  const p = progress || {};
  if (!p.waiting) return null;
  const days = [];
  for (const t of p.backAt || []) {
    const label = longDate(t, timeZone);
    if (label && !days.includes(label)) days.push(label);
  }
  if (!days.length) return null;
  return p.waiting === 1
    ? `The passage you didn’t fully get comes back on ${andList(days)}.`
    : `The ${p.waiting} passages you didn’t fully get come back on ${andList(days)}.`;
}

// An episode is done once every passage is answered and none is due again.
// "N of M episodes done" on a podcast's card counts the episodes listed.
export function podcastDone(episodes, latest, now = Date.now()) {
  const list = episodes || [];
  let done = 0;
  for (const e of list) if (episodeProgress(e, latest, now).done) done++;
  return { done, total: list.length };
}

// Claude's marking, said in a sentence (owner, 2026-10-09). The server sends
// the ideas back as their labels: for gist, "that …" clauses; for translate,
// "« french words » (english)".
//   gist       got     You caught that X, that Y and that Z.
//              partly  You caught that X. You missed that Y.
//              missed  The passage says that X and that Y.
//   translate  got     You got « a » (x) and « b » (y).
//              partly  You got « a » (x). Check « b » (y).
//              missed  Check « a » (x) and « b » (y).
// Claude's optional note follows: one sentence about a specific
// misunderstanding, or nothing.
const clean = (items) =>
  (Array.isArray(items) ? items : [])
    .map((x) => (typeof x === "string" ? x.trim().replace(/[\s.]+$/, "") : ""))
    .filter(Boolean);

export function feedbackSentence(kind, verdict, feedback) {
  const caught = clean(feedback?.caught);
  const missed = clean(feedback?.missed);
  const parts = [];
  if (kind === "translate") {
    if (verdict === "got") {
      if (caught.length) parts.push(`You got ${andList(caught)}.`);
    } else if (verdict === "partly") {
      if (caught.length) parts.push(`You got ${andList(caught)}.`);
      if (missed.length) parts.push(`Check ${andList(missed)}.`);
    } else if (missed.length) {
      parts.push(`Check ${andList(missed)}.`);
    }
  } else if (verdict === "got") {
    if (caught.length) parts.push(`You caught ${andList(caught)}.`);
  } else if (verdict === "partly") {
    if (caught.length) parts.push(`You caught ${andList(caught)}.`);
    if (missed.length) parts.push(`You missed ${andList(missed)}.`);
  } else if (missed.length) {
    parts.push(`The passage says ${andList(missed)}.`);
  }
  const note = typeof feedback?.note === "string" ? feedback.note.trim() : "";
  if (note) parts.push(note);
  return parts.join(" ");
}

// Where each key phrase sits in the passage, to highlight it once the passage
// is answered. `inText` is the phrase as it appears ("cortèges" for the card
// "un cortège"). Found exactly first, then ignoring case, then with the two
// apostrophes (’ and ') treated as one, since RFI's text and Claude's copy
// may differ there. Overlaps keep the earlier phrase. Returns sorted
// [{ start, end, index }] (index: the phrase's place in the list).
const foldApostrophes = (s) => s.replace(/[’‘`´]/g, "'");

export function phraseRanges(fr, phrases) {
  const text = String(fr || "");
  const lower = text.toLowerCase();
  const folded = foldApostrophes(lower);
  const found = [];
  (phrases || []).forEach((ph, index) => {
    const needle = String(ph?.inText || "").trim();
    if (!needle) return;
    let at = text.indexOf(needle);
    if (at < 0) at = lower.indexOf(needle.toLowerCase());
    if (at < 0) at = folded.indexOf(foldApostrophes(needle.toLowerCase()));
    if (at >= 0) found.push({ start: at, end: at + needle.length, index });
  });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let reach = -1;
  for (const r of found) {
    if (r.start < reach) continue;
    out.push(r);
    reach = r.end;
  }
  return out;
}

// The transcript cut into its stories, for the Transcript tab.
// `storyStarts` (from the stored questions) gives the first paragraph of each
// story, in story order; before the questions exist, the stories' own `p`
// (the server's guess from RFI's page) stands in. Paragraphs before the first
// story start go with the first section. No stories, or none whose start is
// known: one section, no time.
//
// A start that is missing is missing, not paragraph 0. The server saves each
// story with p: null when it reads RFI's page, and keeps null when Claude's
// story starts don't check out, and Number(null) is 0: every story then
// "began" at the top and the whole transcript sat under "Les titres" with the
// headlines' time on it (found 2026-10-09).
// Returns [{ story, t, title, paragraphs: [{ index, text }] }].
const startAt = (raw) =>
  typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;

export function transcriptSections(paragraphs, stories, storyStarts) {
  const paras = (Array.isArray(paragraphs) ? paragraphs : []).map((text, index) => ({ index, text: String(text || "") }));
  const list = Array.isArray(stories) ? stories : [];
  const starts = Array.isArray(storyStarts) && storyStarts.length
    ? storyStarts
    : list.map((s) => s?.p);
  const cuts = [];
  list.forEach((s, story) => {
    const at = startAt(starts[story]);
    if (Number.isInteger(at) && at >= 0 && at < paras.length) cuts.push({ story, at, t: s?.t ?? null, title: s?.title || "" });
  });
  // Starts must rise with the stories; one that goes backwards is dropped
  // rather than reordering the transcript.
  const rising = [];
  for (const c of cuts) if (!rising.length || c.at > rising[rising.length - 1].at) rising.push(c);
  if (!rising.length) return paras.length ? [{ story: null, t: null, title: "", paragraphs: paras }] : [];
  return rising.map((c, i) => ({
    story: c.story,
    t: Number.isFinite(Number(c.t)) ? Number(c.t) : null,
    title: c.title,
    paragraphs: paras.slice(i === 0 ? 0 : c.at, i + 1 < rising.length ? rising[i + 1].at : paras.length),
  }));
}

// "1:05", for the time chips and the play bar.
export function clock(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

// Which story is playing at `time`: the last one that has started, or -1
// before the first.
export function storyAt(stories, time) {
  let k = -1;
  (stories || []).forEach((s, i) => {
    const t = Number(s?.t);
    if (Number.isFinite(t) && time >= t) k = i;
  });
  return k;
}
