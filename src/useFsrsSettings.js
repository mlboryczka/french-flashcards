import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";
import { applySettings, State } from "./lib/spacedRepetition";
import {
  TARGET_CHOICES, DEFAULT_TARGET, targetOf, recordStudyDay, nextAutoTarget,
} from "./lib/fsrsSettings";
import { directionsOf, isTwoWay, sideOf } from "./lib/directions";
import { localISODate, startOfLocalDay } from "./lib/studyDay";

// The student's own FSRS settings (migration_012), applied to the scheduler.
//
// Once a study day, after the deck has come fresh from the server:
//   • the day is recorded — did it start with due cards left over from
//     earlier days? — and the automatic target moves if a week says so
//     (lib/fsrsSettings.js)
//   • the server is asked to fit the student's settings or bring their cards'
//     estimates up to date (api/fsrs-fit.js); if it changed anything, the
//     settings and the deck are read again.
//
// Without migration_012 the table isn't there: the starting settings are used
// and nothing is written.

const DAILY_KEY = "fsrs-daily:";

const missing = (error) => error && (error.code === "42P01" || error.code === "PGRST205");

// The choice a row stands for: "auto", or the fixed target's name.
export function choiceOf(row) {
  if ((row?.target_mode ?? "auto") !== "fixed") return "auto";
  const hit = Object.entries(TARGET_CHOICES).find(([k, v]) => k !== "auto" && Math.abs(v - row.target) < 0.001);
  return hit ? hit[0] : "standard";
}

export function useFsrsSettings(user, { cards, freshSeq, dir, onEstimatesChanged }) {
  const userId = user?.id ?? null;
  const [row, setRow] = useState(null);
  const [setUp, setSetUp] = useState(false);
  const [readSeq, setReadSeq] = useState(0);
  const [lastFit, setLastFit] = useState(null);
  const dailyRan = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setRow(null);
    setSetUp(false);
    if (!userId) return;
    (async () => {
      const { data, error } = await supabase
        .from("fsrs_settings").select("*").eq("user_id", userId).maybeSingle();
      if (cancelled) return;
      if (error) {
        if (!missing(error)) console.error("Load FSRS settings failed:", error);
        return;
      }
      setRow(data || null);
      setSetUp(true);
      setReadSeq((n) => n + 1);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const reread = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from("fsrs_settings").select("*").eq("user_id", userId).maybeSingle();
    if (!error) setRow(data || null);
  }, [userId]);

  // Every answer from here on is scheduled with these.
  useEffect(() => {
    applySettings({ weights: row?.weights, retention: targetOf(row) });
  }, [row]);

  const save = useCallback(async (fields) => {
    if (!userId) return null;
    const { data, error } = await supabase
      .from("fsrs_settings")
      .upsert({ user_id: userId, ...fields, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      .select()
      .maybeSingle();
    if (error) { console.error("Save FSRS settings failed:", error); return null; }
    // The row as saved; or, if the database didn't send it back, what was sent.
    setRow((prev) => data || { ...(prev || {}), user_id: userId, ...fields });
    return data;
  }, [userId]);

  // Once a study day, once the deck has come fresh from the server — a copy
  // saved in the browser can be a day old and show yesterday's work as undone.
  useEffect(() => {
    if (!userId || !setUp || !readSeq || !freshSeq) return;
    const today = localISODate();
    let stored = null;
    try { stored = localStorage.getItem(DAILY_KEY + userId); } catch {}
    if (dailyRan.current === today || stored === today) return;
    dailyRan.current = today;
    try { localStorage.setItem(DAILY_KEY + userId, today); } catch {}

    (async () => {
      // Due cards left over from earlier days, the way the student is
      // studying: in EN→FR, a word due only French side up isn't waiting.
      const start = startOfLocalDay(new Date());
      let behind = false;
      for (const c of cards) {
        for (const d of directionsOf(c)) {
          if (isTwoWay(c) && dir !== "mix" && d !== dir) continue;
          const s = sideOf(c, d);
          if ((s.fsrs_state ?? State.New) !== State.New && s.next_due_at && new Date(s.next_due_at).getTime() < start) {
            behind = true;
            break;
          }
        }
        if (behind) break;
      }
      const days = recordStudyDay(row?.days, today, behind);
      const fields = { days };
      if ((row?.target_mode ?? "auto") === "auto") {
        const target = targetOf(row);
        const next = nextAutoTarget({ target, days, changedAt: row?.target_changed_at ?? null, today });
        if (next !== target) Object.assign(fields, { target: next, target_changed_at: new Date().toISOString() });
      }
      await save(fields);

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const res = await fetch("/api/fsrs-fit", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        });
        const result = await res.json().catch(() => null);
        if (!res.ok || !result?.ok) return;
        setLastFit(result);
        if (result.recomputed > 0 || result.status === "fitted") {
          await reread();
          onEstimatesChanged?.();
        }
      } catch (e) {
        // Background work: the student is studying with the settings they had.
        console.warn("FSRS fit check failed:", e?.message || e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, setUp, readSeq, freshSeq]);

  // The student's own choice. Automatic starts again from 90%.
  const setChoice = useCallback((choice) => {
    if (!(choice in TARGET_CHOICES)) return null;
    if (choice === "auto") {
      return save({ target_mode: "auto", target: DEFAULT_TARGET, target_changed_at: new Date().toISOString() });
    }
    return save({ target_mode: "fixed", target: TARGET_CHOICES[choice], target_changed_at: new Date().toISOString() });
  }, [save]);

  return {
    setUp,
    choice: choiceOf(row),
    target: targetOf(row),
    fittedAt: row?.weights ? row.fitted_at : null,
    answers: lastFit?.answers ?? row?.fit_checked_answers ?? null,
    setChoice,
  };
}
