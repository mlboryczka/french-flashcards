// What "Replace my existing deck" does to the cards a deck already has.
// Pure, so it can be tested without a database.
//
// It used to delete every card before adding the upload's, and deleting a
// card deletes every answer recorded against it, so one tick wiped a
// student's whole history (the owner, 2026-09-25: "this should not reset the
// user's progress"). Then it archived the answered cards the upload didn't
// have and deleted the rest, matching cards by their exact French, so a card
// the upload merely spelt differently was archived and its new spelling
// started from zero.
//
// Since 2026-10-06 it works by class, and never deletes:
//
//   • a card from a class that is in the upload stays as it is. The upload
//     reads only the lines of it not read before (src/lib/notesLines.js), and
//     a word it has again only adds the class date;
//   • a card with none of its classes in the upload is taken out of study,
//     marked "replaced", and kept, unless the student has answered it, either
//     way round. An answered card stays in study whatever the classes say
//     (2026-10-07). A class can be missing from an upload for reasons that
//     have nothing to do with the card: the owner's "Le 28 et 29 septembre
//     2026" wasn't read as a class date, so a Replace with their real notes
//     would have taken out "pas grand chose à dire", answered five times,
//     and no later upload would have brought it back;
//   • a card an earlier Replace took out comes back into study when a Replace
//     upload has its class again, unless the word is in study on another card
//     by then: that card gains its class dates instead, so the word isn't in
//     study twice (2026-10-06). No other card out of study comes back: one
//     the student removed, or one put away as a repeat, stays out;
//   • lesson cards belong to their lesson and tutor cards to the student, so
//     both are left alone;
//   • before migration_016 nothing is taken out (api/_lib/notesReading.js): a
//     card taken out then couldn't say a Replace took it, so it would never
//     come back.
//
// It no longer depends on every card saving: a card the database refused
// used to turn the whole Replace into an ordinary add.

import { ARCHIVE_PREFIX, isArchived } from "./archive.js";
import { LESSON_SOURCE_PREFIX } from "./lessonSource.js";
import { DIRECTIONS, sideOf } from "./directions.js";
import { cardIndex } from "./sameCard.js";

const leftAlone = (row) =>
  typeof row.source === "string" && (row.source.startsWith(LESSON_SOURCE_PREFIX) || row.source === "tutor-chat");

// Answered at least once, either way round: French to English or English to
// French. Any sign of an answer counts: a state other than new, an answer
// counted, or a time last answered.
export const answered = (row) =>
  DIRECTIONS.some((d) => {
    const side = sideOf(row, d);
    return (side.fsrs_state ?? 0) !== 0 || (side.reps ?? 0) > 0 || !!side.last_review;
  });

// `existing`: rows with id, dates, source (and archived_reason after
// migration_016). `uploadDates`: the classes in the upload. `reasons`: whether
// the deck says why each card is out of study; without that, no card can be
// told to have come out by a Replace, so none comes back.
// Returns { archive: rows, stay: rows, restore: rows, kept: [{ row, into }] }:
// `stay` are answered cards from classes not in the upload, left in study;
// `kept` are cards that would have come back but whose word is in study on
// `into`.
export function planReplace(existing, uploadDates, { reasons = true } = {}) {
  const inUpload = new Set(uploadDates || []);
  const archive = [];
  const stay = [];
  const back = [];
  for (const row of existing || []) {
    const dates = Array.isArray(row.dates) ? row.dates : [];
    const covered = dates.some((d) => inUpload.has(d));
    if (isArchived(row)) {
      if (reasons && row.archived_reason === "replaced" && covered) back.push(row);
      continue;
    }
    if (leftAlone(row) || covered) continue;
    (answered(row) ? stay : archive).push(row);
  }

  // The cards in study once this Replace is done, by the rule every
  // card-writer uses (src/lib/sameCard.js). A card brought back joins them,
  // so two copies a Replace took out don't both come back.
  const leaving = new Set(archive);
  const index = cardIndex((existing || []).filter((row) => !isArchived(row) && !leaving.has(row)));
  const restore = [];
  const kept = [];
  for (const row of back) {
    const into = index.sure(row);
    if (into) { kept.push({ row, into }); continue; }
    restore.push(row);
    index.add({ ...row, source: String(row.source).slice(ARCHIVE_PREFIX.length) });
  }
  return { archive, stay, restore, kept };
}
