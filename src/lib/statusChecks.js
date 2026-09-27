// The status check: were the student's cards shown the way FSRS and the app's
// own rules say? Pure — no React, no Supabase — so the app (the Status line in
// the profile menu) and the simulations (tests/simulate) run the same checks.
//
// It works everything out again from the record and compares:
//
//   card_reviews  every answer, with the card's state just before and after,
//                 and (migration_013) the settings it was scheduled with
//   dealt_sets    every set of cards the app dealt (migration_013)
//   user_cards    each card's schedule as it now stands
//
// Three questions, as agreed with the owner on 2026-09-27:
//
//   1. Did the app do exactly what FSRS says? Every answer is scheduled again
//      from its before-state and compared; one answer per card, each way, each
//      day; every card's schedule is its last answer's result.
//   2. Were the app's own decisions logical? Nothing asked before it was due,
//      due cards before new ones, missed cards first, new cards in the agreed
//      order, a word's two first meetings on different days, every card asked
//      one that was dealt, no card straight back.
//   3. Is it the best way? That needs the simulations. What the record can
//      say is whether FSRS's predictions match the student's real results.
//
// Answers before CHECKS_START were scheduled under older rules (UTC days, a
// three-day minimum, other starting weights) and are read only as history.
// Every day is the student's own: 4am to 4am, in the time zone the answer was
// given in.

import { State, Rating, makeScheduler, toFsrsTime } from "./spacedRepetition.js";
import { buildHistories, replayHistory } from "./fsrsHistory.js";
import { STARTING_WEIGHTS, targetOf, usableWeights } from "./fsrsSettings.js";
import { sideOf, isTwoWay, directionsOf, otherDirection } from "./directions.js";
import { classDaysOf } from "./sessionQueue.js";
import { lessonIdOf } from "./lessonSource.js";
import { classifyCard } from "./cardTypes.js";
import { isArchived } from "./archive.js";
import { CAT_DB_TO_UI } from "./cardCategories.js";
import { forgetting_curve, get_fuzz_range } from "ts-fsrs";

// The first study day checked: the day the current rules and the check
// started (2026-09-27).
export const CHECKS_START = "2026-09-27";

const DAY = 86400000;
const RECENT_DAYS = 14; // sessionQueue's "recent class"
const EXAMPLES = 6;
const MAX_INTERVAL = 3650;

// ── Days ───────────────────────────────────────────────────────────────
// A study day as a whole number, and as a date. FSRS counts the days between
// two answers as the difference of these.
const dayNo = (ms, tz) => Math.floor(toFsrsTime(ms, tz || undefined) / DAY);
const dayIso = (n) => new Date(n * DAY).toISOString().slice(0, 10);
// How a day reads in a sentence: "Sep 27".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (n) => {
  const d = new Date(n * DAY);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const labelNo = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

// A card as the app's rules read it: the shape useUserDeck gives the app.
export function deckCard(row) {
  return {
    f: row.front,
    b: row.back,
    cat: CAT_DB_TO_UI[row.category] || "vocab",
    dates: Array.isArray(row.dates) ? row.dates : [],
    id: String(row.front || "").toLowerCase().trim(),
    row_id: row.id,
    source: row.source || null,
    created_at: row.created_at || null,
    next_due_at: row.next_due_at || null,
    lapses: row.lapses ?? 0,
    stability: row.stability ?? null,
    difficulty: row.difficulty ?? null,
    fsrs_state: row.fsrs_state ?? 0,
    reps: row.reps ?? 0,
    last_review: row.last_review || null,
    last_answer_correct: row.last_answer_correct ?? null,
    en_next_due_at: row.en_next_due_at || null,
    en_lapses: row.en_lapses ?? 0,
    en_stability: row.en_stability ?? null,
    en_difficulty: row.en_difficulty ?? null,
    en_fsrs_state: row.en_fsrs_state ?? 0,
    en_reps: row.en_reps ?? 0,
    en_last_review: row.en_last_review || null,
    en_last_answer_correct: row.en_last_answer_correct ?? null,
  };
}

const keyOf = (cardId, dir) => `${cardId}:${dir === "en" ? "en" : "fr"}`;
const near = (a, b, rel = 1e-4) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── The record, indexed ────────────────────────────────────────────────
function indexRecord({ answers, cards, deals, timeZone }) {
  const byItem = new Map(); // key -> rows, oldest first
  const rows = [...(answers || [])]
    .filter((r) => r && Number.isFinite(ms(r.answered_at)))
    .sort((a, b) => ms(a.answered_at) - ms(b.answered_at));
  for (const r of rows) {
    const k = keyOf(r.card_id, r.direction);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(r);
  }
  const deck = new Map();
  for (const row of cards || []) if (row && !isArchived(row)) deck.set(row.id, deckCard(row));
  const sets = [...(deals || [])]
    .filter((d) => d && Number.isFinite(ms(d.dealt_at)))
    .sort((a, b) => ms(a.dealt_at) - ms(b.dealt_at));
  const tzOf = (x) => x?.time_zone || timeZone;
  return { rows, byItem, deck, sets, tzOf };
}

// What the record says of one card, one way round, at a moment: its last
// counted answer before `t`. `known` is false when the card's history starts
// before the record does (answered before 2026-09-14) and nothing since says
// where it stood.
function stateAt(idx, cardId, dir, t) {
  const list = idx.byItem.get(keyOf(cardId, dir)) || [];
  let last = null;
  let firstAfter = null;
  for (const r of list) {
    if (!r.counted) continue;
    if (ms(r.answered_at) < t) last = r;
    else { firstAfter = r; break; }
  }
  if (last) {
    return { known: true, isNew: false, due: ms(last.due_after), missed: last.correct === false, last };
  }
  if (firstAfter) {
    // Nothing counted before t. A first answer as a new card means it was new
    // at t; anything else started before the record.
    return firstAfter.state_before === State.New
      ? { known: true, isNew: true }
      : { known: false };
  }
  // Never answered on record: the card's own row is how it stood, unless it
  // has been answered since in a way the record doesn't show.
  const card = idx.deck.get(cardId);
  if (!card) return { known: false };
  const side = sideOf(card, dir);
  if ((side.fsrs_state ?? State.New) === State.New) return { known: true, isNew: true };
  if (side.last_review && ms(side.last_review) >= t) return { known: false };
  return { known: true, isNew: false, due: ms(side.next_due_at), missed: side.last_answer_correct === false };
}

// ── The settings an answer was scheduled with ──────────────────────────
function settingsFor(row, settings) {
  const w = usableWeights(row.weights);
  if (w && Number.isFinite(row.target)) return { weights: w, target: Math.round(row.target * 100) / 100 };
  // Recorded before migration_013: the settings in use now, if nothing has
  // changed since the answer.
  const at = ms(row.answered_at);
  const fitted = settings?.weights ? ms(settings.fitted_at) : NaN;
  const moved = ms(settings?.target_changed_at);
  if (Number.isFinite(fitted) && fitted > at) return null;
  if (Number.isFinite(moved) && moved > at) return null;
  return { weights: usableWeights(settings?.weights) || [...STARTING_WEIGHTS], target: targetOf(settings) };
}

// One answer scheduled again, the way the app is meant to: ts-fsrs, with the
// student's days, and the gap after either answer taken from the card's own
// new stability at the target (lib/spacedRepetition.js).
function reschedule(row, { weights, target }, tz) {
  const sched = makeScheduler({ weights, retention: target });
  const t = (x) => new Date(toFsrsTime(x, tz || undefined));
  const at = ms(row.answered_at);
  const lastReview = ms(row.last_review_before);
  const card = {
    due: t(at),
    stability: row.stability_before ?? 0,
    difficulty: row.difficulty_before ?? 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: row.reps_before ?? 0,
    lapses: row.lapses_before ?? 0,
    state: row.state_before ?? State.New,
    last_review: Number.isFinite(lastReview) ? t(lastReview) : undefined,
  };
  const { card: next } = sched.next(card, t(at), row.correct ? Rating.Good : Rating.Again);
  const elapsed = next.elapsed_days ?? 0;
  const days = sched.next_interval(next.stability, elapsed);
  const plain = Math.min(Math.max(1, Math.round(next.stability * sched.interval_modifier)), MAX_INTERVAL);
  const spread = plain >= 2.5 ? get_fuzz_range(plain, elapsed, MAX_INTERVAL) : { min_ivl: plain, max_ivl: plain };
  return { stability: next.stability, difficulty: next.difficulty, days, spread };
}

// ── The checks ─────────────────────────────────────────────────────────
// Each returns { id, title, status, summary, details }. status: "pass",
// "fail", or "wait" (nothing to judge yet, or waiting on the database update).
// `details` are plain sentences naming cards and days.

function nameOf(idx, cardId, dir) {
  const c = idx.deck.get(cardId);
  const front = c ? c.f : `card ${cardId}`;
  if (!c || !isTwoWay(c)) return `“${front}”`;
  return dir === "en" ? `“${c.b}” (English side up)` : `“${front}”`;
}
const when = (at, tz) => dayLabel(dayNo(at, tz));

function checkScheduling(idx, ctx) {
  const out = { id: "fsrs", title: "Every answer was scheduled the way FSRS says" };
  let checked = 0, exact = 0, unknown = 0;
  const bad = [];
  for (const r of idx.rows) {
    if (!r.counted || !ctx.inWindow(r)) continue;
    const s = settingsFor(r, ctx.settings);
    const tz = idx.tzOf(r);
    if (!s || r.stability_after == null || !r.due_after) { unknown++; continue; }
    checked++;
    const want = reschedule(r, s, tz);
    const gotDays = dayNo(ms(r.due_after), tz) - dayNo(ms(r.answered_at), tz);
    const sOk = near(want.stability, r.stability_after);
    const dOk = near(want.difficulty, r.difficulty_after);
    const inSpread = gotDays >= want.spread.min_ivl && gotDays <= want.spread.max_ivl;
    if (gotDays === want.days) exact++;
    if (!sOk || !dOk) {
      bad.push(`${nameOf(idx, r.card_id, r.direction)} on ${when(ms(r.answered_at), tz)}: its memory estimate came out as ${r.stability_after?.toFixed(1)} days, where FSRS gives ${want.stability.toFixed(1)}.`);
    } else if (gotDays !== want.days && !inSpread) {
      bad.push(`${nameOf(idx, r.card_id, r.direction)} on ${when(ms(r.answered_at), tz)}: comes back in ${plural(gotDays, "day")}, where FSRS says ${plural(want.days, "day")}.`);
    }
  }
  if (!checked) return { ...out, status: "wait", summary: unknown ? "Waiting for answers saved with their settings." : "No answers to check yet.", details: [] };
  return bad.length
    ? { ...out, status: "fail", summary: `${bad.length} of ${plural(checked, "answer")} didn't match FSRS.`, details: bad }
    : { ...out, status: "pass", summary: `All ${checked} answers match${exact < checked ? ` (${exact} to the day; the rest within FSRS's spread)` : ""}.`, details: [] };
}

function checkOnePerDay(idx, ctx) {
  const out = { id: "one-a-day", title: "FSRS counted one answer per card, each way, each day" };
  const bad = [];
  let days = 0;
  for (const [key, list] of idx.byItem) {
    const byDay = new Map();
    for (const r of list) {
      if (!ctx.inWindow(r)) continue;
      const d = dayNo(ms(r.answered_at), idx.tzOf(r));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    for (const [d, rs] of byDay) {
      days++;
      const counted = rs.filter((r) => r.counted);
      const [cardId, dir] = key.split(":");
      const name = nameOf(idx, Number(cardId), dir);
      if (counted.length > 1) bad.push(`${name} had ${counted.length} answers counted on ${dayLabel(d)}.`);
      else if (counted.length === 1 && rs[0] !== counted[0]) bad.push(`${name}: on ${dayLabel(d)} a later answer was counted instead of the first.`);
      else if (counted.length === 0 && !rs[0].counted && !earlierToday(idx, list, rs[0])) {
        bad.push(`${name}: its first answer on ${dayLabel(d)} wasn't counted.`);
      }
    }
  }
  if (!days) return { ...out, status: "wait", summary: "No answers to check yet.", details: [] };
  return bad.length
    ? { ...out, status: "fail", summary: `${plural(bad.length, "problem")} found.`, details: bad }
    : { ...out, status: "pass", summary: "One counted answer per card, each way, each day.", details: [] };
}

// A counted answer earlier the same study day, before the window: the first
// answer of the window's day isn't then expected to count.
function earlierToday(idx, list, row) {
  const tz = idx.tzOf(row);
  const d = dayNo(ms(row.answered_at), tz);
  return list.some((r) => r !== row && r.counted && ms(r.answered_at) < ms(row.answered_at) && dayNo(ms(r.answered_at), tz) === d);
}

function checkNothingLost(idx, ctx) {
  const out = { id: "kept", title: "Every card's schedule is its last answer's result" };
  const bad = [];
  const reset = [];
  let checked = 0;
  // When the settings in use change, the server works every card's estimate
  // out again from its answers (api/fsrs-fit.js) and leaves due dates alone:
  // an estimate may then be that instead of its last answer's.
  const sched = makeScheduler({ weights: usableWeights(ctx.settings?.weights) || [...STARTING_WEIGHTS] });
  const histories = new Map(buildHistories(idx.rows).map((h) => [h.key, h]));
  const reworked = (key) => {
    const h = histories.get(key);
    return h ? replayHistory(h, { sched, timeZone: ctx.timeZone || undefined }) : null;
  };
  for (const [key, list] of idx.byItem) {
    const last = [...list].reverse().find((r) => r.counted);
    // Cards last answered before the check started were scheduled under the
    // old rules, and may since have been moved by scripts run then.
    if (!last || !ctx.inWindow(last)) continue;
    const [cardIdS, dir] = key.split(":");
    const cardId = Number(cardIdS);
    const card = idx.deck.get(cardId);
    if (!card) continue; // archived: out of circulation, schedule kept as it was
    checked++;
    const side = sideOf(card, dir);
    const name = nameOf(idx, cardId, dir);
    if ((side.fsrs_state ?? State.New) === State.New) { reset.push(name); continue; }
    const lastAt = ms(last.answered_at);
    const lastReview = ms(side.last_review);
    if (!Number.isFinite(lastReview) || Math.abs(lastReview - lastAt) > 1000) {
      bad.push(`${name}: its last answer (${when(lastAt, idx.tzOf(last))}) isn't the one its schedule comes from.`);
      continue;
    }
    const due = ms(side.next_due_at);
    if (!Number.isFinite(due) || Math.abs(due - ms(last.due_after)) > 1000) {
      bad.push(`${name}: due ${side.next_due_at ? when(ms(side.next_due_at), idx.tzOf(last)) : "never"}, but its last answer set ${when(ms(last.due_after), idx.tzOf(last))}.`);
      continue;
    }
    const same = (est) => est && near(Math.fround(est.stability), side.stability ?? NaN) && near(Math.fround(est.difficulty), side.difficulty ?? NaN);
    if (last.stability_after != null && !same({ stability: last.stability_after, difficulty: last.difficulty_after }) && !same(reworked(key))) {
      bad.push(`${name}: its memory estimate is neither the one its last answer gave nor the one its answers give under the current settings.`);
    }
  }
  if (!checked) return { ...out, status: "wait", summary: "No answers to check yet.", details: [] };
  // "Reset all progress" puts every answered card back to never answered and
  // keeps the answers: most of the deck at once is that; a few cards is not.
  const massReset = reset.length > 0 && reset.length >= 0.8 * checked;
  if (reset.length && !massReset) {
    for (const name of reset) bad.push(`${name} is back to never answered, though it has answers on record.`);
  }
  const note = massReset ? `${plural(reset.length, "card was", "cards were")} put back to new, as Reset all progress does.` : "";
  const matching = checked - (massReset ? reset.length : 0);
  if (bad.length) {
    return { ...out, status: "fail", summary: `${bad.length} of ${checked} ${checked === 1 ? "card doesn't match its" : "cards don't match their"} last answer.${note ? " " + note : ""}`, details: bad };
  }
  return { ...out, status: "pass", summary: matching > 0 ? `All ${matching} cards match their last answer.${note ? " " + note : ""}` : note, details: [] };
}

function checkNotEarly(idx, ctx) {
  const out = { id: "not-early", title: "Nothing was asked before it was due" };
  const bad = [];
  const cards = new Set();
  let answersChecked = 0, dealtChecked = 0;
  for (const [, list] of idx.byItem) {
    let prev = null;
    for (const r of list) {
      if (!r.counted) continue;
      if (prev && ctx.inWindow(r) && r.state_before !== State.New) {
        answersChecked++;
        const tz = idx.tzOf(r);
        const dueDay = dayNo(ms(prev.due_after), tz);
        const onDay = dayNo(ms(r.answered_at), tz);
        if (dueDay > onDay) {
          cards.add(keyOf(r.card_id, r.direction));
          bad.push(`${nameOf(idx, r.card_id, r.direction)} was asked on ${dayLabel(onDay)}, but wasn't due until ${dayLabel(dueDay)}.`);
        }
      }
      prev = r;
    }
  }
  // And what the app dealt as due: was it?
  for (const d of idx.sets) {
    if (!ctx.dealInWindow(d)) continue;
    const at = ms(d.dealt_at);
    const tz = idx.tzOf(d);
    for (const it of d.items || []) {
      const s = stateAt(idx, it.c, it.d, at);
      if (!s.known) continue;
      dealtChecked++;
      const flag = (text) => { cards.add(keyOf(it.c, it.d)); bad.push(text); };
      if (it.b === "new") {
        if (!s.isNew) flag(`${nameOf(idx, it.c, it.d)} was dealt as new on ${when(at, tz)}, but had been answered before.`);
      } else if (s.isNew) {
        flag(`${nameOf(idx, it.c, it.d)} was dealt as due on ${when(at, tz)}, but had never been answered.`);
      } else if (dayNo(s.due, tz) > dayNo(at, tz)) {
        flag(`${nameOf(idx, it.c, it.d)} was dealt as due on ${when(at, tz)}, but wasn't due until ${when(s.due, tz)}.`);
      }
    }
  }
  if (!answersChecked && !dealtChecked) return { ...out, status: "wait", summary: "No reviews to check yet.", details: [] };
  if (bad.length) return { ...out, status: "fail", summary: `${plural(cards.size, "card was", "cards were")} asked or dealt before ${cards.size === 1 ? "it was" : "they were"} due.`, details: bad };
  const dealt = dealtChecked ? `, and every card dealt as due or new was` : "";
  return { ...out, status: "pass", summary: `All ${answersChecked} reviews were due${dealt}.`, details: [] };
}

// The cards a set could be dealt from, as the app narrows them: the type
// filter and the lesson (the set's scope), and the direction setting.
function candidateItems(idx, deal, at) {
  const [typeFilter = "all", lessonFilter = "all"] = String(deal.scope || "all|all").split("|");
  const items = [];
  for (const [id, c] of idx.deck) {
    if (c.created_at && ms(c.created_at) > at) continue;
    if (typeFilter !== "all" && classifyCard(c) !== typeFilter) continue;
    if (lessonFilter !== "all" && lessonIdOf(c) !== lessonFilter) continue;
    const dirs = directionsOf(c);
    const use = dirs.length === 1 || deal.direction === "mix" ? dirs : [deal.direction];
    for (const dir of use) items.push({ id, dir, card: c });
  }
  return { items, lessonMode: lessonFilter !== "all" };
}

function checkDueFirst(idx, ctx) {
  const out = { id: "due-first", title: "Due cards came before new ones, missed cards first" };
  if (!ctx.dealsOn) return { ...out, status: "wait", summary: ctx.dealsWaiting, details: [] };
  const bad = [];
  const badSets = new Set();
  let checked = 0;
  for (const d of idx.sets) {
    if (!ctx.dealInWindow(d)) continue;
    const at = ms(d.dealt_at);
    const tz = idx.tzOf(d);
    const today = dayNo(at, tz);
    const inSet = new Set([...(d.items || []), ...(d.kept || [])].map((x) => keyOf(x.c, x.d)));
    const dealtNew = (d.items || []).filter((x) => x.b === "new");
    const dealtReviews = (d.items || []).filter((x) => x.b === "review");
    const { items } = candidateItems(idx, d, at);
    const leftDue = [];
    for (const it of items) {
      if (inSet.has(keyOf(it.id, it.dir))) continue;
      const s = stateAt(idx, it.id, it.dir, at);
      if (!s.known || s.isNew || !Number.isFinite(s.due)) continue;
      if (dayNo(s.due, tz) <= today) leftDue.push({ ...it, due: s.due, missed: s.missed });
    }
    checked++;
    if (dealtNew.length && leftDue.length) {
      const names = leftDue.slice(0, 3).map((x) => nameOf(idx, x.id, x.dir)).join(", ");
      badSets.add(d.id);
      bad.push(`The set dealt ${when(at, tz)} took ${plural(dealtNew.length, "new card")} while ${plural(leftDue.length, "due card")} were left out: ${names}${leftDue.length > 3 ? "…" : ""}.`);
    }
    if (dealtReviews.length) {
      const missedOut = leftDue.filter((x) => x.missed);
      if (missedOut.length) {
        badSets.add(d.id);
        bad.push(`The set dealt ${when(at, tz)} left out ${plural(missedOut.length, "card")} missed last time, such as ${nameOf(idx, missedOut[0].id, missedOut[0].dir)}, while taking cards that weren't.`);
      }
      // Most overdue first: nothing left out that was due before a review
      // that was dealt.
      const latestDealt = Math.max(...dealtReviews.map((x) => {
        const s = stateAt(idx, x.c, x.d, at);
        return s.known && Number.isFinite(s.due) ? s.due : -Infinity;
      }));
      const older = leftDue.filter((x) => !x.missed && x.due < latestDealt - 1000);
      if (older.length) {
        badSets.add(d.id);
        bad.push(`The set dealt ${when(at, tz)} left out ${plural(older.length, "review")} more overdue than ones it took, such as ${nameOf(idx, older[0].id, older[0].dir)}.`);
      }
    }
  }
  if (!checked) return { ...out, status: "wait", summary: "No sets to check yet.", details: [] };
  return bad.length
    ? { ...out, status: "fail", summary: `${plural(badSets.size, "set")} of ${checked} broke the order.`, details: bad }
    : { ...out, status: "pass", summary: `All ${plural(checked, "set")} kept to it.`, details: [] };
}

// Where a new card comes in the agreed order (sessionQueue's orderNewCards),
// as a sort key: lower comes first. Cards with equal keys are shuffled.
function newCardKey(card, { lessonMode, cutoff, lessonRank }) {
  const rank = lessonRank ? lessonRank(card) : null;
  const r = Number.isFinite(rank) ? rank : Infinity;
  if (lessonMode) return [r];
  if (lessonIdOf(card)) return [3, r];
  const days = classDaysOf(card).sort();
  if (!days.length) return [2];
  const latest = days[days.length - 1];
  if (latest >= cutoff) return [0, -labelNo(latest), -days.length];
  return [1, -days.length, labelNo(days[0])];
}
const before = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -Infinity, y = b[i] ?? -Infinity;
    if (x !== y) return x < y;
  }
  return false;
};

function checkNewOrder(idx, ctx) {
  const out = { id: "new-order", title: "New cards came in the agreed order" };
  if (!ctx.dealsOn) return { ...out, status: "wait", summary: ctx.dealsWaiting, details: [] };
  const bad = [];
  let checked = 0;
  for (const d of idx.sets) {
    if (!ctx.dealInWindow(d)) continue;
    const dealtNew = (d.items || []).filter((x) => x.b === "new");
    if (!dealtNew.length) continue;
    const at = ms(d.dealt_at);
    const tz = idx.tzOf(d);
    const today = dayNo(at, tz);
    const { items, lessonMode } = candidateItems(idx, d, at);
    const cutoff = dayIso(today - RECENT_DAYS);
    const opts = { lessonMode, cutoff, lessonRank: ctx.lessonRank };
    // A card with a new item in the set has no second one to give.
    const taken = new Set([...(d.items || []), ...(d.kept || [])].filter((x) => x.b === "new").map((x) => x.c));
    const inSet = new Set([...(d.items || []), ...(d.kept || [])].map((x) => keyOf(x.c, x.d)));
    const waiting = [];
    for (const it of items) {
      if (taken.has(it.id) || inSet.has(keyOf(it.id, it.dir))) continue;
      const s = stateAt(idx, it.id, it.dir, at);
      if (!s.known || !s.isNew) continue;
      if (metOtherWayOn(idx, it.card, it.dir, at, tz)) continue;
      waiting.push(it);
    }
    checked++;
    for (const x of dealtNew) {
      const card = idx.deck.get(x.c);
      if (!card) continue;
      const k = newCardKey(card, opts);
      const ahead = waiting.find((w) => before(newCardKey(w.card, opts), k));
      if (ahead) {
        bad.push(`The set dealt ${when(at, tz)} took ${nameOf(idx, x.c, x.d)} ahead of ${nameOf(idx, ahead.id, ahead.dir)}, which comes first${lessonMode ? " in the lesson" : " (a more recent class, or one that came up more often)"}.`);
        break;
      }
    }
  }
  if (!checked) return { ...out, status: "wait", summary: "No new cards dealt yet.", details: [] };
  return bad.length
    ? { ...out, status: "fail", summary: `${plural(bad.length, "set")} took new cards out of order.`, details: bad }
    : { ...out, status: "pass", summary: `All ${plural(checked, "set")} with new cards took them in order.`, details: [] };
}

// The card was met for the very first time the other way round earlier on
// the same study day: this way waits for tomorrow.
function metOtherWayOn(idx, card, dir, at, tz) {
  if (!isTwoWay(card)) return false;
  const other = idx.byItem.get(keyOf(card.row_id, otherDirection(dir))) || [];
  const today = dayNo(at, tz);
  return other.some((r) => r.counted && r.state_before === State.New && ms(r.answered_at) < at && dayNo(ms(r.answered_at), tz) === today);
}

function checkFirstMeetings(idx, ctx) {
  const out = { id: "first-meetings", title: "A new word met one way at a time" };
  const bad = [];
  let checked = 0;
  const firsts = new Map(); // cardId -> { fr: day, en: day }
  for (const r of idx.rows) {
    if (!r.counted || r.state_before !== State.New || !ctx.inWindow(r)) continue;
    const e = firsts.get(r.card_id) || {};
    e[r.direction === "en" ? "en" : "fr"] = dayNo(ms(r.answered_at), idx.tzOf(r));
    firsts.set(r.card_id, e);
  }
  for (const [cardId, e] of firsts) {
    if (e.fr == null || e.en == null) continue;
    checked++;
    if (e.fr === e.en) bad.push(`${nameOf(idx, cardId, "fr")} was met both ways round for the first time on ${dayLabel(e.fr)}.`);
  }
  for (const d of idx.sets) {
    if (!ctx.dealInWindow(d)) continue;
    const seen = new Set();
    for (const x of (d.items || []).filter((i) => i.b === "new")) {
      checked++;
      if (seen.has(x.c)) bad.push(`The set dealt ${when(ms(d.dealt_at), idx.tzOf(d))} took ${nameOf(idx, x.c, "fr")} as new both ways round.`);
      seen.add(x.c);
    }
  }
  if (!checked) return { ...out, status: "wait", summary: "No new words to check yet.", details: [] };
  return bad.length
    ? { ...out, status: "fail", summary: `${plural(bad.length, "word")} met both ways at once.`, details: bad }
    : { ...out, status: "pass", summary: "Each new word's second way waited for another day.", details: [] };
}

function checkDealt(idx, ctx) {
  const out = { id: "dealt", title: "Every card asked came from a set, never straight back" };
  const bad = [];
  let checked = 0;
  let prev = null;
  const setsByDay = new Map();
  for (const d of idx.sets) {
    const day = dayNo(ms(d.dealt_at), idx.tzOf(d));
    if (!setsByDay.has(day)) setsByDay.set(day, []);
    setsByDay.get(day).push({ t: ms(d.dealt_at), keys: new Set([...(d.items || []), ...(d.kept || [])].map((x) => keyOf(x.c, x.d))) });
  }
  for (const r of idx.rows) {
    if (!ctx.inWindow(r)) { prev = r; continue; }
    const at = ms(r.answered_at);
    const tz = idx.tzOf(r);
    // Straight back: the same card the same way round twice running.
    if (prev && keyOf(prev.card_id, prev.direction) === keyOf(r.card_id, r.direction) && at - ms(prev.answered_at) < 30 * 60000) {
      bad.push(`${nameOf(idx, r.card_id, r.direction)} was asked twice in a row on ${when(at, tz)}.`);
    }
    prev = r;
    if (!ctx.dealsOnDay(dayNo(at, tz), tz)) continue;
    checked++;
    const today = dayNo(at, tz);
    const k = keyOf(r.card_id, r.direction);
    const inASet = (setsByDay.get(today) || []).some((d) => d.t <= at + 1000 && d.keys.has(k));
    if (!inASet) bad.push(`${nameOf(idx, r.card_id, r.direction)} was asked on ${when(at, tz)} without being in any set dealt that day.`);
  }
  if (!checked && !bad.length) return { ...out, status: "wait", summary: ctx.dealsOn ? "No answers to check yet." : ctx.dealsWaiting, details: [] };
  return bad.length
    ? { ...out, status: "fail", summary: `${plural(bad.length, "problem")} found.`, details: bad }
    : { ...out, status: "pass", summary: `All ${checked} answers came from a set.`, details: [] };
}

// FSRS's predicted chance of remembering at each answer, against what
// happened. Over the last 30 days; a group is only judged with enough answers
// behind it, since a small one is easily 10 points off by chance.
export const PREDICTION_BANDS = [[0, 0.7], [0.7, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 0.95], [0.95, 1.01]];
const BAND_MIN = 100;
const OVERALL_MIN = 300;

export function predictions(idx, ctx) {
  const since = ctx.now - 30 * DAY;
  const out = [];
  for (const r of idx.rows) {
    if (!r.counted || r.state_before === State.New || r.stability_before == null || !r.last_review_before) continue;
    const at = ms(r.answered_at);
    if (at < since || !ctx.inWindow(r)) continue;
    const tz = idx.tzOf(r);
    const elapsed = dayNo(at, tz) - dayNo(ms(r.last_review_before), tz);
    if (elapsed <= 0) continue;
    const s = settingsFor(r, ctx.settings);
    const w = s?.weights || [...STARTING_WEIGHTS];
    out.push({ p: forgetting_curve(w, elapsed, r.stability_before), got: !!r.correct });
  }
  return out;
}

function checkPredictions(idx, ctx) {
  const out = { id: "predictions", title: "FSRS's predictions match your results" };
  const ps = predictions(idx, ctx);
  if (!ps.length) return { ...out, status: "wait", summary: "No reviews in the last 30 days yet.", details: [] };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const expected = mean(ps.map((x) => x.p));
  const actual = mean(ps.map((x) => (x.got ? 1 : 0)));
  const bad = [];
  const lines = [];
  for (const [lo, hi] of PREDICTION_BANDS) {
    const g = ps.filter((x) => x.p >= lo && x.p < hi);
    if (!g.length) continue;
    const e = mean(g.map((x) => x.p)), a = mean(g.map((x) => (x.got ? 1 : 0)));
    const line = `Cards FSRS gave ${pct(lo)}–${pct(Math.min(hi, 1))}: expected ${pct(e)}, you got ${pct(a)} right (${plural(g.length, "answer")}).`;
    if (g.length >= BAND_MIN && Math.abs(a - e) > 0.1) bad.push(line);
    else lines.push(line);
  }
  if (ps.length >= OVERALL_MIN && Math.abs(actual - expected) > 0.05) {
    bad.unshift(`Overall FSRS expected ${pct(expected)} right and you got ${pct(actual)}, over ${plural(ps.length, "review")}.`);
  }
  const summary = `Expected ${pct(expected)} right, you got ${pct(actual)} (${plural(ps.length, "review")}, last 30 days).`;
  if (bad.length) return { ...out, status: "fail", summary, details: [...bad, ...lines] };
  if (ps.length < OVERALL_MIN) return { ...out, status: "wait", summary: `${summary} Too few to judge yet: needs ${OVERALL_MIN}.`, details: lines };
  return { ...out, status: "pass", summary, details: lines };
}

// ── Running them ───────────────────────────────────────────────────────
//
//   answers   card_reviews rows (all of them: earlier ones are history)
//   deals     dealt_sets rows
//   cards     user_cards rows
//   settings  the fsrs_settings row, or null
//   timeZone  the student's time zone, for rows that don't carry one
//   dealsTable  false when the database hasn't the dealt_sets table yet
//   lessonRank  the lessons' teaching order (data/lessons)
export function runStatusChecks({
  answers = [], deals = [], cards = [], settings = null, timeZone = null,
  now = Date.now(), dealsTable = true, lessonRank = null, from = CHECKS_START,
} = {}) {
  const idx = indexRecord({ answers, cards, deals, timeZone });
  const startDay = labelNo(from);
  const inWindow = (r) => dayNo(ms(r.answered_at), idx.tzOf(r)) >= startDay;
  // The sets are judged from the first study day that began with a set on
  // record: a day the app started recording partway through (the database
  // update run mid-day) would have answers from sets never recorded.
  const firstDealDay = idx.sets.length ? dayNo(ms(idx.sets[0].dealt_at), idx.tzOf(idx.sets[0])) : null;
  const dealsFromDay = firstDealDay == null ? null : Math.max(startDay, firstDealDay + 1);
  const dealsOn = dealsTable && dealsFromDay != null && idx.rows.some((r) => dayNo(ms(r.answered_at), idx.tzOf(r)) >= dealsFromDay);
  const ctx = {
    now, settings, lessonRank, inWindow, dealsOn, timeZone,
    dealsWaiting: !dealsTable
      ? "Waiting for the database update."
      : "Starts the day after the first set is recorded.",
    dealInWindow: (d) => dealsFromDay != null && dayNo(ms(d.dealt_at), idx.tzOf(d)) >= dealsFromDay,
    dealsOnDay: (day) => dealsFromDay != null && day >= dealsFromDay,
  };
  const results = [
    checkScheduling(idx, ctx),
    checkOnePerDay(idx, ctx),
    checkNothingLost(idx, ctx),
    checkNotEarly(idx, ctx),
    checkDueFirst(idx, ctx),
    checkNewOrder(idx, ctx),
    checkFirstMeetings(idx, ctx),
    checkDealt(idx, ctx),
    checkPredictions(idx, ctx),
  ].map((r) => ({ ...r, details: r.details.slice(0, EXAMPLES), more: Math.max(0, r.details.length - EXAMPLES) }));
  const counted = idx.rows.filter((r) => r.counted && inWindow(r)).length;
  const week = idx.rows.filter((r) => ms(r.answered_at) >= now - 7 * DAY);
  return {
    checkedAt: new Date(now).toISOString(),
    from,
    ok: results.every((r) => r.status !== "fail"),
    failing: results.filter((r) => r.status === "fail").length,
    answers: counted,
    week: { answers: week.length, right: week.filter((r) => r.correct).length },
    results,
  };
}

// The results as plain text, to paste to Claude.
export function statusText(report) {
  const lines = [`Status check, ${report.checkedAt.slice(0, 16).replace("T", " ")} UTC — answers from ${report.from} on.`];
  for (const r of report.results) {
    lines.push(`\n[${r.status.toUpperCase()}] ${r.title}: ${r.summary}`);
    for (const d of r.details) lines.push(`  - ${d}`);
    if (r.more) lines.push(`  - and ${r.more} more`);
  }
  return lines.join("\n");
}
