#!/usr/bin/env node
// The status check on a student's real record, from the command line: the
// same eleven checks the server runs on every student each day
// (src/lib/statusChecks.js), for looking into what they report. Claude runs
// it each morning on this Mac (a scheduled task) and tells the owner only
// when something needs their decision; the app itself shows no Status line.
//
// Two of the checks look at the deck itself (2026-10-06): no card in study
// twice, by the rule every card-writer uses and by Claude's verdicts on
// look-alike cards (card_pairs), and nothing the student deleted or corrected
// back (the reason a card was taken out, on user_cards, and the owner's
// corrections, parse_corrections). Both are read here for every student.
// Claude's verdicts come from the server's daily run, which asks about
// look-alikes not judged yet before it checks; this script never asks
// Claude anything.
//
// It only reads. Every request below is a GET, to the database's tables and to
// the list of accounts; nothing is written anywhere.
//
//   node scripts/status-check.mjs                     the admin's own record (ADMIN_EMAIL or VITE_ADMIN_EMAIL)
//   node scripts/status-check.mjs --email x@y.z       another student's
//   node scripts/status-check.mjs --from 2026-09-20   judge answers from an earlier day
//   node scripts/status-check.mjs --tz Europe/Paris   time zone for answers saved without one
//   node scripts/status-check.mjs --all               every detail, not the first six per check
//   node scripts/status-check.mjs --everyone          every student, and the tests of Claude's work
//   node scripts/status-check.mjs --everyone --record the same, saving what's been raised (the morning check)
//
// The time zone defaults to this computer's; answers saved since migration_013
// carry their own.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ALL = args.includes("--all");
const TZ = argVal("--tz") || Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = TZ;

for (const file of [".env.local", ".env"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL } = process.env;
const missing = Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}\nPut them in .env.local or the environment.`);
  process.exit(1);
}
// --everyone: the morning check. The same eleven checks on every student who
// has answered anything, run now (api/_lib/statusDaily.js); what the server's
// daily run last asked Claude about look-alike cards, from its kept reports;
// and whether a change to how Claude is asked has made it get wrong what it
// got right before (api/_lib/evalStatus.js), for each of the three tests of
// Claude's work. Reads the database only.
//
// Each problem found is told apart as new, or raised before: the list of those
// already raised with the owner is kept on this Mac, outside the repo, in
// RAISED_FILE. --record saves today's problems to it (the scheduled morning
// check passes it); without it the list is only read. A problem that stops
// failing drops off the list, so if it comes back it's new again. A daily run
// that couldn't ask Claude about look-alike cards is a problem too.
//
// The last line says which: "All clear.", "Nothing new: ..." or "Something new
// needs looking at."; the exit code is 0, 0 and 1.
if (args.includes("--everyone")) {
  const os = await import("node:os");
  const { createClient } = await import("@supabase/supabase-js");
  const { checkEveryone, latestReports } = await import("../api/_lib/statusDaily.js");
  const { evalStatus } = await import("../api/_lib/evalStatus.js");
  const { statusText, judgingText } = await import("../src/lib/statusChecks.js");
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const RAISED_FILE = path.join(os.homedir(), ".claude", "scheduled-tasks", "morning-check", "raised.json");
  let raised = {};
  try { raised = JSON.parse(fs.readFileSync(RAISED_FILE, "utf8")); } catch {}
  const problems = []; // one line each, also the key in RAISED_FILE
  let unreadable = false;

  const reports = await checkEveryone(db);
  console.log(`Every student who has answered (${reports.length}), checked now:`);
  for (const r of [...reports].sort((a, b) => Number(a.ok) - Number(b.ok))) {
    if (r.error) { unreadable = true; console.log(`\n  ${r.user_email}: couldn't be checked: ${r.error}`); continue; }
    if (r.ok) { console.log(`  ${r.user_email}: ${r.answers} answers, every check passes or waits.`); continue; }
    console.log(`\n  ${r.user_email}: ${r.answers} answers, ${r.failing} check${r.failing === 1 ? "" : "s"} failing.`);
    console.log(statusText(r.report).split("\n").map((l) => `    ${l}`).join("\n"));
    for (const c of r.report.results.filter((x) => x.status === "fail")) {
      for (const d of c.details.length ? c.details : [c.summary]) problems.push(`${r.user_email}: ${c.title}: ${d}`);
    }
  }

  // The server's daily run asks Claude about look-alike cards before it
  // checks; its last report for each student says how that went. A question
  // Claude couldn't answer leaves those cards unjudged, which the check
  // above shows only as waiting, so it is said here.
  const kept = await latestReports(db);
  const judged = [];
  for (const k of kept.reports || []) {
    const j = k.report?.judging;
    if (!j || (!j.asked && !j.left && !j.error)) continue;
    if (j.error) problems.push(`${k.user_email}: the daily run couldn't ask Claude about look-alike cards: ${j.error}`);
    judged.push(`  ${k.user_email}, ${String(k.checked_at).slice(0, 10)}: ${judgingText(j).replace(/^Look-alike cards: /, "")}`);
  }
  if (judged.length) console.log(`\nLook-alike cards put to Claude by the daily run:\n${judged.join("\n")}`);

  const evals = await evalStatus(db);
  for (const [kind, label] of [
    ["answers", "Claude's marking of typed answers"],
    ["notes", "Claude reading class notes into cards"],
    ["repeats", "Claude judging whether two look-alike cards are the same card"],
  ]) {
    const e = evals[kind] || {};
    const last = e.latest ? `last tested ${e.latest.ran_at.slice(0, 10)} (version ${e.latest.version}, ${e.latest.passed} of ${e.latest.cases} right every time)` : "not tested yet";
    console.log(`\n${label}: ${last}.`);
    if (e.error) { unreadable = true; console.log(`  Couldn't read its tests: ${e.error}`); }
    for (const line of e.regressions || []) { console.log(`  - ${line}`); problems.push(`${label}: ${line}`); }
    if (!e.error && !(e.regressions || []).length) console.log("  Nothing it got right before is wrong now.");
  }

  const fresh = problems.filter((x) => !raised[x]);
  const old = problems.filter((x) => raised[x]);
  if (fresh.length) {
    console.log(`\nNew since the last morning check (${fresh.length}):`);
    for (const x of fresh) console.log(`  - ${x}`);
  }
  if (old.length) {
    console.log(`\nRaised with the owner before and still failing (${old.length}):`);
    for (const x of old) console.log(`  - ${x} (raised ${raised[x]})`);
  }
  if (args.includes("--record")) {
    const today = new Date().toISOString().slice(0, 10);
    const keep = Object.fromEntries(problems.map((x) => [x, raised[x] || today]));
    fs.mkdirSync(path.dirname(RAISED_FILE), { recursive: true });
    fs.writeFileSync(RAISED_FILE, JSON.stringify(keep, null, 2) + "\n");
  }

  const isNew = fresh.length > 0 || unreadable;
  console.log(!problems.length && !unreadable ? "\nAll clear."
    : isNew ? "\nSomething new needs looking at."
    : "\nNothing new: everything still failing was raised before.");
  process.exit(isNew ? 1 : 0);
}

// The admin's account: ADMIN_EMAIL, or the app's own VITE_ADMIN_EMAIL, which a
// local .env.local sets when the server's ADMIN_EMAIL is left empty.
const clean = (s) => String(s || "").trim().toLowerCase();
const EMAIL = clean(argVal("--email")) || clean(ADMIN_EMAIL) || clean(process.env.VITE_ADMIN_EMAIL);
if (!EMAIL) {
  console.error("Whose record? Pass --email, or set ADMIN_EMAIL.");
  process.exit(1);
}

const { runStatusChecks, statusText, CHECKS_START } = await import("../src/lib/statusChecks.js");
const { lessonRank } = await import("../src/data/lessons/index.js");

const BASE = SUPABASE_URL.replace(/\/$/, "");
const HEADERS = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function get(url) {
  const res = await fetch(url, { method: "GET", headers: HEADERS });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// A table's rows for the student, a thousand at a time. `null` when the table
// isn't there yet (a migration not run).
async function readAll(table, userId) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await get(`${BASE}/rest/v1/${table}?select=*&user_id=eq.${userId}&order=id.asc&limit=1000&offset=${offset}`);
    if (!r.ok) {
      const code = r.body?.code;
      if (code === "PGRST205" || code === "42P01") return null;
      throw new Error(`reading ${table}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    out.push(...r.body);
    if (r.body.length < 1000) return out;
  }
}

const users = await get(`${BASE}/auth/v1/admin/users?per_page=1000`);
if (!users.ok) throw new Error(`listing accounts: ${users.status} ${JSON.stringify(users.body)}`);
const user = (users.body.users || []).find((u) => (u.email || "").toLowerCase() === EMAIL);
if (!user) {
  console.error(`No account for ${EMAIL}.`);
  process.exit(1);
}

const [answers, cards, deals, settingsRows, pairs, corrections] = await Promise.all([
  readAll("card_reviews", user.id),
  readAll("user_cards", user.id),
  readAll("dealt_sets", user.id),
  get(`${BASE}/rest/v1/fsrs_settings?select=*&user_id=eq.${user.id}`),
  readAll("card_pairs", user.id),
  readAll("parse_corrections", user.id),
]);
const settings = settingsRows.ok && Array.isArray(settingsRows.body) ? settingsRows.body[0] || null : null;

const report = runStatusChecks({
  answers: answers || [],
  cards: cards || [],
  deals: deals || [],
  dealsTable: deals !== null,
  settings,
  pairs,
  pairsTable: pairs !== null,
  corrections,
  timeZone: TZ,
  lessonRank,
  from: argVal("--from") || CHECKS_START,
  examples: ALL ? Infinity : undefined,
});

const withSettings = (answers || []).filter((r) => r.counted && Array.isArray(r.weights)).length;
console.log(`${EMAIL}: ${answers?.length ?? 0} answers on record (${withSettings} saved with their settings), ${cards?.length ?? 0} cards, ` +
  `${deals === null ? "no dealt_sets table yet (migration_013 not run)" : `${deals.length} sets recorded`}; time zone ${TZ}.`);
const removed = (cards || []).filter((c) => c.archived_reason === "removed").length;
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fixes = corrections === null ? "no parse_corrections table" : count(corrections.length, "correction");
console.log(pairs === null
  ? `No card_pairs table yet (migration_016 not run): no verdicts of Claude's on look-alike cards, and no record of cards removed; ${fixes}.`
  : `${count(pairs.length, "verdict")} of Claude's on look-alike cards, ${count(removed, "card")} removed, ${fixes}.`);
console.log(settings
  ? `Settings: ${settings.target_mode === "fixed" ? `fixed at ${Math.round(settings.target * 100)}%` : `automatic, now ${Math.round(settings.target * 100)}%`}; ${settings.weights ? `own weights since ${settings.fitted_at}` : "starting weights"}.`
  : "Settings: none saved (starting settings, 90%).");
console.log("");
console.log(statusText(report));
process.exit(report.ok ? 0 : 1);
