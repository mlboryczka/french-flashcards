import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";
import { CAT_DB_TO_UI } from "./lib/cardCategories";

// Loads the user's flashcard deck from user_cards.
//
// Returned card shape:
//   { f, b, cat, dates, freq, id, row_id, flagged, batch_id,
//     box, next_due_at, lapses }
//   id        — lowercase trimmed front. card_progress is keyed by this so
//               progress survives reseeds as long as the front text is stable.
//   row_id    — user_cards.id (bigint), used for edits / flagging / deletes.
//   box, next_due_at, lapses — spaced-repetition state (migration_005).

export function useUserDeck(user) {
  const [cards, setCards] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  // The user whose deck is currently on screen. A refetch for that same user
  // (reload() after an edit, a delete, an upload, a card added from the tutor
  // chat) is a *background* refetch: it must not flip `loaded` back off.
  // FlashcardApp renders a bare "Loading…" whenever !loaded, which unmounts
  // the entire tree — including whichever panel just triggered the reload.
  const loadedForUser = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setCards([]);
      setLoaded(true);
      loadedForUser.current = null;
      return;
    }
    if (loadedForUser.current !== user.id) setLoaded(false);
    (async () => {
      // Supabase caps responses at 1000 rows per request (server-side,
      // regardless of .limit()). Paginate with .range() to fetch all cards.
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("user_cards")
          .select("id, front, back, category, dates, flagged_for_review, batch_id, box, next_due_at, lapses")
          .eq("user_id", user.id)
          .range(from, from + PAGE - 1);

        if (cancelled) return;
        if (error) {
          console.error("Failed to load user deck:", error);
          setCards([]);
          setLoaded(true);
          loadedForUser.current = user.id;
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
          box: row.box ?? 1,
          next_due_at: row.next_due_at || null,
          lapses: row.lapses ?? 0,
        }));
        // Sort by frequency desc to match legacy buildDeck ordering
        shaped.sort((a, b) => b.freq - a.freq);
        setCards(shaped);
      setLoaded(true);
      loadedForUser.current = user.id;
    })();

    return () => {
      cancelled = true;
    };
  }, [user, reloadCounter]);

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  return { cards, loaded, reload };
}
