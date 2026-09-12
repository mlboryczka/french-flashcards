// How far a student has got, in the three words the app uses everywhere:
// SEEN, ABOUT N REMEMBERED, and NOT YET SEEN. Pure: no React, no Supabase.
//
// One calculation, shared by the checkpoint after each block, the lesson top
// bar and the Stats page, so a figure can never disagree between screens.
//
//   seen         cards answered at least once. Only ever goes up.
//   remembered   the sum, over the cards, of FSRS's own estimate that the
//                student would recall each one right now (retrievability).
//                That sum is the expected number currently known. It rises
//                with study and drifts down without it, because that is what
//                memory does. Shown as "about N", never a bare number — it
//                is an estimate, and saying so is what stops it becoming the
//                next "mastered".
//   notSeen      what's left to learn.
//
// Retrievability is derived, not stored: it changes continuously with
// elapsed time, so compute it when a figure is shown, not on every answer.

import { scheduler, toFsrsCard, State } from "./spacedRepetition.js";
import { classDaysOf } from "./sessionQueue.js";
import { lessonIdOf } from "./lessonSource.js";
import { localISODateDaysAgo } from "./studyDay.js";

const RECENT_DAYS = 14;

const isSeen = (card) => (card.fsrs_state ?? State.New) !== State.New;

// The probability, 0 to 1, that the student would recall this card now.
// Never-seen cards are 0. A seen row with no usable stability (a legacy row
// the FSRS migration could not seed) is also 0 rather than NaN, so one bad
// row cannot poison a sum across thousands.
export function retrievability(card, now = Date.now()) {
  if (!isSeen(card)) return 0;
  if (!(card.stability > 0) || !card.last_review) return 0;
  const r = scheduler.get_retrievability(toFsrsCard(card), new Date(now), false);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
}

// Seen / remembered / not yet seen for any set of cards.
export function summarize(cards, now = Date.now()) {
  let seen = 0;
  let remembered = 0;
  for (const c of cards) {
    if (!isSeen(c)) continue;
    seen++;
    remembered += retrievability(c, now);
  }
  return {
    total: cards.length,
    seen,
    // Kept unrounded so a before/after difference is honest; round only when
    // displaying, via aboutRemembered().
    remembered,
    notSeen: cards.length - seen,
  };
}

export const aboutRemembered = (summary) => Math.round(summary.remembered);

// Which area a card's progress counts towards: its lesson, the student's
// recent classes (the last two weeks, the same window new cards use), or
// their earlier notes. Tutor chat cards are dated by the day they were added.
export function areaOf(card, now = Date.now()) {
  const lesson = lessonIdOf(card);
  if (lesson) return `lesson:${lesson}`;
  const days = classDaysOf(card);
  if (days.length === 0) return "earlier";
  const latest = [...days].sort()[days.length - 1];
  return latest >= localISODateDaysAgo(RECENT_DAYS, new Date(now)) ? "recent" : "earlier";
}

// Every area's figures in one pass over the deck, plus the whole deck.
//   { all, recent, earlier, lessons: { [lessonId]: summary } }
export function progressByArea(cards, now = Date.now()) {
  const buckets = { recent: [], earlier: [], lessons: {} };
  for (const c of cards) {
    const area = areaOf(c, now);
    if (area.startsWith("lesson:")) {
      const id = area.slice("lesson:".length);
      (buckets.lessons[id] ||= []).push(c);
    } else {
      buckets[area].push(c);
    }
  }
  const lessons = {};
  for (const [id, list] of Object.entries(buckets.lessons)) lessons[id] = summarize(list, now);
  return {
    all: summarize(cards, now),
    recent: summarize(buckets.recent, now),
    earlier: summarize(buckets.earlier, now),
    lessons,
  };
}

// What changed between two progressByArea() snapshots, for the areas where
// anything did. The checkpoint shows these: "L'impératif: 8 more seen, about
// 5 more remembered".
export function progressChanges(before, after) {
  const pairs = [
    ["recent", before.recent, after.recent],
    ["earlier", before.earlier, after.earlier],
    ...Object.keys({ ...before.lessons, ...after.lessons }).map((id) => [
      `lesson:${id}`,
      before.lessons[id] || { total: 0, seen: 0, remembered: 0, notSeen: 0 },
      after.lessons[id] || { total: 0, seen: 0, remembered: 0, notSeen: 0 },
    ]),
  ];
  return pairs
    .map(([area, b, a]) => ({
      area,
      after: a,
      seenDelta: a.seen - b.seen,
      rememberedDelta: Math.round(a.remembered) - Math.round(b.remembered),
    }))
    .filter((d) => d.seenDelta !== 0 || d.rememberedDelta !== 0);
}
