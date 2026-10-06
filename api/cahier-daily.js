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
// A second schedule in vercel.json, STATUS_SCHEDULE, runs the status check on
// every student instead (api/_lib/statusDaily.js) and keeps the results for
// the Status window. Vercel says which schedule called in the
// x-vercel-cron-schedule header. It lives here because the Hobby plan deploys
// at most 12 routes and there are 12.
//
// AUTHENTICATION. Vercel sends `Authorization: Bearer $CRON_SECRET` with every
// cron request when that variable is set. Without CRON_SECRET this route
// refuses to run at all rather than leaving a URL that any caller could use to
// spend the deploy owner's Anthropic credit.

import { createClient } from "@supabase/supabase-js";
import { syncUser } from "./cahier-sync.js";
import { STATUS_SCHEDULE, checkEveryone, saveReports } from "./_lib/statusDaily.js";

export const config = { maxDuration: 300 };

// How many students one run covers, and how many classes each gets. Docs are
// read oldest-check-first, so a queue longer than this is worked through over
// consecutive runs rather than the same few docs being read every time.
const STUDENTS_PER_RUN = 40;
const CLASSES_PER_STUDENT = 10;

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

  if (req.headers["x-vercel-cron-schedule"] === STATUS_SCHEDULE) {
    try {
      const reports = await checkEveryone(admin);
      const saved = await saveReports(admin, reports);
      const failing = reports.filter((r) => !r.ok).length;
      console.log(`[status-daily] ${reports.length} students checked, ${failing} with a failing check${saved.missing ? "; not kept: migration_015 not run" : ""}`);
      if (saved.error) console.error("[status-daily] couldn't keep the reports:", saved.error);
      return res.status(200).json({ ok: true, checked: reports.length, failing, kept: !!saved.ok });
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
  for (const { user_id: userId } of links || []) {
    try {
      // One student's doc being unreadable — sharing turned off, doc deleted —
      // must not stop the rest. The reason is stored on their own row for the
      // app to show them.
      const r = await syncUser({
        admin, apiKey: ANTHROPIC_API_KEY, userId,
        limit: CLASSES_PER_STUDENT, force: true,
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
