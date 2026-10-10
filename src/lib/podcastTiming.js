// Where in RFI's recording a passage is said (2026-10-09). Pure: no window,
// no import.meta.env, so the server, the client and the tests share it.
//
// Every question in the Podcasts module shows a French passage from RFI's
// transcript with a Listen button, and Listen plays RFI's own recording, not
// the browser's voice (owner, 2026-10-09). RFI publishes no time for each
// sentence. What it does publish, for Journal en français facile, is a start
// time for each story ("01:18 Mouvement lycéen : 450 000 manifestants dans
// toute la France"), and the transcript is read at a steady newsreader's pace.
// So the time is estimated from where the passage sits in the text:
//
//   within the passage's story, the characters from the story's first
//   paragraph up to the passage's first (and last) character, divided by
//   all the story's characters, times the story's length in seconds, plus
//   the story's start time.
//
// A story runs until the next story starts, and the last one until the end
// of the episode. Short podcasts with no stories (Les mots de l'info, Un mot,
// une histoire) are one story: the whole transcript over the whole episode.
// The result is clamped to the episode.
//
// The estimate is good to a few seconds inside a story. A clip of an
// interviewee, read faster or slower than the newsreader, moves it a little,
// which is why Listen starts LISTEN_LEAD seconds early and runs LISTEN_TAIL
// seconds past the end (owner, 2026-10-09: 3 s before, 2 s after). The server
// stores start and end on each passage (podcast_episodes.questions, written
// once per episode); the client adds the lead and the tail when it plays.
//
// The text is compared after normalizePassage (below): whitespace runs become
// one space and curly apostrophes become straight ones, on both sides, so a
// passage Claude copied with ' where RFI wrote ’ is still found. The server
// uses the same function to check that every passage really is in the
// transcript.

// Characters a second at RFI's slow-news pace, used only when an episode's
// length isn't known (the feed always gives it so far). Measured on seven
// episodes of Journal en français facile, 1 to 9 October 2026: 8,980 to
// 9,698 characters of transcript in 600 seconds each, 15.0 to 16.2 a second.
export const SPEAKING_RATE = 15.5;

// Listen starts this many seconds before the estimated start and stops this
// many after the estimated end (owner, 2026-10-09).
export const LISTEN_LEAD = 3;
export const LISTEN_TAIL = 2;

// Whitespace runs (including RFI's non-breaking spaces before « ? » and
// inside « ») become one space, curly apostrophes become straight ones, and
// accents are composed the one way. Each apostrophe stays one character, so
// only whitespace changes a string's length.
export function normalizePassage(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[’‘ʼ′´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// Where the passage is: the paragraph, and the character it starts at in
// that paragraph (both after normalizePassage). When the same words appear
// twice, the copy inside `prefer` (a paragraph range) wins, then the first.
export function findPassage(paragraphs, fr, prefer = null) {
  const needle = normalizePassage(fr);
  if (!needle) return null;
  const hits = [];
  (paragraphs || []).forEach((p, i) => {
    const at = normalizePassage(p).indexOf(needle);
    if (at >= 0) hits.push({ paragraph: i, offset: at, length: needle.length });
  });
  if (!hits.length) return null;
  if (prefer) {
    const inside = hits.find((h) => h.paragraph >= prefer[0] && h.paragraph < prefer[1]);
    if (inside) return inside;
  }
  return hits[0];
}

// The stories that can be used for timing: as many as have both a start time
// and a first paragraph, with the times and paragraphs in order. Anything
// else (no stories, or Claude's paragraph numbers out of step with RFI's
// chapters) means the whole transcript is timed as one story.
function usableStories(stories, storyStarts, paragraphCount) {
  const n = Math.min(Array.isArray(stories) ? stories.length : 0, Array.isArray(storyStarts) ? storyStarts.length : 0);
  if (n === 0) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Number(stories[i]?.t);
    const p = storyStarts[i];
    if (!Number.isFinite(t) || t < 0 || !Number.isInteger(p) || p < 0 || p > paragraphCount) return null;
    if (out.length && (t < out[out.length - 1].t || p < out[out.length - 1].p)) return null;
    out.push({ t, p });
  }
  return out;
}

// { start, end } in seconds, to a tenth of a second.
//
//   paragraphs   the transcript, one string per paragraph
//   stories      [{ t, title }] from RFI's page, t = start in seconds; [] for
//                a podcast with none
//   storyStarts  the first paragraph of each story, in story order (Claude
//                gives these with the questions)
//   duration     the episode's length in seconds (the feed's)
//   passage      { story, fr }: story is an index into stories, or null
export function estimatePassageTimes({ paragraphs = [], stories = [], storyStarts = [], duration, passage } = {}) {
  const paras = (Array.isArray(paragraphs) ? paragraphs : []).map(normalizePassage);
  // Where each paragraph starts, counting one character between two
  // paragraphs, and one entry for the end of the text.
  const at = [0];
  paras.forEach((p, i) => at.push(at[i] + p.length + (i < paras.length - 1 ? 1 : 0)));
  const total = at[at.length - 1];

  const list = usableStories(stories, storyStarts, paras.length);
  const storyIndex = Number.isInteger(passage?.story) ? passage.story : null;

  // The episode's length; when unknown, how long its text takes at the
  // newsreader's pace (and never less than the last story's start).
  let dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    const last = list ? list[list.length - 1] : null;
    dur = last
      ? last.t + (total - at[last.p]) / SPEAKING_RATE
      : total / SPEAKING_RATE;
  }

  // The stretch of text and time the passage is timed within.
  const whole = { t0: 0, t1: dur, p0: 0, p1: paras.length };
  const span = (s) => {
    if (!list || s === null) return whole;
    if (s < 0) return { t0: 0, t1: list[0].t, p0: 0, p1: list[0].p }; // before the first story
    const next = list[s + 1];
    return { t0: list[s].t, t1: next ? next.t : dur, p0: list[s].p, p1: next ? next.p : paras.length };
  };
  const storyOf = (paragraph) => {
    if (!list) return null;
    let s = -1;
    for (let i = 0; i < list.length; i++) if (list[i].p <= paragraph) s = i;
    return s;
  };

  const hinted = list && storyIndex !== null && storyIndex >= 0 && storyIndex < list.length ? span(storyIndex) : null;
  const found = findPassage(paragraphs, passage?.fr, hinted ? [hinted.p0, hinted.p1] : null);

  let window;
  if (!found) {
    // Not in the transcript (the server drops such passages, so only by
    // mistake): the whole story, or the whole episode.
    const sp = hinted || whole;
    window = { start: sp.t0, end: sp.t1 };
  } else {
    // The story the text is really in. Claude's story number is believed
    // when the paragraph is inside that story; otherwise the paragraph says.
    const inHinted = hinted && found.paragraph >= hinted.p0 && found.paragraph < hinted.p1;
    const sp = inHinted ? hinted : span(storyOf(found.paragraph));
    // The story's text: its paragraphs, one character between each, so its
    // last character is said as the next story starts.
    const chars = at[sp.p1] - at[sp.p0] - (sp.p1 < paras.length && sp.p1 > sp.p0 ? 1 : 0);
    const secs = Math.max(sp.t1 - sp.t0, 0);
    const from = at[found.paragraph] + found.offset - at[sp.p0];
    const to = from + found.length;
    window = chars > 0
      ? { start: sp.t0 + (from / chars) * secs, end: sp.t0 + (to / chars) * secs }
      : { start: sp.t0, end: sp.t1 };
  }

  const start = clamp(window.start, 0, dur);
  const end = clamp(Math.max(window.end, start), 0, dur);
  return { start: round1(start), end: round1(end) };
}

// What Listen plays: from LISTEN_LEAD seconds before the passage to
// LISTEN_TAIL after it, inside the recording.
export function listenWindow({ start, end }, duration) {
  const max = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : Infinity;
  return {
    from: clamp(Number(start) - LISTEN_LEAD, 0, max),
    to: clamp(Number(end) + LISTEN_TAIL, 0, max),
  };
}
