#!/usr/bin/env node
// Put the cards the FSRS switch stamped as due, and nobody has answered since,
// back to "not yet seen".
//
//   node scripts/reset-fsrs-seed.mjs            # count them, write nothing
//   node scripts/reset-fsrs-seed.mjs --apply    # back them up, then reset
//
// migration_007 gave every card answered under the old box system a guessed
// FSRS state — stability 1 to 21 days, from its box or score — and made all of
// them due at the one instant the migration ran: 2026-09-05 04:19:08 UTC. A
// card answered since has a new due date, so a card still due at exactly that
// instant has not been answered since, on any deck.
//
// Nine days on, those cards were one pile of ~1,200 "due" across every deck,
// 582 of them on the owner's. The serving rule is due cards first, new cards
// only once those run out, so the pile meant about fourteen blocks of
// half-forgotten cards before a single new one, missed at around 40%. They
// were never learned in FSRS's sense; their state was a guess. Reset, they come
// back through the new-card order instead: recent classes first, then the
// words that came up in the most classes.
//
// What a reset loses is that guess (stability, difficulty, reps, and the old
// system's lapse count). --apply writes every affected row, in full, to
// backups/ before changing anything, so it can be put back.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

// When migration_007 ran, read off the live table: 1,200 rows carried exactly
// this next_due_at, and every one had last_review exactly its stability before
// it, which is the migration's own formula.
export const SEED_INSTANT = "2026-09-05T04:19:08.31976+00:00";

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
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\nPut them in .env.local or the environment.");
  process.exit(1);
}

const db = async (p, init = {}) => {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || "GET"} ${p.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// Every card still due at the seed instant and not already New.
const PAGE = 1000;
let rows = [];
for (let from = 0; ; from += PAGE) {
  const page = await db(
    `user_cards?select=*&next_due_at=eq.${encodeURIComponent(SEED_INSTANT)}&fsrs_state=neq.0&order=id.asc`,
    { headers: { Range: `${from}-${from + PAGE - 1}` } }
  );
  rows = rows.concat(page);
  if (page.length < PAGE) break;
}

// The formula check: a row that matches the instant but not the migration's
// own last_review arithmetic is not one we understand, so it is left alone.
const DAY = 86400000;
const matchesFormula = (r) =>
  r.last_review &&
  Math.round((new Date(r.next_due_at) - new Date(r.last_review)) / DAY) ===
    Math.max(1, Math.round(r.stability ?? 0));
const targets = rows.filter(matchesFormula);
const skipped = rows.length - targets.length;

const byDeck = new Map();
for (const r of targets) byDeck.set(r.user_id, (byDeck.get(r.user_id) || 0) + 1);
console.log(`${targets.length} card(s) still due at the FSRS switch, across ${byDeck.size} deck(s):`);
for (const [user, n] of [...byDeck].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${user.slice(0, 8)}…  ${n}`);
}
if (skipped) console.log(`${skipped} row(s) at that instant don't match the migration's arithmetic; left alone.`);

if (!APPLY) {
  console.log("\nDry run: nothing written. Run again with --apply to back up and reset.");
  process.exit(0);
}
if (!targets.length) {
  console.log("Nothing to do.");
  process.exit(0);
}

// Back up every affected row, whole, before touching any of them.
const dir = path.join(ROOT, "backups");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `fsrs-seed-reset-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ seedInstant: SEED_INSTANT, rows: targets }, null, 2));
console.log(`\nBacked up ${targets.length} row(s) to ${path.relative(ROOT, file)}`);

// Reset in chunks. The filter repeats the instant and the state, so a card
// answered between the read above and this write is not reset.
const RESET = {
  fsrs_state: 0,
  stability: null,
  difficulty: null,
  reps: 0,
  lapses: 0,
  last_review: null,
  last_answer_correct: null,
};
let written = 0;
for (let i = 0; i < targets.length; i += 200) {
  const ids = targets.slice(i, i + 200).map((r) => r.id);
  const out = await db(
    `user_cards?id=in.(${ids.join(",")})&next_due_at=eq.${encodeURIComponent(SEED_INSTANT)}&fsrs_state=neq.0`,
    { method: "PATCH", body: JSON.stringify(RESET) }
  );
  written += out.length;
}
console.log(`Reset ${written} of ${targets.length} to not yet seen.`);
if (written !== targets.length) {
  console.log("The difference was answered in the meantime, and keeps its real state.");
}
