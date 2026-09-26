// What "Replace my existing deck" does to the cards a deck already has.
// Pure, so it can be tested without a database.
//
// It used to delete every card before adding the upload's — and deleting a
// card deletes every answer recorded against it, so one tick wiped a
// student's whole history: every schedule, every answer, the lessons' cards
// too (the owner, 2026-09-25: "this should not reset the user's progress").
// Now the deck still ends up as the upload, but nothing studied is lost:
//
//   • a card the upload also has is left for the upload to update, progress
//     and all (the insert is an upsert on the front);
//   • a card the student has answered, either way round, that the upload
//     doesn't have is taken out of study (archived), row and answers kept. If
//     a later upload has the word again, it lands on this row and brings it
//     back, history and all;
//   • a card never answered that the upload doesn't have is deleted — there
//     is nothing to lose;
//   • lesson cards belong to their lesson, not to the notebook, and are left
//     alone, as are cards already archived.

import { isArchived } from "./archive.js";
import { LESSON_SOURCE_PREFIX } from "./lessonSource.js";

const answered = (row) => (row.fsrs_state ?? 0) !== 0 || (row.en_fsrs_state ?? 0) !== 0;

// `existing`: rows with id, front, source, fsrs_state, en_fsrs_state.
// `incomingFronts`: the fronts the upload writes.
// `withHistory`: ids of cards with any answer on record. "Reset all progress"
// puts a card back to never answered but keeps its answers, and deleting the
// card would delete them, so such a card counts as answered here.
// Returns { remove: ids, archive: rows }.
export function planReplace(existing, incomingFronts, withHistory = new Set()) {
  const incoming = new Set(incomingFronts);
  const remove = [];
  const archive = [];
  for (const row of existing || []) {
    if (isArchived(row)) continue;
    if (typeof row.source === "string" && row.source.startsWith(LESSON_SOURCE_PREFIX)) continue;
    if (incoming.has(row.front)) continue;
    if (answered(row) || withHistory.has(row.id)) archive.push(row);
    else remove.push(row.id);
  }
  return { remove, archive };
}
