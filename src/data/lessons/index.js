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
import adverbes from "./adverbes.js";
import { drillInstruction } from "../../lib/cardInstruction.js";
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

export const LESSONS = [imperatif, adverbes];

export const lessonById = (id) => LESSONS.find((l) => l.id === id) || null;

// Where a lesson card sits in the order a student should meet it, or null for
// a card that isn't a lesson card (or no longer matches one). Lower comes
// first: lessons in catalogue order, then each lesson's `teachingOrder` of
// sections, then the card's place in the lesson's array.
//
// A row written before lesson keys existed is matched by its front, the same
// fallback reconcileLessons uses.
const RANKS = new Map();
// And which section each lesson card is in, for its instruction line.
const SECTIONS = new Map();
// And the lesson's current answer, so one the lesson has since widened
// ("N'en parlons pas / N'en parlons plus") is accepted on rows synced before.
const BACKS = new Map();
LESSONS.forEach((lesson, li) => {
  const order = lesson.teachingOrder || [];
  // Keyed by the card's identity, which is its FIRST front: a reworded card
  // carries that as its fifth element, and the sync keys its rows by it.
  // Keying by the current front alone left the 27 renamed impératif drills
  // unranked. The current front is kept too, for a row keyed that way.
  lesson.cards.forEach(([front, back, , section, was], ci) => {
    const si = order.indexOf(section);
    const rank = li * 1e8 + (si === -1 ? order.length : si) * 1e4 + ci;
    for (const f of new Set([was ?? front, front])) {
      const k = `${lesson.id}#${lessonCardKey(f)}`;
      RANKS.set(k, rank);
      SECTIONS.set(k, section);
      BACKS.set(k, back);
    }
  });
});

const lessonKeyOf = (card) => {
  const id = lessonIdOf(card);
  if (!id) return null;
  const key = lessonCardKeyOf(card) || lessonCardKey(card.f ?? card.front);
  return `${id}#${key}`;
};

export function lessonRank(card) {
  const k = lessonKeyOf(card);
  return k ? RANKS.get(k) ?? null : null;
}

export function lessonBackFor(card) {
  const k = lessonKeyOf(card);
  return k ? BACKS.get(k) ?? null : null;
}

// The line above a grammar card saying exactly what to type, or null.
//
// Only grammar cards get one: a word or phrase card is a translation, and its
// input already says which language to type. A conjugation drill's line comes
// from its own shape, because that names the tense and the person; any other
// lesson card takes its section's line from LESSON.instructions.
export function cardInstructionFor(card) {
  if (!card || (card.cat !== "gram" && card.cat !== "pron")) return null;
  const front = card.f ?? card.front;
  const drill = drillInstruction(front);
  if (drill) return drill;
  const k = lessonKeyOf(card);
  if (!k) return null;
  const lesson = lessonById(k.split("#")[0]);
  return lesson?.instructions?.[SECTIONS.get(k)] || null;
}
