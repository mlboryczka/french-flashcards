// A student's answers as FSRS histories. Pure. Read by the server
// (api/fsrs-fit.js): the fitting learns the student's settings from these, and
// every card's memory estimate is worked out from its own history again
// whenever the settings change.
//
// A history is one card asked one way round, from card_reviews: only the
// answers FSRS counted (the first of each day), in the order they were given.

import { createEmptyCard } from "ts-fsrs";
import { toFsrsTime, scheduler as current, Rating, State } from "./spacedRepetition.js";

const DAY_MS = 86400000;

// The student's day an answer falls on, as a whole number: days 4am to 4am in
// their own time zone (lib/studyDay.js). Two answers' difference is the number
// of days FSRS counts between them.
export const studyDayNumber = (ms, timeZone) => Math.floor(toFsrsTime(ms, timeZone) / DAY_MS);

// card_reviews rows → [{ key, cardId, dir, fresh, seed, answers: [{ at, got }] }]
//
// `fresh`: the history starts at the card's very first answer. Only those can
// teach the fitting, which needs to see a card from the beginning.
//
// A card answered before the app kept every answer (2026-09-14) starts from
// the state it had then, read off its first recorded answer (`seed`). And
// "Reset all progress" puts a card back to never answered while keeping its
// answers on record, so its history starts again at the last answer it was
// given as a new card.
export function buildHistories(rows) {
  const byItem = new Map();
  for (const r of rows || []) {
    if (!r || !r.counted) continue;
    const at = Date.parse(r.answered_at);
    if (!Number.isFinite(at)) continue;
    const dir = r.direction === "en" ? "en" : "fr";
    const key = `${r.card_id}:${dir}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({ r, at });
  }
  const out = [];
  for (const [key, list] of byItem) {
    list.sort((a, b) => a.at - b.at);
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].r.state_before === State.New) { start = i; break; }
    }
    const first = list[start].r;
    const fresh = (first.state_before ?? State.New) === State.New;
    out.push({
      key,
      cardId: first.card_id,
      dir: key.endsWith(":en") ? "en" : "fr",
      fresh,
      seed: fresh ? null : {
        state: first.state_before,
        stability: first.stability_before,
        difficulty: first.difficulty_before,
        last_review: first.last_review_before,
      },
      answers: list.slice(start).map(({ r, at }) => ({ at, got: !!r.correct })),
    });
  }
  return out;
}

// What the fitting is given: each fresh history as right/wrong grades (3 / 1)
// with the days between them. The first answer's gap is 0; a second answer on
// the same day is left out, as the app leaves it out.
export function fittingSequences(histories, timeZone) {
  const seqs = [];
  for (const h of histories) {
    if (!h.fresh) continue;
    const reviews = [];
    let prevDay = null;
    for (const a of h.answers) {
      const day = studyDayNumber(a.at, timeZone);
      if (prevDay !== null && day <= prevDay) continue;
      reviews.push({ rating: a.got ? 3 : 1, deltaT: prevDay === null ? 0 : day - prevDay, at: a.at });
      prevDay = day;
    }
    if (reviews.length >= 2) seqs.push(reviews);
  }
  return seqs;
}

// A history's memory estimate under a set of settings: its answers played
// through FSRS in order, exactly as the app schedules them one at a time.
// Returns { stability, difficulty, lastAnswerAt }.
export function replayHistory(h, { sched = current, timeZone } = {}) {
  const t = (ms) => new Date(toFsrsTime(ms, timeZone));
  let card;
  if (h.fresh) {
    card = createEmptyCard(t(h.answers[0].at));
  } else {
    const last = h.seed.last_review ? Date.parse(h.seed.last_review) : NaN;
    card = {
      ...createEmptyCard(t(h.answers[0].at)),
      state: h.seed.state ?? State.Review,
      stability: h.seed.stability ?? 0,
      difficulty: h.seed.difficulty ?? 0,
      reps: 1,
      last_review: Number.isFinite(last) ? t(last) : undefined,
    };
  }
  for (const a of h.answers) {
    card = sched.next(card, t(a.at), a.got ? Rating.Good : Rating.Again).card;
  }
  return { stability: card.stability, difficulty: card.difficulty, lastAnswerAt: h.answers[h.answers.length - 1].at };
}
