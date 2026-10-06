// The status check (src/lib/statusChecks.js): on a simulated student's record
// (tests/simulate/student.mjs, the app's own rules dealing and scheduling)
// every check passes; and each fault it exists to catch, put into that record
// by hand, makes its check fail — the stale set of 2026-09-23 among them. Also
// the records the app writes for it: an answer's settings, and each set dealt.
// No browser, nothing leaves the machine.
process.env.TZ = "America/New_York";

import { checker } from "../check.mjs";
import { simulate, TIME_ZONE, lessonRank, detourRepeats } from "../simulate/student.mjs";
import { runStatusChecks, statusText, CHECKS_START } from "../../src/lib/statusChecks.js";
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
const check = (rec, extra = {}) => runStatusChecks({
  answers: rec.answers, deals: rec.deals, cards: rec.cards, settings: rec.settings,
  timeZone: TIME_ZONE, lessonRank, now: endOf(rec), ...extra,
});
const result = (report, id) => report.results.find((r) => r.id === id);
const failsOnly = (report, id, label) => {
  const r = result(report, id);
  ck(label, r.status === "fail", `${r.status}: ${r.summary}`);
  return r;
};

// ── A correct record passes ────────────────────────────────────────────
console.log("\n  a simulated student studying by the app's rules");
{
  const report = check(base);
  const targets = new Set(base.metrics.targets);
  ck("the automatic target moved during the run, so settings changed under the answers", targets.size > 1, [...targets].join(", "));
  ck("the run met lessons and direction settings other than mixed",
     base.deals.some((d) => d.scope !== "all|all") && base.deals.some((d) => d.direction !== "mix"));
  for (const r of report.results) {
    ck(`${r.title}: passes`, r.status === "pass", `${r.status}: ${r.summary}${r.details.length ? " — " + r.details[0] : ""}`);
  }
  ck("every answer recalculated to the day, not just within FSRS's spread", /All \d+ answers match\.$/.test(result(report, "fsrs").summary), result(report, "fsrs").summary);
  ck("the report says it is fine", report.ok && report.failing === 0);
}

// ── A messy student passes too ─────────────────────────────────────────
// The habits the owner's real record showed (2026-09-30 to 10-01) and a tidy
// student never has: an old copy of the deck dealing a set on opening,
// replaced seconds later; a class's notes arriving partway through a set; a
// reload; a detour into a lesson and back. Against the checks as they were
// before 2026-10-04 this record fails three of them, as the owner's did.
console.log("\n  a messy student: old copies, class notes mid-set, reloads, detours into a lesson");
{
  const rec = simulate({ days: 40, seed: 7, cards: 260, student: "typical", messy: 0.35 });
  const h = rec.metrics.messy;
  ck("(the run met every habit, more than once)", h.oldCopy > 1 && h.notes > 1 && h.reload > 1 && h.detour > 1, JSON.stringify(h));
  ck("(and sets were replaced before anything in them was answered)",
     rec.deals.some((d, i) => i + 1 < rec.deals.length && rec.deals[i + 1].scope === d.scope &&
       !rec.answers.some((r) => r.answered_at >= d.dealt_at && r.answered_at < rec.deals[i + 1].dealt_at)));
  const report = check(rec);
  for (const r of report.results) {
    if (r.id === "dealt") continue;
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
  ck("  and nothing is failed for it", r.ok);
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
  ck("the details to paste to Claude name every check", text.split("\n").filter((l) => /^\[(PASS|FAIL|WAIT)\]/.test(l)).length === 9, text.slice(0, 200));
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
