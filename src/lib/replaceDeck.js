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
//     marked "replaced", and kept with its schedule and answers;
//   • a card an earlier Replace took out comes back into study when a Replace
//     upload has its class again, unless the word is in study on another card
//     by then: that card gains its class dates instead. A lesson can add its
//     own copy of a word while the student's is out of study (the lesson sync
//     doesn't count a card a Replace took out as the student's), and bringing
//     the student's back beside it made one card twice (2026-10-06). No other
//     card out of study comes back: one the student removed, or one put away
//     as a repeat, stays out;
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
import { cardIndex } from "./sameCard.js";

const leftAlone = (row) =>
  typeof row.source === "string" && (row.source.startsWith(LESSON_SOURCE_PREFIX) || row.source === "tutor-chat");

// `existing`: rows with id, dates, source (and archived_reason after
// migration_016). `uploadDates`: the classes in the upload. `reasons`: whether
// the deck says why each card is out of study; without that, no card can be
// told to have come out by a Replace, so none comes back.
// Returns { archive: rows, restore: rows, kept: [{ row, into }] }: `kept` are
// cards that would have come back but whose word is in study on `into`.
export function planReplace(existing, uploadDates, { reasons = true } = {}) {
  const inUpload = new Set(uploadDates || []);
  const archive = [];
  const back = [];
  for (const row of existing || []) {
    const dates = Array.isArray(row.dates) ? row.dates : [];
    const covered = dates.some((d) => inUpload.has(d));
    if (isArchived(row)) {
      if (reasons && row.archived_reason === "replaced" && covered) back.push(row);
      continue;
    }
    if (leftAlone(row)) continue;
    if (!covered) archive.push(row);
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
  return { archive, restore, kept };
}
