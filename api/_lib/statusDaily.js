// The status check on every student (2026-10-06).
//
// The checks (src/lib/statusChecks.js; nine then, eleven since the two of the
// deck) used to run only on the admin's own record, in the admin's browser,
// while the app was open. Here they run on
// the server on every student who has answered anything, with the service
// role:
//
//   once a day, from /api/cahier-daily's second schedule (vercel.json), and
//   the results kept in status_reports (migration_015);
//
//   when the owner presses "Check everyone now" in the Status window, through
//   /api/admin-users?view=status&run=1.
//
// The morning check on the owner's Mac (scripts/status-check.mjs --everyone)
// runs the same checks, read-only, and reads the kept reports.
//
// Since 2026-10-06 the daily run first asks Claude about cards in study that
// look alike and haven't been judged yet (judgeLookalikes, below), keeps its
// verdicts in card_pairs (migration_016), and only then runs the checks, so
// "No card is in your deck twice" judges with them. The owner: "make sure the
// evaluation harness is catching this properly". The question is the one
// every card-writer asks (api/_lib/sameCardQuestion.js), capped per student
// per day (LOOKALIKES_PER_DAY); what isn't asked waits for the next morning,
// and the report says how many. No button anywhere starts it. Nothing here
// writes anything but status_reports and those verdicts, and the verdicts
// only from the daily run: the morning check on the Mac and "Check everyone
// now" only read.

import { runStatusChecks, lookalikes, LOOKALIKES_PER_DAY } from "../../src/lib/statusChecks.js";
import { lessonRank } from "../../src/data/lessons/index.js";
import { missingTable } from "../../src/lib/dealLog.js";
import { askSameCard, SAME_CARD_VERSION, SAME_CARD_MODEL } from "./sameCardQuestion.js";

// The daily run's schedule in vercel.json. Vercel sends it with the request
// (x-vercel-cron-schedule), which is how /api/cahier-daily tells this run
// from the cahier one.
export const STATUS_SCHEDULE = "0 14 * * *";

const PAGE = 1000;

async function readAll(db, table, userId) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select("*").eq("user_id", userId)
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { data: out };
  }
}

// Every account, from Supabase's list of users.
export async function listStudents(db) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const users = data?.users || [];
    out.push(...users.map((u) => ({ id: u.id, email: (u.email || "").toLowerCase() })));
    if (users.length < 200) break;
  }
  return out;
}

// One student's record: what the checks read. Null when they have never
// answered a card: there is nothing to judge. Claude's verdicts and the
// owner's corrections are read too; either one unreadable leaves the check
// that needs it waiting rather than failing the student's whole report, and
// card_pairs missing is the database before migration_016.
export async function loadStudent(db, student) {
  const [answers, cards, deals, settings, pairs, corrections] = await Promise.all([
    readAll(db, "card_reviews", student.id),
    readAll(db, "user_cards", student.id),
    readAll(db, "dealt_sets", student.id),
    db.from("fsrs_settings").select("*").eq("user_id", student.id).maybeSingle(),
    readAll(db, "card_pairs", student.id),
    readAll(db, "parse_corrections", student.id),
  ]);
  const failed = answers.error || cards.error || (deals.error && !missingTable(deals.error) ? deals.error : null);
  if (failed) return { student, error: failed.message || String(failed) };
  if (!answers.data.length) return null;
  return {
    student,
    answers: answers.data,
    cards: cards.data,
    deals: deals.error ? [] : deals.data,
    dealsTable: !deals.error,
    settings: settings.error ? null : settings.data,
    pairs: pairs.error ? null : pairs.data,
    pairsTable: !missingTable(pairs.error),
    corrections: corrections.error ? null : corrections.data,
    judging: null,
  };
}

// The checks on a loaded record, as the report kept for it.
export function reportFor(rec, { now = Date.now() } = {}) {
  const { student } = rec;
  if (rec.error) return { user_id: student.id, user_email: student.email, ok: false, error: rec.error };
  // Rows saved without a time zone are read in the student's latest one.
  const latestZone = [...rec.answers].reverse().find((r) => r.time_zone)?.time_zone || null;
  const report = runStatusChecks({
    answers: rec.answers,
    cards: rec.cards,
    deals: rec.deals,
    dealsTable: rec.dealsTable,
    settings: rec.settings,
    pairs: rec.pairs,
    pairsTable: rec.pairsTable,
    corrections: rec.corrections,
    timeZone: latestZone,
    lessonRank,
    now,
  });
  if (rec.judging) report.judging = rec.judging;
  return {
    user_id: student.id,
    user_email: student.email,
    checked_at: report.checkedAt,
    ok: report.ok,
    failing: report.failing,
    answers: report.answers,
    report,
    error: null,
  };
}

// One student's checks. `judge` as for checkEveryone.
export async function checkStudent(db, student, { now = Date.now(), judge = null } = {}) {
  const rec = await loadStudent(db, student);
  if (!rec) return null;
  if (judge && !rec.error) await judgeLookalikes(db, [rec], judge);
  return reportFor(rec, { now });
}

// Everyone. One student's failure is theirs alone.
//
// `judge` is given only by the daily run: { apiKey, startBy, deadline, cap,
// ask }. Every student's look-alikes not yet judged go to Claude together, up
// to `cap` a student (the newest cards first), in the pooled calls
// askSameCard makes, before any check is run. Nothing starts after `startBy`,
// and no call runs past `deadline` (times in ms), so the run still has time
// to keep the verdicts and check everyone.
export async function checkEveryone(db, { now = Date.now(), judge = null } = {}) {
  const loaded = [];
  for (const student of await listStudents(db)) {
    try {
      const rec = await loadStudent(db, student);
      if (rec) loaded.push(rec);
    } catch (e) {
      loaded.push({ student, error: e.message || String(e) });
    }
  }
  if (judge) await judgeLookalikes(db, loaded.filter((r) => !r.error), judge);
  return loaded.map((rec) => {
    try {
      return reportFor(rec, { now });
    } catch (e) {
      return { user_id: rec.student.id, user_email: rec.student.email, ok: false, error: e.message || String(e) };
    }
  });
}

// Claude's verdict on look-alike cards in study it hasn't judged: asked,
// kept in card_pairs (source "check"), and added to each record so its checks
// judge with them. Sets `rec.judging` on every record it is given:
//   { asked, answered, same, left, error }  or  { asked: 0, left, skipped }
// `left` is what waits for tomorrow. A call that fails or runs out of time
// leaves its pairs unjudged, to be asked again the next morning; nothing is
// decided on a guess.
export async function judgeLookalikes(db, recs, { apiKey, startBy = Infinity, deadline, cap = LOOKALIKES_PER_DAY, ask = askSameCard } = {}) {
  const asking = [];
  for (const rec of recs) {
    if (!rec.pairsTable) { rec.judging = { asked: 0, left: 0, skipped: "waiting for the database update (migration_016)" }; continue; }
    if (!rec.pairs) { rec.judging = { asked: 0, left: 0, skipped: "Claude's earlier verdicts couldn't be read" }; continue; }
    const { unjudged } = lookalikes({ cards: rec.cards, pairs: rec.pairs });
    const chosen = unjudged.slice(0, Math.max(0, cap));
    rec.judging = { asked: chosen.length, answered: 0, same: 0, left: unjudged.length, error: null };
    for (const pair of chosen) asking.push({ rec, pair });
  }
  if (!asking.length) return;
  if (Date.now() > startBy) {
    for (const rec of new Set(asking.map((x) => x.rec))) rec.judging = { asked: 0, left: rec.judging.left, skipped: "no time left this morning" };
    return;
  }
  let verdicts = asking.map(() => null);
  let failure = null;
  try {
    const got = await ask({
      apiKey,
      pairs: asking.map(({ pair: { a, b } }) => ({ a: { front: a.front, back: a.back }, b: { front: b.front, back: b.back } })),
      deadline,
    });
    if (Array.isArray(got)) verdicts = asking.map((_, i) => got[i] ?? null);
  } catch (e) {
    failure = e?.message || String(e);
  }
  const at = new Date().toISOString();
  for (const rec of new Set(asking.map((x) => x.rec))) {
    const rows = [];
    asking.forEach(({ rec: r, pair: { a, b } }, i) => {
      const verdict = verdicts[i];
      if (r !== rec || (verdict !== "same" && verdict !== "different")) return;
      rows.push({
        user_id: rec.student.id, card_a: a.id, card_b: b.id,
        a_front: a.front, a_back: a.back, b_front: b.front, b_back: b.back,
        verdict, version: SAME_CARD_VERSION, model: SAME_CARD_MODEL, source: "check",
      });
    });
    const j = rec.judging;
    const unanswered = j.asked - rows.length;
    if (rows.length) {
      const { error } = await db.from("card_pairs").insert(rows);
      if (error) {
        j.error = `Claude's verdicts couldn't be kept: ${error.message}`;
        continue;
      }
      rec.pairs.push(...rows.map((row) => ({ ...row, asked_at: at })));
    }
    j.answered = rows.length;
    j.same = rows.filter((row) => row.verdict === "same").length;
    j.left -= rows.length;
    if (unanswered) {
      j.error = failure
        ? `Claude couldn't be asked about ${unanswered}: ${failure}`
        : `No answer about ${unanswered}: a call failed or ran out of time`;
    }
  }
}

// Kept for the Status window. `missing` before migration_015.
export async function saveReports(db, reports) {
  if (!reports.length) return { ok: true };
  const { error } = await db.from("status_reports").insert(reports.map((r) => ({
    user_id: r.user_id,
    user_email: r.user_email,
    checked_at: r.checked_at || new Date().toISOString(),
    ok: !!r.ok,
    failing: r.failing ?? null,
    answers: r.answers ?? null,
    report: r.report ?? null,
    error: r.error ?? null,
  })));
  return missingTable(error) ? { missing: true } : error ? { error: error.message } : { ok: true };
}

// The latest report for each student.
export async function latestReports(db) {
  const { data, error } = await db.from("status_reports").select("*")
    .order("checked_at", { ascending: false }).limit(2000);
  if (missingTable(error)) return { missing: true, reports: [] };
  if (error) return { error: error.message, reports: [] };
  const seen = new Set();
  const reports = [];
  for (const r of data || []) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    reports.push(r);
  }
  return { reports };
}
