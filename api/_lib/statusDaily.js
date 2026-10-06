// The status check on every student (2026-10-06).
//
// The nine checks (src/lib/statusChecks.js) used to run only on the admin's
// own record, in the admin's browser, while the app was open. Here they run on
// the server on every student who has answered anything, with the service
// role:
//
//   once a day, from /api/cahier-daily's second schedule (vercel.json), and
//   the results kept in status_reports (migration_015);
//
//   when the owner presses "Check everyone now" in the Status window, through
//   /api/admin-users?view=status&run=1.
//
// The Status window's "All students" tab reads the latest report for each
// student, and the avatar's alert lights when any of them failed. Nothing
// here writes anything but status_reports.

import { runStatusChecks } from "../../src/lib/statusChecks.js";
import { lessonRank } from "../../src/data/lessons/index.js";
import { missingTable } from "../../src/lib/dealLog.js";

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

// One student's checks, as the app runs them for the admin. Null when they
// have never answered a card: there is nothing to judge.
export async function checkStudent(db, student, { now = Date.now() } = {}) {
  const [answers, cards, deals, settings] = await Promise.all([
    readAll(db, "card_reviews", student.id),
    readAll(db, "user_cards", student.id),
    readAll(db, "dealt_sets", student.id),
    db.from("fsrs_settings").select("*").eq("user_id", student.id).maybeSingle(),
  ]);
  const failed = answers.error || cards.error || (deals.error && !missingTable(deals.error) ? deals.error : null);
  if (failed) return { user_id: student.id, user_email: student.email, ok: false, error: failed.message || String(failed) };
  if (!answers.data.length) return null;
  // Rows saved without a time zone are read in the student's latest one.
  const latestZone = [...answers.data].reverse().find((r) => r.time_zone)?.time_zone || null;
  const report = runStatusChecks({
    answers: answers.data,
    cards: cards.data,
    deals: deals.error ? [] : deals.data,
    dealsTable: !deals.error,
    settings: settings.error ? null : settings.data,
    timeZone: latestZone,
    lessonRank,
    now,
  });
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

// Everyone, one after another. One student's failure is theirs alone.
export async function checkEveryone(db, { now = Date.now() } = {}) {
  const out = [];
  for (const student of await listStudents(db)) {
    try {
      const r = await checkStudent(db, student, { now });
      if (r) out.push(r);
    } catch (e) {
      out.push({ user_id: student.id, user_email: student.email, ok: false, error: e.message || String(e) });
    }
  }
  return out;
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
