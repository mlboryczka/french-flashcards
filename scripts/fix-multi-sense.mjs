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
// alone. That mirrors api/apply-splits.js exactly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { findMultiSenseCards } from "../src/lib/multiSense.js";
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
      `user_cards?select=id,user_id,front,back,category${scope}&order=id.asc`,
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
async function applySplit(original, cards) {
  const [first, ...rest] = cards;

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

  const ins = await db("user_cards?on_conflict=user_id,front", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(
      rest.map((c) => ({
        user_id: original.user_id,
        front: c.front.trim(),
        back: c.back.trim(),
        category: c.category || original.category,
        dates: [],
        source: "sense-split",
      }))
    ),
  });
  if (!ins.ok) throw new Error(`insert for ${original.id}: ${ins.status} ${await ins.text()}`);
  return rest.length;
}

// ── run ─────────────────────────────────────────────────────────────────────
const deck = await loadDeck();
console.log(`Deck: ${deck.length} cards${DECK_USER_ID ? ` (user ${DECK_USER_ID})` : ""}`);

// looksMultiSense reads `card.b ?? card.back`, so raw rows go straight in and
// come straight back out — no reshaping, and no chance of dropping the id.
const suspects = findMultiSenseCards(deck);
console.log(`Shortlisted by the local scanner: ${suspects.length}`);
if (!suspects.length) process.exit(0);

const byId = new Map(suspects.map((r) => [String(r.id), r]));
let splits = 0;
let kept = 0;
let newCards = 0;
let refused = 0;

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
    splits++;
    console.log(`    ✂ ${original.front}  [${original.back}]`);
    for (const c of r.cards) console.log(`        → ${c.front}  —  ${c.back}`);
    console.log(`        (${r.reason})`);
    if (APPLY) {
      try {
        newCards += await applySplit(original, r.cards);
      } catch (e) {
        console.log(`        WRITE FAILED: ${e.message}`);
        splits--;
      }
    }
  }
}

console.log(
  `\n${APPLY ? "Applied" : "Would apply"}: ${splits} split(s), ` +
    `${newCards || "…"} new card(s). Kept ${kept}. Refused ${refused} malformed.`
);
if (!APPLY) console.log("Nothing was written. Re-run with --apply to perform it.");
