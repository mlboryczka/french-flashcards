// The lesson catalogue.
//
// A lesson is a fixed set of cards built from a teacher's materials, the same
// for everyone who studies it — as opposed to the deck, which is one person's
// own cahier. Adding a lesson copies its cards into your user_cards so they
// schedule through FSRS like anything else; the copy is what makes the
// scheduling personal while the lesson itself stays shared.
//
// Cards are tagged with source = `lesson:<id>#<cardKey>` on insert. That column
// already exists (the cahier parser writes "cahier-upload", the tutor writes
// "tutor-chat"), so a lesson needs no schema change.

import imperatif from "./imperatif";

// How a stored card names which lesson card it is. Defined in src/lib, not
// here, so the sync reconciler can use it without importing every lesson's
// cards; re-exported so callers still reach it through the catalogue.
export {
  LESSON_SOURCE_PREFIX,
  lessonSource,
  lessonIdOf,
  lessonCardKeyOf,
  lessonCardKey,
} from "../../lib/lessonSource";

export const LESSONS = [imperatif];

export const lessonById = (id) => LESSONS.find((l) => l.id === id) || null;
