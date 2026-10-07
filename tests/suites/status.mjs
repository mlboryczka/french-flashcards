// The status check (src/lib/statusChecks.js): on a simulated student's record
// (tests/simulate/student.mjs, the app's own rules dealing and scheduling)
// every check passes; and each fault it exists to catch, put into that record
// by hand, makes its check fail — the stale set of 2026-09-23 among them. Also
// the records the app writes for it: an answer's settings, and each set dealt.
// And the two checks of the deck (2026-10-06): a card in study twice, by the
// rule or by Claude's verdict, and a card the student deleted, removed or
// corrected back; before migration_016 they wait. No browser, nothing leaves
// the machine.
process.env.TZ = "America/New_York";

import { checker } from "../check.mjs";
import { simulate, TIME_ZONE, lessonRank, detourRepeats, standInVerdicts } from "../simulate/student.mjs";
import { runStatusChecks, statusText, CHECKS_START, lookalikes, judgingText } from "../../src/lib/statusChecks.js";
import { reviewRow, withoutExtras, REVIEW_EXTRAS, missingColumn } from "../../src/lib/reviewLog.js";
import { dealRow, missingTable } from "../../src/lib/dealLog.js";
import { buildSession } from "../../src/lib/sessionQueue.js";
import { settingsInUse, makeScheduler, State } from "../../src/lib/spacedRepetition.js";
import { STARTING_WEIGHTS } from "../../src/lib/fsrsSettings.js";

const ck = checker();
const DAY = 86400000;
const clone = (x) => JSON.parse(JSON.stringify(x));

const base = simulate({ days: 40, seed: 7, cards: 260, student: "typical" });
const endOf = (rec) => Date.parse(rec.answers.at(-1).answered_at) + 3600000;
// Two corrections of the owner's, made the day after the deck was, neither
// back: a deleted card, and a typo fixed on a card the deck doesn't have.
const madeAt = Date.parse(base.cards[0].created_at);
const CORRECTIONS = [
  { id: "c1", action: "delete", card_id: 999001, original_front: "Naza", original_back: "Naza (a name)", created_at: new Date(madeAt + DAY).toISOString() },
  { id: "c2", action: "edit", card_id: 999002, original_front: "une propositiond", original_back: "a proposal", corrected_front: "une proposition", corrected_back: "a proposal", created_at: new Date(madeAt + DAY).toISOString() },
];
// The record as the server reads it: Claude's verdicts on look-alike cards
// as the morning check keeps them (a stand-in calling every pair different),
// and the owner's corrections.
const check = (rec, extra = {}) => runStatusChecks({
  answers: rec.answers, deals: rec.deals, cards: rec.cards, settings: rec.settings,
  pairs: rec.pairs ?? standInVerdicts(rec.cards), corrections: rec.corrections ?? CORRECTIONS,
  timeZone: TIME_ZONE, lessonRank, now: endOf(rec), ...extra,
});
const result = (report, id) => report.results.find((r) => r.id === id);
const failsOnly = (report, id, label) => {
  const r = result(report, id);
  ck(label, r.status === "fail", `${r.status}: ${r.summary}`);
  return r;
};

// ── A correct record passes ────────────────────────────────────────────
// Every check but one: the simulated student's memory is deliberately not
// FSRS (tests/simulate/student.mjs), so whether "FSRS's predictions match
// your results" passes on its record is the luck of the seed. On seeds 1 to
// 10 it fails on five for this student and on eight for the messy one below,
// and every other check passes on all ten (2026-10-07). It has tests of its
// own (FSRS's predictions against results, below), so here it is left out,
// and a change to how the simulated deck is built can't turn the suite red
// by reshuffling the luck.
const LUCK = new Set(["predictions"]);
console.log("\n  a simulated student studying by the app's rules");
{
  const report = check(base);
  const targets = new Set(base.metrics.targets);
  ck("the automatic target moved during the run, so settings changed under the answers", targets.size > 1, [...targets].join(", "));
  ck("the run met lessons and direction settings other than mixed",
     base.deals.some((d) => d.scope !== "all|all") && base.deals.some((d) => d.direction !== "mix"));
  for (const r of report.results) {
    if (LUCK.has(r.id)) continue;
    ck(`${r.title}: passes`, r.status === "pass", `${r.status}: ${r.summary}${r.details.length ? " — " + r.details[0] : ""}`);
  }
  ck("every answer recalculated to the day, not just within FSRS's spread", /All \d+ answers match\.$/.test(result(report, "fsrs").summary), result(report, "fsrs").summary);
  ck("the report says it is fine", report.results.every((r) => LUCK.has(r.id) || r.status !== "fail"));
}

// ── A messy student passes too ─────────────────────────────────────────
// The habits the owner's real record showed (2026-09-30 to 10-01) and a tidy
// student never has: an old copy of the deck dealing a set on opening,
// replaced seconds later; a class's notes arriving partway through a set; a
// reload; a detour into a lesson and back. Against the checks as they were
// before 2026-10-04 this record fails three of them, as the owner's did.
console.log("\n  a messy student: old copies, class notes mid-set, reloads, detours into a lesson");
{
  // The seed is the student's luck. "FSRS's predictions match your results"
  // is left out (see above): seed 7 stopped passing it on 2026-10-07, when
  // the deck came to hold "une infirmière" inside "un infirmier, une
  // infirmière", one card fewer, which changed every later card's luck.
  const rec = simulate({ days: 40, seed: 7, cards: 260, student: "typical", messy: 0.35 });
  const h = rec.metrics.messy;
  ck("(the run met every habit, more than once)", h.oldCopy > 1 && h.notes > 1 && h.reload > 1 && h.detour > 1, JSON.stringify(h));
  ck("(and sets were replaced before anything in them was answered)",
     rec.deals.some((d, i) => i + 1 < rec.deals.length && rec.deals[i + 1].scope === d.scope &&
       !rec.answers.some((r) => r.answered_at >= d.dealt_at && r.answered_at < rec.deals[i + 1].dealt_at)));
  const report = check(rec);
  for (const r of report.results) {
    if (r.id === "dealt" || LUCK.has(r.id)) continue;
    ck(`${r.title}: passes`, r.status === "pass", `${r.status}: ${r.summary}${r.details.length ? " — " + r.details[0] : ""}`);
  }
  const known = detourRepeats(rec, report);
  ck("every card asked came from a set; any asked twice running came back from a detour into a lesson (known, not yet fixed)",
     known.onlyThese, `${result(report, "dealt").summary} ${result(report, "dealt").details[0] || ""}`);
}

// ── Following FSRS ─────────────────────────────────────────────────────
console.log("\n  following FSRS");
{
  const rec = clone(base);
  const row = rec.answers.find((r) => r.counted && r.state_before === State.Review && r.correct);
  row.due_after = new Date(Date.parse(row.due_after) + 9 * DAY).toISOString();
  const r = failsOnly(check(rec), "fsrs", "an answer whose due date is nine days off FSRS's fails");
  ck("and the report names the card and both gaps", /comes back in \d+ days, where FSRS says \d+ day/.test(r.details.join(" ")), r.details[0]);
}
{
  const rec = clone(base);
  const row = rec.answers.find((r) => r.counted && r.state_before === State.Review);
  row.stability_after *= 1.5;
  failsOnly(check(rec), "fsrs", "a memory estimate FSRS wouldn't give fails");
}
{
  // Scheduled with the wrong target: 95% recorded, 85% used.
  const rec = clone(base);
  const row = rec.answers.find((r) => r.counted && r.state_before === State.Review && r.correct && Date.parse(r.due_after) - Date.parse(r.answered_at) > 12 * DAY);
  row.target = 0.95;
  failsOnly(check(rec), "fsrs", "an answer scheduled with a different target than it records fails");
}
{
  // Before migration_013: no settings on record. Answers from before the
  // target last moved can't be worked out again, and aren't failed for it.
  const rec = clone(base);
  for (const r of rec.answers) for (const k of REVIEW_EXTRAS) r[k] = null;
  const r = result(check(rec), "fsrs");
  ck("with no settings on record, answers from before the last change aren't failed", r.status !== "fail", `${r.status}: ${r.summary}`);
}
{
  const rec = clone(base);
  const row = rec.answers.find((r) => r.counted && Date.parse(r.answered_at) > Date.parse(`${CHECKS_START}T12:00:00`) + 5 * DAY);
  rec.answers.push({ ...row, id: "dup-1", answered_at: new Date(Date.parse(row.answered_at) + 60000).toISOString() });
  failsOnly(check(rec), "one-a-day", "a second answer counted on the same day fails");
}
{
  const rec = clone(base);
  const row = [...rec.answers].reverse().find((r) => r.counted);
  const card = rec.cards.find((c) => c.id === row.card_id);
  const col = row.direction === "en" ? "en_next_due_at" : "next_due_at";
  card[col] = new Date(Date.parse(card[col]) + 3 * DAY).toISOString();
  const r = failsOnly(check(rec), "kept", "a card whose schedule isn't its last answer's fails");
  ck("and the report says which card", r.details.length === 1, r.details.join(" | "));
}
{
  // Reset all progress: every answered card back to new, answers kept.
  const rec = clone(base);
  for (const c of rec.cards) Object.assign(c, { fsrs_state: 0, en_fsrs_state: 0, next_due_at: c.created_at, en_next_due_at: null, last_review: null, en_last_review: null });
  const r = result(check(rec), "kept");
  ck("Reset all progress is reported as that, not as lost cards", r.status === "pass" && /Reset all progress/.test(r.summary), `${r.status}: ${r.summary}`);
  const few = clone(base);
  const lastIds = [...new Set([...few.answers].reverse().filter((x) => x.counted).map((x) => x.card_id))].slice(0, 2);
  for (const c of few.cards) if (lastIds.includes(c.id)) Object.assign(c, { fsrs_state: 0, en_fsrs_state: 0, last_review: null, en_last_review: null });
  failsOnly(check(few), "kept", "but two cards alone put back to new fail");
}
{
  // The server works estimates out again when the settings change; the card
  // then carries that estimate, and that's not a loss.
  const rec = clone(base);
  const { buildHistories, replayHistory } = await import("../../src/lib/fsrsHistory.js");
  const sched = makeScheduler({ weights: [...STARTING_WEIGHTS].map((w, i) => (i === 8 ? w * 1.2 : w)) });
  rec.settings = { ...rec.settings, weights: sched.parameters.w.slice(), fitted_at: new Date(endOf(rec) - DAY).toISOString() };
  for (const h of buildHistories(rec.answers)) {
    const card = rec.cards.find((c) => c.id === h.cardId);
    const est = replayHistory(h, { sched, timeZone: TIME_ZONE });
    const p = h.dir === "en" ? "en_" : "";
    card[`${p}stability`] = Math.fround(est.stability);
    card[`${p}difficulty`] = Math.fround(est.difficulty);
  }
  const r = result(check(rec), "kept");
  ck("estimates worked out again after a fit are not a loss", r.status === "pass", `${r.status}: ${r.summary} ${r.details[0] || ""}`);
}

// ── Following the app's rules ──────────────────────────────────────────
console.log("\n  following the app's rules");
{
  // An answer to a card that wasn't due: its previous answer set a later day.
  const rec = clone(base);
  const list = rec.answers.filter((r) => r.counted);
  const byItem = new Map();
  let target = null;
  for (const r of list) {
    const k = `${r.card_id}:${r.direction}`;
    if (byItem.has(k) && r.state_before === State.Review && Date.parse(r.answered_at) > Date.parse(`${CHECKS_START}T12:00`)) { target = byItem.get(k); break; }
    byItem.set(k, r);
  }
  target.due_after = new Date(Date.parse(target.due_after) + 20 * DAY).toISOString();
  failsOnly(check(rec), "not-early", "a card answered before the day its last answer set fails");
}
{
  // The stale set of 2026-09-23: dealt from an old copy of the deck, it held
  // cards that weren't due, as due, and left out cards that were.
  const rec = clone(base);
  const stale = rec.deals.find((d, i) => i > 8 && d.items.some((x) => x.b === "review") && d.items.some((x) => x.b === "new"));
  const at = Date.parse(stale.dealt_at);
  // A card answered before, and not due again until days after, dealt as due.
  const lastBefore = new Map();
  for (const r of rec.answers) if (r.counted && Date.parse(r.answered_at) < at) lastBefore.set(`${r.card_id}:${r.direction}`, r);
  const notDue = [...lastBefore.values()].find((r) => Date.parse(r.due_after) > at + 2 * DAY);
  ck("(a card not due when the set was dealt)", !!notDue);
  stale.items.push({ c: notDue.card_id, d: notDue.direction, b: "review", due: null, st: 2, miss: false });
  const report = check(rec);
  failsOnly(report, "not-early", "a set dealing as due a card that wasn't (the stale set) fails");
  // And one that left out a due card while taking new ones.
  const rec2 = clone(base);
  const set2 = rec2.deals.find((d, i) => i > 8 && d.items.some((x) => x.b === "review") && d.items.some((x) => x.b === "new"));
  const dropped = set2.items.findIndex((x) => x.b === "review");
  set2.items.splice(dropped, 1);
  failsOnly(check(rec2), "due-first", "a set taking new cards while a due one is left out fails");
  // The same stale set replaced before anything in it was answered, dealt
  // again twelve seconds later (2026-10-04): nothing in it was asked, so it
  // isn't faulted.
  const rec3 = clone(base);
  const i = rec3.deals.findIndex((d) => d.id === stale.id);
  const early = { ...clone(rec3.deals[i]), id: "replaced", dealt_at: new Date(at - 12000).toISOString() };
  early.items.push({ c: notDue.card_id, d: notDue.direction, b: "review", due: null, st: 2, miss: false });
  early.items.splice(early.items.findIndex((x) => x.b === "review"), 1);
  ck("(nothing answered in the twelve seconds between)",
     !rec3.answers.some((r) => Date.parse(r.answered_at) >= at - 12000 && Date.parse(r.answered_at) < at));
  rec3.deals.splice(i, 0, early);
  const r3 = check(rec3);
  for (const id of ["not-early", "due-first"]) {
    ck(`a set replaced before any answer isn't judged: "${result(r3, id).title}" passes`, result(r3, id).status === "pass", result(r3, id).summary);
  }
}
{
  // A class's notes arriving after a set was dealt (2026-10-04): the set
  // isn't faulted for not putting that class first. Once they had arrived, a
  // set passing over them is.
  const lastAt = Math.max(...base.deals.map((d) => Date.parse(d.dealt_at)));
  const dayOf = (t) => {
    const d = new Date(t - 4 * 3600000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // A set taking new cards while one of the student's notes cards waits;
  // that card gets the class of the set's own day, whose notes (a card made
  // by the upload) arrive at `notesAt`.
  const withClass = (notesAt) => {
    const rec = clone(base);
    for (const set of rec.deals.filter((d) => d.scope === "all|all" && d.items.some((x) => x.b === "new")).reverse()) {
      const at = Date.parse(set.dealt_at);
      const met = new Set(rec.answers.filter((r) => Date.parse(r.answered_at) < at).map((r) => r.card_id));
      const inSet = new Set([...set.items, ...(set.kept || [])].map((x) => x.c));
      const waits = rec.cards.find((c) => c.source === "cahier-upload" && !met.has(c.id) && !inSet.has(c.id));
      if (!waits) continue;
      const day = dayOf(at);
      waits.dates = [...waits.dates, day];
      rec.cards.push({ ...clone(waits), id: -1, front: "une nouvelle", source: "archived:cahier-upload", dates: [day], created_at: new Date(notesAt(at)).toISOString() });
      return rec;
    }
    return null;
  };
  const after = withClass(() => lastAt + 3600000);
  ck("(a set took new cards while a notes card waited)", !!after);
  if (after) {
    const r = result(check(after), "new-order");
    ck("a class whose notes arrived after the set doesn't fault it", r.status === "pass", `${r.status}: ${r.summary} ${r.details[0] || ""}`);
    const beforeSet = withClass((at) => at - 60000);
    failsOnly(check(beforeSet), "new-order", "but one whose notes had arrived does");
  }
  // The same, but the waiting card got that class's date from a repeat put
  // away into it (the 2026-10-06 clean-up moved dates so, and four of the
  // owner's sets were faulted over "lourd (adj)"): the repeat, "word.", was
  // made from the class before the set; when was the date moved?
  const withMovedClass = (movedAt, named = true) => {
    const rec = clone(base);
    for (const set of rec.deals.filter((d) => d.scope === "all|all" && d.items.some((x) => x.b === "new")).reverse()) {
      const at = Date.parse(set.dealt_at);
      const met = new Set(rec.answers.filter((r) => Date.parse(r.answered_at) < at).map((r) => r.card_id));
      const inSet = new Set([...set.items, ...(set.kept || [])].map((x) => x.c));
      const waits = rec.cards.find((c) => c.source === "cahier-upload" && !met.has(c.id) && !inSet.has(c.id) && !/[.!?…]$/.test(c.front));
      if (!waits) continue;
      const day = dayOf(at);
      waits.dates = [...waits.dates, day];
      const when = new Date(movedAt(at)).toISOString();
      rec.cards.push({
        ...clone(waits), id: -2, front: `${waits.front}.`, source: "archived:cahier-upload", dates: [day], created_at: new Date(at - 60000).toISOString(),
        ...(named ? { archived_reason: "duplicate", merged_into: waits.id, archived_at: when } : { updated_at: when }),
      });
      return rec;
    }
    return null;
  };
  const movedLater = withMovedClass(() => lastAt + 3600000);
  ck("(a set took new cards while a card waited that gained a class from a repeat)", !!movedLater);
  if (movedLater) {
    const r = result(check(movedLater), "new-order");
    ck("a class date moved onto a card from a repeat put away after the set doesn't fault the set", r.status === "pass", `${r.status}: ${r.summary} ${r.details[0] || ""}`);
    failsOnly(check(withMovedClass((at) => at - 30000)), "new-order", "  but moved before the set, it does: the card had the date then");
    const before016 = result(check(withMovedClass(() => lastAt + 3600000, false)), "new-order");
    ck("  before migration_016 the repeat is the look-alike out of study, and its last change when it was put away",
       before016.status === "pass", `${before016.status}: ${before016.summary} ${before016.details[0] || ""}`);
  }
}
{
  // Missed cards first: a full set of due cards that took a review and left
  // out a card missed last time.
  const rec = simulate({ days: 30, seed: 11, cards: 500, student: "weak", study: 0.55 });
  const full = rec.deals.find((d) => d.due_left > 0 && d.items.some((x) => x.b === "lapse") && d.items.some((x) => x.b === "review"));
  ck("(a weak student who skips days fills sets with due cards)", !!full);
  if (full) {
    const r = check(rec);
    ck("  and those sets pass as dealt", result(r, "due-first").status === "pass", result(r, "due-first").summary);
    const i = full.items.findIndex((x) => x.b === "lapse");
    full.items[i] = { ...full.items[i], b: "review" };
    // The lapse moves out, a review never dealt moves in.
    const lapse = full.items.splice(i, 1)[0];
    full.items.push({ ...lapse, c: -1 });
    failsOnly(check(rec), "due-first", "a full set leaving out a card missed last time fails");
  }
}
{
  // New cards out of order: outside a lesson, a lesson's card comes after
  // every card from the student's notes; one dealt while notes cards wait.
  const rec = clone(base);
  const set = rec.deals.find((d, i) => i > 2 && d.scope === "all|all" && d.items.filter((x) => x.b === "new").length >= 3);
  const answered = new Set(rec.answers.filter((r) => Date.parse(r.answered_at) < Date.parse(set.dealt_at)).map((r) => r.card_id));
  const lessonCard = rec.cards.find((c) => String(c.source).startsWith("lesson:") && !answered.has(c.id));
  ck("(a lesson card is waiting to be met)", !!lessonCard);
  const i = set.items.findIndex((x) => x.b === "new");
  set.items[i] = { ...set.items[i], c: lessonCard.id, d: "fr" };
  const r = failsOnly(check(rec), "new-order", "a set taking a lesson card ahead of the student's own notes fails");
  ck("  and says which card it passed over", /ahead of/.test(r.details[0] || ""), r.details[0]);
}
{
  const rec = clone(base);
  const set = rec.deals.find((d, i) => i > 2 && d.items.some((x) => x.b === "new"));
  const n = set.items.find((x) => x.b === "new");
  const card = rec.cards.find((c) => c.id === n.c);
  ck("(the new card is a word, asked both ways)", ["V", "E"].includes(card.category));
  set.items.push({ ...n, d: n.d === "en" ? "fr" : "en" });
  failsOnly(check(rec), "first-meetings", "a set taking both first meetings of one word fails");
}
{
  const rec = clone(base);
  const last = rec.answers.at(-1);
  rec.answers.push({ ...last, id: "again-1", counted: false, rating: null, answered_at: new Date(Date.parse(last.answered_at) + 5000).toISOString() });
  const r = failsOnly(check(rec), "dealt", "the same card asked twice running fails");
  ck("and says so", /twice in a row/.test(r.details.join(" ")), r.details[0]);
  const rec2 = clone(base);
  const dealt = new Set(rec2.deals.flatMap((d) => d.items.map((x) => x.c)));
  const never = rec2.cards.find((c) => !dealt.has(c.id));
  rec2.answers.push({ ...last, id: "stray-1", card_id: never.id, direction: "fr", counted: false, rating: null, answered_at: new Date(Date.parse(last.answered_at) + 9000).toISOString() });
  failsOnly(check(rec2), "dealt", "a card asked that no set dealt fails");
}
{
  const r = check(base, { dealsTable: false, deals: [] });
  for (const id of ["due-first", "new-order"]) {
    ck(`before the database update, "${result(r, id).title}" waits rather than fails`, result(r, id).status === "wait" && /database update/.test(result(r, id).summary), result(r, id).summary);
  }
  ck("  and nothing is failed for it", r.results.every((x) => LUCK.has(x.id) || x.status !== "fail"), r.results.filter((x) => x.status === "fail").map((x) => x.id).join(", "));
}

// ── How well it's working ──────────────────────────────────────────────
console.log("\n  FSRS's predictions against results");
{
  // 400 reviews FSRS was sure of, half of them missed.
  const t0 = Date.parse(`${CHECKS_START}T10:00:00`) + 3 * DAY;
  const answers = Array.from({ length: 400 }, (_, i) => ({
    id: `p${i}`, card_id: i + 1, direction: "fr", answered_at: new Date(t0 + i * 60000).toISOString(),
    correct: i % 2 === 0, counted: true, rating: i % 2 === 0 ? 3 : 1, state_before: State.Review,
    stability_before: 40, difficulty_before: 5, last_review_before: new Date(t0 - 2 * DAY).toISOString(),
    stability_after: null, difficulty_after: null, due_after: null,
  }));
  const r = runStatusChecks({ answers, cards: [], timeZone: TIME_ZONE, now: t0 + DAY });
  const p = result(r, "predictions");
  ck("reviews FSRS gave 98% and got half right: fails", p.status === "fail", `${p.status}: ${p.summary}`);
  ck("  naming the overall gap", /expected 9\d% right and you got 50%/.test(p.details[0]), p.details[0]);
  const few = runStatusChecks({ answers: answers.slice(0, 60), cards: [], timeZone: TIME_ZONE, now: t0 + DAY });
  ck("but 60 such reviews are too few to judge, and wait", result(few, "predictions").status === "wait", result(few, "predictions").summary);
}

// ── The records the app writes ─────────────────────────────────────────
console.log("\n  what the app records");
{
  const card = { row_id: 5, f: "la pomme", b: "apple", cat: "vocab", fsrs_state: 2, stability: 4.2, difficulty: 5.1, reps: 3, lapses: 1, last_review: "2026-09-20T15:00:00.000Z", next_due_at: "2026-09-24T15:00:00.000Z" };
  const before = { stability: 4.2, difficulty: 5.1, fsrs_state: 2, reps: 3, lapses: 1, last_review: card.last_review, next_due_at: card.next_due_at };
  const after = { stability: 9.9, difficulty: 5.0, fsrs_state: 2, reps: 4, lapses: 1, last_review: "2026-09-27T15:00:00.000Z", next_due_at: "2026-10-06T15:00:00.000Z" };
  const settings = settingsInUse(makeScheduler({ retention: 0.88 }));
  const row = reviewRow({ id: "x", userId: "u", cardId: 5, dir: "fr", got: true, before, after, at: after.last_review, settings, timeZone: TIME_ZONE });
  ck("a counted answer records its target, weights, time zone and counts before",
     row.target === 0.88 && row.weights.length === 21 && row.time_zone === TIME_ZONE && row.reps_before === 3 && row.lapses_before === 1,
     JSON.stringify({ target: row.target, w: row.weights?.length, tz: row.time_zone, reps: row.reps_before }));
  const retry = reviewRow({ id: "y", userId: "u", cardId: 5, dir: "fr", got: false, before: null, after: null, settings, timeZone: TIME_ZONE });
  ck("an answer FSRS didn't count records none of them", REVIEW_EXTRAS.every((k) => retry[k] === null));
  const bare = withoutExtras(row);
  ck("without them, the row is the one a database before migration_013 accepts", REVIEW_EXTRAS.every((k) => !(k in bare)) && bare.stability_after === 9.9);
  ck("PostgREST's missing-column error is recognised", missingColumn({ code: "PGRST204" }) && missingColumn({ code: "42703" }) && !missingColumn({ code: "23505" }));
  ck("and its missing-table error", missingTable({ code: "PGRST205" }) && missingTable({ code: "42P01" }) && !missingTable(null));
}
{
  const deck = base.cards.slice(0, 40).map((row) => ({
    f: row.front, b: row.back, cat: { V: "vocab", E: "expr", G: "gram", P: "pron" }[row.category], dates: row.dates, row_id: row.id,
    fsrs_state: 0, en_fsrs_state: 0,
  }));
  const dealt = buildSession(deck, { direction: "mix" });
  const kept = [{ ...deck[0], shownDir: "fr", _bucket: "review" }, { ...deck[0], shownDir: "fr", _retry: true }];
  const row = dealRow({ id: "d", userId: "u", kind: "rest", scope: "all|all", direction: "mix", slots: 12, dealt, kept, at: "2026-09-27T15:00:00Z", timeZone: TIME_ZONE });
  ck("a set dealt records every card with its way round and why it was dealt",
     row.items.length === dealt.queue.length && row.items.every((x) => x.c && (x.d === "fr" || x.d === "en") && x.b === "new"),
     JSON.stringify(row.items[0]));
  ck("the cards kept in the set once each, retries left out", row.kept.length === 1 && row.kept[0].c === deck[0].row_id && row.kept[0].b === "review", JSON.stringify(row.kept));
  ck("and what was left over", row.due_left === dealt.dueRemaining && row.new_available === dealt.newAvailable && row.slots === 12);
}
{
  const text = statusText(check(base));
  ck("the details to paste to Claude name every check", text.split("\n").filter((l) => /^\[(PASS|FAIL|WAIT)\]/.test(l)).length === 11, text.slice(0, 200));
}

// ── The deck: no card twice, nothing back ──────────────────────────────
// Judged with the card-writers' own rule (src/lib/sameCard.js) and Claude's
// verdicts (card_pairs), so the check means by "the same card" what the
// upload and the sync mean.
console.log("\n  no card in the deck twice");
const later = (days) => new Date(endOf(base) - days * DAY).toISOString();
let nextId = 900000;
const addCard = (rec, row) => { const card = { user_id: rec.cards[0].user_id, category: "V", dates: [], source: "cahier-upload", created_at: later(3), fsrs_state: 0, en_fsrs_state: 0, ...row, id: row.id ?? nextId++ }; rec.cards.push(card); return card; };
const own = base.cards.find((c) => c.source === "cahier-upload" && !c.front.includes("→") && !/[.!?…)]$/.test(c.front) && c.back.split(" ").length >= 2);
const lessonCard = base.cards.find((c) => String(c.source).startsWith("lesson:") && !c.front.includes("→") && !/[.!?…)]$/.test(c.front));
{
  const r = result(check(base), "repeats");
  ck("(the simulated deck has look-alikes, and Claude's stand-in verdicts on all of them)", /Claude judged all \d+ look-alike pairs different/.test(r.summary), r.summary);
}
{
  const rec = clone(base);
  addCard(rec, { front: `${own.front}.`, back: own.back });
  const r = failsOnly(check(rec), "repeats", "a card made again with a full stop, its English the same, fails");
  ck("  naming both cards", r.details.length === 1 && r.details[0].includes(`“${own.front}”`) && r.details[0].includes(`“${own.front}.”`) && /one card twice/.test(r.details[0]), r.details[0]);
  ck("  and the report fails as a whole", !check(rec).ok);
}
{
  const rec = clone(base);
  addCard(rec, { front: lessonCard.front.toLowerCase() === lessonCard.front ? lessonCard.front.toUpperCase() : lessonCard.front.toLowerCase(), back: lessonCard.back });
  const r = failsOnly(check(rec), "repeats", "a notes card beside the lesson card it repeats fails: lesson cards count");
  ck("  and says which one is the lesson's", /\(from a lesson\)/.test(r.details[0] || ""), r.details[0]);
}
{
  // A card that is one item of another card's list is that card (the owner,
  // 2026-10-07): the owner's "à l'heure" beside "à temps / à l'heure", here
  // demarajackson's "épais" beside "épais, épaisse".
  const rec = clone(base);
  addCard(rec, { front: "épais, épaisse", back: "thick", created_at: later(9) });
  addCard(rec, { front: "épais", back: "thick", created_at: later(2) });
  const r = failsOnly(check(rec), "repeats", "a card beside the list card it is an item of fails, with no verdict needed");
  ck("  naming both, and why", /“épais, épaisse” and “épais” are one card twice: a list card and an item on it, with English that agrees\./.test(r.details[0] || ""), r.details[0]);
  // What a list only seems to hold is never failed by the rule: it waits for
  // Claude, like any look-alike.
  const rec2 = clone(base);
  addCard(rec2, { front: "se lever, acheter, amener", back: "to get up, to buy, to bring", created_at: later(9) });
  addCard(rec2, { front: "amener", back: "to bring (someone)", created_at: later(2) });
  addCard(rec2, { front: "La semaine prochaine, il va faire froid", back: "Next week, it's going to be cold", created_at: later(9) });
  addCard(rec2, { front: "la semaine prochaine", back: "next week", created_at: later(2) });
  const w = result(check(rec2, { pairs: standInVerdicts(base.cards) }), "repeats");
  ck("  but different words grouped on one card, or a word inside a sentence, only wait for Claude", w.status === "wait" && /2 look-alike pairs are still to be put to Claude/.test(w.summary), w.summary);
}
{
  const rec = clone(base);
  addCard(rec, { front: `${own.front}.`, back: own.back, source: "archived:cahier-upload", archived_reason: "duplicate", merged_into: own.id });
  const r = result(check(rec), "repeats");
  ck("a repeat put away (out of study) is not a card in the deck twice", r.status === "pass", `${r.status}: ${r.summary}`);
}
{
  // "le cas" (the case) and "un cas" (an instance): the rule can't say,
  // because the English differs; the near search puts them to Claude.
  const rec = clone(base);
  const a = addCard(rec, { front: "un cas", back: "an instance", created_at: later(9) });
  const b = addCard(rec, { front: "le cas", back: "the case", created_at: later(2) });
  const pending = result(check(rec, { pairs: standInVerdicts(base.cards) }), "repeats");
  ck("two cards Claude hasn't been asked about yet: waits, and says how many pairs", pending.status === "wait" && /1 look-alike pair is still to be put to Claude/.test(pending.summary), pending.summary);
  const rows = (verdict, at, x = a, y = b) => ({ card_a: x.id, card_b: y.id, a_front: x.front, a_back: x.back, b_front: y.front, b_back: y.back, verdict, asked_at: at });
  rec.pairs = [...standInVerdicts(base.cards), rows("same", later(1))];
  const r = failsOnly(check(rec), "repeats", "two cards Claude judged the same card, both in study, fail");
  ck("  naming them and Claude's verdict", /“un cas” and “le cas” are one card twice: Claude judged them the same card to learn on/.test(r.details[0] || ""), r.details[0]);
  rec.pairs = [...standInVerdicts(base.cards), rows("same", later(2), b, a), rows("different", later(1))];
  ck("  the latest verdict on a pair is the one that counts", result(check(rec), "repeats").status === "pass", result(check(rec), "repeats").summary);
  rec.pairs = [...standInVerdicts(base.cards), rows("same", later(1))];
  b.back = "the case (a legal case)";
  const edited = result(check(rec), "repeats");
  ck("  a card edited since Claude judged it is a new question: the old verdict no longer counts", edited.status === "wait" && /still to be put to Claude/.test(edited.summary), edited.summary);
  const rep = lookalikes({ cards: rec.cards, pairs: rec.pairs });
  ck("  and it is the pair the morning check asks about next, newest first", rep.unjudged.length >= 1 && rep.unjudged[0].b === b, JSON.stringify(rep.unjudged[0] && [rep.unjudged[0].a.front, rep.unjudged[0].b.front]));
}
{
  const rec = clone(base);
  addCard(rec, { front: `${own.front}.`, back: own.back });
  const r = check(rec, { pairs: null, pairsTable: false });
  ck("before migration_016, a card twice by the rule still fails: the cards are all it needs", result(r, "repeats").status === "fail", result(r, "repeats").summary);
  const clean = result(check(base, { pairs: null, pairsTable: false }), "repeats");
  ck("but a deck with none waits for Claude's verdicts rather than passing or failing", clean.status === "wait" && /database update \(migration_016\)/.test(clean.summary), clean.summary);
}

console.log("\n  nothing deleted, removed or corrected back");
{
  const r = result(check(base), "nothing-back");
  ck("two corrections, neither back: passes", r.status === "pass" && /None of the 2 cards you deleted or corrected is back/.test(r.summary), `${r.status}: ${r.summary}`);
}
{
  // A card the student removed (migration_016), and the same word made again
  // a week later.
  const rec = clone(base);
  const gone = addCard(rec, { front: "Naza", back: "Naza (a name)", source: "archived:cahier-upload", archived_reason: "removed", archived_at: later(12), created_at: later(30) });
  addCard(rec, { front: "naza", back: "Naza (a brand name)", created_at: later(5) });
  const r = failsOnly(check(rec, { corrections: [] }), "nothing-back", "a card the student removed, made again since, fails");
  ck("  naming it and when it was removed", /“naza” is back in study: you removed “Naza” on \w+ \d+, and this was made again on \w+ \d+/.test(r.details[0] || ""), r.details[0]);
  const kept = clone(base);
  addCard(kept, { front: "Naza", back: "Naza (a name)", source: "archived:cahier-upload", archived_reason: "removed", archived_at: later(12), created_at: later(30) });
  addCard(kept, { front: "naza", back: "Naza (a brand name)", created_at: later(20) });
  const k = result(check(kept, { corrections: [] }), "nothing-back");
  ck("  but the card a repeat was removed beside, there before the removal, is not back", k.status === "pass", `${k.status}: ${k.summary}`);
}
{
  // Deleted before Remove kept the row: only parse_corrections remembers.
  const rec = clone(base);
  addCard(rec, { front: "Naza", back: "Naza (proper noun/brand name)", created_at: later(4) });
  const r = failsOnly(check(rec), "nothing-back", "a card the owner deleted, made again by a later upload, fails");
  ck("  naming it", /“Naza” is back in study: you deleted it on \w+ \d+, and it was made again on/.test(r.details[0] || ""), r.details[0]);
}
{
  // The owner deleted "pas mal = beaucoup" (not bad = a lot), a gloss written
  // as a card, on 29 April; "pas mal" came from their notes on 4 September.
  // That is one item of the deleted card's list, not the deleted card back
  // (2026-10-07).
  const rec = clone(base);
  rec.corrections = [...CORRECTIONS, { id: "c3", action: "delete", card_id: 999003, original_front: "pas mal = beaucoup", original_back: "not bad = a lot; quite a lot", created_at: new Date(madeAt + DAY).toISOString() }];
  addCard(rec, { front: "pas mal", back: "not bad / pretty good / quite a lot / quite a bit", created_at: later(4) });
  const r = result(check(rec), "nothing-back");
  ck("an item of a list card the owner deleted is not that card back", r.status === "pass", `${r.status}: ${r.summary}`);
  addCard(rec, { front: "pas mal = beaucoup.", back: "not bad = a lot; quite a lot", created_at: later(3) });
  failsOnly(check(rec), "nothing-back", "  but the deleted card itself, made again, still fails");
}
{
  // The owner's "Je parle jamais de Pierre" (2026-04-30): the full stop taken
  // off, then the 4 September upload made the card again with it.
  const rec = clone(base);
  const fixed = addCard(rec, { front: "Je parle jamais de Pierre", back: "I never talk about Pierre", created_at: base.cards[0].created_at });
  const fix = { id: "c3", action: "edit", card_id: fixed.id, original_front: "Je parle jamais de Pierre.", original_back: "I never talk about Pierre.", corrected_front: "Je parle jamais de Pierre", corrected_back: "I never talk about Pierre", created_at: new Date(madeAt + 2 * DAY).toISOString() };
  rec.corrections = [...CORRECTIONS, fix];
  ck("the corrected card itself is not the wrong form back, though the rule can't tell the two apart", result(check(rec), "nothing-back").status === "pass", result(check(rec), "nothing-back").summary);
  addCard(rec, { front: "Je parle jamais de Pierre.", back: "I never talk about Pierre", created_at: later(4) });
  const r = failsOnly(check(rec), "nothing-back", "the form the owner corrected, made again since, fails");
  ck("  naming it and what it was corrected to", /“Je parle jamais de Pierre\.” is back in study as it was before you corrected it to “Je parle jamais de Pierre” on/.test(r.details[0] || ""), r.details[0]);
  ck("  (and the first check fails too: it is one card twice)", result(check(rec), "repeats").status === "fail");
}
{
  // A typo the rule can tell apart: "une propositiond" made again fails; a
  // card of the corrected word ("la proposition") is not the typo back.
  const rec = clone(base);
  addCard(rec, { front: "une propositiond", back: "a proposal", created_at: later(4) });
  failsOnly(check(rec), "nothing-back", "a typo the owner fixed, made again since, fails");
  const ok = clone(base);
  addCard(ok, { front: "la proposition", back: "the proposal", created_at: later(4) });
  ck("  but the corrected word is not the typo back", result(check(ok), "nothing-back").status === "pass", result(check(ok), "nothing-back").summary);
}
{
  // English the owner corrected, written over again (the 4 September upload
  // did this to "les poils").
  const rec = clone(base);
  const card = addCard(rec, { front: "les poils", back: "hair; fur", created_at: base.cards[0].created_at });
  rec.corrections = [{ id: "c4", action: "edit", card_id: card.id, original_front: "les poils", original_back: "hair; fur", corrected_front: "les poils", corrected_back: "hair / hairs", created_at: new Date(madeAt + DAY).toISOString() }];
  const r = failsOnly(check(rec), "nothing-back", "English the owner corrected, back on the card, fails");
  ck("  saying so", /“les poils” has its English back as “hair; fur”, which you corrected to “hair \/ hairs”/.test(r.details[0] || ""), r.details[0]);
  card.back = "hair / hairs";
  ck("  and with the corrected English it passes", result(check(rec), "nothing-back").status === "pass");
  // Corrected, then put back by a later correction: wanted again.
  card.back = "hair; fur";
  rec.corrections.push({ id: "c5", action: "edit", card_id: card.id, original_front: "les poils", original_back: "hair / hairs", corrected_front: "les poils", corrected_back: "hair; fur", created_at: new Date(madeAt + 3 * DAY).toISOString() });
  ck("  a form a later correction put back is not watched", result(check(rec), "nothing-back").status === "pass", result(check(rec), "nothing-back").summary);
}
{
  const rec = clone(base);
  addCard(rec, { front: "Naza", back: "Naza (proper noun/brand name)", created_at: later(4) });
  const before = result(check(rec, { pairs: null, pairsTable: false }), "nothing-back");
  ck("before migration_016, a deleted card back still fails: the corrections are all it needs", before.status === "fail", before.summary);
  const clean = result(check(base, { pairs: null, pairsTable: false }), "nothing-back");
  ck("but with nothing back it waits for the record of cards removed", clean.status === "wait" && /database update \(migration_016\)/.test(clean.summary), clean.summary);
}
{
  const text = statusText({ ...check(base), judging: { asked: 200, answered: 180, same: 2, left: 475, error: "No answer about 20: a call failed or ran out of time" } });
  ck("the report says what the morning check asked Claude, and what is left for tomorrow",
     /200 pairs put to Claude this morning\. Claude judged 2 pairs the same card and 178 different\. No answer about 20: a call failed or ran out of time\. 475 pairs left for tomorrow\./.test(text), text.split("\n").at(-1));
  ck("  and when there was nothing to ask, says why", /none put to Claude this morning \(waiting for the database update/.test(judgingText({ asked: 0, left: 0, skipped: "waiting for the database update (migration_016)" })));
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
