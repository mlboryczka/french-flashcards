// Where the student is: the set of cards they are working through, kept in
// this browser so a reload — which is also how an update arrives — puts them
// back on the same card instead of "Card 1 of 50" of a new set.
//
// Until 2026-09-26 the set lived only in the open page. Reloading, an update,
// Chrome reloading a background tab, or going from a lesson to All and back
// all dealt a new set: the count went back to 1, the running score was lost,
// and a missed card lined up to come back later in the set was dropped. The
// owner's adverb lesson lost five of those going to All after 11 cards.
//
// The owner's choices (2026-09-26):
//   • each lesson and the whole deck keep a set of their own, so going from
//     one to another and back carries on where the student was;
//   • a set is kept for the day it was dealt; the next day starts afresh (the
//     answers are all saved anyway);
//   • kept per browser: a phone and a laptop each have their own place.
//
// A set is kept by reference — each entry is a card and a way round, never the
// card's fields — so when it comes back the cards are read from the deck as it
// now is. Pure apart from the storage calls, which are wrapped: storage throws
// in private windows and when it is full, and a lost place only costs a new set.

import { isTwoWay } from "./directions.js";

const KEY = "study-place:";
const VERSION = 1;

export function readPlace(userId) {
  if (!userId) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY + userId) || "null");
    if (!parsed || parsed.v !== VERSION || typeof parsed.sets !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Writes this page's set for `key`, and where the student is, over whatever is
// stored — another tab of the app may have written its own set meanwhile.
// Sets from earlier days are dropped.
export function writePlace(userId, { key, set, current, today }) {
  if (!userId) return;
  try {
    const stored = readPlace(userId) || { v: VERSION, sets: {} };
    const sets = {};
    for (const [k, s] of Object.entries(stored.sets || {})) if (s?.day === today) sets[k] = s;
    if (key && set) sets[key] = set;
    localStorage.setItem(KEY + userId, JSON.stringify({ v: VERSION, current, sets }));
  } catch {
    // Storage full or blocked: the place is a convenience, not a record.
  }
}

// Every set dropped, the choice of lesson and direction kept: after "Reset all
// progress", whose sets hold answers that no longer apply.
export function dropSets(userId) {
  const stored = readPlace(userId);
  if (!stored) return;
  try {
    localStorage.setItem(KEY + userId, JSON.stringify({ ...stored, sets: {} }));
  } catch { /* storage blocked */ }
}

export function clearStudyPlace(userId) {
  try {
    if (userId) localStorage.removeItem(KEY + userId);
    else for (const k of Object.keys(localStorage)) if (k.startsWith(KEY)) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
}

// A set, as it is kept.
//   entries  each card and way round: row id, direction, what it was dealt as,
//            and whether it is a retry (with the retry's own id)
//   idx      the entry on screen
//   face     whether that card's answer has been seen, and what was typed: a
//            card whose answer was seen comes back showing it, so it can't be
//            graded as if seen for the first time
export function packSet({ deck, idx, stats, done, answers, blockStart, face, day, dir, seq }) {
  return {
    day,
    dir,
    seq: seq ?? null,
    idx,
    done: !!done,
    stats,
    blockStart: blockStart || null,
    face: face || null,
    answers: [...(answers || [])],
    entries: deck.map((c) => ({
      r: c.row_id,
      d: c.shownDir || "fr",
      b: c._bucket || null,
      ...(c._retry ? { t: 1, i: c._rid || null } : null),
    })),
  };
}

// The set's entries back, from the deck as it now is. An entry whose card has
// gone — deleted, archived, or no longer asked that way round — is dropped,
// and the position moves with it.
export function unpackEntries(saved, cards) {
  const byRow = new Map((cards || []).map((c) => [c.row_id, c]));
  const entries = [];
  let idx = saved?.idx ?? 0;
  (saved?.entries || []).forEach((e, i) => {
    const card = byRow.get(e.r);
    if (!card || (e.d === "en" && !isTwoWay(card))) {
      if (i < (saved.idx ?? 0)) idx--;
      return;
    }
    entries.push({
      ...card,
      shownDir: e.d,
      flippable: isTwoWay(card),
      _bucket: e.b || undefined,
      ...(e.t ? { _retry: true, _rid: e.i || undefined } : null),
    });
  });
  return { entries, idx: Math.max(0, Math.min(idx, entries.length - 1)) };
}
