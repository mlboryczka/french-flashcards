#!/usr/bin/env node
// Why the 2026-10-06 clean-up put each card away, written onto the cards
// (one-off, 2026-10-06).
//
// That evening the owner approved a clean-up that took 85 cards out of study
// in three decks: repeats of another card, made by reading notes again, and
// three cards the owner had deleted or corrected that had come back. It ran
// before migration_016, so the cards say nothing about why: archived_reason
// and merged_into are empty on every one. This writes them, from the
// clean-up's own plan (cleanup-plan.json: which card was kept in each group,
// which were put away) and its backup (every row as it was before):
//
//   a repeat:  archived_reason 'duplicate', and merged_into the card it
//              repeats. Where a group kept several cards (a list card such as
//              "manquer / rater" put away because "manquer" and "rater" each
//              have a card), the one the card-writers' own rule finds closest
//              (src/lib/sameCard.js), else the first kept.
//   a card the owner had deleted that came back ("Naza", the registers card):
//              archived_reason 'removed', as Remove now records it.
//   "Je parle jamais de Pierre." (back beside the owner's corrected card):
//              'duplicate', merged into the corrected card.
//   archived_at: when the clean-up ran.
//
// Why it matters: a card marked 'removed' or 'duplicate' stays out of study
// whatever a lesson does (src/lib/lessonSync.js), and each repeat with the
// card it repeats is a case in the test of Claude's same-or-different question
// (api/_lib/repeatsChecks.js).
//
// Nothing else on any row changes: not its French or English, its schedule,
// its answers, or its place out of study. A row is written only while it is
// still out of study, still has the French it had, and has no reason yet; any
// other row is left alone and said so. Run it again and it writes nothing.
//
// Dry run by default: GET requests only, nothing written anywhere.
//
//   node scripts/record-cleanup-reasons.mjs --plan <cleanup-plan.json>
//   node scripts/record-cleanup-reasons.mjs --plan <cleanup-plan.json> --apply
//
//   --plan     the clean-up's plan (default backups/cleanup-plan-2026-10-06.json)
//   --backup   its backup (default backups/cleanup-duplicates-2026-10-06T22-43-16-564Z.json)
//   --apply    write, after saving every row it changes to backups/
//
// Needs migration_016, which adds the columns. Environment (a .env.local in
// the repo root is read automatically): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSureMatch, cardIndex, sameWords } from "../src/lib/sameCard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes("--apply");
const PLAN = path.resolve(ROOT, argVal("--plan") || "backups/cleanup-plan-2026-10-06.json");
const BACKUP = path.resolve(ROOT, argVal("--backup") || "backups/cleanup-duplicates-2026-10-06T22-43-16-564Z.json");
const BACKUPS_DIR = path.resolve(ROOT, argVal("--backups-dir") || "backups");

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
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Put them in .env.local or the environment.");
  process.exit(1);
}
for (const [what, file] of [["The clean-up's plan", PLAN], ["Its backup", BACKUP]]) {
  if (!fs.existsSync(file)) {
    console.error(`${what} isn't at ${file}. Pass its path with ${what === "Its backup" ? "--backup" : "--plan"}.`);
    process.exit(1);
  }
}

const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
const backup = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
// When the clean-up ran: the time in its backup's name.
const stamp = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(path.basename(BACKUP));
const CLEANUP_AT = argVal("--at") || (stamp ? `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z` : null);
if (!CLEANUP_AT) {
  console.error("Couldn't tell when the clean-up ran from the backup's name; pass --at YYYY-MM-DDTHH:MM:SSZ.");
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, "");
const HEADERS = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { ...HEADERS, ...(body ? { "Content-Type": "application/json", Prefer: "return=representation" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: res.ok, status: res.status, body: json };
}
const get = (url) => request("GET", url);

// What each put-away card should say.
const before = new Map((backup.rows || []).map((r) => [r.id, r]));
const wanted = []; // { id, reason, merged_into, group }
for (const group of Object.values(plan.plan || {}).flat()) {
  for (const id of group.archive || []) wanted.push({ id, reason: "duplicate", keep: group.keep || [], note: group.note });
}
for (const r of plan.resurrected || []) {
  for (const id of r.archive || []) {
    wanted.push(r.unarchive?.length
      ? { id, reason: "duplicate", keep: r.unarchive, note: r.why }
      : { id, reason: "removed", keep: [], note: r.why });
  }
}

// The rows as they are now: the ones put away, and the ones kept.
const ids = [...new Set(wanted.flatMap((w) => [w.id, ...w.keep]))];
const now = new Map();
let migrated = true;
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  let r = await get(`${BASE}/rest/v1/user_cards?select=id,user_id,front,back,source,archived_reason,archived_at,merged_into&id=in.(${chunk.join(",")})`);
  if (!r.ok && (r.body?.code === "42703" || r.body?.code === "PGRST204")) {
    migrated = false;
    r = await get(`${BASE}/rest/v1/user_cards?select=id,user_id,front,back,source&id=in.(${chunk.join(",")})`);
  }
  if (!r.ok) throw new Error(`reading cards: ${r.status} ${JSON.stringify(r.body)}`);
  for (const row of r.body) now.set(row.id, row);
}

// Which kept card a put-away card repeats.
function repeats(w) {
  const kept = w.keep.map((id) => now.get(id)).filter(Boolean);
  if (kept.length <= 1) return kept[0] || null;
  const card = now.get(w.id) || before.get(w.id);
  // A list card is surely each of its items (2026-10-07): the one with the
  // same English is the closest, then one with the same English words.
  const sure = kept.filter((k) => isSureMatch(k, card));
  const tidy = (s) => String(s ?? "").trim().toLowerCase();
  if (sure.length) return sure.find((k) => tidy(k.back) === tidy(card.back)) || sure.find((k) => sameWords(k.back, card.back)) || sure[0];
  const near = cardIndex(kept).near(card);
  return near[0] || kept[0];
}

const isArchived = (row) => typeof row?.source === "string" && row.source.startsWith("archived:");
const writes = [];
const lines = [];
const left = [];
for (const w of wanted) {
  const row = now.get(w.id);
  const was = before.get(w.id);
  const name = `${w.id} “${row?.front ?? was?.front ?? "?"}”`;
  if (!row) { left.push(`${name}: no longer there.`); continue; }
  if (was && (row.user_id !== was.user_id || row.front !== was.front)) { left.push(`${name}: changed since the clean-up (its French or owner), left alone.`); continue; }
  if (!isArchived(row)) { left.push(`${name}: back in study since the clean-up, left alone.`); continue; }
  const target = w.reason === "duplicate" ? repeats(w) : null;
  if (w.reason === "duplicate" && (!target || target.user_id !== row.user_id)) { left.push(`${name}: the card it repeats isn't there, left alone.`); continue; }
  const patch = { archived_reason: w.reason, merged_into: target ? target.id : null, archived_at: CLEANUP_AT };
  if (migrated && row.archived_reason === patch.archived_reason && (row.merged_into ?? null) === patch.merged_into) { left.push(`${name}: already recorded.`); continue; }
  if (migrated && row.archived_reason) { left.push(`${name}: already says “${row.archived_reason}”, left alone.`); continue; }
  writes.push({ row, patch });
  lines.push(w.reason === "removed"
    ? `  ${name}: removed (${w.note})`
    : `  ${name}: repeats ${target.id} “${target.front}”`);
}

console.log(`The clean-up of ${CLEANUP_AT.slice(0, 10)} put away ${wanted.length} cards; ${writes.length} to record:`);
for (const l of lines) console.log(l);
if (left.length) {
  console.log(`\nLeft as they are (${left.length}):`);
  for (const l of left) console.log(`  ${l}`);
}
const counts = writes.reduce((m, w) => ((m[w.patch.archived_reason] = (m[w.patch.archived_reason] || 0) + 1), m), {});
console.log(`\n${counts.duplicate || 0} as repeats of the card kept, ${counts.removed || 0} as removed.`);

if (!migrated) {
  console.log("\nmigration_016 hasn't been run yet: the cards have nowhere to say why. Run it first, then this again.");
  process.exit(APPLY ? 1 : 0);
}
if (!APPLY) {
  console.log("\nDry run: nothing written. Add --apply to write.");
  process.exit(0);
}
if (!writes.length) {
  console.log("\nNothing to write.");
  process.exit(0);
}

// Every row as it is, saved before anything is written.
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
const saved = path.join(BACKUPS_DIR, `record-cleanup-reasons-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(saved, JSON.stringify({
  note: "Rows as they were before record-cleanup-reasons.mjs wrote archived_reason, merged_into and archived_at. To undo, set those three back to the values here.",
  rows: writes.map((w) => w.row),
}, null, 2));
console.log(`\nBacked up ${writes.length} rows to ${path.relative(ROOT, saved)}.`);

let done = 0;
for (const { row, patch } of writes) {
  // Only while the row is still out of study and still says no reason.
  const r = await request("PATCH",
    `${BASE}/rest/v1/user_cards?id=eq.${row.id}&user_id=eq.${row.user_id}&source=like.archived:*&archived_reason=is.null`, patch);
  if (!r.ok) { console.error(`  ${row.id}: ${r.status} ${JSON.stringify(r.body)}`); continue; }
  if (Array.isArray(r.body) && r.body.length === 1) done++;
  else console.log(`  ${row.id}: changed meanwhile, not written.`);
}
console.log(`Recorded ${done} of ${writes.length}.`);
process.exit(done === writes.length ? 0 : 1);
