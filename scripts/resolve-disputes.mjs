#!/usr/bin/env node
// Work the backlog of "my answer should have been accepted" claims.
//
//   node scripts/resolve-disputes.mjs            # adjudicate, write nothing
//   node scripts/resolve-disputes.mjs --apply    # and record the outcomes
//
// A dispute is raised from the study view and adjudicated by /api/review-answer
// there and then — but only while that request succeeds. Anything that timed
// out, was raised before the endpoint existed, or was left at "uncertain" sits
// unresolved in feedback_submissions with nobody looking at it.
//
// For each pending row this asks Claude the same question the endpoint asks,
// and then:
//   accept    → the answer is added to card_alternates, so it is accepted from
//               now on, and the row is marked approved
//   reject    → the row is marked rejected, with the reasoning recorded
//   uncertain → LEFT ALONE. A machine that cannot decide should not be the
//               thing that closes a complaint about its own marking.
//
// Note on the table: nothing in the current code writes feedback_submissions
// any more — a dispute now goes to /api/review-answer, which decides and writes
// card_alternates on the spot. So what is left in there is an older backlog
// that no path has looked at since. The admin view still lists it.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

for (const file of [".env.local", ".env"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY } = process.env;
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

// Same question /api/review-answer asks, and the same narrowness: this decides
// whether ONE typed answer was acceptable for ONE card, not whether the card is
// any good.
const VERDICT_TOOL = {
  name: "record_verdict",
  description: "Record whether the learner's typed answer should have been accepted.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["accept", "reject", "uncertain"],
        description:
          "accept if it is a correct rendering of the card, reject if it is wrong, uncertain if it genuinely turns on something you cannot see.",
      },
      reasoning: { type: "string", description: "One sentence the learner will read." },
    },
    required: ["verdict", "reasoning"],
  },
};

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function adjudicate(row) {
  const asked = row.direction === "fr" ? row.card_front : row.card_back;
  const expected = row.direction === "fr" ? row.card_back : row.card_front;

  const msg = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 1000,
    system:
      "You adjudicate a single flashcard answer for an English-speaking learner of French. " +
      "Accept an answer that means the same thing as the expected one — a synonym, a different " +
      "register, a missing article where the card's own front does not supply one, a spelling " +
      "slip that leaves the word unambiguous. Reject a different word, a wrong gender where the " +
      "card is teaching gender, or a guess that happens to be close. Be decisive; reserve " +
      "'uncertain' for a genuine ambiguity in the card itself.",
    tools: [VERDICT_TOOL],
    tool_choice: { type: "tool", name: "record_verdict" },
    messages: [
      {
        role: "user",
        content:
          `Card: ${row.card_front}  —  ${row.card_back}\n` +
          `Shown: ${asked}\nExpected: ${expected}\nThey typed: ${row.user_answer}`,
      },
    ],
  });

  const call = (msg.content || []).find(
    (b) => b.type === "tool_use" && b.name === "record_verdict"
  );
  return call?.input || null;
}

// The live table and supabase/schema.sql disagree about how a dispute is
// marked done: the schema declares `status` ('pending'|'approved'|'rejected'),
// while the admin view in FlashcardApp filters on `reviewed = false` and writes
// `action`. One of them is stale and there is no way to tell which from here,
// so the shape is read off an actual row rather than assumed — and if neither
// pair is present, this stops instead of PATCHing columns that don't exist.
let SHAPE = null;

async function detectShape() {
  const res = await db("feedback_submissions?select=*&limit=1");
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  const [row] = await res.json();
  if (!row) return null; // empty table: nothing to do, shape irrelevant
  if ("reviewed" in row) return { done: "reviewed", verdictCol: "action", openFilter: "reviewed=is.false" };
  if ("status" in row) return { done: "status", verdictCol: "status", openFilter: "status=eq.pending" };
  throw new Error(
    `feedback_submissions has neither 'reviewed' nor 'status'. Columns: ${Object.keys(row).join(", ")}`
  );
}

async function pending() {
  SHAPE = await detectShape();
  if (!SHAPE) return [];
  console.log(`Table marks completion with '${SHAPE.done}'.`);
  const res = await db(
    `feedback_submissions?select=*&${SHAPE.openFilter}&order=created_at.asc`
  );
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function record(row, verdict) {
  if (verdict.verdict === "accept") {
    // Teach the card this answer, so the same claim cannot be raised twice.
    const ins = await db("card_alternates?on_conflict=user_id,card_id,direction,alternate_text", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        user_id: row.user_id,
        card_id: row.card_id,
        direction: row.direction,
        alternate_text: row.user_answer,
        source_feedback_id: row.id,
      }),
    });
    if (!ins.ok) throw new Error(`alternate: ${ins.status} ${await ins.text()}`);
  }

  const outcome = verdict.verdict === "accept" ? "approved" : "rejected";
  const patch = { reviewed_at: new Date().toISOString() };
  if (SHAPE.done === "reviewed") {
    patch.reviewed = true;
    patch.action = outcome;
  } else {
    patch.status = outcome;
  }
  // Only send these if the row actually carries them.
  if ("llm_verdict" in row) patch.llm_verdict = verdict.verdict;
  if ("llm_reasoning" in row) patch.llm_reasoning = verdict.reasoning;

  const upd = await db(`feedback_submissions?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!upd.ok) throw new Error(`update: ${upd.status} ${await upd.text()}`);
}

// ── run ─────────────────────────────────────────────────────────────────────
const rows = await pending();
console.log(`Pending disputes: ${rows.length}`);
if (!rows.length) process.exit(0);

const tally = { accept: 0, reject: 0, uncertain: 0, failed: 0 };

for (const row of rows) {
  let v;
  try {
    v = await adjudicate(row);
  } catch (e) {
    tally.failed++;
    console.log(`  ! ${row.card_front}: ${e.message}`);
    continue;
  }
  if (!v?.verdict) {
    tally.failed++;
    continue;
  }

  const mark = { accept: "✓", reject: "✗", uncertain: "?" }[v.verdict] || "?";
  console.log(`  ${mark} ${row.card_front} — they typed "${row.user_answer}"`);
  console.log(`      ${v.reasoning}`);
  tally[v.verdict]++;

  // An adjudicator that cannot decide has no business closing the complaint.
  if (v.verdict === "uncertain") {
    console.log("      left pending for you");
    continue;
  }
  if (APPLY) {
    try {
      await record(row, v);
    } catch (e) {
      console.log(`      WRITE FAILED: ${e.message}`);
      tally.failed++;
    }
  }
}

console.log(
  `\n${APPLY ? "Resolved" : "Would resolve"}: ${tally.accept} accepted, ` +
    `${tally.reject} rejected. ${tally.uncertain} left pending. ${tally.failed} failed.`
);
if (!APPLY) console.log("Nothing was written. Re-run with --apply to perform it.");
