// Which way round a card is asked, and which FSRS state that answer belongs to.
// Pure, and deliberately light: no ts-fsrs, so the tutor's deck context can
// use it too.
//
// A word or phrase card is TWO-WAY: "la pomme → ?" (direction "fr", the French
// side shown) and "apple → ?" (direction "en"). Each direction has its own FSRS
// state, because recognising a word and producing it are different skills and
// which is harder differs per student and per card (migration_010). Grammar
// and pronunciation cards are ONE-WAY — rules with examples, always shown as
// written — and have only the "fr" state.
//
// On the row, "fr" is migration_006's columns and "en" is the same eight with
// an en_ prefix. Everything that reads or writes a direction's state goes
// through sideOf() and sideColumns(); nothing else should name an en_ column
// except the deck loader and the reset.

export const DIRECTIONS = Object.freeze(["fr", "en"]);

// The eight fields one direction's FSRS state is made of.
export const SIDE_FIELDS = Object.freeze([
  "stability",
  "difficulty",
  "fsrs_state",
  "reps",
  "lapses",
  "next_due_at",
  "last_review",
  "last_answer_correct",
]);

export const isTwoWay = (card) => card?.cat === "vocab" || card?.cat === "expr";

// The directions a card can be asked in.
export const directionsOf = (card) => (isTwoWay(card) ? DIRECTIONS : ["fr"]);

export const otherDirection = (dir) => (dir === "en" ? "fr" : "en");

const columnOf = (field, dir) => (dir === "en" ? `en_${field}` : field);

// One direction's FSRS state, under the plain field names — the shape
// toFsrsCard, the session builder and the progress figures all read. Missing
// fields read as a never-answered card.
export function sideOf(card, dir = "fr") {
  const get = (f) => card?.[columnOf(f, dir)];
  return {
    stability: get("stability") ?? null,
    difficulty: get("difficulty") ?? null,
    fsrs_state: get("fsrs_state") ?? 0,
    reps: get("reps") ?? 0,
    lapses: get("lapses") ?? 0,
    next_due_at: get("next_due_at") ?? null,
    last_review: get("last_review") ?? null,
    last_answer_correct: get("last_answer_correct") ?? null,
  };
}

// The inverse: plain field names back to that direction's columns, ready for
// a user_cards update and for patching the in-memory card. Only the fields
// given are mapped.
export function sideColumns(fields, dir = "fr") {
  const out = {};
  for (const f of SIDE_FIELDS) {
    if (fields && f in fields) out[columnOf(f, dir)] = fields[f];
  }
  return out;
}

// Both directions back to never answered: what "Reset all progress" writes.
//
// The French side's next_due_at is NOT NULL (migration_005 made it `not null
// default now()`), so it is set to the moment of the reset rather than
// cleared. A never-answered side's due date is never read — New is decided by
// fsrs_state alone — so the value is only there to satisfy the column. The
// first version sent null, and the live database refused the whole reset
// (2026-09-14); en_next_due_at is nullable and is cleared.
export function resetColumns(now = new Date()) {
  const blank = {
    stability: null,
    difficulty: null,
    fsrs_state: 0,
    reps: 0,
    lapses: 0,
    last_review: null,
    last_answer_correct: null,
  };
  return {
    ...sideColumns({ ...blank, next_due_at: new Date(now).toISOString() }, "fr"),
    ...sideColumns({ ...blank, next_due_at: null }, "en"),
  };
}

// Answers this page has given, laid back over a freshly fetched deck where the
// fetch doesn't have them yet.
//
// An answer is saved in the background, and a fetch can read the row before
// that save lands: the card comes back with its old state, looks due again,
// and is asked and counted a second time. `answers` maps a row_id to the
// columns this page wrote to it (either way round, or both); a way round is
// put back only where this page's last review is later than the fetch's. An
// answer given later on another device is later still, so it wins.
export function withLocalAnswers(cards, answers) {
  if (!answers || answers.size === 0) return cards;
  return cards.map((card) => {
    const written = answers.get(card.row_id);
    if (!written) return card;
    let out = card;
    for (const dir of DIRECTIONS) {
      const col = columnOf("last_review", dir);
      if (!written[col]) continue;
      const mine = new Date(written[col]).getTime();
      const theirs = card[col] ? new Date(card[col]).getTime() : -Infinity;
      if (!(mine > theirs)) continue;
      const side = {};
      for (const f of SIDE_FIELDS) {
        const c = columnOf(f, dir);
        if (c in written) side[c] = written[c];
      }
      out = { ...out, ...side };
    }
    return out;
  });
}

// A card asked one way: the unit a block is made of. The same card can be in a
// block twice, once each way, so anything that tells queue entries apart —
// corrections, unsaved answers, the card kept on screen across a new block —
// keys on this, never on the card alone.
export const itemKey = (item) => `${item?.row_id ?? item?.id}:${item?.shownDir ?? "fr"}`;
