import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";

// The linked cahier: the Google Doc the student and their teacher actually
// write in, read again whenever they open the app so a class added after the
// lesson is already cards by the time they study.
//
// The work is the server's (api/cahier-sync.js). This is the client side of
// it: what is linked, when it was last read, what arrived, and the loop that
// keeps asking for more while classes are left — a run parses a limited number
// of classes so it can't time out, and reports how many remain, so linking a
// year-old cahier is several runs rather than one that dies.
//
// Reading the doc costs nothing and takes a second; only a class that has
// never been read costs anything at all. So checking on open is cheap, and the
// server refuses to check twice within half a minute anyway.

// Don't check more than once an hour per browser. The daily job catches
// anything this misses, and a student reloading the page ten times should not
// mean ten checks.
const CHECK_EVERY_MS = 60 * 60 * 1000;
const LAST_CHECK_KEY = "cahier-checked:";

export function useCahierSync(user) {
  const userId = user?.id ?? null;
  const [link, setLink] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  // What the last run brought in, for the app to tell the student about:
  // { dates: ["2026-09-24"], cards: 31 }
  const [arrived, setArrived] = useState(null);
  const running = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!userId) { setLink(null); setLoaded(true); return; }
    (async () => {
      const { data, error: err } = await supabase
        .from("cahier_links").select("*").eq("user_id", userId).maybeSingle();
      if (cancelled) return;
      if (err) console.error("Couldn't read the cahier link:", err);
      setLink(data || null);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // One run of the sync, repeated while classes are left to read.
  //
  // `onProgress` is called with each run's summary so a caller can say
  // "class 12 of 40" while a long backlog is worked through.
  const sync = useCallback(async ({ url, force = false, onProgress } = {}) => {
    if (running.current) return null;
    running.current = true;
    setChecking(true);
    setError("");
    let added = 0;
    const dates = [];
    let last = null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      for (let run = 0; run < 40; run++) {
        const res = await fetch("/api/cahier-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ ...(run === 0 && url ? { url } : null), force: force || run > 0 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `Couldn't read your cahier (HTTP ${res.status})`);
        last = data;
        added += data.cardsAdded || 0;
        dates.push(...(data.newClasses || []));
        onProgress?.({ ...data, addedSoFar: added });
        if (!data.remaining) break;
      }
      if (userId) {
        try { localStorage.setItem(LAST_CHECK_KEY + userId, String(Date.now())); } catch { /* storage blocked */ }
      }
      // Re-read the row rather than assembling it here, so what the app shows
      // is what was actually stored.
      if (userId) {
        const { data } = await supabase.from("cahier_links").select("*").eq("user_id", userId).maybeSingle();
        setLink(data || null);
      }
      const summary = { cards: added, dates: [...new Set(dates)].sort(), linked: last?.linked !== false };
      if (added > 0) setArrived(summary);
      return summary;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      running.current = false;
      setChecking(false);
    }
  }, [userId]);

  // The check on open. Once the link is known, and at most hourly.
  useEffect(() => {
    if (!loaded || !link || !userId) return;
    let lastLocal = 0;
    try { lastLocal = Number(localStorage.getItem(LAST_CHECK_KEY + userId)) || 0; } catch { /* storage blocked */ }
    if (Date.now() - lastLocal < CHECK_EVERY_MS) return;
    sync();
  }, [loaded, link, userId, sync]);

  const unlink = useCallback(async () => {
    if (!userId) return;
    const { error: err } = await supabase.from("cahier_links").delete().eq("user_id", userId);
    if (err) { setError(err.message); return false; }
    setLink(null);
    setArrived(null);
    return true;
  }, [userId]);

  return {
    link, loaded, checking, error, arrived,
    dismissArrived: () => setArrived(null),
    sync, unlink,
  };
}
