// scripts/status-check.mjs, the status check from the command line, run
// against a stand-in Supabase (the auth admin list and the four tables it
// reads) holding a simulated student's record. Checks that it finds the
// admin's account, reads every page of answers, runs the nine checks, says so
// plainly when migration_013 hasn't been run, lists every detail with --all,
// and never sends anything but a GET. No browser; the stand-in's address
// replaces SUPABASE_URL, so nothing leaves the machine.
process.env.TZ = "America/New_York";

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checker } from "../check.mjs";
import { simulate, USER_ID } from "../simulate/student.mjs";

const ck = checker();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "status-check.mjs");
const KEY = "stand-in-service-key";
const STUDENT = "student@example.com";

const rec = simulate({ days: 40, seed: 7, cards: 260, student: "typical" });

// The stand-in. `state.migrated` false answers dealt_sets as a missing table.
const state = { migrated: true, requests: [], answers: rec.answers };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, apikey: req.headers.apikey });
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method !== "GET") return send(405, { message: "the stand-in only answers reads" });
  if (req.headers.apikey !== KEY || req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: "no key" });
  if (url.pathname === "/auth/v1/admin/users") {
    return send(200, { users: [{ id: "someone-else", email: "other@example.com" }, { id: USER_ID, email: STUDENT }] });
  }
  const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
  const tables = { card_reviews: state.answers, user_cards: rec.cards, dealt_sets: rec.deals, fsrs_settings: [rec.settings] };
  if (!m || !(m[1] in tables)) return send(404, { code: "PGRST205", message: "no such table" });
  if (m[1] === "dealt_sets" && !state.migrated) return send(404, { code: "PGRST205", message: "Could not find the table 'public.dealt_sets' in the schema cache" });
  const user = (url.searchParams.get("user_id") || "").replace(/^eq\./, "");
  let rows = tables[m[1]].filter((r) => r.user_id === user);
  if (url.searchParams.get("order") === "id.asc") rows = [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  const offset = Number(url.searchParams.get("offset") || 0);
  const limit = Number(url.searchParams.get("limit") || rows.length);
  return send(200, rows.slice(offset, offset + limit));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Runs the script. ADMIN_EMAIL is a space: set, so a .env.local can't fill it
// in, and blank, so the script falls back to VITE_ADMIN_EMAIL.
function run(args = [], env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: KEY,
        ADMIN_EMAIL: " ", VITE_ADMIN_EMAIL: STUDENT, TZ: "America/New_York",
        ...env,
      },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code, out }));
  });
}

console.log("\n  the admin's own record, found without being named");
{
  state.requests = [];
  const r = await run(["--tz", "America/New_York"]);
  ck("it names the student it checked", r.out.startsWith(`${STUDENT}:`), r.out.split("\n")[0]);
  ck(`it read every answer, across pages of a thousand (${rec.answers.length})`, r.out.includes(`${rec.answers.length} answers on record`), r.out.split("\n")[0]);
  ck("and how many carry their settings", /\(\d+ saved with their settings\)/.test(r.out) && !/\(0 saved/.test(r.out));
  ck("it read the sets and the settings", r.out.includes(`${rec.deals.length} sets recorded`) && /Settings: automatic, now \d+%/.test(r.out), r.out.split("\n").slice(0, 2).join(" | "));
  const marks = r.out.split("\n").filter((l) => /^\[(PASS|FAIL|WAIT)\]/.test(l));
  ck("all nine checks reported", marks.length === 9, `${marks.length}`);
  // Predictions against results depends on the invented student's memory and
  // on which 30 days count as recent, so it isn't this suite's business; the
  // checks of what the app did are, and the exit code must say if any failed.
  const failed = marks.filter((l) => l.startsWith("[FAIL]"));
  ck("the simulated record passes every check of what the app did", failed.every((l) => l.includes("predictions")), failed.join(" | "));
  ck("and the exit code says whether any check failed", r.code === (failed.length ? 1 : 0), `exit ${r.code}, ${failed.length} failed`);
  ck("it only ever read: every request a GET", state.requests.length > 0 && state.requests.every((q) => q.method === "GET"), [...new Set(state.requests.map((q) => q.method))].join(","));
  ck("and asked for answers more than once, a page at a time", state.requests.filter((q) => q.path === "/rest/v1/card_reviews").length >= 3);
}

console.log("\n  named with --email");
{
  const r = await run(["--email", "Other@Example.com"]);
  ck("another account is checked when named, whatever the case of the address", r.out.startsWith("other@example.com: 0 answers on record"), r.out.split("\n")[0]);
  const nobody = await run(["--email", "nobody@example.com"]);
  ck("an address with no account says so and fails", /No account for nobody@example.com/.test(nobody.out) && nobody.code === 1, nobody.out.trim());
  const none = await run([], { VITE_ADMIN_EMAIL: "" });
  ck("with no address anywhere it asks whose record", /Whose record\?/.test(none.out) && none.code === 1, none.out.trim());
}

console.log("\n  before migration_013");
{
  state.migrated = false;
  const r = await run();
  state.migrated = true;
  ck("it says the update hasn't been run", /no dealt_sets table yet \(migration_013 not run\)/.test(r.out), r.out.split("\n")[0]);
  ck("and the set checks wait rather than fail", /\[WAIT\] Due cards came before new ones[^\n]*Waiting for the database update/.test(r.out));
}

console.log("\n  a fault in the record");
{
  // Ten answers whose due dates are ten days off what FSRS gives.
  const counted = rec.answers.filter((a) => a.counted && a.state_before === 2).slice(0, 10);
  state.answers = rec.answers.map((a) => (counted.includes(a) ? { ...a, due_after: new Date(Date.parse(a.due_after) + 10 * 86400000).toISOString() } : a));
  const r = await run();
  ck("fails, and the script exits 1", /\[FAIL\] Every answer was scheduled the way FSRS says: 10 of/.test(r.out) && r.code === 1, r.out.match(/\[FAIL\][^\n]*/)?.[0]);
  ck("six examples, then how many more", /and 4 more/.test(r.out));
  const all = await run(["--all"]);
  const lines = all.out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("[FAIL] Every answer was scheduled"));
  const details = lines.slice(at + 1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith("  - "))).length;
  ck("--all lists all ten", details === 10 && !/and \d+ more/.test(all.out.split("[FAIL] Every answer")[1].split("\n[")[0]), `${details} listed`);
  state.answers = rec.answers;
}

server.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
