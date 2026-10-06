// Which cards Cards deals from: the student's own, and the lessons they have
// switched on.
//
// Every lesson is in every deck (lib/lessonSync.js), but a class may not have
// reached it yet. Until 2026-10-04 Cards dealt every lesson's cards once the
// student's own new cards ran out, so a student whose class hadn't met the
// impératif got impératif cards anyway. The owner's choices (2026-10-04):
//   • each lesson has a switch, "In my daily cards", on the Lessons page. Off,
//     its cards don't come up on Cards; they keep their history, and studying
//     inside the lesson works as before;
//   • without a choice, a lesson the student has answered cards in is on, so
//     nobody's reviews went missing with the update, and one they haven't
//     started is off — as is any lesson added later;
//   • except the basic lessons, Leçons 1 to 5, which are on without a choice
//     for every student, old and new (owner, 2026-10-06): every class starts
//     with them. L'impératif and the adverbs stay off until switched on;
//   • the first answer inside a lesson switches it on: by then the class has
//     reached it. The student can switch it off again;
//   • Cards can be narrowed to "My cahier": every card that isn't a lesson's,
//     words added from the tutor included.
//
// The choices are kept on the student's account (Supabase's user_metadata),
// so they are the same on every computer, with no table of their own.

import { lessonIdOf } from "./lessonSource.js";
import { directionsOf, sideOf } from "./directions.js";

export const CHOICE_KEY = "lessons_in_cards";

// The student's own choices, { lessonId: true | false }. A lesson missing from
// it has had no choice made.
export function choicesOf(user) {
  const c = user?.user_metadata?.[CHOICE_KEY];
  return c && typeof c === "object" && !Array.isArray(c) ? c : {};
}

// The lessons with a card answered either way round. 0 is FSRS's New.
export function startedLessons(cards) {
  const started = new Set();
  for (const c of cards || []) {
    const id = lessonIdOf(c);
    if (!id || started.has(id)) continue;
    if (directionsOf(c).some((d) => (sideOf(c, d).fsrs_state ?? 0) !== 0)) started.add(id);
  }
  return started;
}

// The lessons on Cards for a student who hasn't chosen: the basic lessons.
export const ON_BY_DEFAULT = new Set(["lecon1", "lecon2", "lecon3", "lecon4", "lecon5"]);

// The lessons whose cards come up on Cards: the student's choice, or without
// one, whether it is a basic lesson or one they have started.
export function lessonsInCards(lessonIds, started, choices) {
  return new Set(
    lessonIds.filter((id) =>
      typeof choices?.[id] === "boolean" ? choices[id] : ON_BY_DEFAULT.has(id) || started.has(id)
    )
  );
}

// Whether Cards may deal this card. `scope` is "all" (everything) or "cahier"
// (the student's own cards only). A lesson card whose lesson is no longer in
// the catalogue has no switch, so it is dealt as it always was.
export function onCards(card, { scope, lessonsOn, lessonIds }) {
  const id = lessonIdOf(card);
  if (!id) return true;
  if (scope === "cahier") return false;
  return lessonsOn.has(id) || !lessonIds.includes(id);
}

// The key a set is kept under (lib/studyPlace.js). The whole deck and each
// lesson keep the keys they had before My cahier existed, so a set kept from
// before the update still comes back.
export const setKeyOf = (typeFilter, lessonFilter, scope) =>
  lessonFilter === "all" && scope === "cahier" ? `${typeFilter}|all|cahier` : `${typeFilter}|${lessonFilter}`;

// What a dealt set is recorded as having been dealt from (lib/dealLog.js), so
// the status check can rebuild it: the set's key, and on Cards the lessons
// switched off, comma-separated, as "|off=…".
export const dealScopeOf = (setKey, lessonsOff) => (lessonsOff ? `${setKey}|off=${lessonsOff}` : setKey);
