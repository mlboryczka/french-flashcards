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
import { DIRECTIONS, sideOf } from "./directions.js";
import { cardIndex } from "./sameCard.js";
import { ARCHIVE_PREFIX, isArchived } from "./archive.js";

// An archived row as it was before it was archived, so its lesson and key can
// be read: "archived:lesson:lecon1#k9" -> "lesson:lecon1#k9".
const unarchived = (card) => ({ ...card, source: String(card.source).slice(ARCHIVE_PREFIX.length) });

// Why a card out of study stays out whatever a lesson has: the student
// removed it, or it was put away as a repeat of another card (archived_reason,
// migration_016). A card out of study for no recorded reason is one a lesson
// dropped, among others, and comes back if the lesson brings it back (owner,
// 2026-09-25).
const STAYS_OUT = new Set(["removed", "duplicate"]);

// Answered at least once, either way round: the card carries the student's
// history, and nothing a lesson does may delete it.
const studied = (card) => DIRECTIONS.some((d) => (sideOf(card, d).fsrs_state ?? 0) !== 0);

// A class date on a lesson card: a lesson card is written with none, so a
// date can only come from the student's own notes.
const fromNotes = (card) => Array.isArray(card.dates) && card.dates.some((d) => typeof d === "string" && d);

// The source a lesson card becomes when it is the student's notes card.
export const ADOPTED_SOURCE = "cahier-upload";

/**
 * @param {Array} lessons   the catalogue (LESSONS)
 * @param {Array} deckCards shaped deck rows from useUserDeck
 * @param {Array} archivedCards the rows out of study ({ f, b, source, reason }),
 *             from useUserDeck's `archived`
 * @returns {{ missing: Array, rekey: Array, retext: Array, stale: number[], archive: number[], adopt: number[], unkeyed: Array, taken: Array, away: Array }}
 *   missing — lesson cards this deck has no row for, ready for insert
 *             (the caller adds user_id)
 *   rekey   — legacy rows that DO match a lesson card, re-upserted on the same
 *             front so they gain a key. The upsert conflicts on (user_id,
 *             front) and updates only the columns given, so the FSRS state on
 *             the row is untouched. One write, once.
 *   retext  — { row_id, front, back } for rows still showing a front the
 *             lesson has since RENAMED. A lesson card's fifth element is the
 *             front it used to have, and that old front stays its identity, so
 *             the rename neither retires the row nor resets its FSRS state.
 *             Only rows whose stored front is still exactly the old text are
 *             rewritten — one the user edited is theirs and is left alone.
 *   stale   — row_ids to delete: keyed rows whose lesson no longer has them,
 *             never answered either way, so there is nothing to lose
 *   archive — row_ids of keyed rows the lesson no longer has that the student
 *             HAS answered. Taken out of study, not deleted: deleting a card
 *             deletes every answer recorded against it, and a lesson update
 *             must never cost a student their history (the owner, 2026-09-25).
 *   adopt   — row_ids of keyed rows the lesson no longer has that carry class
 *             dates: a word from the student's own notes landed on the lesson
 *             card (a reading only adds its class date to a card the student
 *             already has, lesson cards included). That row is the student's
 *             notes card too, and the line it came from is marked read, so no
 *             upload or sync would make it again: deleting or archiving it
 *             lost the word from study for good (2026-10-06). It becomes an
 *             ordinary card instead (source "cahier-upload"), keeping its row,
 *             its dates, its schedule and its answers.
 *   unkeyed — legacy rows matching no lesson card. NOT deleted: a row written
 *             before keys existed is indistinguishable from an edited one, and
 *             deleting a card someone corrected is worse than leaving one the
 *             lesson has retired. Returned so the caller can say so.
 *   taken   — lesson cards NOT inserted because the deck already has a card of
 *             its own with that front, or the same card written another way
 *             (src/lib/sameCard.js's sure rule). The insert is an upsert on
 *             (user_id, front), so it would have turned the student's card
 *             into the lesson's — new back, new category, and its class dates
 *             replaced by none. A single-word lesson front ("actuellement",
 *             in the adverb lesson) can easily already be in a cahier deck.
 *             The student keeps their card; the lesson goes without it. A card
 *             of their own they removed counts too (2026-10-06): it is a word
 *             they didn't want, and a lesson must not bring it back under
 *             another card.
 *   away    — lesson cards NOT inserted because the student removed their row
 *             for it, or it was put away as a repeat (2026-10-06). Removing a
 *             card archives it rather than deleting it (api/_lib/removeCard.js),
 *             and the insert, an upsert on the front, would land on the
 *             archived row and put it back in study: a card the student
 *             removed would never stay removed. Known by the reason the row
 *             gives (archived_reason, migration_016); before the migration no
 *             row gives one, and a removed lesson card comes back, as a
 *             deleted one did before.
 */
export function reconcileLessons(lessons, deckCards, archivedCards = []) {
  const missing = [];
  const rekey = [];
  const retext = [];
  const stale = [];
  const archive = [];
  const adopt = [];
  const unkeyed = [];
  const taken = [];
  const away = [];
  // The rows out of study that must stay out.
  const shelved = (archivedCards || []).filter((card) => isArchived(card) && STAYS_OUT.has(card.reason)).map(unarchived);
  // Their fronts: a lesson card inserted on one of them would put that row
  // back in study.
  const shelvedFronts = new Set(shelved.map((card) => card.f));
  // The deck's own cards, not a lesson's, in study or removed. "Already has
  // this card" is the same rule every card-writer uses (src/lib/sameCard.js),
  // not the exact front: the owner had "rends-moi mon livre" from their
  // notes, and the lesson added "Rends-moi mon livre !" beside it
  // (2026-10-06).
  const ownCards = [...(deckCards || []), ...shelved].filter((card) => !lessonIdOf(card));
  const own = new Set(ownCards.map((card) => card.f));
  const ownIndex = cardIndex(ownCards.map((card) => ({ front: card.f, back: card.b, source: card.source })));
  const ownHas = (c) => own.has(c.f) || !!ownIndex.sure({ front: c.f, back: c.b });

  for (const lesson of lessons) {
    const want = new Map(
      lesson.cards.map(([f, b, c, , was]) => [lessonCardKey(was ?? f), { f, b, c, was }])
    );
    const have = (deckCards || []).filter((card) => lessonIdOf(card) === lesson.id);
    const claimed = new Set();
    // This lesson's cards out of study, by key (or, written before keys, by
    // front).
    const shelvedKeys = new Set(
      shelved.filter((card) => lessonIdOf(card) === lesson.id).map((card) => lessonCardKeyOf(card) || lessonCardKey(card.f))
    );

    for (const card of have) {
      const stored = lessonCardKeyOf(card);
      if (stored) {
        if (want.has(stored)) {
          claimed.add(stored);
          const c = want.get(stored);
          if (c.was && card.f === c.was && card.row_id != null) {
            retext.push({ row_id: card.row_id, front: c.f, back: c.b });
          }
        } else if (card.row_id != null) {
          if (fromNotes(card)) adopt.push(card.row_id);
          else (studied(card) ? archive : stale).push(card.row_id);
        }
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
      if (shelvedKeys.has(key) || shelvedFronts.has(c.f)) { away.push({ lesson: lesson.id, front: c.f }); continue; }
      if (ownHas(c)) { taken.push({ lesson: lesson.id, front: c.f }); continue; }
      missing.push({
        front: c.f,
        back: c.b,
        category: c.c,
        dates: [],
        source: lessonSource(lesson.id, key),
      });
    }
  }

  return { missing, rekey, retext, stale, archive, adopt, unkeyed, taken, away };
}
