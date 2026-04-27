import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase";
import { CAT_DB_TO_UI } from "./lib/cardCategories";

// Loads the user's flashcard deck from user_cards.
//
// Returned card shape: { f, b, cat, dates, freq, id, row_id, flagged, batch_id }
//   id        — lowercase trimmed front. card_progress is keyed by this so
//               progress survives reseeds as long as the front text is stable.
//   row_id    — user_cards.id (bigint), used for edits / flagging / deletes.

export function useUserDeck(user) {
  const [cards, setCards] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setCards([]);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    (async () => {
      // Supabase caps responses at 1000 rows per request (server-side,
      // regardless of .limit()). Paginate with .range() to fetch all cards.
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("user_cards")
          .select("id, front, back, category, dates, flagged_for_review, batch_id")
          .eq("user_id", user.id)
          .range(from, from + PAGE - 1);

        if (cancelled) return;
        if (error) {
          console.error("Failed to load user deck:", error);
          setCards([]);
          setLoaded(true);
          return;
        }
        allRows = allRows.concat(data || []);
        // If we got fewer than PAGE rows, we've fetched everything
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }

      if (cancelled) return;
      const shaped = allRows.map((row) => ({
          f: row.front,
          b: row.back,
          cat: CAT_DB_TO_UI[row.category] || "vocab",
          dates: Array.isArray(row.dates) ? row.dates : [],
          freq: Array.isArray(row.dates) ? row.dates.length : 0,
          id: row.front.toLowerCase().trim(),
          row_id: row.id,
          flagged: row.flagged_for_review === true,
          // Null for legacy cards that predate the upload-batches migration.
          batch_id: row.batch_id || null,
        }));
        // Sort by frequency desc to match legacy buildDeck ordering
        shaped.sort((a, b) => b.freq - a.freq);
        setCards(shaped);
      setLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, reloadCounter]);

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  return { cards, loaded, reload };
}
