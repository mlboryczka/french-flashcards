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
// And since 2026-10-06, two checks of the deck itself, after the owner's
// "there should be NO duplicates from reuploading an updated cahier" and
// "make sure the evaluation harness is catching this properly": no card in
// study twice, and nothing the student deleted or corrected back. They read
// two more records:
//
//   card_pairs        Claude's verdicts on look-alike cards (migration_016)
//   parse_corrections the owner's corrections of cards (migration_002)
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
import { cardIndex, isSureMatch, isListPart, sureKey } from "./sameCard.js";
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
  // A set the app replaced before anything in it was answered: the next set
  // is dealt in the same place with no answer in between — the up-to-date
  // cards, or a class's notes, arriving seconds after the first. Nothing in
  // it was asked, so it isn't judged; the set that replaced it is
  // (2026-10-04: a set dealt from the browser's old copy, replaced twelve
  // seconds later, failed two checks).
  const replaced = new Set();
  const times = rows.map((r) => ms(r.answered_at));
  let j = 0;
  for (let i = 0; i + 1 < sets.length; i++) {
    const s = sets[i], next = sets[i + 1];
    if ((s.scope || "all|all") !== (next.scope || "all|all")) continue;
    while (j < times.length && times[j] < ms(s.dealt_at)) j++;
    if (j >= times.length || times[j] >= ms(next.dealt_at)) replaced.add(s);
  }
  return { rows, byItem, deck, sets, tzOf, replaced, classArrived: classArrivals(cards, timeZone), datesMoved: datesMoved(cards) };
}

// Class dates a card may have gained when a repeat of it was put away: the
// clean-up of 2026-10-06 moved each put-away card's dates onto the card kept,
// after sets that never saw them there (four of the owner's sets then failed
// "New cards came in the agreed order" over "lourd (adj)", which had gained
// a class from "lourd, lourde (adj)"). card row id -> [{ at, dates }].
//
// The repeat is the card named by merged_into (migration_016). A card put away
// before then names nothing, so a card out of study with no reason that the
// card-writers' rule or near search says looks like the card stands in. When
// it was put away is archived_at, else the row's last change.
function datesMoved(rows) {
  const out = new Map();
  const add = (id, r) => {
    const at = Number.isFinite(ms(r.archived_at)) ? ms(r.archived_at) : Number.isFinite(ms(r.updated_at)) ? ms(r.updated_at) : Infinity;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ at, dates: new Set(r.dates) });
  };
  const live = (rows || []).filter((r) => r && r.id != null && r.front && !isArchived(r) && Array.isArray(r.dates) && r.dates.length);
  const liveIds = new Set(live.map((r) => String(r.id)));
  const away = (rows || []).filter((r) => r && r.front && isArchived(r) && Array.isArray(r.dates) && r.dates.length);
  for (const r of away) if (r.merged_into != null && liveIds.has(String(r.merged_into))) add(r.merged_into, r);
  const unnamed = away.filter((r) => r.merged_into == null && r.archived_reason == null);
  if (unnamed.length) {
    const index = cardIndex(unnamed);
    for (const c of live) {
      for (const h of [index.sure(c), ...index.near(c)]) {
        if (h && h.dates.some((d) => c.dates.includes(d))) add(c.id, h);
      }
    }
  }
  return out;
}

// When each class's notes arrived: the first card carrying its date that was
// made on or after that day, which only a notes upload does. A date with no
// such card was added to cards already there, at a time the record doesn't
// keep.
function classArrivals(rows, tz) {
  const at = new Map();
  for (const row of rows || []) {
    const t = ms(row?.created_at);
    if (!Number.isFinite(t) || !Array.isArray(row.dates)) continue;
    for (const d of row.dates) {
      if (typeof d !== "string" || dayNo(t, tz) < labelNo(d)) continue;
      if (!at.has(d) || t < at.get(d)) at.set(d, t);
    }
  }
  return at;
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
    if (!ctx.dealJudged(d)) continue;
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
// filter and the lesson (the set's scope), and the direction setting. Since
// 2026-10-04 a set on Cards also says what it left out (lib/lessonChoice.js):
// "|cahier" for the student's own cards only, "|off=a,b" for lessons
// switched off.
function candidateItems(idx, deal, at) {
  const [typeFilter = "all", lessonFilter = "all", narrowed = ""] = String(deal.scope || "all|all").split("|");
  const ownOnly = narrowed === "cahier";
  const off = new Set(narrowed.startsWith("off=") ? narrowed.slice(4).split(",") : []);
  const items = [];
  for (const [id, c] of idx.deck) {
    if (c.created_at && ms(c.created_at) > at) continue;
    if (typeFilter !== "all" && classifyCard(c) !== typeFilter) continue;
    if (lessonFilter !== "all" && lessonIdOf(c) !== lessonFilter) continue;
    if (lessonFilter === "all" && lessonIdOf(c) && (ownOnly || off.has(lessonIdOf(c)))) continue;
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
    if (!ctx.dealJudged(d)) continue;
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
// `has` says which of its class dates count: those the app knew of then.
function newCardKey(card, { lessonMode, cutoff, lessonRank }, has = () => true) {
  const rank = lessonRank ? lessonRank(card) : null;
  const r = Number.isFinite(rank) ? rank : Infinity;
  if (lessonMode) return [r];
  if (lessonIdOf(card)) return [3, r];
  const days = classDaysOf(card).filter((d) => card.source === "tutor-chat" || has(d)).sort();
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
    if (!ctx.dealJudged(d)) continue;
    const dealtNew = (d.items || []).filter((x) => x.b === "new");
    if (!dealtNew.length) continue;
    const at = ms(d.dealt_at);
    const tz = idx.tzOf(d);
    const today = dayNo(at, tz);
    const { items, lessonMode } = candidateItems(idx, d, at);
    const cutoff = dayIso(today - RECENT_DAYS);
    const opts = { lessonMode, cutoff, lessonRank: ctx.lessonRank };
    // The class dates the app knew of when it dealt the set. A date after
    // the set's day it can't have (notes come after the class); one whose
    // notes had arrived it had; any other is uncertain, and an order that
    // hangs on it isn't judged (2026-10-04: sets dealt before a class's
    // notes arrived were faulted for not putting that class first).
    const known = (iso) => labelNo(iso) > today ? "no" : idx.classArrived.get(iso) <= at ? "yes" : "maybe";
    const sure = (iso) => known(iso) === "yes";
    // A card whose class dates may have changed since the set was dealt (a
    // repeat put away into it, datesMoved) can't be placed as it stood then.
    const changed = (card) => (idx.datesMoved.get(card.row_id) || []).some((m) => m.at > at && card.dates.some((d) => m.dates.has(d)));
    const keyed = (card) => ({
      card,
      changed: changed(card),
      unsure: card.source === "tutor-chat" ? [] : classDaysOf(card).filter((iso) => known(iso) === "maybe"),
      key: newCardKey(card, opts, sure),
    });
    // `w` comes before `x` however the uncertain dates stood.
    const surelyBefore = (w, x) => {
      if (w.changed || x.changed) return false;
      if (!w.unsure.length && !x.unsure.length) return before(w.key, x.key);
      const unsure = [...new Set([...w.unsure, ...x.unsure])];
      if (unsure.length > 4) return false;
      for (let m = 0; m < 1 << unsure.length; m++) {
        const has = (iso) => sure(iso) || unsure.some((u, i) => u === iso && m & (1 << i));
        if (!before(newCardKey(w.card, opts, has), newCardKey(x.card, opts, has))) return false;
      }
      return true;
    };
    // A card with a new item in the set has no second one to give.
    const taken = new Set([...(d.items || []), ...(d.kept || [])].filter((x) => x.b === "new").map((x) => x.c));
    const inSet = new Set([...(d.items || []), ...(d.kept || [])].map((x) => keyOf(x.c, x.d)));
    const waiting = [];
    for (const it of items) {
      if (taken.has(it.id) || inSet.has(keyOf(it.id, it.dir))) continue;
      const s = stateAt(idx, it.id, it.dir, at);
      if (!s.known || !s.isNew) continue;
      if (metOtherWayOn(idx, it.card, it.dir, at, tz)) continue;
      waiting.push({ ...it, ...keyed(it.card) });
    }
    checked++;
    for (const x of dealtNew) {
      const card = idx.deck.get(x.c);
      if (!card) continue;
      const dealt = keyed(card);
      const ahead = waiting.find((w) => surelyBefore(w, dealt));
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
    if (!ctx.dealJudged(d)) continue;
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

// ── The deck: no card twice, nothing back ─────────────────────────────
//
// Both judge with the code every card-writer uses to decide whether a new
// card is one the student already has (src/lib/sameCard.js), imported, never
// copied, so the check and the card-writers can't come to mean different
// things by "the same card".

// How many look-alike pairs the morning check (api/_lib/statusDaily.js) puts
// to Claude for one student in a day. A deck read before the 2026-10-06 fix
// has a backlog (the owner's raised 875 pairs), worked through over a few
// mornings; after that, the cards a day adds raise a handful.
export const LOOKALIKES_PER_DAY = 200;

const tidyText = (s) => String(s ?? "").normalize("NFC").replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();
const pairKey = (x, y) => {
  const [a, b] = [String(x), String(y)].sort((p, q) => (Number(p) - Number(q)) || (p < q ? -1 : p > q ? 1 : 0));
  return `${a}|${b}`;
};
const isLesson = (row) => typeof row?.source === "string" && row.source.startsWith("lesson:");
const quoted = (row) => `“${row.front}”${isLesson(row) ? " (from a lesson)" : ""}`;
const listed = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const TIMES = ["", "once", "twice", "three times", "four times", "five times"];

// The cards in study that are one card twice or more, by the sure rule and by
// Claude's verdicts, and the look-alike pairs Claude hasn't judged yet.
//
//   cards  user_cards rows (archived ones are left out here)
//   pairs  card_pairs rows: Claude's verdicts, from an upload, the sync or the
//          morning check
//
// A verdict counts only while both cards still read as they did when Claude
// judged them: a card edited since is a new question. The latest verdict on a
// pair is the one that counts.
export function lookalikes({ cards = [], pairs = [] } = {}) {
  const inStudy = (cards || []).filter((r) => r && r.id != null && r.front && !isArchived(r));
  const byId = new Map(inStudy.map((r) => [String(r.id), r]));

  // The sure rule, run on every two cards whose French it reads alike, or
  // where one is an item of the other's list ("à l'heure" and "à temps /
  // à l'heure"), as a card-writer meets them (cardIndex.sureAll).
  const parent = new Map(inStudy.map((r) => [String(r.id), String(r.id)]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const index = cardIndex(inStudy);
  const surely = new Set();
  for (const r of inStudy) {
    for (const c of index.sureAll(r)) {
      if (c.id == null || !byId.has(String(c.id))) continue;
      parent.set(find(String(r.id)), find(String(c.id)));
      surely.add(pairKey(r.id, c.id));
    }
  }
  const comps = new Map();
  for (const r of inStudy) {
    const root = find(String(r.id));
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root).push(r);
  }
  const byAge = (x, y) => (Number(x.id) - Number(y.id)) || (String(x.id) < String(y.id) ? -1 : 1);
  const groups = [...comps.values()].filter((g) => g.length > 1).map((g) => g.sort(byAge));

  // Claude's verdicts that still hold.
  const verdicts = new Map();
  const reads = (row, front, back) => tidyText(row.front) === tidyText(front) && tidyText(row.back) === tidyText(back);
  for (const p of pairs || []) {
    if (!p || p.card_a == null || p.card_b == null || (p.verdict !== "same" && p.verdict !== "different")) continue;
    const a = byId.get(String(p.card_a));
    const b = byId.get(String(p.card_b));
    if (!a || !b || a === b || !reads(a, p.a_front, p.a_back) || !reads(b, p.b_front, p.b_back)) continue;
    const key = pairKey(a.id, b.id);
    const at = ms(p.asked_at);
    const had = verdicts.get(key);
    if (!had || (Number.isFinite(at) && !(at < had.at))) verdicts.set(key, { verdict: p.verdict, at, a, b });
  }
  const same = [...verdicts.entries()]
    .filter(([key, v]) => v.verdict === "same" && !surely.has(key))
    .map(([, v]) => ({ a: [v.a, v.b].sort(byAge)[0], b: [v.a, v.b].sort(byAge)[1], at: v.at }));

  // The near search, as a new card meets it: every two cards in study that
  // look alike without being surely one card.
  const near = new Map();
  for (const r of inStudy) {
    for (const n of index.near(r)) {
      if (n.id == null || !byId.has(String(n.id))) continue;
      const key = pairKey(r.id, n.id);
      if (!near.has(key)) near.set(key, [r, n].sort(byAge));
    }
  }
  // Newest cards first: those are the likeliest new repeats.
  const unjudged = [...near.entries()].filter(([key]) => !verdicts.has(key)).map(([, [a, b]]) => ({ a, b }))
    .sort((x, y) => byAge(y.b, x.b) || byAge(y.a, x.a));
  return { inStudy, groups, same, unjudged, judged: near.size - unjudged.length, verdicts: verdicts.size };
}

function checkNoRepeats(cards, ctx) {
  const out = { id: "repeats", title: "No card is in your deck twice" };
  const rep = lookalikes({ cards, pairs: ctx.pairs || [] });
  if (!rep.inStudy.length) return { ...out, status: "wait", summary: "No cards in study yet.", details: [] };
  const bad = [];
  for (const g of rep.groups) {
    const list = g.some((x) => g.some((y) => x !== y && isListPart(x, y)));
    const why = list ? `a list card and ${g.length === 2 ? "an item" : "items"} on it, with English that agrees` : "the same French, and English that agrees";
    bad.push(`${listed(g.map(quoted))} are one card ${TIMES[g.length] || `${g.length} times`}: ${why}.`);
  }
  for (const p of rep.same) {
    const on = Number.isFinite(p.at) ? ` on ${when(p.at, ctx.timeZone)}` : "";
    bad.push(`${quoted(p.a)} and ${quoted(p.b)} are one card twice: Claude judged them the same card to learn${on}.`);
  }
  if (bad.length) {
    const extra = rep.groups.reduce((n, g) => n + g.length - 1, 0) + rep.same.length;
    return { ...out, status: "fail", summary: `${plural(extra, "card")} in study ${extra === 1 ? "repeats" : "repeat"} another card.`, details: bad };
  }
  const n = rep.inStudy.length;
  const sure = `No two of your ${plural(n, "card")} in study are surely the same card`;
  if (!ctx.pairsTable) {
    return { ...out, status: "wait", summary: `${sure}. Look-alikes wait for the database update (migration_016), which keeps Claude's verdicts on them.`, details: [] };
  }
  if (!ctx.pairs) return { ...out, status: "wait", summary: `${sure}. Claude's verdicts on look-alikes weren't read.`, details: [] };
  if (rep.unjudged.length) {
    const left = rep.unjudged.length;
    return {
      ...out, status: "wait",
      summary: `${sure}, and none Claude has judged the same. ${plural(left, "look-alike pair")} ${left === 1 ? "is" : "are"} still to be put to Claude; the morning check asks about up to ${LOOKALIKES_PER_DAY} a day.`,
      details: [],
    };
  }
  const how = rep.judged
    ? `by the rule, and Claude judged ${rep.judged === 1 ? "the one look-alike pair" : `all ${rep.judged} look-alike pairs`} different`
    : "by the rule, and none look alike";
  return { ...out, status: "pass", summary: `None of your ${plural(n, "card")} in study is there twice: ${how}.`, details: [] };
}

// What the student took out or put right, and must not see again:
//   a card they removed in the app (archived_reason "removed", migration_016);
//   a card the owner deleted, logged in parse_corrections before Remove kept
//   the row (Naza, deleted in April, was back on 4 September);
//   the form a card had before the owner corrected it ("Je parle jamais de
//   Pierre." with its full stop, also back on 4 September). A form a later
//   correction put back is wanted again, and isn't watched.
function unwanted(cards, corrections) {
  const out = [];
  for (const r of cards || []) {
    if (r && isArchived(r) && r.archived_reason === "removed") {
      out.push({ kind: "removed", front: r.front, back: r.back, at: ms(r.archived_at), id: r.id });
    }
  }
  const rows = (corrections || []).filter((c) => c && (c.action === "delete" || c.action === "edit") && c.original_front)
    .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  rows.forEach((c, i) => {
    const at = ms(c.created_at);
    if (c.action === "delete") {
      out.push({ kind: "deleted", front: c.original_front, back: c.original_back, at, id: c.card_id });
      return;
    }
    const frontChanged = tidyText(c.original_front) !== tidyText(c.corrected_front);
    const backChanged = tidyText(c.original_back) !== tidyText(c.corrected_back);
    if (!frontChanged && !backChanged) return; // a save that changed nothing
    const putBack = rows.slice(i + 1).some((l) => l.action === "edit" &&
      tidyText(l.corrected_front) === tidyText(c.original_front) &&
      (frontChanged || tidyText(l.corrected_back) === tidyText(c.original_back)));
    if (putBack) return;
    out.push({
      kind: "corrected", front: c.original_front, back: c.original_back, at, id: c.card_id,
      to: { front: c.corrected_front, back: c.corrected_back }, frontChanged,
      // Whether the rule can tell the two Frenches apart. When it can't (a
      // full stop, a capital, a label), only the exact French is the wrong one.
      ruleTells: sureKey(c.original_front, c.original_back).key !== sureKey(c.corrected_front, c.corrected_back).key,
    });
  });
  return out;
}

// Whether card `r`, in study, is `u` back. A card made before `u` was taken
// out or corrected isn't: it was there already (the card a duplicate was
// deleted beside, or the corrected card itself). Nor is one item of a list
// card that was taken out: the owner deleted "pas mal = beaucoup" (not bad =
// a lot), a gloss written as a card, not the word "pas mal" their notes
// taught again (2026-10-07).
function isBack(r, u) {
  const made = ms(r.created_at);
  const madeAfter = Number.isFinite(made) && Number.isFinite(u.at) && made > u.at;
  const itself = u.id != null && String(r.id) === String(u.id);
  const same = (x, y) => isSureMatch(x, y) && !isListPart(x, y);
  if (u.kind !== "corrected") return itself || (madeAfter && same(r, u));
  if (!itself && !madeAfter) return false;
  if (!u.frontChanged) return tidyText(r.front) === tidyText(u.front) && tidyText(r.back) === tidyText(u.back);
  if (itself || !u.ruleTells) return tidyText(r.front) === tidyText(u.front);
  return same(r, u) && !isSureMatch(r, u.to);
}

function checkNothingBack(cards, ctx) {
  const out = { id: "nothing-back", title: "Nothing you deleted or corrected came back" };
  const watch = unwanted(cards, ctx.corrections);
  const inStudy = (cards || []).filter((r) => r && r.id != null && r.front && !isArchived(r));
  const bad = [];
  for (const r of inStudy) {
    const u = watch.find((x) => isBack(r, x));
    if (!u) continue;
    const on = Number.isFinite(u.at) ? ` on ${when(u.at, ctx.timeZone)}` : "";
    const made = Number.isFinite(ms(r.created_at)) ? when(ms(r.created_at), ctx.timeZone) : null;
    const itself = u.id != null && String(r.id) === String(u.id);
    if (u.kind === "corrected" && !u.frontChanged) {
      bad.push(`“${r.front}” has its English back as “${r.back}”, which you corrected to “${u.to.back}”${on}.`);
    } else if (u.kind === "corrected") {
      bad.push(`“${r.front}” is back in study as it was before you corrected it to “${u.to.front}”${on}${!itself && made ? `; it was made again on ${made}` : ""}.`);
    } else if (itself) {
      bad.push(`“${r.front}” is in study, though you ${u.kind === "removed" ? "removed" : "deleted"} it${on}.`);
    } else {
      const was = tidyText(r.front) === tidyText(u.front) ? "it" : `“${u.front}”`;
      bad.push(`“${r.front}” is back in study: you ${u.kind === "removed" ? "removed" : "deleted"} ${was}${on}, and ${was === "it" ? "it" : "this"} was made again${made ? ` on ${made}` : ""}.`);
    }
  }
  if (bad.length) {
    return { ...out, status: "fail", summary: `${plural(bad.length, "card")} you deleted or corrected ${bad.length === 1 ? "is" : "are"} back in study.`, details: bad };
  }
  const none = !watch.length ? ""
    : watch.length === 1 ? "The card you deleted or corrected isn't back."
      : `None of the ${watch.length} cards you deleted or corrected is back.`;
  if (!ctx.pairsTable) {
    return { ...out, status: "wait", summary: `${none ? `${none} ` : ""}Cards removed in the app wait for the database update (migration_016), which keeps why a card was taken out.`, details: [] };
  }
  if (!watch.length) return { ...out, status: "wait", summary: "Nothing deleted, removed or corrected yet.", details: [] };
  return { ...out, status: "pass", summary: none, details: [] };
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
//   from      the first study day judged (YYYY-MM-DD)
//   examples  how many details to keep per check
//   pairs     card_pairs rows: Claude's verdicts on look-alike cards; null
//             when they weren't read
//   pairsTable  false when the database hasn't migration_016 yet: no
//             card_pairs, and no record of why a card was taken out
//   corrections  parse_corrections rows for this student; null when unread
export function runStatusChecks({
  answers = [], deals = [], cards = [], settings = null, timeZone = null,
  now = Date.now(), dealsTable = true, lessonRank = null, from = CHECKS_START, examples = EXAMPLES,
  pairs = null, pairsTable = true, corrections = null,
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
    now, settings, lessonRank, inWindow, dealsOn, timeZone, pairs, pairsTable, corrections,
    dealsWaiting: !dealsTable
      ? "Waiting for the database update."
      : "Starts the day after the first set is recorded.",
    dealInWindow: (d) => dealsFromDay != null && dayNo(ms(d.dealt_at), idx.tzOf(d)) >= dealsFromDay,
    // A set judged: in the window, and not replaced before it was answered.
    dealJudged: (d) => dealsFromDay != null && dayNo(ms(d.dealt_at), idx.tzOf(d)) >= dealsFromDay && !idx.replaced.has(d),
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
    checkNoRepeats(cards, ctx),
    checkNothingBack(cards, ctx),
  ].map((r) => ({ ...r, details: r.details.slice(0, examples), more: Math.max(0, r.details.length - examples) }));
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
  if (report.judging) lines.push(`\n${judgingText(report.judging)}`);
  return lines.join("\n");
}

// What the morning check's questions to Claude came to (api/_lib/statusDaily.js
// keeps it on the report as `judging`): how many look-alike pairs it asked
// about, what Claude said, and how many wait for tomorrow.
export function judgingText(j) {
  if (!j) return "";
  if (j.skipped) return `Look-alike cards: none put to Claude this morning (${j.skipped}).`;
  const said = j.answered ? ` Claude judged ${plural(j.same || 0, "pair")} the same card and ${j.answered - (j.same || 0)} different.` : "";
  const left = j.left ? ` ${plural(j.left, "pair")} left for tomorrow.` : " None left.";
  const failed = j.error ? ` ${String(j.error).replace(/[.\s]+$/, "")}.` : "";
  return `Look-alike cards: ${plural(j.asked || 0, "pair")} put to Claude this morning.${said}${failed}${left}`;
}
