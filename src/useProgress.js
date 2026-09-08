import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";

// Cached alongside the deck, and for the same reason.
//
// FlashcardApp will not render until BOTH the deck and this have arrived, so
// caching only the deck moved the "Loading…" flash rather than removing it —
// the gate simply waited on card_progress instead. Progress is a small object
// keyed by card id, so it costs almost nothing to keep.
//
// See the note in useUserDeck for why this is a cache and not a source of
// truth: the fetch below still runs and still wins.
const CACHE_PREFIX = "progress-cache:";
const CACHE_VERSION = 1;

function readCache(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.v !== CACHE_VERSION || typeof parsed.progress !== "object") return null;
    return parsed.progress;
  } catch {
    return null;
  }
}

function writeCache(userId, progress) {
  if (!userId) return;
  try {
    localStorage.setItem(
      CACHE_PREFIX + userId,
      JSON.stringify({ v: CACHE_VERSION, progress })
    );
  } catch {
    try { localStorage.removeItem(CACHE_PREFIX + userId); } catch {}
  }
}

// Manages per-user card progress with optimistic UI + Supabase persistence.
// Shape of progress state: { [cardId]: { score, seen, got } }
export function clearProgressCache(userId) {
  try {
    if (userId) localStorage.removeItem(CACHE_PREFIX + userId);
    else {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
    }
  } catch {
    // Storage unavailable. Nothing to clear that we can reach.
  }
}

export function useProgress(user) {
  const [progress, setProgress] = useState(() => readCache(user?.id) || {});
  const [loaded, setLoaded] = useState(() => readCache(user?.id) !== null);
  // Whose progress is already on screen.
  //
  // This effect re-runs whenever the `user` OBJECT changes, and supabase hands
  // back a new one every time it refreshes the token — which it does in the
  // middle of whatever you were doing. Dropping `loaded` on each of those made
  // FlashcardApp return its bare "Loading…", and that unmounts the entire
  // tree: the tutor panel with a question in flight, its whole conversation,
  // everything. A refetch for the SAME person is a background refresh and must
  // never take the app off screen. Same guard as useUserDeck's.
  const loadedForUser = useRef(null);
  // Cards answered locally since mount. A cached copy counts as loaded, so the
  // app is answerable while the fetch is still running — and the fetch's result
  // is a snapshot from BEFORE those answers. Overwriting with it made the score
  // visibly go up and then back down.
  const localWrites = useRef(new Map());

  // Initial load: fetch all progress rows for this user
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setProgress({});
      setLoaded(true);
      loadedForUser.current = null;
      return;
    }
    // A cached copy counts as loaded, so the fetch below is a background
    // refresh rather than something the first paint waits on.
    const cached = readCache(user.id);
    if (cached) {
      setProgress(cached);
      setLoaded(true);
      loadedForUser.current = user.id;
    } else if (loadedForUser.current !== user.id) {
      setLoaded(false);
    }
    (async () => {
      // Supabase caps responses at 1000 rows. Paginate to fetch all progress.
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("card_progress")
          .select("card_id, score, seen, got")
          .eq("user_id", user.id)
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error("Failed to load progress:", error);
          setProgress({});
          setLoaded(true);
          return;
        }
        allRows = allRows.concat(data || []);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      if (cancelled) return;
      const obj = {};
      for (const row of allRows) {
        obj[row.card_id] = { score: row.score, seen: row.seen, got: row.got };
      }
      // Server rows first, then anything answered while they were in flight.
      const merged = { ...obj, ...Object.fromEntries(localWrites.current) };
      setProgress(merged);
      setLoaded(true);
      loadedForUser.current = user.id;
      writeCache(user.id, merged);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Update a single card's progress (optimistic local update + async upsert)
  const updateCard = useCallback(
    async (cardId, update) => {
      localWrites.current.set(cardId, update);
      setProgress((prev) => ({ ...prev, [cardId]: update }));
      if (!user) return;
      const { error } = await supabase.from("card_progress").upsert(
        {
          user_id: user.id,
          card_id: cardId,
          score: update.score,
          seen: update.seen,
          got: update.got,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,card_id" }
      );
      if (error) console.error("Failed to save progress:", error);
    },
    [user]
  );

  const resetAll = useCallback(async () => {
    setProgress({});
    // Both of these, or a reload undoes the reset: the cache would repaint the
    // old scores and the in-flight writes would be merged back over them.
    localWrites.current.clear();
    if (user) clearProgressCache(user.id);
    if (!user) return;
    const { error } = await supabase
      .from("card_progress")
      .delete()
      .eq("user_id", user.id);
    if (error) console.error("Failed to reset progress:", error);
  }, [user]);

  return { progress, loaded, updateCard, resetAll };
}
