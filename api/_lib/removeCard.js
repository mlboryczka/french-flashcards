// A student removing a card: taken out of study, and remembered (2026-10-06).
//
// "Delete card" used to erase the row and every answer on it, even on a card
// the student had answered, against the owner's rule that answers are never
// lost. And because nothing remembered it, the next upload or a later class
// made the same card again: the owner deleted "Naza" in April and the
// 4 September upload brought it back.
//
// Now the row stays. It is archived (src/lib/archive.js), with
// archived_reason "removed" and the time, and keeps its schedule, answers and
// class dates. Every card-writer counts it as a card the student has
// (src/lib/cardMatch.js), so a class that has the word again only adds its
// date, and the card stays out of study.
//
// Before migration_016 there is no archived_reason column: the card is
// archived all the same, without the reason.

import { archivedSource, isArchived } from "../../src/lib/archive.js";
import { missingColumn } from "../../src/lib/reviewLog.js";

// Returns { status, json }, the reply the route sends.
export async function removeCard({ admin, userId, rowId }) {
  if (rowId === null || rowId === undefined || rowId === "") {
    return { status: 400, json: { error: "Which card? row_id is missing." } };
  }
  const { data: row, error } = await admin.from("user_cards").select("id, user_id, front, source").eq("id", rowId).maybeSingle();
  if (error) return { status: 500, json: { error: error.message } };
  if (!row) return { status: 404, json: { error: "Card not found." } };
  if (row.user_id !== userId) return { status: 403, json: { error: "Not your card" } };
  if (isArchived(row)) return { status: 200, json: { ok: true, removed: true, already: true } };

  const source = archivedSource(row.source);
  let { error: updErr } = await admin.from("user_cards")
    .update({ source, archived_reason: "removed", archived_at: new Date().toISOString() })
    .eq("id", row.id).eq("user_id", userId);
  if (updErr && missingColumn(updErr)) {
    ({ error: updErr } = await admin.from("user_cards").update({ source }).eq("id", row.id).eq("user_id", userId));
  }
  if (updErr) return { status: 500, json: { error: updErr.message } };
  return { status: 200, json: { ok: true, removed: true } };
}
