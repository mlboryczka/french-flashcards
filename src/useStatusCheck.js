import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";
import { runStatusChecks } from "./lib/statusChecks";
import { missingTable } from "./lib/dealLog";
import { browserTimeZone } from "./lib/studyDay";
import { lessonRank } from "./data/lessons";

// The status check (lib/statusChecks.js) on the signed-in student's own
// record: were their cards shown the way FSRS and the app's rules say?
//
// The admin's instrument, not something a student needs to read, so it runs
// only when `enabled`. It reads and never writes: a few seconds after the deck
// has loaded, when the Status dialog opens, and on coming back to the tab
// once the last result is an hour old. `amiss` is what the profile menu's
// alert shows: a check failed, or the check itself couldn't run.

const PAGE = 1000;
const STALE_MS = 60 * 60 * 1000;

async function readAll(table, userId) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select("*").eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { data: out };
  }
}

export function useStatusCheck(user, { enabled, ready }) {
  const userId = user?.id ?? null;
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const ranAtRef = useRef(0);

  const run = useCallback(async () => {
    if (!userId || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const [answers, cards, deals, settings] = await Promise.all([
        readAll("card_reviews", userId),
        readAll("user_cards", userId),
        readAll("dealt_sets", userId),
        supabase.from("fsrs_settings").select("*").eq("user_id", userId).maybeSingle(),
      ]);
      const failed = answers.error || cards.error || (deals.error && !missingTable(deals.error) ? deals.error : null);
      if (failed) {
        setError(failed.message || String(failed));
        return;
      }
      setReport(runStatusChecks({
        answers: answers.data,
        cards: cards.data,
        deals: deals.error ? [] : deals.data,
        dealsTable: !deals.error,
        settings: settings.error ? null : settings.data,
        timeZone: browserTimeZone(),
        lessonRank,
      }));
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      ranAtRef.current = Date.now();
      runningRef.current = false;
      setRunning(false);
    }
  }, [userId]);

  useEffect(() => {
    setReport(null);
    setError(null);
    if (!enabled || !ready || !userId) return;
    const t = setTimeout(run, 3000);
    const onReturn = () => {
      if (document.visibilityState === "visible" && Date.now() - ranAtRef.current > STALE_MS) run();
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [enabled, ready, userId, run]);

  return { report, error, running, run, amiss: !!error || (!!report && !report.ok) };
}
