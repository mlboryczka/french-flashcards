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
//     upload has its class again. No other card out of study comes back: one
//     the student removed, or one put away as a repeat, stays out;
//   • lesson cards belong to their lesson and tutor cards to the student, so
//     both are left alone.
//
// It no longer depends on every card saving: a card the database refused
// used to turn the whole Replace into an ordinary add.

import { isArchived } from "./archive.js";
import { LESSON_SOURCE_PREFIX } from "./lessonSource.js";

const leftAlone = (row) =>
  typeof row.source === "string" && (row.source.startsWith(LESSON_SOURCE_PREFIX) || row.source === "tutor-chat");

// `existing`: rows with id, dates, source (and archived_reason after
// migration_016). `uploadDates`: the classes in the upload. `reasons`: whether
// the deck says why each card is out of study; without that, no card can be
// told to have come out by a Replace, so none comes back.
// Returns { archive: rows, restore: rows }.
export function planReplace(existing, uploadDates, { reasons = true } = {}) {
  const inUpload = new Set(uploadDates || []);
  const archive = [];
  const restore = [];
  for (const row of existing || []) {
    const dates = Array.isArray(row.dates) ? row.dates : [];
    const covered = dates.some((d) => inUpload.has(d));
    if (isArchived(row)) {
      if (reasons && row.archived_reason === "replaced" && covered) restore.push(row);
      continue;
    }
    if (leftAlone(row)) continue;
    if (!covered) archive.push(row);
  }
  return { archive, restore };
}
