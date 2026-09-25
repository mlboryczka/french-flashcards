import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { RAW } from "./data/cards"; // only used for the admin "seed demo deck" action
import { LESSONS, lessonIdOf, lessonRank, cardInstructionFor, lessonBackFor } from "./data/lessons";
import { reconcileLessons } from "./lib/lessonSync";
import LessonPanel, { LESSON_PANEL_WIDTH } from "./LessonPanel";
import { useProgress } from "./useProgress";
import { cleanFrenchPrompt, cleanEnglishPrompt, dropFinalPeriod } from "./lib/cardText";
import { drillAlternates, isConjugationDrill } from "./lib/cardInstruction";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";
import { classifyCard, CARD_TYPES, TYPE_LABEL, TYPE_COLOR } from "./lib/cardTypes";
import { useUserDeck } from "./useUserDeck";
import { useCahierSync } from "./useCahierSync";
import { supabase } from "./supabase";
import { CahierUpload } from "./CahierUpload";
import { CahierLink } from "./CahierLink";
import { BetaFeedback } from "./BetaFeedback";
import ApiKeyModal from "./ApiKeyModal";
import { keyHeaders, hasKey } from "./lib/anthropicKey";

const SIDEBAR_WIDTH = 256;
// The sidebar can be minimized to a rail of icons. Remembered per browser.
const SIDEBAR_MIN_WIDTH = 64;
const SIDEBAR_MIN_KEY = "sidebar:minimized";
const SIDEBAR_TOGGLE_ICON = (minimized) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d={minimized ? "M14 10l2 2-2 2" : "M16 10l-2 2 2 2"} />
  </svg>
);
// Narrowest content column worth reflowing to.
//
// Measured, not guessed. The card is height-driven and 1.6:1, so in a 900px
// window it wants 375 tall and 600 wide; with mainInner's 40px of padding
// either side that is a 680px column. Give it less and the width caps while
// the height does not, and the card turns portrait — 404x375 at a 484px
// column, 340x375 at 420.
//
// The top bar used to go first — below about 700 the chips stopped fitting on
// one row and stacked — but they scroll now (.chip-row in styles.css), so the
// card is the only thing this floor is protecting.
const MIN_REFLOW_CONTENT = 680;
import ChatPanel, { CHAT_PANEL_WIDTH } from "./ChatPanel";
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
import { CAT_UI_TO_DB } from "./lib/cardCategories";
import { localISODate, reviewedToday, endOfLocalDay, startOfLocalDay } from "./lib/studyDay";
import { progressByArea, progressChanges, aboutRemembered, summarize, areaDates } from "./lib/progress";
import { buildSession, applyAnswer, placeRetry, countBuckets } from "./lib/sessionQueue";
import { RE_QUEUE_OFFSET, State } from "./lib/spacedRepetition";
import { sideOf, sideColumns, directionsOf, isTwoWay, itemKey, resetColumns } from "./lib/directions";
import { newReviewId, reviewRow } from "./lib/reviewLog";

const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL || "").toLowerCase();

// Feature flag: hide the pronunciation assessment UI (mic button + results
// panel) without removing any code. The Azure backend, audio.js parser, and
// PronunciationPanel component all stay in place — they just don't render.
// Flip to `true` to bring it back.
const PRONUNCIATION_ENABLED = false;

// Cards are labelled by the three types in lib/cardTypes (grammar / word /
// phrase), derived from the four storage categories plus the shape of the
// French side. Storage stays 4-way. This is labelling only — it is
// deliberately not a study filter (see the session effect for why).

// ─── STORAGE ─────────────────────────────────────────────────────────────
// (progress is now handled by the useProgress hook via Supabase)

// ─── ANSWER MATCHING (fuzzy, gender-aware) ───────────────────────────────
// Strip accents, lowercase, remove parentheticals and punctuation
function normalize(s) {
  return s.toLowerCase()
    // Most keyboards have no œ or æ key: "une soeur" is how "une sœur" gets
    // typed, and it was marked wrong (2 edits on a short word, limit 0).
    .replace(/œ/g, "oe").replace(/æ/g, "ae")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, "")
    // Curly quotes too: phones type ’, so "d’un air" and "d'un air" differ
    // by a character the reader can't see.
    .replace(/[.,!?;:""''«»’‘“”…]/g, "")
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
// Remove every parenthetical, nested or unclosed: "je suis allé (I went
// (passé)" never closes its outer group, and an unclosed group runs to the end.
function stripParens(s) {
  let out = String(s || "");
  let prev;
  do { prev = out; out = out.replace(/\([^()]*\)/g, " "); } while (out !== prev);
  return out.replace(/\(.*$/, " ").replace(/\)/g, " ").replace(/\s+/g, " ").trim();
}
// Match typed answer against correct answer, handling alternatives and fuzz.
//
// `exact` turns the fuzz off: the typed answer must equal one of the
// alternatives once case, accents, punctuation and parentheses are set aside.
// It is for French-answered grammar drills, where the typo tolerance accepted
// exactly the mistakes being drilled — "je vend" for je vends, "il dois" for
// il doit, "que j'aie" for que j'aille, chères and chèrement for cher,
// évidamment for évidemment — and a "Close enough" counts as remembered.
function matchAnswer(typed, correct, extraAlts = [], { exact = false } = {}) {
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
    //
    // Parentheticals go BEFORE the split. "seul (only; sole)" used to split on
    // the semicolon inside its own gloss into "seul (only" and "sole)", neither
    // of which normalize() could clean, so typing "seul" was marked wrong.
    const slashParts = (stripParens(src) || src).split(/\//).map(s => s.trim()).filter(Boolean);
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

  if (exact) {
    // Only "/" separates answers here. The comma/semicolon split above is for
    // glosses, and in an exact answer a comma is part of it: "Oui, j'y vais"
    // split into "Oui" and "j'y vais" would accept "oui" and refuse the whole.
    const squash = (x) => normalize(x).replace(/\s+/g, " ").trim();
    const pool = sources.flatMap((src) => { const x = stripParens(src) || src; return [x, ...x.split("/")]; });
    return { match: pool.some((alt) => squash(alt) && squash(alt) === squash(t)) };
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

// The columns an answer changes, as they stood before it — so a corrected
// grade can be recomputed from the card as it was, not from the answer being
// replaced.
const STUDY_MODE_KEY = "study-mode";

// An answer's place in the block, for telling a correction from a first
// answer. A retry is its own slot; otherwise it is the card asked that way
// round, because both ways of one card can be in the same block.
const slotKeyOf = (entry) => (entry._retry ? `retry:${entry._rid}` : `card:${itemKey(entry)}`);

// The two groups of cards from the student's own classes (areaOf in
// lib/progress.js). Both come from the same notebook; what separates them is
// only how long ago the class was. They were "Your recent classes" and "Your
// earlier notes", which read as two different kinds of thing.
const AREA_LABEL = Object.freeze({ recent: "Last two weeks of class", earlier: "Older classes" });

// "Your class of 24 September: 31 new cards" — said in classes, because that
// is what the student recognises, with the count second.
// What linking a cahier did, said in classes rather than in lessons parsed.
function uploadDoneText({ cardsInserted = 0, datesCovered = 0 }) {
  if (cardsInserted === 0) {
    return "Your cahier is linked. Nothing new to add yet — every class in it is already in your deck.\n\nFrom now on, each class Laura adds becomes cards on its own.";
  }
  return `Your cahier is linked.\n\n${cardsInserted} cards from ${datesCovered} ${datesCovered === 1 ? "class" : "classes"} you hadn't studied yet. They join your deck as new cards, so they arrive once your reviews are done.\n\nFrom now on, each class Laura adds becomes cards on its own.`;
}

function cahierArrivalText({ dates = [], cards = 0 } = {}) {
  const asDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  const when = dates.length === 0 ? "Your cahier"
    : dates.length === 1 ? `Your class of ${asDay(dates[0])}`
    : `Your classes from ${asDay(dates[0])} to ${asDay(dates[dates.length - 1])}`;
  return `${when}: ${cards.toLocaleString()} new ${cards === 1 ? "card" : "cards"} added to your deck.`;
}


// A typed answer counts as recalled unless the user gave up ("revealed") or
// got it wrong. Shared by the Continue button and by tapping the card, which
// does the same thing.
function typedGotIt(typeResult) {
  // "wrongArticle" is NOT recall.
  //
  // It used to be, which meant the banner said "✗ Wrong article" and the
  // scheduler was then told you knew the card and pushed it further out. The
  // matcher is deliberately strict about French gender — `articlesCompatible`
  // refuses le/la and un/une outright — and grading it as a hit threw away the
  // one distinction it was being strict about, quietly teaching the wrong
  // gender. If you disagree on a given card, the "should have been accepted"
  // link is still right there.
  return typeResult === "correct" || typeResult === "close";
}

export default function FlashcardApp({ user, onSignOut }) {
  const { progress, loaded: progressLoaded, updateCard, resetAll: resetAllProgress } = useProgress(user);
  const { cards: userCards, loaded: deckLoaded, reload: reloadDeck, patch: patchDeckCard, patchAll: patchAllDeckCards, add: addDeckCard } = useUserDeck(user);
  // The linked cahier, read again when the app opens: a class taught after
  // the last visit is already cards by the time the student studies.
  const cahier = useCahierSync(user);
  // Cards that arrived from it are only in the database until the deck is
  // read again. They then reach the student the way any new card does — the
  // scheduler deals them once due work runs out, most recent class first.
  const arrivedRef = useRef(null);
  useEffect(() => {
    if (!cahier.arrived || arrivedRef.current === cahier.arrived) return;
    arrivedRef.current = cahier.arrived;
    reloadDeck();
  }, [cahier.arrived, reloadDeck]);
  const loaded = progressLoaded && deckLoaded;
  const [deck, setDeck] = useState([]);
  const [sessionCounts, setSessionCounts] = useState({ lapse: 0, review: 0, new: 0, spot: 0 });
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const skipFlipAnim = useRef(false); // temporarily disables the card flip transition
  // Tracks the currently-displayed entry (card and way round, itemKey) so the deck-build effect can
  // preserve the user's position when userCards re-references on a
  // background refetch (e.g. when the browser tab regains focus). Without
  // this, every refetch reshuffles and snaps the user back to card 0.
  const currentCardIdRef = useRef(null);
  // Signature of the filters/direction the current deck was built from.
  // The deck-build effect uses this to tell "filters changed, fresh
  // session" apart from "userCards re-referenced, just patch in place".
  const filterSigRef = useRef(null);
  const [mode, setMode] = useState("study"); // study | stats | feedback
  // seen/got/missed count TYPED answers only — those are verifiable, and
  // accuracy built from self-reported flips would be meaningless. `answered`
  // counts every graded card in either mode, so the end-of-session summary
  // has something true to say when nothing was typed.
  // firstAnswered/firstGot count each card's FIRST answer of the day, in
  // either mode — what the checkpoint reports as "right first time". A retry
  // or a card revisited with Previous card is not a first answer.
  const [stats, setStats] = useState({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
  // Bumped by Continue to deal the next block from the deck already in memory.
  const [blockSeq, setBlockSeq] = useState(0);
  // Progress when the current block was dealt, so the checkpoint can say what
  // the block changed.
  const blockStartRef = useRef(null);
  // Each card answered in this block, per way round: the shown direction's
  // FSRS state before the answer that was recorded (null if nothing was
  // recorded), the grade given, and the id of its answer record. Lets Previous
  // card correct a grade rather than be ignored. Cleared per block.
  const blockAnswersRef = useRef(new Map());
  // The queue has been worked to the end. Not derivable from `idx` alone:
  // idx sits on the last card both before and after that card is answered.
  const [sessionDone, setSessionDone] = useState(false);
  // Study one type at a time. Off ("all") by default: mixing types is
  // interleaved practice and tests better than drilling one kind in a block.
  // But when you know your conjugations are the weak spot, being able to sit
  // on them for a session is worth more than the interleaving penalty.
  const [typeFilter, setTypeFilter] = useState("all");
  // Study one lesson's cards instead of the whole deck. "all" is everything.
  // Like typeFilter this narrows the candidate pool the session is built
  // from, so the lesson still schedules through FSRS normally.
  const [lessonFilter, setLessonFilter] = useState("all");
  const [dir, setDir] = useState("mix"); // fr | en | mix
  // The direction setting as blocks are dealt, read through a ref so that
  // changing it does not deal a new block (see the effect on `dir`).
  const dirRef = useRef(dir);
  // Typing is the default: it is checked, so FSRS gets real evidence, and
  // producing the answer is what makes it stick. The student's last choice is
  // remembered on this browser.
  const [typeMode, setTypeMode] = useState(() => {
    try { return localStorage.getItem(STUDY_MODE_KEY) !== "flip"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(STUDY_MODE_KEY, typeMode ? "type" : "flip"); } catch { /* storage blocked */ }
  }, [typeMode]);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [typeResult, setTypeResult] = useState(null); // null | 'correct' | 'wrong'
  const studyInputRef = useRef(null);

  // Upload & onboarding state
  const [showUpload, setShowUpload] = useState(false);
  const [showCahierLink, setShowCahierLink] = useState(false);
  const [uploadInitialTab, setUploadInitialTab] = useState("paste");
  // Tutor chat slide-over — global, so it opens from any view.
  const [showChat, setShowChat] = useState(false);
  // Feedback panel. Its open state lives here rather than inside BetaFeedback
  // so it and the tutor can be kept mutually exclusive. It opens inside the
  // sidebar, into `feedbackDock`, so the page never has to make room for it.
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackDock, setFeedbackDock] = useState(null);
  // Minimized sidebar: icons only, no labels, no lesson sub-items. The feedback
  // panel opens INSIDE the sidebar and needs its full width to write in, so
  // opening it widens the sidebar, and closing it puts the sidebar back the
  // way it was.
  const [sidebarMin, setSidebarMin] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_MIN_KEY) === "1"; } catch { return false; }
  });
  const widenedForFeedback = useRef(false);
  const setSidebarMinimized = useCallback((v) => {
    widenedForFeedback.current = false;
    setSidebarMin(v);
    try { localStorage.setItem(SIDEBAR_MIN_KEY, v ? "1" : "0"); } catch { /* storage blocked: still toggles */ }
  }, []);
  // Bumped by the flag on the card, so the panel opens with that card attached.
  const [feedbackAttachReq, setFeedbackAttachReq] = useState(0);

  // Only one panel at a time: two overlapping surfaces fighting for the same
  // screen is worse than either alone. Opening the tutor just puts the
  // feedback sheet away — the sheet keeps its draft when it closes, so there
  // is nothing to ask about. (This used to route through a close request on
  // the sheet, so an unsent draft could prompt "discard?" and cancel the
  // tutor opening.)
  // The tutor always knows the card on screen, live, with where the student is
  // with it — see `tutorCard` below. Opening it FROM a card ("Ask the tutor"
  // after a miss) additionally bumps this, so a conversation about some other
  // card is put away for a fresh one.
  //
  // This used to be a snapshot of the card carrying `last_answer_correct:
  // false`, because the miss isn't on the row until the answer is committed.
  // The live typed result says the same thing, and says what was typed.
  const [tutorThread, setTutorThread] = useState(null);
  const openChat = useCallback((aboutCard = null) => {
    setShowFeedback(false);
    setShowLessonPanel(false);
    if (aboutCard) setTutorThread((t) => ({ id: (t?.id || 0) + 1, rowId: aboutCard.row_id ?? null }));
    setShowChat(true);
  }, []);
  const toggleChat = useCallback(() => {
    if (showChat) { setShowChat(false); return; }
    setShowFeedback(false);
    setShowLessonPanel(false);
    setShowChat(true);
  }, [showChat]);
  const openFeedback = useCallback(() => {
    setShowChat(false);
    setShowLessonPanel(false);
    // Widen for the panel without touching the saved preference.
    setSidebarMin((min) => { if (min) widenedForFeedback.current = true; return false; });
    setShowFeedback(true);
  }, []);
  useEffect(() => {
    if (!showFeedback && widenedForFeedback.current) {
      widenedForFeedback.current = false;
      setSidebarMin(true);
    }
  }, [showFeedback]);
  const reportCard = useCallback(() => { openFeedback(); setFeedbackAttachReq((n) => n + 1); }, [openFeedback]);
  // Three panels share the right-hand slot; opening one puts the others away.
  const toggleLessonPanel = useCallback(() => {
    setShowLessonPanel((v) => {
      if (!v) { setShowChat(false); setShowFeedback(false); }
      return !v;
    });
  }, []);
  const [showLessonPanel, setShowLessonPanel] = useState(false);

  // Leaving a lesson closes its notes.
  //
  // These are two pieces of state and only the first was ever cleared, by both
  // the chip's × and the Cards nav item. The panel then vanished — it renders
  // nothing without a lesson — while the page went on reserving the 460px it
  // had made for it: a dead strip down the right side with nothing in it, and
  // no way back, because the "Lesson notes" toggle only exists while a lesson
  // is selected. One function so a third caller can't reintroduce it.
  const leaveLesson = useCallback(() => {
    setLessonFilter("all");
    setShowLessonPanel(false);
  }, []);

  // Entering one. The type chips are hidden inside a lesson, so a filter left
  // over from the wider deck would go on narrowing the session with nothing on
  // screen to say so and no way to clear it. One function, so a third caller
  // can't reintroduce that.
  const enterLesson = useCallback((id) => {
    setTypeFilter("all");
    setLessonFilter(id);
    setMode("study");
  }, []);
  // "Connect your Claude account". Everything that calls Claude bills the
  // caller's own Anthropic key now, so there has to be somewhere to put one.
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileRef = useRef(null);

  // Close the profile menu on an outside click or Escape. Mousedown rather
  // than click so the menu is gone before whatever was underneath reacts,
  // and containment rather than a target check so clicks on the menu's own
  // items still run their handlers.
  useEffect(() => {
    if (!showProfileMenu) return;
    const onDown = (e) => {
      if (profileRef.current && profileRef.current.contains(e.target)) return;
      setShowProfileMenu(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setShowProfileMenu(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [showProfileMenu]);

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
  // The actual width too, because whether a panel can reflow the page is a
  // question about how much room is LEFT, not about phone versus desktop.
  const [winWidth, setWinWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1400
  );
  // Coalesced to one update per frame. A drag fires resize dozens of times a
  // second and each one re-rendered this entire component; rAF collapses a
  // burst into the single measurement that matters, which is the last one.
  useEffect(() => {
    let frame = null;
    const onResize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setIsNarrow(window.innerWidth < 768);
        setWinWidth(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  // The feedback panel lives in the desktop sidebar, which the narrow layout
  // doesn't have. Left "open" across that change, nothing would show it but
  // `overlayOpen` would go on swallowing the card's keyboard shortcuts.
  useEffect(() => {
    if (isNarrow) setShowFeedback(false);
  }, [isNarrow]);

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
  const [feedbackErrMsg, setFeedbackErrMsg] = useState("");
  const [feedbackVerdict, setFeedbackVerdict] = useState(null); // {verdict, reasoning}
  const autoAdvanceTimer = useRef(null);
  const isAdmin = !!(user?.email && user.email.toLowerCase() === ADMIN_EMAIL);

  // Load card alternates from Supabase on mount (and when user changes)
  useEffect(() => {
    if (!user) return;
    (async () => {
      // Scoped to the owner. This used to select the whole table: alternates
      // had no user_id and RLS let every signed-in user read every row, so
      // one person's accepted answer loosened everyone's grading. See
      // migration_008.
      const { data, error } = await supabase
        .from("card_alternates")
        .select("card_id, direction, alternate_text")
        .eq("user_id", user.id);
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
  //
  // Selection is spaced-repetition driven: the working set comes from
  // buildSession (lapses → due reviews → new once those run out → spot-checks).
  //
  // There is deliberately no category filter. Studying one category at a time
  // is blocked practice, which feels easier during the session and tests worse
  // afterwards; mixing card types is interleaved practice, worth about g=0.42
  // in Brunmair & Richter's (2019) meta-analysis of 59 studies. FSRS has no
  // opinion on categories either — it schedules on memory state alone — so a
  // filter here could only make sessions worse.
  // The cards a block may be drawn from: the whole deck, or one lesson's or
  // one type's when the student has narrowed it.
  const candidatesFrom = useCallback((cards) => {
    let candidates = cards;
    if (typeFilter !== "all") candidates = candidates.filter(c => classifyCard(c) === typeFilter);
    if (lessonFilter !== "all") candidates = candidates.filter(c => lessonIdOf(c) === lessonFilter);
    return candidates;
  }, [typeFilter, lessonFilter]);

  useEffect(() => {
    if (!loaded) return;
    // Direction is not part of this: changing it re-deals the cards still to
    // come (see the effect below) instead of dealing a new block, which threw
    // away the block's running count and a missed card's pending retry.
    const filterSig = `${typeFilter}|${lessonFilter}`;
    const filterChanged = filterSigRef.current !== filterSig;
    filterSigRef.current = filterSig;

    const candidates = candidatesFrom(userCards);

    // Mid-session userCards refetch (card edit/delete, background reload,
    // Supabase token refresh). Rebuilding here would reshuffle the queue,
    // drop already-answered cards, lose in-session retries, and snap the
    // counter to wherever the current card lands in the new ordering.
    // Instead, patch each card's fields in place by row_id and drop any
    // that were deleted — session order, idx, and retries stay intact.
    if (!filterChanged && deck.length > 0) {
      const byRow = new Map(candidates.map(c => [c.row_id, c]));
      const patched = deck
        .map(c => {
          const u = byRow.get(c.row_id);
          // A card edited into grammar is asked only as written: its English-
          // side entry would record to a state the card no longer uses.
          if (!u || (c.shownDir === "en" && !isTwoWay(u))) return null;
          return { ...u, shownDir: c.shownDir, flippable: isTwoWay(u), _bucket: c._bucket, _retry: c._retry, _rid: c._rid };
        })
        .filter(Boolean);
      setDeck(patched);
      setIdx(i => Math.min(i, Math.max(0, patched.length - 1)));
      return;
    }

    // Full rebuild: initial mount, filter/direction change, or resetSession
    // (which clears deck so the next refetch takes this branch).
    // Inside a lesson, new cards come in the lesson's teaching order; outside,
    // from the student's notes, recent classes first. See orderNewCards.
    // Each entry is a card asked one way round; the direction setting decides
    // which ways of words and phrases are dealt. Grammar and pronunciation
    // cards are rules with examples, not translations — always shown as
    // written, whatever the setting.
    const { queue: cards, counts } = buildSession(candidates, {
      direction: dirRef.current,
      lessonMode: lessonFilter !== "all",
      lessonRank,
    });
    blockStartRef.current = progressByArea(userCards);

    // A full rebuild is a NEW block — first load, a filter or direction
    // change, Continue — so it starts at card 1 with nothing counted yet.
    //
    // If the card on screen is in the new block, it moves to the front so it
    // doesn't vanish from under the student. This used to jump to wherever
    // that card landed in the shuffled block instead, which on entering a
    // lesson could start the student at card 35 of 50: the first 34 were
    // skipped, and the checkpoint came after 16 answers. Tracked by row_id
    // (DB pk) because card.id is derived from front text and changes whenever
    // the admin edits the French side — and by the way round, because the
    // same card can be in the new block both ways.
    const preservedKey = currentCardIdRef.current;
    const preservedIdx = preservedKey != null
      ? cards.findIndex(c => itemKey(c) === preservedKey)
      : -1;
    if (preservedIdx > 0) cards.unshift(cards.splice(preservedIdx, 1)[0]);
    else if (preservedIdx < 0) setFlipped(false);
    blockAnswersRef.current = new Map();
    setDeck(cards);
    setSessionCounts(counts);
    setIdx(0);
    // A rebuilt queue is unworked, whatever the last one's state was.
    setSessionDone(false);
    setStats({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, typeFilter, lessonFilter, userCards, blockSeq]);

  const card = deck[idx];

  // What the checkpoint after a block shows. Computed once when the block
  // ends (and again if the deck changes under it), never per answer.
  //   changes   the areas the block moved: seen and about-remembered deltas
  //   next      the block Continue would deal, to say "reviews only" or
  //             "all caught up" before the student presses anything
  //   waiting   inside a lesson, cards due today elsewhere in the deck
  const checkpoint = useMemo(() => {
    if (!sessionDone) return null;
    const now = Date.now();
    const after = progressByArea(userCards, now);
    const changes = blockStartRef.current ? progressChanges(blockStartRef.current, after) : [];
    const next = buildSession(candidatesFrom(userCards), {
      now,
      direction: dir,
      lessonMode: lessonFilter !== "all",
      lessonRank,
    });
    const endToday = endOfLocalDay(new Date(now));
    // Counted the way the student is studying: in EN→FR, a word due only
    // French side up is not waiting for them.
    const dueToday = (side) => (side.fsrs_state ?? State.New) !== State.New && !!side.next_due_at &&
      new Date(side.next_due_at).getTime() <= endToday;
    let waiting = 0;
    if (lessonFilter !== "all") {
      for (const c of userCards) {
        if (lessonIdOf(c) === lessonFilter) continue;
        for (const d of directionsOf(c)) {
          if (isTwoWay(c) && dir !== "mix" && d !== dir) continue;
          if (dueToday(sideOf(c, d))) waiting++;
        }
      }
    }
    return { after, changes, next, waiting };
  }, [sessionDone, userCards, candidatesFrom, lessonFilter, dir]);
  // Keep the ref in sync so deck rebuilds can find the current card.
  useEffect(() => { currentCardIdRef.current = card ? itemKey(card) : null; }, [card]);
  // The card on screen as the tutor needs it: what it asks, and whether its
  // answer has been shown. Until it has, the tutor's header shows only the
  // prompt and the tutor is told not to give the answer away — a recall FSRS
  // records after the tutor said the word is a recall that never happened.
  //
  // "Answered" sticks for this appearance of the card: flip it back over and
  // the answer has still been seen. Keyed on the queue position as well as
  // the row, so the same card re-queued after a miss starts unanswered again.
  const cardSlot = card ? `${idx}:${itemKey(card)}` : null;
  const [revealedSlot, setRevealedSlot] = useState(null);
  useEffect(() => {
    if (cardSlot && (flipped || typeResult)) setRevealedSlot(cardSlot);
  }, [cardSlot, flipped, typeResult]);
  // Switching between flipping and typing once this card's answer has been
  // seen waits for the next card. Switching reset the card, so the answer
  // could be seen one way and then given the other: flip, switch to typing,
  // type what you just read, and FSRS recorded a recall that never happened;
  // or "Show answer" (a miss), switch to flipping, and press Got It. Before
  // the answer is seen, the switch is immediate.
  const [pendingTypeMode, setPendingTypeMode] = useState(null);
  const answerSeen = !!card && (flipped || !!typeResult || revealedSlot === cardSlot);
  // Whether a typed answer counts as recalled: the matcher's verdict, or a
  // "my answer should be accepted" dispute that was accepted. An accepted
  // dispute used to save the alternate for next time and still record today's
  // answer as a miss, because Continue read only the matcher's verdict.
  const disputeAccepted =
    feedbackState === "accepted" ||
    (feedbackState === "submitted" && feedbackVerdict?.verdict === "accept");
  const typedRecalled = typedGotIt(typeResult) || disputeAccepted;

  // Changing direction applies to the cards still to come — and to the card on
  // screen only if its answer hasn't been seen, for the same reason as the
  // flip/type switch. It used to deal a new block, and then to turn the
  // remaining cards round; neither works now each way round is its own entry
  // with its own schedule (the other way may already be in the block, or
  // answered today).
  //
  // So the rest of the block is re-dealt under the new setting. Entries it
  // still asks stay where they are, as does anything already answered; the
  // others are replaced from the deck, by the same rules as any block. The
  // block keeps its count, its length where the deck allows, and its retries.
  useEffect(() => {
    if (dirRef.current === dir) return;
    dirRef.current = dir;
    if (!deck.length || sessionDone) return;
    const firstOpen = answerSeen ? idx + 1 : idx;
    const asked = (c) => !c.flippable || dir === "mix" || c.shownDir === dir;
    const head = deck.slice(0, firstOpen);
    const tail = deck.slice(firstOpen);
    const kept = new Set(tail.filter((c) => asked(c) || blockAnswersRef.current.has(slotKeyOf(c))));
    const room = tail.length - kept.size;
    const fill = room > 0
      ? buildSession(candidatesFrom(userCards), {
          direction: dir,
          target: room,
          spotCheckSlots: 0,
          lessonMode: lessonFilter !== "all",
          lessonRank,
          inBlock: [...head, ...kept],
        }).queue
      : [];
    let f = 0;
    const next = [...head, ...tail.map((c) => (kept.has(c) ? c : fill[f++])).filter(Boolean)];
    setDeck(next);
    setSessionCounts(countBuckets(next));
    if (next.length <= idx) {
      // Nothing left to ask this way round: the block ends where it is.
      setIdx(Math.max(0, next.length - 1));
      if (next.length > 0) setSessionDone(true);
    }
    if (!answerSeen) setTypedAnswer("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);
  const directionPending =
    !!card && card.flippable && answerSeen && !sessionDone && dir !== "mix" && card.shownDir !== dir;
  useEffect(() => {
    if (pendingTypeMode === null) return;
    setTypeMode(pendingTypeMode);
    setPendingTypeMode(null);
  // Apply on the NEXT card (or the checkpoint), never on the one it was asked on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardSlot, sessionDone]);
  const toggleTypeMode = () => {
    const target = pendingTypeMode === null ? !typeMode : !pendingTypeMode;
    if (answerSeen && !sessionDone) {
      // Pressing again before the next card cancels the pending switch.
      setPendingTypeMode(target === typeMode ? null : target);
      return;
    }
    setPendingTypeMode(null);
    setTypeMode(target);
    setTypedAnswer("");
    setTypeResult(null);
    setFlipped(false);
  };

  const tutorCard = useMemo(() => {
    // After the last card of a block the checkpoint replaces it on screen.
    if (mode !== "study" || !card || sessionDone) return null;
    const answered = flipped || !!typeResult || revealedSlot === cardSlot;
    return {
      ...card,
      answered,
      ...(typeResult ? { result: typeResult } : null),
      ...(typeResult && typeResult !== "revealed" && typedAnswer.trim()
        ? { typed: typedAnswer.trim() }
        : null),
    };
  }, [mode, card, sessionDone, flipped, typeResult, typedAnswer, revealedSlot, cardSlot]);
  const flip = useCallback(() => setFlipped(f => !f), []);

  // Auto-speak French when a French side becomes visible
  useEffect(() => {
    if (!autoSpeak || !card || mode !== "study") return;
    const isFrenchVisible =
      (card.shownDir === "fr" && !flipped) || (card.shownDir === "en" && flipped);
    if (isFrenchVisible) {
      // Slight delay so the speech starts after the flip animation
      const t = setTimeout(() => speakFrench(cleanFrenchPrompt(card.f, card.b)), 200);
      return () => clearTimeout(t);
    }
  }, [autoSpeak, card, flipped, mode]);

  // Speak French manually (button handler)
  const speakCard = useCallback(() => {
    if (card) speakFrench(cleanFrenchPrompt(card.f, card.b));
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


  // Answer handling: update progress + spaced-repetition state.
  //
  // Two parallel updates per answer:
  //   1. card_progress (legacy score/seen/got) — still drives the Stats view.
  //   2. user_cards spaced-rep fields (box, next_due_at, lapses) — drives
  //      session selection on the next deck build.
  //
  // Wrong answers also re-queue the card later in the same session so the
  // user gets another shot before the session ends.
  // Saving an answer, visibly. The write to user_cards used to be
  // fire-and-forget with its error sent to the console: the screen moved on as
  // if it had saved, and a reload brought the card back with the answer gone.
  // Now a failed write is kept and retried, with backoff, and the student is
  // told while any answer is unsaved.
  //
  // Each write is kept under a key, and a newer write under the same key
  // replaces an older one waiting to be retried. A schedule's key is the card
  // AND the way round it was asked — keyed by the card alone, a French-side
  // answer waiting to be retried was replaced by an English-side answer to the
  // same card, and lost. An answer's record is keyed by its own id. `answer`
  // groups an answer's writes, so the notice counts answers, not writes.
  const unsavedRef = useRef(new Map()); // key -> { answer, send, failed }
  const [unsavedCount, setUnsavedCount] = useState(0);
  const retryTimerRef = useRef(null);
  const retryDelayRef = useRef(3000);
  const countFailed = () =>
    setUnsavedCount(new Set([...unsavedRef.current.values()].filter((e) => e.failed).map((e) => e.answer)).size);
  const attemptSave = async (key, entry) => {
    const { error } = await entry.send();
    if (unsavedRef.current.get(key) !== entry) return; // superseded by a newer write
    if (error) {
      console.error("Saving an answer failed:", key, error);
      entry.failed = true;
      countFailed();
      if (!retryTimerRef.current) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          retryDelayRef.current = Math.min(retryDelayRef.current * 2, 60000);
          for (const [k, e] of unsavedRef.current) attemptSave(k, e);
        }, retryDelayRef.current);
      }
    } else {
      unsavedRef.current.delete(key);
      if (unsavedRef.current.size === 0) retryDelayRef.current = 3000;
      countFailed();
    }
  };
  // `send` makes a fresh request each time: a retry sends it again.
  const save = (key, answer, send) => {
    const entry = { answer, send, failed: false };
    unsavedRef.current.set(key, entry);
    attemptSave(key, entry);
  };
  // Leaving with answers unsaved asks first.
  useEffect(() => {
    if (!unsavedCount) return;
    const onLeave = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [unsavedCount]);
  useEffect(() => () => clearTimeout(retryTimerRef.current), []);

  const answer = (got, source = "flip") => {
    if (!card) return;
    // Once the queue is worked out the last card stays on screen behind the
    // completion panel. Grading it again would write a second FSRS review for
    // a card that was answered once, so the session end is a hard stop.
    if (sessionDone) return;
    // Whether this answer empties the queue. Read BEFORE the wrong-answer
    // splice below, which grows the deck by one and would hide the end.
    const wasLastCard = idx >= deck.length - 1;
    const prev = progress[card.id] || { score:0, seen:0, got:0 };
    const newProg = {
      score: Math.max(0, Math.min(5, prev.score + (got?1:-1))),
      seen: prev.seen + 1,
      got: prev.got + (got?1:0),
    };
    // NOT awaited. updateCard writes local state synchronously and only the
    // Supabase upsert is async, so awaiting it held the whole advance —
    // including setIdx below — behind a network round trip. The card sat
    // there for exactly as long as the write took. The other two writes in
    // this function were already fire-and-forget; this one was the outlier.
    // updateCard logs its own failures and never throws.
    updateCard(card.id, newProg);

    // Spaced-repetition update — the FIRST answer of the day only. A retry,
    // or a card revisited with Previous card, is still shown and still
    // graded on screen, but FSRS already has today's answer for it; see
    // reviewedToday() for what recording a second one did to the schedule.
    //
    // Optimistic local deck patch first so the in-memory card carries today's
    // last_review into its retry; DB update is fire-and-forget (errors
    // logged, not surfaced).
    //
    // A card answered again with Previous card is a CORRECTION, not a second
    // review: if its first answer in this block was the one recorded, the new
    // grade replaces it, recomputed from the card's state before that answer.
    // Without this, a mistaken Got It stood — the day's answer was already in,
    // so the corrected Again was shown and never recorded. Retries are never
    // corrections; they stay practice.
    //
    // Everything here is for the way round the card was SHOWN: "la pomme → ?"
    // is recorded to the French-side state and "apple → ?" to the English-side
    // one, and the other is never touched. applyAnswer returns only the shown
    // direction's columns, so patching every entry for this card with them is
    // right even when the block holds it both ways.
    const cardDir = card.shownDir ?? "fr";
    const slotKey = slotKeyOf(card);
    const earlier = blockAnswersRef.current.get(slotKey);
    const isCorrection = !!earlier;
    const answeredAt = Date.now();
    let recordsReview = false;
    let sr = null;
    if (isCorrection) {
      if (earlier.before && earlier.got !== got) {
        sr = applyAnswer({ ...card, ...earlier.before }, got, answeredAt, cardDir);
      }
    } else {
      recordsReview = !card._retry && !reviewedToday(sideOf(card, cardDir).last_review);
      if (recordsReview) sr = applyAnswer(card, got, answeredAt, cardDir);
    }
    const before = isCorrection ? earlier.before : recordsReview ? sideColumns(sideOf(card, cardDir), cardDir) : null;
    const reviewId = isCorrection ? earlier.reviewId : newReviewId();
    blockAnswersRef.current.set(slotKey, { before, got, reviewId });
    if (sr) {
      setDeck(prev => prev.map(c =>
        c.row_id === card.row_id ? { ...c, ...sr } : c
      ));
      // And the deck the next block is built from — see patch() in useUserDeck.
      patchDeckCard(card.row_id, sr);
      if (card.row_id != null) {
        save(`card:${itemKey(card)}`, reviewId, () => supabase.from("user_cards").update(sr).eq("id", card.row_id));
      }
    }
    // The record of the answer: every answer, counted or not. A correction
    // rewrites the same record, and only if the grade changed.
    if (card.row_id != null && user?.id && (!isCorrection || earlier.got !== got)) {
      const row = reviewRow({
        id: reviewId, userId: user.id, cardId: card.row_id, dir: cardDir, got,
        before, after: before ? sr : null, at: answeredAt,
      });
      save(`review:${reviewId}`, reviewId, () => supabase.from("card_reviews").upsert(row, { onConflict: "id" }));
    }
    // Record today's review date for streak tracking.
    // Write to Supabase (persists across devices) and update local state so
    // the streak UI reflects it immediately without a refetch.
    const todayISO = localISODate();
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
    // Accuracy counts typed answers only — those are verifiable, and a
    // flip-mode "got it" is self-reported. `answered` counts both, so the
    // end of a flip-only session still has something true to report.
    // A correction changes the block's count of right answers, never its count
    // of answers: the checkpoint's "50 answers" is the block's own length.
    const recordedBefore = isCorrection && !!earlier.before;
    setStats(s => ({
      ...s,
      answered: s.answered + (isCorrection ? 0 : 1),
      firstAnswered: s.firstAnswered + (recordsReview ? 1 : 0),
      firstGot: s.firstGot + (recordsReview && got ? 1 : 0)
        + (recordedBefore ? (got ? 1 : 0) - (earlier.got ? 1 : 0) : 0),
      ...(source === "typed"
        ? { seen: s.seen+1, got: s.got+(got?1:0), missed: s.missed+(got?0:1) }
        : null),
    }));
    // Wrong answers: the card comes back RE_QUEUE_OFFSET cards later, INSIDE
    // the block, taking the place of the block's last unseen card — see
    // placeRetry. The block never grows past its length. Splice runs after
    // setDeck above so we use the post-SR-patch deck.
    if (!got && !(isCorrection && earlier.got === false)) {
      setDeck(prev =>
        // A correction to a miss gets a retry only if the card has none coming.
        prev.slice(idx + 1).some((c) => c._retry && itemKey(c) === itemKey(card))
          ? prev
          : placeRetry(prev, idx, { ...card, ...(sr || {}), _rid: Math.random().toString(36).slice(2) }, RE_QUEUE_OFFSET)
      );
    }

    // Skip the un-flip animation — snap instantly to the next card's front
    skipFlipAnim.current = true;
    setFlipped(false);
    setTypeResult(null);
    setTypedAnswer("");
    setFeedbackState(null); setFeedbackVerdict(null);
    // Cap at last index. The block's length never changes (a retry replaces
    // an unseen card), so the last card stays put, and `sessionDone` below is
    // what turns that into a visible end — the clamp alone can't, since idx
    // reads the same before and after the last card is answered.
    setIdx(i => Math.min(i + 1, deck.length - 1));
    // Any answer to the last card ends the block. A miss there has no room
    // for a retry; it is due again tomorrow, first in that day's block.
    if (wasLastCard) setSessionDone(true);
    // Re-enable the flip animation on the next frame
    requestAnimationFrame(() => { skipFlipAnim.current = false; });
  };

  // Submit typed answer
  const submitTyped = () => {
    if (!card || !typedAnswer.trim()) return;
    const correctText = card.shownDir === "fr" ? card.b : card.f;
    const altKey = `${card.id}:${card.shownDir}`;
    // A French-answered drill ("vivre → je", "relatif → adverbe") is marked
    // exactly; see matchAnswer. An "il/elle" drill takes either pronoun, and
    // a subjunctive is right with or without its que.
    // Only a real drill or a lesson card: a leftover rule card with an arrow
    // ("si + imparfait → conditionnel") has English prose for an answer.
    const drill = card.shownDir === "fr" && String(card.f || "").includes("→") &&
      (isConjugationDrill(card.f) || !!lessonIdOf(card));
    const extraAlts = [
      ...(alternates[altKey] || []),
      ...(drill ? drillAlternates(card.f, card.b) : []),
      // The lesson's current answer, which a deck synced before a lesson
      // widened it doesn't have on its row.
      ...(card.shownDir === "fr" ? [lessonBackFor(card)].filter(Boolean) : []),
    ];
    const result = matchAnswer(typedAnswer, correctText, extraAlts, { exact: drill });
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
    // Stepping back puts an answerable card on screen again, so the session
    // is no longer over.
    setSessionDone(false);
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
    // Clear the deck so the userCards refetch below takes the full-rebuild
    // branch instead of patching the now-stale in-memory session in place.
    // Without this, "New Session" would re-show the cards you just finished
    // (patched but still in old order) until the next filter change.
    setDeck([]);
    setSessionCounts({ lapse: 0, review: 0, new: 0, spot: 0 });
    currentCardIdRef.current = null;
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
    setSessionDone(false);
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null); setFeedbackVerdict(null);
    // Refetch user_cards so the new session sees fresh box / next_due_at
    // values written by the previous session's answer() updates.
    reloadDeck();
  };

  // Continue, from the checkpoint: deal the next block from the deck already in
  // memory, which carries every answer just given. resetSession refetches
  // instead, and a refetch can land before the last answers' writes do.
  const startNextBlock = () => {
    setIdx(0);
    setDeck([]);
    setSessionCounts({ lapse: 0, review: 0, new: 0, spot: 0 });
    currentCardIdRef.current = null;
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
    setSessionDone(false);
    setTypedAnswer("");
    setTypeResult(null);
    setFeedbackState(null); setFeedbackVerdict(null);
    setBlockSeq(n => n + 1);
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

  // Anything layered over the study view. While one of these is up the card
  // is not what the keyboard is addressing: pressing Enter to submit in a
  // modal, or after clicking anywhere in the tutor that isn't its textarea,
  // used to fall through and grade the card behind it as "Got It" — a real
  // FSRS review, written for a card the user never saw an answer for.
  // Checking the event target for INPUT/TEXTAREA isn't enough; most of a
  // panel is neither.
  //
  // The tutor is the exception when it sits BESIDE the card rather than over
  // it. It is built for studying with it open — it follows you from card to
  // card — and treating it as an overlay left Space, Enter and the arrows dead
  // the whole time. Beside the card it only takes the keyboard while it is
  // what you are using: focus inside it, or your last click was in it (the
  // inert-click case above, where focus falls to the body).
  const roomToReflow = (panelWidth) =>
    winWidth - (sidebarMin ? SIDEBAR_MIN_WIDTH : SIDEBAR_WIDTH) - panelWidth >= MIN_REFLOW_CONTENT;
  const chatReflow = showChat && !isNarrow && roomToReflow(CHAT_PANEL_WIDTH);
  const lessonReflow = showLessonPanel && !isNarrow && roomToReflow(LESSON_PANEL_WIDTH);
  const overlayOpen =
    (showChat && !chatReflow) || showFeedback || showUpload || showKeyModal || showLessonPanel ||
    showProfileMenu || showFeedbackModal || showUsersModal || editingCard != null;
  const pointerInTutorRef = useRef(false);
  useEffect(() => {
    // click as well as pointerdown: a click from the keyboard or assistive
    // tech arrives with no pointer event in front of it.
    const onDown = (e) => {
      pointerInTutorRef.current = !!e.target?.closest?.("[data-tutor-panel]");
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onDown, true);
    };
  }, []);
  // The ✕ is a click inside the panel; closing must not leave the keys held.
  useEffect(() => { if (!showChat) pointerInTutorRef.current = false; }, [showChat]);
  const tutorHasKeyboard = () =>
    pointerInTutorRef.current || !!document.activeElement?.closest?.("[data-tutor-panel]");

  useEffect(() => {
    if (mode !== "study" || typeMode || overlayOpen || sessionDone) return;
    const handler = (e) => {
      if (!card) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (tutorHasKeyboard()) return;
      if (e.key === " ") { e.preventDefault(); flipRef.current(); }
      // A card is only graded once its answer has been seen. Before that the
      // grading keys turn it over instead — they used to record Got It (or
      // Again) on a card whose answer was never on screen.
      else if (!answerSeen && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Enter")) {
        e.preventDefault(); flipRef.current();
      }
      else if (e.key === "ArrowLeft") { e.preventDefault(); answerRef.current(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); answerRef.current(true); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [card, mode, typeMode, overlayOpen, sessionDone, answerSeen]);

  // In type mode, after a result is showing (input gone), Enter/Space/→
  // auto-commits the matcher's verdict and advances to the next card.
  // The matcher's verdict is the progress update — no self-report needed.
  useEffect(() => {
    if (mode !== "study" || !typeMode || !typeResult || overlayOpen || sessionDone) return;
    // One rule, one place. This was a second copy of typedGotIt's logic, so
    // the two could — and did — disagree about what counts as recall.
    const gotIt = typedRecalled;
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (tutorHasKeyboard()) return;
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        answerRef.current(gotIt, "typed");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, typeMode, typeResult, typedRecalled, overlayOpen, sessionDone]);

  // Submit a feedback claim: "my answer should have been accepted"

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
          ...keyHeaders(user?.id),
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
          ...keyHeaders(user?.id),
        },
        body: JSON.stringify({
          card_id: card.id,
          direction: card.shownDir,
          french: card.f,
          english: card.b,
          user_answer: typedAnswer,
          expected_answer: card.shownDir === "fr" ? card.b : card.f,
          // The server honours this now: it records the alternate without a
          // model call instead of re-running the review it just lost.
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

  // Every card back to not yet seen, both ways round, the legacy tally, and
  // the streak. Until 2026-09-14 this cleared only that tally (card_progress):
  // every card kept its FSRS schedule, so the button reset nothing a student
  // could see. The owner decided the same day that the streak goes too. The
  // record of past answers (card_reviews) is history, and stays.
  const resetAll = async () => {
    if (!confirm("Reset all of your progress? Every card goes back to not yet seen, and your streak starts again. This can't be undone.")) return;
    const reset = resetColumns();
    const { error } = await supabase.from("user_cards").update(reset).eq("user_id", user.id);
    if (error) {
      console.error("Reset failed:", error);
      alert("Your progress couldn't be reset, and nothing was changed. Please try again.");
      return;
    }
    // An answer still waiting to be saved would put its schedule back.
    for (const k of [...unsavedRef.current.keys()]) if (k.startsWith("card:")) unsavedRef.current.delete(k);
    countFailed();
    patchAllDeckCards(reset);
    await resetAllProgress();
    // The streak. Asked to return what it deleted: a delete that row security
    // refuses reports success and removes nothing, and the streak would
    // quietly survive the reset.
    const hadDays = reviewDates.size > 0;
    const { data: cleared, error: streakError } = await supabase
      .from("user_review_dates").delete().eq("user_id", user.id).select("review_date");
    if (streakError || (hadDays && !(cleared || []).length)) {
      console.error("Clearing the streak failed:", streakError || "no rows deleted");
      alert("Your cards were reset, but your streak couldn't be cleared.");
    } else {
      setReviewDates(new Set());
    }
    resetSession();
  };

  // ── SEED DEMO DECK (admin only) ─────────────────────────────────────
  // Bulk-inserts RAW into user_cards for the current user. Preserves
  // categories (vocab/expr/gram/pron → V/E/G/P) and dates so Matt's existing
  // card_progress rows continue to match via the lowercased-front id.
  // Keep every lesson's cards in step with the lesson itself.
  //
  // Lessons are part of the app, not something a student uploads: a new
  // account should find L'impératif already in its deck. And because the
  // lesson is the authority, this also removes cards it no longer contains —
  // otherwise an earlier version's mistakes live on in the deck of everyone
  // who added it. That is how the eight "state the rule" cards, which asked
  // things like "L'impératif a combien de personnes ?" with nothing to type,
  // outlived being deleted from the source.
  //
  // Runs once per mount, and only writes when there is a difference, so the
  // usual case costs one comparison and no network.
  const lessonsSynced = useRef(false);
  useEffect(() => {
    if (!user || !deckLoaded || lessonsSynced.current) return;
    lessonsSynced.current = true;
    (async () => {
      const { missing, rekey, retext, stale, unkeyed, taken } = reconcileLessons(LESSONS, userCards);
      if (taken.length) {
        // The deck already has its own card with that front; the lesson card
        // would have overwritten it. See reconcileLessons.
        console.info(`[lessons] ${taken.length} lesson card(s) skipped; the deck has its own:`, taken.map((t) => t.front));
      }
      if (unkeyed.length) {
        // Written before lesson cards had a stable key, and matching nothing in
        // the lesson now. That is either a card the lesson retired or one the
        // user corrected, and there is no way to tell which — so it stays.
        console.info(
          `[lessons] ${unkeyed.length} unkeyed card(s) match no lesson card; left alone:`,
          unkeyed.map((c) => c.f)
        );
      }
      if (!missing.length && !rekey.length && !retext.length && !stale.length) return;
      const owned = (rows) => rows.map((r) => ({ ...r, user_id: user.id }));
      try {
        if (missing.length) {
          const { error } = await supabase
            .from("user_cards")
            .upsert(owned(missing), { onConflict: "user_id,front" });
          if (error) throw error;
        }
        if (rekey.length) {
          const { error } = await supabase
            .from("user_cards")
            .upsert(owned(rekey), { onConflict: "user_id,front" });
          if (error) throw error;
        }
        for (const r of retext) {
          const { error } = await supabase
            .from("user_cards")
            .update({ front: r.front, back: r.back })
            .eq("id", r.row_id)
            .eq("user_id", user.id);
          if (error) throw error;
        }
        if (stale.length) {
          const { error } = await supabase
            .from("user_cards")
            .delete()
            .in("id", stale)
            .eq("user_id", user.id);
          if (error) throw error;
        }
        console.info(
          `[lessons] synced: +${missing.length} card(s), ${rekey.length} re-keyed, ${retext.length} renamed, ` +
            `-${stale.length} retired`
        );
        reloadDeck();
      } catch (e) {
        // A lesson that cannot sync is not worth blocking the app for; the
        // deck the student already has still works.
        console.error("Lesson sync failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, deckLoaded]);

  // addLesson() lived here: it copied a lesson's cards into the deck for an
  // "Add" button that no longer exists, because the sync above puts every
  // lesson in every deck on load. Nothing had called it since.

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
          seen.set(key, { front: f, back: b, category: CAT_UI_TO_DB[cat] || "V", dates: [...dates] });
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
  /**
   * Update a card via the admin endpoint and log the diff to the
   * corrections ledger.
   *
   * @param {number} rowId — user_cards.id (bigint)
   * @param {string} newFront
   * @param {string} newBack
   * @param {{originalFront?: string, originalBack?: string, batchId?: string}} ctx
   *   Pre-edit values + batch_id passed straight from EditCardModal so we
   *   never re-look them up in React state (stale state was silently
   *   dropping the ledger log).
   */
  const saveCardEdit = async (rowId, newFront, newBack, ctx = {}) => {
    const trimmedFront = newFront.trim();
    const trimmedBack = newBack.trim();

    // Service-role endpoint bypasses RLS. row_id is the primary lookup;
    // original_front is a fallback when React state has lost row_id.
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/admin-update-card", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({
          row_id: rowId || null,
          original_front: ctx.originalFront || null,
          front: trimmedFront,
          back: trimmedBack,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        console.error("Card update failed:", body);
        // For known 4xx errors (duplicate front, etc.) the server returns
        // a human-readable `error` string — surface it directly. Only fall
        // back to the noisy "HTTP N + raw response" dump for unexpected 5xx.
        const friendly = body && typeof body === "object" && body.error;
        if (res.status >= 400 && res.status < 500 && friendly) {
          alert(friendly);
        } else {
          alert(
            `Card update failed.\n` +
            `HTTP ${res.status}\n` +
            `Response: ${typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`
          );
        }
        return false;
      }
    } catch (e) {
      console.error("Card update network error:", e);
      alert(`Card update network error: ${e.message || e}`);
      return false;
    }

    // Fire-and-forget: log to the parse-corrections ledger every time a
    // save succeeds. No diff guard — the small cost of logging a no-op
    // save is nothing compared to the cost of silently swallowing logs
    // because the guard mis-fires.
    const frontChanged = ctx.originalFront !== trimmedFront;
    logCorrection({
      category: frontChanged
        ? CORRECTION_CATEGORIES.FRONT_TEXT_EDIT
        : CORRECTION_CATEGORIES.BACK_TEXT_EDIT,
      action: CORRECTION_ACTIONS.EDIT,
      card_id: rowId,
      batch_id: ctx.batchId || null,
      original_front: ctx.originalFront ?? null,
      original_back: ctx.originalBack ?? null,
      corrected_front: trimmedFront,
      corrected_back: trimmedBack,
    });

    reloadDeck();
    return true;
  };

  const deleteCard = async (rowId) => {
    const { error } = await supabase.from("user_cards").delete().eq("id", rowId);
    if (error) {
      console.error("Card delete failed:", error);
      return false;
    }
    // Reset answer state so the card that slides into this idx position on
    // the deck rebuild starts with a fresh prompt, not a stale verdict from
    // the card we just removed.
    setTypedAnswer("");
    setTypeResult(null);
    setFlipped(false);
    setFeedbackState(null);
    setFeedbackVerdict(null);
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
            <button data-tutor-toggle style={S.onbCard} onClick={() => openChat()}>
              <div style={S.onbCardIcon}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg>
              </div>
              <h3 style={S.onbCardTitle}>Ask the tutor</h3>
              <p style={S.onbCardDesc}>Look a word or phrase up and add the cards one at a time.</p>
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

        {/* A separate instance from the main app's, so the conversation
            lives in lib/tutorThreads rather than in either one: adding the
            first card from here swaps this screen for the main app. */}
        <ChatPanel
          open={showChat}
          onClose={() => setShowChat(false)}
          user={user}
          cards={userCards}
          onCardAdded={(row) => (row ? addDeckCard(row) : reloadDeck())}
          onCardUpdated={patchDeckCard}
          onNeedKey={() => setShowKeyModal(true)}
        />

        <ApiKeyModal
          open={showKeyModal}
          onClose={() => setShowKeyModal(false)}
          user={user}
        />

        <CahierUpload
          open={showUpload}
          user={user}
          onClose={() => setShowUpload(false)}
          hasExisting={false}
          initialTab={uploadInitialTab}
          onSuccess={(result) => {
            setShowUpload(false);
            reloadDeck();
            if (result.linked) return alert(uploadDoneText(result));
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
    lessons: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
    tutor: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.1 9a2.5 2.5 0 0 1 4.9.6c0 1.7-2.5 2.5-2.5 2.5"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>,
  };

  const navItems = [["study", "Cards"], ["lessons", "Lessons"], ["stats", "Stats"]];

  // Exactly one thing in the nav is ever marked.
  //
  // Studying a lesson is still mode "study", so Cards and the lesson under
  // Lessons were both lighting up — two selected items, which says nothing
  // about where you are. The most specific selection wins: pick a lesson and
  // only the lesson is marked; Cards means the whole deck.
  const navActive = (m) =>
    m === "study" ? mode === "study" && lessonFilter === "all" : mode === m;

  // Open the tutor panel and the app reflows to sit beside it rather than
  // being covered — you can still read the card you're asking about. Below
  // 768px there is no room to give, so the panel stays an overlay instead.
  // Reflow only while the content column stays usable.
  //
  // "Not a phone" was the wrong test. A 900px window is not narrow by that
  // rule, but 900 - 256 of sidebar - 460 of panel leaves 184px of column: the
  // card turns portrait and crushes and the answer row runs off the edge.
  // (The chips stacked one per line too, until they were made to scroll.) Below the floor the panel goes back to being
  // an overlay with a scrim, which is what it already does on a phone and what
  // it should always have done when there was nothing to reflow FOR.
  //
  // See MIN_REFLOW_CONTENT for where the floor comes from.
  // (roomToReflow, chatReflow and lessonReflow are computed further up, before
  // the keyboard handlers, which need to know whether the tutor covers the card.)
  const shellStyle = isNarrow ? S.shellNarrow : S.shell;
  // The room is made by MAIN, not by the shell. Padding the shell shrank the
  // sidebar too — its account block jumped up the page and left a gap —
  // when the sidebar is not what either panel covers. Only the content column
  // has to move.
  const mainStyle = {
    ...S.main,
    boxSizing: "border-box",
    paddingRight: chatReflow ? CHAT_PANEL_WIDTH : lessonReflow ? LESSON_PANEL_WIDTH : 0,
    // Same duration and curve as the panel's own slide, so the page and the
    // panel move together instead of as two separate animations. (There is no
    // padding-bottom any more: the feedback panel moved into the sidebar.)
    transition: `padding-right ${PANEL_ANIM_MS}ms ${PANEL_EASING}`,
  };
  
  const sidebar = (
    <aside
      data-sidebar
      data-minimized={!isNarrow && sidebarMin ? "" : undefined}
      style={isNarrow ? S.sideBarBottom : sidebarMin ? { ...S.sideBar, ...S.sideBarMin } : S.sideBar}
    >
      {!isNarrow && !sidebarMin && (
        // Full width: in the corner of the sidebar's top padding, clear of the nav.
        <button
          data-sidebar-toggle
          style={S.sideToggle}
          onClick={() => setSidebarMinimized(true)}
          aria-label="Minimize sidebar"
          title="Minimize sidebar"
          aria-expanded="true"
        >
          {SIDEBAR_TOGGLE_ICON(false)}
        </button>
      )}
      {/* Nav items with icons */}
      <nav style={isNarrow ? S.sideNavBottom : S.sideNav}>
        {!isNarrow && sidebarMin && (
          // Minimized, the expand button is one more item in the rail: the
          // same button style as Cards and the rest, so it shares their centre
          // line (the 4px marker border offsets it, equally), their spacing and
          // their colour. Positioned on its own it sat 2px right of the column
          // and 11px closer to Cards than Cards is to Lessons.
          <button
            data-sidebar-toggle
            style={{ ...S.sideItem, ...S.sideItemMin }}
            onClick={() => setSidebarMinimized(false)}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            aria-expanded="false"
          >
            <span style={S.sideIcon}>{SIDEBAR_TOGGLE_ICON(true)}</span>
          </button>
        )}
        {navItems.map(([m, label]) => {
          const baseStyle = isNarrow ? S.sideItemBottom : sidebarMin ? { ...S.sideItem, ...S.sideItemMin } : S.sideItem;
          const activeStyle = isNarrow ? S.sideItemBottomActive : S.sideItemActive;
          return (
            <Fragment key={m}>
              <button
                style={navActive(m) ? {...baseStyle, ...activeStyle} : baseStyle}
                onClick={() => {
                  // Cards means the whole deck, so it clears any lesson you
                  // were inside — otherwise it selects itself while the lesson
                  // beneath it stays filtered and marked.
                  if (m === "study") leaveLesson();
                  setMode(m);
                }}
                title={!isNarrow && sidebarMin ? label : undefined}
                aria-label={!isNarrow && sidebarMin ? label : undefined}
              >
                <span style={S.sideIcon}>{NAV_ICONS[m]}</span>
                {!(sidebarMin && !isNarrow) && label}
              </button>
              {/* Lessons are the one nav item with children: each lesson sits
                  under it as a sub-item, so picking one is a single click
                  rather than a trip through the catalogue. Only on desktop —
                  the narrow layout's nav is a row of icons with no room to
                  nest anything. */}
              {m === "lessons" && !isNarrow && !sidebarMin && LESSONS.map((lesson) => {
                const on = mode === "study" && lessonFilter === lesson.id;
                return (
                  <button
                    key={lesson.id}
                    style={on ? {...S.sideSubItem, ...S.sideSubItemActive} : S.sideSubItem}
                    onClick={() => enterLesson(lesson.id)}
                    title={`Study ${lesson.title}`}
                  >
                    {lesson.title}
                  </button>
                );
              })}
            </Fragment>
          );
        })}

        {/* The tutor chat is an overlay, not a page, so it sits alongside the
            nav items but never takes the active state. It lives here rather
            than in the profile menu because looking a word up mid-session is
            a primary action, and nobody finds it behind an avatar. */}
        <button
          data-tutor-toggle
          style={isNarrow ? S.sideItemBottom : sidebarMin ? { ...S.sideItem, ...S.sideItemMin } : S.sideItem}
          onClick={toggleChat}
          title={!isNarrow && sidebarMin ? "Tutor" : undefined}
          aria-label={!isNarrow && sidebarMin ? "Tutor" : undefined}
        >
          <span style={S.sideIcon}>{NAV_ICONS.tutor}</span>
          {!(sidebarMin && !isNarrow) && "Tutor"}
        </button>
      </nav>

      {/* Bottom: account, then feedback beneath it (desktop only) */}
      {!isNarrow && user && (
        <>
        {/* The feedback panel's slot: the empty stretch between the nav and
            the account block. It takes the free height, pins the panel to its
            bottom edge just above the account, and its top padding keeps the
            panel well clear of Tutor. On a short window it holds a floor while
            the panel is open, and the sidebar scrolls instead of the panel
            climbing over the nav. */}
        <div
          ref={setFeedbackDock}
          data-feedback-dock
          style={{ ...S.sideFeedbackDock, minHeight: showFeedback ? 244 : 0 }}
        />
        <div style={sidebarMin ? { ...S.sideDivider, ...S.sideDividerMin } : S.sideDivider} />
        <div style={sidebarMin ? { ...S.sideBottom, ...S.sideBottomMin } : S.sideBottom}>
          <div style={sidebarMin ? { ...S.sideBottomRow, ...S.sideBottomRowMin } : S.sideBottomRow}>
            <div style={S.sideProfileRow} ref={profileRef}>
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
                    data-tutor-toggle
                    style={S.profileMenuItem}
                    onClick={() => { openChat(); setShowProfileMenu(false); }}
                  >
                    Ask the tutor
                  </button>
                  <button
                    style={S.profileMenuItem}
                    onClick={() => { setShowCahierLink(true); setShowProfileMenu(false); }}
                  >
                    {cahier.link ? "Your cahier ✓" : "Link your cahier"}
                  </button>
                  <button
                    style={S.profileMenuItem}
                    onClick={() => { setUploadInitialTab("paste"); setShowUpload(true); setShowProfileMenu(false); }}
                  >
                    Upload document
                  </button>
                  <button
                    style={S.profileMenuItem}
                    onClick={() => { setShowKeyModal(true); setShowProfileMenu(false); }}
                  >
                    {hasKey(user?.id) ? "Claude account ✓" : "Connect Claude account"}
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
            {!sidebarMin && <span style={S.sideBottomEmail}>{user.email}</span>}
          </div>
          <div style={sidebarMin ? { ...S.sideFeedbackRow, ...S.sideFeedbackRowMin } : S.sideFeedbackRow}>
            <BetaFeedback
              compact={sidebarMin}
              user={user}
              currentPage={mode}
              currentCard={mode === "study" ? card : null}
              open={showFeedback}
              onOpen={openFeedback}
              onClose={() => setShowFeedback(false)}
              dockEl={feedbackDock}
              attachRequest={feedbackAttachReq}
            />
          </div>
        </div>
        </>
      )}
    </aside>
  );

  // ── SHARED MODALS ───────────────────────────────────────────────────
  // Mounted at the top level so they render regardless of active view —
  // they're triggered from the sidebar profile menu, which is global.
  const modals = (
    <>
      <LessonPanel
        open={showLessonPanel}
        onClose={() => setShowLessonPanel(false)}
        lesson={LESSONS.find((l) => l.id === lessonFilter) || null}
        reflow={lessonReflow}
      />
      <ChatPanel
        open={showChat}
        onClose={() => setShowChat(false)}
        user={user}
        cards={userCards}
        // Live rather than a snapshot, so the tutor follows you as you advance
        // through the session — with whether each card's answer has been shown.
        currentCard={tutorCard}
        thread={tutorThread}
        // The insert hands back the row, so the deck takes it in place; only a
        // write that returned nothing falls back to a refetch.
        onCardAdded={(row) => (row ? addDeckCard(row) : reloadDeck())}
        onCardUpdated={patchDeckCard}
        onNeedKey={() => { setShowChat(false); setShowKeyModal(true); }}
        reflow={chatReflow}
      />
      <ApiKeyModal
        open={showKeyModal}
        onClose={() => setShowKeyModal(false)}
        user={user}
      />
      <CahierUpload
        open={showUpload}
        user={user}
        onClose={() => setShowUpload(false)}
        hasExisting={userCards.length > 0}
        initialTab={uploadInitialTab}
        onSuccess={(result) => {
          setShowUpload(false);
          reloadDeck();
          if (result.linked) return alert(uploadDoneText(result));
          alert(
            `Done!\n\n${result.cardsInserted} cards across ${result.datesCovered} lessons.\n` +
            (result.conjugationDrillsGenerated ? `${result.conjugationDrillsGenerated} conjugation drills generated.\n` : "") +
            (result.polysemySplits ? `${result.polysemySplits} polysemy splits.` : "")
          );
        }}
      />
      <CahierLink
        open={showCahierLink}
        cahier={cahier}
        onClose={() => setShowCahierLink(false)}
        onCardsAdded={() => reloadDeck()}
      />
      {showFeedbackModal && (
        <FeedbackReviewModal onClose={() => setShowFeedbackModal(false)} />
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
  // ── LESSONS ──────────────────────────────────────────────────────────
  // The catalogue. A lesson you have added is studied from here or from the
  // sidebar; one you haven't is added, which copies its cards into your deck.
  if (mode === "lessons") {
    return (
      <div style={shellStyle}>
        {sidebar}
        <main style={mainStyle}>
          <div style={S.mainInnerScroll}>
            <h1 style={S.statsHeading}>Lessons</h1>
            <p style={S.lessonIntro}>
              Card sets built from a teacher's lesson materials. Adding one copies its
              cards into your deck, where they schedule alongside everything else.
            </p>
            {LESSONS.map((lesson) => {
              const owned = userCards.filter((c) => lessonIdOf(c) === lesson.id);
              const added = owned.length > 0;
              // A lesson card whose front the deck already had as its own is
              // not added (reconcileLessons' `taken`), but the word is there.
              const ownFronts = new Set(userCards.filter((c) => !lessonIdOf(c)).map((c) => c.f));
              const inDeck = owned.length + lesson.cards.filter(([f]) => ownFronts.has(f)).length;
              return (
                <div key={lesson.id} style={S.lessonCard}>
                  <div style={S.lessonHead}>
                    <div>
                      <div style={S.lessonTitle}>{lesson.title}</div>
                      <div style={S.lessonSub}>{lesson.subtitle}</div>
                    </div>
                    {/* No "add" step: lessons ship with the app and sync
                        themselves into the deck on load. A student should
                        find L'impératif already there. */}
                    <button
                      style={S.lessonStudyBtn}
                      disabled={!added}
                      onClick={() => enterLesson(lesson.id)}
                    >
                      {added ? "Study" : "Adding…"}
                    </button>
                  </div>
                  <div style={S.lessonMeta}>
                    {added
                      ? `${Math.min(inDeck, lesson.cards.length)} of ${lesson.cards.length} cards in your deck`
                      : `${lesson.cards.length} cards · adding to your deck`}
                    {" · "}
                    {lesson.source}
                  </div>
                </div>
              );
            })}
          </div>
        </main>
        {modals}
      </div>
    );
  }

  if (mode === "stats") {
    const now = Date.now();
    const todayISO = localISODate();
    const endToday = endOfLocalDay(new Date(now));
    // Every card, each way round it is asked: a word is two schedules, and
    // everything below that reads FSRS state reads them apart.
    const sides = [];
    for (const c of userCards) for (const d of directionsOf(c)) sides.push({ card: c, side: sideOf(c, d) });
    const isSeenSide = (s) => (s.fsrs_state ?? State.New) !== State.New;

    // Today. FSRS records one answer per card per way round per day, so the
    // sides whose last review falls today ARE today's answers, across every
    // block, reload and device — and last_answer_correct on those is whether
    // that first answer was right.
    let answeredToday = 0, rightToday = 0;
    for (const { side } of sides) {
      if (!reviewedToday(side.last_review, new Date(now))) continue;
      answeredToday++;
      if (side.last_answer_correct === true) rightToday++;
    }

    // Streak: based on actual review days stored in Supabase
    // (loaded into reviewDates state on mount, appended to by answer()).
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = localISODate(d);
      if (reviewDates.has(iso)) streak++;
      // Not having studied yet TODAY doesn't end a streak — the day isn't over.
      else if (iso !== todayISO) break;
    }

    // Hardest cards: the ones you have actually forgotten, most often.
    //
    // `lapses` is FSRS's own count of times a card went from known back to
    // unknown, which is the definition of a hard card. The old version looked
    // for a low score on the retired ladder, so it surfaced cards nobody had
    // answered since the migration and missed ones being missed today.
    // Forgotten either way round counts: both ways are the same word.
    const hardest = userCards
      .map(c => {
        const ways = directionsOf(c).map((d) => sideOf(c, d));
        return {
          ...c,
          _lapses: ways.reduce((n, w) => n + (w.lapses ?? 0), 0),
          _difficulty: Math.max(...ways.map((w) => w.difficulty ?? 0)),
          _seen: progress[c.id]?.seen ?? 0,
        };
      })
      .filter(c => c._lapses >= 1)
      .sort((a, b) => b._lapses - a._lapses || b._difficulty - a._difficulty)
      .slice(0, 4);

    // Seen / about remembered / not yet seen, for the whole deck and each area.
    const areas = progressByArea(userCards, now);
    // Which classes each group holds, in dates: the line between them moves
    // with the calendar, and a card changes group when its class turns two
    // weeks old, so the page says where the line is today.
    const areaSpan = (() => {
      const { since, earliestOlder } = areaDates(userCards, now);
      const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" });
      const month = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      const dayBefore = (() => { const d = new Date(`${since}T12:00:00`); d.setDate(d.getDate() - 1); return localISODate(d); })();
      return {
        recent: `Classes since ${day(since)}`,
        earlier: earliestOlder ? `${month(earliestOlder)} to ${day(dayBefore)}` : `Classes before ${day(since)}`,
      };
    })();
    const areaRows = [
      ...LESSONS.filter((l) => areas.lessons[l.id]?.total > 0)
        .map((l) => ({ key: `lesson:${l.id}`, label: l.title, sub: "Lesson", summary: areas.lessons[l.id] })),
      { key: "recent", label: AREA_LABEL.recent, sub: areaSpan.recent, summary: areas.recent },
      { key: "earlier", label: AREA_LABEL.earlier, sub: areaSpan.earlier, summary: areas.earlier },
    ].filter((r) => r.summary.total > 0);

    // Coming up. Today's work is split in two: cards whose date is today, and
    // cards left over from earlier days. Counted together this once read
    // "708 due today" — almost all of them stamped due on one day by the
    // move to FSRS — which reads as a day's work no one could do.
    const startToday = startOfLocalDay(new Date(now));
    let dueToday = 0, dueEarlier = 0;
    for (const { side } of sides) {
      if (!isSeenSide(side) || !side.next_due_at) continue;
      const t = new Date(side.next_due_at).getTime();
      if (t > endToday) continue;
      if (t >= startToday) dueToday++; else dueEarlier++;
    }
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() + i + 1);
      return { iso: localISODate(d), label: d.toLocaleDateString(undefined, { weekday: "short" }), count: 0 };
    });
    const weekIndex = new Map(week.map((w, i) => [w.iso, i]));
    for (const { side } of sides) {
      if (!isSeenSide(side) || !side.next_due_at) continue;
      const i = weekIndex.get(localISODate(new Date(side.next_due_at)));
      if (i !== undefined) week[i].count++;
    }
    const weekTotal = week.reduce((n, w) => n + w.count, 0);
    const weekMax = Math.max(1, ...week.map((w) => w.count));

    // Breakdown by card type. Grammar, words and phrases are different kinds
    // of work and tend to sit at different levels — this is where you find out
    // that your vocabulary is fine and your conjugations are not.
    const byType = CARD_TYPES.map((type) => {
      const cards = userCards.filter((c) => classifyCard(c) === type);
      // Of the cards seen, how many were right the last time they were
      // answered — read off the same FSRS rows as the rest of the page.
      //
      // This was the lifetime tally in card_progress, which went back to the
      // box system and never forgets: after the 2026-09-14 reset it still
      // counted old answers on 1,200 cards now "not yet seen", and read 55%
      // beside a Right first time today of 70%.
      // Each way round a card has been answered is one last answer.
      let answered = 0, right = 0;
      for (const c of cards) {
        for (const d of directionsOf(c)) {
          const side = sideOf(c, d);
          if (!isSeenSide(side) || side.last_answer_correct == null) continue;
          answered++;
          if (side.last_answer_correct === true) right++;
        }
      }
      return {
        type,
        summary: summarize(cards, now),
        accuracy: answered > 0 ? Math.round((right / answered) * 100) : null,
        answered,
      };
    }).filter((t) => t.summary.total > 0);

    // One bar, three bands: remembered (solid), seen but not currently
    // remembered (light), not yet seen (the empty track).
    const bands = (summary, color, height) => {
      const total = Math.max(summary.total, 1);
      const rem = Math.min(summary.remembered, summary.seen);
      return (
        <div style={{ ...S.bandTrack, height }}>
          <div style={{ width: `${(rem / total) * 100}%`, background: color }} />
          <div style={{ width: `${((summary.seen - rem) / total) * 100}%`, background: color, opacity: 0.3 }} />
        </div>
      );
    };
    const figures = (summary) =>
      `${summary.seen.toLocaleString()} seen · about ${aboutRemembered(summary).toLocaleString()} remembered · ${summary.total.toLocaleString()} cards`;

    return (
      <div style={shellStyle}>
        {sidebar}
        <main style={mainStyle}>
          <div style={S.mainInnerScroll}>
            <h1 style={S.statsHeading}>Progress</h1>

            {/* Row 1: Today · Right first time today · Streak */}
            <div style={S.statsRow3}>
              <div style={S.metricCard}>
                <div style={S.metricLabel}>Today</div>
                <div style={S.metricVal}>{answeredToday.toLocaleString()}</div>
                <div style={S.metricSub}>{answeredToday === 1 ? "answer" : "answers"}</div>
              </div>
              <div style={S.metricCard}>
                <div style={S.metricLabel}>Right first time today</div>
                <div style={S.metricVal}>{answeredToday > 0 ? `${Math.round((rightToday / answeredToday) * 100)}%` : "—"}</div>
                <div style={S.metricSub}>{answeredToday > 0 ? `${rightToday.toLocaleString()} of ${answeredToday.toLocaleString()}` : "nothing answered yet today"}</div>
              </div>
              <div style={S.streakCard}>
                <div style={{fontSize:16}}>🔥</div>
                <div style={S.streakNum}>{streak}</div>
                <div style={S.streakSub}>day streak</div>
              </div>
            </div>

            {/* All cards: seen / about remembered / not yet seen */}
            <div style={S.pipelineCard} data-stats-all>
              <div style={S.pipeTitle}>All your cards</div>
              {bands(areas.all, T.color.primary, 28)}
              <div style={S.pipeLegend}>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.primary}} />about {aboutRemembered(areas.all).toLocaleString()} remembered</div>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.primary, opacity:0.3}} />{Math.max(0, areas.all.seen - aboutRemembered(areas.all)).toLocaleString()} seen, not currently remembered</div>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.surfaceHigh}} />{areas.all.notSeen.toLocaleString()} not yet seen</div>
              </div>
              <p style={S.statsFootnote}>A word or phrase counts as remembered once you'd get it right from French and from English. It's an estimate: it rises when you study and falls when you don't.</p>
            </div>

            {/* Your progress: each lesson, recent classes, earlier notes */}
            {areaRows.length > 0 && (
              <div style={{marginTop:24}} data-stats-areas>
                <h3 style={S.statsSectionTitle}>Your progress</h3>
                <p style={S.statsSectionSub}>Lessons, and the cards from your own classes, split by how long ago the class was.</p>
                <div style={S.areaList}>
                  {areaRows.map((r) => (
                    <div key={r.key} style={S.areaRow}>
                      <div style={S.areaHead}>
                        <span style={S.areaName}>{r.label}</span>
                        <span style={S.areaSub}>{r.sub}</span>
                      </div>
                      {bands(r.summary, T.color.secondary, 10)}
                      <div style={S.areaFigures}>{figures(r.summary)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Coming up: due cards on each of the next seven days */}
            <div style={{marginTop:24}} data-stats-coming-up>
              <h3 style={S.statsSectionTitle}>Coming up</h3>
              <p style={S.statsSectionSub}>
                {dueToday.toLocaleString()} due today
                {dueEarlier > 0 ? `, and ${dueEarlier.toLocaleString()} older ${dueEarlier === 1 ? "card" : "cards"} still waiting from earlier days` : ""}.
                {" "}{week[0].count.toLocaleString()} due tomorrow, {weekTotal.toLocaleString()} over the next seven days.
              </p>
              <div style={S.weekChart}>
                {week.map((w) => (
                  <div key={w.iso} style={S.weekCol} title={`${w.count} due on ${w.iso}`}>
                    <div style={S.weekCount}>{w.count.toLocaleString()}</div>
                    <div style={S.weekBarSlot}>
                      <div style={{ ...S.weekBar, height: `${(w.count / weekMax) * 100}%` }} />
                    </div>
                    <div style={S.weekLabel}>{w.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* By type: grammar vs words vs phrases */}
            {byType.length > 1 && (
              <div style={{marginTop:24}}>
                <h3 style={S.statsSectionTitle}>By type</h3>
                <p style={S.statsSectionSub}>Grammar, single words and phrases ask different things of you.</p>
                <div style={S.typeGrid}>
                  {byType.map((t) => (
                    <div key={t.type} style={S.typeCard}>
                      <span style={{...S.hardTag, background: TYPE_COLOR[t.type] + "22", color: TYPE_COLOR[t.type]}}>
                        {TYPE_LABEL[t.type]}
                      </span>
                      <div style={S.typeVal}>{t.accuracy === null ? "—" : `${t.accuracy}%`}</div>
                      <div style={S.typeSub}>
                        {t.summary.seen === 0
                          ? `${t.summary.total.toLocaleString()} card${t.summary.total === 1 ? "" : "s"} · none studied yet`
                          : `${t.accuracy === null ? "" : "right last time · "}${t.summary.seen.toLocaleString()} of ${t.summary.total.toLocaleString()} seen · about ${aboutRemembered(t.summary).toLocaleString()} remembered`}
                      </div>
                      <div style={{marginTop:10}}>{bands(t.summary, TYPE_COLOR[t.type], 4)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                          background: TYPE_COLOR[classifyCard(c)] + "22",
                          color: TYPE_COLOR[classifyCard(c)],
                        }}>
                          {TYPE_LABEL[classifyCard(c)]}
                        </span>
                      </div>
                      <h4 style={S.hardWord}>{c.f}</h4>
                      <p style={S.hardMeta}>
                        forgotten {c._lapses}×{c._seen ? ` · seen ${c._seen}×` : ""}
                      </p>
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
  // French shown as the prompt gets its English gloss stripped — otherwise the
  // card answers itself. English shown as the prompt loses any note naming the
  // French form ("to re-elect (past participle: réélu)"), for the same reason.
  // The answer side keeps everything, apart from a sentence-final full stop,
  // which neither side shows.
  const front = card ? dropFinalPeriod(card.shownDir==="fr" ? cleanFrenchPrompt(card.f, card.b) : cleanEnglishPrompt(card.b)) : "";
  const back = card ? dropFinalPeriod(card.shownDir==="fr" ? card.b : card.f) : "";
  // Typing mode: user enabled it AND the card exists. All cards are
  // typable — if the back is a long explanation, the user can hit
  // "Show answer" to skip. The old isTypable guard (back ≤ 25 chars)
  // silently disabled type mode on many cards, making the toggle button
  // appear broken.
  const effectiveTypeMode = typeMode && !!card;

  // The card face is the same affordance as the "Show answer" button, so in
  // What the completion panel says it did. Accuracy needs a denominator you
  // can trust, so it is only offered when something was actually typed;
  // otherwise the honest report is a count of what you worked through.
  // Answers, not cards: a block of 50 includes its retries. Right first time
  // counts each card's first answer of the day.
  const blockSummary = stats.firstAnswered > 0
    ? `${stats.answered} ${stats.answered === 1 ? "answer" : "answers"}, ${stats.firstGot} right first time`
    : `${stats.answered} ${stats.answered === 1 ? "answer" : "answers"}`;
  const areaLabel = (area) =>
    area === "recent" ? AREA_LABEL.recent
      : area === "earlier" ? AREA_LABEL.earlier
      : LESSONS.find((l) => `lesson:${l.id}` === area)?.title || "Lesson";
  const moreOrFewer = (n, word) => `about ${Math.abs(n)} ${n >= 0 ? "more" : "fewer"} ${word}`;

  // type mode tapping it has to run giveUpTyped. A bare flip() would turn the
  // card over while leaving typeResult null — the answer visible, but the app
  // still believing the card was unanswered, so the action row never appears.
  // Once the answer is showing, the card is the same affordance as
  // "Continue →": tapping it grades and moves on, so you can work through a
  // session without moving the pointer off the card.
  // Which language the typed answer is supposed to be in.
  //
  // Not the same question as which side is showing. A vocab card shown
  // French-side wants English back, but a drill shown French-side wants
  // FRENCH back: "regarder (impératif) → tu" answers "regarde". The input
  // used to read "Type English…" on every one of those, which is a plain
  // instruction to type the wrong language.
  //
  // The arrow is the test, the same marker classifyCard treats as definitive
  // for a conjugation drill.
  const cardLesson = card ? LESSONS.find((l) => l.id === lessonIdOf(card)) || null : null;
  // What to type, above the prompt of a grammar card: "Conjugate in the
  // present tense, first person singular, with je", "Write the adverb for this
  // adjective". "vivre → je" never said which tense, and "relatif → adverbe"
  // read as a word to translate. Grammar cards are only ever shown French side.
  const instruction = card && card.shownDir === "fr" ? cardInstructionFor(card) : null;

  const answerLang = (c) =>
    !c ? "English"
      : c.shownDir === "en" ? "French"
      : String(c.f || "").includes("→") ? "French"
      : "English";

  const onCardClick = () => {
    if (!effectiveTypeMode) return flip();
    // With an answer typed but not checked, tapping the card checks it. It
    // used to be Show answer: the typed text was ignored and a miss recorded.
    if (!typeResult) return typedAnswer.trim() ? submitTyped() : giveUpTyped();
    answer(typedRecalled, "typed");
  };

  return (
    <div style={shellStyle}>
      {sidebar}
      <main style={mainStyle}>
        {/* Top app bar — direction toggle, type answer chip, sticky glass */}
        <div style={S.topBar}>
          <div style={S.topBarInner} className="chip-row">
          {/* The type filter is a whole-deck control and it does not survive
              contact with a lesson: of the 108 impératif cards, 80 classify as
              grammar and 28 as phrase, so Vocab hands you an empty session and
              the other two collapse to "drills or sentences" — a distinction
              the lesson's own sections make far better. Hidden inside a
              lesson; enterLesson() clears it so nothing narrows the deck
              invisibly while the control that would show it is gone. */}
          {lessonFilter === "all" && (
          <div style={S.typeGroup}>
            {[["all", "All"], ...CARD_TYPES.map((t) => [t, TYPE_LABEL[t] === "Phrase" ? "Phrases" : TYPE_LABEL[t]])]
              .map(([k, label]) => {
                const on = typeFilter === k;
                return (
                  <button
                    key={k}
                    style={on ? {...S.typeBtn, ...S.typeBtnA, ...(k !== "all" ? {background: TYPE_COLOR[k], borderColor: TYPE_COLOR[k]} : null)} : S.typeBtn}
                    onClick={() => setTypeFilter(k)}
                    title={k === "all"
                      ? "Everything, mixed — best for long-term retention"
                      : `Only ${label.toLowerCase()} this session`}
                  >
                    {label}
                  </button>
                );
              })}
          </div>
          )}
          {/* Which lesson you are in — a label, not a control. It sat beside
              the "Lesson notes" toggle as an identically shaped pill with an ×
              on it, so the two read as a pair of switches when only one is.
              Leaving a lesson is the Cards nav item, which is where going back
              to the whole deck belongs. */}
          {lessonFilter !== "all" && (
            <div style={S.lessonName}>
              {LESSONS.find((l) => l.id === lessonFilter)?.title || lessonFilter}
            </div>
          )}
          {/* The lesson's progress. Read when the block was dealt and again at
              its checkpoint — never per answer, because a figure that moves
              on every card reads as noise rather than progress. "About",
              because remembered is an estimate. */}
          {lessonFilter !== "all" && (() => {
            const snap = (sessionDone && checkpoint ? checkpoint.after : blockStartRef.current)?.lessons?.[lessonFilter];
            return snap ? (
              <div style={S.lessonProgress} data-lesson-progress>
                about {aboutRemembered(snap).toLocaleString()} of {snap.total.toLocaleString()} remembered
              </div>
            ) : null;
          })()}
          {lessonFilter !== "all" && (
            <button
              data-lesson-toggle
              style={showLessonPanel ? {...S.chipToggle, ...S.chipToggleA} : S.chipToggle}
              onClick={toggleLessonPanel}
              title="The lesson, beside the cards"
            >
              Lesson notes
            </button>
          )}
          <div style={S.dirGroup}>
            {[["fr","FR→EN"],["en","EN→FR"],["mix","Mixed"]].map(([k,label]) => (
              <button key={k} style={dir===k ? {...S.dirBtn,...S.dirBtnA} : S.dirBtn} onClick={() => setDir(k)}>{label}</button>
            ))}
          </div>
          <button
            data-type-toggle
            style={(pendingTypeMode ?? typeMode) ? {...S.chipToggle, ...S.chipToggleA} : S.chipToggle}
            onClick={toggleTypeMode}
            title={pendingTypeMode === null ? undefined : "This card's answer has been seen, so the switch waits for the next card"}
          >
            Type answer
          </button>
          {directionPending && pendingTypeMode === null && (
            <span style={S.pendingSwitch} data-pending-direction>
              The new direction starts from the next card
            </span>
          )}
          {pendingTypeMode !== null && (
            <span style={S.pendingSwitch} data-pending-switch>
              {pendingTypeMode ? "Typing starts from the next card" : "Flipping starts from the next card"}
            </span>
          )}
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
        </div>

        {/* What the cahier brought in. The cards are already in the deck and
            already scheduled; this says so once, and goes when dismissed —
            new cards arriving silently read as the app inventing work. */}
        {cahier.arrived && (
          <div style={S.cahierNotice} data-cahier-notice role="status">
            <span>
              {cahierArrivalText(cahier.arrived)}
            </span>
            <button style={S.cahierDismiss} onClick={cahier.dismissArrived} aria-label="Dismiss">✕</button>
          </div>
        )}

        <div style={S.mainInner}>
          {/* Sub-toolbar: session counter and back control */}
          <div style={S.subToolbar} className="chip-row">
            {card && (() => {
              // Where you are in the block. Retries sit inside the block rather
              // than after it, so this is one running count to the checkpoint;
              // a retry says so beside the count.
              const retriesComing = deck.slice(idx + 1).filter((c) => c._retry).length;
              const hasBreakdown =
                sessionCounts.lapse + sessionCounts.review + sessionCounts.new + sessionCounts.spot > 0;
              return (
                <>
                <button
                  style={idx > 0 ? S.backBtn : {...S.backBtn, ...S.backBtnOff}}
                  onClick={goBack}
                  disabled={idx === 0}
                  title={idx > 0 ? "Go back to the previous card" : "You're on the first card"}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3 5 8l5 5"/></svg>
                  Previous card
                </button>
                <div style={S.subToolbarRight}>
                  {/* Where you are in the block. Gone at the checkpoint, where
                      the last card's position means nothing. */}
                  {unsavedCount > 0 && (
                    <span style={S.unsavedNotice} data-unsaved role="status">
                      {unsavedCount === 1 ? "1 answer not saved yet" : `${unsavedCount} answers not saved yet`} — retrying
                    </span>
                  )}
                  {!sessionDone && <span style={S.counter}>
                    {`Card ${idx+1} of ${deck.length}`}
                    {card._retry && (
                      <span style={S.counterBreakdown} data-retry>{" · retry"}</span>
                    )}
                    {!card._retry && hasBreakdown && (
                      <span style={S.counterBreakdown}>
                        {" · "}
                        {[
                          sessionCounts.lapse > 0 && `${sessionCounts.lapse} relearning`,
                          sessionCounts.review > 0 && `${sessionCounts.review} review`,
                          sessionCounts.new > 0 && `${sessionCounts.new} new`,
                          sessionCounts.spot > 0 && `${sessionCounts.spot} spot check`,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    )}
                    {retriesComing > 0 && (
                      <span style={S.counterBreakdown}>
                        {` · ${retriesComing} ${retriesComing === 1 ? "retry" : "retries"} to come`}
                      </span>
                    )}
                  </span>}
                </div>
                </>
              );
            })()}
          </div>

          {sessionDone ? (
            // The queue is worked out. This REPLACES the card rather than
            // sitting under it: leaving the last card on screen with Again /
            // Got It still live let you grade the same card over and over,
            // writing an FSRS review each time.
            <div style={S.cardArea}>
              <div style={S.sessionDone} data-checkpoint>
                <p style={S.checkpointHead}>{blockSummary}</p>
                {checkpoint?.changes.length > 0 && (
                  <div style={S.checkpointAreas}>
                    {checkpoint.changes.map((d) => (
                      <div key={d.area} style={S.checkpointArea}>
                        <div style={S.checkpointAreaName}>{areaLabel(d.area)}</div>
                        <div style={S.checkpointAreaDelta}>
                          {[
                            d.seenDelta !== 0 && `${d.seenDelta} more seen`,
                            d.rememberedDelta !== 0 && moreOrFewer(d.rememberedDelta, "remembered"),
                          ].filter(Boolean).join(" · ")}
                        </div>
                        <div style={S.checkpointAreaTotal}>
                          {d.after.seen.toLocaleString()} of {d.after.total.toLocaleString()} seen · about {aboutRemembered(d.after).toLocaleString()} remembered
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {checkpoint && checkpoint.next.queue.length === 0 && (
                  <p style={S.checkpointNote}>
                    <strong>You're all caught up.</strong> Nothing is due, and there are no new cards
                    {lessonFilter !== "all" ? " left in this lesson" : ""}.
                  </p>
                )}
                {checkpoint?.waiting > 0 && (
                  <p style={S.checkpointNote}>
                    {checkpoint.waiting.toLocaleString()} {checkpoint.waiting === 1 ? "card" : "cards"} from the rest of your deck {checkpoint.waiting === 1 ? "is" : "are"} due.
                    They come first when you go back to all cards.
                  </p>
                )}
                {checkpoint && checkpoint.next.queue.length > 0 && (
                  <button style={S.resetSBtn} onClick={startNextBlock}>Continue</button>
                )}
              </div>
            </div>
          ) : card ? (
            <div style={S.cardArea}>
              {/* Decorative blur shapes (per Stitch design) */}
              <div style={S.blurTL} />
              <div style={S.blurBR} />

              <div style={S.cardTopSpacer} />
              <div style={S.cardWrap} onClick={onCardClick}>
                <div style={{...S.card, transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)", transition: skipFlipAnim.current ? "none" : S.card.transition, cursor: "pointer"}}>
                  <div style={{...S.cardFront, pointerEvents: flipped ? "none" : "auto"}}>
                    {cardLesson && <div style={S.cardBadge}>{cardLesson.title}</div>}
                    {instruction && <div style={S.cardInstruction} data-card-instruction>{instruction}</div>}
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
                    {effectiveTypeMode && !typeResult && <div style={S.cardHint}>Tap to show answer</div>}
                    {!effectiveTypeMode && <ShortcutsTooltip />}
                    {!showFeedback && <ReportCardButton onReport={reportCard} nextToInfo={!effectiveTypeMode} />}
                  </div>
                  <div style={{...S.cardBack, pointerEvents: flipped ? "auto" : "none"}}>
                    {cardLesson && <div style={S.cardBadge}>{cardLesson.title}</div>}
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
                    {!showFeedback && <ReportCardButton onReport={reportCard} />}
                  </div>
                </div>
              </div>

              {/* Everything under the card lives in one fixed-height well.
                  The area centres its contents, so when the typed-answer row
                  (one input) was replaced by the result banner plus the
                  "should have been accepted" link plus Continue, the whole
                  column re-centred and the card jumped 45px up the page.
                  Reserving the tallest state's height keeps the card still and
                  lets only the controls change. */}
              <div style={S.belowCard}>
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
                      {/* The card has already flipped to the correct answer, so
                          repeating it here wastes the line. Show what you
                          actually typed instead — that's the useful comparison.
                          "revealed" is the exception: nothing was typed. */}
                      {typeResult==="correct" && "✓ Correct!"}
                      {typeResult==="close" && (typedAnswer.trim() ? `✓ Close enough — you wrote: ${typedAnswer.trim()}` : "✓ Close enough")}
                      {typeResult==="wrongArticle" && (typedAnswer.trim() ? `✗ Wrong article — you wrote: ${typedAnswer.trim()}` : `✗ Wrong article — answer: ${back}`)}
                      {typeResult==="wrong" && (typedAnswer.trim() ? `✗ You wrote: ${typedAnswer.trim()}` : `✗ Answer: ${back}`)}
                      {typeResult==="revealed" && `Answer: ${back}`}
                    </div>
                    {(() => {
                      const gotIt = typedRecalled;
                      const missed = typeResult === "wrong" || typeResult === "close" || typeResult === "wrongArticle";
                      return (
                        <>
                          {/* Centred, at its own size — not stretched to the
                              column, and not pushed to its right edge. */}
                          <button style={S.continueBtn} onClick={() => answer(gotIt, "typed")}>
                            Continue →
                          </button>
                          {/* The follow-ups sit BELOW Continue, in one centred
                              row at 12px: Continue is what you press nearly
                              every time, so it comes first after the result.
                              One row for all three rather than a row each,
                              because belowCard is a fixed 170px well and every
                              extra line would push the card off its place.
                              A dispute in progress replaces the row with its
                              status, in the same spot. */}
                          {feedbackState === null ? (
                            (missed || gotIt) && (
                              <div data-graded-links style={S.typeLinksRow}>
                                {missed && (
                                  <button style={S.typeLink} onClick={submitFeedback}>
                                    My answer should be accepted
                                  </button>
                                )}
                                {gotIt && (
                                  <button
                                    style={{ ...S.typeLink, ...S.typeLinkMuted }}
                                    onClick={() => answer(false, "typed")}
                                    title="Record as incorrect and keep this card near the top of the queue"
                                  >
                                    Mark for review
                                  </button>
                                )}
                                {missed && (
                                  <button
                                    data-tutor-toggle
                                    style={S.typeLink}
                                    onClick={() =>
                                      // The miss reaches the tutor through tutorCard,
                                      // which carries the typed answer and the
                                      // verdict. Passing the card starts a fresh
                                      // thread if the last one was about another.
                                      openChat(card)
                                    }
                                  >
                                    Ask the tutor
                                  </button>
                                )}
                              </div>
                            )
                          ) : missed && (
                            <div style={S.feedbackRow}>
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
                        </>
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
                        onKeyDown={e => {
                          if (e.key === "Enter") submitTyped();
                          // Escape clears the box. It used to be Show answer,
                          // which threw away what was typed and recorded a
                          // miss — and Escape is the reflex for clearing a field.
                          else if (e.key === "Escape") setTypedAnswer("");
                        }}
                        placeholder={`Type ${answerLang(card)}…`}
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
                  {/* Grading is offered only once the answer has been seen —
                      Got It on an unturned card is a recall FSRS records
                      without one having happened. Before that, one button
                      turns the card, in the same row so nothing moves. */}
                  {answerSeen ? (
                    <>
                      <div style={S.actionRow}>
                        <button style={S.actionAgainRect} onClick={() => answer(false)}>
                          Again
                        </button>
                        <button style={S.actionGotRect} onClick={() => answer(true)}>
                          Got It
                        </button>
                      </div>
                      <p style={S.flipHint}>Only press Got It if you knew it before turning the card.</p>
                    </>
                  ) : (
                    <div style={S.actionRow}>
                      <button style={S.actionGotRect} onClick={flip} data-show-answer>
                        Show answer
                      </button>
                    </div>
                  )}
                  </>
              )}
              </div>
            </div>
          ) : (
            <div style={S.empty}><p><strong>You're all caught up.</strong> Nothing is due, and there are no new cards here.</p><button style={S.resetSBtn} onClick={resetSession}>Check again</button></div>
          )}
        </div>

      </main>
      {modals}
    </div>
  );
}

// ─── EDIT CARD MODAL ─────────────────────────────────────────────────────
// ─── FEEDBACK ENTRY ────────────────────────────────────────────────────────
// One entry in the feedback log, the same in the "View feedback" modal and on
// the Feedback Review page. Read-only on purpose: feedback is worked through by
// a Claude session, which fixes the card or the code and then resolves the
// entry with scripts/resolve-feedback.mjs. There is nothing for the owner to do
// by hand, so there are no buttons.
//
// Layout: the message is the headline, then who and when (to the minute), then
// the attached card as two lines beside a screenshot thumbnail stretched to the
// card's height. The thumbnail is the whole affordance — click it for the full
// screenshot.
//
// Entries are numbered 1, 2, 3 down the list as it stands: open feedback only,
// newest first. That is the number the owner quotes to a Claude session ("fix
// feedback 2"), and scripts/resolve-feedback.mjs lists open feedback with the
// same numbers in the same order. They are positions, not ids, so they change
// as entries arrive or are resolved.
const FEEDBACK_THUMB_WIDTH = 120;

const feedbackTime = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

function ScreenshotLightbox({ src, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Portalled, but React events still bubble up the component tree — through
  // the feedback modal's overlay, whose click closes the modal. Stop them here.
  return createPortal(
    <div
      data-feedback-lightbox
      style={S.fbLightbox}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <img src={src} alt="Feedback screenshot, full size" style={S.fbLightboxImg} />
    </div>,
    document.body
  );
}

function FeedbackEntry({ item, number, last }) {
  const [zoomed, setZoomed] = useState(false);
  const ctx = item.card_context;
  const type = ctx ? classifyCard({ cat: ctx.category, f: ctx.front, b: ctx.back }) : null;
  const meta = [item.user_email || "anonymous", feedbackTime(item.created_at)];
  if (!ctx && !item.screenshot) meta.push("no card attached");

  return (
    <div data-feedback-entry style={{ ...S.fbEntry, ...(last ? { borderBottom: "none" } : null) }}>
      <div data-feedback-number style={S.fbEntryNumber}>{number}</div>
      <div style={{ minWidth: 0 }}>
      <div style={S.fbEntryMsg}>{item.message}</div>
      <div style={S.fbEntryMeta}>{meta.join(" · ")}</div>
      {(ctx || item.screenshot) && (
        <div
          style={{
            ...S.fbEntryRow,
            gridTemplateColumns: ctx && item.screenshot
              ? `minmax(0, 1fr) ${FEEDBACK_THUMB_WIDTH}px`
              : ctx ? "minmax(0, 1fr)" : `${FEEDBACK_THUMB_WIDTH}px`,
          }}
        >
          {ctx && (
            <div data-feedback-card style={S.fbEntryCard}>
              <div style={S.fbEntryCardLabel}>
                <span style={{ color: TYPE_COLOR[type] }}>{TYPE_LABEL[type]}</span>
                {ctx.shown_dir && (
                  <span> · shown {ctx.shown_dir === "fr" ? "French" : "English"} first</span>
                )}
              </div>
              <div style={S.fbEntryCardText} title={ctx.back ? `${ctx.front} · ${ctx.back}` : ctx.front}>
                {ctx.front}
                {ctx.back && <span style={{ color: T.color.onSurfaceVariant }}> · {ctx.back}</span>}
              </div>
            </div>
          )}
          {item.screenshot && (
            <button
              type="button"
              data-feedback-thumb
              title="View full size"
              onClick={() => setZoomed(true)}
              style={{ ...S.fbEntryThumb, ...(ctx ? null : { height: 72 }) }}
            >
              <img src={item.screenshot} alt="Feedback screenshot" style={S.fbEntryThumbImg} />
            </button>
          )}
        </div>
      )}
      </div>
      {zoomed && <ScreenshotLightbox src={item.screenshot} onClose={() => setZoomed(false)} />}
    </div>
  );
}

// ─── FEEDBACK REVIEW MODAL (admin only) ───────────────────────────────────
// ─── OPEN FEEDBACK ─────────────────────────────────────────────────────────
// Feedback that has been dealt with is marked resolved rather than deleted, and
// leaves the list. Both admin views read through this, so they cannot disagree
// about what "open" means. See migration_009.
//
// A database without migration_009 has no resolved_at column. Rather than show
// an empty list — indistinguishable from "nothing waiting", which is exactly how
// the dispute view hid its backlog — the list falls back to every entry and
// says why it cannot be cleared.
async function loadOpenFeedback() {
  const query = () =>
    supabase.from("beta_feedback").select("*").order("created_at", { ascending: false }).limit(50);
  const open = await query().is("resolved_at", null);
  if (open.error && /resolved_at/.test(open.error.message || "")) {
    const all = await query();
    return { data: all.data || [], error: all.error, resolvable: false };
  }
  return { data: open.data || [], error: open.error, resolvable: true };
}

const NEEDS_MIGRATION_009 =
  "Showing resolved feedback too: this database has no resolved_at column yet. Run migrations/migration_009_beta_feedback_resolved.sql in the Supabase SQL editor.";

// Shows open beta_feedback entries in a portal overlay. Triggered from the
// profile dropdown → "View feedback".
function FeedbackReviewModal({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resolvable, setResolvable] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error, resolvable } = await loadOpenFeedback();
      if (error) console.error("Failed to load feedback:", error);
      setItems(data);
      setResolvable(resolvable);
      setLoading(false);
    })();
  }, []);

  return createPortal(
    <div style={S.feedbackModalOverlay} onClick={onClose}>
      <div data-feedback-log style={S.feedbackModalBox} onClick={e => e.stopPropagation()}>
        <div style={S.fbLogHeader}>
          <h2 style={S.fbLogTitle}>Feedback</h2>
          {!loading && <span style={S.fbLogCount}>{items.length} open</span>}
          <span style={{ flex: 1 }} />
          <button aria-label="Close" style={S.fbLogClose} onClick={onClose}>×</button>
        </div>
        {!resolvable && <div style={S.fbLogNote}>{NEEDS_MIGRATION_009}</div>}
        {loading ? (
          <div style={S.fbLogEmpty}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={S.fbLogEmpty}>No open feedback.</div>
        ) : (
          <div style={S.fbLogList}>
            {items.map((item, i) => (
              <FeedbackEntry key={item.id} item={item} number={i + 1} last={i === items.length - 1} />
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
// approve (adds answer as a card alternate) or reject.
//
// This whole view was dead until 2026-09-12, and dead SILENTLY, which is the
// part worth remembering. It queried `feedback_submissions` for a column named
// `reviewed` and wrote `reviewed` and `action`; the table has `status` and
// `reviewed_at` and never had the others. It also rendered `item.french`,
// `item.english` and `item.expected_answer` against a table whose columns are
// `card_front` and `card_back`.
//
// So: the list's own query errored, the error went to console.error, the catch
// set items to [] — and an empty list is exactly what "no disputes waiting"
// looks like. Approve and reject failed the same quiet way. The backlog the
// doc describes as "nobody looking at it" was a backlog nobody COULD look at.
//
// Hence loadError below. A fetch that fails now says so on the page. Anything
// that can silently render as "nothing to do" has to be able to say "I broke".
function FeedbackAdminView({ user, setMode, resetSession }) {
  const [items, setItems] = useState([]);
  const [betaItems, setBetaItems] = useState([]);
  const [betaResolvable, setBetaResolvable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [acting, setActing] = useState(null); // id being acted on

  const load = async () => {
    setLoading(true);
    // Load card answer disputes
    setLoadError("");
    const { data, error } = await supabase
      .from("feedback_submissions")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Failed to load feedback:", error);
      setItems([]);
      setLoadError(error.message || "Could not load the disputes.");
    } else {
      setItems(data || []);
    }
    // Load general user feedback
    const { data: betaData, error: betaErr, resolvable } = await loadOpenFeedback();
    setBetaResolvable(resolvable);
    if (betaErr) {
      console.error("Failed to load beta feedback:", betaErr);
      setBetaItems([]);
    } else {
      setBetaItems(betaData);
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
      original_front: item.card_front || null,
      original_back: item.card_back || null,
      corrected_back: item.user_answer,
      notes: `direction=${item.direction}`,
    });

    const { error: upErr } = await supabase
      .from("feedback_submissions")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", item.id);
    if (upErr) console.error("Review mark failed:", upErr);
    await load();
    setActing(null);
  };

  const reject = async (item) => {
    setActing(item.id);
    const { error } = await supabase
      .from("feedback_submissions")
      .update({ status: "rejected", reviewed_at: new Date().toISOString() })
      .eq("id", item.id);
    if (error) console.error("Reject failed:", error);
    await load();
    setActing(null);
  };

  return (
    <>
      <h1 style={S.statsHeading}>Feedback Review</h1>

      {/* Card answer disputes */}
      <h3 style={S.statsSectionTitle}>Answer disputes</h3>
      {loading ? (
        <div style={S.empty}>Loading…</div>
      ) : loadError ? (
        // Never collapse a failure into the empty state: "no disputes" and
        // "the query broke" looked identical here for months.
        <p style={S.statsSectionSub}>
          Couldn't load the disputes — {loadError}
        </p>
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
                <div style={S.feedbackPrompt}>{item.direction === "fr" ? item.card_front : item.card_back}</div>
              </div>
              <div style={S.feedbackAnswers}>
                <div style={S.feedbackAnsRow}>
                  <span style={S.feedbackAnsLabel}>Expected:</span>
                  <span style={S.feedbackExpected}>{item.direction === "fr" ? item.card_back : item.card_front}</span>
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
      {!betaResolvable && <p style={S.statsSectionSub}>{NEEDS_MIGRATION_009}</p>}
      {betaItems.length === 0 ? (
        <p style={S.statsSectionSub}>No open user feedback.</p>
      ) : (
        <div data-feedback-log style={S.fbLogPage}>
          {betaItems.map((item, i) => (
            <FeedbackEntry key={item.id} item={item} number={i + 1} last={i === betaItems.length - 1} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── REPORT THIS CARD ────────────────────────────────────────────────────
// A faint flag in the card's bottom-right corner, beside the ⓘ. Most feedback
// is about a card, and the only way in used to be a 12px link at the foot of
// the sidebar. Opens the feedback panel with this card attached. Stops the
// click so it never flips, continues or grades the card underneath it.
function ReportCardButton({ onReport, nextToInfo = false }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-report-card
      style={{ ...S.reportCardBtn, right: nextToInfo ? 50 : 14, opacity: hover ? 0.7 : 0.25 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onReport(); }}
      title="Report a problem with this card"
      aria-label="Report a problem with this card"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 22V4" /><path d="M4 4h13l-2 4 2 4H4" />
      </svg>
    </button>
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
  // Fixed viewport height, not min-height: the study view sizes the card to
  // whatever space is left so the card and its buttons are always on screen
  // together. Anything that legitimately runs long (Stats) scrolls inside
  // main via mainInnerScroll rather than scrolling the whole page.
  shell: { display:"flex", height:"100vh", overflow:"hidden", boxSizing:"border-box", background:T.color.background },
  // overflowX matters here and not on `shell`, which clips both axes
  // already. The decorative blur circles in the card area are deliberately
  // positioned outside their container (left:-60 / right:-60); on a phone
  // that put the document 20px wider than the viewport and the whole page
  // slid sideways. Clip horizontally only — the narrow layout scrolls
  // vertically by design, and overflow-y stays effectively visible.
  shellNarrow: { display:"flex", flexDirection:"column", minHeight:"100vh", background:T.color.background, overflowX:"hidden" },
  // minHeight:0 is what lets the flex children actually shrink; without it a
  // flex item refuses to go below its content size and the card pushes the
  // buttons off the bottom instead of getting smaller.
  main: { flex:1, display:"flex", flexDirection:"column", minWidth:0, minHeight:0 },
  mainInner: { flex:1, minHeight:0, display:"flex", flexDirection:"column", padding:"12px 40px 16px", maxWidth:1100, width:"100%", margin:"0 auto", boxSizing:"border-box" },
  // Stats is genuinely long-form, so it scrolls within main.
  mainInnerScroll: { flex:1, minHeight:0, overflowY:"auto", padding:"32px 40px 60px", maxWidth:1100, width:"100%", margin:"0 auto", boxSizing:"border-box" },

  // ── Sidebar ───────────────────────────────────────────────────────
  // Fixed 256px column on desktop. The sticky positioning + 100vh height
  // means the sidebar stays fixed while the main content scrolls.
  // overflowX stays visible when minimized so the profile menu can open past
  // the 64px rail; the rail is short enough never to need to scroll.
  sideBarMin: { width:SIDEBAR_MIN_WIDTH, overflowY:"visible", paddingTop:8 },
  sideBar: { width:SIDEBAR_WIDTH, background:T.color.surfaceLow, borderRight:"1px solid rgba(3,22,50,0.07)", padding:"40px 0 24px", display:"flex", flexDirection:"column", flexShrink:0, position:"sticky", top:0, height:"100vh", overflowY:"auto", boxSizing:"border-box", transition:`width ${PANEL_ANIM_MS}ms ${PANEL_EASING}` },
  sideBarBottom: { position:"fixed", bottom:0, left:0, right:0, background:"rgba(247,243,241,0.95)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", padding:"4px 0", boxShadow:"0 -8px 32px rgba(3,22,50,0.06)", zIndex:30, display:"flex", flexDirection:"column" },
  // Not flex:1 any more — the feedback dock below takes the free height, so the
  // panel can sit in it. The nav looks the same either way.
  sideNav: { display:"flex", flexDirection:"column", gap:4, flex:"none" },
  sideFeedbackDock: { flex:"1 1 auto", minHeight:0, display:"flex", flexDirection:"column", justifyContent:"flex-end", padding:"24px 16px 12px", boxSizing:"border-box" },
  // Indented to sit under its parent nav item, and quieter than one: a lesson
  // is a place inside Lessons, not a peer of Cards and Stats.
  // Every nav style declares all FOUR border sides, even the three it does not
  // use. The wide nav marks the active item on its right, the narrow one on
  // its top; React diffs style objects per property, so crossing the 768px
  // breakpoint used to leave the other layout's border behind — resize a wide
  // window down and back and every item kept a stale top border, drawing a
  // rule between each one. Declaring all four means switching always
  // overwrites instead of relying on a property being absent.
  //
  // A lesson sitting under Lessons. Its text starts at 64px, which is exactly
  // where a nav item's LABEL starts — sideItem is padded 32 and its 18px icon
  // is followed by a 14px gap. That makes one clean vertical line down the
  // nav's text, with the lesson visibly a child of the item above it. At the
  // old 52 it aligned to neither the icon nor the label and just looked
  // dropped in the wrong place.
  //
  // Same 13px as the nav labels, deliberately: a glyph's left side bearing
  // scales with font size, so at 12px the L's ink started about a pixel right
  // of the L above it even though both text boxes began at exactly 64. The
  // hierarchy is carried by weight, colour and case instead of size.
  //
  // The active marker is the same right-hand bar the parent items use, rather
  // than a left bar 64px away from the text it was supposed to be marking.
  // Longhands, not the borderRight shorthand: React diffs per property, so a
  // shorthand base plus a longhand override strands the old value when the
  // item deactivates.
  sideSubItem: { display:"block", width:"100%", padding:"7px 32px 7px 64px", border:"none", borderTopWidth:0, borderTopStyle:"solid", borderTopColor:"transparent", borderBottomWidth:0, borderBottomStyle:"solid", borderBottomColor:"transparent", borderLeftWidth:0, borderLeftStyle:"solid", borderLeftColor:"transparent", borderRightWidth:4, borderRightStyle:"solid", borderRightColor:"transparent", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:13, fontWeight:500, color:"rgba(3,22,50,0.55)", textAlign:"left", boxSizing:"border-box" },
  sideSubItemActive: { color:T.color.secondary, fontWeight:700, borderRightColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideNavBottom: { display:"flex", flexDirection:"row", justifyContent:"space-around", padding:"4px 0", flex:1 },
  sideItemBottom: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, padding:"10px 8px", border:"none", borderRightWidth:0, borderRightStyle:"solid", borderRightColor:"transparent", borderBottomWidth:0, borderBottomStyle:"solid", borderBottomColor:"transparent", borderLeftWidth:0, borderLeftStyle:"solid", borderLeftColor:"transparent", borderTopWidth:3, borderTopStyle:"solid", borderTopColor:"transparent", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:9, fontWeight:700, color:"rgba(3,22,50,0.6)", textTransform:"uppercase", letterSpacing:"0.08em" },
  sideItemBottomActive: { color:T.color.secondary, borderTopColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideItem: { display:"flex", alignItems:"center", gap:14, padding:"14px 32px", border:"none", borderTopWidth:0, borderTopStyle:"solid", borderTopColor:"transparent", borderBottomWidth:0, borderBottomStyle:"solid", borderBottomColor:"transparent", borderLeftWidth:0, borderLeftStyle:"solid", borderLeftColor:"transparent", borderRightWidth:4, borderRightStyle:"solid", borderRightColor:"transparent", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:13, fontWeight:600, color:"rgba(3,22,50,0.6)", textTransform:"uppercase", letterSpacing:"0.1em", textAlign:"left", transition:"all 0.2s" },
  // Minimized: the item is just its icon, centred in the rail. The right-edge
  // marker still shows which page you are on.
  sideItemMin: { justifyContent:"center", padding:"14px 0", gap:0 },
  sideItemActive: { color:T.color.secondary, borderRightColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideIcon: { display:"flex", alignItems:"center", flexShrink:0 },
  // ── Sidebar bottom: avatar + email + feedback in one row ────────────
  sideDivider: { marginTop:"auto", height:1, background:"rgba(3,22,50,0.07)", marginLeft:20, marginRight:20 },
  sideBottom: { padding:"14px 20px 4px" },
  sideBottomMin: { padding:"14px 0 4px", display:"flex", flexDirection:"column", alignItems:"center" },
  sideBottomRowMin: { justifyContent:"center" },
  sideDividerMin: { marginLeft:12, marginRight:12 },
  sideFeedbackRowMin: { marginLeft:0, marginTop:6, display:"flex", justifyContent:"center" },
  sideToggle: { position:"absolute", top:8, right:12, width:32, height:32, display:"flex", alignItems:"center", justifyContent:"center", padding:0, border:"none", borderRadius:T.radius.md, background:"transparent", color:"rgba(3,22,50,0.45)", cursor:"pointer" },
  sideBottomRow: { display:"flex", alignItems:"center", gap:10 },
  sideFeedbackRow: { marginTop:2, marginLeft:42 },
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
  // flexWrap is gone; the row scrolls instead (className "chip-row"). Wrapping
  // changed the row's HEIGHT at a threshold width, and a panel reflow crosses
  // that threshold mid-animation — see the .chip-row note in styles.css.
  subToolbar: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:14, marginBottom:0, flexShrink:0, minHeight:30 },
  subToolbarRight: { display:"flex", alignItems:"center", gap:12 },

  // ── Card area: centered with decorative blur shapes ───────────────
  // "safe center" rather than plain center: when the area is shorter than its
  // contents, plain centring overflows in BOTH directions and the top of the
  // card rides up over the counter and the back button. Safe centring falls
  // back to start-alignment instead of spilling into what's above.
  // The CARD is centred on the window, not the card-plus-well stack.
  //
  // cardArea centres its children as a group, and everything below the card —
  // cardWrap's 20px margin and the 170px belowCard well — is part of that
  // group. Centring the group therefore pushes the card itself up by half of
  // whatever sits under it. With a 130px bottom padding on top of that, the
  // card measured a consistent 118px above the middle of the window at every
  // viewport height. The fix is `cardTopSpacer` below; the bottom padding is
  // gone because it was the larger half of the same error, and the well
  // already leaves plenty of space beneath the card.
  //
  // The `padding-bottom` transition that used to ride along with it is gone
  // too. With the value pinned at 0 it could never fire, and the motion suite
  // was pointed at it — checking a declaration rather than a movement, and
  // passing whatever the declaration said.
  cardArea: { position:"relative", flex:1, minHeight:0, containerType:"inline-size", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"safe center" },
  // Mirrors what sits below the card, less the chrome that already sits above
  // cardArea, so the card's own midpoint lands on the window's midpoint:
  //
  //   below the card   170 (belowCard) + 20 (cardWrap marginBottom) = 190
  //   above cardArea   100 (top bar + sub-toolbar + mainInner padTop)
  //   below cardArea    16 (mainInner padBottom)
  //   spacer = 190 + 16 - 100 = 106
  //
  // `0 8 106px` and not a fixed height: it must give its space up first when
  // the window is short or a panel opens, so the card keeps its size rather
  // than crushing. That is the job the old paddingBottom toggle was doing.
  //
  // The shrink factor is 2, and the number is load-bearing: it is the largest
  // one that does not make this spacer BOTTOM OUT mid-animation.
  //
  // Flex shrinks weighted by factor x basis, so the factor sets the spacer's
  // share of a squeeze against cardWrap's 375 basis. Push it too high and the
  // spacer's share exceeds the 106px it actually has, so it pins at 0 while
  // the deficit is large and only un-pins as the deficit shrinks. That pinning
  // is a HANDOVER, and it is what "jerky" finally turned out to be: closing
  // the sheet on a 700px-tall window, the card grew at 1.00px per px of page
  // movement for four frames with the spacer stuck at 0, then dropped to
  // 0.31 the moment it came off the floor. A rate change of 3.2x in one frame,
  // in the middle of a single 420ms move.
  //
  // Measured across window heights 640-900, worst-case ratio of fastest to
  // slowest frame: factor 1 gives 6.5x, factor 8 gives 3.2x, factor 4 gives
  // 2.9x, factor 2 gives 2.0x — and 1.1x at the short heights where the card
  // has real resizing to do. Worst single frame falls from 26px to 10px.
  //
  // It only changes behaviour under pressure: with free space to spare the
  // spacer stays 106 and cardArea's `safe center` places the card, so resting
  // geometry at every window height is untouched.
  cardTopSpacer: { flex:"0 2 106px", minHeight:0, width:"100%", pointerEvents:"none" },
  blurTL: { position:"absolute", top:-60, left:-60, width:360, height:360, background:"rgba(3,22,50,0.04)", borderRadius:"50%", filter:"blur(60px)", pointerEvents:"none", zIndex:0 },
  blurBR: { position:"absolute", bottom:60, right:-60, width:360, height:360, background:"rgba(156,66,52,0.05)", borderRadius:"50%", filter:"blur(60px)", pointerEvents:"none", zIndex:0 },

  // ── Card content (eyebrow, hint, audio circles, hover actions) ────
  cardEyebrow: { position:"absolute", top:22, left:"50%", transform:"translateX(-50%)", fontSize:10, fontFamily:T.font.sans, fontWeight:700, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.18em", display:"flex", alignItems:"center", gap:8, whiteSpace:"nowrap" },
  cardHint: { position:"absolute", bottom:14, left:"50%", transform:"translateX(-50%)", fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontStyle:"italic", opacity:0.45 },
  cardAudio: { display:"flex", gap:14, marginTop:20, justifyContent:"center" },
  cardAudioBtn: { width:52, height:52, display:"flex", alignItems:"center", justifyContent:"center", border:"none", borderRadius:"50%", background:T.color.surfaceLow, cursor:"pointer", fontSize:20, color:T.color.primary, transition:"all 0.15s" },
  cardAudioMic: { background:T.color.surfaceLow, color:T.color.secondary },
  cardAudioMicActive: { background:T.color.secondary, color:T.color.onSecondary, animation:"pulse 1.2s infinite" },
  // The pencil, the flag and the ⓘ are matching 30px circles 14px in from the
  // card's edges, so the pencil and the flag share a centre line.
  cardActionsFloat: { position:"absolute", top:14, right:14, display:"flex", gap:6 },

  // ── Big icon-button actions: AGAIN / GOT IT ───────────────────────
  // The button itself is a borderless flex column. The colored 80×80
  // box wraps the SVG, and the uppercase label sits below it.
  // ── Rectangular action buttons: AGAIN / GOT IT ─────────────────────
  unsavedNotice: { fontSize:11, fontFamily:T.font.sans, fontWeight:600, color:T.color.secondary, whiteSpace:"nowrap", marginRight:12 },
  flipHint: { fontSize:11.5, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, margin:"10px 0 0", textAlign:"center" },
  actionRow: { display:"flex", gap:12, justifyContent:"center", marginTop:0, marginBottom:0, width:"100%", maxWidth:420, alignSelf:"center", flexShrink:0 },
  actionAgainRect: { flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"13px 24px", border:"1px solid rgba(3,22,50,0.1)", borderRadius:T.radius.md, background:"transparent", color:T.color.onSurfaceVariant, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"-0.01em", transition:"all 0.15s" },
  actionGotRect: { flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"13px 24px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"-0.01em", boxShadow:"0 8px 24px rgba(3,22,50,0.15)", transition:"all 0.15s" },

  // ── Info tooltip (ⓘ keyboard shortcuts) ───────────────────────────
  infoWrap: { position:"absolute", bottom:14, right:14, zIndex:5 },
  reportCardBtn: { position:"absolute", bottom:14, width:30, height:30, padding:0, border:"none", borderRadius:"50%", background:"transparent", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:T.color.onSurfaceVariant, transition:"opacity 0.15s", zIndex:5 },
  infoBtn: { width:30, height:30, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:12, color:T.color.onSurfaceVariant, opacity:0.25, transition:"opacity 0.15s", userSelect:"none" },
  infoTip: { position:"absolute", bottom:36, right:0, background:T.color.surfaceLow, color:T.color.onSurfaceVariant, padding:"12px 16px", borderRadius:T.radius.lg, fontSize:11, fontFamily:T.font.sans, lineHeight:1.8, whiteSpace:"nowrap", boxShadow:"0 4px 16px rgba(3,22,50,0.08)", zIndex:10 },

  // Legacy action styles (kept for reference, no longer rendered)
  actionBtn: { display:"flex", flexDirection:"column", alignItems:"center", gap:12, background:"transparent", border:"none", cursor:"pointer", padding:0, fontFamily:T.font.sans },
  actionBoxAgain: { width:80, height:80, borderRadius:T.radius.lg, background:T.color.surfaceHigh, color:T.color.primary, display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.2s" },
  actionBoxGot: { width:80, height:80, borderRadius:T.radius.lg, background:T.color.secondary, color:T.color.onSecondary, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 24px rgba(156,66,52,0.25)", transition:"all 0.2s" },
  actionLabel: { fontSize:11, fontWeight:800, letterSpacing:"0.18em", color:T.color.onSurfaceVariant, textTransform:"uppercase" },

  // Top utility bar — single horizontal row at the top of the page with
  // upload, beta feedback, email and sign-out. Replaces the old vertically
  // stacked header userInfo block.
  // Sticky glass-blur top app bar — direction toggle, type/auto-speak chips
  topBar: { position:"sticky", top:0, zIndex:20, padding:"0 40px", background:"rgba(253,248,246,0.92)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", flexShrink:0 },
  // Same as subToolbar: one line, always, scrolling if the chips outgrow the
  // column. This row growing a second line is what made the card jump 39px in
  // a single frame partway through every horizontal reflow.
  topBarInner: { display:"flex", alignItems:"center", gap:12, padding:"14px 0", maxWidth:1100, width:"100%", margin:"0 auto", borderBottom:"1px solid rgba(3,22,50,0.07)" },
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
  toggleRow: { display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" },
  toggle: { display:"flex", gap:6, alignItems:"center", fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, cursor:"pointer" },
  // Chip-style toggle button — used in the study filter row in place of
  // raw checkboxes. Same pill shape as catBtn but with an active state.
  chipToggle: { padding:"6px 13px", border:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.08)"}`, borderRadius:T.radius.full, background:"transparent", cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500, letterSpacing:"0.02em", transition:"all 0.15s" },
  pendingSwitch: { fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, whiteSpace:"nowrap", flexShrink:0 },
  chipToggleA: { background:T.color.primary, color:T.color.onPrimary, borderColor:T.color.primary, fontWeight:600 },
  // Sits inside the scrolling chip row, so it must not wrap on its own either.
  typeGroup: { display:"flex", gap:6, alignItems:"center", flexWrap:"nowrap", flexShrink:0 },
  typeBtn: { padding:"6px 13px", borderWidth:1, borderStyle:"solid", borderColor:"rgba(3,22,50,0.08)", borderRadius:T.radius.full, background:"transparent", cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500, letterSpacing:"0.02em", transition:"all 0.15s" },
  typeBtnA: { background:T.color.primary, borderColor:T.color.primary, color:T.color.onPrimary, fontWeight:600 },
  dirGroup: { display:"flex", gap:2, marginLeft:"auto", padding:3, background:T.color.surfaceLow, borderRadius:T.radius.md },
  dirBtn: { padding:"5px 12px", border:"none", borderRadius:T.radius.sm, background:"transparent", cursor:"pointer", fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontWeight:500 },
  dirBtnA: { background:T.color.surfaceLowest, color:T.color.primary, fontWeight:600, boxShadow:T.shadow.focus },
  counterRow: { display:"flex", alignItems:"center", gap:8, marginBottom:10 },
  counter: { textAlign:"center", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, letterSpacing:"0.05em", textTransform:"uppercase", fontWeight:500 },
  counterBreakdown: { opacity:0.7 },
  // Unavailable keeps the shape and drops the fill, so the row never shifts
  // and the control still reads as a control rather than a ghost of one.
  backBtnOff: { background:"transparent", color:T.color.onSurfaceVariant, borderColor:"rgba(3,22,50,0.07)", boxShadow:"none", cursor:"default" },
  backBtn: { display:"flex", alignItems:"center", gap:6, padding:"6px 14px 6px 11px", background:T.color.surfaceLowest, borderWidth:1, borderStyle:"solid", borderColor:"rgba(3,22,50,0.22)", borderRadius:T.radius.full, cursor:"pointer", fontSize:11.5, color:T.color.onSurface, fontFamily:T.font.sans, fontWeight:700, letterSpacing:"0.01em", boxShadow:"0 1px 3px rgba(3,22,50,0.07)", transition:"all 0.15s" },
  backBtnDisabled: { padding:"6px 14px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"default", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:500, opacity:0.3 },
  backBtnSpacer: { width:60 },
  // flex:0 1 auto — the card shrinks on short windows but never grows to fill
  // the page. Letting it grow is what pushed the buttons down to the bottom
  // edge and left a gulf in the middle; cardArea now centres the card and its
  // buttons together, so spare height sits above and below the pair.
  // Sized to the TALLEST thing that goes here — a wrong graded answer, which
  // stacks a result banner, the "should have been accepted" link and the
  // Continue row, and measures 170. Anything less and the card still shifts
  // when that state appears; measured, not estimated.
  belowCard: { width:"100%", maxWidth:600, minHeight:170, flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-start" },
  // `0 1 375px`, not `1 1 auto`. The basis is the card's own maxHeight, so the
  // wrapper is exactly as tall as the card wants to be and no taller.
  //
  // It used to GROW to swallow every spare pixel in cardArea, and that slack
  // is what split a reflow into two separate motions. Squeeze the page and the
  // wrapper's slack went first: the card kept its size and only slid upward.
  // Once the slack ran out the card stopped sliding and started shrinking
  // instead. One 420ms animation, two different behaviours, with a hard
  // switchover about 80% of the way through — and on the way back the card
  // recovered 62% of its size in a single frame.
  //
  // With a definite basis there is no slack to spend first. The spacer above
  // (basis 106) and this (basis 375) shrink together, weighted by those bases,
  // from the first pixel of the squeeze: the card moves and resizes at the
  // same time, over one curve, instead of doing one and then the other.
  //
  // Grow stays 0 so a tall window still leaves the card at 375 rather than
  // stretching it; the spare height goes to cardArea's `safe center` instead.
  // The basis must stay DEFINITE — `auto` reintroduces the circularity with
  // the card's `height: 100%` below and collapses it to its 170px floor.
  //
  // The SAME maxHeight as the card, and that matters more than it looks.
  //
  // This wrapper used to be allowed to stand taller than the card could ever
  // be — 309px against a 290px cap at an 800px window. That 19px of slack is
  // an absorber, and absorbers are what make a reflow lurch: opening the sheet,
  // the card sat perfectly still for three frames while the slack was eaten,
  // then started shrinking at 0.64px per px of page movement the moment the
  // wrapper dropped to the card's size. Still, then moving, in one frame.
  //
  // Capping both at the same value leaves nothing to eat first, so the card
  // starts moving on frame one and keeps one rate throughout. The query
  // container is cardArea (see there) because an element cannot query itself,
  // and 62.5cqw resolves the same against it: this wrapper is
  // min(600, cardArea width) wide, and above 600 the 375px cap wins anyway.
  cardWrap: { perspective:1200, marginBottom:20, width:"100%", maxWidth:600, position:"relative", zIndex:1, flex:"0 1 min(375px, 62.5cqw)", minHeight:170, maxHeight:"min(375px, 62.5cqw)", display:"flex", alignItems:"safe center", justifyContent:"center" },
  // maxHeight caps it on tall screens and lets it give up height on short
  // ones; the old minHeight:340 floor is what made it overflow instead.
  // Height-driven so a short window shrinks the card instead of overflowing
  // it, but with a floor: making it height-driven with no minimum meant it
  // absorbed the entire squeeze when a panel opened, collapsing to nothing
  // while 130px of padding sat unused below it.
  //
  // maxHeight caps the card on BOTH axes, which took a container query.
  //
  // The container is cardArea, not cardWrap: INLINE-size, not size — size
  // containment on an ancestor of the rotating card is the hazard the note
  // below warns about. Verified by sampling the card's transform mid-rotation
  // rather than trusting its computed style: still a real matrix3d.
  //
  // `aspect-ratio` only holds while one axis is free to follow the other. The
  // height came from the flex column and the width was capped by
  // `max-width: 100%`, so once the COLUMN was the tight axis both were pinned
  // and the ratio simply lost: at an 800px window the card was 464x375, near
  // enough a square, and at 900 it was 1.5:1. Long-standing, and invisible to
  // a suite that varied only the window height.
  //
  // 62.5cqw is 100/1.6 percent of cardWrap's width, so this reads "never
  // taller than the width can support", and whichever of the two caps binds
  // first, the card stays 1.6:1.
  //
  // NO containerType here. container-type: size applies containment, which
  // makes the element a grouping element and so FLATTENS transform-style:
  // preserve-3d — the computed style still reads preserve-3d, but the card
  // stopped rotating and just swapped faces mid-flip. The query container is
  // each face instead; they are inset:0 so their size is the card's, and they
  // hold no 3D children of their own.
  card: { position:"relative", height:"100%", minHeight:170, maxHeight:"min(375px, 62.5cqw)", maxWidth:"100%", transformStyle:"preserve-3d", transition:"transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)", aspectRatio:"1.6 / 1" },
  cardFront: { containerType:"size", backfaceVisibility:"hidden", position:"absolute", inset:0, background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, padding:"28px 30px", display:"flex", flexDirection:"column", justifyContent:"safe center", alignItems:"center", boxShadow:"0 8px 32px rgba(3,22,50,0.08)", overflow:"hidden" },
  cardBack: { containerType:"size", backfaceVisibility:"hidden", position:"absolute", inset:0, transform:"rotateY(180deg)", background:T.color.surfaceLowest, border:"none", borderRadius:T.radius.xl, padding:"28px 30px", display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", boxShadow:"0 8px 32px rgba(3,22,50,0.08)", overflow:"hidden", borderTop:`3px solid ${T.color.secondary}` },
  cardCat: { position:"absolute", top:14, left:18, display:"flex", alignItems:"center", gap:7, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:600 },
  langBadge: { position:"absolute", top:14, right:18, fontSize:9, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, background:T.color.surfaceHigh, padding:"3px 9px", borderRadius:T.radius.full, letterSpacing:"0.08em", fontWeight:600, textTransform:"uppercase" },
  dot: { width:7, height:7, borderRadius:"50%" },
  // Names the lesson a card belongs to, so the prompt itself does not have to.
  // Absolute rather than in flow: cardFront centres its children, and a badge
  // in the column would shove the prompt off the middle of the card.
  // Outlined pill naming the card's lesson.
  //
  // right:70 rather than tucked into the corner because the back face floats
  // the edit button at top:18/right:18 and it is about 40px wide — at right:16
  // the two sat on top of each other. Same offset on both faces so the badge
  // does not jump sideways mid-flip, and top:19 centres it against that
  // button so the two read as one row rather than two near-misses. The pencil
  // is 25px tall against the badge's 20, so their tops differ by design —
  // top:23 is what puts the two centre lines together.
  // Set as written, not uppercased: a lesson title is a name ("L'impératif"),
  // and forcing caps on it both loses that and mangles the accented capital.
  // Sentence case needs a little more size and a lot less tracking than the
  // 9px micro-caps it replaces.
  cardBadge: { position:"absolute", top:23, right:70, padding:"4px 10px", borderRadius:999, border:`1px solid ${T.color.outline || "rgba(3,22,50,0.18)"}`, fontSize:10.5, fontWeight:600, letterSpacing:"0.01em", color:T.color.onSurfaceVariant, fontFamily:T.font.sans, background:"transparent", pointerEvents:"none", maxWidth:"48%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  cardInstruction: { fontSize:"clamp(12px, 4.6cqh, 15px)", textAlign:"center", fontWeight:600, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, lineHeight:1.35, maxWidth:"34em", margin:"0 auto 14px", padding:"0 12px" },
  cardText: { fontSize:"clamp(19px, 10.7cqh, 40px)", textAlign:"center", fontWeight:700, color:T.color.primary, lineHeight:1.15, padding:"0 12px", fontFamily:T.font.serif, letterSpacing:"-0.025em" },
  cardTextB: { fontSize:"clamp(16px, 8.3cqh, 31px)", textAlign:"center", fontWeight:600, color:T.color.primary, lineHeight:1.25, padding:"0 12px", fontFamily:T.font.serif, letterSpacing:"-0.015em" },
  dateH: { position:"absolute", bottom:12, right:18, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, opacity:0.7 },
  hint: { position:"absolute", bottom:12, left:18, fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontStyle:"italic", opacity:0.7 },
  btnRow: { display:"flex", gap:12, marginBottom:12 },
  btnWrong: { flex:1, padding:"15px", border:"none", borderRadius:T.radius.md, background:T.color.secondary, color:T.color.onSecondary, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow:T.shadow.button, letterSpacing:"0.01em" },
  btnRight: { flex:1, padding:"15px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow:T.shadow.button, letterSpacing:"0.01em" },
  shortcuts: { textAlign:"center", fontSize:10, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, opacity:0.7, letterSpacing:"0.03em" },
  // The lesson you are in, set as a title rather than a pill: it names where
  // you are, and the only pill-shaped things in this row are controls.
  lessonName: { fontFamily:T.font.serif, fontSize:15, fontWeight:600, color:T.color.primary, whiteSpace:"nowrap", letterSpacing:"-0.01em", flexShrink:0 },
  lessonIntro: { fontSize:13, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, maxWidth:560, lineHeight:1.55, marginBottom:24 },
  lessonCard: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"20px 24px", marginBottom:12, boxShadow:T.shadow.card, maxWidth:720 },
  lessonHead: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16 },
  lessonTitle: { fontSize:18, fontFamily:T.font.serif, color:T.color.onSurface, marginBottom:4 },
  lessonSub: { fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  lessonMeta: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, marginTop:14, textTransform:"uppercase", letterSpacing:"0.06em" },
  lessonAddBtn: { padding:"9px 18px", border:"none", borderRadius:T.radius.md, background:T.color.primary, color:"#fff", fontSize:12, fontWeight:600, fontFamily:T.font.sans, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 },
  lessonStudyBtn: { padding:"9px 18px", border:"none", borderRadius:T.radius.md, background:T.color.surfaceLow, color:T.color.primary, fontSize:12, fontWeight:600, fontFamily:T.font.sans, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0, boxShadow:T.shadow.focus },
  empty: { textAlign:"center", padding:60, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  sessionDone: { textAlign:"center", padding:24, background:T.color.surfaceLow, borderRadius:T.radius.xl, marginTop:12 },
  doneText: { fontSize:14, color:T.color.primary, fontFamily:T.font.sans, marginBottom:14, fontWeight:500 },
  lessonProgress: { fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, whiteSpace:"nowrap", fontVariantNumeric:"tabular-nums", flexShrink:0 },
  checkpointHead: { fontSize:22, color:T.color.primary, fontFamily:T.font.serif, fontWeight:600, margin:"0 0 16px" },
  checkpointAreas: { display:"flex", flexDirection:"column", gap:10, margin:"0 auto 16px", maxWidth:420, textAlign:"left" },
  checkpointArea: { background:T.color.surfaceLowest, borderRadius:T.radius.md, padding:"10px 14px" },
  checkpointAreaName: { fontSize:13, fontWeight:700, color:T.color.primary, fontFamily:T.font.sans },
  checkpointAreaDelta: { fontSize:13, color:T.color.secondary, fontFamily:T.font.sans, fontWeight:600, marginTop:2 },
  checkpointAreaTotal: { fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, marginTop:2, fontVariantNumeric:"tabular-nums" },
  checkpointNote: { fontSize:14, color:T.color.onSurface, fontFamily:T.font.sans, margin:"0 auto 14px", maxWidth:420, lineHeight:1.5 },
  resetSBtn: { padding:"11px 26px", border:"none", borderRadius:T.radius.md, background:T.color.surfaceLowest, color:T.color.primary, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, boxShadow:T.shadow.focus },
  // Stats — bento dashboard
  statsHeading: { fontSize:36, fontWeight:600, color:T.color.primary, fontFamily:T.font.serif, letterSpacing:"-0.02em", margin:"8px 0 28px" },
  // ── New stats layout: metric cards + pipeline + hardest ───────────
  typeGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:12, marginTop:10 },
  typeCard: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"14px 16px 16px", border:"1px solid rgba(3,22,50,0.06)" },
  typeVal: { fontSize:28, fontFamily:T.font.serif, fontWeight:700, color:T.color.primary, marginTop:8, letterSpacing:"-0.02em" },
  typeSub: { fontSize:11.5, color:T.color.onSurfaceVariant, marginTop:2 },
  typeBarWrap: { height:4, borderRadius:2, background:"rgba(3,22,50,0.07)", marginTop:10, overflow:"hidden" },
  typeBar: { height:"100%", borderRadius:2, transition:"width 300ms ease" },
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
  pipeLegend: { display:"flex", flexWrap:"wrap", gap:"6px 20px" },
  pipeLegItem: { display:"flex", alignItems:"center", gap:6, fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, whiteSpace:"nowrap" },
  pipeDot: { width:8, height:8, borderRadius:"50%", flexShrink:0 },
  // Section titles
  bandTrack: { display:"flex", borderRadius:6, overflow:"hidden", background:T.color.surfaceHigh, marginBottom:10 },
  cahierNotice: { display:"flex", alignItems:"center", gap:12, margin:"0 24px 4px", padding:"10px 14px", borderRadius:10,
    background:T.color.surfaceHigh, color:T.color.onSurface, fontFamily:T.font.sans, fontSize:13, lineHeight:1.4 },
  cahierDismiss: { marginLeft:"auto", border:"none", background:"transparent", cursor:"pointer", color:T.color.onSurfaceVariant, fontSize:13, padding:4 },
  statsFootnote: { fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, margin:"12px 0 0", lineHeight:1.5 },
  areaList: { display:"flex", flexDirection:"column", gap:10 },
  areaRow: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"14px 18px", border:"1px solid rgba(3,22,50,0.06)" },
  areaHead: { display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:12, marginBottom:10, flexWrap:"wrap" },
  areaName: { fontSize:15, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary },
  areaSub: { fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant },
  areaFigures: { fontSize:12.5, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, fontVariantNumeric:"tabular-nums", marginTop:-2 },
  weekChart: { display:"grid", gridTemplateColumns:"repeat(7, minmax(0, 1fr))", gap:8, background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"16px 18px", border:"1px solid rgba(3,22,50,0.06)" },
  weekCol: { display:"flex", flexDirection:"column", alignItems:"center", gap:6, minWidth:0 },
  weekCount: { fontSize:12, fontFamily:T.font.sans, fontWeight:600, color:T.color.primary, fontVariantNumeric:"tabular-nums" },
  weekBarSlot: { height:90, width:"100%", maxWidth:36, display:"flex", alignItems:"flex-end", background:T.color.surfaceLow, borderRadius:4, overflow:"hidden" },
  weekBar: { width:"100%", background:T.color.secondary, borderRadius:"4px 4px 0 0", minHeight:0 },
  weekLabel: { fontSize:11, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.04em" },
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
  cardActionBtn: { width:30, height:30, display:"flex", alignItems:"center", justifyContent:"center", background:T.color.surfaceLow, border:"none", borderRadius:"50%", padding:0, fontSize:13, cursor:"pointer", color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.02em" },
  cardActionBtnFlagged: { background:T.color.tertiaryFixed, color:T.color.onSecondaryContainer, cursor:"default", fontWeight:700 },
  // Type mode (study input)
  typeInputRow: { display:"flex", gap:10, justifyContent:"center", marginBottom:10 },
  giveUpRow: { display:"flex", justifyContent:"center", marginBottom:4, flexShrink:0 },
  giveUpBtn: { padding:"6px 14px", background:"transparent", border:"none", cursor:"pointer", fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:600, letterSpacing:"0.02em", textDecoration:"underline" },
  typeInput: { flex:1, maxWidth:280, padding:"11px 15px", border:"none", background:T.color.surfaceLowest, borderRadius:T.radius.lg, fontSize:16, fontFamily:T.font.serif, outline:"none", color:T.color.primary, boxShadow:T.shadow.focus },
  typeSubmit: { padding:"11px 22px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:T.font.sans, boxShadow:T.shadow.button, letterSpacing:"0.01em" },
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
  // One 420px column under the card in type mode — the width of Again and Got
  // It — so the result banner and the link rows share both edges, and Continue
  // sits centred in it. It used to be four widths stacked: card 600, banner
  // 520, links as centred text, Continue pushed right in a 480 row.
  typeFeedback: { width:"100%", maxWidth:420, alignSelf:"center", display:"flex", flexDirection:"column", gap:10 },
  typeCorrect: { textAlign:"center", padding:"13px 14px", background:"#dcece5", color:"#1f5446", borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  typeClose: { textAlign:"center", padding:"13px 14px", background:T.color.surfaceHigh, color:T.color.primary, borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  typeRevealed: { textAlign:"center", padding:"13px 14px", background:T.color.surfaceHigh, color:T.color.primary, borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  typeWrong: { textAlign:"center", padding:"13px 14px", background:T.color.errorContainer, color:T.color.onErrorContainer, borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  // Links at either end of the column, their text on its edges.
  typeLinksRow: { display:"flex", alignItems:"center", justifyContent:"center", flexWrap:"wrap", columnGap:32, rowGap:4, minHeight:24, fontFamily:T.font.sans },
  typeLink: { padding:"4px 0", background:"transparent", border:"none", color:T.color.secondary, fontSize:12, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, textDecoration:"underline", textUnderlineOffset:3 },
  typeLinkMuted: { color:T.color.onSurfaceVariant, fontWeight:500, opacity:0.8 },
  typeBtnRow: { display:"flex", gap:12, marginTop:8 },
  feedbackRow: { textAlign:"center", fontFamily:T.font.sans, fontSize:12 },
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
  continueBtn: { alignSelf:"center", display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"11px 26px", border:"none", borderRadius:T.radius.md, background:T.gradient.ink, color:T.color.onPrimary, fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:T.font.sans, letterSpacing:"-0.01em", boxShadow:"0 6px 20px rgba(3,22,50,0.14)", transition:"all 0.15s" },
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
  // Feedback log (shared by the modal and the Feedback Review page)
  fbLogHeader: { display:"flex", alignItems:"center", gap:10, paddingBottom:14, borderBottom:"1px solid rgba(3,22,50,0.08)" },
  fbLogTitle: { margin:0, fontSize:24, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary },
  fbLogCount: { fontSize:12, fontFamily:T.font.sans, fontWeight:500, color:T.color.onSurfaceVariant, background:T.color.surfaceLow, padding:"3px 10px", borderRadius:T.radius.md },
  fbLogClose: { background:"none", border:"none", fontSize:24, lineHeight:1, cursor:"pointer", color:T.color.onSurfaceVariant, padding:"0 4px" },
  fbLogNote: { fontSize:13, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, padding:"12px 0 0" },
  fbLogEmpty: { textAlign:"center", padding:32, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontSize:14 },
  // A scroll container clips to its padding box, and the thumbnail sits flush
  // against the list's right edge — so the focus ring it gets back after Escape
  // closes the lightbox (2px, offset 2px) was cut off down its right side and
  // read as a stray white bar through the thumbnail. 4px of padding, cancelled
  // by the margin, gives the ring room without moving anything.
  fbLogList: { overflowY:"auto", minHeight:0, padding:"0 4px", margin:"0 -4px" },
  fbLogPage: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"4px 24px", boxShadow:T.shadow.card },
  fbEntry: { display:"grid", gridTemplateColumns:"32px minmax(0, 1fr)", columnGap:12, padding:"16px 0", borderBottom:"1px solid rgba(3,22,50,0.08)", fontFamily:T.font.sans },
  // Same line height as the message, so the number sits on its first line.
  fbEntryNumber: { fontSize:15, fontWeight:600, lineHeight:"25.5px", color:T.color.onSurfaceVariant, fontVariantNumeric:"tabular-nums" },
  fbEntryMsg: { fontSize:17, lineHeight:1.5, color:T.color.onSurface, whiteSpace:"pre-wrap", overflowWrap:"anywhere" },
  fbEntryMeta: { fontSize:13, color:T.color.onSurfaceVariant, marginTop:2 },
  fbEntryRow: { display:"grid", gap:12, alignItems:"stretch", marginTop:12 },
  fbEntryCard: { background:T.color.surfaceLow, borderRadius:T.radius.md, padding:"10px 12px", minWidth:0 },
  fbEntryCardLabel: { fontSize:13, color:T.color.onSurfaceVariant, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  fbEntryCardText: { fontSize:16, lineHeight:1.5, color:T.color.onSurface, marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  fbEntryThumb: { display:"block", position:"relative", padding:0, border:"1px solid rgba(3,22,50,0.08)", borderRadius:T.radius.md, background:T.color.surfaceLow, overflow:"hidden", cursor:"zoom-in", minHeight:64 },
  // Absolute, so the image never sets the row height: the thumbnail follows the card beside it.
  fbEntryThumbImg: { position:"absolute", inset:0, display:"block", width:"100%", height:"100%", objectFit:"cover", objectPosition:"center top" },
  fbLightbox: { position:"fixed", inset:0, background:"rgba(3,22,50,0.72)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1100, padding:24, cursor:"zoom-out" },
  // Capped well below the window, not fitted to it. Screenshots come off
  // retina screens at twice their on-screen size: fitted, a screenshot of the
  // app filled the screen like the app itself, and a first cap of 820px only
  // took it from ~925px to 820 on a laptop, which read as no change.
  fbLightboxImg: { width:"auto", height:"auto", maxWidth:"min(560px, 100%)", maxHeight:"min(420px, 100%)", objectFit:"contain", borderRadius:T.radius.lg, boxShadow:"0 32px 96px rgba(0,0,0,0.35)" },
  // Feedback review modal
  feedbackModalOverlay: { position:"fixed", inset:0, background:"rgba(3,22,50,0.4)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 },
  feedbackModalBox: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, maxWidth:600, width:"100%", padding:"24px 28px 8px", boxShadow:"0 32px 96px rgba(3,22,50,0.18)", fontFamily:T.font.sans, maxHeight:"80vh", overflow:"hidden", display:"flex", flexDirection:"column" },
  // Users table
  usersTable: { width:"100%", borderCollapse:"collapse", fontFamily:T.font.sans, fontSize:13 },
  usersTh: { textAlign:"left", padding:"10px 12px", fontSize:10, fontWeight:700, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.08em", borderBottom:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.08)"}` },
  usersTd: { padding:"10px 12px", borderBottom:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.04)"}`, color:T.color.onSurface },
  usersTdNum: { padding:"10px 12px", borderBottom:`1px solid ${T.color.outlineGhost || "rgba(3,22,50,0.04)"}`, color:T.color.primary, fontWeight:600, textAlign:"center" },
};

