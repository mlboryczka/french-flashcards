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

// UI code → DB code, used by the admin seed-deck action
const CAT_TO_DB = { vocab: "V", expr: "E", gram: "G", pron: "P" };

const CAT_LABELS = { all:"All", vocab:"Vocabulaire", expr:"Expressions", gram:"Grammaire", pron:"Prononciation" };
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
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState("");

  // Inline card edit state
  const [editingCard, setEditingCard] = useState(null); // null | card object

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
    let cards = cat === "all" ? [...userCards] : userCards.filter(c => c.cat === cat);
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
      const result = await assessPronunciation(blob, card.f);
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

  // Auto-focus study input when entering type mode or advancing cards
  useEffect(() => {
    if (typeMode && mode === "study" && !typeResult) {
      setTimeout(() => studyInputRef.current?.focus(), 50);
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
    setTimeout(() => {
      setFlipped(false);
      setIdx(i => Math.min(i+1, deck.length-1));
      setTypedAnswer("");
      setTypeResult(null);
    }, 100);
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

  const goBack = () => {
    if (idx === 0) return;
    if (autoAdvanceTimer.current) {
      clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = null;
    }
    setFlipped(false);
    setIdx(i => Math.max(0, i-1));
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null);
    setTimeout(() => studyInputRef.current?.focus(), 50);
  };

  const resetSession = () => {
    setIdx(0);
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0 });
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null);
  };

  // Keyboard shortcuts (study mode, non-type mode)
  useEffect(() => {
    if (mode !== "study" || typeMode) return;
    const handler = (e) => {
      if (!card) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); flip(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); answer(false); }
      else if (e.key === "ArrowRight") { e.preventDefault(); answer(true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); goBack(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, mode, typeMode, idx, deck.length]);

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
    return (
      <div style={S.container}>
        <div style={S.header}>
          <div>
            <h1 style={S.title}>French Flashcards</h1>
            <p style={S.sub}>Let's set up your deck</p>
          </div>
          {user && (
            <div style={S.userInfo}>
              <div style={S.userEmail}>{user.email}</div>
              <button style={S.signOutBtn} onClick={onSignOut}>Sign out</button>
            </div>
          )}
        </div>
        <div style={S.onboarding}>
          <h2 style={S.onbTitle}>Welcome back</h2>
          <p style={S.onbText}>
            Upload your cahier to get started. We'll turn your lesson notes into a personal deck —
            vocabulary, expressions, grammar, and conjugation drills.
          </p>
          <button style={S.onbPrimary} onClick={() => setShowUpload(true)}>
            Upload your cahier
          </button>
          {isAdmin && (
            <>
              <div style={S.onbDivider}>or</div>
              <button
                style={S.onbSecondary}
                onClick={seedDemoDeck}
                disabled={seeding}
              >
                {seeding ? "Seeding…" : "Seed demo deck (admin)"}
              </button>
              {seedError && <div style={S.onbError}>{seedError}</div>}
            </>
          )}
        </div>
        <CahierUpload
          open={showUpload}
          onClose={() => setShowUpload(false)}
          hasExisting={false}
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

  // ── NAV BAR ─────────────────────────────────────────────────────────
  const NavBar = () => {
    const items = [["study","Cards"],["stats","Stats"]];
    if (isAdmin) items.push(["feedback","Feedback"]);
    return (
      <div style={S.nav}>
        {items.map(([m,label]) => (
          <button key={m} style={mode===m ? {...S.navBtn,...S.navActive} : S.navBtn} onClick={() => { setMode(m); resetSession(); }}>{label}</button>
        ))}
      </div>
    );
  };

  // ── FILTERS ─────────────────────────────────────────────────────────
  const Filters = () => (
    <div style={S.filters}>
      <div style={S.catRow}>
        {Object.entries(CAT_LABELS).map(([k,v]) => (
          <button key={k} style={cat===k ? {...S.catBtn,...S.catBtnA,...(k!=="all"?{borderColor:CAT_COLORS[k],color:CAT_COLORS[k]}:{})} : S.catBtn} onClick={() => setCat(k)}>{v}</button>
        ))}
      </div>
      {mode === "study" && (
        <div style={S.toggleRow}>
          <label style={S.toggle}><input type="checkbox" checked={freqOnly} onChange={e => setFreqOnly(e.target.checked)} /><span>Repeated 2×+</span></label>
          <label style={S.toggle}><input type="checkbox" checked={typeMode} onChange={e => { setTypeMode(e.target.checked); setTypedAnswer(""); setTypeResult(null); setFlipped(false); }} /><span>Type answer</span></label>
          {TTS_AVAILABLE && (
            <label style={S.toggle}><input type="checkbox" checked={autoSpeak} onChange={e => setAutoSpeak(e.target.checked)} /><span>Auto-speak FR</span></label>
          )}
          <div style={S.dirGroup}>
            {[["fr","FR→EN"],["en","EN→FR"],["mix","Mixed"]].map(([k,label]) => (
              <button key={k} style={dir===k ? {...S.dirBtn,...S.dirBtnA} : S.dirBtn} onClick={() => setDir(k)}>{label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );


  // ── STATS VIEW ──────────────────────────────────────────────────────
  if (mode === "stats") {
    const total = userCards.length;
    const learned = userCards.filter(c => (progress[c.id]?.score??0) >= 3).length;
    const inProg = userCards.filter(c => { const s=progress[c.id]?.score??0; return s>0&&s<3; }).length;
    const byCat = {};
    for (const c of userCards) { if (!byCat[c.cat]) byCat[c.cat]={total:0,learned:0}; byCat[c.cat].total++; if ((progress[c.id]?.score??0)>=3) byCat[c.cat].learned++; }
    const topFreq = userCards.filter(c=>c.freq>=3).slice(0,20);
    return (
      <div style={S.container}>
        <h1 style={S.title}>My Statistics</h1>
        <NavBar />
        <div style={S.statsGrid}>
          <div style={S.statCard}><div style={S.statNum}>{total}</div><div style={S.statLabel}>Cards</div></div>
          <div style={{...S.statCard,borderColor:"#2d6a4f"}}><div style={{...S.statNum,color:"#2d6a4f"}}>{learned}</div><div style={S.statLabel}>Mastered</div></div>
          <div style={{...S.statCard,borderColor:"#e9c46a"}}><div style={{...S.statNum,color:"#b8860b"}}>{inProg}</div><div style={S.statLabel}>In Progress</div></div>
          <div style={{...S.statCard,borderColor:"#c44536"}}><div style={{...S.statNum,color:"#c44536"}}>{total-learned-inProg}</div><div style={S.statLabel}>To Learn</div></div>
        </div>
        <div style={S.pBarOut}><div style={{...S.pBarIn, width:`${total > 0 ? (learned/total)*100 : 0}%`}} /></div>
        <div style={S.pText}>{total > 0 ? Math.round((learned/total)*100) : 0}% mastered</div>
        <h2 style={S.subT}>By Category</h2>
        <div style={S.catStats}>{Object.entries(byCat).map(([k,v]) => (
          <div key={k} style={S.catStatRow}><span style={{...S.dot,background:CAT_COLORS[k]}} /><span style={{flex:1}}>{CAT_LABELS[k]}</span><span style={{fontWeight:600}}>{v.learned}/{v.total}</span></div>
        ))}</div>
        <h2 style={S.subT}>Most Repeated (prioritize these)</h2>
        <div style={S.freqList}>{topFreq.map(c => (
          <div key={c.id} style={S.freqItem}><span style={S.freqWord}>{c.f}</span><span style={S.freqBadge}>{c.freq}×</span></div>
        ))}</div>
        <button style={S.resetBtn} onClick={resetAll}>Reset All Progress</button>
      </div>
    );
  }

  // ── FEEDBACK VIEW (admin only) ──────────────────────────────────────
  if (mode === "feedback") {
    if (!isAdmin) {
      return (
        <div style={S.container}>
          <NavBar />
          <div style={S.empty}><p>Admins only.</p></div>
        </div>
      );
    }
    return <FeedbackAdminView user={user} setMode={setMode} resetSession={resetSession} />;
  }

  // ── STUDY MODE ──────────────────────────────────────────────────────
  const front = card ? (card.shownDir==="fr" ? card.f : card.b) : "";
  const back = card ? (card.shownDir==="fr" ? card.b : card.f) : "";
  // Typing mode applies when:
  //  - user enabled it, AND
  //  - the card is either flippable (vocab/expr) OR has a short back (≤25 chars)
  //    that's a specific answer rather than a rule explanation
  const isTypable = card && (card.flippable || (back && back.length <= 25));
  const effectiveTypeMode = typeMode && isTypable;
  return (
    <div style={S.container}>
      <div style={S.header}>
        <div>
          <h1 style={S.title}>French Flashcards</h1>
          <p style={S.sub}>{deck.length} cards · {stats.seen} seen · {stats.got} ✓ · {stats.missed} ✗</p>
        </div>
        {user && (
          <div style={S.userInfo}>
            <div style={S.headerBtnRow}>
              <button style={S.headerBtn} onClick={() => setShowUpload(true)} title="Upload or re-upload your cahier">📄 Upload cahier</button>
              <BetaFeedback user={user} currentPage={mode} />
            </div>
            <div style={S.userEmail}>{user.email}</div>
            <button style={S.signOutBtn} onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </div>
      <NavBar />
      <Filters />
      {card ? (
        <>
          <div style={S.counterRow}>
            <button style={{...S.backBtn, visibility: idx === 0 ? "hidden" : "visible"}} onClick={goBack} title="Previous card">← Back</button>
            <div style={{...S.counter, flex:1, marginBottom:0}}>{idx+1} / {deck.length}</div>
            <div style={S.backBtnSpacer} />
          </div>
          <div style={S.cardWrap} onClick={effectiveTypeMode ? undefined : flip}>
            <div style={{...S.card, transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)", cursor: effectiveTypeMode ? "default" : "pointer"}}>
              <div style={S.cardFront}>
                <div style={S.cardCat}><span style={{...S.dot,background:CAT_COLORS[card.cat]}} />{CAT_LABELS[card.cat]}{card.freq>=2 && <span style={S.freqTag}>{card.freq}×</span>}</div>
                <div style={S.langBadge}>{card.flippable ? (card.shownDir==="fr" ? "FR → EN" : "EN → FR") : "RULE"}</div>
                <div style={S.cardText}>{front}</div>
                {TTS_AVAILABLE && card.shownDir === "fr" && (
                  <AudioToolbar
                    onSpeak={(e) => { e.stopPropagation(); speakCard(); }}
                    onMic={(e) => { e.stopPropagation(); if (recState === "recording") stopRecording(); else startRecording(); }}
                    recState={recState}
                    sttAvailable={STT_AVAILABLE}
                  />
                )}
                {!effectiveTypeMode && <div style={S.hint}>tap to flip</div>}
              </div>
              <div style={S.cardBack}>
                <div style={S.cardCat}><span style={{...S.dot,background:CAT_COLORS[card.cat]}} />{card.shownDir==="fr"?"English":"French"}</div>
                <div style={S.cardTextB}>{back}</div>
                {TTS_AVAILABLE && card.shownDir === "en" && (
                  <AudioToolbar
                    onSpeak={(e) => { e.stopPropagation(); speakCard(); }}
                    onMic={(e) => { e.stopPropagation(); if (recState === "recording") stopRecording(); else startRecording(); }}
                    recState={recState}
                    sttAvailable={STT_AVAILABLE}
                  />
                )}
                <div style={S.dateH}>Seen on: {card.dates[card.dates.length-1]}</div>
                <div style={S.cardActions}>
                  <button
                    style={S.cardActionBtn}
                    onClick={(e) => { e.stopPropagation(); setEditingCard(card); }}
                    title="Edit this card"
                  >
                    ✏️ Edit
                  </button>
                  <button
                    style={card.flagged ? {...S.cardActionBtn, ...S.cardActionBtnFlagged} : S.cardActionBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!card.flagged) flagCard(card.row_id);
                    }}
                    title={card.flagged ? "Already flagged" : "Flag this card's translation for review"}
                  >
                    {card.flagged ? "🚩 Flagged" : "🚩 Flag"}
                  </button>
                </div>
              </div>
            </div>
          </div>
          {/* Pronunciation panel — appears below card when recording or showing results */}
          {(recState !== "idle") && (
            <PronunciationPanel
              recState={recState}
              result={pronResult}
              error={pronError}
              referenceText={card.f}
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
                <div style={S.typeBtnRow}>
                  <button style={S.btnWrong} onClick={() => answer(false)}>Again</button>
                  <button style={S.btnRight} onClick={() => answer(true)}>Got It</button>
                </div>
              </div>
            ) : (
              <div style={S.typeInputRow}>
                <input
                  ref={studyInputRef}
                  style={S.typeInput}
                  value={typedAnswer}
                  onChange={e => setTypedAnswer(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") submitTyped(); }}
                  placeholder={`Type ${card.shownDir==="fr" ? "English" : "French"}…`}
                  autoFocus
                />
                <button style={S.typeSubmit} onClick={submitTyped}>Check</button>
              </div>
            )
          ) : (
            <>
              <div style={S.btnRow}>
                <button style={S.btnWrong} onClick={() => answer(false)}>
                  <span style={{fontSize:18}}>✗</span> Again
                </button>
                <button style={S.btnRight} onClick={() => answer(true)}>
                  <span style={{fontSize:18}}>✓</span> Got It
                </button>
              </div>
              <div style={S.shortcuts}>Space = flip · ← = again · → = got it · ↑ = back</div>
            </>
          )}
        </>
      ) : (
        <div style={S.empty}><div style={{fontSize:48}}>🎉</div><p>No cards in this selection.</p><button style={S.resetSBtn} onClick={resetSession}>Start Over</button></div>
      )}
      {idx >= deck.length-1 && deck.length > 0 && stats.seen > 0 && (
        <div style={S.sessionDone}>
          <p style={S.doneText}>Session complete! {stats.got}/{stats.seen} ({Math.round(stats.got/Math.max(stats.seen,1)*100)}%)</p>
          <button style={S.resetSBtn} onClick={resetSession}>New Session</button>
        </div>
      )}
      <CahierUpload
        open={showUpload}
        onClose={() => setShowUpload(false)}
        hasExisting={userCards.length > 0}
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
    <div style={S.container}>
      <h1 style={S.title}>Feedback Review</h1>
      <div style={S.nav}>
        {[["study","Cards"],["stats","Stats"],["feedback","Feedback"]].map(([m,label]) => (
          <button key={m} style={m==="feedback" ? {...S.navBtn,...S.navActive} : S.navBtn} onClick={() => { if (m !== "feedback") { setMode(m); resetSession(); } }}>{label}</button>
        ))}
      </div>
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
  toggleRow: { display:"flex", gap:14, alignItems:"center", flexWrap:"wrap" },
  toggle: { display:"flex", gap:6, alignItems:"center", fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, cursor:"pointer" },
  dirGroup: { display:"flex", gap:2, marginLeft:"auto", padding:3, background:T.color.surfaceLow, borderRadius:T.radius.md },
  dirBtn: { padding:"5px 12px", border:"none", borderRadius:T.radius.sm, background:"transparent", cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500 },
  dirBtnA: { background:T.color.surfaceLowest, color:T.color.primary, fontWeight:600, boxShadow:T.shadow.focus },
  counterRow: { display:"flex", alignItems:"center", gap:8, marginBottom:10 },
  counter: { textAlign:"center", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, letterSpacing:"0.05em", textTransform:"uppercase", fontWeight:500 },
  backBtn: { padding:"6px 14px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:500 },
  backBtnSpacer: { width:60 },
  cardWrap: { perspective:1200, marginBottom:20 },
  card: { position:"relative", transformStyle:"preserve-3d", transition:"transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)", minHeight:260 },
  cardFront: { backfaceVisibility:"hidden", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, padding:"36px 28px", minHeight:260, display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:T.shadow.card, position:"relative", overflow:"hidden" },
  cardBack: { backfaceVisibility:"hidden", transform:"rotateY(180deg)", position:"absolute", top:0, left:0, right:0, background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, padding:"36px 28px", minHeight:260, display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:T.shadow.card, overflow:"hidden", borderTop:`3px solid ${T.color.secondary}` },
  cardCat: { position:"absolute", top:14, left:18, display:"flex", alignItems:"center", gap:7, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:600 },
  langBadge: { position:"absolute", top:14, right:18, fontSize:9, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, background:T.color.surfaceHigh, padding:"3px 9px", borderRadius:T.radius.full, letterSpacing:"0.08em", fontWeight:600, textTransform:"uppercase" },
  freqTag: { marginLeft:6, background:T.color.secondaryContainer, color:T.color.onSecondaryContainer, padding:"2px 7px", borderRadius:T.radius.full, fontSize:10, fontWeight:700 },
  dot: { width:7, height:7, borderRadius:"50%" },
  cardText: { fontSize:32, textAlign:"center", fontWeight:400, color:T.color.primary, lineHeight:1.25, padding:"0 12px", fontFamily:T.font.serif, letterSpacing:"-0.015em" },
  cardTextB: { fontSize:28, textAlign:"center", fontWeight:400, color:T.color.primary, lineHeight:1.3, padding:"0 12px", fontFamily:T.font.serif, letterSpacing:"-0.01em" },
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
  // Stats
  statsGrid: { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:18 },
  statCard: { textAlign:"center", padding:"18px 8px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, boxShadow:T.shadow.card },
  statNum: { fontSize:30, fontWeight:700, color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.02em" },
  statLabel: { fontSize:10, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.1em", marginTop:5, fontFamily:T.font.sans, fontWeight:600 },
  pBarOut: { height:8, background:T.color.surfaceHigh, borderRadius:T.radius.full, overflow:"hidden", marginBottom:8 },
  pBarIn: { height:"100%", background:T.gradient.ink, transition:"width 0.5s" },
  pText: { textAlign:"center", fontSize:12, color:T.color.onSurfaceVariant, marginBottom:24, fontFamily:T.font.sans, fontWeight:500 },
  subT: { fontSize:18, fontWeight:600, margin:"24px 0 12px", color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.01em" },
  catStats: { display:"flex", flexDirection:"column", gap:8, marginBottom:18 },
  catStatRow: { display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.lg, fontSize:13, fontFamily:T.font.sans, boxShadow:T.shadow.card },
  freqList: { display:"flex", flexDirection:"column", gap:6, marginBottom:24 },
  freqItem: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 14px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.lg, fontSize:13, boxShadow:T.shadow.card },
  freqWord: { fontFamily:T.font.serif, fontStyle:"italic", color:T.color.primary, fontSize:15 },
  freqBadge: { background:T.color.secondaryContainer, color:T.color.onSecondaryContainer, padding:"2px 10px", borderRadius:T.radius.full, fontSize:11, fontWeight:700 },
  resetBtn: { display:"block", width:"100%", padding:"13px", border:"none", borderRadius:T.radius.md, background:"transparent", color:T.color.secondary, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600 },
  // Onboarding (empty deck state)
  onboarding: { maxWidth:520, margin:"60px auto", padding:"48px 36px", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, textAlign:"center", boxShadow:T.shadow.card },
  onbTitle: { margin:"0 0 14px", fontSize:32, color:T.color.primary, fontFamily:T.font.serif, fontWeight:600, letterSpacing:"-0.02em" },
  onbText: { fontSize:15, color:T.color.onSurfaceVariant, lineHeight:1.6, marginBottom:28, fontFamily:T.font.sans },
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
  typeFeedback: { marginBottom:12 },
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

