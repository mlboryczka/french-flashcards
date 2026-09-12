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

import imperatif from "./imperatif.js";
import { lessonIdOf, lessonCardKeyOf, lessonCardKey } from "../../lib/lessonSource.js";

// How a stored card names which lesson card it is. Defined in src/lib, not
// here, so the sync reconciler can use it without importing every lesson's
// cards; re-exported so callers still reach it through the catalogue.
export {
  LESSON_SOURCE_PREFIX,
  lessonSource,
  lessonIdOf,
  lessonCardKeyOf,
  lessonCardKey,
} from "../../lib/lessonSource.js";

export const LESSONS = [imperatif];

export const lessonById = (id) => LESSONS.find((l) => l.id === id) || null;

// Where a lesson card sits in the order a student should meet it, or null for
// a card that isn't a lesson card (or no longer matches one). Lower comes
// first: lessons in catalogue order, then each lesson's `teachingOrder` of
// sections, then the card's place in the lesson's array.
//
// A row written before lesson keys existed is matched by its front, the same
// fallback reconcileLessons uses.
const RANKS = new Map();
LESSONS.forEach((lesson, li) => {
  const order = lesson.teachingOrder || [];
  lesson.cards.forEach(([front, , , section], ci) => {
    const si = order.indexOf(section);
    const rank = li * 1e8 + (si === -1 ? order.length : si) * 1e4 + ci;
    RANKS.set(`${lesson.id}#${lessonCardKey(front)}`, rank);
  });
});

export function lessonRank(card) {
  const id = lessonIdOf(card);
  if (!id) return null;
  const key = lessonCardKeyOf(card) || lessonCardKey(card.f ?? card.front);
  return RANKS.get(`${id}#${key}`) ?? null;
}
