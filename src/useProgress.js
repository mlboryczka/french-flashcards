import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase";

// Manages per-user card progress with optimistic UI + Supabase persistence.
// Shape of progress state: { [cardId]: { score, seen, got } }
export function useProgress(user) {
  const [progress, setProgress] = useState({});
  const [loaded, setLoaded] = useState(false);

  // Initial load: fetch all progress rows for this user
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setProgress({});
      setLoaded(true);
      return;
    }
    setLoaded(false);
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
      setProgress(obj);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Update a single card's progress (optimistic local update + async upsert)
  const updateCard = useCallback(
    async (cardId, update) => {
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
    if (!user) return;
    const { error } = await supabase
      .from("card_progress")
      .delete()
      .eq("user_id", user.id);
    if (error) console.error("Failed to reset progress:", error);
  }, [user]);

  return { progress, loaded, updateCard, resetAll };
}
