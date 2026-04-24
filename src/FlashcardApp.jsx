import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { RAW } from "./data/cards"; // only used for the admin "seed demo deck" action
import { useProgress } from "./useProgress";
import { useUserDeck } from "./useUserDeck";
import { supabase } from "./supabase";
import { CahierUpload } from "./CahierUpload";
import { BetaFeedback } from "./BetaFeedback";
import { T } from "./theme";
import {
  speakFrench,
  stopSpeaking,
  WavRecorder,
  assessPronunciation,
  TTS_AVAILABLE,
  STT_AVAILABLE,
  scoreColor,
} from "./audio";
import {
  logCorrection,
  CORRECTION_CATEGORIES,
  CORRECTION_ACTIONS,
} from "./lib/parseCorrections";

const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL || "").toLowerCase();

// Feature flag: hide the pronunciation assessment UI (mic button + results
// panel) without removing any code. The Azure backend, audio.js parser, and
// PronunciationPanel component all stay in place — they just don't render.
// Flip to `true` to bring it back.
const PRONUNCIATION_ENABLED = false;

// UI code → DB code, used by the admin seed-deck action
const CAT_TO_DB = { vocab: "V", expr: "E", gram: "G", pron: "P" };

// Simplified two-category system: Vocabulary (single words) vs Phrases
// (expressions, grammar, pronunciation). The underlying card data still
// carries the original 4-way category; these constants control the tabs
// and display labels only.
const TAB_LABELS = { all: "All", vocab: "Vocabulary", phrases: "Phrases" };
const TAB_COLORS = { vocab: "#9c4234", phrases: "#1a2b48" };
// Map underlying card.cat → display tab key
const catToTab = (cat) => cat === "vocab" ? "vocab" : "phrases";
// Map underlying card.cat → eyebrow display label
const catToLabel = (cat) => cat === "vocab" ? "Vocabulary" : "Phrase";
// Legacy — kept for stats bar colors and any remaining references
const CAT_LABELS = { all:"All", vocab:"Vocabulary", expr:"Phrases", gram:"Phrases", pron:"Phrases" };
const CAT_COLORS = { vocab:"#9c4234", expr:"#76261b", gram:"#1a2b48", pron:"#031632" };

// ─── STORAGE ─────────────────────────────────────────────────────────────
// (progress is now handled by the useProgress hook via Supabase)

// ─── ANSWER MATCHING (fuzzy, gender-aware) ───────────────────────────────
// Strip accents, lowercase, remove parentheticals and punctuation
function normalize(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[.,!?;:""''«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// English particles are interchangeable / optional, but French articles carry gender
const EN_PARTICLES = new Set(["to", "the", "a", "an"]);
const FR_ARTICLES = new Set(["le", "la", "les", "un", "une", "des", "du", "de", "l'", "d'"]);
// Separate leading article from content
function splitArticle(s) {
  const m = s.match(/^(to |the |a |an |le |la |les |un |une |des |du |de |l'|d')/i);
  if (m) {
    const article = m[0].trim().toLowerCase();
    return { article, rest: s.slice(m[0].length).trim() };
  }
  return { article: "", rest: s };
}
// Check if typed article is compatible with answer article
function articlesCompatible(tArt, aArt) {
  if (!tArt) return true; // user omitted article — lenient
  if (!aArt) return true; // answer has no article
  if (tArt === aArt) return true; // exact match
  // Both English → interchangeable (a/an/the/to)
  if (EN_PARTICLES.has(tArt) && EN_PARTICLES.has(aArt)) return true;
  // Both French → strict (gender matters: un ≠ une, le ≠ la)
  if (FR_ARTICLES.has(tArt) && FR_ARTICLES.has(aArt)) return false;
  return false;
}
// Damerau-Levenshtein edit distance (transpositions count as 1)
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({length: a.length+1}, () => new Array(b.length+1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + cost
      );
      if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}
// Match typed answer against correct answer, handling alternatives and fuzz
function matchAnswer(typed, correct, extraAlts = []) {
  const t = normalize(typed);
  if (!t) return { match: false };

  // Build list of valid answers: the correct one plus any alternates, plus
  // slash-separated synonyms like "mémoriser / retenir" or "un vendeur / une vendeuse"
  const sources = [correct, ...extraAlts];
  const alternatives = [];
  for (const src of sources) {
    // Split on / , ; | to get individual acceptable answers — BUT only if
    // every resulting piece is short enough to be a word-level alternative
    // (gendered forms, short synonyms, glosses). Long phrases with commas
    // like "i wrote correctly except for trahison, which should be betrayal"
    // must not decompose into standalone clauses, or a user typing the rest
    // of the sentence right with one wrong word still matches a clause as a
    // substring. Slashes are always split (they're always synonym markers).
    const slashParts = src.split(/\//).map(s => s.trim()).filter(Boolean);
    for (const sp of slashParts) {
      const subParts = sp.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      const tooLong = subParts.some(
        p => p.split(/\s+/).filter(Boolean).length >= 4 || p.length >= 20
      );
      if (tooLong) {
        alternatives.push(sp);
      } else {
        for (const ap of subParts) alternatives.push(ap);
      }
    }
  }

  for (const alt of alternatives) {
    const a = normalize(alt);
    if (!a) continue;
    // Split article off both sides
    const typedSplit = splitArticle(t);
    const answerSplit = splitArticle(a);
    // Enforce French gender on articles
    if (!articlesCompatible(typedSplit.article, answerSplit.article)) {
      // Record that the article was wrong specifically, so we can feedback
      // "wrong article" instead of just "wrong"
      if (normalize(typedSplit.rest) === normalize(answerSplit.rest)) {
        return { match: false, wrongArticle: true };
      }
      continue;
    }
    const tRest = typedSplit.rest;
    const aRest = answerSplit.rest;
    // Exact match
    if (tRest === aRest) return { match: true };
    // Substring match (user typed part of a longer answer)
    if (aRest.includes(tRest) && tRest.length >= Math.max(4, aRest.length - 3)) {
      return { match: true, close: true };
    }
    if (tRest.includes(aRest) && aRest.length >= 4) {
      return { match: true, close: true };
    }
    // Token-set overlap: only accepts word-order changes, not wrong/missing words.
    // Previous 0.8 threshold let "betrayal" pass for "trahison" in long phrases.
    const tTokens = new Set(tRest.split(/\s+/).filter(x => x.length >= 2));
    const aTokens = new Set(aRest.split(/\s+/).filter(x => x.length >= 2));
    if (tTokens.size >= 2 && aTokens.size >= 2) {
      let shared = 0;
      for (const tok of tTokens) if (aTokens.has(tok)) shared++;
      if (shared === tTokens.size && shared === aTokens.size) {
        return { match: true, close: true };
      }
    }
    // Fuzzy: edit distance within threshold
    const dist = editDistance(tRest, aRest);
    const longest = Math.max(tRest.length, aRest.length);
    const threshold = longest <= 4 ? 0 : longest <= 8 ? 1 : longest <= 14 ? 2 : 3;
    if (dist <= threshold) return { match: true, close: dist > 0 };
  }
  return { match: false };
}

export default function FlashcardApp({ user, onSignOut }) {
  const { progress, loaded: progressLoaded, updateCard, resetAll: resetAllProgress } = useProgress(user);
  const { cards: userCards, loaded: deckLoaded, reload: reloadDeck } = useUserDeck(user);
  const loaded = progressLoaded && deckLoaded;
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const skipFlipAnim = useRef(false); // temporarily disables the card flip transition
  // Tracks the currently-displayed card id so the deck-build effect can
  // preserve the user's position when userCards re-references on a
  // background refetch (e.g. when the browser tab regains focus). Without
  // this, every refetch reshuffles and snaps the user back to card 0.
  const currentCardIdRef = useRef(null);
  const [cat, setCat] = useState("all");
  const [mode, setMode] = useState("study"); // study | stats | feedback
  const [stats, setStats] = useState({ seen:0, got:0, missed:0 });
  const [freqOnly, setFreqOnly] = useState(false);
  const [dir, setDir] = useState("mix"); // fr | en | mix
  const [typeMode, setTypeMode] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [typeResult, setTypeResult] = useState(null); // null | 'correct' | 'wrong'
  const studyInputRef = useRef(null);

  // Upload & onboarding state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadInitialTab, setUploadInitialTab] = useState("paste");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState("");

  // Inline card edit state
  const [editingCard, setEditingCard] = useState(null); // null | card object

  // Viewport-narrow flag — used by the bento grid in the Stats view to
  // collapse to a single column on phones. Inline-style based, so we track
  // window width with a tiny resize listener instead of a CSS media query.
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== "undefined" && window.innerWidth < 768
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Review dates for streak tracking, loaded from Supabase.
  // Set of ISO date strings (e.g. "2026-04-16") on which the user reviewed
  // at least one card. Populated on mount and appended to in answer().
  const [reviewDates, setReviewDates] = useState(() => new Set());

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data, error } = await supabase
        .from("user_review_dates")
        .select("review_date")
        .eq("user_id", user.id)
        .order("review_date", { ascending: false })
        .limit(400);
      if (error) { console.error("Load review dates failed:", error); return; }
      setReviewDates(new Set((data || []).map(r => r.review_date)));
    })();
  }, [user?.id]);

  // Feedback & alternates state
  const [alternates, setAlternates] = useState({}); // { "cardId:direction": ["alt1", "alt2"] }
  const [feedbackState, setFeedbackState] = useState(null); // null | 'submitting' | 'submitted' | 'error'
  const autoAdvanceTimer = useRef(null);
  const isAdmin = !!(user?.email && user.email.toLowerCase() === ADMIN_EMAIL);

  // Load card alternates from Supabase on mount (and when user changes)
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data, error } = await supabase
        .from("card_alternates")
        .select("card_id, direction, alternate_text");
      if (error) { console.error("Failed to load alternates:", error); return; }
      const map = {};
      for (const row of data || []) {
        const key = `${row.card_id}:${row.direction}`;
        if (!map[key]) map[key] = [];
        map[key].push(row.alternate_text);
      }
      setAlternates(map);
    })();
  }, [user]);

  // ── AUDIO STATE ─────────────────────────────────────────────────────
  // Pronunciation states: 'idle' | 'recording' | 'processing' | 'result' | 'error'
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [recState, setRecState] = useState("idle");
  const [pronResult, setPronResult] = useState(null);
  const [pronError, setPronError] = useState("");
  const recorderRef = useRef(null);
  const recordingTimerRef = useRef(null);

  // Cancel any in-flight speech and recording when component unmounts
  useEffect(() => {
    return () => {
      stopSpeaking();
      if (recorderRef.current && recorderRef.current.recording) {
        recorderRef.current.stop().catch(() => {});
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

  // Build flashcard deck — rebuilds when filters or user's card list changes,
  // NOT on every answer and NOT when switching between study/stats/feedback
  // views (that used to reshuffle and snap back to card 0 mid-session).
  useEffect(() => {
    if (!loaded) return;
    let cards = cat === "all"
      ? [...userCards]
      : cat === "phrases"
        ? userCards.filter(c => c.cat !== "vocab")
        : userCards.filter(c => c.cat === cat);
    if (freqOnly) cards = cards.filter(c => c.freq >= 2);
    for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [cards[i],cards[j]]=[cards[j],cards[i]]; }
    // Sort by current progress score (worst first) at build time only
    cards.sort((a, b) => (progress[a.id]?.score ?? 0) - (progress[b.id]?.score ?? 0));
    // Assign a per-card direction (stable within session)
    // Grammar & pronunciation cards are rules with examples, not translations — always show front-as-written
    cards = cards.map(c => {
      const flippable = c.cat === "vocab" || c.cat === "expr";
      const shownDir = !flippable ? "fr" : (dir === "mix" ? (Math.random() < 0.5 ? "fr" : "en") : dir);
      return { ...c, shownDir, flippable };
    });
    setDeck(cards);
    // Preserve the user's position if the current card still exists in the
    // rebuilt deck — otherwise reset to the top. This stops background
    // userCards refetches from snapping the user back to card 0.
    const preservedId = currentCardIdRef.current;
    const preservedIdx = preservedId ? cards.findIndex(c => c.id === preservedId) : -1;
    if (preservedIdx >= 0) {
      setIdx(preservedIdx);
    } else {
      setIdx(0);
      setFlipped(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, freqOnly, loaded, dir, userCards]);

  const card = deck[idx];
  // Keep the ref in sync so deck rebuilds can find the current card.
  useEffect(() => { currentCardIdRef.current = card?.id || null; }, [card]);
  const flip = useCallback(() => setFlipped(f => !f), []);

  // Auto-speak French when a French side becomes visible
  useEffect(() => {
    if (!autoSpeak || !card || mode !== "study") return;
    const isFrenchVisible =
      (card.shownDir === "fr" && !flipped) || (card.shownDir === "en" && flipped);
    if (isFrenchVisible) {
      // Slight delay so the speech starts after the flip animation
      const t = setTimeout(() => speakFrench(card.f), 200);
      return () => clearTimeout(t);
    }
  }, [autoSpeak, card, flipped, mode]);

  // Speak French manually (button handler)
  const speakCard = useCallback(() => {
    if (card) speakFrench(card.f);
  }, [card]);

  // Speak any specific text (used for "tap a word to hear it")
  const speakText = useCallback((text) => {
    speakFrench(text);
  }, []);

  // ── PRONUNCIATION RECORDING ─────────────────────────────────────────
  const startRecording = async () => {
    if (!STT_AVAILABLE || !card) return;
    stopSpeaking(); // don't let TTS bleed into the mic
    setPronResult(null);
    setPronError("");
    try {
      const recorder = new WavRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setRecState("recording");
      // Auto-stop after 10 seconds to prevent runaway recordings
      recordingTimerRef.current = setTimeout(() => {
        if (recorderRef.current && recorderRef.current.recording) {
          stopRecording();
        }
      }, 10000);
    } catch (e) {
      console.error("Recording failed to start:", e);
      setPronError(e.message || "Could not access microphone");
      setRecState("error");
    }
  };

  const stopRecording = async () => {
    if (!recorderRef.current || !recorderRef.current.recording) return;
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setRecState("processing");
    try {
      const blob = await recorderRef.current.stop();
      recorderRef.current = null;
      if (!blob) {
        setPronError("Recording was empty. Try holding the mic button while speaking.");
        setRecState("error");
        return;
      }
      // For production-style grammar cards (front contains "→", e.g.
      // "vivre (présent) → il/elle"), the back holds the answer the user
      // is supposed to say ("il vit"). For everything else (vocab,
      // expressions), the front IS the French word being practiced.
      const refText = card.f.includes("→") ? card.b : card.f;
      const result = await assessPronunciation(blob, refText);
      if (result.error) {
        setPronError(result.error);
        setRecState("error");
      } else {
        setPronResult(result);
        setRecState("result");
      }
    } catch (e) {
      console.error("Assessment failed:", e);
      setPronError(e.message || "Assessment failed");
      setRecState("error");
    }
  };

  const cancelRecording = () => {
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.recording) {
      recorderRef.current.stop().catch(() => {});
      recorderRef.current = null;
    }
    setRecState("idle");
    setPronResult(null);
    setPronError("");
  };

  // Auto-focus study input when entering type mode, advancing cards, or
  // flipping back to the front. When a type result is shown, blur focus so
  // keyboard shortcuts (Space, arrows) reach the window handler instead of
  // being captured by buttons. When peeking at the back of the card mid-type,
  // leave focus alone so the back is actually readable.
  useEffect(() => {
    if (typeMode && mode === "study") {
      if (!typeResult && !flipped) {
        setTimeout(() => studyInputRef.current?.focus(), 50);
      } else if (typeResult) {
        // Result is showing — blur any focused button so Space/arrows
        // go to the window keydown handler, not the button
        if (document.activeElement && document.activeElement.tagName === "BUTTON") {
          document.activeElement.blur();
        }
      }
    }
  }, [typeMode, idx, typeResult, mode, flipped]);

  // Clear any pending auto-advance timer on unmount or card change
  useEffect(() => {
    return () => {
      if (autoAdvanceTimer.current) {
        clearTimeout(autoAdvanceTimer.current);
        autoAdvanceTimer.current = null;
      }
    };
  }, [idx]);


  // Answer handling: update progress
  const answer = async (got, source = "flip") => {
    if (!card) return;
    const prev = progress[card.id] || { score:0, seen:0, got:0 };
    const newProg = {
      score: Math.max(0, Math.min(5, prev.score + (got?1:-1))),
      seen: prev.seen + 1,
      got: prev.got + (got?1:0),
    };
    await updateCard(card.id, newProg);
    // Record today's review date for streak tracking.
    // Write to Supabase (persists across devices) and update local state so
    // the streak UI reflects it immediately without a refetch.
    const todayISO = new Date().toISOString().slice(0,10);
    if (!reviewDates.has(todayISO)) {
      setReviewDates(prev => {
        const next = new Set(prev);
        next.add(todayISO);
        return next;
      });
      // Fire-and-forget. upsert with ignoreDuplicates is idempotent against
      // the (user_id, review_date) primary key, so repeated reviews on the
      // same day are no-ops server-side.
      supabase
        .from("user_review_dates")
        .upsert(
          { user_id: user.id, review_date: todayISO },
          { onConflict: "user_id,review_date", ignoreDuplicates: true }
        )
        .then(({ error }) => { if (error) console.error("Record review date failed:", error); });
    }
    // Session stats only count typed answers (verifiable). Flip-mode
    // "got it" is self-reported and doesn't count toward accuracy.
    if (source === "typed") {
      setStats(s => ({ seen: s.seen+1, got: s.got+(got?1:0), missed: s.missed+(got?0:1) }));
    }
    // Skip the un-flip animation — snap instantly to the next card's front
    skipFlipAnim.current = true;
    setFlipped(false);
    setTypeResult(null);
    setTypedAnswer("");
    setFeedbackState(null); setFeedbackVerdict(null);
    setIdx(i => Math.min(i+1, deck.length-1));
    // Re-enable the flip animation on the next frame
    requestAnimationFrame(() => { skipFlipAnim.current = false; });
  };

  // Submit typed answer
  const submitTyped = () => {
    if (!card || !typedAnswer.trim()) return;
    const correctText = card.shownDir === "fr" ? card.b : card.f;
    const altKey = `${card.id}:${card.shownDir}`;
    const extraAlts = alternates[altKey] || [];
    const result = matchAnswer(typedAnswer, correctText, extraAlts);
    if (result.match) {
      setTypeResult(result.close ? "close" : "correct");
      setFlipped(true);
    } else if (result.wrongArticle) {
      setTypeResult("wrongArticle");
      setFlipped(true);
    } else {
      setTypeResult("wrong");
      setFlipped(true);
    }
  };

  // Give up: reveal the answer without typing. Still counts as wrong for
  // scoring (user couldn't recall it), but displayed neutrally — not framed
  // as "you typed the wrong answer", since no answer was typed.
  const giveUpTyped = () => {
    if (!card) return;
    setTypeResult("revealed");
    setFlipped(true);
  };

  const goBack = () => {
    if (idx === 0) return;
    if (autoAdvanceTimer.current) {
      clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = null;
    }
    skipFlipAnim.current = true;
    setFlipped(false);
    setIdx(i => Math.max(0, i-1));
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null); setFeedbackVerdict(null);
    requestAnimationFrame(() => { skipFlipAnim.current = false; });
  };

  const resetSession = () => {
    setIdx(0);
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0 });
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null); setFeedbackVerdict(null);
  };

  // Keyboard shortcuts (study mode). Uses refs so the handler always
  // calls the latest version of each function without needing them in
  // the useEffect dependency array. Works in both flip mode and type
  // mode — in type mode it only fires when the input isn't focused
  // (e.g. after a result is shown and Again/Got It buttons are visible).
  const flipRef = useRef(flip);
  const answerRef = useRef(answer);
  const goBackRef = useRef(goBack);
  const giveUpRef = useRef(giveUpTyped);
  useEffect(() => { flipRef.current = flip; }, [flip]);
  useEffect(() => { answerRef.current = answer; });
  useEffect(() => { goBackRef.current = goBack; });
  useEffect(() => { giveUpRef.current = giveUpTyped; });

  useEffect(() => {
    if (mode !== "study" || typeMode) return;
    const handler = (e) => {
      if (!card) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); flipRef.current(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); answerRef.current(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); answerRef.current(true); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [card, mode, typeMode]);

  // In type mode, after a result is showing (input gone), Enter/Space/→
  // auto-commits the matcher's verdict and advances to the next card.
  // The matcher's verdict is the progress update — no self-report needed.
  useEffect(() => {
    if (mode !== "study" || !typeMode || !typeResult) return;
    const gotIt = typeResult === "correct" || typeResult === "close" || typeResult === "wrongArticle";
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        answerRef.current(gotIt, "typed");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, typeMode, typeResult]);

  // Submit a feedback claim: "my answer should have been accepted"
  const [feedbackErrMsg, setFeedbackErrMsg] = useState("");
  const [feedbackVerdict, setFeedbackVerdict] = useState(null); // {verdict, reasoning}

  const submitFeedback = async () => {
    if (!card || !typedAnswer.trim()) return;
    setFeedbackState("submitting");
    setFeedbackErrMsg("");
    setFeedbackVerdict(null);
    const correctText = card.shownDir === "fr" ? card.b : card.f;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/review-answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          card_id: card.id,
          direction: card.shownDir,
          french: card.f,
          english: card.b,
          user_answer: typedAnswer,
          expected_answer: correctText,
        }),
      });
      const responseText = await res.text();
      let data;
      try { data = JSON.parse(responseText); } catch { data = null; }
      if (!res.ok) {
        setFeedbackErrMsg(data?.error || `HTTP ${res.status}`);
        setFeedbackState("error");
        return;
      }
      setFeedbackVerdict(data);
      if (data?.verdict === "accept") {
        // Update local alternates so the matcher accepts it immediately
        const key = `${card.id}:${card.shownDir}`;
        setAlternates(prev => ({
          ...prev,
          [key]: [...(prev[key] || []), typedAnswer],
        }));
      }
      setFeedbackState("submitted");
    } catch (e) {
      console.error("Feedback failed:", e);
      setFeedbackErrMsg(e.message);
      setFeedbackState("error");
    }
  };

  // Force-accept: user overrides Claude's reject/uncertain verdict
  const forceAcceptAnswer = async () => {
    if (!card || !typedAnswer.trim()) return;
    setFeedbackState("submitting");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/review-answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          card_id: card.id,
          direction: card.shownDir,
          french: card.f,
          english: card.b,
          user_answer: typedAnswer,
          expected_answer: card.shownDir === "fr" ? card.b : card.f,
          force: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setFeedbackErrMsg(data?.error || `HTTP ${res.status}`);
        setFeedbackState("error");
        return;
      }
      // Update local alternates
      const key = `${card.id}:${card.shownDir}`;
      setAlternates(prev => ({
        ...prev,
        [key]: [...(prev[key] || []), typedAnswer],
      }));
      setFeedbackState("accepted");
    } catch (e) {
      setFeedbackErrMsg(e.message);
      setFeedbackState("error");
    }
  };

  const resetAll = async () => {
    if (!confirm("Reset all of your progress? This can't be undone.")) return;
    await resetAllProgress();
    resetSession();
  };

  // ── SEED DEMO DECK (admin only) ─────────────────────────────────────
  // Bulk-inserts RAW into user_cards for the current user. Preserves
  // categories (vocab/expr/gram/pron → V/E/G/P) and dates so Matt's existing
  // card_progress rows continue to match via the lowercased-front id.
  const seedDemoDeck = async () => {
    if (!user) return;
    setSeeding(true);
    setSeedError("");
    try {
      // Build rows from RAW, deduped by lowercased front (matches old buildDeck)
      const seen = new Map();
      for (const [f, b, cat, dates] of RAW) {
        const key = f.toLowerCase().trim();
        if (seen.has(key)) {
          const ex = seen.get(key);
          ex.dates = [...new Set([...ex.dates, ...dates])];
        } else {
          seen.set(key, { front: f, back: b, category: CAT_TO_DB[cat] || "V", dates: [...dates] });
        }
      }
      const rows = [...seen.values()].map(r => ({
        user_id: user.id,
        front: r.front,
        back: r.back,
        category: r.category,
        dates: r.dates,
        source: "demo-seed",
      }));
      // Insert in chunks of 500
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabase
          .from("user_cards")
          .upsert(chunk, { onConflict: "user_id,front" });
        if (error) throw error;
      }
      reloadDeck();
    } catch (e) {
      console.error("seed failed:", e);
      setSeedError(e.message || "Seed failed");
    } finally {
      setSeeding(false);
    }
  };

  // ── INLINE CARD EDIT ────────────────────────────────────────────────
  // saveCardEdit receives the originals via `ctx` straight from the
  // EditCardModal — never re-looks them up in React state. The previous
  // implementation did `userCards.find(c => c.row_id === rowId)` and then
  // silently skipped logging when the lookup missed (stale state, etc.),
  // which is why /api/parse-corrections was never being hit.
  const saveCardEdit = async (rowId, newFront, newBack, ctx = {}) => {
    const trimmedFront = newFront.trim();
    const trimmedBack = newBack.trim();

    const { error } = await supabase
      .from("user_cards")
      .update({ front: trimmedFront, back: trimmedBack, flagged_for_review: false })
      .eq("id", rowId);
    if (error) {
      console.error("Card update failed:", error);
      return false;
    }

    // Fire-and-forget: log to the parse-corrections ledger so future
    // cahier parses learn from this edit. Skip only when nothing changed.
    const frontChanged =
      ctx.originalFront != null && ctx.originalFront !== trimmedFront;
    const backChanged =
      ctx.originalBack != null && ctx.originalBack !== trimmedBack;
    if (frontChanged || backChanged) {
      logCorrection({
        category: frontChanged
          ? CORRECTION_CATEGORIES.FRONT_TEXT_EDIT
          : CORRECTION_CATEGORIES.BACK_TEXT_EDIT,
        action: CORRECTION_ACTIONS.EDIT,
        card_id: rowId,
        batch_id: ctx.batchId || null, // null for legacy cards
        original_front: ctx.originalFront ?? null,
        original_back: ctx.originalBack ?? null,
        corrected_front: trimmedFront,
        corrected_back: trimmedBack,
      });
    }

    reloadDeck();
    return true;
  };

  const deleteCard = async (rowId) => {
    const { error } = await supabase.from("user_cards").delete().eq("id", rowId);
    if (error) {
      console.error("Card delete failed:", error);
      return false;
    }
    reloadDeck();
    return true;
  };

  const flagCard = async (rowId) => {
    const { error } = await supabase
      .from("user_cards")
      .update({
        flagged_for_review: true,
        flagged_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    if (error) {
      console.error("Flag failed:", error);
      return;
    }
    reloadDeck();
  };

  if (!loaded) return <div style={S.loading}>Loading…</div>;

  // ── ONBOARDING (empty deck) ─────────────────────────────────────────
  if (userCards.length === 0) {
    const openUpload = (tab) => { setUploadInitialTab(tab); setShowUpload(true); };
    return (
      <div style={S.onbPage}>
        {/* Sign out cluster top right */}
        {user && (
          <div style={S.onbTopBar}>
            <span style={S.onbTopEmail}>{user.email}</span>
            <button style={S.onbTopSignOut} onClick={onSignOut}>Sign out</button>
          </div>
        )}

        <div style={S.onbInner}>
          {/* Hero — left text + right typographic preview */}
          <section style={S.onbHero}>
            <div style={S.onbHeroLeft}>
              <h1 style={S.onbHeroTitle}>Welcome.</h1>
              <p style={S.onbHeroText}>
                Upload your document to get started. We'll turn your lesson notes into a personal deck — vocabulary, expressions, grammar, and conjugation drills.
              </p>
              <button style={S.onbHeroCta} onClick={() => openUpload("paste")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                Upload document
              </button>
            </div>
            <div style={S.onbHeroRight}>
              <div style={{...S.onbSample, ...S.onbSample1}}>
                <div style={S.onbSampleEyebrow}>Vocabulaire</div>
                <div style={S.onbSampleWord}>vivre</div>
                <div style={S.onbSampleEn}>to live</div>
              </div>
              <div style={{...S.onbSample, ...S.onbSample2}}>
                <div style={S.onbSampleEyebrow}>Expressions</div>
                <div style={S.onbSampleWord}>Tu en es où ?</div>
                <div style={S.onbSampleEn}>where are you with it?</div>
              </div>
              <div style={{...S.onbSample, ...S.onbSample3}}>
                <div style={S.onbSampleEyebrow}>Grammaire</div>
                <div style={S.onbSampleWord}>vivre → je vis</div>
                <div style={S.onbSampleEn}>présent</div>
              </div>
            </div>
          </section>

          {/* Import methods bento */}
          <section style={S.onbBento}>
            <button style={S.onbCard} onClick={() => openUpload("paste")}>
              <div style={S.onbCardIcon}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
              </div>
              <h3 style={S.onbCardTitle}>Paste text</h3>
              <p style={S.onbCardDesc}>Paste your document contents directly from your clipboard.</p>
              <div style={S.onbCardArrow}>→</div>
            </button>
            <button style={{...S.onbCard, ...S.onbCardFeatured}} onClick={() => openUpload("file")}>
              <div style={{...S.onbCardIcon, ...S.onbCardIconFeatured}}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
              </div>
              <h3 style={S.onbCardTitle}>Upload .txt file</h3>
              <p style={S.onbCardDesc}>Drag and drop a plain text file from your computer.</p>
              <div style={S.onbCardArrow}>→</div>
            </button>
            <button style={S.onbCard} onClick={() => openUpload("link")}>
              <div style={S.onbCardIcon}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </div>
              <h3 style={S.onbCardTitle}>Google Doc link</h3>
              <p style={S.onbCardDesc}>Paste a public Google Doc URL and we'll fetch the contents.</p>
              <div style={S.onbCardArrow}>→</div>
            </button>
          </section>

          {/* Admin seed button — small, below */}
          {isAdmin && (
            <div style={S.onbAdmin}>
              <button onClick={seedDemoDeck} disabled={seeding} style={S.onbAdminBtn}>
                {seeding ? "Seeding…" : "Seed demo deck (admin)"}
              </button>
              {seedError && <div style={S.onbError}>{seedError}</div>}
            </div>
          )}
        </div>

        <CahierUpload
          open={showUpload}
          onClose={() => setShowUpload(false)}
          hasExisting={false}
          initialTab={uploadInitialTab}
          onSuccess={(result) => {
            setShowUpload(false);
            reloadDeck();
            alert(
              `Done!\n\n${result.cardsInserted} cards across ${result.datesCovered} lessons.\n` +
              (result.conjugationDrillsGenerated ? `${result.conjugationDrillsGenerated} conjugation drills generated.\n` : "") +
              (result.polysemySplits ? `${result.polysemySplits} polysemy splits.` : "")
            );
          }}
        />
      </div>
    );
  }

  // ── SHELL: SIDEBAR ──────────────────────────────────────────────────
  // The sidebar is the global app shell. On wide screens it's a fixed
  // 256px-wide column; on phones it collapses to a fixed bottom nav.
  // Defined here (inside the component) so it captures all the closure
  // variables it needs without prop-drilling.
  // Icon SVGs for sidebar nav (14×14, inline, match Material Symbols style)
  const NAV_ICONS = {
    study: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>,
    stats: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>,
    feedback: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>,
  };

  const navItems = [["study", "Cards"], ["stats", "Stats"]];
  
  const sidebar = (
    <aside style={isNarrow ? S.sideBarBottom : S.sideBar}>
      {/* Nav items with icons */}
      <nav style={isNarrow ? S.sideNavBottom : S.sideNav}>
        {navItems.map(([m, label]) => {
          const baseStyle = isNarrow ? S.sideItemBottom : S.sideItem;
          const activeStyle = isNarrow ? S.sideItemBottomActive : S.sideItemActive;
          return (
            <button
              key={m}
              style={mode === m ? {...baseStyle, ...activeStyle} : baseStyle}
              onClick={() => { setMode(m); }}
            >
              <span style={S.sideIcon}>{NAV_ICONS[m]}</span>
              {label}
            </button>
          );
        })}
      </nav>

      {/* Bottom: profile + feedback on one row (desktop only) */}
      {!isNarrow && user && (
        <div style={S.sideBottom}>
          <div style={S.sideBottomRow}>
            <div style={S.sideProfileRow}>
              <button
                style={S.profileBtn}
                onClick={() => setShowProfileMenu(v => !v)}
              >
                <div style={S.profileAvatar}>{user.email[0].toUpperCase()}</div>
              </button>
              {showProfileMenu && (
                <div style={S.profileMenuBottom}>
                  <div style={S.profileMenuEmail}>{user.email}</div>
                  <button
                    style={S.profileMenuItem}
                    onClick={() => { setUploadInitialTab("paste"); setShowUpload(true); setShowProfileMenu(false); }}
                  >
                    Upload document
                  </button>
                  {isAdmin && (<>
                    <button
                      style={S.profileMenuItem}
                      onClick={() => { setShowFeedbackModal(true); setShowProfileMenu(false); }}
                    >
                      View feedback
                    </button>
                    <button
                      style={S.profileMenuItem}
                      onClick={() => { setShowUsersModal(true); setShowProfileMenu(false); }}
                    >
                      View users
                    </button>
                  </>)}
                  <button style={S.profileMenuItem} onClick={onSignOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
            <span style={S.sideBottomEmail}>{user.email}</span>
            <BetaFeedback user={user} currentPage={mode} currentCard={mode === "study" ? card : null} />
          </div>
        </div>
      )}
    </aside>
  );

  // ── SHARED MODALS ───────────────────────────────────────────────────
  // These need to render regardless of which view (stats, cards, etc.) is
  // active, because they're triggered from the profile menu in the sidebar
  // which is visible from every view. Previously they were only mounted
  // inside the Cards view's return, so clicking "View users" from Stats
  // would set the flag but render nothing until you tabbed back to Cards.
  const modals = (
    <>
      <CahierUpload
        open={showUpload}
        onClose={() => setShowUpload(false)}
        hasExisting={userCards.length > 0}
        initialTab={uploadInitialTab}
        onSuccess={(result) => {
          setShowUpload(false);
          reloadDeck();
          alert(
            `Done!\n\n${result.cardsInserted} cards across ${result.datesCovered} lessons.\n` +
            (result.conjugationDrillsGenerated ? `${result.conjugationDrillsGenerated} conjugation drills generated.\n` : "") +
            (result.polysemySplits ? `${result.polysemySplits} polysemy splits.` : "")
          );
        }}
      />
      {showFeedbackModal && (
        <FeedbackReviewModal
          onClose={() => setShowFeedbackModal(false)}
          onEditCard={(item) => {
            const frontText = item.card_context?.front;
            if (!frontText) {
              alert("This feedback has no attached card — nothing to edit.");
              return;
            }
            // Match by lowercased trim (same convention as card_progress joins).
            const key = String(frontText).toLowerCase().trim();
            const found = userCards.find(c => String(c.f || "").toLowerCase().trim() === key);
            if (!found) {
              alert(`Couldn't find the card "${frontText}" in your deck. It may have been edited or deleted since this feedback was submitted.`);
              return;
            }
            setShowFeedbackModal(false);
            setEditingCard(found);
          }}
        />
      )}
      {showUsersModal && (
        <UsersModal onClose={() => setShowUsersModal(false)} />
      )}
      {editingCard && (
        <EditCardModal
          card={editingCard}
          onClose={() => setEditingCard(null)}
          onSave={async (newFront, newBack) => {
            // Pass originals + batch_id through from the modal itself, so
            // saveCardEdit doesn't depend on a React-state lookup that
            // might miss.
            const ok = await saveCardEdit(
              editingCard.row_id,
              newFront,
              newBack,
              {
                originalFront: editingCard.f,
                originalBack: editingCard.b,
                batchId: editingCard.batch_id,
              }
            );
            if (ok) setEditingCard(null);
            return ok;
          }}
          onDelete={async () => {
            if (!confirm("Delete this card? This cannot be undone.")) return;

            // Prompt admin for a correction category. Default to
            // duplicate_detected since that's by far the most common
            // deletion reason. Admin can override with any other code from
            // the menu; anything unrecognized falls back to the default.
            const CATEGORY_MENU = [
              "duplicate_detected",
              "should_split_polysemy",
              "should_merge_gendered",
              "wrong_disambiguator",
              "wrong_card_type",
              "reversed_front_back",
              "spelling_correction",
              "other",
            ];
            const categoryInput = window.prompt(
              `Why are you deleting this card?\n\nPick one:\n  ${CATEGORY_MENU.join(
                "\n  "
              )}\n\n(press Enter to accept the default)`,
              "duplicate_detected"
            );
            // Pressing Cancel returns null — treat as abort.
            if (categoryInput === null) return;
            const category = CATEGORY_MENU.includes(categoryInput.trim())
              ? categoryInput.trim()
              : "duplicate_detected";

            // Log BEFORE deleting — the original front/back are lost once
            // the row is gone.
            logCorrection({
              category,
              action: CORRECTION_ACTIONS.DELETE,
              card_id: editingCard.row_id,
              batch_id: editingCard.batch_id || null,
              original_front: editingCard.f,
              original_back: editingCard.b,
            });

            const ok = await deleteCard(editingCard.row_id);
            if (ok) setEditingCard(null);
          }}
        />
      )}
    </>
  );

  // ── STATS VIEW ──────────────────────────────────────────────────────
  if (mode === "stats") {
    const total = userCards.length;
    const learned = userCards.filter(c => (progress[c.id]?.score??0) >= 3).length;
    const inProg = userCards.filter(c => { const s=progress[c.id]?.score??0; return s>0&&s<3; }).length;
    const newCount = total - learned - inProg;

    // Streak: based on actual review days stored in Supabase
    // (loaded into reviewDates state on mount, appended to by answer()).
    const todayISO = new Date().toISOString().slice(0,10);
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0,10);
      if (reviewDates.has(iso)) streak++;
      else if (iso !== todayISO) break;
    }

    // Session accuracy
    const sessionAcc = stats.seen > 0 ? Math.round((stats.got / stats.seen) * 100) : 0;

    // Due for review: cards you've started (score 1-2) but haven't mastered
    const dueForReview = userCards.filter(c => {
      const s = progress[c.id]?.score ?? 0;
      return s > 0 && s < 3;
    }).length;

    // Hardest cards
    const hardest = userCards
      .map(c => ({ ...c, _score: progress[c.id]?.score ?? 0, _seen: progress[c.id]?.seen ?? 0 }))
      .filter(c => c._seen >= 2 && c._score <= 1)
      .sort((a, b) => b._seen - a._seen || a._score - b._score)
      .slice(0, 4);

    // Pipeline bar proportions
    const pipeTotal = Math.max(total, 1);

    return (
      <div style={isNarrow ? S.shellNarrow : S.shell}>
        {sidebar}
        <main style={S.main}>
          <div style={S.mainInner}>
            <h1 style={S.statsHeading}>Progress</h1>

            {/* Row 1: This session · Accuracy · Streak */}
            <div style={S.statsRow3}>
              <div style={S.metricCard}>
                <div style={S.metricLabel}>This session</div>
                <div style={S.metricVal}>{stats.seen}</div>
                <div style={S.metricSub}>cards reviewed</div>
              </div>
              <div style={S.metricCard}>
                <div style={S.metricLabel}>Accuracy</div>
                <div style={S.metricVal}>{stats.seen > 0 ? `${sessionAcc}%` : "—"}</div>
                <div style={S.metricSub}>{stats.seen > 0 ? `${stats.got} of ${stats.seen} correct` : "study some cards first"}</div>
              </div>
              <div style={S.streakCard}>
                <div style={{fontSize:16}}>🔥</div>
                <div style={S.streakNum}>{streak}</div>
                <div style={S.streakSub}>day streak</div>
              </div>
            </div>
            <div style={S.statsNote}>Stats only count answers typed with "Type answer" mode — flip-mode responses aren't tracked.</div>

            {/* Pipeline: New → Learning → Mastered */}
            <div style={S.pipelineCard}>
              <div style={S.pipeTitle}>Your {total.toLocaleString()} cards</div>
              <div style={S.pipeBarWrap}>
                {newCount > 0 && <div style={{...S.pipeSeg, background:T.color.surfaceHigh, flex:newCount}} />}
                {inProg > 0 && (
                  <div style={{...S.pipeSeg, background:T.color.secondary, flex:inProg, color:"#fff", fontSize:11, fontWeight:600, minWidth:40}}>
                    {inProg}
                  </div>
                )}
                {learned > 0 && (
                  <div style={{...S.pipeSeg, background:T.color.primary, flex:learned, color:T.color.onPrimary, fontSize:11, fontWeight:600, minWidth:40}}>
                    {learned}
                  </div>
                )}
              </div>
              <div style={S.pipeLegend}>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:"rgba(3,22,50,0.12)"}} />{newCount.toLocaleString()} new</div>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.secondary}} />{inProg} learning</div>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.primary}} />{learned} mastered</div>
              </div>
            </div>

            {/* Hardest Cards */}
            {hardest.length > 0 && (
              <div style={{marginTop:24}}>
                <h3 style={S.statsSectionTitle}>Hardest cards</h3>
                <p style={S.statsSectionSub}>Cards you've seen multiple times but keep missing.</p>
                <div style={S.hardGrid}>
                  {hardest.map(c => (
                    <div key={c.id} style={S.hardCard}>
                      <div style={S.hardHead}>
                        <span style={{
                          ...S.hardTag,
                          background: TAB_COLORS[catToTab(c.cat)] + "22",
                          color: TAB_COLORS[catToTab(c.cat)],
                        }}>
                          {catToLabel(c.cat)}
                        </span>
                      </div>
                      <h4 style={S.hardWord}>{c.f}</h4>
                      <p style={S.hardMeta}>Score {c._score}/5 · seen {c._seen}×</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button style={S.resetBtn} onClick={resetAll}>Reset all progress</button>
          </div>
        </main>
        {modals}
      </div>
    );
  }

  // ── FEEDBACK VIEW (admin only) ──────────────────────────────────────
  // ── STUDY MODE ──────────────────────────────────────────────────────
  const front = card ? (card.shownDir==="fr" ? card.f : card.b) : "";
  const back = card ? (card.shownDir==="fr" ? card.b : card.f) : "";
  // Typing mode: user enabled it AND the card exists. All cards are
  // typable — if the back is a long explanation, the user can hit
  // "Show answer" to skip. The old isTypable guard (back ≤ 25 chars)
  // silently disabled type mode on many cards, making the toggle button
  // appear broken.
  const effectiveTypeMode = typeMode && !!card;
  return (
    <div style={isNarrow ? S.shellNarrow : S.shell}>
      {sidebar}
      <main style={S.main}>
        {/* Top app bar — direction toggle, type answer chip, sticky glass */}
        <div style={S.topBar}>
          <div style={S.topBarSpacer} />
          <div style={S.dirGroup}>
            {[["fr","FR→EN"],["en","EN→FR"],["mix","Mixed"]].map(([k,label]) => (
              <button key={k} style={dir===k ? {...S.dirBtn,...S.dirBtnA} : S.dirBtn} onClick={() => setDir(k)}>{label}</button>
            ))}
          </div>
          <button
            style={typeMode ? {...S.chipToggle, ...S.chipToggleA} : S.chipToggle}
            onClick={() => { setTypeMode(v => !v); setTypedAnswer(""); setTypeResult(null); setFlipped(false); }}
          >
            Type answer
          </button>
          {TTS_AVAILABLE && (
            <button
              style={autoSpeak ? {...S.chipToggle, ...S.chipToggleA} : S.chipToggle}
              onClick={() => setAutoSpeak(v => !v)}
              title="Auto-speak French side"
            >
              Auto-speak
            </button>
          )}
        </div>

        <div style={S.mainInner}>
          {/* Sub-toolbar: category filter + counter */}
          <div style={S.subToolbar}>
            <div style={S.catRow}>
              {Object.entries(TAB_LABELS).map(([k,v]) => (
                <button
                  key={k}
                  style={cat===k ? {...S.catBtn,...S.catBtnA,...(k!=="all"?{borderColor:TAB_COLORS[k],color:TAB_COLORS[k]}:{})} : S.catBtn}
                  onClick={() => setCat(k)}
                >
                  {v}
                </button>
              ))}
            </div>
            {card && (
              <div style={S.subToolbarRight}>
                {effectiveTypeMode && idx > 0 && (
                  <button style={S.backBtn} onClick={goBack}>← Back</button>
                )}
                <span style={S.counter}>Card {idx+1} of {deck.length}</span>
              </div>
            )}
          </div>

          {card ? (
            <div style={S.cardArea}>
              {/* Decorative blur shapes (per Stitch design) */}
              <div style={S.blurTL} />
              <div style={S.blurBR} />

              <div style={S.cardWrap} onClick={flip}>
                <div style={{...S.card, transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)", transition: skipFlipAnim.current ? "none" : S.card.transition, cursor: "pointer"}}>
                  <div style={S.cardFront}>
                    <div style={S.cardEyebrow}>{catToLabel(card.cat)}{card.freq>=2 && <span style={S.freqTag}>{card.freq}×</span>}</div>
                    <div style={S.cardText}>{front}</div>
                    {TTS_AVAILABLE && card.shownDir === "fr" && (
                      <div style={S.cardAudio}>
                        <button
                          style={S.cardAudioBtn}
                          onClick={(e) => { e.stopPropagation(); speakCard(); }}
                          title="Play French pronunciation"
                        >
                          🔊
                        </button>
                        {STT_AVAILABLE && PRONUNCIATION_ENABLED && (
                          <button
                            style={recState === "recording" ? {...S.cardAudioBtn, ...S.cardAudioMicActive} : {...S.cardAudioBtn, ...S.cardAudioMic}}
                            onClick={(e) => { e.stopPropagation(); if (recState === "recording") stopRecording(); else startRecording(); }}
                            title="Record yourself speaking"
                          >
                            🎤
                          </button>
                        )}
                      </div>
                    )}
                    {!effectiveTypeMode && <div style={S.cardHint}>Tap to reveal translation</div>}
                    {!effectiveTypeMode && <ShortcutsTooltip />}
                  </div>
                  <div style={S.cardBack}>
                    <div style={S.cardEyebrow}>{catToLabel(card.cat)}</div>
                    <div style={S.cardTextB}>{back}</div>
                    {TTS_AVAILABLE && card.shownDir === "en" && (
                      <div style={S.cardAudio}>
                        <button
                          style={S.cardAudioBtn}
                          onClick={(e) => { e.stopPropagation(); speakCard(); }}
                          title="Play French pronunciation"
                        >
                          🔊
                        </button>
                      </div>
                    )}
                    <div style={S.cardActionsFloat}>
                      <button
                        style={S.cardActionBtn}
                        onClick={(e) => { e.stopPropagation(); setEditingCard(card); }}
                        title="Edit this card"
                      >
                        ✏️
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Pronunciation panel — appears below card when recording or showing results */}
              {PRONUNCIATION_ENABLED && (recState !== "idle") && (
                <PronunciationPanel
                  recState={recState}
                  result={pronResult}
                  error={pronError}
                  referenceText={card.f.includes("→") ? card.b : card.f}
                  onCancel={cancelRecording}
                  onRetry={() => { setRecState("idle"); setPronResult(null); setPronError(""); setTimeout(startRecording, 100); }}
                  onSpeakWord={speakText}
                  onDismiss={() => { setRecState("idle"); setPronResult(null); setPronError(""); }}
                />
              )}

              {effectiveTypeMode ? (
                typeResult ? (
                  <div style={S.typeFeedback}>
                    <div style={typeResult==="correct" ? S.typeCorrect : typeResult==="close" ? S.typeClose : typeResult==="revealed" ? S.typeRevealed : S.typeWrong}>
                      {typeResult==="correct" && "✓ Correct!"}
                      {typeResult==="close" && `✓ Close enough — answer: ${back}`}
                      {typeResult==="wrongArticle" && `✗ Wrong article — answer: ${back}`}
                      {typeResult==="wrong" && `✗ Answer: ${back}`}
                      {typeResult==="revealed" && `Answer: ${back}`}
                    </div>
                    {(typeResult === "wrong" || typeResult === "close" || typeResult === "wrongArticle") && (
                      <div style={S.feedbackRow}>
                        {feedbackState === null && (
                          <button style={S.feedbackBtn} onClick={submitFeedback}>
                            My answer should have been accepted
                          </button>
                        )}
                        {feedbackState === "submitting" && <span style={S.feedbackPending}>Reviewing your answer…</span>}
                        {feedbackState === "submitted" && feedbackVerdict?.verdict === "accept" && (
                          <div style={S.feedbackMsg}>✓ Accepted — this answer will be remembered.</div>
                        )}
                        {feedbackState === "submitted" && (feedbackVerdict?.verdict === "reject" || feedbackVerdict?.verdict === "uncertain") && (
                          <div style={S.feedbackMsg}>
                            <div style={S.feedbackReasoning}>{feedbackVerdict.reasoning}</div>
                            <button style={S.feedbackOverrideBtn} onClick={forceAcceptAnswer}>
                              Accept anyway
                            </button>
                          </div>
                        )}
                        {feedbackState === "accepted" && (
                          <div style={S.feedbackMsg}>✓ Accepted — this answer will be remembered.</div>
                        )}
                        {feedbackState === "error" && <span style={S.feedbackErr}>{feedbackErrMsg || "Couldn't send — try again"}</span>}
                      </div>
                    )}
                    {(() => {
                      const gotIt = typeResult === "correct" || typeResult === "close" || typeResult === "wrongArticle";
                      return (
                        <div style={S.typeAdvanceRow}>
                          {gotIt && (
                            <button
                              style={S.markReviewLink}
                              onClick={() => answer(false, "typed")}
                              title="Record as incorrect and keep this card near the top of the queue"
                            >
                              Actually, mark for review
                            </button>
                          )}
                          <button style={S.continueBtn} onClick={() => answer(gotIt, "typed")}>
                            Continue →
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <>
                    <div style={S.typeInputRow}>
                      <input
                        ref={studyInputRef}
                        style={S.typeInput}
                        value={typedAnswer}
                        onChange={e => setTypedAnswer(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") submitTyped(); else if (e.key === "Escape") { e.target.blur(); giveUpTyped(); } }}
                        placeholder={`Type ${card.shownDir==="fr" ? "English" : "French"}…`}
                        autoFocus
                      />
                      <button style={S.typeSubmit} onClick={submitTyped}>Check</button>
                    </div>
                    <div style={S.giveUpRow}>
                      <button style={S.giveUpBtn} onClick={giveUpTyped}>
                        Show answer
                      </button>
                    </div>
                  </>
                )
              ) : (
                <>
                  <div style={S.actionRow}>
                    <button style={S.actionAgainRect} onClick={() => answer(false)}>
                      Again
                    </button>
                    <button style={S.actionGotRect} onClick={() => answer(true)}>
                      Got It
                    </button>
                  </div>
                  </>
              )}
            </div>
          ) : (
            <div style={S.empty}><div style={{fontSize:48}}>🎉</div><p>No cards in this selection.</p><button style={S.resetSBtn} onClick={resetSession}>Start Over</button></div>
          )}

          {idx >= deck.length-1 && deck.length > 0 && stats.seen > 0 && (
            <div style={S.sessionDone}>
              <p style={S.doneText}>Session complete! {stats.got}/{stats.seen} ({Math.round(stats.got/Math.max(stats.seen,1)*100)}%)</p>
              <button style={S.resetSBtn} onClick={resetSession}>New Session</button>
            </div>
          )}
        </div>

      </main>
      {modals}
    </div>
  );
}

// ─── EDIT CARD MODAL ─────────────────────────────────────────────────────
// ─── CARD CONTEXT PREVIEW ─────────────────────────────────────────────────
// Renders the card snapshot captured with a beta_feedback entry via the
// "Attach current card" toggle. Used in both FeedbackReviewModal and
// FeedbackAdminView so admin review shows which card was on screen
// without needing an actual screenshot.
function CardContextPreview({ ctx }) {
  if (!ctx) return null;
  const label = ctx.category === "vocab" ? "Vocabulary" : "Phrase";
  const color = ctx.category === "vocab" ? "#9c4234" : "#1a2b48";
  return (
    <div style={{
      border: "1px solid rgba(3,22,50,0.08)",
      background: T.color.surfaceLow,
      borderRadius: T.radius.lg,
      padding: "10px 12px",
      marginTop: 8,
      fontFamily: T.font.sans,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 6,
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontWeight: 600,
      }}>
        <span style={{ color }}>{label}</span>
        <span style={{ opacity: 0.4, color: T.color.onSurfaceVariant }}>·</span>
        <span style={{ color: T.color.onSurfaceVariant, opacity: 0.7 }}>
          shown: {ctx.shown_dir === "fr" ? "FR → EN" : "EN → FR"}
        </span>
      </div>
      <div style={{ fontSize: 15, color: T.color.onSurface, marginBottom: 2, fontWeight: 500 }}>
        {ctx.front}
      </div>
      <div style={{ fontSize: 13, color: T.color.onSurfaceVariant }}>
        {ctx.back}
      </div>
    </div>
  );
}

// ─── FEEDBACK REVIEW MODAL (admin only) ───────────────────────────────────
// Shows all beta_feedback entries in a portal overlay. Triggered from the
// profile dropdown → "View feedback".
function FeedbackReviewModal({ onClose, onEditCard }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("beta_feedback")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) console.error("Failed to load feedback:", error);
      setItems(data || []);
      setLoading(false);
    })();
  }, []);

  const dismiss = async (id) => {
    if (!confirm("Delete this feedback? This can't be undone.")) return;
    // Chain .select() so PostgREST returns the deleted rows — this lets us
    // detect RLS silent failures (delete blocked by policy returns success
    // with zero rows affected, no error) that would otherwise make the row
    // disappear from the UI but stay in the DB, reappearing on refresh.
    const { data, error } = await supabase
      .from("beta_feedback")
      .delete()
      .eq("id", id)
      .select();
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) {
      alert("Delete was blocked by the database (0 rows affected). The beta_feedback table is missing an admin DELETE RLS policy — run the migration in Supabase SQL editor to fix it.");
      return;
    }
    setItems(prev => prev.filter(i => i.id !== id));
  };

  return createPortal(
    <div style={S.feedbackModalOverlay} onClick={onClose}>
      <div style={S.feedbackModalBox} onClick={e => e.stopPropagation()}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20}}>
          <h2 style={{margin:0, fontSize:24, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary}}>User feedback</h2>
          <button style={{background:"none", border:"none", fontSize:24, cursor:"pointer", color:T.color.onSurfaceVariant, padding:"0 4px"}} onClick={onClose}>×</button>
        </div>
        {loading ? (
          <div style={{textAlign:"center", padding:32, color:T.color.onSurfaceVariant, fontFamily:T.font.sans}}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{textAlign:"center", padding:32, color:T.color.onSurfaceVariant, fontFamily:T.font.sans}}>No feedback yet.</div>
        ) : (
          <div style={{display:"flex", flexDirection:"column", gap:12, maxHeight:"60vh", overflowY:"auto"}}>
            {items.map(item => (
              <div key={item.id} style={S.fbItem}>
                <div style={S.fbItemHeader}>
                  <span style={S.fbItemEmail}>{item.user_email || "anonymous"}</span>
                  <span style={S.fbItemDate}>{new Date(item.created_at).toLocaleDateString()}</span>
                </div>
                <div style={S.fbItemMsg}>{item.message}</div>
                {item.card_context && <CardContextPreview ctx={item.card_context} />}
                {item.screenshot && (
                  <img src={item.screenshot} alt="Screenshot" style={S.fbItemImg} />
                )}
                <div style={{display:"flex", gap:8}}>
                  {item.card_context && onEditCard && (
                    <button style={S.fbItemDismiss} onClick={() => onEditCard(item)}>Edit card</button>
                  )}
                  <button style={S.fbItemDismiss} onClick={() => dismiss(item.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── USERS MODAL (admin only) ─────────────────────────────────────────────
function UsersModal({ onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch("/api/admin-users", {
          headers: { Authorization: `Bearer ${session?.access_token}` },
        });
        // Parse defensively: a truncated or non-JSON response (e.g. a Vercel
        // error page) would otherwise surface the raw V8 parse error string
        // to the user.
        const responseText = await res.text();
        let data = null;
        try { data = JSON.parse(responseText); } catch { /* non-JSON response */ }
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setUsers(data?.users || []);
      } catch (e) {
        setError(e.message);
      }
      setLoading(false);
    })();
  }, []);

  const timeAgo = (iso) => {
    if (!iso) return "never";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  return createPortal(
    <div style={S.feedbackModalOverlay} onClick={onClose}>
      <div style={{...S.feedbackModalBox, maxWidth:700}} onClick={e => e.stopPropagation()}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20}}>
          <h2 style={{margin:0, fontSize:24, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary}}>Users</h2>
          <button style={{background:"none", border:"none", fontSize:24, cursor:"pointer", color:T.color.onSurfaceVariant, padding:"0 4px"}} onClick={onClose}>×</button>
        </div>
        {loading ? (
          <div style={{textAlign:"center", padding:32, color:T.color.onSurfaceVariant, fontFamily:T.font.sans}}>Loading…</div>
        ) : error ? (
          <div style={{textAlign:"center", padding:32, color:T.color.secondary, fontFamily:T.font.sans}}>{error}</div>
        ) : users.length === 0 ? (
          <div style={{textAlign:"center", padding:32, color:T.color.onSurfaceVariant, fontFamily:T.font.sans}}>No users yet.</div>
        ) : (
          <div style={{overflowX:"auto"}}>
            <table style={S.usersTable}>
              <thead>
                <tr>
                  <th style={S.usersTh}>Email</th>
                  <th style={S.usersTh}>Deck</th>
                  <th style={S.usersTh}>Studied</th>
                  <th style={S.usersTh}>Mastered</th>
                  <th style={S.usersTh}>Last active</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={S.usersTd}>{u.email}</td>
                    <td style={S.usersTdNum}>{u.deck_size}</td>
                    <td style={S.usersTdNum}>{u.studied}</td>
                    <td style={S.usersTdNum}>{u.mastered}</td>
                    <td style={S.usersTd}>
                      {u.last_review
                        ? timeAgo(u.last_review)
                        : u.last_sign_in
                          ? <>{timeAgo(u.last_sign_in)} <span style={{color:T.color.onSurfaceVariant, fontSize:12}}>· login only</span></>
                          : "never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function EditCardModal({ card, onClose, onSave, onDelete }) {
  const [front, setFront] = useState(card.f);
  const [back, setBack] = useState(card.b);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!front.trim() || !back.trim()) {
      setError("Both fields are required");
      return;
    }
    setSaving(true);
    setError("");
    const ok = await onSave(front, back);
    if (!ok) {
      setError("Save failed");
      setSaving(false);
    }
  };

  return (
    <div style={EM.overlay} onClick={saving ? null : onClose}>
      <div style={EM.modal} onClick={(e) => e.stopPropagation()}>
        <div style={EM.header}>
          <h2 style={EM.title}>Edit card</h2>
          <button style={EM.closeBtn} onClick={onClose} disabled={saving}>×</button>
        </div>
        <label style={EM.label}>French</label>
        <input
          style={EM.input}
          value={front}
          onChange={(e) => setFront(e.target.value)}
          disabled={saving}
        />
        <label style={EM.label}>English</label>
        <textarea
          style={EM.textarea}
          value={back}
          onChange={(e) => setBack(e.target.value)}
          disabled={saving}
        />
        {error && <div style={EM.error}>{error}</div>}
        <div style={EM.footer}>
          <button style={EM.deleteBtn} onClick={onDelete} disabled={saving}>Delete card</button>
          <div style={{flex:1}} />
          <button style={EM.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={EM.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const EM = {
  overlay: { position: "fixed", inset: 0, background: "rgba(3, 22, 50, 0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
  modal: { background: T.color.surfaceLowest, borderRadius: T.radius.xl, maxWidth: 500, width: "100%", padding: 32, boxShadow: T.shadow.modal, fontFamily: T.font.sans },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  title: { margin: 0, fontSize: 24, color: T.color.primary, fontFamily: T.font.serif, fontWeight: 600, letterSpacing: "-0.015em" },
  closeBtn: { background: "none", border: "none", fontSize: 28, cursor: "pointer", color: T.color.onSurfaceVariant, padding: "0 8px", lineHeight: 1 },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: T.color.primary, marginBottom: 6, marginTop: 14, textTransform: "uppercase", letterSpacing: "0.05em" },
  input: { width: "100%", padding: 12, fontSize: 17, border: "none", background: T.color.surfaceLow, borderRadius: T.radius.lg, boxSizing: "border-box", fontFamily: T.font.serif, color: T.color.onSurface },
  textarea: { width: "100%", minHeight: 80, padding: 12, fontSize: 14, border: "none", background: T.color.surfaceLow, borderRadius: T.radius.lg, boxSizing: "border-box", resize: "vertical", fontFamily: T.font.sans, color: T.color.onSurface, lineHeight: 1.5 },
  error: { padding: 12, background: T.color.errorContainer, color: T.color.onErrorContainer, borderRadius: T.radius.lg, fontSize: 13, marginTop: 14 },
  footer: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20, alignItems: "center" },
  deleteBtn: { padding: "9px 14px", background: "transparent", color: T.color.secondary, border: "none", borderRadius: T.radius.md, cursor: "pointer", fontSize: 13, fontFamily: T.font.sans, fontWeight: 500 },
  cancelBtn: { padding: "11px 20px", background: "transparent", border: "none", borderRadius: T.radius.md, cursor: "pointer", fontSize: 14, color: T.color.onSurfaceVariant, fontFamily: T.font.sans, fontWeight: 500 },
  saveBtn: { padding: "12px 26px", background: T.gradient.ink, color: T.color.onPrimary, border: "none", borderRadius: T.radius.md, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: T.font.sans, boxShadow: T.shadow.button, letterSpacing: "0.01em" },
};

// ─── FEEDBACK ADMIN VIEW ─────────────────────────────────────────────────
// Shows pending feedback submissions with the LLM's verdict. Admin can
// approve (adds answer as a card alternate) or reject (marks reviewed).
function FeedbackAdminView({ user, setMode, resetSession }) {
  const [items, setItems] = useState([]);
  const [betaItems, setBetaItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null); // id being acted on

  const load = async () => {
    setLoading(true);
    // Load card answer disputes
    const { data, error } = await supabase
      .from("feedback_submissions")
      .select("*")
      .eq("reviewed", false)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Failed to load feedback:", error);
      setItems([]);
    } else {
      setItems(data || []);
    }
    // Load general user feedback
    const { data: betaData, error: betaErr } = await supabase
      .from("beta_feedback")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (betaErr) {
      console.error("Failed to load beta feedback:", betaErr);
      setBetaItems([]);
    } else {
      setBetaItems(betaData || []);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const approve = async (item) => {
    setActing(item.id);
    const { error: altErr } = await supabase.from("card_alternates").insert({
      card_id: item.card_id,
      direction: item.direction,
      alternate_text: item.user_answer,
      source_feedback_id: item.id,
    });
    if (altErr) { console.error("Alt insert failed:", altErr); setActing(null); return; }

    // Resolve item.card_id (the lowercased-trimmed French front, per the
    // card_progress join convention used in the admin stats page) back to
    // the submitting user's user_cards row so the correction ledger can
    // reference a real uuid + batch_id. Falls back to nulls on no match —
    // never blocks the approval.
    let resolvedCardId = null;
    let resolvedBatchId = null;
    try {
      const key = String(item.card_id || "").toLowerCase().trim();
      if (key && item.user_id) {
        const { data: matches } = await supabase
          .from("user_cards")
          .select("id, front, batch_id")
          .eq("user_id", item.user_id)
          .ilike("front", key);
        const hit = (matches || []).find(
          (r) => String(r.front || "").toLowerCase().trim() === key
        );
        if (hit) {
          resolvedCardId = hit.id;
          resolvedBatchId = hit.batch_id || null;
        }
      }
    } catch (e) {
      console.warn("[approve] card_id resolve failed:", e?.message || e);
    }

    // Log the alternate approval so future cahier parses know this answer
    // is acceptable. card_id / batch_id point at the originating card when
    // we found it; otherwise null.
    logCorrection({
      category: CORRECTION_CATEGORIES.ALTERNATE_ANSWER,
      action: CORRECTION_ACTIONS.APPROVE_ALTERNATE,
      card_id: resolvedCardId,
      batch_id: resolvedBatchId,
      original_front: item.french || null,
      original_back: item.english || item.expected_answer || null,
      corrected_back: item.user_answer,
      notes: `direction=${item.direction}`,
    });

    const { error: upErr } = await supabase
      .from("feedback_submissions")
      .update({ reviewed: true, reviewed_at: new Date().toISOString(), action: "approved" })
      .eq("id", item.id);
    if (upErr) console.error("Review mark failed:", upErr);
    await load();
    setActing(null);
  };

  const reject = async (item) => {
    setActing(item.id);
    const { error } = await supabase
      .from("feedback_submissions")
      .update({ reviewed: true, reviewed_at: new Date().toISOString(), action: "rejected" })
      .eq("id", item.id);
    if (error) console.error("Reject failed:", error);
    await load();
    setActing(null);
  };

  const deleteBetaItem = async (id) => {
    const { error } = await supabase.from("beta_feedback").delete().eq("id", id);
    if (error) console.error("Delete failed:", error);
    else setBetaItems(prev => prev.filter(i => i.id !== id));
  };

  return (
    <>
      <h1 style={S.statsHeading}>Feedback Review</h1>

      {/* Card answer disputes */}
      <h3 style={S.statsSectionTitle}>Answer disputes</h3>
      {loading ? (
        <div style={S.empty}>Loading…</div>
      ) : items.length === 0 ? (
        <p style={S.statsSectionSub}>No pending answer disputes.</p>
      ) : (
        <div style={S.feedbackList}>
          {items.map(item => (
            <div key={item.id} style={S.feedbackItem}>
              <div style={S.feedbackCard}>
                <div style={S.feedbackCardHeader}>
                  <span style={S.feedbackDir}>{item.direction === "fr" ? "FR → EN" : "EN → FR"}</span>
                  <span style={S.feedbackDate}>{new Date(item.created_at).toLocaleDateString()}</span>
                </div>
                <div style={S.feedbackPrompt}>{item.direction === "fr" ? item.french : item.english}</div>
              </div>
              <div style={S.feedbackAnswers}>
                <div style={S.feedbackAnsRow}>
                  <span style={S.feedbackAnsLabel}>Expected:</span>
                  <span style={S.feedbackExpected}>{item.expected_answer}</span>
                </div>
                <div style={S.feedbackAnsRow}>
                  <span style={S.feedbackAnsLabel}>User typed:</span>
                  <span style={S.feedbackUser}>{item.user_answer}</span>
                </div>
              </div>
              {item.llm_verdict && (
                <div style={S.llmBlock}>
                  <div style={S.llmHead}>
                    <span style={item.llm_verdict === "accept" ? S.llmAccept : item.llm_verdict === "reject" ? S.llmReject : S.llmUnclear}>
                      Claude: {item.llm_verdict}
                    </span>
                  </div>
                  {item.llm_reasoning && <div style={S.llmReasoning}>{item.llm_reasoning}</div>}
                </div>
              )}
              <div style={S.feedbackActions}>
                <button style={S.feedbackApprove} onClick={() => approve(item)} disabled={acting === item.id}>
                  {acting === item.id ? "…" : "Approve (add alternate)"}
                </button>
                <button style={S.feedbackReject} onClick={() => reject(item)} disabled={acting === item.id}>
                  {acting === item.id ? "…" : "Reject"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* General user feedback from beta_feedback */}
      <h3 style={{...S.statsSectionTitle, marginTop:32}}>User feedback</h3>
      {betaItems.length === 0 ? (
        <p style={S.statsSectionSub}>No user feedback yet.</p>
      ) : (
        <div style={S.feedbackList}>
          {betaItems.map(item => (
            <div key={item.id} style={S.betaFeedbackItem}>
              <div style={S.betaFeedbackHeader}>
                <span style={S.betaFeedbackEmail}>{item.user_email || "anonymous"}</span>
                <span style={S.feedbackDate}>{new Date(item.created_at).toLocaleDateString()}</span>
              </div>
              <div style={S.betaFeedbackMsg}>{item.message}</div>
              {item.card_context && <CardContextPreview ctx={item.card_context} />}
              {item.screenshot && (
                <img src={item.screenshot} alt="Screenshot" style={S.betaFeedbackImg} />
              )}
              <button style={S.betaFeedbackDel} onClick={() => deleteBetaItem(item.id)}>Dismiss</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── SHORTCUTS TOOLTIP ────────────────────────────────────────────────────
// Small ⓘ circle in the bottom-right of the card area. Hover reveals
// keyboard shortcuts in a styled tooltip. Keeps the study view clean
// while remaining discoverable.
function ShortcutsTooltip() {
  const [show, setShow] = useState(false);
  return (
    <div style={S.infoWrap} onClick={(e) => e.stopPropagation()}>
      <div
        style={S.infoBtn}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(s => !s)}
      >
        ⓘ
      </div>
      {show && (
        <div style={S.infoTip}>
          <div><b>Space</b> flip card</div>
          <div><b>←</b> again</div>
          <div><b>→</b> or <b>Enter</b> got it</div>
        </div>
      )}
    </div>
  );
}

// ─── AUDIO TOOLBAR ───────────────────────────────────────────────────────
function AudioToolbar({ onSpeak, onMic, recState, sttAvailable }) {
  return (
    <div style={S.audioToolbar}>
      <button style={S.speakBtn} onClick={onSpeak} title="Play French pronunciation">🔊</button>
      {sttAvailable && (
        <button
          style={recState === "recording" ? {...S.micBtn, ...S.micBtnActive} : S.micBtn}
          onClick={onMic}
          title={recState === "recording" ? "Stop recording" : "Record yourself speaking"}
        >
          {recState === "recording" ? "⏹" : "🎤"}
        </button>
      )}
    </div>
  );
}

// ─── PRONUNCIATION PANEL ─────────────────────────────────────────────────
function PronunciationPanel({ recState, result, error, referenceText, onCancel, onRetry, onSpeakWord, onDismiss }) {
  if (recState === "recording") {
    return (
      <div style={S.pronPanel}>
        <div style={S.pronRecordingRow}>
          <div style={S.pronRecordingDot} />
          <span>Listening… speak the French clearly</span>
          <button style={S.pronStopBtn} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }
  if (recState === "processing") {
    return (
      <div style={S.pronPanel}>
        <div style={S.pronProcessing}>
          <div style={S.spinner} />
          <span>Analyzing your pronunciation…</span>
        </div>
      </div>
    );
  }
  if (recState === "error") {
    return (
      <div style={S.pronPanel}>
        <div style={S.pronError}>
          <span>✗ {error || "Something went wrong"}</span>
          <div style={{display:"flex", gap:8}}>
            <button style={S.pronRetryBtn} onClick={onRetry}>Try again</button>
            <button style={S.pronDismissBtn} onClick={onDismiss}>Dismiss</button>
          </div>
        </div>
      </div>
    );
  }
  if (recState === "result" && result) {
    return (
      <div style={S.pronPanel}>
        <div style={S.pronHeader}>
          <div style={S.pronScoreBlock}>
            <div style={{...S.pronScoreBig, color: scoreColor(result.pronunciation)}}>
              {result.pronunciation ?? "—"}
            </div>
            <div style={S.pronScoreLabel}>Overall</div>
          </div>
          <div style={S.pronSubScores}>
            <ScoreCell label="Accuracy" value={result.accuracy} />
            <ScoreCell label="Fluency" value={result.fluency} />
            <ScoreCell label="Complete" value={result.completeness} />
          </div>
        </div>
        {result.words && result.words.length > 0 && (
          <div style={S.pronWordRow}>
            {result.words.map((w, i) => (
              <button
                key={i}
                style={{
                  ...S.pronWordChip,
                  background: scoreColor(w.accuracy),
                  opacity: w.errorType === "Omission" ? 0.4 : 1,
                }}
                onClick={() => onSpeakWord(w.word)}
                title={`${w.word} — ${w.accuracy ?? "—"}/100 · tap to hear`}
              >
                {w.word}
              </button>
            ))}
          </div>
        )}
        {result.transcribed && result.transcribed !== referenceText && (
          <div style={S.pronTranscribed}>
            Heard: <em>"{result.transcribed}"</em>
          </div>
        )}
        <div style={S.pronBtnRow}>
          <button style={S.pronRetryBtn} onClick={onRetry}>Try again</button>
          <button style={S.pronDismissBtn} onClick={onDismiss}>Done</button>
        </div>
      </div>
    );
  }
  return null;
}

function ScoreCell({ label, value }) {
  return (
    <div style={S.scoreCell}>
      <div style={{...S.scoreCellNum, color: scoreColor(value)}}>{value ?? "—"}</div>
      <div style={S.scoreCellLabel}>{label}</div>
    </div>
  );
}

const S = {
  container: { maxWidth:760, margin:"0 auto", padding:"24px 16px 64px", fontFamily:T.font.sans, color:T.color.onSurface },
  loading: { textAlign:"center", padding:60, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },

  // ── App shell: sidebar + main ─────────────────────────────────────
  shell: { display:"flex", minHeight:"100vh", background:T.color.background },
  shellNarrow: { display:"flex", flexDirection:"column", minHeight:"100vh", background:T.color.background },
  main: { flex:1, display:"flex", flexDirection:"column", minWidth:0 },
  mainInner: { flex:1, padding:"32px 40px 120px", maxWidth:1100, width:"100%", margin:"0 auto", boxSizing:"border-box" },

  // ── Sidebar ───────────────────────────────────────────────────────
  // Fixed 256px column on desktop. The sticky positioning + 100vh height
  // means the sidebar stays fixed while the main content scrolls.
  sideBar: { width:256, background:T.color.surfaceLow, padding:"40px 0 24px", display:"flex", flexDirection:"column", flexShrink:0, position:"sticky", top:0, height:"100vh", overflowY:"auto", boxSizing:"border-box" },
  sideBarBottom: { position:"fixed", bottom:0, left:0, right:0, background:"rgba(247,243,241,0.95)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", padding:"4px 0", boxShadow:"0 -8px 32px rgba(3,22,50,0.06)", zIndex:30, display:"flex", flexDirection:"column" },
  sideNav: { display:"flex", flexDirection:"column", gap:4, flex:1 },
  sideNavBottom: { display:"flex", flexDirection:"row", justifyContent:"space-around", padding:"4px 0", flex:1 },
  sideItemBottom: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, padding:"10px 8px", border:"none", borderTop:"3px solid transparent", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:9, fontWeight:700, color:"rgba(3,22,50,0.6)", textTransform:"uppercase", letterSpacing:"0.08em" },
  sideItemBottomActive: { color:T.color.secondary, borderTopColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideItem: { display:"flex", alignItems:"center", gap:14, padding:"14px 32px", border:"none", borderRight:"4px solid transparent", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:13, fontWeight:600, color:"rgba(3,22,50,0.6)", textTransform:"uppercase", letterSpacing:"0.1em", textAlign:"left", transition:"all 0.2s" },
  sideItemActive: { color:T.color.secondary, borderRightColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideIcon: { display:"flex", alignItems:"center", flexShrink:0 },
  // ── Sidebar bottom: avatar + email + feedback in one row ────────────
  sideBottom: { padding:"16px 20px 20px", marginTop:"auto", borderTop:"1px solid rgba(3,22,50,0.06)" },
  sideBottomRow: { display:"flex", alignItems:"center", gap:10 },
  sideProfileRow: { position:"relative", flexShrink:0 },
  sideBottomEmail: { flex:1, fontSize:11, color:"rgba(3,22,50,0.45)", fontFamily:T.font.sans, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  profileMenuBottom: { position:"absolute", bottom:"100%", left:0, minWidth:200, marginBottom:8, background:T.color.surfaceLowest, borderRadius:T.radius.lg, boxShadow:"0 -8px 32px rgba(3,22,50,0.12)", padding:"8px 0", zIndex:20, fontFamily:T.font.sans },
  // Legacy styles kept for reference
  sideProfile: { padding:"16px 20px 8px", position:"relative" },
  sideFeedback: { padding:"12px 20px 20px", marginTop:"auto", borderTop:"1px solid rgba(3,22,50,0.06)", display:"flex", flexDirection:"column", gap:10 },
  profileBtn: { display:"flex", alignItems:"center", justifyContent:"center", padding:0, background:"transparent", border:"none", borderRadius:"50%", cursor:"pointer" },
  profileAvatar: { width:32, height:32, borderRadius:"50%", background:T.color.primary, color:T.color.onPrimary, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:600, fontFamily:T.font.sans, flexShrink:0 },
  profileChevron: { marginLeft:"auto", fontSize:12, color:T.color.onSurfaceVariant, opacity:0.5 },
  profileMenu: { position:"absolute", top:"100%", left:16, right:16, background:T.color.surfaceLowest, borderRadius:T.radius.lg, boxShadow:"0 8px 32px rgba(3,22,50,0.12)", padding:"8px 0", zIndex:20, fontFamily:T.font.sans },
  profileMenuEmail: { padding:"10px 16px 6px", fontSize:11, color:T.color.onSurfaceVariant, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", borderBottom:"1px solid rgba(3,22,50,0.06)", marginBottom:4 },
  profileMenuItem: { display:"block", width:"100%", padding:"10px 16px", background:"transparent", border:"none", borderRadius:0, cursor:"pointer", fontSize:12, fontFamily:T.font.sans, fontWeight:500, color:T.color.onSurface, textAlign:"left", transition:"background 0.1s" },
  // ── Sidebar feedback (bottom) ─────────────────────────────────────
  sideFeedback: { padding:"12px 20px 20px", marginTop:"auto", borderTop:"1px solid rgba(3,22,50,0.06)", display:"flex", flexDirection:"column", gap:10 },
  endSessionBtn: { width:"100%", padding:"12px", border:"1px solid rgba(3,22,50,0.1)", borderRadius:T.radius.md, background:"transparent", color:T.color.secondary, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"0.02em", transition:"background 0.15s" },
  // Legacy sidebar footer styles — no longer rendered but kept so the
  // BetaFeedback component (which may reference S.sideFoot) doesn't crash
  sideFoot: { padding:"16px 24px 0", marginTop:"auto", borderTop:"1px solid rgba(3,22,50,0.06)", display:"flex", flexDirection:"column", gap:6, alignItems:"flex-start" },
  sideUtilBtn: { padding:"8px 12px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, textAlign:"left", width:"100%", letterSpacing:"0.02em" },
  sideEmail: { fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, padding:"4px 12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%", opacity:0.7 },

  // ── Sub-toolbar (category filter + counter, below sticky top bar) ─
  subToolbar: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:14, marginBottom:24, flexWrap:"wrap" },
  subToolbarRight: { display:"flex", alignItems:"center", gap:12 },

  // ── Card area: centered with decorative blur shapes ───────────────
  cardArea: { position:"relative", display:"flex", flexDirection:"column", alignItems:"center", paddingTop:24 },
  blurTL: { position:"absolute", top:-60, left:-60, width:360, height:360, background:"rgba(3,22,50,0.04)", borderRadius:"50%", filter:"blur(60px)", pointerEvents:"none", zIndex:0 },
  blurBR: { position:"absolute", bottom:60, right:-60, width:360, height:360, background:"rgba(156,66,52,0.05)", borderRadius:"50%", filter:"blur(60px)", pointerEvents:"none", zIndex:0 },

  // ── Card content (eyebrow, hint, audio circles, hover actions) ────
  cardEyebrow: { position:"absolute", top:30, left:"50%", transform:"translateX(-50%)", fontSize:10, fontFamily:T.font.sans, fontWeight:700, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.18em", display:"flex", alignItems:"center", gap:8, whiteSpace:"nowrap" },
  cardHint: { position:"absolute", bottom:18, left:"50%", transform:"translateX(-50%)", fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontStyle:"italic", opacity:0.45 },
  cardAudio: { display:"flex", gap:14, marginTop:28, justifyContent:"center" },
  cardAudioBtn: { width:52, height:52, display:"flex", alignItems:"center", justifyContent:"center", border:"none", borderRadius:"50%", background:T.color.surfaceLow, cursor:"pointer", fontSize:20, color:T.color.primary, transition:"all 0.15s" },
  cardAudioMic: { background:T.color.surfaceLow, color:T.color.secondary },
  cardAudioMicActive: { background:T.color.secondary, color:T.color.onSecondary, animation:"pulse 1.2s infinite" },
  cardActionsFloat: { position:"absolute", top:18, right:18, display:"flex", gap:6 },

  // ── Big icon-button actions: AGAIN / GOT IT ───────────────────────
  // The button itself is a borderless flex column. The colored 80×80
  // box wraps the SVG, and the uppercase label sits below it.
  // ── Rectangular action buttons: AGAIN / GOT IT ─────────────────────
  actionRow: { display:"flex", gap:16, justifyContent:"center", marginTop:8, marginBottom:24, width:"100%", maxWidth:480, alignSelf:"center" },
  actionAgainRect: { flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"20px 28px", border:"1px solid rgba(3,22,50,0.1)", borderRadius:T.radius.md, background:"transparent", color:T.color.onSurfaceVariant, fontSize:16, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"-0.01em", transition:"all 0.15s" },
  actionGotRect: { flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"20px 28px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:16, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"-0.01em", boxShadow:"0 8px 24px rgba(3,22,50,0.15)", transition:"all 0.15s" },

  // ── Info tooltip (ⓘ keyboard shortcuts) ───────────────────────────
  infoWrap: { position:"absolute", bottom:14, right:18, zIndex:5 },
  infoBtn: { width:22, height:22, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:12, color:T.color.onSurfaceVariant, opacity:0.25, transition:"opacity 0.15s", userSelect:"none" },
  infoTip: { position:"absolute", bottom:30, right:0, background:T.color.surfaceLow, color:T.color.onSurfaceVariant, padding:"12px 16px", borderRadius:T.radius.lg, fontSize:11, fontFamily:T.font.sans, lineHeight:1.8, whiteSpace:"nowrap", boxShadow:"0 4px 16px rgba(3,22,50,0.08)", zIndex:10 },

  // Legacy action styles (kept for reference, no longer rendered)
  actionBtn: { display:"flex", flexDirection:"column", alignItems:"center", gap:12, background:"transparent", border:"none", cursor:"pointer", padding:0, fontFamily:T.font.sans },
  actionBoxAgain: { width:80, height:80, borderRadius:T.radius.lg, background:T.color.surfaceHigh, color:T.color.primary, display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.2s" },
  actionBoxGot: { width:80, height:80, borderRadius:T.radius.lg, background:T.color.secondary, color:T.color.onSecondary, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 24px rgba(156,66,52,0.25)", transition:"all 0.2s" },
  actionLabel: { fontSize:11, fontWeight:800, letterSpacing:"0.18em", color:T.color.onSurfaceVariant, textTransform:"uppercase" },

  // Top utility bar — single horizontal row at the top of the page with
  // upload, beta feedback, email and sign-out. Replaces the old vertically
  // stacked header userInfo block.
  // Sticky glass-blur top app bar — direction toggle, type/auto-speak chips
  topBar: { position:"sticky", top:0, zIndex:20, display:"flex", alignItems:"center", gap:12, padding:"16px 40px", background:"rgba(253,248,246,0.92)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", borderBottom:"1px solid rgba(3,22,50,0.06)", flexWrap:"wrap" },
  topBarSpacer: { flex:1 },
  topBarBtn: { padding:"6px 12px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.02em" },
  topBarEmail: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  // Session ribbon — small uppercase metadata line beneath the navbar,
  // replacing the old "8 cards · 0 seen · 0 ✓ · 0 ✗" subtitle.
  sessionRibbon: { display:"flex", alignItems:"center", gap:8, fontSize:10, fontFamily:T.font.sans, fontWeight:600, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.12em", margin:"4px 2px 18px" },
  ribbonDot: { opacity:0.4 },
  // Legacy header styles kept for screens that still reference them
  // (onboarding, feedback admin view). Study view no longer uses these.
  header: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18, gap:12, flexWrap:"wrap" },
  title: { fontSize:30, fontWeight:600, margin:"0 0 4px", color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.02em", lineHeight:1.1 },
  sub: { fontSize:13, color:T.color.onSurfaceVariant, margin:"4px 0 0", fontFamily:T.font.sans },
  userInfo: { display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6, fontFamily:T.font.sans },
  userEmail: { fontSize:11, color:T.color.onSurfaceVariant },
  signOutBtn: { padding:"5px 12px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:500 },
  nav: { display:"flex", gap:6, marginBottom:18, padding:4, background:T.color.surfaceLow, borderRadius:T.radius.lg, width:"fit-content" },
  navBtn: { padding:"9px 18px", border:"none", borderRadius:T.radius.md, background:"transparent", cursor:"pointer", fontSize:13, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500, transition:"all 0.15s" },
  navActive: { background:T.color.surfaceLowest, color:T.color.primary, fontWeight:600, boxShadow:T.shadow.focus },
  filters: { marginBottom:18 },
  catRow: { display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 },
  catBtn: { padding:"6px 14px", border:"none", borderRadius:T.radius.full, background:T.color.surfaceLow, cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500, letterSpacing:"0.02em" },
  catBtnA: { background:T.color.primary, color:T.color.onPrimary, fontWeight:600 },
  toggleRow: { display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" },
  toggle: { display:"flex", gap:6, alignItems:"center", fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, cursor:"pointer" },
  // Chip-style toggle button — used in the study filter row in place of
  // raw checkboxes. Same pill shape as catBtn but with an active state.
  chipToggle: { padding:"6px 13px", border:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.08)"}`, borderRadius:T.radius.full, background:"transparent", cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500, letterSpacing:"0.02em", transition:"all 0.15s" },
  chipToggleA: { background:T.color.primary, color:T.color.onPrimary, borderColor:T.color.primary, fontWeight:600 },
  dirGroup: { display:"flex", gap:2, marginLeft:"auto", padding:3, background:T.color.surfaceLow, borderRadius:T.radius.md },
  dirBtn: { padding:"5px 12px", border:"none", borderRadius:T.radius.sm, background:"transparent", cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500 },
  dirBtnA: { background:T.color.surfaceLowest, color:T.color.primary, fontWeight:600, boxShadow:T.shadow.focus },
  counterRow: { display:"flex", alignItems:"center", gap:8, marginBottom:10 },
  counter: { textAlign:"center", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, letterSpacing:"0.05em", textTransform:"uppercase", fontWeight:500 },
  backBtn: { padding:"6px 14px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:500 },
  backBtnDisabled: { padding:"6px 14px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"default", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:500, opacity:0.3 },
  backBtnSpacer: { width:60 },
  cardWrap: { perspective:1200, marginBottom:48, width:"100%", maxWidth:680, position:"relative", zIndex:1 },
  card: { position:"relative", transformStyle:"preserve-3d", transition:"transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)", aspectRatio:"1.6 / 1", minHeight:340 },
  cardFront: { backfaceVisibility:"hidden", position:"absolute", inset:0, background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, padding:"56px 36px", display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:"0 8px 32px rgba(3,22,50,0.08)", overflow:"hidden" },
  cardBack: { backfaceVisibility:"hidden", position:"absolute", inset:0, transform:"rotateY(180deg)", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, padding:"56px 36px", display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:"0 8px 32px rgba(3,22,50,0.08)", overflow:"hidden", borderTop:`3px solid ${T.color.secondary}` },
  cardCat: { position:"absolute", top:14, left:18, display:"flex", alignItems:"center", gap:7, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:600 },
  langBadge: { position:"absolute", top:14, right:18, fontSize:9, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, background:T.color.surfaceHigh, padding:"3px 9px", borderRadius:T.radius.full, letterSpacing:"0.08em", fontWeight:600, textTransform:"uppercase" },
  freqTag: { marginLeft:6, background:T.color.secondaryContainer, color:T.color.onSecondaryContainer, padding:"2px 7px", borderRadius:T.radius.full, fontSize:10, fontWeight:700 },
  dot: { width:7, height:7, borderRadius:"50%" },
  cardText: { fontSize:48, textAlign:"center", fontWeight:700, color:T.color.primary, lineHeight:1.15, padding:"0 12px", fontFamily:T.font.serif, letterSpacing:"-0.025em" },
  cardTextB: { fontSize:36, textAlign:"center", fontWeight:600, color:T.color.primary, lineHeight:1.25, padding:"0 12px", fontFamily:T.font.serif, letterSpacing:"-0.015em" },
  dateH: { position:"absolute", bottom:12, right:18, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, opacity:0.7 },
  hint: { position:"absolute", bottom:12, left:18, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontStyle:"italic", opacity:0.7 },
  btnRow: { display:"flex", gap:12, marginBottom:12 },
  btnWrong: { flex:1, padding:"15px", border:"none", borderRadius:T.radius.md, background:T.color.secondary, color:T.color.onSecondary, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow:T.shadow.button, letterSpacing:"0.01em" },
  btnRight: { flex:1, padding:"15px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow:T.shadow.button, letterSpacing:"0.01em" },
  shortcuts: { textAlign:"center", fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, opacity:0.7, letterSpacing:"0.03em" },
  empty: { textAlign:"center", padding:60, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  sessionDone: { textAlign:"center", padding:24, background:T.color.surfaceLow, borderRadius:T.radius.xl, marginTop:12 },
  doneText: { fontSize:14, color:T.color.primary, fontFamily:T.font.sans, marginBottom:14, fontWeight:500 },
  resetSBtn: { padding:"11px 26px", border:"none", borderRadius:T.radius.md, background:T.color.surfaceLowest, color:T.color.primary, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, boxShadow:T.shadow.focus },
  // Stats — bento dashboard
  statsHeading: { fontSize:36, fontWeight:600, color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.02em", margin:"8px 0 28px" },
  // ── New stats layout: metric cards + pipeline + hardest ───────────
  statsRow3: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 },
  statsRow2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 },
  metricCard: { background:T.color.surfaceLow, borderRadius:T.radius.xl, padding:"22px 24px" },
  metricLabel: { fontSize:11, fontFamily:T.font.sans, fontWeight:600, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.04em", marginBottom:6 },
  metricVal: { fontSize:32, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary, lineHeight:1.1 },
  metricSub: { fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, marginTop:4 },
  statsNote: { fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, opacity:0.5, marginBottom:16, paddingLeft:2 },
  streakCard: { background:"#1a2b48", borderRadius:T.radius.xl, padding:"22px 24px", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center" },
  streakNum: { fontSize:32, fontFamily:T.font.serif, fontWeight:600, color:"#fdf8f6", lineHeight:1.1, margin:"4px 0 4px" },
  streakSub: { fontSize:10, fontFamily:T.font.sans, fontWeight:600, color:"rgba(253,248,246,0.5)", textTransform:"uppercase", letterSpacing:"0.1em" },
  // Pipeline
  pipelineCard: { background:T.color.surfaceLowest, border:`0.5px solid ${T.color.outlineGhost || "rgba(3,22,50,0.08)"}`, borderRadius:T.radius.xl, padding:"22px 24px", marginBottom:12 },
  pipeTitle: { fontSize:14, fontFamily:T.font.sans, fontWeight:600, color:T.color.primary, marginBottom:14 },
  pipeBarWrap: { display:"flex", height:28, borderRadius:6, overflow:"hidden", background:T.color.surfaceHigh, marginBottom:10 },
  pipeSeg: { display:"flex", alignItems:"center", justifyContent:"center", fontFamily:T.font.sans },
  pipeLegend: { display:"flex", gap:20 },
  pipeLegItem: { display:"flex", alignItems:"center", gap:6, fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant },
  pipeDot: { width:8, height:8, borderRadius:"50%", flexShrink:0 },
  // Section titles
  statsSectionTitle: { fontSize:18, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary, margin:"0 0 4px" },
  statsSectionSub: { fontSize:13, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, margin:"0 0 14px" },
  // Hardest cards
  hardGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:14 },
  hardCard: { background:T.color.surfaceLow, borderRadius:T.radius.xl, padding:"18px 20px", display:"flex", flexDirection:"column", gap:8, transition:"background 0.15s", cursor:"default" },
  hardHead: { display:"flex", justifyContent:"space-between", alignItems:"flex-start" },
  hardTag: { fontSize:9, fontFamily:T.font.sans, fontWeight:700, padding:"3px 8px", borderRadius:T.radius.sm, textTransform:"uppercase", letterSpacing:"0.08em" },
  hardWord: { fontSize:18, fontFamily:T.font.serif, fontStyle:"italic", color:T.color.primary, margin:"4px 0 0", letterSpacing:"-0.01em", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  hardMeta: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, margin:0 },
  resetBtn: { display:"block", width:"100%", padding:"13px", border:"none", borderRadius:T.radius.md, background:"transparent", color:T.color.secondary, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, marginTop:24 },
  // Legacy stats styles (kept to avoid crashes if any references remain)
  bento: { display:"grid", gridTemplateColumns:"repeat(12, minmax(0, 1fr))", gap:24, marginBottom:32 },
  bentoNarrow: { display:"flex", flexDirection:"column", gap:18, marginBottom:32 },
  bentoCard: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"28px 30px", boxShadow:T.shadow.card, border:"none" },
  bentoTitle: { fontSize:20, fontWeight:600, color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.01em", margin:"0 0 4px" },
  bentoSub: { fontSize:13, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, margin:"0 0 18px" },
  bentoHead: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 },
  bentoStreak: { background:"#1a2b48" },
  // ── Onboarding (empty deck state) ─────────────────────────────────
  // Full-bleed page (no sidebar) with hero on top and import method
  // bento below. Sign-out lives in a small top-right cluster.
  onbPage: { minHeight:"100vh", background:T.color.background, position:"relative", overflow:"hidden" },
  onbTopBar: { position:"absolute", top:24, right:32, display:"flex", alignItems:"center", gap:14, zIndex:10 },
  onbTopEmail: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, opacity:0.7 },
  onbTopSignOut: { padding:"6px 14px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.02em" },
  onbInner: { maxWidth:1100, margin:"0 auto", padding:"96px 40px 80px", boxSizing:"border-box" },
  onbHero: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:64, alignItems:"center", marginBottom:88 },
  onbHeroLeft: { display:"flex", flexDirection:"column", gap:24 },
  onbHeroTitle: { fontSize:64, fontWeight:700, color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.03em", lineHeight:1.05, margin:0 },
  onbHeroText: { fontSize:17, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, lineHeight:1.6, maxWidth:440, margin:0 },
  onbHeroCta: { display:"inline-flex", alignItems:"center", gap:10, padding:"16px 28px", background:T.gradient.ink, color:T.color.onPrimary, border:"none", borderRadius:T.radius.lg, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, boxShadow:"0 8px 32px rgba(3,22,50,0.16)", letterSpacing:"0.02em", alignSelf:"flex-start", marginTop:8 },
  // Right side: stack of 3 typographic sample card previews (no photos)
  onbHeroRight: { position:"relative", height:420 },
  onbSample: { position:"absolute", width:300, padding:"24px 28px", background:T.color.surfaceLowest, borderRadius:T.radius.xl, boxShadow:"0 16px 48px rgba(3,22,50,0.08)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", minHeight:140 },
  onbSample1: { top:0, left:20, transform:"rotate(-3deg)", borderTop:`3px solid ${T.color.secondary}` },
  onbSample2: { top:130, left:90, transform:"rotate(2deg)", borderTop:"3px solid #76261b", zIndex:2 },
  onbSample3: { top:260, left:30, transform:"rotate(-1deg)", borderTop:"3px solid #1a2b48" },
  onbSampleEyebrow: { fontSize:9, fontFamily:T.font.sans, fontWeight:700, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.18em", marginBottom:10 },
  onbSampleWord: { fontSize:24, fontFamily:T.font.serif, fontWeight:700, color:T.color.primary, letterSpacing:"-0.015em", lineHeight:1.2 },
  onbSampleEn: { fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, marginTop:8, fontStyle:"italic" },

  // ── Import methods bento (3 cards) ────────────────────────────────
  onbBento: { display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:20, marginBottom:32 },
  onbCard: { display:"flex", flexDirection:"column", gap:16, padding:"32px 28px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, boxShadow:"0 8px 32px rgba(3,22,50,0.06)", textAlign:"left", cursor:"pointer", fontFamily:T.font.sans, transition:"all 0.2s", color:T.color.onSurface, position:"relative" },
  onbCardFeatured: { background:T.color.surfaceHigh },
  onbCardIcon: { width:48, height:48, borderRadius:T.radius.lg, background:T.color.surfaceHigh, display:"flex", alignItems:"center", justifyContent:"center", color:T.color.secondary },
  onbCardIconFeatured: { background:T.color.primary, color:T.color.onPrimary },
  onbCardTitle: { fontSize:22, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary, margin:"4px 0 0", letterSpacing:"-0.015em" },
  onbCardDesc: { fontSize:13, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, lineHeight:1.55, margin:0 },
  onbCardArrow: { marginTop:"auto", alignSelf:"flex-end", fontSize:18, color:T.color.onSurfaceVariant, fontWeight:700 },

  // Admin seed deck button — small text link below the bento
  onbAdmin: { marginTop:24, textAlign:"center" },
  onbAdminBtn: { padding:"10px 20px", background:"transparent", border:"none", color:T.color.onSurfaceVariant, fontSize:11, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.05em", textTransform:"uppercase", textDecoration:"underline" },

  // Legacy onboarding styles kept as fallbacks
  onboarding: { maxWidth:520, margin:"60px auto", padding:"48px 36px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, textAlign:"center", boxShadow:T.shadow.card },
  onbTitle: { margin:"0 0 14px", fontSize:32, color:T.color.primary, fontFamily:T.font.serif, fontWeight:600, letterSpacing:"-0.02em" },
  onbPrimary: { padding:"15px 32px", background:T.gradient.ink, color:T.color.onPrimary, border:"none", borderRadius:T.radius.md, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, boxShadow:T.shadow.button, letterSpacing:"0.02em" },
  onbSecondary: { padding:"12px 24px", background:"transparent", color:T.color.onSurfaceVariant, border:"none", borderRadius:T.radius.md, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:500 },
  onbDivider: { fontSize:10, color:T.color.onSurfaceVariant, margin:"20px 0", textTransform:"uppercase", letterSpacing:"0.2em", fontWeight:600 },
  onbError: { marginTop:14, padding:12, background:T.color.errorContainer, color:T.color.onErrorContainer, borderRadius:T.radius.lg, fontSize:13 },
  // Header buttons (Upload + Feedback above email)
  headerBtnRow: { display:"flex", gap:6, marginBottom:6, justifyContent:"flex-end" },
  headerBtn: { padding:"6px 12px", background:T.color.surfaceHigh, border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:12, color:T.color.primary, fontFamily:T.font.sans, fontWeight:500 },
  // Per-card action buttons (edit / flag)
  cardActions: { display:"flex", gap:10, justifyContent:"center", marginTop:18 },
  cardActionBtn: { background:T.color.surfaceLow, border:"none", borderRadius:T.radius.full, padding:"6px 14px", fontSize:11, cursor:"pointer", color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.02em" },
  cardActionBtnFlagged: { background:T.color.tertiaryFixed, color:T.color.onSecondaryContainer, cursor:"default", fontWeight:700 },
  // Type mode (study input)
  typeInputRow: { display:"flex", gap:10, justifyContent:"center", marginBottom:10 },
  giveUpRow: { display:"flex", justifyContent:"center", marginBottom:14 },
  giveUpBtn: { padding:"6px 14px", background:"transparent", border:"none", cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.02em", textDecoration:"underline" },
  typeInput: { flex:1, maxWidth:300, padding:"13px 16px", border:"none", background:T.color.surfaceLowest, borderRadius:T.radius.lg, fontSize:16, fontFamily:T.font.serif, outline:"none", color:T.color.primary, boxShadow:T.shadow.focus },
  typeSubmit: { padding:"13px 26px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, boxShadow:T.shadow.button, letterSpacing:"0.01em" },
  // Audio: speak/mic toolbar inside the card
  audioToolbar: { marginTop:14, display:"flex", gap:10, justifyContent:"center" },
  speakBtn: { background:T.color.surfaceHigh, border:"none", borderRadius:T.radius.full, padding:"8px 16px", fontSize:16, cursor:"pointer", lineHeight:1, color:T.color.primary },
  micBtn: { background:T.color.surfaceHigh, border:"none", borderRadius:T.radius.full, padding:"8px 16px", fontSize:16, cursor:"pointer", lineHeight:1, color:T.color.primary, transition:"all 0.15s" },
  micBtnActive: { background:T.color.secondary, color:T.color.onSecondary, animation:"pulse 1.2s infinite" },
  // Pronunciation result panel below the card
  pronPanel: { marginTop:16, marginBottom:16, padding:"20px 22px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, fontFamily:T.font.sans, boxShadow:T.shadow.card },
  pronRecordingRow: { display:"flex", alignItems:"center", gap:14, fontSize:14, color:T.color.secondary, fontWeight:500 },
  pronRecordingDot: { width:14, height:14, borderRadius:"50%", background:T.color.secondary, animation:"pulse 1s infinite", flexShrink:0 },
  pronStopBtn: { marginLeft:"auto", background:T.color.secondary, color:T.color.onSecondary, border:"none", borderRadius:T.radius.md, padding:"7px 16px", fontSize:12, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600 },
  pronProcessing: { display:"flex", alignItems:"center", gap:14, color:T.color.onSurfaceVariant, fontSize:14 },
  spinner: { width:18, height:18, border:`2px solid ${T.color.surfaceHigh}`, borderTopColor:T.color.secondary, borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  pronError: { display:"flex", flexDirection:"column", gap:14, color:T.color.secondary, fontSize:13 },
  pronHeader: { display:"flex", alignItems:"center", gap:24, marginBottom:18 },
  pronScoreBlock: { display:"flex", flexDirection:"column", alignItems:"center", minWidth:72 },
  pronScoreBig: { fontSize:48, fontWeight:700, lineHeight:1, fontFamily:T.font.serif, letterSpacing:"-0.03em" },
  pronScoreLabel: { fontSize:9, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.15em", marginTop:4, fontWeight:600 },
  pronSubScores: { display:"flex", gap:18, flex:1, flexWrap:"wrap" },
  scoreCell: { display:"flex", flexDirection:"column", alignItems:"center", minWidth:56 },
  scoreCellNum: { fontSize:24, fontWeight:700, fontFamily:T.font.serif, lineHeight:1, letterSpacing:"-0.02em" },
  scoreCellLabel: { fontSize:9, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.12em", marginTop:4, fontWeight:600 },
  pronWordRow: { display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 },
  pronWordChip: { color:T.color.onPrimary, border:"none", borderRadius:T.radius.md, padding:"7px 14px", fontSize:14, cursor:"pointer", fontFamily:T.font.serif },
  pronTranscribed: { fontSize:12, color:T.color.onSurfaceVariant, marginBottom:14, fontStyle:"italic" },
  pronBtnRow: { display:"flex", gap:10 },
  pronRetryBtn: { padding:"9px 20px", background:T.color.surfaceHigh, border:"none", color:T.color.primary, borderRadius:T.radius.md, cursor:"pointer", fontSize:13, fontFamily:T.font.sans, fontWeight:600 },
  pronDismissBtn: { padding:"9px 20px", background:"transparent", border:"none", color:T.color.onSurfaceVariant, borderRadius:T.radius.md, cursor:"pointer", fontSize:13, fontFamily:T.font.sans, fontWeight:500 },
  // Typing feedback
  typeFeedback: { marginBottom:12, width:"100%", maxWidth:520, alignSelf:"center" },
  typeCorrect: { textAlign:"center", padding:14, background:T.color.tertiaryFixed, color:T.color.onSecondaryContainer, borderRadius:T.radius.lg, fontSize:15, fontWeight:600, marginBottom:12, fontFamily:T.font.sans },
  typeClose: { textAlign:"center", padding:14, background:T.color.surfaceHigh, color:T.color.primary, borderRadius:T.radius.lg, fontSize:14, fontWeight:500, marginBottom:12, fontFamily:T.font.sans },
  typeRevealed: { textAlign:"center", padding:14, background:T.color.surfaceHigh, color:T.color.primary, borderRadius:T.radius.lg, fontSize:14, fontWeight:500, marginBottom:12, fontFamily:T.font.sans },
  typeWrong: { textAlign:"center", padding:14, background:T.color.errorContainer, color:T.color.onErrorContainer, borderRadius:T.radius.lg, fontSize:14, fontWeight:500, marginBottom:12, fontFamily:T.font.sans },
  typeBtnRow: { display:"flex", gap:12, marginTop:8 },
  feedbackRow: { textAlign:"center", marginBottom:10, fontFamily:T.font.sans, fontSize:12 },
  feedbackBtn: { padding:"7px 16px", background:"transparent", border:"none", color:T.color.secondary, borderRadius:T.radius.md, fontSize:12, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, textDecoration:"underline" },
  feedbackPending: { color:T.color.onSurfaceVariant },
  feedbackOk: { color:T.color.primary, fontWeight:500 },
  feedbackAccept: { color:"#1d9e75", fontWeight:600, fontSize:12, fontFamily:T.font.sans },
  feedbackReject: { color:T.color.secondary, fontWeight:500, fontSize:12, fontFamily:T.font.sans },
  feedbackMsg: { textAlign:"center", fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, lineHeight:1.5, maxWidth:480, margin:"0 auto" },
  feedbackReasoning: { padding:"10px 16px", background:T.color.surfaceLow, borderRadius:T.radius.lg, marginBottom:8, fontSize:12, lineHeight:1.5 },
  feedbackOverrideBtn: { padding:"6px 14px", background:"transparent", border:"1px solid rgba(3,22,50,0.15)", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, fontWeight:600, fontFamily:T.font.sans, color:T.color.primary, letterSpacing:"0.02em" },
  feedbackErr: { color:T.color.secondary, fontWeight:500 },
  // Type-mode advance row (replaces Again/Got It). The matcher's verdict
  // auto-commits; this row just holds the Continue button plus an optional
  // "mark for review" override link when the matcher accepted the answer.
  typeAdvanceRow: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, marginTop:8, marginBottom:24, width:"100%", maxWidth:480, alignSelf:"center" },
  markReviewLink: { padding:"6px 2px", background:"transparent", border:"none", color:T.color.onSurfaceVariant, fontSize:12, cursor:"pointer", fontFamily:T.font.sans, fontWeight:500, textDecoration:"underline", textUnderlineOffset:3, opacity:0.75, letterSpacing:"0.01em" },
  continueBtn: { marginLeft:"auto", display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"14px 32px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"-0.01em", boxShadow:"0 6px 20px rgba(3,22,50,0.14)", transition:"all 0.15s" },
  // Feedback admin view
  feedbackList: { display:"flex", flexDirection:"column", gap:18 },
  feedbackItem: { padding:22, background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, fontFamily:T.font.sans, boxShadow:T.shadow.card },
  feedbackCard: { marginBottom:14 },
  feedbackCardHeader: { display:"flex", justifyContent:"space-between", fontSize:11, color:T.color.onSurfaceVariant, marginBottom:8 },
  feedbackDir: { background:T.color.surfaceHigh, padding:"3px 10px", borderRadius:T.radius.full, fontWeight:600, letterSpacing:"0.05em" },
  feedbackDate: {},
  feedbackPrompt: { fontSize:22, fontFamily:T.font.serif, color:T.color.primary, fontStyle:"italic", letterSpacing:"-0.01em" },
  feedbackAnswers: { display:"flex", flexDirection:"column", gap:8, marginBottom:14, padding:"14px 16px", background:T.color.surfaceLow, borderRadius:T.radius.lg },
  feedbackAnsRow: { display:"flex", gap:12, fontSize:13 },
  feedbackAnsLabel: { color:T.color.onSurfaceVariant, minWidth:80, fontWeight:600, textTransform:"uppercase", fontSize:10, letterSpacing:"0.05em", marginTop:3 },
  feedbackExpected: { color:T.color.primary, fontWeight:600 },
  feedbackUser: { color:T.color.onSurface },
  llmBlock: { padding:"14px 16px", background:T.color.surfaceLow, borderRadius:T.radius.lg, marginBottom:14, fontSize:12 },
  llmHead: { display:"flex", gap:12, alignItems:"center", marginBottom:8 },
  llmAccept: { color:T.color.primary, fontWeight:700, textTransform:"uppercase", fontSize:10, letterSpacing:"0.1em" },
  llmReject: { color:T.color.secondary, fontWeight:700, textTransform:"uppercase", fontSize:10, letterSpacing:"0.1em" },
  llmUnclear: { color:T.color.onSurfaceVariant, fontWeight:700, textTransform:"uppercase", fontSize:10, letterSpacing:"0.1em" },
  llmConf: { color:T.color.onSurfaceVariant, fontSize:11 },
  llmReasoning: { color:T.color.onSurface, lineHeight:1.5 },
  feedbackActions: { display:"flex", gap:10 },
  feedbackApprove: { flex:1, padding:12, background:T.gradient.ink, color:T.color.onPrimary, border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:13, fontWeight:600, fontFamily:T.font.sans, boxShadow:T.shadow.button },
  feedbackReject: { flex:1, padding:12, background:T.color.surfaceHigh, border:"none", color:T.color.onSurfaceVariant, borderRadius:T.radius.md, cursor:"pointer", fontSize:13, fontFamily:T.font.sans, fontWeight:500 },
  // Beta feedback (general user feedback)
  betaFeedbackItem: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"20px 24px", marginBottom:12, boxShadow:T.shadow.card },
  betaFeedbackHeader: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 },
  betaFeedbackEmail: { fontSize:12, fontFamily:T.font.sans, fontWeight:600, color:T.color.primary },
  betaFeedbackMsg: { fontSize:14, fontFamily:T.font.sans, color:T.color.onSurface, lineHeight:1.6, marginBottom:12 },
  betaFeedbackImg: { maxWidth:"100%", maxHeight:300, borderRadius:T.radius.lg, marginBottom:12, objectFit:"contain" },
  betaFeedbackDel: { padding:"6px 14px", background:"transparent", border:"1px solid rgba(3,22,50,0.1)", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, fontFamily:T.font.sans, fontWeight:500, color:T.color.onSurfaceVariant },
  // Feedback review modal
  feedbackModalOverlay: { position:"fixed", inset:0, background:"rgba(3,22,50,0.4)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 },
  feedbackModalBox: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, maxWidth:600, width:"100%", padding:"32px 36px", boxShadow:"0 32px 96px rgba(3,22,50,0.18)", fontFamily:T.font.sans, maxHeight:"80vh", overflow:"hidden", display:"flex", flexDirection:"column" },
  fbItem: { background:T.color.surfaceLow, borderRadius:T.radius.lg, padding:"16px 20px" },
  fbItemHeader: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 },
  fbItemEmail: { fontSize:12, fontWeight:600, color:T.color.primary, fontFamily:T.font.sans },
  fbItemDate: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  fbItemMsg: { fontSize:14, fontFamily:T.font.sans, color:T.color.onSurface, lineHeight:1.6, marginBottom:10 },
  fbItemImg: { maxWidth:"100%", maxHeight:240, borderRadius:T.radius.md, marginBottom:10, objectFit:"contain" },
  fbItemDismiss: { padding:"5px 12px", background:"transparent", border:"1px solid rgba(3,22,50,0.1)", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, fontFamily:T.font.sans, fontWeight:500, color:T.color.onSurfaceVariant },
  // Users table
  usersTable: { width:"100%", borderCollapse:"collapse", fontFamily:T.font.sans, fontSize:13 },
  usersTh: { textAlign:"left", padding:"10px 12px", fontSize:10, fontWeight:700, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.08em", borderBottom:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.08)"}` },
  usersTd: { padding:"10px 12px", borderBottom:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.04)"}`, color:T.color.onSurface },
  usersTdNum: { padding:"10px 12px", borderBottom:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.04)"}`, color:T.color.primary, fontWeight:600, textAlign:"center" },
};

