import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";
import { CAT_DB_TO_UI } from "./lib/cardCategories";

// Loads the user's flashcard deck from user_cards.
//
// Returned card shape:
//   { f, b, cat, dates, freq, id, row_id, flagged, batch_id,
//     next_due_at, lapses, stability, difficulty, fsrs_state, reps, last_review }
//   id        — lowercase trimmed front. card_progress is keyed by this so
//               progress survives reseeds as long as the front text is stable.
//   row_id    — user_cards.id (bigint), used for edits / flagging / deletes.
//   next_due_at, lapses, stability, difficulty, fsrs_state, reps,
//   last_review — FSRS scheduling state (migration_006).

// Last-known deck, kept so a fresh page can paint one immediately.
//
// The app shows a bare "Loading…" until the deck arrives, and that is what
// flashes when you come back to a backgrounded tab: Chrome discards tabs under
// memory pressure and reloads them on return, so the app boots from scratch and
// waits on a round trip before it has anything to draw. Nothing about that is
// wrong, it is just visible.
//
// So the deck is written to localStorage on every successful load and read back
// synchronously on the next mount. The network fetch still runs and still wins;
// the cache only decides what is on screen for the few hundred milliseconds
// before it lands, and the alternative to a slightly stale deck is no deck.
//
// Everything here is wrapped: storage throws in private windows and when the
// quota is full, and a deck of several thousand cards is not small.
const CACHE_PREFIX = "deck-cache:";
const CACHE_VERSION = 1;

function readCache(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.v !== CACHE_VERSION || !Array.isArray(parsed.cards)) return null;
    return parsed.cards;
  } catch {
    return null;
  }
}

// localStorage gives an origin about 5MB. A deck in the thousands serialises
// past that, so the write throws, the key is cleared, and every load repeats
// the attempt for nothing. Above the cap the cache simply opts out — `loaded`
// no longer depends on it either way.
const MAX_CACHE_BYTES = 2_500_000;

function writeCache(userId, cards) {
  if (!userId) return;
  try {
    const payload = JSON.stringify({ v: CACHE_VERSION, cards });
    if (payload.length > MAX_CACHE_BYTES) {
      try { localStorage.removeItem(CACHE_PREFIX + userId); } catch {}
      return;
    }
    localStorage.setItem(CACHE_PREFIX + userId, payload);
  } catch {
    // Over quota or storage unavailable. The cache is an optimisation; losing
    // it costs a loading state, not correctness.
    try { localStorage.removeItem(CACHE_PREFIX + userId); } catch {}
  }
}

export function useUserDeck(user) {
  // Depend on the ID, not the object. supabase-js hands back a NEW user object
  // every time it refreshes the token — roughly hourly — and keying the effect
  // on the object meant every refresh re-downloaded the whole deck. The id is
  // what actually identifies whose deck this is.
  const userId = user?.id ?? null;
  // Seeded from the cache so the very first render already has a deck. Lazy
  // initialisers, so the read happens once rather than on every render.
  const [cards, setCards] = useState(() => readCache(user?.id) || []);
  const [loaded, setLoaded] = useState(() => readCache(user?.id) !== null);
  const [reloadCounter, setReloadCounter] = useState(0);
  // The user whose deck is currently on screen. A refetch for that same user
  // (reload() after an edit, a delete, an upload, a card added from the tutor
  // chat) is a *background* refetch: it must not flip `loaded` back off.
  // FlashcardApp renders a bare "Loading…" whenever !loaded, which unmounts
  // the entire tree — including whichever panel just triggered the reload.
  const loadedForUser = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setCards([]);
      setLoaded(true);
      loadedForUser.current = null;
      return;
    }
    // A cached deck counts as loaded: the refetch below is then a background
    // refresh, exactly like a reload after an edit.
    const cached = readCache(userId);
    if (cached) {
      setCards(cached);
      setLoaded(true);
      loadedForUser.current = userId;
    } else if (loadedForUser.current !== userId) {
      setLoaded(false);
    }
    (async () => {
      // Supabase caps responses at 1000 rows per request (server-side,
      // regardless of .limit()). Paginate with .range() to fetch all cards.
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("user_cards")
          .select(
            "id, front, back, category, dates, flagged_for_review, batch_id, source, " +
              "next_due_at, lapses, stability, difficulty, fsrs_state, reps, " +
              "last_review, last_answer_correct"
          )
          .eq("user_id", userId)
          // ORDER BY is not decoration here. A deck of several thousand cards
          // takes nine of these requests, and SQL makes no promise about row
          // order without one — so nothing guaranteed page 2 began where page 1
          // stopped. Grading a card or adding one from the tutor writes to this
          // table, and a write landing mid-paging could shift rows across the
          // boundary: a card fetched twice, or silently not fetched at all. A
          // card that isn't fetched isn't scheduled, and nothing says so.
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);

        if (cancelled) return;
        if (error) {
          console.error("Failed to load user deck:", error);
          setCards([]);
          setLoaded(true);
          loadedForUser.current = userId;
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
          // Where the card came from: "cahier-upload", "tutor-chat", or
          // "lesson:<id>" for a card added from the Lessons catalogue.
          source: row.source || null,
          // FSRS scheduling state (migration_006). Nulls are legitimate:
          // a never-reviewed card has no stability and no last review.
          next_due_at: row.next_due_at || null,
          lapses: row.lapses ?? 0,
          stability: row.stability ?? null,
          difficulty: row.difficulty ?? null,
          fsrs_state: row.fsrs_state ?? 0,
          reps: row.reps ?? 0,
          last_review: row.last_review || null,
          // null = unknown (pre-FSRS row); false = missed on the last attempt.
          last_answer_correct: row.last_answer_correct ?? null,
        }));
        // Sort by frequency desc to match legacy buildDeck ordering
        shaped.sort((a, b) => b.freq - a.freq);
        setCards(shaped);
      setLoaded(true);
      loadedForUser.current = userId;
      writeCache(userId, shaped);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, reloadCounter]);

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  return { cards, loaded, reload };
}
