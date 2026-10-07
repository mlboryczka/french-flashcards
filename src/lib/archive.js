// Archiving a card: out of circulation, not out of the database.
//
// An archived card keeps its row, and the row keeps where it came from:
// `source` gains an "archived:" prefix ("archived:cahier-upload"). The deck
// loader drops those rows, so an archived card is not studied, listed or
// counted anywhere, and nothing about it is lost until someone deletes it:
//
//   delete from user_cards where source like 'archived:%';
//
// A prefix on an existing column rather than an archived_at column, because
// this needed no migration. Two things follow from the row still existing:
// its front still holds the (user_id, front) unique slot, so adding a card
// with the same front from the tutor upserts onto the archived row and
// brings it back, which is what the student asked for. Nothing else brings
// one back (2026-10-06): a card the student removed (api/_lib/removeCard.js)
// is still a card they have, so neither their notes (src/lib/cardMatch.js)
// nor a lesson (lib/lessonSync.js) puts it back in study. Only "Replace my
// existing deck" returns the cards it took out itself (lib/replaceDeck.js).
// Since migration_016 the row also says why it is out (archived_reason).

export const ARCHIVE_PREFIX = "archived:";

export const isArchived = (row) =>
  typeof row?.source === "string" && row.source.startsWith(ARCHIVE_PREFIX);

// The source to write when archiving. Idempotent, and a null source stays
// recoverable as "archived:".
export const archivedSource = (source) =>
  typeof source === "string" && source.startsWith(ARCHIVE_PREFIX)
    ? source
    : `${ARCHIVE_PREFIX}${source ?? ""}`;
