// The record of every set of cards dealt (dealt_sets, migration_013). Pure.
//
// card_reviews says what the student answered; this says what the app put in
// front of them, and what it believed about each card when it did. The status
// check (lib/statusChecks.js) reads both: whether a due card was left out of a
// set that took new cards, whether missed cards were picked first, whether a
// card was dealt as due when it wasn't. The stale set of 2026-09-23 — 22 cards
// asked that weren't due, 54 due ones left out — is exactly what these rows
// make visible on the day it happens.
//
// Written for every student, whether or not the app is shown the check, and
// never waited on: a set is studied the same whether its record saved or not.

import { sideOf, itemKey } from "./directions.js";

const cardIdOf = (c) => c.row_id ?? c.id;

// Postgres "relation does not exist", or PostgREST's "not in the schema
// cache": the database hasn't had migration_013 yet.
export const missingTable = (error) => !!error && (error.code === "42P01" || error.code === "PGRST205");

// One entry dealt: the card, the way round, why it was dealt, and the card's
// state that way round as the app read it.
function dealtItem(c) {
  const s = sideOf(c, c.shownDir ?? "fr");
  return {
    c: cardIdOf(c),
    d: c.shownDir ?? "fr",
    b: c._bucket ?? null,
    due: s.next_due_at ?? null,
    st: s.fsrs_state ?? 0,
    miss: s.last_answer_correct === false,
  };
}

// `kind`: "new" (a new set), "rest" (the rest of a set dealt again), or
// "direction" (the rest dealt again for a new direction setting). `dealt` is
// buildSession's result; `kept` the entries staying in the set.
export function dealRow({ id, userId, kind, scope, direction, slots, dealt, kept = [], at = new Date(), timeZone = null }) {
  const seen = new Set();
  const keptItems = [];
  for (const c of kept) {
    if (!c || c._retry) continue;
    const k = itemKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    keptItems.push({ c: cardIdOf(c), d: c.shownDir ?? "fr", b: c._bucket ?? null });
  }
  return {
    id,
    user_id: userId,
    dealt_at: new Date(at).toISOString(),
    kind,
    scope,
    direction: direction === "en" || direction === "fr" ? direction : "mix",
    slots,
    items: (dealt?.queue || []).map(dealtItem),
    kept: keptItems,
    due_left: Number.isFinite(dealt?.dueRemaining) ? dealt.dueRemaining : null,
    new_available: Number.isFinite(dealt?.newAvailable) ? dealt.newAvailable : null,
    time_zone: timeZone,
  };
}
