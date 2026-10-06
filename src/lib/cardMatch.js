// What happens to each card a reading of the student's notes made: it is a
// card they already have (it only adds the class date), a new card, or it
// waits. Shared by every path that writes cards from notes (the upload, the
// linked notebook's sync), so they can't decide differently, and pure apart
// from `ask`, so the status checks can run it too (2026-10-06).
//
// The owner's rules, from the plan they approved ("there should be NO
// duplicates from reuploading an updated cahier"):
//
//   A new card is compared with every card the student has: in study,
//   archived, removed by the student, and lesson cards. A card they removed
//   is still a match, so a later class can't bring it back.
//
//   A match adds the class date and nothing else. The card keeps its French,
//   English, category, schedule, answers, and whether it is in study.
//
//   The sure rule settles most cards (src/lib/sameCard.js). A near look-alike
//   is put to Claude as one question, "the same card to learn, or
//   different". If that question can't be answered, the card waits, and the
//   lines it came from stay unread, so the next run tries again. Nothing is
//   added on a guess.
//
//   Inside one reading the same rule applies: a card made from one class is
//   compared with the cards made from the others. A card only gets a label
//   in brackets when Claude says it means something different from a card
//   with the same French.

import { cardIndex, isSureMatch } from "./sameCard.js";

const isArchivedRow = (row) => typeof row?.source === "string" && row.source.startsWith("archived:");
const datesOf = (c) => (Array.isArray(c?.dates) ? c.dates.filter((d) => typeof d === "string") : []);

// A label for a card that shares its French with a different card: its
// English, or the first three words of a long one.
export function senseLabel(back) {
  const trimmed = String(back ?? "").trim();
  if (trimmed.length <= 30) return trimmed;
  return trimmed.split(/\s+/).slice(0, 3).join(" ");
}

// `incoming`: the cards a reading made, each with its class dates.
// `deck`: every row the student has (id, front, back, dates, source).
// `ask(pairs)`: Claude's question, given [{ a, b }] (a: the card already
// there, b: the new one); resolves to one "same" / "different" / null per
// pair, or throws. It is called at most once.
//
// Returns { decisions, pairs, asked, askError }. Each decision is
//   { card, action: "join", row }      the card is `row`, already in the deck
//   { card, action: "insert", insert } a new card, with the dates of every
//                                      other new card that joined it
//   { card, action: "wait" }           undecided; its classes stay unread
export async function matchNewCards({ incoming, deck, ask }) {
  const index = cardIndex(deck || []);
  const decisions = [];
  const asking = [];
  // A card of this run that is still undecided stands in the index for itself,
  // so later cards are compared with it too.
  const standIn = new Map();

  for (const card of incoming || []) {
    if (!card?.front || !card?.back) continue;
    const d = { card, action: null };
    decisions.push(d);
    const row = index.sure(card);
    if (row) {
      d.action = "join";
      d.target = row;
      continue;
    }
    const near = index.near(card);
    const self = { front: card.front, back: card.back, dates: datesOf(card), source: card.source || "cahier-upload" };
    standIn.set(self, d);
    index.add(self);
    if (near.length === 0) {
      d.action = "insert";
      continue;
    }
    d.action = "ask";
    d.near = near;
    asking.push(d);
  }

  // One question for the whole run.
  const pairs = [];
  for (const d of asking) {
    for (const other of d.near) pairs.push({ a: other, b: d.card, verdict: null });
  }
  let askError = null;
  if (pairs.length) {
    try {
      const verdicts = await ask(pairs.map(({ a, b }) => ({ a: { front: a.front, back: a.back }, b: { front: b.front, back: b.back } })));
      pairs.forEach((p, i) => {
        const v = Array.isArray(verdicts) ? verdicts[i] : null;
        p.verdict = v === "same" || v === "different" ? v : null;
      });
    } catch (e) {
      askError = e?.message || String(e);
    }
  }
  const verdictsFor = (d) => pairs.filter((p) => p.b === d.card);

  // Settle each card, in reading order. A card joined to one of this run's
  // undecided cards follows it.
  const settled = new Map();
  const deckFronts = new Set((deck || []).map((r) => r.front));
  const newFronts = new Set();
  const settle = (d) => {
    if (settled.has(d)) return settled.get(d);
    let out;
    if (d.action === "join") {
      out = followTo(d.target);
    } else if (d.action === "insert") {
      out = place(d);
    } else {
      const vs = verdictsFor(d);
      const same = vs.filter((p) => p.verdict === "same").map((p) => p.a);
      if (same.length) {
        // The card already in the deck before one made this run, and one in
        // study before one out of it.
        const rank = (c) => (standIn.has(c) ? 2 : 0) + (isArchivedRow(c) ? 1 : 0);
        out = followTo(same.slice().sort((x, y) => rank(x) - rank(y))[0]);
      } else if (vs.some((p) => p.verdict === null)) {
        out = { action: "wait" };
      } else {
        out = place(d, true);
      }
    }
    settled.set(d, out);
    return out;
  };
  // What joining `target` comes to: a deck row, or whatever became of one of
  // this run's cards.
  const followTo = (target) => {
    const d = standIn.get(target);
    if (!d) return { action: "join", row: target };
    const out = settle(d);
    return out.action === "insert" ? { action: "join-new", insert: out.insert } : out;
  };
  // A new card. Its French has to be free: the deck holds one card per front.
  // When a different card has it, this one is labelled with its English.
  const place = (d, judgedDifferent = false) => {
    const taken = (f) => deckFronts.has(f) || newFronts.has(f);
    let front = d.card.front;
    if (taken(front)) {
      const holder = (deck || []).find((r) => r.front === front);
      if (!judgedDifferent && holder) return { action: "join", row: holder };
      front = `${d.card.front} (${senseLabel(d.card.back)})`;
      if (taken(front)) {
        const same = (deck || []).find((r) => r.front === front);
        if (same) return { action: "join", row: same };
        const pending = [...settled.values()].find((o) => o.action === "insert" && o.insert.front === front);
        return pending ? { action: "join-new", insert: pending.insert } : { action: "wait" };
      }
    }
    newFronts.add(front);
    return {
      action: "insert",
      insert: {
        front,
        back: d.card.back,
        category: d.card.category || "V",
        dates: [...new Set(datesOf(d.card))].sort(),
        source: d.card.source || "cahier-upload",
        labelled: front !== d.card.front,
      },
    };
  };

  const out = decisions.map((d) => {
    const s = settle(d);
    if (s.action === "join") return { card: d.card, action: "join", row: s.row };
    if (s.action === "join-new") {
      s.insert.dates = [...new Set([...s.insert.dates, ...datesOf(d.card)])].sort();
      return { card: d.card, action: "join-new", insert: s.insert };
    }
    if (s.action === "insert") return { card: d.card, action: "insert", insert: s.insert };
    return { card: d.card, action: "wait" };
  });

  // Every question asked, with what became of both cards, for the record of
  // Claude's verdicts.
  const asked = pairs.map((p) => {
    const aDecision = standIn.get(p.a);
    const aOut = aDecision ? settled.get(aDecision) : null;
    const bOut = settled.get(decisions.find((d) => d.card === p.b));
    return {
      a: p.a, b: p.b, verdict: p.verdict,
      aRow: aDecision ? null : p.a,
      aInsert: aOut?.action === "insert" ? aOut.insert : null,
      bInsert: bOut?.action === "insert" ? bOut.insert : null,
    };
  });
  return { decisions: out, asked, askError, questions: pairs.length };
}

// The classes that wait: every class of a card that waits, and the classes
// the reading couldn't read at all. Nothing is written with one of those
// dates, so a waiting class is read again whole.
export function waitingDates(decisions, failedDates = []) {
  const waiting = new Set(failedDates);
  for (const d of decisions || []) if (d.action === "wait") for (const date of datesOf(d.card)) waiting.add(date);
  return waiting;
}

// What to write: new cards, and the dates to add to cards already there, with
// no waiting class's date on any of them. A card left with no date that may
// be written is left out, to be made again when its class is read again.
export function plannedWrites(decisions, waiting = new Set()) {
  const keep = (dates) => [...new Set(dates)].filter((d) => !waiting.has(d)).sort();
  const inserts = [];
  const seen = new Set();
  const addDates = new Map();
  let joined = 0;
  for (const d of decisions || []) {
    if (d.action === "insert" || d.action === "join-new") {
      if (seen.has(d.insert)) { if (d.action === "join-new") joined++; continue; }
      seen.add(d.insert);
      const dates = keep(d.insert.dates);
      const hadDates = d.insert.dates.length > 0;
      if (hadDates && dates.length === 0) continue;
      inserts.push({ ...d.insert, dates });
      if (d.action === "join-new") joined++;
    } else if (d.action === "join") {
      const dates = keep(datesOf(d.card));
      const allWaiting = datesOf(d.card).length > 0 && dates.length === 0;
      if (allWaiting) continue;
      joined++;
      const row = d.row;
      if (!addDates.has(row)) addDates.set(row, new Set());
      for (const x of dates) addDates.get(row).add(x);
    }
  }
  // Only rows that actually gain a date are written.
  const updates = [];
  for (const [row, dates] of addDates) {
    const have = new Set(datesOf(row));
    const gain = [...dates].filter((x) => !have.has(x)).sort();
    if (gain.length && row.id != null) updates.push({ row, id: row.id, dates: gain, merged: [...new Set([...have, ...gain])].sort() });
  }
  return { inserts, updates, joined, rowsSeenAgain: addDates.size };
}

export { isSureMatch };
