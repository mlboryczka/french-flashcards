// The Stats page over time, worked out from the record of answers
// (card_reviews). Pure: no React, no Supabase.
//
// The page's other figures read each card's state now (lib/progress.js). These
// read what it was on earlier days, so a student can see their ~N remembered
// rise, what each lesson gained in the last 7 days, the days they studied, and
// when at their pace they'll have seen every card (owner, 2026-10-06).
//
// ~N remembered on an earlier day is the same sum as now, each card's chance
// of being right both ways, read at the end of that day from the answers given
// up to then: an answer's record keeps the memory strength it left
// (stability_after), and the chance falls from there with time exactly as it
// does for the card now. Only answers FSRS counted, the first of each day,
// carry a strength.
//
// A card's history starts again the last time it was answered as a new card,
// as in lib/fsrsHistory.js: "Reset all progress" keeps the record. A card that
// is not yet seen now counts for nothing on any day, so a reset student's
// chart starts again rather than showing what they wiped.
//
// Days are the student's own, 4am to 4am (lib/studyDay.js).

import { retrievability, areaOf } from "./progress.js";
import { isTwoWay } from "./directions.js";
import { State } from "./spacedRepetition.js";
import { localISODate, startOfLocalDay } from "./studyDay.js";

// The columns this needs, for the select.
export const HISTORY_COLUMNS = "id, card_id, direction, answered_at, correct, counted, state_before, stability_after";

const NEW = State.New;

// One way round of a card, as retrievability() reads it, from the answer that
// set it.
const sideAfter = (rec) => ({
  fsrs_state: State.Review,
  stability: rec.stability_after,
  last_review: rec.answered_at,
  last_answer_correct: rec.correct,
});

const isSeenNow = (card) =>
  (card.fsrs_state ?? NEW) !== NEW || (isTwoWay(card) && (card.en_fsrs_state ?? NEW) !== NEW);

// The start of each of the student's days from `first` to `now`, oldest first.
function dayStarts(first, now) {
  const out = [];
  const d = new Date(startOfLocalDay(new Date(first)));
  const last = startOfLocalDay(new Date(now));
  while (d.getTime() <= last) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// cards: the student's deck (each with row_id). rows: their card_reviews,
// any order, counted or not, with HISTORY_COLUMNS.
export function statsOverTime({ cards, rows, now = Date.now() }) {
  const byRowId = new Map();
  for (const c of cards || []) if (c.row_id != null) byRowId.set(c.row_id, c);

  // Every answer on a card still in the deck, in the order given.
  const records = [];
  const seenIds = new Set();
  for (const r of rows || []) {
    if (!r || seenIds.has(r.id)) continue;
    const at = Date.parse(r.answered_at);
    const card = byRowId.get(r.card_id);
    if (!Number.isFinite(at) || at > now || !card) continue;
    seenIds.add(r.id);
    records.push({ ...r, at, card });
  }
  records.sort((a, b) => a.at - b.at);

  // Each card's counted answers each way round, since it was last new.
  const lives = new Map(); // row_id -> { card, fr: [], en: [], firstId, firstAt }
  for (const rec of records) {
    if (!rec.counted) continue;
    let life = lives.get(rec.card_id);
    if (!life) lives.set(rec.card_id, (life = { card: rec.card, fr: [], en: [] }));
    const list = rec.direction === "en" ? life.en : life.fr;
    // Answered as new again: the history before is over.
    if (rec.state_before === NEW) list.length = 0;
    list.push(rec);
  }
  for (const life of lives.values()) {
    // When the card was first met, and by which answer: the earlier of the two
    // ways' first answers, if that answer met it as new. A card already
    // studied when the record began (2026-09-14) was met before it.
    let first = null;
    for (const list of [life.fr, life.en]) if (list.length && (!first || list[0].at < first.at)) first = list[0];
    life.firstId = first && first.state_before === NEW ? first.id : null;
    life.firstAt = first ? (first.state_before === NEW ? first.at : -Infinity) : Infinity;
    life.counts = isSeenNow(life.card);
    life.area = areaOf(life.card, now);
    life.twoWay = isTwoWay(life.card);
  }
  const counting = [...lives.values()].filter((l) => l.counts);

  // ~N remembered at time t, for the whole deck and each area (keyed as
  // areaOf() names them, by where the card belongs today).
  function rememberedAt(t) {
    const byArea = {};
    let all = 0;
    for (const life of counting) {
      const at = (list) => {
        let rec = null;
        for (const r of list) { if (r.at > t) break; rec = r; }
        return rec ? retrievability(sideAfter(rec), t) : 0;
      };
      const fr = at(life.fr);
      const chance = life.twoWay ? fr * at(life.en) : fr;
      all += chance;
      byArea[life.area] = (byArea[life.area] || 0) + chance;
    }
    return { all, byArea };
  }

  // Cards met for the first time after `from` and up to `to`.
  const newMetBetween = (from, to) =>
    counting.filter((l) => l.firstAt > from && l.firstAt <= to).length;

  // Each day since the first answer: its answers split three ways (new cards,
  // reviews, retries), how many first tries were right, and ~N remembered at
  // its end (for today, now).
  const days = [];
  if (records.length) {
    const starts = dayStarts(records[0].at, now);
    const index = new Map(starts.map((s, i) => [localISODate(new Date(s)), i]));
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] - 1 : now;
      days.push({ iso: localISODate(new Date(starts[i])), start: starts[i], end, cards: 0, fresh: 0, reviews: 0, retries: 0, right: 0, remembered: 0 });
    }
    for (const rec of records) {
      const day = days[index.get(localISODate(new Date(rec.at)))];
      if (!day) continue;
      day.cards++;
      if (!rec.counted) { day.retries++; continue; }
      if (lives.get(rec.card_id)?.firstId === rec.id) day.fresh++;
      else day.reviews++;
      if (rec.correct) day.right++;
    }
    for (const day of days) day.remembered = rememberedAt(day.end).all;
  }

  return {
    days,
    firstAt: records.length ? records[0].at : null,
    rememberedAt,
    newMetBetween,
  };
}

// The end of the student's day `n` days before `now`'s: what "in the last
// 7 days" counts from.
export function endOfDayAgo(n, now = Date.now()) {
  const d = new Date(startOfLocalDay(new Date(now)));
  d.setDate(d.getDate() - n + 1);
  return d.getTime() - 1;
}

// When, at the pace of the last 14 days, every card will have been seen:
// a Date, or null with too little to go on (under a week of answers, or no new
// cards met in the last 14 days) or nothing left to see.
export function allSeenBy({ history, notSeen, now = Date.now() }) {
  if (!history?.firstAt || notSeen <= 0) return null;
  const span = Math.min(14, Math.floor((now - history.firstAt) / 86400000));
  if (span < 7) return null;
  const met = history.newMetBetween(endOfDayAgo(span, now), now);
  if (met <= 0) return null;
  const days = Math.ceil(notSeen / (met / span));
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d;
}
