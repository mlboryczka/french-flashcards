// Working out what a deck is missing from its lessons, and what it holds that
// the lesson has retired. Pure, so it can be tested without a browser.
//
// A lesson is the authority over its own cards: adding a lesson copies them
// into user_cards, and later versions of the lesson must be able to withdraw a
// card, which is how eight "state the rule" cards — questions with nothing to
// type — were removed from the decks of everyone who had already added them.
//
// The subtlety is telling "the lesson dropped this card" apart from "the user
// edited this card". Both look like a front that is no longer in the lesson.
// Identity is therefore a key hashed from the LESSON's front and stored in
// `source`, not the stored front itself; see lessonCardKey.

import { lessonSource, lessonIdOf, lessonCardKeyOf, lessonCardKey } from "./lessonSource.js";

/**
 * @param {Array} lessons   the catalogue (LESSONS)
 * @param {Array} deckCards shaped deck rows from useUserDeck
 * @returns {{ missing: Array, rekey: Array, stale: number[], unkeyed: Array }}
 *   missing — lesson cards this deck has no row for, ready for insert
 *             (the caller adds user_id)
 *   rekey   — legacy rows that DO match a lesson card, re-upserted on the same
 *             front so they gain a key. The upsert conflicts on (user_id,
 *             front) and updates only the columns given, so the FSRS state on
 *             the row is untouched. One write, once.
 *   stale   — row_ids to delete: keyed rows whose lesson no longer has them
 *   unkeyed — legacy rows matching no lesson card. NOT deleted: a row written
 *             before keys existed is indistinguishable from an edited one, and
 *             deleting a card someone corrected is worse than leaving one the
 *             lesson has retired. Returned so the caller can say so.
 */
export function reconcileLessons(lessons, deckCards) {
  const missing = [];
  const rekey = [];
  const stale = [];
  const unkeyed = [];

  for (const lesson of lessons) {
    const want = new Map(
      lesson.cards.map(([f, b, c]) => [lessonCardKey(f), { f, b, c }])
    );
    const have = (deckCards || []).filter((card) => lessonIdOf(card) === lesson.id);
    const claimed = new Set();

    for (const card of have) {
      const stored = lessonCardKeyOf(card);
      if (stored) {
        if (want.has(stored)) claimed.add(stored);
        else if (card.row_id != null) stale.push(card.row_id);
        continue;
      }
      // Legacy row: no key. Match it by front, which is what identity used to
      // be. A match claims that card and is queued to be re-keyed; anything
      // else is left alone.
      const byFront = lessonCardKey(card.f);
      if (want.has(byFront)) {
        claimed.add(byFront);
        const c = want.get(byFront);
        rekey.push({
          front: card.f,
          back: c.b,
          category: c.c,
          source: lessonSource(lesson.id, byFront),
        });
      } else {
        unkeyed.push(card);
      }
    }

    for (const [key, c] of want) {
      if (claimed.has(key)) continue;
      missing.push({
        front: c.f,
        back: c.b,
        category: c.c,
        dates: [],
        source: lessonSource(lesson.id, key),
      });
    }
  }

  return { missing, rekey, stale, unkeyed };
}
