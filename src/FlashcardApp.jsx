import { useState, useEffect, useCallback, useRef } from "react";
import { RAW, BLANKS } from "./data/cards";
import { useProgress } from "./useProgress";
import { supabase } from "./supabase";
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

// ─── BUILD DECK ──────────────────────────────────────────────────────────
function buildDeck(raw) {
  const map = new Map();
  for (const [f, b, cat, dates] of raw) {
    const key = f.toLowerCase().trim();
    if (map.has(key)) {
      const ex = map.get(key);
      ex.dates = [...new Set([...ex.dates, ...dates])];
      ex.freq = ex.dates.length;
    } else {
      map.set(key, { f, b, cat, dates: [...dates], freq: dates.length, id: key });
    }
  }
  return [...map.values()].sort((a, b) => b.freq - a.freq);
}

const ALL_CARDS = buildDeck(RAW);

const CAT_LABELS = { all:"All", vocab:"Vocabulaire", expr:"Expressions", gram:"Grammaire", pron:"Prononciation" };
const CAT_COLORS = { vocab:"#2d6a4f", expr:"#7b2d8b", gram:"#c44536", pron:"#1d3557" };

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
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}
// Returns { match, close?, wrongArticle? }
function matchAnswer(typed, correct, extraAlts = []) {
  const t = normalize(typed);
  if (!t) return { match: false };
  // Strip parentheticals first so commas inside them aren't treated as separators
  // (e.g., "to take (someone, somewhere)" should not split into "to take (someone" + "somewhere)")
  const stripParens = correct.replace(/\([^)]*\)/g, "");
  // Split on /, |, ;, comma, or " or " — each becomes an acceptable alternative answer
  const alts = stripParens.split(/\s*[,/|;]\s*|\s+or\s+/i).map(normalize).filter(Boolean);
  alts.push(normalize(correct));
  for (const e of extraAlts) {
    const n = normalize(e);
    if (n) alts.push(n);
  }
  const tP = splitArticle(t);
  let articleMismatch = false; // track if content matched but article was wrong
  for (const alt of alts) {
    if (!alt) continue;
    const aP = splitArticle(alt);
    const artOK = articlesCompatible(tP.article, aP.article);
    const tR = tP.rest, aR = aP.rest;
    // 1. Exact match on content
    if (t === alt) return { match: true };
    if (tR === aR) {
      if (artOK) return { match: true };
      articleMismatch = true; continue;
    }
    // 2. Substring of content
    if (tR.length >= 4 && aR.length >= 4) {
      const short = tR.length < aR.length ? tR : aR;
      const long = tR.length < aR.length ? aR : tR;
      if (long.includes(short) && short.length >= long.length * 0.4) {
        if (artOK) return { match: true, close: true };
        articleMismatch = true; continue;
      }
    }
    // 3. Token set overlap on content
    // Filter out function words — "of", "in", "for", etc. inflate overlap without meaning
    const STOPWORDS = new Set(["of","in","on","at","for","by","is","it","to","the","a","an","up","not","no","and","or","my","be","do","if","so","as","with","that","this","from","but","its","has","was","are","will","been","have","had","can","all","out","than","when","very","just","about","into","also","each","how","de","la","le","les","un","une","du","des","en","au","est","et","que","qui","pas","ne","se"]);
    const tTok = tR.split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
    const aTok = aR.split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
    if (tTok.length > 0 && aTok.length > 0) {
      const tSet = new Set(tTok), aSet = new Set(aTok);
      const [smallSet, bigSet] = tSet.size <= aSet.size ? [tSet, aSet] : [aSet, tSet];
      const overlap = [...smallSet].filter(w => bigSet.has(w)).length;
      let tokenMatch = false;
      if (overlap === smallSet.size && smallSet.size >= 2) tokenMatch = true;
      if (smallSet.size >= 3 && overlap >= smallSet.size - 1 && overlap / bigSet.size >= 0.5) tokenMatch = true;
      if (tokenMatch) {
        if (artOK) return { match: true, close: true };
        articleMismatch = true; continue;
      }
    }
    // 4. Typo tolerance on content
    const maxLen = Math.max(tR.length, aR.length);
    if (maxLen >= 4 && maxLen <= 20) {
      const dist = editDistance(tR, aR);
      const tolerance = Math.max(1, Math.floor(maxLen / 6));
      if (dist <= tolerance) {
        if (artOK) return { match: true, close: true };
        articleMismatch = true; continue;
      }
    }
  }
  return { match: false, wrongArticle: articleMismatch };
}

// ─── COMPONENT ───────────────────────────────────────────────────────────
export default function FlashcardApp({ user, onSignOut }) {
  const { progress, loaded, updateCard, resetAll: resetAllProgress } = useProgress(user);
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [cat, setCat] = useState("all");
  const [mode, setMode] = useState("study"); // study | stats | blank
  const [stats, setStats] = useState({ seen:0, got:0, missed:0 });
  const [freqOnly, setFreqOnly] = useState(false);
  const [dir, setDir] = useState("mix"); // fr | en | mix
  const [typeMode, setTypeMode] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [typeResult, setTypeResult] = useState(null); // null | 'correct' | 'wrong'
  const studyInputRef = useRef(null);
  // blank mode state
  const [blankIdx, setBlankIdx] = useState(0);
  const [blankInput, setBlankInput] = useState("");
  const [blankResult, setBlankResult] = useState(null); // null | 'correct' | 'wrong'
  const [blankDeck, setBlankDeck] = useState([]);
  const [blankStats, setBlankStats] = useState({ seen:0, got:0 });
  const inputRef = useRef(null);

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
    let cards = cat === "all" ? [...ALL_CARDS] : ALL_CARDS.filter(c => c.cat === cat);
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
  }, [cat, freqOnly, mode, loaded, dir]);

  // Build blank deck
  useEffect(() => {
    if (mode !== "blank") return;
    let b = cat === "all" ? [...BLANKS] : BLANKS.filter(x => x[3] === cat);
    for (let i = b.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [b[i],b[j]]=[b[j],b[i]]; }
    setBlankDeck(b);
    setBlankIdx(0);
    setBlankInput("");
    setBlankResult(null);
    setBlankStats({ seen:0, got:0 });
  }, [mode, cat]);

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

  // Start a pronunciation practice session for the current card.
  // Records the user, sends the WAV to Azure, displays per-word scores.
  const startRecording = useCallback(async () => {
    if (!STT_AVAILABLE || !card) return;
    setPronError("");
    setPronResult(null);
    stopSpeaking();
    try {
      const recorder = new WavRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setRecState("recording");
    } catch (e) {
      console.error("Mic access failed:", e);
      setPronError(
        e.name === "NotAllowedError"
          ? "Microphone access denied"
          : "Couldn't start recording: " + (e.message || e.name || "unknown")
      );
      setRecState("error");
    }
  }, [card]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || !card) return;
    setRecState("processing");
    try {
      const wav = await recorder.stop();
      recorderRef.current = null;
      if (!wav) {
        setPronError("No audio recorded");
        setRecState("error");
        return;
      }
      const result = await assessPronunciation(wav, card.f);
      if (result.error) {
        setPronError(result.error);
        setRecState("error");
        return;
      }
      setPronResult(result);
      setRecState("result");
    } catch (e) {
      console.error("Recording / assessment failed:", e);
      setPronError(e.message || "Unknown error");
      setRecState("error");
    }
  }, [card]);

  const cancelRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder) {
      try { await recorder.stop(); } catch {}
      recorderRef.current = null;
    }
    setRecState("idle");
    setPronResult(null);
    setPronError("");
  }, []);

  // Reset audio state when navigating to a different card
  useEffect(() => {
    setRecState("idle");
    setPronResult(null);
    setPronError("");
    if (recorderRef.current && recorderRef.current.recording) {
      recorderRef.current.stop().catch(() => {});
      recorderRef.current = null;
    }
  }, [idx]);

  const rate = useCallback((correct) => {
    if (!card) return;
    const old = progress[card.id] || { score:0, seen:0, got:0 };
    const next = {
      score: correct ? Math.min(old.score+1,5) : Math.max(old.score-1,-2),
      seen: old.seen+1,
      got: old.got+(correct?1:0),
    };
    updateCard(card.id, next);
    setStats(s => ({ seen:s.seen+1, got:s.got+(correct?1:0), missed:s.missed+(correct?0:1) }));
    setFlipped(false);
    setTypedAnswer("");
    setTypeResult(null);
    setTimeout(() => setIdx(i => Math.min(i+1, deck.length-1)), 150);
  }, [card, deck.length, progress, updateCard]);

  const goBack = useCallback(() => {
    if (idx === 0) return;
    setFlipped(false);
    setTypedAnswer("");
    setTypeResult(null);
    setIdx(i => Math.max(0, i - 1));
  }, [idx]);

  const checkTyped = useCallback(() => {
    if (!card || !typedAnswer.trim()) return;
    const correctAnswer = card.shownDir === "fr" ? card.b : card.f;
    const altKey = `${card.id}:${card.shownDir}`;
    const extraAlts = alternates[altKey] || [];
    const result = matchAnswer(typedAnswer, correctAnswer, extraAlts);
    let status;
    if (result.match) status = result.close ? "close" : "correct";
    else if (result.wrongArticle) status = "wrongArticle";
    else status = "wrong";
    setTypeResult(status);
    setFlipped(true);
    setFeedbackState(null);
    const wasCorrect = result.match;
    const delay = status === "correct" ? 900 : status === "close" ? 1800 : 2200;
    // Store timer ID so the feedback button can cancel auto-advance
    if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
    autoAdvanceTimer.current = setTimeout(() => rate(wasCorrect), delay);
  }, [card, typedAnswer, rate, alternates]);

  // Submit "my answer should have been accepted" feedback to Supabase + LLM reviewer
  const submitFeedback = useCallback(async () => {
    if (!card || !user || !typedAnswer.trim()) return;
    // Cancel the auto-advance so the user can see the confirmation
    if (autoAdvanceTimer.current) {
      clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = null;
    }
    setFeedbackState("submitting");
    const row = {
      user_id: user.id,
      user_email: user.email,
      card_id: card.id,
      card_front: card.shownDir === "fr" ? card.f : card.b,
      card_back: card.shownDir === "fr" ? card.b : card.f,
      direction: card.shownDir,
      user_answer: typedAnswer.trim(),
    };
    const { data, error } = await supabase
      .from("feedback_submissions")
      .insert(row)
      .select()
      .single();
    if (error) {
      console.error("Feedback insert failed:", error);
      setFeedbackState("error");
      return;
    }
    // Fire-and-forget the LLM review (don't block the UI on it)
    fetch("/api/review-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submissionId: data.id }),
    }).catch(err => console.error("LLM review call failed:", err));
    setFeedbackState("submitted");
  }, [card, user, typedAnswer]);

  useEffect(() => {
    if (mode !== "study") return;
    const h = (e) => {
      // Don't hijack keys when the user is typing in the answer input
      if (e.target.tagName === "INPUT") return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
      if (e.key === "ArrowRight" || e.key === "j") rate(true);
      if (e.key === "ArrowLeft" || e.key === "k") rate(false);
      if (e.key === "ArrowUp" || e.key === "b") { e.preventDefault(); goBack(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [flip, rate, goBack, mode]);

  // Focus input when entering type mode or moving to next card
  useEffect(() => {
    if (typeMode && mode === "study" && !typeResult) {
      setTimeout(() => studyInputRef.current?.focus(), 100);
    }
  }, [idx, typeMode, mode, typeResult]);

  const resetSession = () => { setStats({seen:0,got:0,missed:0}); setIdx(0); setFlipped(false); setTypedAnswer(""); setTypeResult(null); };
  const resetAll = async () => {
    if (!confirm("Reset all of your progress? This can't be undone.")) return;
    await resetAllProgress();
    resetSession();
  };

  // Blank mode handlers
  const checkBlank = () => {
    if (!blankDeck[blankIdx]) return;
    const answer = blankDeck[blankIdx][1].toLowerCase().trim();
    const input = blankInput.toLowerCase().trim();
    // flexible matching: exact or contained
    const correct = input === answer || answer.includes(input) && input.length >= Math.max(3, answer.length - 2);
    setBlankResult(correct ? "correct" : "wrong");
    setBlankStats(s => ({ seen: s.seen+1, got: s.got + (correct?1:0) }));
  };
  const nextBlank = () => {
    setBlankResult(null);
    setBlankInput("");
    setBlankIdx(i => Math.min(i+1, blankDeck.length-1));
    setTimeout(() => inputRef.current?.focus(), 100);
  };
  const goBackBlank = () => {
    if (blankIdx === 0) return;
    setBlankResult(null);
    setBlankInput("");
    setBlankIdx(i => Math.max(0, i-1));
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  if (!loaded) return <div style={S.loading}>Loading…</div>;

  // ── NAV BAR ─────────────────────────────────────────────────────────
  const NavBar = () => {
    const items = [["study","Cards"],["blank","Fill-in"],["stats","Stats"]];
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
    const total = ALL_CARDS.length;
    const learned = ALL_CARDS.filter(c => (progress[c.id]?.score??0) >= 3).length;
    const inProg = ALL_CARDS.filter(c => { const s=progress[c.id]?.score??0; return s>0&&s<3; }).length;
    const byCat = {};
    for (const c of ALL_CARDS) { if (!byCat[c.cat]) byCat[c.cat]={total:0,learned:0}; byCat[c.cat].total++; if ((progress[c.id]?.score??0)>=3) byCat[c.cat].learned++; }
    const topFreq = ALL_CARDS.filter(c=>c.freq>=3).slice(0,20);
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
        <div style={S.pBarOut}><div style={{...S.pBarIn, width:`${(learned/total)*100}%`}} /></div>
        <div style={S.pText}>{Math.round((learned/total)*100)}% mastered</div>
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

  // ── BLANK MODE ──────────────────────────────────────────────────────
  if (mode === "blank") {
    const bl = blankDeck[blankIdx];
    const done = blankIdx >= blankDeck.length - 1 && blankStats.seen > 0;
    return (
      <div style={S.container}>
        <h1 style={S.title}>Fill in the Blank</h1>
        <NavBar />
        <Filters />
        {bl ? (
          <>
            <div style={S.counterRow}>
              <button style={{...S.backBtn, visibility: blankIdx === 0 ? "hidden" : "visible"}} onClick={goBackBlank} title="Previous question">← Back</button>
              <div style={{...S.counter, flex:1, marginBottom:0}}>{blankIdx+1} / {blankDeck.length}</div>
              <div style={S.backBtnSpacer} />
            </div>
            <div style={S.blankCard}>
              <div style={S.blankSentence}>{bl[0].split("___").map((part,i,arr) => (
                <span key={i}>{part}{i < arr.length-1 && <span style={S.blankSlot}>{blankResult ? bl[1] : "___"}</span>}</span>
              ))}</div>
              <div style={S.blankHint}>{bl[2]}</div>
              {!blankResult ? (
                <div style={S.blankInputRow}>
                  <input ref={inputRef} style={S.blankInput} value={blankInput} onChange={e => setBlankInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") checkBlank(); }} placeholder="Your answer…" autoFocus />
                  <button style={S.blankSubmit} onClick={checkBlank}>Check</button>
                </div>
              ) : (
                <div style={S.blankFeedback}>
                  <div style={blankResult==="correct" ? S.blankCorrect : S.blankWrong}>
                    {blankResult==="correct" ? "✓ Correct!" : `✗ Answer: ${bl[1]}`}
                  </div>
                  {bl[4] && <div style={S.blankTranslation}>"{bl[4]}"</div>}
                  <button style={S.blankNext} onClick={nextBlank}>Next →</button>
                </div>
              )}
            </div>
            <div style={S.blankStatsRow}>Score: {blankStats.got}/{blankStats.seen}</div>
            {done && (
              <div style={S.sessionDone}>
                <p style={S.doneText}>Session complete! {blankStats.got}/{blankStats.seen} ({Math.round(blankStats.got/Math.max(blankStats.seen,1)*100)}%)</p>
                <button style={S.resetSBtn} onClick={() => { setBlankIdx(0); setBlankInput(""); setBlankResult(null); setBlankStats({seen:0,got:0}); }}>Start Over</button>
              </div>
            )}
          </>
        ) : (
          <div style={S.empty}><div style={{fontSize:48}}>📝</div><p>No questions in this category.</p></div>
        )}
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
                    {feedbackState === "submitting" && <span style={S.feedbackStatus}>Submitting…</span>}
                    {feedbackState === "submitted" && (
                      <div style={S.feedbackSubmitted}>
                        <span>✓ Thanks — we'll review this.</span>
                        <button style={S.nextAfterFeedback} onClick={() => rate(false)}>Next →</button>
                      </div>
                    )}
                    {feedbackState === "error" && <span style={S.feedbackError}>Failed to submit. Try again?</span>}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div style={S.typeInputRow}>
                  <input ref={studyInputRef} style={S.typeInput} value={typedAnswer} onChange={e => setTypedAnswer(e.target.value)} onKeyDown={e => { if (e.key === "Enter") checkTyped(); }} placeholder={!card.flippable ? "Type the answer…" : (card.shownDir==="fr" ? "Type English meaning…" : "Type French…")} autoFocus />
                  <button style={S.typeSubmit} onClick={checkTyped} disabled={!typedAnswer.trim()}>Check</button>
                </div>
                <div style={S.showAnswerRow}>
                  <button style={S.showAnswerBtn} onClick={() => { setFlipped(true); setTypeResult("wrong"); setTimeout(() => rate(false), 1800); }}>Show answer (skip)</button>
                </div>
              </>
            )
          ) : (
            <>
              <div style={S.rateRow}>
                <button style={S.missBtn} onClick={() => rate(false)}>✗ Again</button>
                <button style={S.gotBtn} onClick={() => rate(true)}>✓ Got It</button>
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
    </div>
  );
}

// ─── FEEDBACK ADMIN VIEW ─────────────────────────────────────────────────
// Shows pending feedback submissions with the LLM's verdict. Admin can
// approve (adds answer as a card alternate) or reject (marks reviewed).
function FeedbackAdminView({ user, setMode, resetSession }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("pending"); // 'pending' | 'all'

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from("feedback_submissions")
      .select("*")
      .order("created_at", { ascending: false });
    if (filter === "pending") q = q.eq("status", "pending");
    const { data, error } = await q;
    if (error) { console.error("Load feedback failed:", error); setItems([]); }
    else setItems(data || []);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const approve = async (item) => {
    // Insert alternate
    const { error: altErr } = await supabase.from("card_alternates").insert({
      card_id: item.card_id,
      direction: item.direction,
      alternate_text: item.user_answer,
      source_feedback_id: item.id,
    });
    if (altErr && altErr.code !== "23505") { // 23505 = unique_violation (already exists)
      console.error("Insert alternate failed:", altErr);
      alert("Failed to add alternate: " + altErr.message);
      return;
    }
    // Mark reviewed
    const { error: updErr } = await supabase
      .from("feedback_submissions")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", item.id);
    if (updErr) { console.error(updErr); return; }
    load();
  };

  const reject = async (item) => {
    const { error } = await supabase
      .from("feedback_submissions")
      .update({ status: "rejected", reviewed_at: new Date().toISOString() })
      .eq("id", item.id);
    if (error) { console.error(error); return; }
    load();
  };

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div>
          <h1 style={S.title}>Feedback Review</h1>
          <p style={S.sub}>{items.length} {filter === "pending" ? "pending" : "total"} submissions</p>
        </div>
      </div>
      <div style={S.nav}>
        {[["study","Cards"],["blank","Fill-in"],["stats","Stats"],["feedback","Feedback"]].map(([m,label]) => (
          <button key={m} style={m==="feedback" ? {...S.navBtn,...S.navActive} : S.navBtn} onClick={() => { if (m !== "feedback") { setMode(m); resetSession(); } }}>{label}</button>
        ))}
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        <button style={filter === "pending" ? {...S.catBtn,...S.catBtnA} : S.catBtn} onClick={() => setFilter("pending")}>Pending</button>
        <button style={filter === "all" ? {...S.catBtn,...S.catBtnA} : S.catBtn} onClick={() => setFilter("all")}>All</button>
        <button style={S.catBtn} onClick={load}>Refresh</button>
      </div>
      {loading ? (
        <div style={S.loading}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={S.empty}><div style={{ fontSize:48 }}>📭</div><p>No submissions.</p></div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {items.map(item => (
            <div key={item.id} style={S.feedbackCard}>
              <div style={S.feedbackMeta}>
                <span>{item.user_email}</span>
                <span>{new Date(item.created_at).toLocaleString()}</span>
              </div>
              <div style={S.feedbackCardBody}>
                <div style={S.feedbackLine}><b>Card ({item.direction === "fr" ? "FR→EN" : "EN→FR"}):</b> {item.card_front}</div>
                <div style={S.feedbackLine}><b>Expected:</b> {item.card_back}</div>
                <div style={{...S.feedbackLine, color:"#2d6a4f", fontWeight:600 }}><b style={{ color:"#1a1a1a", fontWeight:700 }}>User typed:</b> {item.user_answer}</div>
                {item.llm_verdict ? (
                  <div style={{
                    ...S.feedbackLlm,
                    background: item.llm_verdict === "accept" ? "#e8f5ed" : item.llm_verdict === "reject" ? "#fce8e6" : "#fff4e0",
                    borderColor: item.llm_verdict === "accept" ? "#2d6a4f" : item.llm_verdict === "reject" ? "#c44536" : "#b8860b",
                  }}>
                    <b>Claude's verdict: {item.llm_verdict}</b>
                    <div>{item.llm_reasoning}</div>
                  </div>
                ) : (
                  <div style={{ ...S.feedbackLlm, color:"#888", background:"#f5f5f5" }}>Awaiting LLM review…</div>
                )}
              </div>
              {item.status === "pending" ? (
                <div style={S.feedbackActions}>
                  <button style={S.gotBtn} onClick={() => approve(item)}>✓ Approve</button>
                  <button style={S.missBtn} onClick={() => reject(item)}>✗ Reject</button>
                </div>
              ) : (
                <div style={{ padding:"8px 12px", fontSize:12, color:"#888" }}>
                  {item.status} on {item.reviewed_at ? new Date(item.reviewed_at).toLocaleString() : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── AUDIO COMPONENTS ────────────────────────────────────────────────────

// Small button group inside the card: speaker + mic
function AudioToolbar({ onSpeak, onMic, recState, sttAvailable }) {
  const isRecording = recState === "recording";
  return (
    <div style={S.audioToolbar}>
      <button
        style={S.speakBtn}
        onClick={onSpeak}
        title="Listen to French pronunciation"
        aria-label="Listen"
      >🔊</button>
      {sttAvailable && (
        <button
          style={isRecording ? {...S.micBtn, ...S.micBtnActive} : S.micBtn}
          onClick={onMic}
          title={isRecording ? "Stop recording" : "Practice your pronunciation"}
          aria-label={isRecording ? "Stop" : "Practice pronunciation"}
        >{isRecording ? "⏹" : "🎤"}</button>
      )}
    </div>
  );
}

// Full pronunciation result panel below the card
function PronunciationPanel({ recState, result, error, referenceText, onCancel, onRetry, onSpeakWord, onDismiss }) {
  // Recording state — show timer + stop hint
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
          <span>⚠ {error || "Something went wrong"}</span>
          <div style={S.pronActions}>
            <button style={S.pronBtn} onClick={onRetry}>Try again</button>
            <button style={S.pronBtnGhost} onClick={onDismiss}>Dismiss</button>
          </div>
        </div>
      </div>
    );
  }

  if (recState === "result" && result) {
    const overall = result.pronunciation ?? result.accuracy ?? 0;
    return (
      <div style={S.pronPanel}>
        <div style={S.pronHeader}>
          <div style={S.pronScoreBlock}>
            <div style={{...S.pronScoreBig, color: scoreColor(overall)}}>{overall}</div>
            <div style={S.pronScoreLabel}>overall</div>
          </div>
          <div style={S.pronSubScores}>
            <ScoreCell label="accuracy" value={result.accuracy} />
            <ScoreCell label="fluency" value={result.fluency} />
            <ScoreCell label="completeness" value={result.completeness} />
          </div>
        </div>
        {result.words && result.words.length > 0 && (
          <div style={S.pronWords}>
            {result.words.map((w, i) => (
              <button
                key={i}
                style={{
                  ...S.pronWordChip,
                  borderColor: scoreColor(w.accuracy),
                  color: scoreColor(w.accuracy),
                }}
                onClick={() => onSpeakWord(w.word)}
                title={`${w.word}: ${w.accuracy}/100${w.errorType !== "None" ? " — " + w.errorType : ""}. Tap to hear it.`}
              >
                {w.word}
                <span style={S.pronWordScore}>{w.accuracy}</span>
              </button>
            ))}
          </div>
        )}
        {result.transcribed && result.transcribed.toLowerCase() !== referenceText.toLowerCase() && (
          <div style={S.pronTranscript}>
            heard: <i>"{result.transcribed}"</i>
          </div>
        )}
        <div style={S.pronActions}>
          <button style={S.pronBtn} onClick={onRetry}>🎤 Try again</button>
          <button style={S.pronBtnGhost} onClick={onDismiss}>Done</button>
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

// ─── STYLES ──────────────────────────────────────────────────────────────
const S = {
  container: { maxWidth:560, margin:"0 auto", padding:"20px 16px 40px", fontFamily:"'Georgia','Garamond',serif", color:"#1a1a1a" },
  loading: { textAlign:"center", padding:60, fontFamily:"'Georgia',serif", color:"#666", fontSize:18 },
  header: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 },
  userInfo: { display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3 },
  userEmail: { fontSize:10, color:"#999", fontFamily:"system-ui,sans-serif", maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  signOutBtn: { background:"none", border:"1px solid #ddd", borderRadius:6, padding:"3px 8px", fontSize:10, color:"#888", cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  title: { fontSize:24, fontWeight:700, margin:0, letterSpacing:"-0.5px", color:"#0a0a0a" },
  sub: { fontSize:12, color:"#888", margin:"4px 0 0", fontFamily:"system-ui,sans-serif" },
  nav: { display:"flex", gap:4, marginBottom:14, background:"#f5f3ef", borderRadius:12, padding:3 },
  navBtn: { flex:1, padding:"8px 0", border:"none", borderRadius:10, background:"transparent", fontSize:13, fontFamily:"system-ui,sans-serif", cursor:"pointer", color:"#777", fontWeight:500, transition:"all 0.15s" },
  navActive: { background:"#fff", color:"#111", fontWeight:700, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  filters: { marginBottom:16 },
  catRow: { display:"flex", gap:5, flexWrap:"wrap", marginBottom:8 },
  catBtn: { padding:"5px 12px", border:"1.5px solid #ddd", borderRadius:20, background:"#fafafa", fontSize:12, cursor:"pointer", fontFamily:"system-ui,sans-serif", color:"#555", transition:"all 0.15s" },
  catBtnA: { background:"#fff", borderColor:"#333", color:"#111", fontWeight:600 },
  toggleRow: { display:"flex", gap:12, alignItems:"center", flexWrap:"wrap" },
  toggle: { display:"flex", gap:5, alignItems:"center", cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif", color:"#666" },
  dirGroup: { display:"flex", gap:0, marginLeft:"auto", background:"#f5f3ef", borderRadius:8, padding:2 },
  dirBtn: { padding:"4px 9px", border:"none", borderRadius:6, background:"transparent", fontSize:11, fontFamily:"system-ui,sans-serif", cursor:"pointer", color:"#888", fontWeight:500 },
  dirBtnA: { background:"#fff", color:"#111", fontWeight:700, boxShadow:"0 1px 3px rgba(0,0,0,0.08)" },
  langBadge: { position:"absolute", top:12, right:14, fontSize:10, color:"#aaa", fontFamily:"system-ui,sans-serif", letterSpacing:0.5, fontWeight:600 },
  counter: { textAlign:"center", fontSize:12, color:"#999", marginBottom:8, fontFamily:"system-ui,sans-serif", letterSpacing:1 },
  counterRow: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8, gap:8 },
  backBtn: { background:"none", border:"1px solid #ddd", borderRadius:8, padding:"4px 10px", fontSize:11, color:"#666", cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  backBtnSpacer: { width:55 },
  cardWrap: { perspective:1000, cursor:"pointer", marginBottom:16 },
  card: { position:"relative", width:"100%", minHeight:240, transformStyle:"preserve-3d", transition:"transform 0.45s cubic-bezier(0.4,0,0.2,1)" },
  cardFront: { position:"absolute", inset:0, backfaceVisibility:"hidden", background:"linear-gradient(145deg,#fefefe,#f7f5f0)", border:"1.5px solid #e0dcd4", borderRadius:14, padding:"26px 22px", display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:"0 3px 16px rgba(0,0,0,0.05)" },
  cardBack: { position:"absolute", inset:0, backfaceVisibility:"hidden", transform:"rotateY(180deg)", background:"linear-gradient(145deg,#f0f4f0,#e8ede6)", border:"1.5px solid #c5cfc0", borderRadius:14, padding:"26px 22px", display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:"0 3px 16px rgba(0,0,0,0.05)" },
  cardCat: { position:"absolute", top:12, left:16, display:"flex", alignItems:"center", gap:5, fontSize:10, color:"#888", fontFamily:"system-ui,sans-serif", textTransform:"uppercase", letterSpacing:1 },
  dot: { width:7, height:7, borderRadius:"50%", display:"inline-block" },
  freqTag: { background:"#fff3cd", color:"#856404", padding:"1px 6px", borderRadius:10, fontSize:10, fontWeight:600, marginLeft:3 },
  cardText: { fontSize:22, fontWeight:500, textAlign:"center", lineHeight:1.4, padding:"18px 0" },
  cardTextB: { fontSize:18, textAlign:"center", lineHeight:1.5, padding:"18px 0", color:"#2d4a3e", fontFamily:"system-ui,sans-serif" },
  hint: { position:"absolute", bottom:12, fontSize:10, color:"#bbb", fontFamily:"system-ui,sans-serif" },
  dateH: { position:"absolute", bottom:12, fontSize:10, color:"#8a9a85", fontFamily:"system-ui,sans-serif" },
  rateRow: { display:"flex", gap:10, justifyContent:"center", marginBottom:6 },
  missBtn: { flex:1, maxWidth:180, padding:"12px 0", border:"2px solid #e0c4c0", borderRadius:12, background:"#fdf5f4", color:"#a63d2f", fontSize:15, fontWeight:600, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  gotBtn: { flex:1, maxWidth:180, padding:"12px 0", border:"2px solid #b8d4b0", borderRadius:12, background:"#f2f8f0", color:"#2d6a4f", fontSize:15, fontWeight:600, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  shortcuts: { textAlign:"center", fontSize:10, color:"#bbb", fontFamily:"system-ui,sans-serif", marginBottom:16 },
  empty: { textAlign:"center", padding:"50px 20px", color:"#888" },
  resetSBtn: { padding:"9px 22px", border:"1.5px solid #ddd", borderRadius:10, background:"#fff", cursor:"pointer", fontSize:13, fontFamily:"system-ui,sans-serif", marginTop:8 },
  sessionDone: { textAlign:"center", padding:"18px", background:"#f8faf7", borderRadius:12, border:"1px solid #dde6d9", marginTop:8 },
  doneText: { margin:"0 0 8px", fontSize:14, fontFamily:"system-ui,sans-serif", color:"#2d6a4f" },
  // Stats
  statsGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 },
  statCard: { padding:"16px 12px", border:"1.5px solid #ddd", borderRadius:12, textAlign:"center", background:"#fafafa" },
  statNum: { fontSize:28, fontWeight:700, color:"#1a1a1a" },
  statLabel: { fontSize:11, color:"#888", fontFamily:"system-ui,sans-serif", marginTop:3, textTransform:"uppercase", letterSpacing:0.5 },
  pBarOut: { height:7, background:"#eee", borderRadius:4, overflow:"hidden", marginBottom:5 },
  pBarIn: { height:"100%", background:"linear-gradient(90deg,#2d6a4f,#52b788)", borderRadius:4, transition:"width 0.4s" },
  pText: { fontSize:12, color:"#666", textAlign:"center", fontFamily:"system-ui,sans-serif", marginBottom:24 },
  subT: { fontSize:16, fontWeight:600, margin:"0 0 10px", color:"#333" },
  catStats: { marginBottom:24, display:"flex", flexDirection:"column", gap:6 },
  catStatRow: { display:"flex", alignItems:"center", gap:8, padding:"7px 10px", background:"#fafafa", borderRadius:8, fontFamily:"system-ui,sans-serif", fontSize:13 },
  freqList: { display:"flex", flexDirection:"column", gap:5, marginBottom:24 },
  freqItem: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 10px", background:"#fffcf0", border:"1px solid #f0e8d0", borderRadius:8, fontSize:13 },
  freqWord: { fontFamily:"'Georgia',serif", fontStyle:"italic" },
  freqBadge: { background:"#fff3cd", color:"#856404", padding:"1px 8px", borderRadius:10, fontSize:11, fontWeight:700 },
  resetBtn: { display:"block", width:"100%", padding:"11px", border:"1.5px solid #e0c4c0", borderRadius:10, background:"#fdf5f4", color:"#a63d2f", fontSize:13, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  // Blank mode
  blankCard: { background:"linear-gradient(145deg,#fefefe,#f7f5f0)", border:"1.5px solid #e0dcd4", borderRadius:14, padding:"28px 22px", marginBottom:16, boxShadow:"0 3px 16px rgba(0,0,0,0.05)" },
  blankSentence: { fontSize:20, fontWeight:500, textAlign:"center", lineHeight:1.6, marginBottom:12 },
  blankSlot: { display:"inline", padding:"2px 4px", borderBottom:"2px solid #c44536", color:"#c44536", fontWeight:700, minWidth:60 },
  blankHint: { textAlign:"center", fontSize:12, color:"#999", fontFamily:"system-ui,sans-serif", marginBottom:16, fontStyle:"italic" },
  blankInputRow: { display:"flex", gap:8, justifyContent:"center" },
  blankInput: { flex:1, maxWidth:260, padding:"10px 14px", border:"1.5px solid #ddd", borderRadius:10, fontSize:16, fontFamily:"'Georgia',serif", outline:"none" },
  blankSubmit: { padding:"10px 20px", border:"none", borderRadius:10, background:"#2d6a4f", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  blankFeedback: { textAlign:"center" },
  blankCorrect: { fontSize:18, fontWeight:700, color:"#2d6a4f", marginBottom:12 },
  blankWrong: { fontSize:16, fontWeight:600, color:"#c44536", marginBottom:12 },
  blankTranslation: { fontSize:14, color:"#666", fontStyle:"italic", fontFamily:"'Georgia',serif", marginBottom:14, marginTop:-4 },
  blankNext: { padding:"10px 24px", border:"1.5px solid #ddd", borderRadius:10, background:"#fff", cursor:"pointer", fontSize:14, fontFamily:"system-ui,sans-serif" },
  blankStatsRow: { textAlign:"center", fontSize:12, color:"#888", fontFamily:"system-ui,sans-serif", marginBottom:8 },
  // Type mode (study input)
  typeInputRow: { display:"flex", gap:8, justifyContent:"center", marginBottom:8 },
  typeInput: { flex:1, maxWidth:280, padding:"11px 14px", border:"1.5px solid #ddd", borderRadius:10, fontSize:15, fontFamily:"'Georgia',serif", outline:"none", background:"#fff" },
  typeSubmit: { padding:"11px 22px", border:"none", borderRadius:10, background:"#2d6a4f", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  // Audio: speak/mic toolbar inside the card
  audioToolbar: { marginTop:10, display:"flex", gap:8, justifyContent:"center" },
  speakBtn: { background:"none", border:"1.5px solid #c5cfc0", borderRadius:20, padding:"6px 14px", fontSize:16, cursor:"pointer", lineHeight:1, color:"#2d6a4f" },
  micBtn: { background:"none", border:"1.5px solid #c5cfc0", borderRadius:20, padding:"6px 14px", fontSize:16, cursor:"pointer", lineHeight:1, color:"#2d6a4f", transition:"all 0.15s" },
  micBtnActive: { background:"#fde8e8", borderColor:"#c44536", color:"#c44536", animation:"pulse 1.2s infinite" },
  // Pronunciation result panel below the card
  pronPanel: { marginTop:14, marginBottom:14, padding:"16px 18px", background:"#fff", border:"1.5px solid #e0dcd4", borderRadius:14, fontFamily:"system-ui,sans-serif", boxShadow:"0 2px 12px rgba(0,0,0,0.04)" },
  pronRecordingRow: { display:"flex", alignItems:"center", gap:12, fontSize:14, color:"#c44536", fontWeight:500 },
  pronRecordingDot: { width:14, height:14, borderRadius:"50%", background:"#c44536", animation:"pulse 1s infinite", flexShrink:0 },
  pronStopBtn: { marginLeft:"auto", background:"#c44536", color:"#fff", border:"none", borderRadius:8, padding:"6px 14px", fontSize:12, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  pronProcessing: { display:"flex", alignItems:"center", gap:12, color:"#666", fontSize:14 },
  spinner: { width:16, height:16, border:"2px solid #ddd", borderTopColor:"#2d6a4f", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  pronError: { display:"flex", flexDirection:"column", gap:12, color:"#c44536", fontSize:13 },
  pronHeader: { display:"flex", alignItems:"center", gap:18, marginBottom:14 },
  pronScoreBlock: { display:"flex", flexDirection:"column", alignItems:"center", minWidth:64 },
  pronScoreBig: { fontSize:42, fontWeight:700, lineHeight:1, fontFamily:"'Georgia',serif" },
  pronScoreLabel: { fontSize:10, color:"#888", textTransform:"uppercase", letterSpacing:0.5, marginTop:2 },
  pronSubScores: { display:"flex", gap:14, flex:1, flexWrap:"wrap" },
  scoreCell: { display:"flex", flexDirection:"column", alignItems:"flex-start" },
  scoreCellNum: { fontSize:18, fontWeight:600, lineHeight:1 },
  scoreCellLabel: { fontSize:9, color:"#888", textTransform:"uppercase", letterSpacing:0.5, marginTop:2 },
  pronWords: { display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 },
  pronWordChip: { background:"#fff", border:"1.5px solid", borderRadius:16, padding:"5px 11px", fontSize:13, cursor:"pointer", fontFamily:"system-ui,sans-serif", display:"inline-flex", alignItems:"center", gap:6, fontWeight:500 },
  pronWordScore: { fontSize:10, opacity:0.7, fontWeight:600 },
  pronTranscript: { fontSize:11, color:"#888", marginBottom:10, fontStyle:"italic" },
  pronActions: { display:"flex", gap:8, justifyContent:"flex-end" },
  pronBtn: { background:"#2d6a4f", color:"#fff", border:"none", borderRadius:8, padding:"7px 14px", fontSize:12, cursor:"pointer", fontWeight:500, fontFamily:"system-ui,sans-serif" },
  pronBtnGhost: { background:"none", color:"#666", border:"1.5px solid #ddd", borderRadius:8, padding:"7px 14px", fontSize:12, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  showAnswerRow: { textAlign:"center", marginBottom:12 },
  showAnswerBtn: { background:"none", border:"none", color:"#888", fontSize:11, fontFamily:"system-ui,sans-serif", cursor:"pointer", textDecoration:"underline" },
  // Feedback button shown after a wrong/close answer in typing mode
  feedbackRow: { textAlign:"center", marginTop:6, marginBottom:6 },
  feedbackBtn: { background:"none", border:"1px solid #c4a373", borderRadius:6, padding:"6px 12px", fontSize:11, fontFamily:"system-ui,sans-serif", color:"#8b6914", cursor:"pointer" },
  feedbackStatus: { fontSize:11, color:"#888", fontFamily:"system-ui,sans-serif" },
  feedbackError: { fontSize:11, color:"#c44536", fontFamily:"system-ui,sans-serif" },
  feedbackSubmitted: { display:"flex", flexDirection:"column", alignItems:"center", gap:8, fontSize:12, color:"#2d6a4f", fontFamily:"system-ui,sans-serif" },
  nextAfterFeedback: { background:"#2d6a4f", color:"#fff", border:"none", borderRadius:6, padding:"6px 14px", fontSize:12, cursor:"pointer", fontFamily:"system-ui,sans-serif" },
  // Admin feedback review view
  feedbackCard: { background:"#fff", border:"1.5px solid #e0dcd4", borderRadius:12, overflow:"hidden" },
  feedbackMeta: { display:"flex", justifyContent:"space-between", padding:"8px 14px", background:"#f5f1e8", fontSize:11, color:"#888", fontFamily:"system-ui,sans-serif", borderBottom:"1px solid #e0dcd4" },
  feedbackCardBody: { padding:"14px", display:"flex", flexDirection:"column", gap:8, fontSize:13, fontFamily:"system-ui,sans-serif" },
  feedbackLine: { lineHeight:1.5 },
  feedbackLlm: { padding:"10px 12px", borderRadius:8, border:"1.5px solid", marginTop:4, fontSize:12, lineHeight:1.5 },
  feedbackActions: { display:"flex", gap:8, padding:"10px 14px", borderTop:"1px solid #f0ede5" },
  typeFeedback: { textAlign:"center", marginBottom:12, minHeight:40 },
  typeCorrect: { display:"inline-block", padding:"10px 20px", borderRadius:10, background:"#f2f8f0", border:"2px solid #b8d4b0", color:"#2d6a4f", fontSize:16, fontWeight:700, fontFamily:"system-ui,sans-serif" },
  typeClose: { display:"inline-block", padding:"10px 18px", borderRadius:10, background:"#fdf8e6", border:"2px solid #e9c46a", color:"#8a6d10", fontSize:14, fontWeight:600, fontFamily:"system-ui,sans-serif", maxWidth:"95%" },
  typeWrong: { display:"inline-block", padding:"10px 20px", borderRadius:10, background:"#fdf5f4", border:"2px solid #e0c4c0", color:"#a63d2f", fontSize:15, fontWeight:600, fontFamily:"system-ui,sans-serif", maxWidth:"95%" },
};
