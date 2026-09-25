#!/usr/bin/env node
// Merge cards in one deck that are the same card written two ways.
//
//   node scripts/merge-duplicates.mjs <verdicts.json> <email>            # show the plan, write nothing
//   node scripts/merge-duplicates.mjs <verdicts.json> <email> --apply    # back up, then merge
//
// <verdicts.json> is a list of groups, each with "merge": sets of user_cards
// ids judged to be one card ("gratuit" and "gratuit (adj)", "le cas" and "un
// cas"). A set is a list of ids, or { ids, keep, back } where the judging
// named the card to keep — "une virgule" over "un virgule", a gender slip —
// and, optionally, the fuller answer it should take from the others. Judging is done beforehand, card by card, not here: look-alikes that
// are different cards — "la poste" and "le poste", "planter" and "planter
// (fam)", meanings split on purpose — must never be merged, and no string rule
// tells them apart reliably.
//
// For each set, one card stays:
//   1. the card the student has answered, either way round; if several have
//      been, the one answered most;
//   2. otherwise the one from the most classes, then the fuller answer, then
//      the oldest.
// It takes every class date the set's cards had. The others are taken out of
// study — archived, not deleted (src/lib/archive.js) — so their rows, and any
// answers recorded against them, stay in the database and can be put back:
//
//   update user_cards set source = substr(source, 10) where id in (...);
//
// A set is skipped if any of its cards is missing, not in this deck, already
// archived, or a lesson card. --apply writes every row it will change, in full,
// to backups/ first.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archivedSource, isArchived } from "../src/lib/archive.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [verdictsFile, email] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
if (!verdictsFile || !email) {
  console.error("Usage: node scripts/merge-duplicates.mjs <verdicts.json> <email> [--apply]");
  process.exit(1);
}

for (const file of [".env.local", ".env"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const base = SUPABASE_URL.replace(/\/$/, "");
const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const call = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { ...headers, Prefer: "return=representation", ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || "GET"} ${url.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// The deck's owner.
let userId = null;
for (let page = 1; !userId; page++) {
  const r = await call(`${base}/auth/v1/admin/users?page=${page}&per_page=200`);
  const users = r.users || r;
  userId = users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase())?.id || null;
  if (users.length < 200) break;
}
if (!userId) { console.error(`No account for ${email}.`); process.exit(1); }

const verdicts = JSON.parse(fs.readFileSync(verdictsFile, "utf8"));
const sets = verdicts.flatMap((g) => (g.merge || []).map((s) =>
  Array.isArray(s) ? { group: g.group, ids: s } : { group: g.group, ids: s.ids, keep: s.keep, back: s.back }));
const ids = [...new Set(sets.flatMap((s) => s.ids))];
const rows = new Map();
for (let i = 0; i < ids.length; i += 150) {
  const chunk = ids.slice(i, i + 150);
  for (const r of await call(`${base}/rest/v1/user_cards?select=*&id=in.(${chunk.join(",")})`)) rows.set(r.id, r);
}

const answered = (r) => (r.fsrs_state ?? 0) !== 0 || (r.en_fsrs_state ?? 0) !== 0;
const answers = (r) => (r.reps ?? 0) + (r.en_reps ?? 0);
const classes = (r) => (Array.isArray(r.dates) ? r.dates.length : 0);
function keeperOf(members) {
  return [...members].sort((a, b) =>
    Number(answered(b)) - Number(answered(a)) ||
    answers(b) - answers(a) ||
    classes(b) - classes(a) ||
    String(b.back).length - String(a.back).length ||
    a.id - b.id
  )[0];
}

const plan = [];
const skipped = [];
for (const set of sets) {
  const members = set.ids.map((id) => rows.get(id));
  const bad = members.find((r) => !r || r.user_id !== userId || isArchived(r) || String(r.source || "").startsWith("lesson:"));
  if (bad !== undefined || members.length < 2) { skipped.push({ ...set, why: bad ? `row ${bad?.id ?? "missing"} not mergeable` : "fewer than two" }); continue; }
  const named = set.keep != null ? members.find((r) => r.id === set.keep) : null;
  // A named keeper gives way only to a card the student has answered when it
  // hasn't been: their progress is never the thing traded for a better label.
  const keep = named && (answered(named) || !members.some(answered)) ? named : keeperOf(members);
  const drop = members.filter((r) => r.id !== keep.id);
  const dates = [...new Set(members.flatMap((r) => (Array.isArray(r.dates) ? r.dates : [])))].sort();
  plan.push({ group: set.group, keep, drop, dates, back: set.back && set.back !== keep.back ? set.back : null, alsoAnswered: drop.filter(answered).map((r) => r.front) });
}

for (const p of plan) {
  const mark = (r) => `"${r.front}"${answered(r) ? " (answered)" : ""}`;
  console.log(`keep ${mark(p.keep)}  ←  ${p.drop.map(mark).join(", ")}${p.dates.length !== classes(p.keep) ? `  [classes ${classes(p.keep)} → ${p.dates.length}]` : ""}${p.back ? `  [answer → "${p.back}"]` : ""}`);
}
const dropped = plan.reduce((n, p) => n + p.drop.length, 0);
console.log(`\n${plan.length} set(s): ${dropped} card(s) taken out of study, ${plan.length} kept.`);
const doubleAnswered = plan.filter((p) => p.alsoAnswered.length);
if (doubleAnswered.length) console.log(`${doubleAnswered.length} set(s) had more than one answered card; the others' answers stay on record with the archived row.`);
if (skipped.length) console.log(`${skipped.length} set(s) skipped:`, skipped.map((s) => `group ${s.group}: ${s.why}`).join("; "));

if (!APPLY) { console.log("\nDry run: nothing written. Run again with --apply to back up and merge."); process.exit(0); }
if (!plan.length) { console.log("Nothing to do."); process.exit(0); }

fs.mkdirSync(path.join(ROOT, "backups"), { recursive: true });
const backup = path.join(ROOT, "backups", `merge-duplicates-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(backup, JSON.stringify({ userId, rows: plan.flatMap((p) => [p.keep, ...p.drop]) }, null, 2));
console.log(`\nBacked up ${plan.reduce((n, p) => n + 1 + p.drop.length, 0)} row(s) to ${path.relative(ROOT, backup)}`);

let done = 0;
for (const p of plan) {
  const change = {
    ...(p.dates.length !== classes(p.keep) ? { dates: p.dates } : null),
    ...(p.back ? { back: p.back } : null),
  };
  if (Object.keys(change).length) {
    await call(`${base}/rest/v1/user_cards?id=eq.${p.keep.id}&user_id=eq.${userId}`, { method: "PATCH", body: JSON.stringify(change) });
  }
  for (const r of p.drop) {
    await call(`${base}/rest/v1/user_cards?id=eq.${r.id}&user_id=eq.${userId}`, { method: "PATCH", body: JSON.stringify({ source: archivedSource(r.source) }) });
  }
  done++;
}
console.log(`Merged ${done} set(s).`);
