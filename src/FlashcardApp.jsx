import { useState, useEffect, useCallback, useRef } from "react";
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
    // Split on / , ; | to get individual acceptable answers
    for (const alt of src.split(/[\/,;|]/)) {
      const trimmed = alt.trim();
      if (trimmed) alternatives.push(trimmed);
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
    // Token-set overlap (for multi-word phrases, ignoring order)
    const tTokens = new Set(tRest.split(/\s+/).filter(x => x.length >= 2));
    const aTokens = new Set(aRest.split(/\s+/).filter(x => x.length >= 2));
    if (tTokens.size >= 2 && aTokens.size >= 2) {
      let shared = 0;
      for (const tok of tTokens) if (aTokens.has(tok)) shared++;
      const ratio = shared / Math.max(tTokens.size, aTokens.size);
      if (ratio >= 0.8) return { match: true, close: true };
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

  // Build flashcard deck - only rebuilds when filters/mode change, NOT on every answer
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
    setIdx(0);
    setFlipped(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, freqOnly, mode, loaded, dir, userCards]);

  const card = deck[idx];
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

  // Auto-focus study input when entering type mode or advancing cards.
  // When a type result is shown, blur focus so keyboard shortcuts (Space,
  // arrows) reach the window handler instead of being captured by buttons.
  useEffect(() => {
    if (typeMode && mode === "study") {
      if (!typeResult) {
        setTimeout(() => studyInputRef.current?.focus(), 50);
      } else {
        // Result is showing — blur any focused button so Space/arrows
        // go to the window keydown handler, not the button
        if (document.activeElement && document.activeElement.tagName === "BUTTON") {
          document.activeElement.blur();
        }
      }
    }
  }, [typeMode, idx, typeResult, mode]);

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
  const answer = async (got) => {
    if (!card) return;
    const prev = progress[card.id] || { score:0, seen:0, got:0 };
    const newProg = {
      score: Math.max(0, Math.min(5, prev.score + (got?1:-1))),
      seen: prev.seen + 1,
      got: prev.got + (got?1:0),
    };
    await updateCard(card.id, newProg);
    setStats(s => ({ seen: s.seen+1, got: s.got+(got?1:0), missed: s.missed+(got?0:1) }));
    // Skip the un-flip animation — snap instantly to the next card's front
    skipFlipAnim.current = true;
    setFlipped(false);
    setTypeResult(null);
    setTypedAnswer("");
    setFeedbackState(null);
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
      // Auto-advance after a moment
      autoAdvanceTimer.current = setTimeout(() => answer(true), 1200);
    } else if (result.wrongArticle) {
      setTypeResult("wrongArticle");
      setFlipped(true);
    } else {
      setTypeResult("wrong");
      setFlipped(true);
    }
  };

  // Give up: reveal the answer without typing, count as wrong. Used when
  // the user can't recall the word and wants to see it instead of guessing.
  const giveUpTyped = () => {
    if (!card) return;
    setTypeResult("wrong");
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
    setFeedbackState(null);
    requestAnimationFrame(() => { skipFlipAnim.current = false; });
  };

  const resetSession = () => {
    setIdx(0);
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0 });
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null);
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
    if (mode !== "study") return;
    const handler = (e) => {
      if (!card) return;
      // Don't intercept keys when user is typing in an input/textarea
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); flipRef.current(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); answerRef.current(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); answerRef.current(true); }
      else if (e.key === "Escape") { e.preventDefault(); giveUpRef.current(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [card, mode]);

  // Submit a feedback claim: "my answer should have been accepted"
  const submitFeedback = async () => {
    if (!card || !typedAnswer.trim()) return;
    setFeedbackState("submitting");
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
      if (!res.ok) {
        setFeedbackState("error");
        return;
      }
      setFeedbackState("submitted");
    } catch (e) {
      console.error("Feedback failed:", e);
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
  const saveCardEdit = async (rowId, newFront, newBack) => {
    const { error } = await supabase
      .from("user_cards")
      .update({ front: newFront.trim(), back: newBack.trim(), flagged_for_review: false })
      .eq("id", rowId);
    if (error) {
      console.error("Card update failed:", error);
      return false;
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
  if (userCards.length === 0 && mode !== "feedback") {
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
  if (isAdmin) navItems.push(["feedback", "Feedback"]);
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
              onClick={() => { setMode(m); resetSession(); }}
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
                  <button style={S.profileMenuItem} onClick={onSignOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
            <span style={S.sideBottomEmail}>{user.email}</span>
            <BetaFeedback user={user} currentPage={mode} />
          </div>
        </div>
      )}
    </aside>
  );

  // ── STATS VIEW ──────────────────────────────────────────────────────
  if (mode === "stats") {
    const total = userCards.length;
    const learned = userCards.filter(c => (progress[c.id]?.score??0) >= 3).length;
    const inProg = userCards.filter(c => { const s=progress[c.id]?.score??0; return s>0&&s<3; }).length;
    const newCount = total - learned - inProg;
    const masteryPct = total > 0 ? Math.round((learned/total)*100) : 0;

    // Per-category totals (two groups: Vocabulary vs Phrases)
    const byTab = { vocab: {total:0, learned:0}, phrases: {total:0, learned:0} };
    for (const c of userCards) {
      const tab = catToTab(c.cat);
      byTab[tab].total++;
      if ((progress[c.id]?.score??0) >= 3) byTab[tab].learned++;
    }
    const tabOrder = ["vocab", "phrases"].filter(k => byTab[k].total > 0);

    // Streak: walk back from today, count consecutive days where any card was
    // studied. We allow today itself to be empty (you might not have studied
    // yet) but not any earlier day. Dates are ISO yyyy-mm-dd strings.
    const allDates = new Set();
    for (const c of userCards) for (const d of (c.dates || [])) allDates.add(d);
    const todayISO = new Date().toISOString().slice(0,10);
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0,10);
      if (allDates.has(iso)) streak++;
      else if (iso !== todayISO) break;
    }

    // Activity heatmap: 12 columns of 7 rows. dayCounts[iso] = total cards
    // touched that day across the whole deck. Older weeks on the left.
    const dayCounts = {};
    for (const c of userCards) {
      for (const d of (c.dates || [])) dayCounts[d] = (dayCounts[d] || 0) + 1;
    }
    const heatmapWeeks = [];
    for (let w = 11; w >= 0; w--) {
      const week = [];
      for (let day = 0; day < 7; day++) {
        const d = new Date();
        d.setDate(d.getDate() - (w*7 + (6-day)));
        const iso = d.toISOString().slice(0,10);
        week.push({ iso, count: dayCounts[iso] || 0 });
      }
      heatmapWeeks.push(week);
    }
    const heatColor = (count) => {
      if (count === 0) return T.color.surfaceHigh;
      if (count <= 2) return "rgba(156, 66, 52, 0.3)";
      if (count <= 5) return "rgba(156, 66, 52, 0.6)";
      return T.color.secondary;
    };

    // Hardest cards: persistent strugglers (seen ≥ 2, score ≤ 1), ordered by
    // most-seen first so the UI surfaces the cards you keep flunking.
    const hardest = userCards
      .map(c => ({ ...c, _score: progress[c.id]?.score ?? 0, _seen: progress[c.id]?.seen ?? 0 }))
      .filter(c => c._seen >= 2 && c._score <= 1)
      .sort((a, b) => b._seen - a._seen || a._score - b._score)
      .slice(0, 4);

    // Bento grid spans collapse to full width on narrow viewports
    const span = (n) => ({ gridColumn: isNarrow ? "1 / -1" : `span ${n}` });

    return (
      <div style={isNarrow ? S.shellNarrow : S.shell}>
        {sidebar}
        <main style={S.main}>
          <div style={S.mainInner}>
            <h1 style={S.statsHeading}>Progress</h1>

        <div style={isNarrow ? S.bentoNarrow : S.bento}>

          {/* Mastery gauge — col 8 */}
          <div style={{...S.bentoCard, ...span(8)}}>
            <div style={S.masteryRow}>
              <div style={S.gaugeBox}>
                <svg width="180" height="180" style={{transform:"rotate(-90deg)"}}>
                  <circle cx="90" cy="90" r="78" fill="transparent"
                    stroke={T.color.surfaceHigh} strokeWidth="10" />
                  <circle cx="90" cy="90" r="78" fill="transparent"
                    stroke={T.color.secondary} strokeWidth="14"
                    strokeLinecap="round"
                    strokeDasharray={`${2*Math.PI*78}`}
                    strokeDashoffset={`${2*Math.PI*78*(1 - masteryPct/100)}`} />
                </svg>
                <div style={S.gaugeLabel}>
                  <div style={S.gaugePct}>{masteryPct}%</div>
                  <div style={S.gaugeSub}>Mastered</div>
                </div>
              </div>
              <div style={S.masteryText}>
                <h3 style={S.bentoTitle}>Mastery</h3>
                <p style={S.masteryDesc}>
                  {learned} of {total} cards mastered.
                  {inProg > 0 && ` ${inProg} in progress.`}
                  {newCount > 0 && ` ${newCount} new.`}
                </p>
                <div style={S.pillRow}>
                  <span style={S.pillSecondary}>{total} CARDS</span>
                  {inProg > 0 && <span style={S.pillNeutral}>{inProg} LEARNING</span>}
                </div>
              </div>
            </div>
          </div>

          {/* Streak — col 4, dark primary-container background */}
          <div style={{...S.bentoCard, ...S.bentoStreak, ...span(4)}}>
            <div style={S.streakTop}>
              <div style={S.streakIcon}>🔥</div>
              <h3 style={S.streakTitle}>Streak</h3>
              <p style={S.streakLabel}>{streak === 1 ? "1 day" : `${streak} days`}</p>
            </div>
            <div style={S.streakBig}>{streak}</div>
          </div>

          {/* By Category — col 4 */}
          <div style={{...S.bentoCard, ...span(4)}}>
            <h3 style={S.bentoTitle}>By Category</h3>
            <div style={S.catBars}>
              {tabOrder.map(k => {
                const v = byTab[k];
                const pct = v.total > 0 ? Math.round((v.learned/v.total)*100) : 0;
                return (
                  <div key={k}>
                    <div style={S.catBarHead}>
                      <span>{TAB_LABELS[k]}</span>
                      <span>{pct}%</span>
                    </div>
                    <div style={S.catBarTrack}>
                      <div style={{...S.catBarFill, width:`${pct}%`, background:TAB_COLORS[k]}} />
                    </div>
                    <div style={S.catBarMeta}>{v.learned} of {v.total}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Activity heatmap — col 8 */}
          <div style={{...S.bentoCard, ...span(8)}}>
            <div style={S.bentoHead}>
              <h3 style={S.bentoTitle}>Activity</h3>
              <div style={S.heatLegend}>
                <span style={S.heatLegendLabel}>Less</span>
                <div style={{...S.heatCell, background:T.color.surfaceHigh}} />
                <div style={{...S.heatCell, background:"rgba(156, 66, 52, 0.3)"}} />
                <div style={{...S.heatCell, background:"rgba(156, 66, 52, 0.6)"}} />
                <div style={{...S.heatCell, background:T.color.secondary}} />
                <span style={S.heatLegendLabel}>More</span>
              </div>
            </div>
            <div style={S.heatGrid}>
              {heatmapWeeks.map((week, wi) => (
                <div key={wi} style={S.heatCol}>
                  {week.map((day, di) => (
                    <div
                      key={di}
                      style={{...S.heatCell, background:heatColor(day.count)}}
                      title={`${day.iso} · ${day.count} card${day.count===1?"":"s"}`}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div style={S.heatFootnote}>
              <span>Past 12 weeks</span>
              <span>Today</span>
            </div>
          </div>

          {/* Hardest cards — col 12 (only if there are any) */}
          {hardest.length > 0 && (
            <div style={{...S.bentoCard, ...span(12)}}>
              <h3 style={S.bentoTitle}>Hardest Cards</h3>
              <p style={S.bentoSub}>Cards you've seen multiple times but keep missing.</p>
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

        </div>

        <button style={S.resetBtn} onClick={resetAll}>Reset all progress</button>
          </div>
        </main>
      </div>
    );
  }

  // ── FEEDBACK VIEW (admin only) ──────────────────────────────────────
  if (mode === "feedback") {
    if (!isAdmin) {
      return (
        <div style={isNarrow ? S.shellNarrow : S.shell}>
          {sidebar}
          <main style={S.main}>
            <div style={S.mainInner}>
              <div style={S.empty}><p>Admins only.</p></div>
            </div>
          </main>
        </div>
      );
    }
    return (
      <div style={isNarrow ? S.shellNarrow : S.shell}>
        {sidebar}
        <main style={S.main}>
          <div style={S.mainInner}>
            <FeedbackAdminView user={user} setMode={setMode} resetSession={resetSession} />
          </div>
        </main>
      </div>
    );
  }

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
                <span style={S.counter}>Card {idx+1} of {deck.length}</span>
              </div>
            )}
          </div>

          {card ? (
            <div style={S.cardArea}>
              {/* Decorative blur shapes (per Stitch design) */}
              <div style={S.blurTL} />
              <div style={S.blurBR} />

              <div style={S.cardWrap} onClick={effectiveTypeMode ? undefined : flip}>
                <div style={{...S.card, transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)", transition: skipFlipAnim.current ? "none" : S.card.transition, cursor: effectiveTypeMode ? "default" : "pointer"}}>
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
                    <ShortcutsTooltip />
                  </div>
                  <div style={S.cardBack}>
                    <div style={S.cardEyebrow}>{card.shownDir==="fr"?"English":"French"}</div>
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
                      <button
                        style={card.flagged ? {...S.cardActionBtn, ...S.cardActionBtnFlagged} : S.cardActionBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!card.flagged) flagCard(card.row_id);
                        }}
                        title={card.flagged ? "Already flagged" : "Flag this card's translation for review"}
                      >
                        🚩
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
                    <div style={typeResult==="correct" ? S.typeCorrect : typeResult==="close" ? S.typeClose : S.typeWrong}>
                      {typeResult==="correct" && "✓ Correct!"}
                      {typeResult==="close" && `✓ Close enough — answer: ${back}`}
                      {typeResult==="wrongArticle" && `✗ Wrong article — answer: ${back}`}
                      {typeResult==="wrong" && `✗ Answer: ${back}`}
                    </div>
                    {(typeResult === "wrong" || typeResult === "close" || typeResult === "wrongArticle") && (
                      <div style={S.feedbackRow}>
                        {feedbackState === null && (
                          <button style={S.feedbackBtn} onClick={submitFeedback}>
                            My answer should have been accepted
                          </button>
                        )}
                        {feedbackState === "submitting" && <span style={S.feedbackPending}>Sending…</span>}
                        {feedbackState === "submitted" && <span style={S.feedbackOk}>Thanks! Your answer is being reviewed.</span>}
                        {feedbackState === "error" && <span style={S.feedbackErr}>Couldn't send — try again</span>}
                      </div>
                    )}
                    <div style={S.actionRow}>
                      <button style={S.actionAgainRect} onClick={() => answer(false)}>
                        Again
                      </button>
                      <button style={S.actionGotRect} onClick={() => answer(true)}>
                        Got It
                      </button>
                    </div>
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
        {editingCard && (
          <EditCardModal
            card={editingCard}
            onClose={() => setEditingCard(null)}
            onSave={async (newFront, newBack) => {
              const ok = await saveCardEdit(editingCard.row_id, newFront, newBack);
              if (ok) setEditingCard(null);
              return ok;
            }}
            onDelete={async () => {
              if (!confirm("Delete this card? This cannot be undone.")) return;
              const ok = await deleteCard(editingCard.row_id);
              if (ok) setEditingCard(null);
            }}
          />
        )}
      </main>
    </div>
  );
}

// ─── EDIT CARD MODAL ─────────────────────────────────────────────────────
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
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null); // id being acted on

  const load = async () => {
    setLoading(true);
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
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const approve = async (item) => {
    setActing(item.id);
    // Add alternate
    const { error: altErr } = await supabase.from("card_alternates").insert({
      card_id: item.card_id,
      direction: item.direction,
      alternate_text: item.user_answer,
      source_feedback_id: item.id,
    });
    if (altErr) { console.error("Alt insert failed:", altErr); setActing(null); return; }
    // Mark reviewed
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

  return (
    <>
      <h1 style={S.statsHeading}>Feedback Review</h1>
      {loading ? (
        <div style={S.empty}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={S.empty}><div style={{fontSize:48}}>✨</div><p>No pending feedback.</p></div>
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
                    {item.llm_confidence && <span style={S.llmConf}>confidence: {item.llm_confidence}</span>}
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
          <div><b>Esc</b> show answer</div>
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
  bento: { display:"grid", gridTemplateColumns:"repeat(12, minmax(0, 1fr))", gap:24, marginBottom:32 },
  bentoNarrow: { display:"flex", flexDirection:"column", gap:18, marginBottom:32 },
  bentoCard: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"28px 30px", boxShadow:T.shadow.card, border:"none" },
  bentoTitle: { fontSize:20, fontWeight:600, color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.01em", margin:"0 0 4px" },
  bentoSub: { fontSize:13, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, margin:"0 0 18px" },
  bentoHead: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 },
  // Mastery card
  masteryRow: { display:"flex", flexDirection:"row", alignItems:"center", gap:32, flexWrap:"wrap" },
  gaugeBox: { position:"relative", width:180, height:180, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  gaugeLabel: { position:"absolute", display:"flex", flexDirection:"column", alignItems:"center" },
  gaugePct: { fontSize:38, fontFamily:T.font.serif, fontWeight:700, color:T.color.primary, letterSpacing:"-0.02em" },
  gaugeSub: { fontSize:10, fontFamily:T.font.sans, fontWeight:600, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.12em", marginTop:2 },
  masteryText: { flex:1, minWidth:200 },
  masteryDesc: { fontSize:14, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, lineHeight:1.55, margin:"8px 0 16px" },
  pillRow: { display:"flex", gap:8, flexWrap:"wrap" },
  pillSecondary: { padding:"6px 14px", background:T.color.secondaryContainer, color:T.color.onSecondaryContainer, fontSize:10, fontWeight:700, fontFamily:T.font.sans, borderRadius:T.radius.full, letterSpacing:"0.08em" },
  pillNeutral: { padding:"6px 14px", background:T.color.surfaceHigh, color:T.color.primary, fontSize:10, fontWeight:700, fontFamily:T.font.sans, borderRadius:T.radius.full, letterSpacing:"0.08em" },
  // Streak card — dark navy background (Stitch primary-container #1a2b48)
  bentoStreak: { background:"#1a2b48", color:T.color.onPrimary, display:"flex", flexDirection:"column", justifyContent:"space-between", minHeight:240, position:"relative", overflow:"hidden" },
  streakTop: { zIndex:1 },
  streakIcon: { fontSize:36, marginBottom:8, lineHeight:1 },
  streakTitle: { fontSize:20, fontWeight:600, fontFamily:T.font.serif, color:T.color.onPrimary, margin:"0 0 4px" },
  streakLabel: { fontSize:10, fontFamily:T.font.sans, fontWeight:700, color:"rgba(255,255,255,0.7)", textTransform:"uppercase", letterSpacing:"0.12em", margin:0 },
  streakBig: { fontSize:88, fontFamily:T.font.serif, fontStyle:"italic", fontWeight:700, color:T.color.onPrimary, lineHeight:1, alignSelf:"flex-end", zIndex:1 },
  // Category bars
  catBars: { display:"flex", flexDirection:"column", gap:18, marginTop:14 },
  catBarHead: { display:"flex", justifyContent:"space-between", fontSize:10, fontFamily:T.font.sans, fontWeight:700, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 },
  catBarTrack: { width:"100%", height:6, background:T.color.surfaceHigh, borderRadius:T.radius.full, overflow:"hidden" },
  catBarFill: { height:"100%", borderRadius:T.radius.full, transition:"width 0.5s" },
  catBarMeta: { fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, marginTop:4 },
  // Heatmap
  heatLegend: { display:"flex", alignItems:"center", gap:4 },
  heatLegendLabel: { fontSize:9, fontFamily:T.font.sans, fontWeight:600, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.1em", padding:"0 4px" },
  heatGrid: { display:"flex", gap:6, marginTop:8 },
  heatCol: { display:"grid", gridTemplateRows:"repeat(7, 1fr)", gap:6, flex:1 },
  heatCell: { width:"100%", aspectRatio:"1", borderRadius:3, minWidth:10, minHeight:10 },
  heatFootnote: { display:"flex", justifyContent:"space-between", marginTop:14, fontSize:9, fontFamily:T.font.sans, fontWeight:600, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.12em" },
  // Hardest cards
  hardGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:14 },
  hardCard: { background:T.color.surfaceLow, borderRadius:T.radius.xl, padding:"18px 20px", display:"flex", flexDirection:"column", gap:8, transition:"background 0.15s", cursor:"default" },
  hardHead: { display:"flex", justifyContent:"space-between", alignItems:"flex-start" },
  hardTag: { fontSize:9, fontFamily:T.font.sans, fontWeight:700, padding:"3px 8px", borderRadius:T.radius.sm, textTransform:"uppercase", letterSpacing:"0.08em" },
  hardWord: { fontSize:18, fontFamily:T.font.serif, fontStyle:"italic", color:T.color.primary, margin:"4px 0 0", letterSpacing:"-0.01em", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  hardMeta: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, margin:0 },
  resetBtn: { display:"block", width:"100%", padding:"13px", border:"none", borderRadius:T.radius.md, background:"transparent", color:T.color.secondary, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600 },
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
  typeWrong: { textAlign:"center", padding:14, background:T.color.errorContainer, color:T.color.onErrorContainer, borderRadius:T.radius.lg, fontSize:14, fontWeight:500, marginBottom:12, fontFamily:T.font.sans },
  typeBtnRow: { display:"flex", gap:12, marginTop:8 },
  feedbackRow: { textAlign:"center", marginBottom:10, fontFamily:T.font.sans, fontSize:12 },
  feedbackBtn: { padding:"7px 16px", background:"transparent", border:"none", color:T.color.secondary, borderRadius:T.radius.md, fontSize:12, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, textDecoration:"underline" },
  feedbackPending: { color:T.color.onSurfaceVariant },
  feedbackOk: { color:T.color.primary, fontWeight:500 },
  feedbackErr: { color:T.color.secondary, fontWeight:500 },
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
};

