#!/usr/bin/env node
// Clear feedback off the admin list once it has been dealt with.
//
//   node scripts/resolve-feedback.mjs                               # list what is open
//   node scripts/resolve-feedback.mjs 24 25 --note "..."            # show what would be resolved
//   node scripts/resolve-feedback.mjs 24 25 --note "..." --apply    # and resolve it
//   node scripts/resolve-feedback.mjs --all --note "..." --apply    # every open entry
//
// Resolving sets resolved_at (and resolution, from --note) on beta_feedback,
// which takes the entry off both admin views. Nothing is deleted: a resolved
// row stays in the table until someone clears them in the SQL editor.
//
// This is the last step of working through feedback. Fix the card or the
// code, then resolve the entries that fix answers, with a note saying what
// was done — so the list only ever holds what is still waiting.
//
// Needs migration_009. Without it the script says so and writes nothing.
//
// Environment (a .env.local in the repo root is read automatically):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all");
const noteAt = args.indexOf("--note");
const NOTE = noteAt >= 0 ? args[noteAt + 1] : null;
const IDS = args.filter((a, i) => /^\d+$/.test(a) && (noteAt < 0 || i !== noteAt + 1)).map(Number);

for (const file of [".env.local", ".env"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const missing = Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}\nPut them in .env.local or the environment.`);
  process.exit(1);
}

const db = async (p, init = {}) => {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

let open;
try {
  open = await db(
    "beta_feedback?select=id,user_email,message,card_context,created_at&resolved_at=is.null&order=created_at.asc"
  );
} catch (e) {
  if (/resolved_at/.test(e.message)) {
    console.error(
      "beta_feedback has no resolved_at column yet. Run migrations/migration_009_beta_feedback_resolved.sql in the Supabase SQL editor first."
    );
    process.exit(1);
  }
  throw e;
}

const line = (r) => {
  const card = r.card_context?.front ? `  [${r.card_context.front}]` : "";
  return `  #${r.id}  ${r.created_at.slice(0, 10)}  ${r.message}${card}`;
};

if (!ALL && IDS.length === 0) {
  console.log(open.length ? `${open.length} open:` : "No open feedback.");
  open.forEach((r) => console.log(line(r)));
  process.exit(0);
}

const openIds = new Set(open.map((r) => r.id));
const unknown = IDS.filter((id) => !openIds.has(id));
if (unknown.length) {
  console.error(`Not open (already resolved, or no such entry): ${unknown.join(", ")}`);
  process.exit(1);
}
const targets = ALL ? open : open.filter((r) => IDS.includes(r.id));
if (!NOTE) {
  console.error('Say what was done: --note "…". It is what the resolved entry is kept for.');
  process.exit(1);
}

console.log(`${APPLY ? "Resolving" : "Would resolve"} ${targets.length}:`);
targets.forEach((r) => console.log(line(r)));
console.log(`  note: ${NOTE}`);
if (!APPLY) {
  console.log("\nNothing written. Add --apply to resolve.");
  process.exit(0);
}

const rows = await db(`beta_feedback?id=in.(${targets.map((r) => r.id).join(",")})`, {
  method: "PATCH",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({ resolved_at: new Date().toISOString(), resolution: NOTE }),
});
console.log(`\nResolved ${rows.length} of ${targets.length}.`);
if (rows.length !== targets.length) process.exit(1);
