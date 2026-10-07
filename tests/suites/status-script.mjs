// scripts/status-check.mjs, the status check from the command line, run
// against a stand-in Supabase (the auth admin list and every table it reads)
// holding a simulated student's record. Checks that it finds the admin's
// account, reads every page of answers, runs the eleven checks, says so
// plainly when migration_013 or migration_016 hasn't been run, lists every
// detail with --all, and never sends anything but a GET. And what it reads
// for the two checks of the deck (2026-10-06): Claude's verdicts on look-alike
// cards, the owner's corrections and why cards were taken out, with a card in
// the deck twice and a deleted card back each failing their check. And the
// morning check, --everyone: every student, what the server's daily run last
// asked Claude about look-alikes, and the three tests of Claude's work with
// any slip named. No browser; the stand-in's address replaces SUPABASE_URL,
// so nothing leaves the machine.
process.env.TZ = "America/New_York";

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { checker } from "../check.mjs";
import { simulate, USER_ID, standInVerdicts } from "../simulate/student.mjs";

const ck = checker();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "status-check.mjs");
const KEY = "stand-in-service-key";
const STUDENT = "student@example.com";

const rec = simulate({ days: 40, seed: 7, cards: 260, student: "typical" });
const end = Date.parse(rec.answers.at(-1).answered_at);
const CORRECTION = { id: "c1", user_id: USER_ID, action: "delete", category: "other", card_id: 999001, original_front: "Naza", original_back: "Naza (a name)", created_at: rec.cards[0].created_at };
const pairsOf = (cards) => standInVerdicts(cards, new Date(end).toISOString()).map((p, i) => ({ id: `p${String(i).padStart(4, "0")}`, user_id: USER_ID, ...p }));

// The stand-in. `state.migrated` false answers dealt_sets as a missing table
// (before migration_013), `state.m16` false card_pairs (before migration_016).
// Filters and order as PostgREST reads them: col=eq.x, col=in.(a,b),
// order=col.asc|desc, offset and limit.
const state = {
  migrated: true, m16: true, requests: [], answers: rec.answers, cards: rec.cards,
  pairs: pairsOf(rec.cards), corrections: [CORRECTION], reports: [], runs: [],
};
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
  const tables = {
    card_reviews: state.answers, user_cards: state.cards, dealt_sets: rec.deals, fsrs_settings: [rec.settings],
    card_pairs: state.pairs, parse_corrections: state.corrections, status_reports: state.reports, eval_runs: state.runs,
  };
  const missing = (name) => send(404, { code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` });
  if (!m || !(m[1] in tables)) return missing(m?.[1]);
  if (m[1] === "dealt_sets" && !state.migrated) return missing("dealt_sets");
  if (m[1] === "card_pairs" && !state.m16) return missing("card_pairs");
  let rows = tables[m[1]];
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "offset", "limit"].includes(k)) continue;
    if (v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3));
    else if (v.startsWith("in.(")) { const set = v.slice(4, -1).split(","); rows = rows.filter((r) => set.includes(String(r[k]))); }
  }
  const order = url.searchParams.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === "desc" ? -1 : 1));
  }
  const offset = Number(url.searchParams.get("offset") || 0);
  const limit = Number(url.searchParams.get("limit") || rows.length);
  return send(200, rows.slice(offset, offset + limit));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Runs the script. ADMIN_EMAIL is a space: set, so a .env.local can't fill it
// in, and blank, so the script falls back to VITE_ADMIN_EMAIL. HOME is a
// fresh folder, so the morning check's list of problems already raised
// (kept under the home folder) is this run's own, never the owner's.
const HOME = mkdtempSync(join(tmpdir(), "status-script-home-"));
const RAISED = join(HOME, ".claude", "scheduled-tasks", "morning-check", "raised.json");
function run(args = [], env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH, HOME,
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
  ck("all eleven checks reported", marks.length === 11, `${marks.length}`);
  ck("it read Claude's verdicts, why cards were taken out, and the corrections",
     r.out.includes(`${state.pairs.length} verdicts of Claude's on look-alike cards, 0 cards removed, 1 correction.`) &&
     ["card_pairs", "parse_corrections"].every((t) => state.requests.some((q) => q.path === `/rest/v1/${t}`)), r.out.split("\n")[1]);
  ck("the deck holds each card once, judged with every verdict", /\[PASS\] No card is in your deck twice: None of your \d+ cards in study is there twice: by the rule, and Claude judged all \d+ look-alike pairs different/.test(r.out),
     r.out.match(/\[\w+\] No card is in your deck twice[^\n]*/)?.[0]);
  ck("and nothing the owner deleted is back", /\[PASS\] Nothing you deleted or corrected came back: The card you deleted or corrected isn't back\./.test(r.out),
     r.out.match(/\[\w+\] Nothing you deleted[^\n]*/)?.[0]);
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

console.log("\n  before migration_016");
{
  state.m16 = false;
  const r = await run();
  state.m16 = true;
  ck("it says the update hasn't been run", /No card_pairs table yet \(migration_016 not run\)/.test(r.out), r.out.split("\n")[1]);
  ck("and the check of look-alikes waits rather than fails", /\[WAIT\] No card is in your deck twice[^\n]*migration_016/.test(r.out));
}

console.log("\n  a card twice, and a deleted card back");
{
  // "le cas" made again beside "un cas", and Claude's verdict: one card.
  const extra = [
    { id: 990001, user_id: USER_ID, front: "un cas", back: "an instance", category: "V", dates: [], source: "cahier-upload", created_at: new Date(end - 9 * 86400000).toISOString(), fsrs_state: 0, en_fsrs_state: 0 },
    { id: 990002, user_id: USER_ID, front: "le cas", back: "the case", category: "V", dates: [], source: "cahier-upload", created_at: new Date(end - 2 * 86400000).toISOString(), fsrs_state: 0, en_fsrs_state: 0 },
    { id: 990003, user_id: USER_ID, front: "Naza", back: "Naza (a brand)", category: "V", dates: [], source: "cahier-upload", created_at: new Date(end - 3 * 86400000).toISOString(), fsrs_state: 0, en_fsrs_state: 0 },
  ];
  state.cards = [...rec.cards, ...extra];
  state.pairs = [...pairsOf(rec.cards), { id: "p9999", user_id: USER_ID, card_a: 990001, card_b: 990002, a_front: "un cas", a_back: "an instance", b_front: "le cas", b_back: "the case", verdict: "same", asked_at: new Date(end - 86400000).toISOString() }];
  const r = await run();
  ck("Claude's verdict that two cards in study are one card fails the check, naming them",
     /\[FAIL\] No card is in your deck twice: 1 card in study repeats another card\.\n {2}- “un cas” and “le cas” are one card twice: Claude judged them the same card to learn/.test(r.out), r.out.match(/\[FAIL\] No card[^\n]*\n[^\n]*/)?.[0]);
  ck("a card the owner deleted, made again, fails the other, naming it",
     /\[FAIL\] Nothing you deleted or corrected came back: 1 card you deleted or corrected is back in study\.\n {2}- “Naza” is back in study: you deleted it on/.test(r.out), r.out.match(/\[FAIL\] Nothing[^\n]*\n[^\n]*/)?.[0]);
  ck("and the script exits 1", r.code === 1);
  state.cards = rec.cards;
  state.pairs = pairsOf(rec.cards);
}

console.log("\n  the morning check: --everyone");
{
  state.requests = [];
  const run1 = (version, results, ranAt) => ({ id: `r-${version}-${ranAt}`, kind: "repeats", ran_at: ranAt, version, model: "m", cases: results.length, passed: results.filter((c) => c.got.every((v) => v === c.says)).length, summary: {}, results });
  const okCase = { id: "apart:ou", says: "different", a: { front: "ou", back: "or" }, b: { front: "où", back: "where" }, got: ["different", "different", "different"] };
  const slip = { ...okCase, got: ["same", "same", "different"] };
  state.runs = [run1("aaaaaaa", [okCase], "2026-10-07T15:00:00Z"), run1("bbbbbbb", [slip], "2026-10-14T15:00:00Z")];
  state.reports = [{ id: "k1", user_id: USER_ID, user_email: STUDENT, checked_at: "2026-10-14T14:00:30Z", ok: true, failing: 0, answers: 10,
    report: { results: [], judging: { asked: 200, answered: 200, same: 1, left: 675, error: null } } }];
  const r = await run(["--everyone"]);
  ck("it checks every student who has answered, now", /Every student who has answered \(1\), checked now:/.test(r.out) && r.out.includes(STUDENT), r.out.split("\n")[0]);
  ck("it reads what the daily run last asked Claude about look-alikes, and what is left for tomorrow",
     /Look-alike cards put to Claude by the daily run:\n {2}student@example\.com, 2026-10-14: 200 pairs put to Claude this morning\. Claude judged 1 pair the same card and 199 different\. 675 pairs left for tomorrow\./.test(r.out),
     r.out.match(/Look-alike cards put to Claude[^\n]*\n[^\n]*/)?.[0]);
  ck("it reports the test of Claude's same-or-different question like the other two",
     /Claude's marking of typed answers: not tested yet\./.test(r.out) && /Claude reading class notes into cards: not tested yet\./.test(r.out) &&
     /Claude judging whether two look-alike cards are the same card: last tested 2026-10-14 \(version bbbbbbb, 0 of 1 right every time\)\./.test(r.out),
     r.out.match(/Claude judging[^\n]*/)?.[0]);
  ck("  naming a slip after a change to the question", /- Since the last change to how Claude is asked, it calls “ou” and “où” the same card, which it kept apart before\./.test(r.out));
  const slipLine = "Claude judging whether two look-alike cards are the same card: Since the last change to how Claude is asked, it calls “ou” and “où” the same card, which it kept apart before.";
  ck("  so something new needs looking at, and it exits 1",
     (r.out.split("New since the last morning check")[1] || "").includes(`- ${slipLine}`) && /Something new needs looking at\./.test(r.out) && r.code === 1,
     r.out.split("\n").slice(-2).join(" "));
  ck("  without --record the list of problems raised is only read", !existsSync(RAISED));
  const recorded = await run(["--everyone", "--record"]);
  const again = await run(["--everyone"]);
  ck("--record keeps what was raised, so the next morning it is not new, and exits 0",
     recorded.code === 1 && existsSync(RAISED) && slipLine in JSON.parse(readFileSync(RAISED, "utf8")) &&
       (again.out.split("Raised with the owner before and still failing")[1] || "").includes(`- ${slipLine} (raised `) &&
       !/New since the last morning check/.test(again.out) && /Nothing new: everything still failing was raised before\./.test(again.out) && again.code === 0,
     again.out.split("\n").slice(-3).join(" "));
  ck("it read Claude's verdicts and the corrections for every student", ["card_pairs", "parse_corrections", "status_reports", "eval_runs"].every((t) => state.requests.some((q) => q.path === `/rest/v1/${t}`)));
  ck("and only ever read", state.requests.every((q) => q.method === "GET"), [...new Set(state.requests.map((q) => q.method))].join(","));

  state.runs = [run1("bbbbbbb", [okCase], "2026-10-07T15:00:00Z"), run1("bbbbbbb", [slip], "2026-10-14T15:00:00Z")];
  state.reports[0].report.judging = { asked: 200, answered: 0, same: 0, left: 675, error: "Claude couldn't be asked about 200: 529 overloaded" };
  const down = await run(["--everyone"]);
  ck("between two runs of the same question a wrong case isn't a slip", /Claude judging whether[^\n]*\n {2}Nothing it got right before is wrong now\./.test(down.out), down.out.match(/Claude judging[^\n]*\n[^\n]*/)?.[0]);
  ck("but a daily run that couldn't ask Claude is said, and needs looking at",
     /Claude couldn't be asked about 200: 529 overloaded\. 675 pairs left for tomorrow\./.test(down.out) && down.code === 1, down.out.match(/student@example\.com, 2026[^\n]*/)?.[0]);
  // The problem's line is its key in the list of problems raised, so it
  // can't hold the error, whose count of pairs and request id change every
  // morning: a run that failed each day was raised as new each day. The error
  // is printed beneath the line instead.
  const downLine = `${STUDENT}: the daily run couldn't ask Claude about look-alike cards`;
  ck("  under a line of its own, with the error itself beneath it",
     (down.out.split("New since the last morning check")[1] || "").includes(`- ${downLine}\n      Claude couldn't be asked about 200: 529 overloaded`),
     (down.out.split("New since the last morning check")[1] || "").split("\n").slice(0, 4).join(" / "));
  await run(["--everyone", "--record"]);
  state.reports[0].report.judging = { asked: 212, answered: 0, same: 0, left: 690,
    error: "Claude couldn't be asked about 212: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"},\"request_id\":\"req_011CTd8\"}" };
  const nextDay = await run(["--everyone"]);
  ck("the same failure the next morning, with another count and request id, was raised before: not new, and it exits 0",
     (nextDay.out.split("Raised with the owner before and still failing")[1] || "").includes(`- ${downLine} (raised `) &&
       nextDay.out.includes("      Claude couldn't be asked about 212: 401") &&
       !/New since the last morning check/.test(nextDay.out) && nextDay.code === 0,
     nextDay.out.split("\n").slice(-6).join(" / "));
  state.runs = [];
  state.reports = [];
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
