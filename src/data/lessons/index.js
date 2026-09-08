// The lesson catalogue.
//
// A lesson is a fixed set of cards built from a teacher's materials, the same
// for everyone who studies it — as opposed to the deck, which is one person's
// own cahier. Adding a lesson copies its cards into your user_cards so they
// schedule through FSRS like anything else; the copy is what makes the
// scheduling personal while the lesson itself stays shared.
//
// Cards are tagged with source = `lesson:<id>` on insert. That column already
// exists (the cahier parser writes "cahier-upload", the tutor writes
// "tutor-chat"), so a lesson needs no schema change.

import imperatif from "./imperatif";

export const LESSONS = [imperatif];

export const LESSON_SOURCE_PREFIX = "lesson:";

export const lessonSource = (id) => `${LESSON_SOURCE_PREFIX}${id}`;

export const lessonById = (id) => LESSONS.find((l) => l.id === id) || null;

// Which lesson a stored card came from, or null for ordinary deck cards.
export const lessonIdOf = (card) =>
  typeof card?.source === "string" && card.source.startsWith(LESSON_SOURCE_PREFIX)
    ? card.source.slice(LESSON_SOURCE_PREFIX.length)
    : null;
