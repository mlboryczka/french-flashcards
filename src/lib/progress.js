// How far a student has got, in the three words the app uses everywhere:
// SEEN, ABOUT N REMEMBERED, and NOT YET SEEN. Pure: no React, no Supabase.
//
// One calculation, shared by the checkpoint after each block, the lesson top
// bar and the Stats page, so a figure can never disagree between screens.
//
//   seen         cards answered at least once, either way round. Only ever
//                goes up.
//   remembered   the sum, over the cards, of the chance the student would get
//                each one right now — for a word or phrase, right BOTH ways:
//                from French and from English. That sum is the expected number
//                currently known. It rises with study and drifts down without
//                it, because that is what memory does. Shown as "about N",
//                never a bare number — it is an estimate, and saying so is what
//                stops it becoming the next "mastered". A card whose last
//                answer was wrong counts for nothing until it is answered right.
//   notSeen      what's left to learn.
//
// A word counts as remembered only as far as it is remembered both ways: the
// owner's definition (2026-09-14) is that a student understands the word in
// French and in English. Each way has its own FSRS state, and students never
// see the split — only this one figure. The chance of both is the product of
// the two retrievabilities. The two are not independent (knowing one way helps
// the other), so the product errs low; the true chance lies between it and the
// smaller of the two. Low is the safer error. A word met only one way so far
// counts for nothing yet. Grammar and pronunciation cards are asked one way
// and count as that way's chance.
//
// For one day in between, 2026-09-14, this was two figures shown to students,
// "you'd understand" (French side) and "you could say" (English side). The
// owner rejected both the split and the words.
//
// Retrievability is derived, not stored: it changes continuously with
// elapsed time, so compute it when a figure is shown, not on every answer.

import { scheduler, State } from "./spacedRepetition.js";
import { sideOf, isTwoWay } from "./directions.js";
import { classDaysOf } from "./sessionQueue.js";
import { lessonIdOf } from "./lessonSource.js";
import { localISODateDaysAgo } from "./studyDay.js";

const RECENT_DAYS = 14;

const isSeenSide = (side) => (side.fsrs_state ?? State.New) !== State.New;
const isSeen = (card) =>
  isSeenSide(sideOf(card, "fr")) || (isTwoWay(card) && isSeenSide(sideOf(card, "en")));

// The probability, 0 to 1, that the student would recall this now. Takes one
// direction's state under the plain field names — sideOf(card, dir).
// Never-seen cards are 0. A seen row with no usable stability (a legacy row
// the FSRS migration could not seed) is also 0 rather than NaN, so one bad
// row cannot poison a sum across thousands.
//
// Two things this used to get wrong, both visible the day you study
// (2026-09-25, the owner's adverb lesson: 6 right, 5 wrong, "about 11 of 81
// remembered"):
//   • The time since the last answer is measured exactly. ts-fsrs's own
//     get_retrievability rounds it down to whole days, so for the first 24
//     hours after an answer every card read 100%, then dropped at once.
//   • A card whose last answer was wrong counts for nothing until it is
//     answered right again. Right after a miss the model rates it near
//     certain, because the answer was just shown; the owner's call is that
//     being shown the answer is not remembering it.
const DAY_MS = 86400000;
export function retrievability(card, now = Date.now()) {
  if (!isSeenSide(card)) return 0;
  if (!(card.stability > 0) || !card.last_review) return 0;
  if (card.last_answer_correct === false) return 0;
  const last = new Date(card.last_review).getTime();
  if (!Number.isFinite(last)) return 0;
  const r = scheduler.forgetting_curve(Math.max(0, (now - last) / DAY_MS), card.stability);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
}

// The chance, 0 to 1, that the student would get this card right now: both
// ways round for a word or phrase, as written for anything else.
export function rememberedChance(card, now = Date.now()) {
  const fr = retrievability(sideOf(card, "fr"), now);
  return isTwoWay(card) ? fr * retrievability(sideOf(card, "en"), now) : fr;
}

// Seen / remembered / not yet seen for any set of cards.
export function summarize(cards, now = Date.now()) {
  let seen = 0;
  let remembered = 0;
  for (const c of cards) {
    if (!isSeen(c)) continue;
    seen++;
    remembered += rememberedChance(c, now);
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

// Where the line between the two class groups falls today, and the earliest
// class in the older group (null if it has none), both as YYYY-MM-DD. A card
// is in the recent group when its latest class is on or after `since`.
export function areaDates(cards, now = Date.now()) {
  const since = localISODateDaysAgo(RECENT_DAYS, new Date(now));
  let earliestOlder = null;
  for (const c of cards) {
    if (areaOf(c, now) !== "earlier") continue;
    for (const d of classDaysOf(c)) if (earliestOlder === null || d < earliestOlder) earliestOlder = d;
  }
  return { since, earliestOlder };
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
const EMPTY = Object.freeze({ total: 0, seen: 0, remembered: 0, notSeen: 0 });

export function progressChanges(before, after) {
  const pairs = [
    ["recent", before.recent, after.recent],
    ["earlier", before.earlier, after.earlier],
    ...Object.keys({ ...before.lessons, ...after.lessons }).map((id) => [
      `lesson:${id}`,
      before.lessons[id] || EMPTY,
      after.lessons[id] || EMPTY,
    ]),
  ];
  return pairs
    .map(([area, b, a]) => ({
      area,
      after: a,
      seenDelta: a.seen - b.seen,
      rememberedDelta: aboutRemembered(a) - aboutRemembered(b),
    }))
    .filter((d) => d.seenDelta !== 0 || d.rememberedDelta !== 0);
}
