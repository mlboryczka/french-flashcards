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
export function useProgress(user) {
  // The ID, not the object — see the note in useUserDeck. A token refresh
  // hands back a new object and used to re-run this whole fetch.
  const userId = user?.id ?? null;
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

  // Initial load: fetch all progress rows for this user
  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setProgress({});
      setLoaded(true);
      loadedForUser.current = null;
      return;
    }
    // A cached copy counts as loaded, so the fetch below is a background
    // refresh rather than something the first paint waits on.
    const cached = readCache(userId);
    if (cached) {
      setProgress(cached);
      setLoaded(true);
      loadedForUser.current = userId;
    } else if (loadedForUser.current !== userId) {
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
          .eq("user_id", userId)
          // A stable order across pages — see useUserDeck for why.
          .order("card_id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error("Failed to load progress:", error);
          setProgress({});
          setLoaded(true);
          // Marking WHO is loaded, which this path used to skip while
          // useUserDeck's equivalent set it. After one failed fetch the next
          // background refresh took the setLoaded(false) branch instead, and
          // that unmounts the whole tree — the "Loading…" flash that losing
          // your place looks like, and exactly what this ref exists to stop.
          loadedForUser.current = userId;
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
      setProgress(obj);
      setLoaded(true);
      loadedForUser.current = userId;
      writeCache(userId, obj);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Update a single card's progress (optimistic local update + async upsert)
  const updateCard = useCallback(
    async (cardId, update) => {
      setProgress((prev) => ({ ...prev, [cardId]: update }));
      if (!userId) return;
      const { error } = await supabase.from("card_progress").upsert(
        {
          user_id: userId,
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
    [userId]
  );

  const resetAll = useCallback(async () => {
    setProgress({});
    if (!userId) return;
    const { error } = await supabase
      .from("card_progress")
      .delete()
      .eq("user_id", userId);
    if (error) console.error("Failed to reset progress:", error);
  }, [userId]);

  return { progress, loaded, updateCard, resetAll };
}
