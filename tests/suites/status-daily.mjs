// The status check on every student (api/_lib/statusDaily.js), against a
// stand-in Supabase holding three accounts: a simulated student studying by
// the app's rules, the same student's record with one answer scheduled nine
// days off, and an account that has never answered a card. Checks that each
// student is judged on their own record, that a fault is reported against the
// right student and nobody else, that an account with nothing to judge is
// left out, what is kept, and that before migration_015 the reports still come
// back but aren't kept. No browser, nothing leaves the machine.
process.env.TZ = "America/New_York";

import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { checker } from "../check.mjs";
import { simulate, USER_ID } from "../simulate/student.mjs";

const ck = checker();
const DAY = 86400000;
const KEY = "stand-in-service-key";

const rec = simulate({ days: 40, seed: 7, cards: 260, student: "typical" });
const now = Date.parse(rec.answers.at(-1).answered_at) + 3600000;

// The second student: the same record under another account, with one answer
// whose due date is nine days off what FSRS says.
const OTHER = "00000000-0000-0000-0000-00000000cafe";
const swap = (rows) => rows.map((r) => ({ ...r, user_id: OTHER }));
const other = { answers: swap(rec.answers), cards: swap(rec.cards), deals: swap(rec.deals), settings: { ...rec.settings, user_id: OTHER } };
const off = other.answers.find((r) => r.counted && r.state_before === 2 && r.correct);
off.due_after = new Date(Date.parse(off.due_after) + 9 * DAY).toISOString();

const state = { migrated: true, kept: [], methods: new Set() };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  state.methods.add(`${req.method} ${url.pathname}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, json) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.headers.apikey !== KEY) return send(401, { message: "no key" });
    if (url.pathname === "/auth/v1/admin/users") {
      return send(200, { users: [
        { id: USER_ID, email: "Typical@Example.com" },
        { id: OTHER, email: "faulty@example.com" },
        { id: "00000000-0000-0000-0000-0000000000aa", email: "new@example.com" },
      ] });
    }
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (m?.[1] === "status_reports") {
      if (!state.migrated) return send(404, { code: "PGRST205", message: "Could not find the table 'public.status_reports' in the schema cache" });
      if (req.method === "POST") { state.kept.push(...[].concat(JSON.parse(body))); res.writeHead(201); return res.end(); }
      return send(200, [...state.kept].sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1)));
    }
    if (req.method !== "GET") return send(405, { message: "only status_reports is written" });
    const tables = {
      card_reviews: [...rec.answers, ...other.answers],
      user_cards: [...rec.cards, ...other.cards],
      dealt_sets: [...rec.deals, ...other.deals],
      fsrs_settings: [rec.settings, other.settings],
    };
    if (!m || !(m[1] in tables)) return send(404, { code: "PGRST205", message: "no such table" });
    const user = (url.searchParams.get("user_id") || "").replace(/^eq\./, "");
    let rows = tables[m[1]].filter((r) => r.user_id === user);
    if (url.searchParams.get("order") === "id.asc") rows = [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || rows.length);
    return send(200, rows.slice(offset, offset + limit));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const db = createClient(`http://127.0.0.1:${server.address().port}`, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const { checkEveryone, saveReports, latestReports, STATUS_SCHEDULE } = await import("../../api/_lib/statusDaily.js");

console.log("\n  every student, each on their own record");
const reports = await checkEveryone(db, { now });
const byEmail = Object.fromEntries(reports.map((r) => [r.user_email, r]));
ck("the two students who have answered are checked; the one who hasn't is left out",
   reports.length === 2 && byEmail["typical@example.com"] && byEmail["faulty@example.com"] && !byEmail["new@example.com"],
   reports.map((r) => r.user_email).join(", "));
const good = byEmail["typical@example.com"];
ck("the student studying by the app's rules passes every check", good?.ok === true && good.failing === 0,
   JSON.stringify(good?.report?.results?.filter((r) => r.status === "fail").map((r) => r.summary)));
ck("and it says how many of their answers were judged", good?.answers > 0 && good.answers === good.report.answers, String(good?.answers));
const bad = byEmail["faulty@example.com"];
const fsrs = bad?.report?.results?.find((r) => r.id === "fsrs");
ck("the answer nine days off fails its check, for that student only", bad?.ok === false && fsrs?.status === "fail" && bad.failing >= 1,
   fsrs?.summary);
ck("and the report names the card", (fsrs?.details || []).some((d) => /comes back in \d+ days, where FSRS says/.test(d)), fsrs?.details?.[0]);

console.log("\n  kept for the Status window");
const saved = await saveReports(db, reports);
ck("the reports are kept, one row a student", saved.ok && state.kept.length === 2);
const row = state.kept.find((r) => r.user_email === "faulty@example.com");
ck("each with whether it passed, how many checks failed, how many answers were judged and the report",
   row && row.ok === false && row.failing >= 1 && row.answers > 0 && Array.isArray(row.report?.results) && row.user_id === OTHER,
   JSON.stringify({ ok: row?.ok, failing: row?.failing, answers: row?.answers }));
state.kept.push({ ...row, ok: true, failing: 0, checked_at: new Date(Date.parse(row.checked_at) - DAY).toISOString() });
const latest = await latestReports(db);
ck("the window reads the latest for each student, not an older one", latest.reports.length === 2 &&
   latest.reports.find((r) => r.user_email === "faulty@example.com").ok === false);
ck("nothing but the reports was written", [...state.methods].every((m) => m.startsWith("GET ") || m === "POST /rest/v1/status_reports"),
   [...state.methods].filter((m) => !m.startsWith("GET ")).join(", "));

console.log("\n  before migration_015");
state.migrated = false;
const notKept = await saveReports(db, reports);
ck("the reports aren't kept, and it says why rather than failing", notKept.missing === true);
const none = await latestReports(db);
ck("and the window is told it's waiting", none.missing === true && none.reports.length === 0);

ck("the daily run's schedule is the one in vercel.json", (await import("node:fs")).readFileSync(new URL("../../vercel.json", import.meta.url), "utf8").includes(`"schedule": "${STATUS_SCHEDULE}"`));

server.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
