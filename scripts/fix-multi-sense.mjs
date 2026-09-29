#!/usr/bin/env node
// Run the multi-sense cleanup across a whole deck.
//
//   node scripts/fix-multi-sense.mjs            # scan + audit, write nothing
//   node scripts/fix-multi-sense.mjs --apply    # and perform the writes
//
// The machinery for this has existed for a while — the scanner in
// src/lib/multiSense.js, the audit in api/split-senses.js, the writer in
// api/apply-splits.js — but nothing ever invoked it. The UI that drove it was
// removed on the grounds that deck maintenance is not a task to hand a
// student, which left it with no caller at all. This is the caller.
//
// It talks to Supabase and Anthropic directly rather than through the
// serverless functions, because those require a signed-in browser session.
// Same prompt and same schema as the endpoint, imported rather than copied.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   the deck to clean
//   ANTHROPIC_API_KEY                         who pays for the audit
//   DECK_USER_ID                              optional; omit for every user
//
// What a split does to scheduling: the original row is REWRITTEN as the first
// sense and keeps its history — it is still the card you have been studying,
// with the other headword's glosses removed. The remaining senses are new rows
// starting from New, which is honest: you have never been tested on them
// alone. They take the original's class dates, as api/apply-splits.js does.
//
// What it never does (fixed 2026-09-29; before, --apply could have):
//   • overwrite a card. A new sense whose front the deck already has is not
//     added, and a split whose first sense would take another card's front is
//     refused. New senses are plain inserts, so a clash fails rather than
//     writing over the card that is there.
//   • touch an archived card or a lesson card. Both are left out of the scan.
//   • write before backing up the rows it will rewrite, to backups/.
// The dry run reports exactly what --apply would do, skips included.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { findMultiSenseCards } from "../src/lib/multiSense.js";
import { ARCHIVE_PREFIX } from "../src/lib/archive.js";
import { SYSTEM_PROMPT, REPORT_TOOL, MODEL, MAX_CARDS } from "../api/split-senses.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

// ── config ──────────────────────────────────────────────────────────────────
for (const file of [".env.local", ".env"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, DECK_USER_ID } = process.env;
const missing = Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}\nPut them in .env.local or the environment.`);
  process.exit(1);
}

const db = (p, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

// ── 1. the deck ─────────────────────────────────────────────────────────────
async function loadDeck() {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const scope = DECK_USER_ID ? `&user_id=eq.${DECK_USER_ID}` : "";
    const res = await db(
      `user_cards?select=id,user_id,front,back,category,dates,source${scope}&order=id.asc`,
      { headers: { Range: `${from}-${from + PAGE - 1}` } }
    );
    if (!res.ok) throw new Error(`Deck fetch failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// ── 2. the audit ────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function audit(batch) {
  const payload = batch.map((c) => ({
    row_id: String(c.id),
    front: c.front,
    back: c.back,
    category: c.category,
  }));

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report_splits" },
    messages: [
      { role: "user", content: `Audit these cards:\n\n${JSON.stringify(payload, null, 2)}` },
    ],
  });

  const call = (msg.content || []).find(
    (b) => b.type === "tool_use" && b.name === "report_splits"
  );
  return Array.isArray(call?.input?.results) ? call.input.results : [];
}

// A proposal is only worth writing if it is actually two distinct, non-empty
// French cards. The endpoint refuses malformed splits at both ends; so do we.
function usable(result, original) {
  if (result?.action !== "split") return false;
  const cards = Array.isArray(result.cards) ? result.cards : [];
  if (cards.length < 2) return false;
  if (cards.some((c) => !c?.front?.trim() || !c?.back?.trim())) return false;
  const fronts = cards.map((c) => c.front.trim().toLowerCase());
  if (new Set(fronts).size !== fronts.length) return false;
  // A "split" that hands back the same single card it was given is a no-op.
  if (fronts.length === 2 && fronts.includes(original.front.trim().toLowerCase())) {
    const other = cards.find((c) => c.front.trim().toLowerCase() !== original.front.trim().toLowerCase());
    if (!other) return false;
  }
  return true;
}

// ── 3. the writes ───────────────────────────────────────────────────────────
// `adds` are only the senses the deck doesn't already have (see the plan).
async function applySplit(original, first, adds) {
  const upd = await db(`user_cards?id=eq.${original.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      front: first.front.trim(),
      back: first.back.trim(),
      category: first.category || original.category,
    }),
  });
  if (!upd.ok) throw new Error(`update ${original.id}: ${upd.status} ${await upd.text()}`);
  if (!adds.length) return 0;

  // A plain insert, never an upsert: a front that is already there makes this
  // fail instead of overwriting that card's answer, dates and source.
  const ins = await db("user_cards", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(
      adds.map((c) => ({
        user_id: original.user_id,
        front: c.front.trim(),
        back: c.back.trim(),
        category: c.category || original.category,
        dates: Array.isArray(original.dates) ? original.dates : [],
        source: "sense-split",
      }))
    ),
  });
  if (!ins.ok) throw new Error(`insert for ${original.id}: ${ins.status} ${await ins.text()}`);
  return adds.length;
}

// ── run ─────────────────────────────────────────────────────────────────────
const deck = await loadDeck();
console.log(`Deck: ${deck.length} cards${DECK_USER_ID ? ` (user ${DECK_USER_ID})` : ""}`);

// Archived cards are out of study, and lesson cards belong to their lesson:
// the lesson sync would put an edited one back. Neither is scanned.
const inStudy = deck.filter((c) => {
  const source = String(c.source || "");
  return !source.startsWith(ARCHIVE_PREFIX) && !source.startsWith("lesson:");
});
console.log(`In study (not archived, not a lesson card): ${inStudy.length}`);

// looksMultiSense reads `card.b ?? card.back`, so raw rows go straight in and
// come straight back out — no reshaping, and no chance of dropping the id.
const suspects = findMultiSenseCards(inStudy);
console.log(`Shortlisted by the local scanner: ${suspects.length}`);
if (!suspects.length) process.exit(0);

// Every front each student has, archived and lesson cards included, so no
// split is planned onto a card that is already there. Kept up to date as the
// plan goes, so two splits in one run can't both add the same front.
const frontKey = (f) => String(f || "").trim().toLowerCase();
const frontsByUser = new Map();
for (const c of deck) {
  if (!frontsByUser.has(c.user_id)) frontsByUser.set(c.user_id, new Set());
  frontsByUser.get(c.user_id).add(frontKey(c.front));
}

const byId = new Map(suspects.map((r) => [String(r.id), r]));
const plans = [];
let splits = 0;
let kept = 0;
let newCards = 0;
let refused = 0;
let alreadyThere = 0;

for (let i = 0; i < suspects.length; i += MAX_CARDS) {
  const batch = suspects.slice(i, i + MAX_CARDS);
  process.stdout.write(`  auditing ${i + 1}-${i + batch.length} of ${suspects.length}… `);
  let results;
  try {
    results = await audit(batch);
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    continue;
  }
  console.log("ok");

  for (const r of results) {
    const original = byId.get(String(r.row_id));
    if (!original) continue;
    if (!usable(r, original)) {
      if (r?.action === "split") {
        refused++;
        console.log(`    ~ refused malformed split: ${original.front}`);
      } else {
        kept++;
      }
      continue;
    }
    const fronts = frontsByUser.get(original.user_id);
    const [first, ...rest] = r.cards;
    if (frontKey(first.front) !== frontKey(original.front) && fronts.has(frontKey(first.front))) {
      refused++;
      console.log(`    ~ refused: "${first.front}" is already another card — ${original.front}`);
      continue;
    }
    const adds = rest.filter((c) => !fronts.has(frontKey(c.front)));
    const skipped = rest.filter((c) => fronts.has(frontKey(c.front)));
    alreadyThere += skipped.length;
    fronts.delete(frontKey(original.front));
    fronts.add(frontKey(first.front));
    for (const c of adds) fronts.add(frontKey(c.front));
    plans.push({ original, first, adds });
    splits++;
    console.log(`    ✂ ${original.front}  [${original.back}]`);
    console.log(`        → ${first.front}  —  ${first.back}   (this card, history kept)`);
    for (const c of adds) console.log(`        → ${c.front}  —  ${c.back}   (new card)`);
    for (const c of skipped) console.log(`        (not added: "${c.front}" is already a card in this deck)`);
    console.log(`        (${r.reason})`);
  }
}

if (APPLY && plans.length) {
  // Back up every row about to be rewritten, whole, before the first write.
  const ids = plans.map((p) => p.original.id);
  const rows = [];
  for (let i = 0; i < ids.length; i += 200) {
    const res = await db(`user_cards?id=in.(${ids.slice(i, i + 200).join(",")})&select=*`);
    if (!res.ok) throw new Error(`Backup read failed: ${res.status} ${await res.text()}`);
    rows.push(...(await res.json()));
  }
  fs.mkdirSync(path.join(ROOT, "backups"), { recursive: true });
  const backup = path.join(ROOT, "backups", `fix-multi-sense-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
  console.log(`\nBacked up ${rows.length} card(s) to ${path.relative(ROOT, backup)}`);

  for (const { original, first, adds } of plans) {
    try {
      newCards += await applySplit(original, first, adds);
    } catch (e) {
      console.log(`    WRITE FAILED for ${original.front}: ${e.message}`);
      splits--;
    }
  }
} else {
  newCards = plans.reduce((n, p) => n + p.adds.length, 0);
}

console.log(
  `\n${APPLY ? "Applied" : "Would apply"}: ${splits} split(s), ${newCards} new card(s). ` +
    `Kept ${kept}. Refused ${refused}. Senses already in the deck, not added: ${alreadyThere}.`
);
if (!APPLY) console.log("Nothing was written. Re-run with --apply to perform it.");
