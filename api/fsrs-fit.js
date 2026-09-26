// POST /api/fsrs-fit  { timeZone }
//
// Fits FSRS to one student's own answers, and keeps every card's memory
// estimate in step with the settings in use. The app calls it once a day, in
// the background; this decides whether there is anything to do.
//
//   1. Fitting. Once the student has given about 1,000 answers, their own
//      settings are fitted from them (the official FSRS optimizer). Then again
//      each month, once there are 500 more. A fit is only used if it predicts
//      the student's most recent answers — ones it was not fitted on — better
//      than the settings in use; otherwise nothing changes. On the FSRS team's
//      open data (2026-09-26) a personal fit beat the starting settings for 78%
//      of students at 1,000 answers, and was a coin flip at 250.
//   2. Estimates. Whenever the settings in use change — a fit is adopted, or
//      the app's starting settings change — every card's memory estimate
//      (stability and difficulty) is worked out again from its own answers
//      under the new settings. Due dates don't move: each card is scheduled
//      under the new settings at its next answer. Nothing else is written, and
//      a card answered while this runs is left alone.
//
// Settings live in fsrs_settings (migration_012); without that migration this
// answers { status: "not-set-up" } and the app keeps the starting settings.

import { createClient } from "@supabase/supabase-js";
import { requireUser } from "./_lib/auth.js";
import { buildHistories, fittingSequences, replayHistory } from "../src/lib/fsrsHistory.js";
import { makeScheduler } from "../src/lib/spacedRepetition.js";
import { STARTING_WEIGHTS, STARTING_VERSION, FIRST_FIT, fitDue, usableWeights } from "../src/lib/fsrsSettings.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const user = await requireUser(req, res);
  if (!user) return;
  const timeZone = validTimeZone(req.body?.timeZone);
  if (!timeZone) return res.status(400).json({ error: "timeZone must be an IANA time zone name" });
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    return res.status(200).json(await fitUser({ admin, userId: user.id, timeZone }));
  } catch (e) {
    console.error("[fsrs-fit]", user.id, e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

function validTimeZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// Postgres "relation does not exist", or PostgREST's "not in the schema cache".
const missing = (error) => error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202");

async function readAll(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

// Exported for the tests, which pass a stand-in database and optimizer.
export async function fitUser({ admin, userId, timeZone, now = Date.now(), optimizer = null }) {
  const { data: row, error: rowError } = await admin
    .from("fsrs_settings").select("*").eq("user_id", userId).maybeSingle();
  if (rowError) {
    if (missing(rowError)) return { ok: true, status: "not-set-up" };
    throw new Error(rowError.message);
  }

  const reviews = await readAll(() => admin
    .from("card_reviews")
    .select("card_id, direction, answered_at, correct, counted, state_before, stability_before, difficulty_before, last_review_before")
    .eq("user_id", userId)
    .eq("counted", true)
    .order("answered_at", { ascending: true })
    .order("id", { ascending: true }));
  const histories = buildHistories(reviews);
  const sequences = fittingSequences(histories, timeZone);
  const answers = sequences.reduce((n, s) => n + s.length, 0);

  let weights = usableWeights(row?.weights) || STARTING_WEIGHTS;
  let settings = usableWeights(row?.weights) ? `fit:${row.fitted_at}` : `start:${STARTING_VERSION}`;
  const patch = {};
  let fit = null;

  if (fitDue({ answers, checkedAt: row?.fit_checked_at, checkedAnswers: row?.fit_checked_answers, now })) {
    const opt = optimizer || (await import("@open-spaced-repetition/binding"));
    fit = await tryFit(opt, sequences, weights);
    const at = new Date(now).toISOString();
    Object.assign(patch, { fit_checked_at: at, fit_checked_answers: answers, fit_result: fit.result });
    if (fit.weights) {
      weights = fit.weights;
      settings = `fit:${at}`;
      Object.assign(patch, { weights, fitted_at: at, fitted_answers: answers });
    }
  }

  let recomputed = 0;
  if (row?.computed_with !== settings) {
    recomputed = await recompute({ admin, userId, histories, weights, timeZone });
    patch.computed_with = settings;
  }

  if (Object.keys(patch).length) {
    const { error } = await admin
      .from("fsrs_settings")
      .upsert({ user_id: userId, ...patch, updated_at: new Date(now).toISOString() }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
  }

  return {
    ok: true,
    status: fit?.weights ? "fitted" : fit ? "kept" : answers < FIRST_FIT ? "waiting" : "up-to-date",
    answers,
    needed: FIRST_FIT,
    settings,
    recomputed,
    fit: fit?.result || null,
  };
}

// Fit on the older 80% of the student's answers, test on the newest 20%. Only
// if the fit predicts those better than the settings in use is it kept — and
// then fitted again on everything, for the settings actually used.
async function tryFit(opt, sequences, current) {
  const items = [];
  for (const s of sequences) {
    for (let k = 1; k < s.length; k++) items.push({ reviews: s.slice(0, k + 1), at: s[k].at });
  }
  items.sort((a, b) => a.at - b.at);
  const cut = Math.floor(items.length * 0.8);
  const toItems = (list) => list.map((it) =>
    new opt.FSRSBindingItem(it.reviews.map((r) => new opt.FSRSBindingReview(r.rating, r.deltaT))));
  const train = toItems(items.slice(0, cut));
  const test = toItems(items.slice(cut));
  const result = { trainAnswers: train.length, testAnswers: test.length, lossFitted: null, lossInUse: null, adopted: false };
  if (train.length < 200 || test.length < 50) return { weights: null, result };

  const candidate = usableWeights(await opt.computeParameters(train, { enableShortTerm: false }));
  if (!candidate) return { weights: null, result };
  result.lossFitted = new opt.FSRSBinding(candidate).evaluate(test).logLoss;
  result.lossInUse = new opt.FSRSBinding([...current]).evaluate(test).logLoss;
  if (!(result.lossFitted < result.lossInUse)) return { weights: null, result };

  const weights = usableWeights(await opt.computeParameters(toItems(items), { enableShortTerm: false }));
  result.adopted = !!weights;
  return { weights, result };
}

// Every card's estimate, worked out again from its answers under `weights`,
// and written where the card hasn't been answered since its history was read.
async function recompute({ admin, userId, histories, weights, timeZone }) {
  const sched = makeScheduler({ weights });
  const cards = await readAll(() => admin
    .from("user_cards")
    .select("id, fsrs_state, last_review, en_fsrs_state, en_last_review")
    .eq("user_id", userId)
    .order("id", { ascending: true }));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows = [];
  for (const h of histories) {
    const card = byId.get(h.cardId);
    if (!card) continue;
    const state = h.dir === "en" ? card.en_fsrs_state : card.fsrs_state;
    const last = h.dir === "en" ? card.en_last_review : card.last_review;
    // Never answered, or reset since: nothing to work out.
    if (!state || !last) continue;
    const estimate = replayHistory(h, { sched, timeZone });
    // The card's last answer must be the history's last answer; if not, it has
    // been answered since, or its history isn't all on record.
    if (Date.parse(last) !== estimate.lastAnswerAt) continue;
    if (!(estimate.stability > 0) || !(estimate.difficulty >= 1 && estimate.difficulty <= 10)) continue;
    rows.push({ id: h.cardId, direction: h.dir, stability: estimate.stability, difficulty: estimate.difficulty, last_review: last });
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await admin.rpc("apply_memory_estimates", { p_user_id: userId, p_rows: rows.slice(i, i + 500) });
    if (error) throw new Error(error.message);
    written += Number(data) || 0;
  }
  return written;
}
