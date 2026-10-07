// Vercel cron: GET /api/cahier-daily (see vercel.json)
//
// Reads every linked cahier once a day, so a class Laura adds after a lesson
// is already cards the next morning — whether or not the student opened the
// app. Opening the app checks too (useCahierSync); this is what covers the
// student who doesn't.
//
// Nothing here decides anything: it walks the linked docs and calls the same
// sync the app calls (api/cahier-sync.js), so there is one set of rules about
// what gets parsed and what gets written.
//
// Three more schedules in vercel.json do other daily work instead. Vercel says
// which schedule called in the x-vercel-cron-schedule header. They live here
// because the Hobby plan deploys at most 12 routes and there are 12.
//
//   STATUS_SCHEDULE   the status check on every student, kept for the Status
//                     window (api/_lib/statusDaily.js); first, Claude is
//                     asked about look-alike cards in study it hasn't judged
//                     yet, up to a cap a student a day (since 2026-10-06)
//   ANSWERS_SCHEDULE  the test of Claude's verdicts on disputed answers
//                     (api/_lib/answerChecks.js), when it is due
//   NOTES_SCHEDULE    the test of Claude reading class notes, against the
//                     owner's corrections (api/_lib/notesChecks.js), when due
//
// A third test, of Claude's same-or-different question about look-alike
// cards (api/_lib/repeatsChecks.js, 2026-10-06), has no schedule of its own:
// it runs in either of the last two when that one's own test isn't due, so
// no fifth cron is needed. On a day both of theirs are due it waits a day.
//
// "Due" is api/_lib/evalRuns.js's: never run, the way Claude is asked has
// changed since, or a week since the last run. Otherwise those tests do
// nothing and cost nothing.
//
// AUTHENTICATION. Vercel sends `Authorization: Bearer $CRON_SECRET` with every
// cron request when that variable is set. Without CRON_SECRET this route
// refuses to run at all rather than leaving a URL that any caller could use to
// spend the deploy owner's Anthropic credit.

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { syncUser } from "./cahier-sync.js";
import { fetchGoogleDoc, sliceIntoBlocks, extractCardsFromBlock, cardsFromExtracted } from "./parse-cahier.js";
import { STATUS_SCHEDULE, checkEveryone, saveReports } from "./_lib/statusDaily.js";
import { adminEmail } from "./_lib/auth.js";
import { isDue } from "./_lib/evalRuns.js";
import { ANSWER_PROMPT_VERSION, runAnswerTest, supabaseAnswerStore } from "./_lib/answerChecks.js";
import { NOTES_PROMPT_VERSION, runNotesTest, supabaseNotesStore } from "./_lib/notesChecks.js";
import { REPEATS_PROMPT_VERSION, runRepeatsTest, supabaseRepeatsStore } from "./_lib/repeatsChecks.js";

export const ANSWERS_SCHEDULE = "0 15 * * *";
export const NOTES_SCHEDULE = "0 16 * * *";
// Stop starting new calls to Claude after this long, leaving the function's
// five minutes room to save what was done.
const TEST_TIME_MS = 230 * 1000;
// The status run's questions about look-alike cards: none starts after
// JUDGE_START_UNTIL_MS, and no call runs past JUDGE_UNTIL_MS, leaving time to
// keep the verdicts and check every student.
const JUDGE_START_UNTIL_MS = 150 * 1000;
const JUDGE_UNTIL_MS = 210 * 1000;

export const config = { maxDuration: 300 };

// How many students one run covers, and how many classes each gets. Docs are
// read oldest-check-first, so a queue longer than this is worked through over
// consecutive runs rather than the same few docs being read every time.
const STUDENTS_PER_RUN = 40;
const CLASSES_PER_STUDENT = 10;
// Since 2026-10-06 a sync can end with a question to Claude about cards that
// look like ones the student has (api/_lib/sameCardQuestion.js). No student's
// question runs past SYNC_QUESTIONS_UNTIL_MS into the run, and no student's
// sync starts after SYNC_START_UNTIL_MS, so the run ends inside the
// function's five minutes. Students not reached come first tomorrow: the
// list is ordered by when each doc was last checked.
const SYNC_START_UNTIL_MS = 200 * 1000;
const SYNC_QUESTIONS_UNTIL_MS = 265 * 1000;

// A schedule's tests in order (its own first, then the look-alike
// question's): the first one due runs, and the rest wait for another day. One
// that is due but has nothing to test (no cases yet, a migration not run)
// gives way to the next. `testFor(kind)` gives { store, version, run }.
export async function runFirstDue(order, testFor, { now = Date.now } = {}) {
  let waiting = null;
  for (const kind of order) {
    try {
      const test = testFor(kind);
      const runs = await test.store.runs();
      if (runs.missing) { waiting ||= "migration_015 not run"; continue; }
      const latest = (runs.rows || [])[0] || null;
      if (!isDue(latest, test.version, now())) continue;
      const result = await test.run(now() + TEST_TIME_MS);
      console.log(`[${kind}-test] ${result.skipped ? `skipped: ${result.skipped}` : JSON.stringify(result.summary)}`);
      if (result.skipped && kind !== order[order.length - 1]) { waiting ||= `${kind}: ${result.skipped}`; continue; }
      return { test: kind, ...result };
    } catch (e) {
      e.test = kind;
      throw e;
    }
  }
  return { skipped: waiting || "not due" };
}

// The three tests of Claude's work, each with its store, its version and how
// it runs. `deadline` is when to stop starting calls to Claude.
function testFor(kind, admin, apiKey) {
  if (kind === "answers") {
    const store = supabaseAnswerStore(admin);
    return { store, version: ANSWER_PROMPT_VERSION, run: (deadline) => runAnswerTest({ store, apiKey, adminEmail: adminEmail(), deadline }) };
  }
  if (kind === "notes") {
    const store = supabaseNotesStore(admin);
    const anthropic = new Anthropic({ apiKey });
    return {
      store, version: NOTES_PROMPT_VERSION,
      run: (deadline) => runNotesTest({
        store, readDoc: fetchGoogleDoc, blocksOf: sliceIntoBlocks, deadline,
        read: async (block) => cardsFromExtracted(await extractCardsFromBlock(anthropic, block)),
      }),
    };
  }
  const store = supabaseRepeatsStore(admin);
  return { store, version: REPEATS_PROMPT_VERSION, run: (deadline) => runRepeatsTest({ store, apiKey, deadline }) };
}

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, CRON_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  if (!CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET is not set; refusing to run" });
  }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== CRON_SECRET) {
    return res.status(401).json({ error: "Not authorised" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const schedule = req.headers["x-vercel-cron-schedule"];
  if (schedule === ANSWERS_SCHEDULE || schedule === NOTES_SCHEDULE) {
    const order = schedule === ANSWERS_SCHEDULE ? ["answers", "repeats"] : ["notes", "repeats"];
    try {
      const out = await runFirstDue(order, (kind) => testFor(kind, admin, ANTHROPIC_API_KEY));
      return res.status(200).json({ ok: true, ...out, run: out.run?.id || null });
    } catch (e) {
      console.error(`[${e.test || "test"}-test] failed:`, e);
      return res.status(500).json({ error: e.message, test: e.test || null });
    }
  }

  if (schedule === STATUS_SCHEDULE) {
    try {
      const started = Date.now();
      const reports = await checkEveryone(admin, {
        judge: { apiKey: ANTHROPIC_API_KEY, startBy: started + JUDGE_START_UNTIL_MS, deadline: started + JUDGE_UNTIL_MS },
      });
      const saved = await saveReports(admin, reports);
      const failing = reports.filter((r) => !r.ok).length;
      const judged = reports.map((r) => r.report?.judging).filter(Boolean);
      const answered = judged.reduce((n, j) => n + (j.answered || 0), 0);
      const left = judged.reduce((n, j) => n + (j.left || 0), 0);
      console.log(`[status-daily] ${reports.length} students checked, ${failing} with a failing check; ${answered} look-alike pairs judged by Claude, ${left} left for tomorrow${saved.missing ? "; not kept: migration_015 not run" : ""}`);
      if (saved.error) console.error("[status-daily] couldn't keep the reports:", saved.error);
      return res.status(200).json({ ok: true, checked: reports.length, failing, kept: !!saved.ok, judged: answered, left });
    } catch (e) {
      console.error("[status-daily] failed:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  const { data: links, error } = await admin
    .from("cahier_links")
    .select("user_id")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(STUDENTS_PER_RUN);
  if (error) {
    console.error("[cahier-daily] couldn't list linked cahiers:", error);
    return res.status(500).json({ error: error.message });
  }

  const results = [];
  const started = Date.now();
  for (const { user_id: userId } of links || []) {
    if (Date.now() - started > SYNC_START_UNTIL_MS) {
      console.log(`[cahier-daily] out of time; ${(links?.length || 0) - results.length} cahiers left for the next run`);
      break;
    }
    try {
      // One student's doc being unreadable — sharing turned off, doc deleted —
      // must not stop the rest. The reason is stored on their own row for the
      // app to show them.
      const r = await syncUser({
        admin, apiKey: ANTHROPIC_API_KEY, userId,
        limit: CLASSES_PER_STUDENT, force: true, deadline: started + SYNC_QUESTIONS_UNTIL_MS,
      });
      results.push({ userId, ok: r.ok, classes: r.newClasses?.length || 0, cards: r.cardsAdded || 0, remaining: r.remaining ?? null, error: r.error || null });
    } catch (e) {
      console.error(`[cahier-daily] ${userId} failed:`, e);
      results.push({ userId, ok: false, error: e.message });
    }
  }

  const classes = results.reduce((n, r) => n + (r.classes || 0), 0);
  const cards = results.reduce((n, r) => n + (r.cards || 0), 0);
  console.log(`[cahier-daily] ${results.length} cahiers read, ${classes} new classes, ${cards} cards, ${results.filter((r) => !r.ok).length} failed`);
  return res.status(200).json({ ok: true, checked: results.length, classes, cards, results });
}
