import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { RAW } from "./data/cards"; // only used for the admin "seed demo deck" action
import { LESSONS, LESSON_GROUPS, LESSONS_SHOWN, lessonIdOf, lessonRank, cardInstructionFor, lessonBackFor } from "./data/lessons";
import { reconcileLessons, ADOPTED_SOURCE } from "./lib/lessonSync";
import { archivedSource } from "./lib/archive";
import { readPlace, writePlace, dropSets, packSet, unpackEntries } from "./lib/studyPlace";
import { CHOICE_KEY, choicesOf, startedLessons, lessonsInCards, onCards, setKeyOf, dealScopeOf } from "./lib/lessonChoice";
import { withdrawRetry } from "./lib/sessionQueue";
import LessonPanel, { LESSON_PANEL_WIDTH } from "./LessonPanel";
import Tour from "./Tour";
import { tourSteps, TOUR_LESSON } from "./lib/tourSteps";
import { useProgress } from "./useProgress";
import { cleanFrenchPrompt, cleanEnglishPrompt, dropFinalPeriod } from "./lib/cardText";
import { drillAlternates, isConjugationDrill } from "./lib/cardInstruction";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";
import { classifyCard, CARD_TYPES, TYPE_LABEL, TYPE_COLOR } from "./lib/cardTypes";
import { useUserDeck } from "./useUserDeck";
import { useCahierSync } from "./useCahierSync";
import { supabase } from "./supabase";
import { CahierUpload } from "./CahierUpload";
import { BetaFeedback } from "./BetaFeedback";
import { FEEDBACK_REVIEW_VERSION } from "./lib/feedbackReviewVersion";
import ApiKeyModal from "./ApiKeyModal";
import FsrsSettingsModal from "./FsrsSettingsModal";
import { useFsrsSettings } from "./useFsrsSettings";
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
import { localISODate, reviewedToday, endOfLocalDay, browserTimeZone } from "./lib/studyDay";
import { progressByArea, progressChanges, aboutRemembered, areaDates } from "./lib/progress";
import { statsOverTime, HISTORY_COLUMNS, endOfDayAgo, allSeenBy } from "./lib/progressHistory";
import { RememberedChart, StudyCalendar, ProgressByLesson, Bands, splitText } from "./StatsSections";
import { buildSession, applyAnswer, placeRetry, countBuckets, BLOCK_SIZE } from "./lib/sessionQueue";
import { RE_QUEUE_OFFSET, State, settingsInUse } from "./lib/spacedRepetition";
import { sideOf, sideColumns, directionsOf, isTwoWay, itemKey, resetColumns } from "./lib/directions";
import { newReviewId, reviewRow, withoutExtras, missingColumn } from "./lib/reviewLog";
import { dealRow, missingTable } from "./lib/dealLog";
import { uploadResultText } from "./lib/uploadText";

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
    // Curly quotes too: smart punctuation types ’, so "d’un air" and "d'un air" differ
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
// Auto-speak and the number of cards in a set, kept on this browser like the
// flip/type choice. A new set size applies to the set on screen at once (the
// deck-build effect).
const AUTO_SPEAK_KEY = "auto-speak";
const SET_SIZE_KEY = "set-size";
const SET_SIZES = [20, 30, 50, 100];

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
function uploadDoneText({ cardsInserted = 0, datesCovered = 0, busy = false }) {
  // Only one reading of a student's notes runs at a time (2026-10-06).
  if (busy && cardsInserted === 0) {
    return "Your cahier is linked. Your notes are being read right now, by an upload or the daily check, so its new classes will be added on the next check.\n\nFrom now on, each class Laura adds becomes cards on its own.";
  }
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
  const { cards: userCards, archived: archivedCards, loaded: deckLoaded, reload: reloadDeck, patch: patchDeckCard, patchAll: patchAllDeckCards, add: addDeckCard, freshSeq: deckFreshSeq, fetchedAt: deckFetchedAt } = useUserDeck(user);
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
  // How the set is made up, counted from the set as it now is. It was counted
  // once, when the set was dealt, and never again, though each retry pushes a
  // card out of the set: with 6 retries, "15 new" might mean 9 (2026-09-27).
  const sessionCounts = useMemo(() => countBuckets(deck), [deck]);
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
  // Which fetch of the deck the block was dealt from, and on which day. When
  // either has moved on, the block is dealt again — see the deck-build effect.
  const dealtSeqRef = useRef(null);
  const dealtDayRef = useRef(null);
  // And which lessons were switched off then (switchSig), and the set size.
  const dealtSwitchRef = useRef(null);
  const dealtSizeRef = useRef(null);
  // Bumped on coming back to the tab on a new day, to run that check.
  const [recheck, setRecheck] = useState(0);
  // Where the student was, kept in this browser (lib/studyPlace.js): the set
  // for each lesson and for the whole deck — today's only — and which of them
  // they were in. Read once. Which fetch a set was dealt from means nothing to
  // a new page, so that is dropped here.
  const placeRef = useRef(null);
  if (placeRef.current === null) {
    const stored = readPlace(user?.id);
    const today = localISODate();
    const sets = {};
    for (const [k, v] of Object.entries(stored?.sets || {})) if (v?.day === today) sets[k] = { ...v, seq: null };
    placeRef.current = { current: stored?.current || null, sets };
  }
  // Which set the deck on screen is: the filters it was dealt for. State, not a
  // ref, so it changes in the same render as the deck, and a set is only ever
  // saved under its own key.
  const [deckSig, setDeckSig] = useState(null);
  // What the last deal or return of a set was made from — see the guard at the
  // top of the deck-build effect.
  const scheduledRef = useRef(null);
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
  const [typeFilter, setTypeFilter] = useState(() => {
    const t = placeRef.current.current?.typeFilter;
    return t === "all" || CARD_TYPES.includes(t) ? t : "all";
  });
  // Study one lesson's cards instead of the whole deck. "all" is everything.
  // Like typeFilter this narrows the candidate pool the session is built
  // from, so the lesson still schedules through FSRS normally.
  // Both, and the direction, start where the student left them on this browser.
  const [lessonFilter, setLessonFilter] = useState(() => {
    const l = placeRef.current.current?.lessonFilter;
    return l === "all" || LESSONS.some((x) => x.id === l) ? l : "all";
  });
  // Cards: everything, or only the student's own cards, "My cahier"
  // (lib/lessonChoice.js). Kept with the other two. Inside a lesson it has no
  // effect, and its control is hidden.
  const [scope, setScope] = useState(() => (placeRef.current.current?.scope === "cahier" ? "cahier" : "all"));
  const [dir, setDir] = useState(() => {
    const d = placeRef.current.current?.dir;
    return ["fr", "en", "mix"].includes(d) ? d : "mix"; // fr | en | mix
  });
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
  // How many cards a set has. Changing it changes the set on screen: the
  // cards not yet reached are dealt again to the new length, while the card on
  // screen, every answer and the retries lined up stay where they are. It used
  // to wait for the next set, and the counter went on saying "of 50" after 20
  // was chosen (2026-10-06).
  const [setSize, setSetSize] = useState(() => {
    try {
      const n = Number(localStorage.getItem(SET_SIZE_KEY));
      return SET_SIZES.includes(n) ? n : BLOCK_SIZE;
    } catch { return BLOCK_SIZE; }
  });
  const setSizeRef = useRef(setSize);
  setSizeRef.current = setSize;
  useEffect(() => {
    try { localStorage.setItem(SET_SIZE_KEY, String(setSize)); } catch { /* storage blocked */ }
  }, [setSize]);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [typeResult, setTypeResult] = useState(null); // null | 'correct' | 'wrong'
  const studyInputRef = useRef(null);

  // Upload & onboarding state
  const [showUpload, setShowUpload] = useState(false);
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
  // The settings menu behind the gear: direction, typing, auto-speak, lessons,
  // set size. Closes on a click outside it or Escape.
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(null);
  useEffect(() => {
    if (!showSettings) return;
    const onDown = (e) => { if (!settingsRef.current?.contains(e.target)) setShowSettings(false); };
    const onKey = (e) => { if (e.key === "Escape") setShowSettings(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showSettings]);

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

  // Leaving the lesson page closes its notes, wherever you go: Stats, the
  // Lessons page, the whole deck or another lesson. Lessons and Stats only
  // change the page, so the notes stayed open over Stats. Keyed on the page
  // itself rather than on each way off it, so a new way off can't bring it back.
  useEffect(() => { setShowLessonPanel(false); }, [mode, lessonFilter]);

  // "Connect your Claude account". Everything that calls Claude bills the
  // caller's own Anthropic key now, so there has to be somewhere to put one.
  const [showKeyModal, setShowKeyModal] = useState(false);
  // "How much to remember", and the student's own FSRS settings behind it:
  // applied to the scheduler, checked once a day (useFsrsSettings).
  const [showFsrsSettings, setShowFsrsSettings] = useState(false);
  const fsrs = useFsrsSettings(user, { cards: userCards, freshSeq: deckFreshSeq, dir, onEstimatesChanged: reloadDeck });
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

  // The window's width, because whether a panel can sit beside the card is a
  // question about how much room is left. There is no phone layout: the app
  // is for a computer's browser (the owner, 2026-09-29).
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
        setWinWidth(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
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
  const [feedbackErrMsg, setFeedbackErrMsg] = useState("");
  const [feedbackVerdict, setFeedbackVerdict] = useState(null); // {verdict, reasoning}
  // The "My answer should be accepted" check in progress for the card on
  // screen, as a ticket its result must still hold when it arrives. Moving on
  // — Continue, Enter, Previous card — drops the ticket: the answer was saved
  // as the first mark gave it, wrong, and stays so (the owner's rule,
  // 2026-09-27). The result used to land on whichever card was on screen when
  // it came back, and accepted a wrong answer there.
  const disputeRef = useRef(null);
  const autoAdvanceTimer = useRef(null);
  const isAdmin = !!(user?.email && user.email.toLowerCase() === ADMIN_EMAIL);
  // "Status" in the profile menu (admin only): whether the cards are being
  // shown the way FSRS and the app's rules say. See lib/statusChecks.js.

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
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try { return localStorage.getItem(AUTO_SPEAK_KEY) === "on"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(AUTO_SPEAK_KEY, autoSpeak ? "on" : "off"); } catch { /* storage blocked */ }
  }, [autoSpeak]);
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
  // Which lessons come up on Cards (lib/lessonChoice.js). The student's
  // choices are kept on their account: read from the session, and once from
  // the server on opening, in case another computer has changed them since
  // this one last signed in.
  const [lessonChoices, setLessonChoices] = useState(() => choicesOf(user));
  const lessonChoicesRef = useRef(lessonChoices);
  lessonChoicesRef.current = lessonChoices;
  const sessionChoices = JSON.stringify(choicesOf(user));
  useEffect(() => { setLessonChoices(JSON.parse(sessionChoices)); }, [sessionChoices]);
  // Whether the account says the first-visit tour has been shown, read at the
  // same time: null until the server has answered (see the tour, below).
  const [accountTourSeen, setAccountTourSeen] = useState(null);
  useEffect(() => {
    if (!user?.id) return;
    let live = true;
    supabase.auth.getUser()
      .then(({ data }) => {
        if (!live || data?.user?.id !== user.id) return;
        setLessonChoices(choicesOf(data.user));
        setAccountTourSeen(!!data.user.user_metadata?.tour_shown);
      })
      .catch(() => { /* the session's copy stands */ })
      .finally(() => { if (live) setAccountTourSeen((v) => v ?? !!user?.user_metadata?.tour_shown); });
    return () => { live = false; };
  }, [user?.id]);
  // The lesson whose switch failed to save, to say so beside it.
  const [choiceFailed, setChoiceFailed] = useState(null);
  // Lessons in the sidebar, folded by a press on it on the Lessons page.
  // Opens again on any move to another page or lesson.
  const [lessonsFolded, setLessonsFolded] = useState(false);
  useEffect(() => { setLessonsFolded(false); }, [mode, lessonFilter]);
  // A heading among the lessons (Basic Lessons) folds its own list away. Open
  // unless the student folded it; folded, it still shows the lesson they're in.
  const [closedGroups, setClosedGroups] = useState(() => new Set());
  const toggleGroup = (title) => setClosedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(title)) next.delete(title); else next.add(title);
    return next;
  });
  // The same on the Lessons page, kept apart from the sidebar's.
  const [pageClosedGroups, setPageClosedGroups] = useState(() => new Set());
  const togglePageGroup = (title) => setPageClosedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(title)) next.delete(title); else next.add(title);
    return next;
  });
  const setLessonChoice = useCallback(async (id, on) => {
    const was = lessonChoicesRef.current[id];
    const next = { ...lessonChoicesRef.current, [id]: on };
    lessonChoicesRef.current = next;
    setLessonChoices(next);
    setChoiceFailed(null);
    const { error } = await supabase.auth.updateUser({ data: { [CHOICE_KEY]: next } });
    if (!error) return;
    console.error("Saving the lesson switch failed:", error);
    setLessonChoices((cur) => ({ ...cur, [id]: was }));
    setChoiceFailed(id);
  }, []);
  const lessonIds = useMemo(() => LESSONS.map((l) => l.id), []);
  const lessonsStarted = useMemo(() => startedLessons(userCards), [userCards]);
  // The lessons switched off, as a string, so that it changes only when one
  // is switched, not on every answer.
  const switchedOn = lessonsInCards(lessonIds, lessonsStarted, lessonChoices);
  const lessonsOff = lessonIds.filter((id) => !switchedOn.has(id)).join(",");
  const lessonsOn = useMemo(
    () => new Set(lessonIds.filter((id) => !lessonsOff.split(",").includes(id))),
    [lessonIds, lessonsOff]
  );
  // What the lesson switches change about the set on screen: on Cards with
  // everything, which lessons are off; nothing under My cahier or inside a
  // lesson. A set dealt under other switches has its cards not yet reached
  // dealt again (the deck-build effect).
  const switchSig = lessonFilter === "all" && scope === "all" ? lessonsOff : "";

  // The cards a set may hold: one lesson's, or the whole deck's, and one
  // type's when the student has narrowed it. A set under way is read back
  // from these, so a card it has already shown stays in it when its lesson is
  // switched off.
  const poolFrom = useCallback((cards) => {
    let candidates = cards;
    if (typeFilter !== "all") candidates = candidates.filter(c => classifyCard(c) === typeFilter);
    if (lessonFilter !== "all") candidates = candidates.filter(c => lessonIdOf(c) === lessonFilter);
    return candidates;
  }, [typeFilter, lessonFilter]);
  // The cards a set is dealt from: the pool, less on Cards the lessons
  // switched off, or every lesson under My cahier.
  const candidatesFrom = useCallback((cards) => {
    const pool = poolFrom(cards);
    if (lessonFilter !== "all") return pool;
    return pool.filter((c) => onCards(c, { scope, lessonsOn, lessonIds }));
  }, [poolFrom, lessonFilter, scope, lessonsOn, lessonIds]);

  // The record of each set dealt (lib/dealLog.js), for the status check. Never
  // waited on and never retried: a set is studied the same whether its record
  // saved or not. Before migration_013 there is no table to write to: after the
  // first refusal nothing more is sent that study day, and the next day tries
  // again, so a page left open picks it up once the update has been run.
  const dealLogOffRef = useRef(null);
  const recordDeal = (fields) => {
    if (!user?.id || dealLogOffRef.current === localISODate()) return;
    const row = dealRow({ id: newReviewId(), userId: user.id, timeZone: browserTimeZone(), ...fields });
    supabase.from("dealt_sets").insert(row).then(({ error }) => {
      if (!error) return;
      if (missingTable(error) || missingColumn(error)) dealLogOffRef.current = localISODate();
      else console.warn("Recording a dealt set failed:", error.message || error);
    });
  };

  useEffect(() => {
    if (!loaded) return;
    // Direction is not part of this: changing it re-deals the cards still to
    // come (see the effect below) instead of dealing a new block, which threw
    // away the block's running count and a missed card's pending retry.
    const filterSig = setKeyOf(typeFilter, lessonFilter, scope);
    // A set dealt, or brought back, that hasn't reached the screen yet is not
    // dealt again from the same deck. Under React's strict mode an effect runs
    // twice on mount, the second time before the first one's deck is in state:
    // it dealt a fresh set over one just brought back from the browser.
    const stamp = { sig: filterSig, blockSeq, fresh: deckFreshSeq, cards: userCards, recheck, switches: switchSig };
    const last = scheduledRef.current;
    if (deck.length === 0 && last && last.sig === stamp.sig && last.blockSeq === stamp.blockSeq &&
        last.fresh === stamp.fresh && last.cards === stamp.cards && last.recheck === stamp.recheck &&
        last.switches === stamp.switches) return;
    const prevSig = filterSigRef.current;
    const filterChanged = prevSig !== filterSig;
    filterSigRef.current = filterSig;

    const candidates = candidatesFrom(userCards);
    const pool = poolFrom(userCards);
    const today = localISODate();
    const dealScope = dealScopeOf(filterSig, switchSig);

    // The cards of a set not yet reached, dealt again from the deck as it now
    // is. What has been shown, answered or lined up for a retry stays put.
    //
    // `size` is the set's length afterwards, when the set size has changed:
    // a longer set gets more cards at the end, a shorter one loses the cards
    // not yet reached. A set shorter than its card on screen, answers and
    // retries leave room for loses its last unanswered retries, as a miss with
    // no room for a retry does (placeRetry): due again tomorrow instead. The
    // set never ends before the card on screen.
    const redealRest = (entries, at, size = entries.length) => {
      const head = entries.slice(0, at + 1);
      const tail = entries.slice(at + 1);
      const answered = (c) => blockAnswersRef.current.has(slotKeyOf(c));
      const staying = tail.filter((c) => c._retry || answered(c));
      for (let over = head.length + staying.length - size, j = staying.length - 1; over > 0 && j >= 0; j--) {
        if (!answered(staying[j])) { staying.splice(j, 1); over--; }
      }
      const kept = new Set(staying);
      const room = Math.max(0, size - head.length - kept.size);
      const dealt = room > 0
        ? buildSession(candidates, {
            direction: dirRef.current,
            target: room,
            lessonMode: lessonFilter !== "all",
            lessonRank,
            inBlock: [...head, ...kept],
          })
        : null;
      if (dealt) recordDeal({ kind: "rest", scope: dealScope, direction: dirRef.current, slots: room, dealt, kept: [...head, ...kept] });
      const fill = dealt ? dealt.queue : [];
      let f = 0;
      const rest = tail
        .filter((c) => kept.has(c) || !(c._retry || answered(c)))
        .map((c) => (kept.has(c) ? c : fill[f++]))
        .filter(Boolean);
      return [...head, ...rest, ...fill.slice(f)];
    };

    // Moving between sets: a lesson, the whole deck, a type. The set being
    // left is kept, and one kept from earlier today carries on where it was —
    // it used to be thrown away, and coming back dealt a new one from card 1,
    // dropping the retries lined up in it (2026-09-25). The same on opening
    // the app, which is also how an update arrives: see lib/studyPlace.js.
    if (filterChanged) {
      if (prevSig !== null && deckSig === prevSig && deck.length > 0) {
        placeRef.current.sets[prevSig] = packSet({
          deck, idx, stats, done: sessionDone, answers: blockAnswersRef.current, blockStart: blockStartRef.current,
          face: { seen: answerSeen, key: card ? itemKey(card) : null, typeResult, typed: typeResult ? typedAnswer : "", accepted: disputeAccepted },
          day: dealtDayRef.current, dir: dirRef.current, seq: dealtSeqRef.current, switches: dealtSwitchRef.current,
          size: dealtSizeRef.current,
        });
      }
      const saved = placeRef.current.sets[filterSig];
      const back = saved && saved.day === today ? unpackEntries(saved, pool) : null;
      if (back && back.entries.length > 0) {
        blockAnswersRef.current = new Map(saved.answers || []);
        for (const [, a] of blockAnswersRef.current) if (a?.reviewId) knownReviewIdsRef.current.add(a.reviewId);
        blockStartRef.current = saved.blockStart || progressByArea(userCards);
        // Unchanged since it was left, it comes back as it was; otherwise the
        // cards not yet reached are checked against the deck as it now is, and
        // a set not yet finished takes the set size chosen since. One that
        // came out short, the deck having run out, is not topped up unless
        // the size has changed.
        const resized = !saved.done && saved.size !== setSizeRef.current;
        const unchanged = saved.seq === deckFreshSeq && saved.dir === dirRef.current && saved.switches === switchSig && !resized;
        const next = unchanged ? back.entries : redealRest(back.entries, back.idx, resized ? setSizeRef.current : back.entries.length);
        const at = Math.min(back.idx, next.length - 1);
        dealtSeqRef.current = deckFreshSeq;
        dealtDayRef.current = saved.day;
        dealtSwitchRef.current = switchSig;
        dealtSizeRef.current = setSizeRef.current;
        scheduledRef.current = stamp;
        setDeck(next);
        setDeckSig(filterSig);
        setIdx(at);
        setSessionDone(!!saved.done);
        setStats(saved.stats || { seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
        // The card on screen as it was left: one whose answer had been seen
        // comes back showing it, so it can't be graded as if seen afresh.
        const face = saved.face;
        const seen = !!face?.seen && face.key === itemKey(next[at]);
        skipFlipAnim.current = true;
        setFlipped(seen);
        setTypeResult(seen ? face.typeResult ?? null : null);
        setTypedAnswer(seen ? face.typed || "" : "");
        // And accepted, if "My answer should be accepted" had accepted it.
        disputeRef.current = null;
        setFeedbackState(seen && face.accepted ? "accepted" : null);
        setFeedbackVerdict(null);
        requestAnimationFrame(() => { skipFlipAnim.current = false; });
        return;
      }
    }

    // Mid-session userCards refetch (card edit/delete, background reload,
    // Supabase token refresh). Rebuilding here would reshuffle the queue,
    // drop already-answered cards, lose in-session retries, and snap the
    // counter to wherever the current card lands in the new ordering.
    // Instead, patch each card's fields in place by row_id and drop any
    // that were deleted — session order, idx, and retries stay intact.
    //
    // Unless the block was dealt from an out-of-date deck. A block is dealt from
    // the deck in memory, and on opening the app that is the copy saved in the
    // browser, which is only saved when the page loads — so it can be days old
    // — and a page left open knows nothing of answers given on another device.
    // On 2026-09-23 a block dealt from a five-day-old copy asked 22 cards that
    // weren't due and left out 54 that were; the up-to-date deck arrived a
    // second later and only patched the cards in place. And a block dealt one
    // evening and worked the next morning holds the evening's due cards: the
    // cards missed the day before, which come first, weren't in it
    // (2026-09-24). So when a fetch has landed, or the day has turned, since
    // the block was dealt, a block not yet started is dealt again from scratch,
    // and one under way keeps what has been shown, answered or lined up for a
    // retry while the cards not yet reached are dealt again.
    //
    // A new day starts a new set, whatever state the last one was in: its
    // answers are all saved, and a set spread over two days makes its
    // checkpoint meaningless (the owner's choice, 2026-09-26).
    //
    // Switching a lesson on or off does the same to a set on Cards: what has
    // been shown, answered or lined up for a retry stays, so the count and the
    // student's place don't move, and the rest is dealt under the new switches.
    const outOfDate = dealtSeqRef.current !== deckFreshSeq || dealtSwitchRef.current !== switchSig;
    // A finished set keeps its length: the next one has the new size.
    const resized = dealtSizeRef.current !== setSize && !sessionDone;
    const newDay = dealtDayRef.current !== today;
    const started = blockAnswersRef.current.size > 0 || answerSeen;
    if (!filterChanged && deck.length > 0 && !newDay && !(outOfDate && !started)) {
      const byRow = new Map(pool.map(c => [c.row_id, c]));
      const patched = deck
        .map(c => {
          const u = byRow.get(c.row_id);
          // A card edited into grammar is asked only as written: its English-
          // side entry would record to a state the card no longer uses.
          if (!u || (c.shownDir === "en" && !isTwoWay(u))) return null;
          return { ...u, shownDir: c.shownDir, flippable: isTwoWay(u), _bucket: c._bucket, _retry: c._retry, _rid: c._rid, _displaced: c._displaced };
        })
        .filter(Boolean);
      let next = patched;
      if (outOfDate || resized) {
        next = redealRest(patched, Math.min(idx, patched.length - 1), resized ? setSize : patched.length);
        dealtSeqRef.current = deckFreshSeq;
        dealtSwitchRef.current = switchSig;
      }
      dealtSizeRef.current = setSize;
      setDeck(next);
      setIdx(i => Math.min(i, Math.max(0, next.length - 1)));
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
    const dealt = buildSession(candidates, {
      direction: dirRef.current,
      target: setSizeRef.current,
      lessonMode: lessonFilter !== "all",
      lessonRank,
    });
    const { queue: cards, counts } = dealt;
    recordDeal({ kind: "new", scope: dealScope, direction: dirRef.current, slots: setSizeRef.current, dealt });
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
    else if (preservedIdx < 0) {
      setFlipped(false); setTypedAnswer("");
      // A check on the card that was on screen is not about this one.
      disputeRef.current = null; setFeedbackState(null); setFeedbackVerdict(null);
    }
    blockAnswersRef.current = new Map();
    dealtSeqRef.current = deckFreshSeq;
    dealtDayRef.current = today;
    dealtSwitchRef.current = switchSig;
    dealtSizeRef.current = setSizeRef.current;
    scheduledRef.current = stamp;
    setDeck(cards);
    setDeckSig(filterSig);
    setIdx(0);
    // A rebuilt queue is unworked, whatever the last one's state was.
    setSessionDone(false);
    setStats({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, typeFilter, lessonFilter, scope, switchSig, userCards, blockSeq, deckFreshSeq, recheck, setSize]);

  // Answers given somewhere else — another device, another tab — since the
  // deck in memory was fetched. Coming back to the tab asks for their ids,
  // which is one small query; the whole deck is read again only when there is
  // one this page didn't give, and the block is then dealt again from it.
  // Ids this page has written are known, as are ones a check has already
  // acted on.
  const knownReviewIdsRef = useRef(new Set());
  // The record of answers, for the Stats page: today's cards (new, reviews,
  // retries), ~N remembered day by day, each lesson's last 7 days and the
  // days studied (lib/progressHistory.js). Read whole when the page opens, a
  // page of rows at a time, since the server hands back at most 1,000 per
  // request. Answers given here are added from answersHereRef, so one whose
  // record is still being saved counts too: today's count once said 6 where
  // the end-of-set screen said 8 (2026-09-27).
  const answersHereRef = useRef(new Map()); // review id -> its record
  const [historyRows, setHistoryRows] = useState(null); // null until read, or if it can't be
  useEffect(() => {
    if (mode !== "stats" || !user?.id) return;
    let live = true;
    (async () => {
      const rows = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("card_reviews")
          .select(HISTORY_COLUMNS)
          .eq("user_id", user.id)
          .order("answered_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (!live) return;
        if (error || !Array.isArray(data)) { setHistoryRows(null); return; }
        rows.push(...data);
        if (data.length < PAGE) break;
      }
      const have = new Set(rows.map((r) => r.id));
      for (const [id, row] of answersHereRef.current) if (!have.has(id)) rows.push(row);
      setHistoryRows(rows);
    })();
    return () => { live = false; };
  }, [mode, user?.id]);
  const statsHistory = useMemo(
    () => (mode === "stats" && historyRows ? statsOverTime({ cards: userCards, rows: historyRows, now: Date.now() }) : null),
    [mode, userCards, historyRows],
  );
  const lastElsewhereCheckRef = useRef(0);
  const checkElsewhere = useCallback(async () => {
    if (!user?.id || !deckFetchedAt) return;
    if (Date.now() - lastElsewhereCheckRef.current < 15000) return;
    lastElsewhereCheckRef.current = Date.now();
    // Ten minutes' margin for a device whose clock runs behind.
    const since = new Date(deckFetchedAt - 10 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("card_reviews")
      .select("id")
      .eq("user_id", user.id)
      .gte("answered_at", since)
      .limit(1000);
    if (error || !Array.isArray(data)) return;
    const unknown = data.filter((r) => !knownReviewIdsRef.current.has(r.id));
    if (!unknown.length) return;
    for (const r of unknown) knownReviewIdsRef.current.add(r.id);
    reloadDeck();
  }, [user?.id, deckFetchedAt, reloadDeck]);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (dealtDayRef.current && dealtDayRef.current !== localISODate()) setRecheck((n) => n + 1);
      checkElsewhere();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [checkElsewhere]);

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
    // Elsewhere is what Cards would deal: not the lessons switched off, and
    // under My cahier no lesson at all.
    let waiting = 0;
    if (lessonFilter !== "all") {
      for (const c of userCards) {
        if (lessonIdOf(c) === lessonFilter || !onCards(c, { scope, lessonsOn, lessonIds })) continue;
        for (const d of directionsOf(c)) {
          if (isTwoWay(c) && dir !== "mix" && d !== dir) continue;
          if (dueToday(sideOf(c, d))) waiting++;
        }
      }
    }
    return { after, changes, next, waiting };
  }, [sessionDone, userCards, candidatesFrom, lessonFilter, scope, lessonsOn, lessonIds, dir]);
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

  // ── The first-visit tour (src/Tour.jsx; its steps are lib/tourSteps.js) ──
  // Every student sees it once, new or not (owner, 2026-10-06): the next time
  // they open the app, once the deck has come from the server and the lesson
  // sync has put Lesson 1's cards in it. That it was shown is kept on the
  // account (user_metadata.tour_shown, like the lesson switches), so it
  // doesn't come back on another computer, and on this browser, so a failed
  // save doesn't bring it back here. The account's copy is the server's, read
  // on opening: a session signed in before the tour was shown elsewhere still
  // holds the old one. Skipping the tour counts as shown. "Take the tour
  // again" in the profile menu opens it any time. (The tour's first version
  // saved tour_seen, and also set it, without showing the tour, for students
  // who had answered cards; so it is no longer read.)
  const tourLesson = LESSONS.find((l) => l.id === TOUR_LESSON) || null;
  const tourSeenKey = `tour-shown:${user?.id}`;
  const [tourOpen, setTourOpen] = useState(false);
  const [tourRun, setTourRun] = useState(0);
  const tourChecked = useRef(false);
  const markTourSeen = useCallback(() => {
    try { localStorage.setItem(tourSeenKey, "1"); } catch {}
    if (!user?.user_metadata?.tour_shown) {
      supabase.auth.updateUser({ data: { tour_shown: true } }).then(({ error }) => {
        if (error) console.error("Saving that the tour was shown failed:", error);
      });
    }
  }, [tourSeenKey, user]);
  const startTour = useCallback(() => {
    markTourSeen();
    setShowProfileMenu(false);
    setShowSettings(false);
    setShowChat(false);
    setShowFeedback(false);
    setTourRun((n) => n + 1);
    setTourOpen(true);
  }, [markTourSeen]);
  useEffect(() => {
    if (tourChecked.current || !user || !loaded || !deckFreshSeq || !tourLesson || accountTourSeen === null) return;
    let seenHere = false;
    try { seenHere = !!localStorage.getItem(tourSeenKey); } catch {}
    if (accountTourSeen || user.user_metadata?.tour_shown || seenHere) { tourChecked.current = true; return; }
    // Once the lesson sync has put Lesson 1 in the deck.
    if (!userCards.some((c) => lessonIdOf(c) === TOUR_LESSON)) return;
    tourChecked.current = true;
    startTour();
  }, [user, loaded, deckFreshSeq, userCards, tourLesson, tourSeenKey, accountTourSeen, startTour]);
  // What the steps do to set the page up. Read through a ref, so the steps
  // are made once and still act on the page as it is now.
  const tourActsRef = useRef(null);
  tourActsRef.current = {
    goCards: () => { leaveLesson(); setMode("study"); },
    goLessons: () => {
      const group = LESSON_GROUPS.find((g) => g.lessons.some((l) => l.id === TOUR_LESSON));
      if (group?.title) {
        setPageClosedGroups((prev) => {
          if (!prev.has(group.title)) return prev;
          const next = new Set(prev);
          next.delete(group.title);
          return next;
        });
      }
      setMode("lessons");
    },
    goStats: () => setMode("stats"),
    setTutor: (on) => (on ? openChat() : setShowChat(false)),
    // Continue on a typed card already checked: what the button does.
    continueCard: () => { if (typeMode && typeResult && card && !sessionDone) answer(typedRecalled, "typed"); },
    openLesson: (id) => { if (mode !== "study" || lessonFilter !== id) enterLesson(id); },
    setNotes: (on) => {
      if (on) { setShowChat(false); setShowFeedback(false); }
      setShowLessonPanel(on);
    },
    setSettings: (on) => setShowSettings(on),
    setProfileMenu: (on) => setShowProfileMenu(on),
  };
  const tourActions = useMemo(() => {
    const call = (name) => (...args) => tourActsRef.current[name](...args);
    return {
      goCards: call("goCards"),
      goLessons: call("goLessons"),
      goStats: call("goStats"),
      setTutor: call("setTutor"),
      continueCard: call("continueCard"),
      openLesson: call("openLesson"),
      setNotes: call("setNotes"),
      setSettings: call("setSettings"),
      setProfileMenu: call("setProfileMenu"),
    };
  }, []);
  const tourStepList = useMemo(
    () => (tourLesson ? tourSteps(tourActions, tourLesson) : []),
    [tourActions, tourLesson]
  );
  // Whether a typed answer counts as recalled: the matcher's verdict, or a
  // "my answer should be accepted" dispute that was accepted. An accepted
  // dispute used to save the alternate for next time and still record today's
  // answer as a miss, because Continue read only the matcher's verdict.
  const disputeAccepted =
    feedbackState === "accepted" ||
    (feedbackState === "submitted" && feedbackVerdict?.verdict === "accept");
  const typedRecalled = typedGotIt(typeResult) || disputeAccepted;

  // Keep the set on screen, and which set it is, as it changes: every answer,
  // every card, the checkpoint, and whether the answer on screen has been seen.
  // See lib/studyPlace.js; the deck-build effect brings it back.
  //
  // Written to storage a moment later rather than on every change, so turning
  // or grading a card never waits on it — and at once when the page is hidden
  // or unloaded, which is what a reload, an update or closing the tab does.
  const pendingPlaceRef = useRef(null);
  const placeTimerRef = useRef(null);
  const flushPlace = useCallback(() => {
    clearTimeout(placeTimerRef.current);
    placeTimerRef.current = null;
    const p = pendingPlaceRef.current;
    pendingPlaceRef.current = null;
    if (p) writePlace(p.userId, p.write);
  }, []);
  useEffect(() => {
    if (!user?.id || !deckSig || deckSig !== filterSigRef.current || deck.length === 0) return;
    const set = packSet({
      deck, idx, stats, done: sessionDone, answers: blockAnswersRef.current, blockStart: blockStartRef.current,
      face: { seen: answerSeen, key: card ? itemKey(card) : null, typeResult, typed: typeResult ? typedAnswer : "", accepted: disputeAccepted },
      day: dealtDayRef.current, dir, seq: dealtSeqRef.current, switches: dealtSwitchRef.current,
      size: dealtSizeRef.current,
    });
    placeRef.current.sets[deckSig] = set;
    placeRef.current.current = { lessonFilter, typeFilter, scope, dir };
    pendingPlaceRef.current = { userId: user.id, write: { key: deckSig, set, current: placeRef.current.current, today: localISODate() } };
    clearTimeout(placeTimerRef.current);
    placeTimerRef.current = setTimeout(flushPlace, 400);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, deckSig, deck, idx, stats, sessionDone, answerSeen, typeResult, disputeAccepted, dir, lessonFilter, typeFilter, scope]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushPlace(); };
    window.addEventListener("pagehide", flushPlace);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flushPlace);
      document.removeEventListener("visibilitychange", onHide);
      flushPlace();
    };
  }, [flushPlace]);

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
    const dealt = room > 0
      ? buildSession(candidatesFrom(userCards), {
          direction: dir,
          target: room,
          lessonMode: lessonFilter !== "all",
          lessonRank,
          inBlock: [...head, ...kept],
        })
      : null;
    if (dealt) recordDeal({ kind: "direction", scope: dealScopeOf(setKeyOf(typeFilter, lessonFilter, scope), switchSig), direction: dir, slots: room, dealt, kept: [...head, ...kept] });
    const fill = dealt ? dealt.queue : [];
    let f = 0;
    const next = [...head, ...tail.map((c) => (kept.has(c) ? c : fill[f++])).filter(Boolean)];
    setDeck(next);
    if (next.length <= idx) {
      // Nothing left to ask this way round: the block ends where it is.
      setIdx(Math.max(0, next.length - 1));
      if (next.length > 0) setSessionDone(true);
    }
    if (!answerSeen) setTypedAnswer("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);
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
  // An answer's record. Before migration_013 the database has no columns for
  // the settings it was scheduled with: the answer is saved without them
  // rather than not at all, and after the first refusal they aren't sent again
  // that study day.
  const reviewExtrasOffRef = useRef(null);
  const saveReviewRow = async (row) => {
    if (reviewExtrasOffRef.current !== localISODate()) {
      const res = await supabase.from("card_reviews").upsert(row, { onConflict: "id" });
      if (!missingColumn(res.error)) return res;
      reviewExtrasOffRef.current = localISODate();
    }
    return supabase.from("card_reviews").upsert(withoutExtras(row), { onConflict: "id" });
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

  // What "Mark for review" did to the card it was pressed on, shown beside the
  // counter for a few seconds. The card moves on at once, so without this
  // nothing on screen said the press had worked.
  const [reviewMark, setReviewMark] = useState(null);
  const reviewMarkTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(reviewMarkTimerRef.current), []);

  // Returns the schedule written for the way round shown, or null when the
  // answer wasn't counted (a retry, or a card already answered today).
  const answer = (got, source = "flip") => {
    if (!card) return null;
    // Once the queue is worked out the last card stays on screen behind the
    // completion panel. Grading it again would write a second FSRS review for
    // a card that was answered once, so the session end is a hard stop.
    if (sessionDone) return null;
    setReviewMark(null);
    // Whether this answer empties the queue. Read BEFORE the wrong-answer
    // splice below, which grows the deck by one and would hide the end.
    const wasLastCard = idx >= deck.length - 1;
    // The class banner has said its piece once a card is answered. Left up, it
    // kept 42px from the card on every card after — on a short window, the
    // difference between a card that fits and one whose contents overlap.
    if (cahier.arrived) cahier.dismissArrived();
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
    knownReviewIdsRef.current.add(reviewId);
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
    // The first answer inside a lesson switches it on for Cards: the class has
    // reached it (lib/lessonChoice.js). Only the first, so a student who
    // switches it off again is not overruled by studying it.
    if (recordsReview && lessonFilter !== "all" && lessonIdOf(card) === lessonFilter &&
        !lessonsStarted.has(lessonFilter) && lessonChoicesRef.current[lessonFilter] !== true) {
      setLessonChoice(lessonFilter, true);
    }
    // The record of the answer: every answer, counted or not. A correction
    // rewrites the same record, and only if the grade changed.
    if (card.row_id != null && user?.id && (!isCorrection || earlier.got !== got)) {
      const row = reviewRow({
        id: reviewId, userId: user.id, cardId: card.row_id, dir: cardDir, got,
        before, after: before ? sr : null, at: answeredAt,
        settings: before ? settingsInUse() : null, timeZone: before ? browserTimeZone() : null,
      });
      save(`review:${reviewId}`, reviewId, () => saveReviewRow(row));
      // Kept here too, for the Stats page while the record is on its way to
      // the database. A correction rewrites it under the same id.
      answersHereRef.current.set(reviewId, row);
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
    // A miss changed to right: its retry is taken back out, and the card that
    // retry pushed out of the block goes back in. See withdrawRetry.
    if (got && isCorrection && earlier.got === false) {
      setDeck(prev => withdrawRetry(prev, idx, itemKey(card)));
    }

    // Skip the un-flip animation — snap instantly to the next card's front
    skipFlipAnim.current = true;
    setFlipped(false);
    setTypeResult(null);
    setTypedAnswer("");
    disputeRef.current = null; setFeedbackState(null); setFeedbackVerdict(null);
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
    return sr;
  };

  // "Mark for review": a typed answer the app accepted, recorded as a miss
  // instead. Says when the card comes back: later in this set when there is
  // room for a retry (see placeRetry), otherwise the day it is next due.
  const markForReview = () => {
    if (!card || sessionDone) return;
    const dir = card.shownDir ?? "fr";
    const key = itemKey(card);
    // The same test answer() makes: a miss already recorded in this set gets
    // no second retry.
    const missedBefore = blockAnswersRef.current.get(slotKeyOf(card))?.got === false;
    const comesBackInSet =
      deck.slice(idx + 1).some((c) => c._retry && itemKey(c) === key) ||
      (!missedBefore && placeRetry(deck, idx, card, RE_QUEUE_OFFSET) !== deck);
    const sr = answer(false, "typed");
    let when = "later in this set";
    if (!comesBackInSet) {
      const due = Date.parse((sr ? sr[dir === "en" ? "en_next_due_at" : "next_due_at"] : null) ?? sideOf(card, dir).next_due_at);
      const now = new Date();
      const tomorrowEnds = endOfLocalDay(new Date(endOfLocalDay(now) + 1));
      when = !Number.isFinite(due) || due <= endOfLocalDay(now) ? "in your next set"
        : due <= tomorrowEnds ? "tomorrow"
        : `on ${new Date(due).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`;
    }
    // No card name: the student has just pressed the button on it, and a long
    // front ran the message off the top bar on a narrow window.
    setReviewMark(`Marked for review: counted as wrong, back ${when}`);
    clearTimeout(reviewMarkTimerRef.current);
    reviewMarkTimerRef.current = setTimeout(() => setReviewMark(null), 5000);
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
    setReviewMark(null);
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
    disputeRef.current = null; setFeedbackState(null); setFeedbackVerdict(null);
    requestAnimationFrame(() => { skipFlipAnim.current = false; });
  };

  const resetSession = () => {
    setIdx(0);
    // Clear the deck so the userCards refetch below takes the full-rebuild
    // branch instead of patching the now-stale in-memory session in place.
    // Without this, "New Session" would re-show the cards you just finished
    // (patched but still in old order) until the next filter change.
    setDeck([]);
    currentCardIdRef.current = null;
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
    setSessionDone(false);
    setTypedAnswer("");
    setTypeResult(null);
    disputeRef.current = null; setFeedbackState(null); setFeedbackVerdict(null);
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
    currentCardIdRef.current = null;
    setFlipped(false);
    setStats({ seen:0, got:0, missed:0, answered:0, firstAnswered:0, firstGot:0 });
    setSessionDone(false);
    setTypedAnswer("");
    setTypeResult(null);
    disputeRef.current = null; setFeedbackState(null); setFeedbackVerdict(null);
    setBlockSeq(n => n + 1);
    // Dealt from the deck in memory, which has every answer given here; if
    // any were given elsewhere meanwhile, the deck is read again and the new
    // block dealt again from it.
    checkElsewhere();
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
  //
  // So are the lesson notes. They counted as an overlay wherever they sat, so
  // studying a lesson with its notes open beside the card left Enter, Space
  // and the arrows dead: after a typed answer the only way on was to click
  // Continue. The notes have nothing to type into, so beside the card they
  // take a key only when it is pressed on one of their own buttons, reached
  // with Tab. Not a clicked one: Chrome leaves focus on a tab you click, and
  // that held the keys the same way. (Nor :focus-visible, which Chrome turns
  // on for a clicked button at the very keypress being asked about.)
  const sidebarWidth = sidebarMin ? SIDEBAR_MIN_WIDTH : SIDEBAR_WIDTH;
  const roomToReflow = (panelWidth) =>
    winWidth - sidebarWidth - panelWidth >= MIN_REFLOW_CONTENT;
  const chatReflow = showChat && roomToReflow(CHAT_PANEL_WIDTH);
  const lessonReflow = showLessonPanel && roomToReflow(LESSON_PANEL_WIDTH);
  // On a window too narrow for the notes to sit beside the cards, they cover
  // the page under a dim, and the "Lesson notes" button with it. A copy of
  // the button sits on the original, above the dim, so pressing it closes the
  // notes there too.
  const lessonToggleRef = useRef(null);
  const [lessonToggleBox, setLessonToggleBox] = useState(null);
  const notesOver = showLessonPanel && !lessonReflow;
  useEffect(() => {
    if (!notesOver) { setLessonToggleBox(null); return; }
    const measure = () => {
      const r = lessonToggleRef.current?.getBoundingClientRect();
      setLessonToggleBox(r && r.width ? { left: r.left, top: r.top, minWidth: r.width } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [notesOver, sidebarMin]);
  const overlayOpen =
    (showChat && !chatReflow) || showFeedback || showUpload || showKeyModal ||
    (showLessonPanel && !lessonReflow) ||
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
  // Whether focus last moved by Tab rather than by a click.
  const tabbedRef = useRef(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Tab") tabbedRef.current = true; };
    const onPointer = () => { tabbedRef.current = false; };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  const notesHaveKeyboard = () =>
    tabbedRef.current && !!document.activeElement?.closest?.("[data-lesson-panel]");

  useEffect(() => {
    if (mode !== "study" || typeMode || overlayOpen || sessionDone) return;
    const handler = (e) => {
      if (!card) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (tutorHasKeyboard() || notesHaveKeyboard()) return;
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
      if (tutorHasKeyboard() || notesHaveKeyboard()) return;
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
    // The result is for this card as it is now. If the student has moved on
    // when it comes back, it changes nothing on screen: see disputeRef.
    const ticket = {};
    disputeRef.current = ticket;
    const key = `${card.id}:${card.shownDir}`;
    const typed = typedAnswer;
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
      if (res.ok && data?.verdict === "accept") {
        // Update local alternates so the matcher accepts it from now on. Done
        // even if the student has moved on: the server has saved it anyway.
        setAlternates(prev => ({
          ...prev,
          [key]: [...(prev[key] || []), typed],
        }));
      }
      if (disputeRef.current !== ticket) return;
      if (!res.ok) {
        setFeedbackErrMsg(data?.error || `HTTP ${res.status}`);
        setFeedbackState("error");
        return;
      }
      setFeedbackVerdict(data);
      setFeedbackState("submitted");
    } catch (e) {
      console.error("Feedback failed:", e);
      if (disputeRef.current !== ticket) return;
      setFeedbackErrMsg(e.message);
      setFeedbackState("error");
    }
  };

  // Force-accept: user overrides Claude's reject/uncertain verdict
  const forceAcceptAnswer = async () => {
    if (!card || !typedAnswer.trim()) return;
    const ticket = {};
    disputeRef.current = ticket;
    const key = `${card.id}:${card.shownDir}`;
    const typed = typedAnswer;
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
        if (disputeRef.current !== ticket) return;
        setFeedbackErrMsg(data?.error || `HTTP ${res.status}`);
        setFeedbackState("error");
        return;
      }
      // Update local alternates
      setAlternates(prev => ({
        ...prev,
        [key]: [...(prev[key] || []), typed],
      }));
      if (disputeRef.current !== ticket) return;
      setFeedbackState("accepted");
    } catch (e) {
      if (disputeRef.current !== ticket) return;
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
    // The kept sets hold answers that no longer apply.
    clearTimeout(placeTimerRef.current);
    pendingPlaceRef.current = null;
    placeRef.current.sets = {};
    dropSets(user.id);
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
  //
  // Only against the deck as the server has it. The deck on screen at first is
  // the copy saved in the browser, which can be days old: a card answered
  // since would look never answered there, and be deleted with its history
  // instead of kept. So this waits for the first fetch to land.
  const lessonsSynced = useRef(false);
  useEffect(() => {
    if (!user || !deckLoaded || !deckFreshSeq || lessonsSynced.current) return;
    lessonsSynced.current = true;
    (async () => {
      const { missing, rekey, retext, stale, archive, adopt, unkeyed, taken, away } = reconcileLessons(LESSONS, userCards, archivedCards);
      if (away.length) {
        // Out of study: the student removed them, or they were put away as a
        // repeat. Putting them back would undo that. See reconcileLessons.
        console.info(`[lessons] ${away.length} lesson card(s) out of study left out:`, away.map((t) => t.front));
      }
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
      if (!missing.length && !rekey.length && !retext.length && !stale.length && !archive.length && !adopt.length) return;
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
        // Deleted only if still never answered either way, checked by the
        // database itself: a card answered on another device since the deck
        // was read is left, and archived on the next visit.
        if (stale.length) {
          const { error } = await supabase
            .from("user_cards")
            .delete()
            .in("id", stale)
            .eq("user_id", user.id)
            .eq("fsrs_state", 0)
            .eq("en_fsrs_state", 0);
          if (error) throw error;
        }
        // A card the student has answered is taken out of study, not deleted:
        // its answers stay on record. See reconcileLessons.
        for (const rowId of archive) {
          const row = userCards.find((c) => c.row_id === rowId);
          const { error } = await supabase
            .from("user_cards")
            .update({ source: archivedSource(row?.source) })
            .eq("id", rowId)
            .eq("user_id", user.id);
          if (error) throw error;
        }
        // A card the lesson dropped that a class in the student's notes had
        // landed on: it stays, as one of their own cards. See reconcileLessons.
        if (adopt.length) {
          const { error } = await supabase
            .from("user_cards")
            .update({ source: ADOPTED_SOURCE })
            .in("id", adopt)
            .eq("user_id", user.id);
          if (error) throw error;
        }
        console.info(
          `[lessons] synced: +${missing.length} card(s), ${rekey.length} re-keyed, ${retext.length} renamed, ` +
            `-${stale.length} never answered and removed, ${archive.length} answered and kept out of study, ` +
            `${adopt.length} kept as cards from your notes`
        );
        reloadDeck();
      } catch (e) {
        // A lesson that cannot sync is not worth blocking the app for; the
        // deck the student already has still works.
        console.error("Lesson sync failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, deckLoaded, deckFreshSeq]);

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

  // Removing a card takes it out of study and remembers why; it never erases
  // it (api/_lib/removeCard.js, 2026-10-06). Deleting the row used to delete
  // every answer on it too, and nothing then stopped the next upload, or a
  // later class with the same word, from making the card again.
  const deleteCard = async (rowId) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/admin-update-card", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
        body: JSON.stringify({ action: "remove", row_id: rowId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        console.error("Card removal failed:", body);
        alert(body.error || `The card couldn't be removed (HTTP ${res.status}).`);
        return false;
      }
    } catch (e) {
      console.error("Card removal failed:", e);
      alert(`The card couldn't be removed: ${e.message || e}`);
      return false;
    }
    // Reset answer state so the card that slides into this idx position on
    // the deck rebuild starts with a fresh prompt, not a stale verdict from
    // the card we just removed.
    setTypedAnswer("");
    setTypeResult(null);
    setFlipped(false);
    disputeRef.current = null;
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
          cahier={cahier}
          onClose={() => setShowUpload(false)}
          hasExisting={false}
          initialTab={uploadInitialTab}
          onSuccess={(result) => {
            setShowUpload(false);
            reloadDeck();
            if (result.linked) return alert(uploadDoneText(result));
            alert(uploadResultText(result));
          }}
        />
      </div>
    );
  }

  // ── SHELL: SIDEBAR ──────────────────────────────────────────────────
  // The sidebar is the global app shell. On wide screens it's a fixed
  // 256px-wide column, or a 64px rail when minimized.
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

  // The lessons drop down from Lessons: open on the Lessons page and inside a
  // lesson, where you pick one or see which you are in; folded away
  // everywhere else, so the sidebar is just its four items. On the Lessons
  // page a press on Lessons folds the list away or opens it again, as its
  // arrow says; it used to do nothing there.
  const lessonsOpen = !lessonsFolded && (mode === "lessons" || (mode === "study" && lessonFilter !== "all"));

  // Open the tutor panel and the app reflows to sit beside it rather than
  // being covered — you can still read the card you're asking about. Reflow
  // only while the content column stays usable: a 900px window leaves
  // 900 - 256 of sidebar - 460 of panel = 184px of column, where the card
  // turns portrait and crushes and the answer row runs off the edge. Below
  // the floor the panel covers the app with a scrim instead.
  //
  // See MIN_REFLOW_CONTENT for where the floor comes from.
  // (roomToReflow, chatReflow and lessonReflow are computed further up, before
  // the keyboard handlers, which need to know whether the tutor covers the card.)
  const shellStyle = S.shell;
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
      data-minimized={sidebarMin ? "" : undefined}
      style={sidebarMin ? { ...S.sideBar, ...S.sideBarMin } : S.sideBar}
    >
      {!sidebarMin && (
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
      <nav style={S.sideNav}>
        {sidebarMin && (
          // Minimized, the expand button is one more item in the rail: the
          // same button style as Cards and the rest, so it shares their centre
          // line (the 4px marker border offsets it, equally), their spacing and
          // their colour. Positioned on its own it sat 2px right of the column
          // and 11px closer to Cards than Cards is to Lessons.
          <button
            data-sidebar-toggle
            className="side-btn"
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
          const baseStyle = sidebarMin ? { ...S.sideItem, ...S.sideItemMin } : S.sideItem;
          const activeStyle = S.sideItemActive;
          return (
            <Fragment key={m}>
              <button
                data-tour={`nav-${m === "study" ? "cards" : m}`}
                className="side-btn"
                aria-current={navActive(m) ? "page" : undefined}
                style={navActive(m) ? {...baseStyle, ...activeStyle} : baseStyle}
                onClick={() => {
                  // Cards means the whole deck, so it clears any lesson you
                  // were inside — otherwise it selects itself while the lesson
                  // beneath it stays filtered and marked.
                  if (m === "study") leaveLesson();
                  if (m === "lessons" && mode === "lessons" && !sidebarMin) { setLessonsFolded((v) => !v); return; }
                  setMode(m);
                }}
                title={sidebarMin ? label : undefined}
                aria-label={sidebarMin ? label : undefined}
                aria-expanded={m === "lessons" && !sidebarMin ? lessonsOpen : undefined}
              >
                <span style={S.sideIcon}>{NAV_ICONS[m]}</span>
                {!sidebarMin && label}
                {m === "lessons" && !sidebarMin && (
                  <span style={lessonsOpen ? { ...S.sideChevron, ...S.sideChevronOpen } : S.sideChevron} aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </span>
                )}
              </button>
              {/* Lessons are the one nav item with children: each lesson sits
                  under it as a sub-item, so picking one is a single click
                  rather than a trip through the catalogue. Not on the rail,
                  which has no room to nest anything. */}
              {m === "lessons" && !sidebarMin && lessonsOpen && LESSON_GROUPS.map((group) => {
                // Folded, it still shows the lesson you're in. (It used to
                // refuse to fold there, so the press did nothing you could
                // see.)
                const closed = group.folds && closedGroups.has(group.title);
                const base = group.folds ? { ...S.sideSubItem, ...S.sideSubItemNested } : S.sideSubItem;
                return (
                  <Fragment key={group.title || "lessons"}>
                    {group.folds && (
                      <button
                        className="side-btn"
                        style={S.sideGroup}
                        onClick={() => toggleGroup(group.title)}
                        aria-expanded={!closed}
                        data-lesson-group={group.title}
                      >
                        {group.title}
                        <span style={closed ? S.sideChevron : { ...S.sideChevron, ...S.sideChevronOpen }} aria-hidden="true">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                        </span>
                      </button>
                    )}
                    {group.lessons.filter((l) => !closed || (mode === "study" && lessonFilter === l.id)).map((lesson) => {
                      const on = mode === "study" && lessonFilter === lesson.id;
                      return (
                        <button
                          key={lesson.id}
                          className="side-btn"
                          aria-current={on ? "page" : undefined}
                          style={on ? {...base, ...S.sideSubItemActive} : base}
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
            </Fragment>
          );
        })}

        {/* The tutor chat is an overlay, not a page, so it sits alongside the
            nav items but never takes the active state. It lives here rather
            than in the profile menu because looking a word up mid-session is
            a primary action, and nobody finds it behind an avatar. */}
        <button
          data-tutor-toggle
          data-tour="nav-tutor"
          className="side-btn"
          style={sidebarMin ? { ...S.sideItem, ...S.sideItemMin } : S.sideItem}
          onClick={toggleChat}
          title={sidebarMin ? "Tutor" : undefined}
          aria-label={sidebarMin ? "Tutor" : undefined}
        >
          <span style={S.sideIcon}>{NAV_ICONS.tutor}</span>
          {!sidebarMin && "Tutor"}
        </button>
      </nav>

      {/* Bottom: account, then feedback beneath it */}
      {user && (
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
                data-tour="avatar"
                style={S.profileBtn}
                onClick={() => setShowProfileMenu(v => !v)}
              >
                <div style={S.profileAvatar}>{user.email[0].toUpperCase()}</div>
              </button>
              {showProfileMenu && (
                <div style={S.profileMenuBottom} data-tour="profile-menu">
                  <button
                    data-tutor-toggle
                    style={S.profileMenuItem}
                    onClick={() => { openChat(); setShowProfileMenu(false); }}
                  >
                    Ask the tutor
                  </button>
                  <button
                    data-tour="upload"
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
                  <button
                    data-fsrs-settings-toggle
                    style={S.profileMenuItem}
                    onClick={() => { setShowFsrsSettings(true); setShowProfileMenu(false); }}
                  >
                    How much to remember
                  </button>
                  {tourStepList.length > 0 && (
                    <button data-tour-again style={S.profileMenuItem} onClick={startTour}>
                      Take the tour again
                    </button>
                  )}
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
  // What the steps read: where the student is and what the card is doing.
  const tourState = {
    mode,
    lessonFilter,
    typeMode: typeMode && !!card,
    front: card && !sessionDone
      ? dropFinalPeriod(card.shownDir === "fr" ? cleanFrenchPrompt(card.f, card.b) : cleanEnglishPrompt(card.b))
      : "",
    hasCard: !!card && !sessionDone,
    // Never answered the way round it is shown.
    cardNew: !!card && !sessionDone && (sideOf(card, card.shownDir ?? "fr").fsrs_state ?? State.New) === State.New,
    graded: !!card && !sessionDone && (typeMode ? !!typeResult : answerSeen),
    result: typeResult,
    cardKey: sessionDone ? "done" : cardSlot,
    notesOpen: showLessonPanel,
    // Whether the notes sit beside the card or cover it (the window's width).
    notesBeside: roomToReflow(LESSON_PANEL_WIDTH),
    tourLessonOn: lessonsOn.has(TOUR_LESSON),
  };
  const modals = (
    <>
      <LessonPanel
        open={showLessonPanel}
        onClose={() => setShowLessonPanel(false)}
        lesson={LESSONS.find((l) => l.id === lessonFilter) || null}
        reflow={lessonReflow}
        sidebarWidth={sidebarWidth}
      />
      {lessonToggleBox && createPortal(
        <button
          data-lesson-toggle-copy
          style={{ ...S.chipToggle, ...S.chipToggleA, position: "fixed", zIndex: 1001, margin: 0, boxSizing: "border-box", whiteSpace: "nowrap", ...lessonToggleBox }}
          onClick={toggleLessonPanel}
          title="The lesson, beside the cards"
        >
          Lesson notes
        </button>,
        document.body
      )}
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
        sidebarWidth={sidebarWidth}
      />
      <ApiKeyModal
        open={showKeyModal}
        onClose={() => setShowKeyModal(false)}
        user={user}
      />
      <FsrsSettingsModal
        open={showFsrsSettings}
        onClose={() => setShowFsrsSettings(false)}
        settings={fsrs}
      />
      <CahierUpload
        open={showUpload}
        user={user}
        cahier={cahier}
        onClose={() => setShowUpload(false)}
        hasExisting={userCards.length > 0}
        initialTab={uploadInitialTab}
        onSuccess={(result) => {
          setShowUpload(false);
          reloadDeck();
          if (result.linked) return alert(uploadDoneText(result));
          alert(uploadResultText(result));
        }}
      />
      {showFeedbackModal && (
        <FeedbackReviewModal user={user} onClose={() => setShowFeedbackModal(false)} onOwnCardChanged={reloadDeck} />
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
            if (!confirm("Remove this card from your deck? Your answers on it are kept, and the same word in your notes won't bring it back.")) return;

            // Only the admin is asked why, in the correction codes the notes
            // checks read, and only the admin's correction is logged
            // (/api/parse-corrections accepts no one else). A student used to
            // get the list of codes too, and their pick was refused without a
            // word; Cancel on it called off a removal they had just said yes
            // to (2026-10-06).
            if (isAdmin) {
              // duplicate_detected is the default: by far the commonest
              // reason. Anything not on the menu falls back to it.
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
                `Why are you removing this card?\n\nPick one:\n  ${CATEGORY_MENU.join(
                  "\n  "
                )}\n\n(press Enter to accept the default)`,
                "duplicate_detected"
              );
              // Pressing Cancel returns null — treat as abort.
              if (categoryInput === null) return;
              const category = CATEGORY_MENU.includes(categoryInput.trim())
                ? categoryInput.trim()
                : "duplicate_detected";

              // Logged first, as the removal is a correction of Claude's reading.
              logCorrection({
                category,
                action: CORRECTION_ACTIONS.DELETE,
                card_id: editingCard.row_id,
                batch_id: editingCard.batch_id || null,
                original_front: editingCard.f,
                original_back: editingCard.b,
              });
            }

            const ok = await deleteCard(editingCard.row_id);
            if (ok) setEditingCard(null);
          }}
        />
      )}
      {tourOpen && tourStepList.length > 0 && (
        <Tour key={tourRun} steps={tourStepList} app={tourState} onClose={() => setTourOpen(false)} />
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
            {LESSON_GROUPS.map((group) => (
              <Fragment key={group.title || "lessons"}>
              {group.title && (group.folds ? (
                <button
                  style={S.lessonGroupToggle}
                  onClick={() => togglePageGroup(group.title)}
                  aria-expanded={!pageClosedGroups.has(group.title)}
                  data-lesson-group-heading={group.title}
                >
                  {group.title}
                  <span style={pageClosedGroups.has(group.title) ? S.lessonGroupChevron : { ...S.lessonGroupChevron, ...S.sideChevronOpen }} aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </span>
                </button>
              ) : (
                <h2 style={S.lessonGroupHeading} data-lesson-group-heading={group.title}>{group.title}</h2>
              ))}
              {!(group.folds && pageClosedGroups.has(group.title)) && group.lessons.map((lesson) => {
              const owned = userCards.filter((c) => lessonIdOf(c) === lesson.id);
              const added = owned.length > 0;
              // A lesson card whose front the deck already had as its own is
              // not added (reconcileLessons' `taken`), but the word is there.
              const ownFronts = new Set(userCards.filter((c) => !lessonIdOf(c)).map((c) => c.f));
              const inDeck = owned.length + lesson.cards.filter(([f]) => ownFronts.has(f)).length;
              // Whether its cards come up on Cards (lib/lessonChoice.js), and
              // how many are due today, the way the student is studying: in
              // EN→FR a word due only French side up is not waiting for them.
              const on = lessonsOn.has(lesson.id);
              const endToday = endOfLocalDay(new Date());
              let due = 0;
              for (const c of owned) {
                for (const d of directionsOf(c)) {
                  if (isTwoWay(c) && dir !== "mix" && d !== dir) continue;
                  const side = sideOf(c, d);
                  if ((side.fsrs_state ?? State.New) !== State.New && side.next_due_at &&
                      new Date(side.next_due_at).getTime() <= endToday) due++;
                }
              }
              return (
                <div key={lesson.id} style={S.lessonCard} data-tour-lesson={lesson.id}>
                  <div style={S.lessonHead}>
                    <div>
                      <div style={S.lessonTitle}>{lesson.title}</div>
                      <div style={S.lessonSub}>{lesson.subtitle}</div>
                    </div>
                    {/* No "add" step: lessons ship with the app and sync
                        themselves into the deck on load. A student should
                        find L'impératif already there. */}
                    <button
                      data-tour-study={lesson.id}
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
                  <div style={S.lessonSwitchRow} data-tour-include={lesson.id}>
                    <button
                      role="switch"
                      aria-checked={on}
                      data-lesson-include={lesson.id}
                      style={S.lessonSwitch}
                      onClick={() => setLessonChoice(lesson.id, !on)}
                    >
                      <span style={on ? {...S.switchTrack, ...S.switchTrackOn} : S.switchTrack}>
                        <span style={on ? {...S.switchKnob, ...S.switchKnobOn} : S.switchKnob} />
                      </span>
                      In my daily cards
                    </button>
                    <div style={choiceFailed === lesson.id ? {...S.lessonSwitchNote, ...S.lessonSwitchFailed} : S.lessonSwitchNote} data-lesson-include-note>
                      {choiceFailed === lesson.id
                        ? "That didn't save. Try again."
                        : on
                        ? null
                        : due > 0
                        ? `${due.toLocaleString()} ${due === 1 ? "card is" : "cards are"} due. While this is off, they come up only when you study the lesson.`
                        : "Its cards come up only when you study the lesson."}
                    </div>
                  </div>
                </div>
              );
            })}
              </Fragment>
            ))}
          </div>
        </main>
        {modals}
      </div>
    );
  }

  if (mode === "stats") {
    const now = Date.now();
    const todayISO = localISODate();

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

    // Seen / ~N remembered / not yet seen, for the whole deck and each area.
    const areas = progressByArea(userCards, now);
    const history = statsHistory;

    // Today, from the record of answers: the cards studied, in three (new
    // cards, reviews back from an earlier day, and retries), and how many
    // first tries were right. A retry isn't a first try. Every figure names
    // what it counts and they add up: 64 cards = 21 new + 29 reviews + 14
    // retries, and right first time is out of the 50 new and reviews (owner,
    // 2026-10-06). Until the record is read, or if it can't be, each card's
    // own last answer stands in: one per card and way round answered today,
    // with no split.
    let today;
    if (history) {
      const d = history.days.at(-1)?.iso === todayISO ? history.days.at(-1) : { cards: 0, fresh: 0, reviews: 0, retries: 0, right: 0 };
      today = { ...d, tries: d.fresh + d.reviews };
    } else {
      let tries = 0, right = 0;
      for (const c of userCards) for (const dir of directionsOf(c)) {
        const side = sideOf(c, dir);
        if (!reviewedToday(side.last_review, new Date(now))) continue;
        tries++;
        if (side.last_answer_correct === true) right++;
      }
      today = { cards: tries, tries, right, fresh: null };
    }

    // The last 7 days: ~N remembered now against the end of the day a week
    // ago, for the whole deck and each area, worked out from the record.
    const weekAgo = history ? history.rememberedAt(endOfDayAgo(7, now)) : null;
    const gain = (nowRem, thenRem) => Math.round(nowRem) - Math.round(thenRem || 0);
    const firstDayLong = history?.days.length
      ? new Date(history.days[0].start).toLocaleDateString(undefined, { day: "numeric", month: "long" })
      : null;
    // "Since you started" only if the record goes back to the first day
    // studied: the streak's days go back further for anyone who studied before
    // every answer was kept (2026-09-14).
    const startedThen = history?.days.length > 0 && ![...reviewDates].some((d) => d < history.days[0].iso);

    // The chart: ~N remembered at the end of each day, and now for today, so
    // its last point is the figure above it.
    const points = history ? history.days.map((d) => ({ ...d })) : [];
    if (points.length) points[points.length - 1].remembered = areas.all.remembered;

    // At the pace of the last 14 days, when every card will have been seen.
    const allSeenDate = history ? allSeenBy({ history, notSeen: areas.all.notSeen, now }) : null;

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
    // Progress by Lesson: a group that folds (Basic Lessons) as one row, its
    // lessons added together, then every other lesson, then the two class
    // groups. Each with its change over the last 7 days.
    const lessonRow = (l) => ({
      key: `lesson:${l.id}`, label: l.title, summary: areas.lessons[l.id],
      delta: weekAgo ? gain(areas.lessons[l.id].remembered, weekAgo.byArea[`lesson:${l.id}`]) : null,
    });
    const lessonGroups = [];
    const lessonRows = [];
    for (const g of LESSON_GROUPS) {
      const rows = g.lessons.filter((l) => areas.lessons[l.id]?.total > 0).map(lessonRow);
      if (!rows.length) continue;
      if (!g.folds) { lessonRows.push(...rows); continue; }
      const sum = (k) => rows.reduce((n, r) => n + r.summary[k], 0);
      lessonGroups.push({
        key: `group:${g.title}`, label: g.title, sub: `${rows.length} ${rows.length === 1 ? "lesson" : "lessons"}`, lessons: rows,
        summary: { total: sum("total"), seen: sum("seen"), remembered: sum("remembered"), notSeen: sum("notSeen") },
        delta: weekAgo ? rows.reduce((n, r) => n + r.delta, 0) : null,
      });
    }
    const classRows = ["recent", "earlier"].map((k) => ({
      key: k, label: AREA_LABEL[k], sub: areaSpan[k], summary: areas[k],
      delta: weekAgo ? gain(areas[k].remembered, weekAgo.byArea[k]) : null,
    })).filter((r) => r.summary.total > 0);

    return (
      <div style={shellStyle}>
        {sidebar}
        <main style={mainStyle}>
          <div style={S.mainInnerScroll}>
            <h1 style={S.statsHeading}>Progress</h1>

            {/* Row 1: Today · Right first time today · Streak */}
            <div style={S.statsRow3}>
              <div style={S.metricCard} data-stats-today>
                <div style={S.metricLabel}>Today</div>
                <div><span style={S.metricVal}>{today.cards.toLocaleString()}</span> <span style={S.metricUnit}>{today.cards === 1 ? "card" : "cards"}</span></div>
                <div style={S.metricSub}>
                  {today.cards === 0 ? "nothing studied yet today" : today.fresh == null ? "" : splitText(today)}
                </div>
              </div>
              <div style={S.metricCard} data-stats-first-time>
                <div style={S.metricLabel}>Right first time today</div>
                <div style={S.metricVal}>{today.tries > 0 ? `${Math.round((today.right / today.tries) * 100)}%` : "—"}</div>
                <div style={S.metricSub}>
                  {today.tries === 0 ? "nothing answered yet today"
                    : `${today.right.toLocaleString()} of ${today.tries.toLocaleString()} ${today.tries === 1 ? "card" : "cards"}` +
                      (today.fresh == null ? "" : ` (${today.fresh} new + ${today.reviews} ${today.reviews === 1 ? "review" : "reviews"})`)}
                </div>
              </div>
              <div style={S.streakCard}>
                <div style={{fontSize:16}}>🔥</div>
                <div style={S.streakNum}>{streak}</div>
                <div style={S.streakSub}>day streak</div>
              </div>
            </div>

            {/* ~N remembered, day by day */}
            {history && points.length > 0 && (
              <RememberedChart
                points={points}
                now={now}
                week={{ gain: gain(areas.all.remembered, weekAgo.all), met: history.newMetBetween(endOfDayAgo(7, now), now) }}
                all={{ remembered: aboutRemembered(areas.all), met: history.newMetBetween(-Infinity, now) }}
                allLabel={startedThen ? "Since you started" : `Since ${firstDayLong}`}
              />
            )}

            {/* All cards: seen / ~N remembered / not yet seen, and when all will be seen */}
            <div style={S.pipelineCard} data-stats-all>
              <div style={S.pipeTitle}>All your cards</div>
              <Bands summary={areas.all} height={28} />
              <div style={S.pipeLegend}>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.primary}} />~{aboutRemembered(areas.all).toLocaleString()} remembered</div>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.primary, opacity:0.3}} />{Math.max(0, areas.all.seen - aboutRemembered(areas.all)).toLocaleString()} seen, not currently remembered</div>
                <div style={S.pipeLegItem}><div style={{...S.pipeDot, background:T.color.surfaceHigh}} />{areas.all.notSeen.toLocaleString()} not yet seen</div>
              </div>
              <p style={S.statsFootnote}>A word or phrase counts as remembered once you'd get it right from French and from English. It's an estimate: it rises when you study and falls when you don't.</p>
              {allSeenDate && (
                <div style={S.finishLine} data-stats-finish>
                  At your current pace, all seen by <b>{allSeenDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>.
                </div>
              )}
            </div>

            {/* The days studied since the first answer on record */}
            {history && history.days.length > 0 && (
              <StudyCalendar days={history.days} since={startedThen ? `since you started on ${firstDayLong}` : `since ${firstDayLong}`} />
            )}

            {/* Each lesson, Basic Lessons folded together, and the class groups */}
            {(lessonGroups.length > 0 || lessonRows.length > 0 || classRows.length > 0) && (
              <ProgressByLesson groups={lessonGroups} rows={[...lessonRows, ...classRows]} />
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
  // What to type, above the prompt of a grammar card: "Present tense, with
  // je", "Write the adverb for this adjective". "vivre → je" never said which
  // tense, and "relatif → adverbe" read as a word to translate. In italics, like
  // the tap hint, so it reads as the app talking rather than part of the card.
  // Grammar cards are only ever shown French side.
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
    // Turned back to its question with the turn-back arrow: a tap turns it
    // over again. Moving on from there would record the answer from a card
    // the student was only re-reading.
    if (!flipped) return flip();
    answer(typedRecalled, "typed");
  };

  return (
    <div style={shellStyle}>
      {sidebar}
      <main style={mainStyle}>
        {/* Top app bar — kind of card, settings menu, sticky glass */}
        <div style={S.topBar}>
          <div style={S.topBarInner}>
          {/* The row scrolls in a narrow window rather than squeezing; the gear
              sits outside it, as the scrolling would clip its menu. */}
          <div style={S.topBarLeft} className="chip-row">
          {/* The kind of card: the one choice left on the bar. Hidden inside a
              lesson, where it does not survive contact: of the 108 impératif
              cards, 80 classify as grammar and 28 as phrase, so Vocab hands
              you an empty session and the other two collapse to "drills or
              sentences" — a distinction the lesson's own sections make far
              better. enterLesson() clears it so nothing narrows the deck
              invisibly while the control that would show it is gone.
              Everything or only the student's own cards is "Include lessons"
              in the settings menu. */}
          {lessonFilter === "all" && (
            <div style={S.typeGroup} data-type-filter>
              {[["all", "All"], ...CARD_TYPES.map((t) => [t, TYPE_LABEL[t] === "Phrase" ? "Phrases" : TYPE_LABEL[t]])]
                .map(([k, label]) => (
                  <button
                    key={k}
                    style={typeFilter === k ? {...S.dirBtn, ...S.dirBtnA} : S.dirBtn}
                    onClick={() => setTypeFilter(k)}
                    title={k === "all"
                      ? "Everything, mixed — best for long-term retention"
                      : `Only ${label.toLowerCase()} this session`}
                  >
                    {label}
                  </button>
                ))}
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
              on every card reads as noise rather than progress. Plain
              "N/M remembered" (owner, 2026-10-04). */}
          {lessonFilter !== "all" && (() => {
            const snap = (sessionDone && checkpoint ? checkpoint.after : blockStartRef.current)?.lessons?.[lessonFilter];
            return snap ? (
              <div style={S.lessonProgress} data-lesson-progress>
                {aboutRemembered(snap).toLocaleString()}/{snap.total.toLocaleString()} remembered
              </div>
            ) : null;
          })()}
          {lessonFilter !== "all" && (
            <button
              data-lesson-toggle
              ref={lessonToggleRef}
              style={showLessonPanel ? {...S.chipToggle, ...S.chipToggleA} : S.chipToggle}
              onClick={toggleLessonPanel}
              title="The lesson, beside the cards"
            >
              Lesson notes
            </button>
          )}
          </div>
          <div style={S.settingsWrap} ref={settingsRef}>
            <button
              data-settings-toggle
              style={showSettings ? {...S.gearBtn, ...S.gearBtnA} : S.gearBtn}
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Settings"
              aria-expanded={showSettings}
              title="Settings"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            {/* Kept in the page when closed, only hidden, so its switches can
                be reached the same way whether or not it is showing. */}
            {(
              <div style={showSettings ? S.settingsMenu : {...S.settingsMenu, display:"none"}} data-settings-menu role="dialog" aria-label="Settings" aria-hidden={!showSettings}>
                <div style={S.settingsSec}>
                  <div style={S.settingsSeg}>
                    {[["fr", "French → English"], ["en", "English → French"], ["mix", "Mixed"]].map(([k, label]) => (
                      <button key={k} data-dir-choice={k} style={dir === k ? {...S.dirBtn, ...S.dirBtnA, ...S.settingsSegBtn} : {...S.dirBtn, ...S.settingsSegBtn}} onClick={() => setDir(k)}>{label}</button>
                    ))}
                  </div>
                </div>
                {/* A change made once the card's answer has been seen waits for
                    the next card (toggleTypeMode, the effect on dir); the
                    switch shows where it is going. */}
                <div style={{...S.settingsSec, ...S.settingsSecRule}}>
                  <SettingsSwitch label="Type answer" on={pendingTypeMode ?? typeMode} onClick={toggleTypeMode} data-type-toggle />
                  {TTS_AVAILABLE && (
                    <SettingsSwitch label="Auto-speak" on={autoSpeak} onClick={() => setAutoSpeak((v) => !v)} data-auto-speak />
                  )}
                  {/* Everything (on) or only the student's own cards (off):
                      lib/lessonChoice.js. Inside a lesson it means nothing. */}
                  {lessonFilter === "all" && (
                    <SettingsSwitch label="Include lessons" on={scope === "all"} onClick={() => setScope(scope === "all" ? "cahier" : "all")} data-scope />
                  )}
                </div>
                <div style={{...S.settingsSec, ...S.settingsSecRule}}>
                  <div style={S.settingsCap}>Cards in a set</div>
                  <div style={S.settingsSeg}>
                    {SET_SIZES.map((n) => (
                      <button key={n} data-set-size={n} style={setSize === n ? {...S.dirBtn, ...S.dirBtnA, ...S.settingsSegBtn} : {...S.dirBtn, ...S.settingsSegBtn}} onClick={() => setSetSize(n)}>{n}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
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

        <div style={S.mainInner} className="study-column">
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
                  {reviewMark && (
                    <span style={S.reviewMarkNotice} data-review-mark role="status">{reviewMark}</span>
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
                    {lessonFilter !== "all" ? " left in this lesson" : scope === "cahier" ? " left in your cahier" : ""}.
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
              <div style={S.cardWrap} onClick={onCardClick} data-tour="card">
                <div style={{...S.card, transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)", transition: skipFlipAnim.current ? "none" : S.card.transition, cursor: "pointer"}}>
                  <div style={{...S.cardFront, pointerEvents: flipped ? "none" : "auto"}}>
                    {cardLesson && <div className="card-badge" style={S.cardBadge}>{cardLesson.title}</div>}
                    {instruction && <div className="card-instruction" style={S.cardInstruction} data-card-instruction>{instruction}</div>}
                    <div style={S.cardText}>{front}</div>
                    {TTS_AVAILABLE && card.shownDir === "fr" && (
                      <div className="card-audio" style={S.cardAudio}>
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
                    {!effectiveTypeMode && <div className="card-hint" style={S.cardHint}>Tap to reveal translation</div>}
                    {effectiveTypeMode && !typeResult && <div className="card-hint" style={S.cardHint}>Tap to show answer</div>}
                    {!effectiveTypeMode && <ShortcutsTooltip />}
                    {!showFeedback && <ReportCardButton onReport={reportCard} nextToInfo={!effectiveTypeMode} />}
                    {answerSeen && <TurnCardButton onTurn={flip} toAnswer />}
                  </div>
                  <div style={{...S.cardBack, pointerEvents: flipped ? "auto" : "none"}}>
                    {cardLesson && <div className="card-badge" style={S.cardBadge}>{cardLesson.title}</div>}
                    <div style={S.cardTextB}>{back}</div>
                    {TTS_AVAILABLE && card.shownDir === "en" && (
                      <div className="card-audio" style={S.cardAudio}>
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
                    {answerSeen && <TurnCardButton onTurn={flip} />}
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
              <div style={S.belowCard} data-tour="well">
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
                    <div style={disputeAccepted || typeResult==="correct" ? S.typeCorrect : typeResult==="close" ? S.typeClose : typeResult==="revealed" ? S.typeRevealed : S.typeWrong}>
                      {/* The card has already flipped to the correct answer, so
                          repeating it here wastes the line. Show what you
                          actually typed instead — that's the useful comparison.
                          "revealed" is the exception: nothing was typed.
                          An answer "My answer should be accepted" got accepted
                          turns green: it stayed a red ✗ and looked like a miss
                          still, though Continue saves it as right. */}
                      {disputeAccepted ? `✓ Accepted — you wrote: ${typedAnswer.trim()}` : (
                        <>
                          {typeResult==="correct" && "✓ Correct!"}
                          {typeResult==="close" && (typedAnswer.trim() ? `✓ Close enough — you wrote: ${typedAnswer.trim()}` : "✓ Close enough")}
                          {typeResult==="wrongArticle" && (typedAnswer.trim() ? `✗ Wrong article — you wrote: ${typedAnswer.trim()}` : `✗ Wrong article — answer: ${back}`)}
                          {typeResult==="wrong" && (typedAnswer.trim() ? `✗ You wrote: ${typedAnswer.trim()}` : `✗ Answer: ${back}`)}
                          {typeResult==="revealed" && `Answer: ${back}`}
                        </>
                      )}
                    </div>
                    {(() => {
                      const gotIt = typedRecalled;
                      const missed = typeResult === "wrong" || typeResult === "close" || typeResult === "wrongArticle";
                      return (
                        <>
                          {/* Beside the result, at its own size. Stacked under
                              it, the two took 99px of the well between them. */}
                          <button style={S.continueBtn} onClick={() => answer(gotIt, "typed")} data-tour="continue">
                            Continue →
                          </button>
                          {/* The follow-ups sit BELOW Continue, in one centred
                              row at 12px: Continue is what you press nearly
                              every time, so it comes first after the result.
                              One row for all three rather than a row each,
                              because belowCard is a fixed 110px well and every
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
                                    onClick={markForReview}
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
                                <div style={S.feedbackMsg}>This answer will be accepted from now on.</div>
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
                                <div style={S.feedbackMsg}>This answer will be accepted from now on.</div>
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
                    <div style={S.typeInputRow} data-tour="answer-row">
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
                      <button style={S.giveUpBtn} onClick={giveUpTyped} data-tour="show-answer">
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
                      <div style={S.actionRow} data-tour="grade">
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
                      <button style={S.actionGotRect} onClick={flip} data-show-answer data-tour="show-answer">
                        Show answer
                      </button>
                    </div>
                  )}
                  </>
              )}
              </div>
            </div>
          ) : (
            <div style={S.empty}>
              <p><strong>You're all caught up.</strong> Nothing is due, and there are no new cards here.</p>
              {/* A new student's deck holds only lessons, and only the basic
                  ones are on until they switch another on
                  (lib/lessonChoice.js): say where that is. */}
              {lessonFilter === "all" && scope === "all" && lessonsOff && (
                <p data-lessons-off-note>Lessons come up here once you switch them on, on the Lessons page.</p>
              )}
              <button style={S.resetSBtn} onClick={resetSession}>Check again</button>
            </div>
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
// the Feedback Review page. The entry itself is read-only; in View feedback,
// Claude's review and the owner's buttons sit beneath it (`children`, see
// FeedbackReview). Feedback about the app is still fixed by a Claude session,
// which resolves the entry with scripts/resolve-feedback.mjs.
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

function FeedbackEntry({ item, number, last, children }) {
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
      {children}
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

const NEEDS_MIGRATION_014 =
  "Claude can't review feedback yet: this database has no review column. Run migrations/migration_014_feedback_review.sql in the Supabase SQL editor.";

const NEEDS_MIGRATION_009 =
  "Showing resolved feedback too: this database has no resolved_at column yet. Run migrations/migration_009_beta_feedback_resolved.sql in the Supabase SQL editor.";

// ─── CLAUDE'S REVIEW OF FEEDBACK ──────────────────────────────────────────
// Every piece of feedback is reviewed by Claude when it is sent, or here when
// View feedback opens, for anything that has no review yet. Claude says whether
// the sender is right and what it needs (api/_lib/feedbackReview.js):
//   card  a corrected card. Apply writes it over the card, in place, so the
//         card keeps its schedule and history; it works on any student's deck.
//   remove  the card shouldn't be in the deck. "Remove card" archives it, so
//         its answers are kept. Revert undoes either (owner, 2026-10-04).
//   app   a change to the app or a lesson, which only a coding session can
//         make. "Copy for Claude" copies a brief to paste into one; that
//         session resolves the entry when it has fixed it.
//   none  nothing to change.
// Dismiss resolves any entry. Nothing changes until the owner presses a button
// (owner, 2026-10-04).

async function feedbackRequest(feedback) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch("/api/review-answer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
    body: JSON.stringify({ feedback }),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || `The server answered ${res.status}.`);
    err.code = body?.code;
    throw err;
  }
  return body;
}

const REVIEW_LABEL = { card: "Card fix", remove: "Remove card", app: "App problem", none: "No change needed" };
const REVIEW_COLOR = { card: T.color.secondary, remove: T.color.secondary, app: T.color.primary, none: T.color.onSurfaceVariant };

// What "Copy for Claude" puts on the clipboard: enough for a fresh session to
// find the problem, fix it and resolve the entry.
function feedbackBrief(item) {
  const r = item.review || {};
  const ctx = item.card_context;
  return [
    `Fix feedback #${item.id} from ${item.user_email || "a student"}, sent ${feedbackTime(item.created_at)}:`,
    `"${item.message}"`,
    ctx ? `Card: ${ctx.front} · ${ctx.back}` : null,
    "",
    `Claude's review: ${r.reasoning || ""}`,
    r.brief ? `What needs changing: ${r.brief}` : null,
    "",
    `When it is fixed, resolve it: node scripts/resolve-feedback.mjs ${item.id} --note "what was done" --apply`,
  ].filter((l) => l !== null).join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    area.remove();
    return ok;
  }
}

function FeedbackReview({ item, state, onApply, onDismiss, onReview, onRevert }) {
  const [copied, setCopied] = useState(false);
  const r = item.review;

  if (state.done) {
    return (
      <div data-feedback-review style={S.fbReview}>
        <div style={S.fbReviewDone}>
          {state.done === "dismissed"
            ? "Dismissed."
            : state.removed
              ? <>Taken out of the deck, answers kept: <b>{state.card.front}</b> · {state.card.back}</>
              : <>Applied. The card now reads <b>{state.card.front}</b> · {state.card.back}</>}
        </div>
        {state.done === "applied" && (
          <div style={S.fbReviewActions}>
            <button type="button" data-feedback-revert style={S.fbReviewBtn} disabled={!!state.busy} onClick={onRevert}>
              {state.busy === "revert" ? "Reverting…" : "Revert"}
            </button>
          </div>
        )}
        {state.error && <div style={S.fbReviewError}>{state.error}</div>}
      </div>
    );
  }
  if (state.reviewing) {
    return (
      <div data-feedback-review style={S.fbReview}>
        <div style={S.fbReviewMuted}>Claude is reviewing this…</div>
      </div>
    );
  }

  const busy = !!state.busy;
  const error = state.error && (
    <div style={S.fbReviewError}>
      {state.error}
      {(state.errorCode === "card_changed" || !r) && (
        <> <button type="button" style={S.fbReviewLink} onClick={onReview}>Review again</button></>
      )}
    </div>
  );

  if (!r) {
    return (
      <div data-feedback-review style={S.fbReview}>
        {error || <div style={S.fbReviewMuted}>Not reviewed yet.</div>}
        <div style={S.fbReviewActions}>
          {!state.error && <button type="button" style={S.fbReviewBtn} onClick={onReview}>Ask Claude</button>}
          <button type="button" style={S.fbReviewBtn} disabled={busy} onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    );
  }

  return (
    <div data-feedback-review={r.kind} style={S.fbReview}>
      <div style={{ ...S.fbReviewLabel, color: REVIEW_COLOR[r.kind] }}>Claude · {REVIEW_LABEL[r.kind]}</div>
      {r.reasoning && <div style={S.fbReviewText}>{r.reasoning}</div>}
      {r.kind === "card" && r.fix && (
        <div style={S.fbReviewFix}>
          <span style={S.fbReviewFixLabel}>Now</span>
          <span style={S.fbReviewFixText}>{r.card?.front} · {r.card?.back}</span>
          <span style={S.fbReviewFixLabel}>After</span>
          <span style={{ ...S.fbReviewFixText, color: T.color.onSurface, fontWeight: 600 }}>{r.fix.front} · {r.fix.back}</span>
        </div>
      )}
      {r.kind === "remove" && r.card && (
        <div style={S.fbReviewFix}>
          <span style={S.fbReviewFixLabel}>Remove</span>
          <span style={{ ...S.fbReviewFixText, color: T.color.onSurface }}>{r.card.front} · {r.card.back}</span>
        </div>
      )}
      <div style={S.fbReviewActions}>
        {r.kind === "card" && r.fix && (
          <button type="button" data-feedback-apply style={S.fbReviewPrimary} disabled={busy} onClick={onApply}>
            {state.busy === "apply" ? "Applying…" : "Apply"}
          </button>
        )}
        {r.kind === "remove" && r.card && (
          <button type="button" data-feedback-apply style={S.fbReviewPrimary} disabled={busy} onClick={onApply}>
            {state.busy === "apply" ? "Removing…" : "Remove card"}
          </button>
        )}
        {r.kind === "app" && (
          <button
            type="button"
            data-feedback-copy
            style={S.fbReviewPrimary}
            onClick={async () => {
              if (await copyText(feedbackBrief(item))) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
          >
            {copied ? "Copied" : "Copy for Claude"}
          </button>
        )}
        <button type="button" data-feedback-dismiss style={S.fbReviewBtn} disabled={busy} onClick={onDismiss}>
          {state.busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
      {error}
    </div>
  );
}

// Shows open beta_feedback entries in a portal overlay, the owner's own first
// and other students' below. Triggered from the profile dropdown → "View
// feedback". Entries keep the numbers the script uses (newest first across
// the whole list), so the two sections' numbers interleave.
function FeedbackReviewModal({ user, onClose, onOwnCardChanged }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resolvable, setResolvable] = useState(true);
  // A database without migration_014 has no review column, so nothing can be
  // reviewed or kept.
  const [reviewable, setReviewable] = useState(true);
  // Per entry, by id: { reviewing, busy, error, errorCode, done, card }.
  const [states, setStates] = useState({});
  const patch = (id, next) => setStates((all) => ({ ...all, [id]: { ...all[id], ...next } }));
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Development runs effects twice; each review is a paid call to Claude.
  const started = useRef(false);

  const review = useCallback(async (item) => {
    patch(item.id, { reviewing: true, error: null, errorCode: null });
    try {
      const { review: r } = await feedbackRequest({ action: "review", id: item.id });
      if (!mounted.current) return;
      setItems((list) => list.map((x) => (x.id === item.id ? { ...x, review: r } : x)));
      patch(item.id, { reviewing: false });
    } catch (e) {
      if (mounted.current) patch(item.id, { reviewing: false, error: `Claude couldn't review this: ${e.message}` });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const { data, error, resolvable } = await loadOpenFeedback();
      if (error) console.error("Failed to load feedback:", error);
      const canReview = resolvable && (data.length === 0 || data.some((x) => "review" in x));
      setItems(data);
      setResolvable(resolvable);
      setReviewable(canReview);
      setLoading(false);
      if (!canReview) return;
      // Three at a time, oldest first: each is a call to Claude. A review from
      // before Claude could suggest what it can now is asked for afresh.
      const queue = data
        .filter((x) => !x.review || (x.review.version ?? 1) < FEEDBACK_REVIEW_VERSION)
        .reverse();
      queue.forEach((x) => patch(x.id, { reviewing: true }));
      const worker = async () => {
        while (queue.length && mounted.current) await review(queue.shift());
      };
      await Promise.all([worker(), worker(), worker()]);
    })();
  }, [review]);

  const act = async (item, action) => {
    patch(item.id, { busy: action, error: null, errorCode: null });
    try {
      const result = await feedbackRequest({ action, id: item.id });
      if (!mounted.current) return;
      if (action === "revert") patch(item.id, { busy: null, done: null, removed: false, card: null });
      else patch(item.id, { busy: null, done: action === "apply" ? "applied" : "dismissed", removed: !!result.removed, card: result.card });
      if (action !== "dismiss" && result.own) onOwnCardChanged?.();
    } catch (e) {
      if (mounted.current) patch(item.id, { busy: null, error: e.message, errorCode: e.code });
    }
  };

  const numbered = items.map((item, i) => ({ item, number: i + 1 }));
  const sections = [
    ["Your feedback", numbered.filter(({ item }) => item.user_id && item.user_id === user?.id)],
    ["Other students", numbered.filter(({ item }) => !(item.user_id && item.user_id === user?.id))],
  ];
  const openCount = items.filter((x) => !states[x.id]?.done).length;

  return createPortal(
    <div style={S.feedbackModalOverlay} onClick={onClose}>
      <div data-feedback-log style={S.feedbackModalBox} onClick={e => e.stopPropagation()}>
        <div style={S.fbLogHeader}>
          <h2 style={S.fbLogTitle}>Feedback</h2>
          {!loading && <span style={S.fbLogCount}>{openCount} open</span>}
          <span style={{ flex: 1 }} />
          <button aria-label="Close" style={S.fbLogClose} onClick={onClose}>×</button>
        </div>
        {!resolvable && <div style={S.fbLogNote}>{NEEDS_MIGRATION_009}</div>}
        {resolvable && !reviewable && <div style={S.fbLogNote}>{NEEDS_MIGRATION_014}</div>}
        {loading ? (
          <div style={S.fbLogEmpty}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={S.fbLogEmpty}>No open feedback.</div>
        ) : (
          <div style={S.fbLogList}>
            {sections.map(([title, entries]) => (
              <section key={title} data-feedback-section={title}>
                <h3 style={S.fbLogSection}>{title}</h3>
                {entries.length === 0 && <div style={S.fbLogSectionEmpty}>Nothing open.</div>}
                {entries.map(({ item, number }, i) => (
                  <FeedbackEntry key={item.id} item={item} number={number} last={i === entries.length - 1}>
                    {reviewable && (
                      <FeedbackReview
                        item={item}
                        state={states[item.id] || {}}
                        onApply={() => act(item, "apply")}
                        onDismiss={() => act(item, "dismiss")}
                        onReview={() => review(item)}
                        onRevert={() => act(item, "revert")}
                      />
                    )}
                  </FeedbackEntry>
                ))}
              </section>
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
  // A word or phrase card is a translation: French on one side, English on
  // the other, whichever way round it was asked. Any other card (a
  // conjugation drill, a lesson exercise) is a question and its answer, often
  // both in French, so "French / English" mislabelled it.
  const [frontLabel, backLabel] = isTwoWay(card) ? ["French", "English"] : ["Question", "Answer"];

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
        <label style={EM.label}>{frontLabel}</label>
        <input
          style={EM.input}
          value={front}
          onChange={(e) => setFront(e.target.value)}
          disabled={saving}
        />
        <label style={EM.label}>{backLabel}</label>
        <textarea
          style={EM.textarea}
          value={back}
          onChange={(e) => setBack(e.target.value)}
          disabled={saving}
        />
        {error && <div style={EM.error}>{error}</div>}
        <div style={EM.footer}>
          <button style={EM.deleteBtn} onClick={onDelete} disabled={saving}>Remove card</button>
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
// One on/off row in the settings menu.
function SettingsSwitch({ label, on, onClick, ...rest }) {
  return (
    <button {...rest} role="switch" aria-checked={on} onClick={onClick} style={S.settingsRow}>
      <span style={S.settingsLabel}>{label}</span>
      <span style={on ? {...S.switchTrack, ...S.switchTrackOn} : S.switchTrack}>
        <span style={on ? {...S.switchKnob, ...S.switchKnobOn} : S.switchKnob} />
      </span>
    </button>
  );
}

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

// ─── TURN THE CARD BACK ──────────────────────────────────────────────────
// A small U-turn arrow in the card's top-left corner, once the answer has
// been seen: on the answer side it turns the card back to its question, and
// on the question side over to the answer again. Turning records nothing; the
// grade is still Got It / Again, or Continue after a typed answer. Never
// shown before the answer, where it would be a way to peek. Stops the click
// so the card underneath doesn't also flip, continue or grade.
function TurnCardButton({ onTurn, toAnswer = false }) {
  const label = toAnswer ? "See the answer again" : "See the question again";
  return (
    <button
      type="button"
      data-turn-card={toAnswer ? "answer" : "question"}
      style={{ ...S.cardActionBtn, ...S.cardTurnBtn }}
      onClick={(e) => { e.stopPropagation(); onTurn(); }}
      title={label}
      aria-label={label}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={toAnswer ? { transform: "scaleX(-1)" } : undefined}>
        <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
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
  // minHeight:0 is what lets the flex children actually shrink; without it a
  // flex item refuses to go below its content size and the card pushes the
  // buttons off the bottom instead of getting smaller.
  main: { flex:1, display:"flex", flexDirection:"column", minWidth:0, minHeight:0 },
  // Scrolls only on a window too short for the study view at its smallest —
  // the .study-column rule in styles.css. Always scrolling would clip the
  // blur shapes at the column's edges on every window.
  mainInner: { flex:1, minHeight:0, display:"flex", flexDirection:"column", padding:"12px 40px 16px", maxWidth:1100, width:"100%", margin:"0 auto", boxSizing:"border-box" },
  // Stats is genuinely long-form, so it scrolls within main.
  mainInnerScroll: { flex:1, minHeight:0, overflowY:"auto", padding:"32px 40px 60px", maxWidth:1100, width:"100%", margin:"0 auto", boxSizing:"border-box" },

  // ── Sidebar ───────────────────────────────────────────────────────
  // Fixed 256px column on desktop. The sticky positioning + 100vh height
  // means the sidebar stays fixed while the main content scrolls.
  // overflowX stays visible when minimized so the profile menu can open past
  // the 64px rail; the rail is short enough never to need to scroll.
  // Padding as longhands, not the shorthand: React diffs per property, so going
  // back from the rail's paddingTop:8 removed paddingTop without re-applying the
  // shorthand, the top padding fell to 0 and Cards slid up under the button.
  sideBarMin: { width:SIDEBAR_MIN_WIDTH, overflowY:"visible", paddingTop:8 },
  sideBar: { width:SIDEBAR_WIDTH, background:T.color.surfaceLow, borderRight:"1px solid rgba(3,22,50,0.07)", paddingTop:40, paddingRight:0, paddingBottom:24, paddingLeft:0, display:"flex", flexDirection:"column", flexShrink:0, position:"sticky", top:0, height:"100vh", overflowY:"auto", boxSizing:"border-box", transition:`width ${PANEL_ANIM_MS}ms ${PANEL_EASING}` },
  // Not flex:1 any more — the feedback dock below takes the free height, so the
  // panel can sit in it. The nav looks the same either way.
  sideNav: { display:"flex", flexDirection:"column", gap:4, flex:"none" },
  sideFeedbackDock: { flex:"1 1 auto", minHeight:0, display:"flex", flexDirection:"column", justifyContent:"flex-end", padding:"24px 16px 12px", boxSizing:"border-box" },
  // Indented to sit under its parent nav item, and quieter than one: a lesson
  // is a place inside Lessons, not a peer of Cards and Stats.
  // Every nav style declares all FOUR border sides, even the three it does not
  // use, as longhands: React diffs style objects per property, so a side left
  // undeclared keeps whatever an earlier style set there. Declaring all four
  // means switching always overwrites instead of relying on a property being
  // absent.
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
  // A lesson under a heading (Basic Lessons) sits one step further in.
  sideSubItemNested: { paddingLeft:80 },
  sideGroup: { display:"flex", alignItems:"center", width:"100%", padding:"9px 32px 5px 64px", border:"none", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:13, fontWeight:600, color:"rgba(3,22,50,0.7)", textAlign:"left", boxSizing:"border-box" },
  sideSubItemActive: { color:T.color.secondary, fontWeight:700, borderRightColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideItem: { display:"flex", alignItems:"center", gap:14, padding:"14px 32px", border:"none", borderTopWidth:0, borderTopStyle:"solid", borderTopColor:"transparent", borderBottomWidth:0, borderBottomStyle:"solid", borderBottomColor:"transparent", borderLeftWidth:0, borderLeftStyle:"solid", borderLeftColor:"transparent", borderRightWidth:4, borderRightStyle:"solid", borderRightColor:"transparent", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, fontSize:13, fontWeight:600, color:"rgba(3,22,50,0.6)", textTransform:"uppercase", letterSpacing:"0.1em", textAlign:"left", transition:"all 0.2s" },
  // Minimized: the item is just its icon, centred in the rail. The right-edge
  // marker still shows which page you are on.
  sideItemMin: { justifyContent:"center", padding:"14px 0", gap:0 },
  sideItemActive: { color:T.color.secondary, borderRightColor:T.color.secondary, background:"rgba(255,255,255,0.5)" },
  sideIcon: { display:"flex", alignItems:"center", flexShrink:0 },
  // The arrow on Lessons: down while its lessons are folded away, up while they show.
  sideChevron: { display:"flex", marginLeft:"auto", opacity:0.7, transition:"transform 0.2s" },
  sideChevronOpen: { transform:"rotate(180deg)" },
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
  profileBtn: { position:"relative", display:"flex", alignItems:"center", justifyContent:"center", padding:0, background:"transparent", border:"none", borderRadius:"50%", cursor:"pointer" },
  // The status check's alert: a dot on the avatar, and a mark on the menu's
  // Status line, while a check has failed or couldn't run.
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
  // cardWrap's 20px margin and the 110px belowCard well — is part of that
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
  //
  // minHeight 300 is the view at its smallest: the card at its 170 floor, its
  // 20px margin and the 110px well. At 0 the area could get shorter than
  // that, and what didn't fit was cut off with no way to reach it — the
  // container type turns overflow into paint that nothing can scroll to. At
  // 300 the area stops there and mainInner scrolls instead.
  cardArea: { position:"relative", flex:1, minHeight:300, containerType:"inline-size", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"safe center" },
  // Mirrors what sits below the card, less the chrome that already sits above
  // cardArea, so the card's own midpoint lands on the window's midpoint:
  //
  //   below the card   110 (belowCard) + 20 (cardWrap marginBottom) = 130
  //   above cardArea   100 (top bar + sub-toolbar + mainInner padTop)
  //   below cardArea    16 (mainInner padBottom)
  //   spacer = 130 + 16 - 100 = 46
  //
  // (It was 106 while the well was 170. The notes below were measured then;
  // at 46 the spacer takes a smaller share of a squeeze, so it bottoms out
  // later, not sooner.)
  //
  // `0 2 46px` and not a fixed height: it must give its space up first when
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
  // spacer stays 46 and cardArea's `safe center` places the card, so resting
  // geometry at every window height is untouched.
  cardTopSpacer: { flex:"0 2 46px", minHeight:0, width:"100%", pointerEvents:"none" },
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
  // The turn-back arrow mirrors the pencil, in the top-left corner.
  cardTurnBtn: { position:"absolute", top:14, left:14, zIndex:5 },

  // ── Big icon-button actions: AGAIN / GOT IT ───────────────────────
  // The button itself is a borderless flex column. The colored 80×80
  // box wraps the SVG, and the uppercase label sits below it.
  // ── Rectangular action buttons: AGAIN / GOT IT ─────────────────────
  unsavedNotice: { fontSize:11, fontFamily:T.font.sans, fontWeight:600, color:T.color.secondary, whiteSpace:"nowrap", marginRight:12 },
  // In the error red: the answer was right but now counts as a miss.
  reviewMarkNotice: { fontSize:11, fontFamily:T.font.sans, fontWeight:600, color:T.color.error, whiteSpace:"nowrap", marginRight:12 },
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
  topBarLeft: { display:"flex", alignItems:"center", gap:12, flex:1, minWidth:0 },
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
  chipToggleA: { background:T.color.primary, color:T.color.onPrimary, borderColor:T.color.primary, fontWeight:600 },
  // Sits inside the scrolling chip row, so it must not wrap on its own either.
  typeGroup: { display:"flex", gap:2, padding:3, background:T.color.surfaceLow, borderRadius:T.radius.md, flexShrink:0 },
  settingsWrap: { position:"relative", flexShrink:0 },
  gearBtn: { width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", padding:0, border:"1px solid rgba(3,22,50,0.08)", borderRadius:T.radius.full, background:"transparent", color:T.color.onSurfaceVariant, cursor:"pointer", transition:"all 0.15s" },
  gearBtnA: { background:T.color.surfaceLowest, color:T.color.primary, borderColor:"rgba(3,22,50,0.22)", boxShadow:T.shadow.focus },
  settingsMenu: { position:"absolute", top:"calc(100% + 10px)", right:0, width:344, background:T.color.surfaceLowest, borderRadius:T.radius.xl, border:"1px solid rgba(3,22,50,0.08)", boxShadow:"0 20px 60px rgba(3,22,50,0.15)", padding:"6px 0", zIndex:40, fontFamily:T.font.sans },
  settingsSec: { padding:"14px 18px" },
  settingsSecRule: { borderTop:"1px solid rgba(3,22,50,0.07)" },
  settingsSeg: { display:"flex", gap:2, padding:3, background:T.color.surfaceLow, borderRadius:T.radius.md },
  settingsSegBtn: { flex:"1 1 auto", whiteSpace:"nowrap" },
  settingsCap: { fontSize:10, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"rgba(68,71,77,0.78)", marginBottom:8 },
  settingsRow: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, width:"100%", padding:"7px 0", border:"none", background:"transparent", cursor:"pointer", fontFamily:T.font.sans, textAlign:"left" },
  settingsLabel: { fontSize:13, fontWeight:600, color:T.color.primary },
  switchTrack: { position:"relative", display:"block", width:34, height:20, flexShrink:0, borderRadius:T.radius.full, background:T.color.surfaceHighest, transition:"background 0.15s" },
  switchTrackOn: { background:T.color.primary },
  switchKnob: { display:"block", position:"absolute", top:3, left:3, width:14, height:14, borderRadius:"50%", background:"#fff", boxShadow:"0 1px 3px rgba(3,22,50,0.25)", transition:"left 0.15s" },
  switchKnobOn: { left:17 },
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
  // Sized to the TALLEST common thing that goes here. That was a wrong graded
  // answer at 170 — result banner, Continue and the links row stacked — and
  // the 170 was taken from the card on every short window. With the result
  // and Continue on one line the tallest is the typed-answer box plus Show
  // answer, about 82, and a links row that wraps to two lines, about 107.
  // Anything less and the card shifts when that state appears.
  belowCard: { width:"100%", maxWidth:600, minHeight:110, flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-start" },
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
  cardInstruction: { fontSize:"clamp(12px, 4.6cqh, 15px)", textAlign:"center", fontWeight:500, fontStyle:"italic", color:T.color.onSurfaceVariant, fontFamily:T.font.sans, lineHeight:1.35, maxWidth:"34em", margin:"0 auto 14px", padding:"0 12px" },
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
  lessonGroupHeading: { fontSize:20, fontWeight:600, color:T.color.primary, fontFamily:T.font.serif, margin:"32px 0 14px" },
  lessonGroupToggle: { display:"flex", alignItems:"center", gap:10, padding:0, border:"none", background:"transparent", cursor:"pointer", fontSize:20, fontWeight:600, color:T.color.primary, fontFamily:T.font.serif, margin:"32px 0 14px", textAlign:"left" },
  lessonGroupChevron: { display:"flex", opacity:0.6, transition:"transform 0.2s" },
  lessonCard: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"20px 24px", marginBottom:12, boxShadow:T.shadow.card, maxWidth:720 },
  lessonHead: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16 },
  lessonTitle: { fontSize:18, fontFamily:T.font.serif, color:T.color.onSurface, marginBottom:4 },
  lessonSub: { fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  lessonMeta: { fontSize:11, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, marginTop:14, textTransform:"uppercase", letterSpacing:"0.06em" },
  lessonAddBtn: { padding:"9px 18px", border:"none", borderRadius:T.radius.md, background:T.color.primary, color:"#fff", fontSize:12, fontWeight:600, fontFamily:T.font.sans, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 },
  lessonSwitchRow: { display:"flex", alignItems:"center", gap:12, marginTop:14, flexWrap:"wrap" },
  lessonSwitch: { display:"inline-flex", alignItems:"center", gap:8, padding:0, border:"none", background:"transparent", cursor:"pointer", fontSize:12, fontWeight:600, fontFamily:T.font.sans, color:T.color.onSurface, whiteSpace:"nowrap" },
  switchTrack: { position:"relative", width:30, height:18, borderRadius:T.radius.full, background:T.color.surfaceHighest, transition:"background 0.15s", flexShrink:0 },
  switchTrackOn: { background:T.color.primary },
  switchKnob: { display:"block", position:"absolute", top:2, left:2, width:14, height:14, borderRadius:"50%", background:T.color.surfaceLowest, boxShadow:"0 1px 2px rgba(3,22,50,0.2)", transition:"left 0.15s" },
  switchKnobOn: { left:14 },
  lessonSwitchNote: { fontSize:12, color:T.color.onSurfaceVariant, fontFamily:T.font.sans },
  lessonSwitchFailed: { color:T.color.error },
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
  // ── Stats layout: metric cards, then the all-cards bar ─────────────
  typeBarWrap: { height:4, borderRadius:2, background:"rgba(3,22,50,0.07)", marginTop:10, overflow:"hidden" },
  typeBar: { height:"100%", borderRadius:2, transition:"width 300ms ease" },
  statsRow3: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 },
  statsRow2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 },
  metricCard: { background:T.color.surfaceLow, borderRadius:T.radius.xl, padding:"22px 24px" },
  metricLabel: { fontSize:11, fontFamily:T.font.sans, fontWeight:600, color:T.color.onSurfaceVariant, textTransform:"uppercase", letterSpacing:"0.04em", marginBottom:6 },
  metricVal: { fontSize:32, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary, lineHeight:1.1 },
  metricUnit: { fontSize:18, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary },
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
  cahierNotice: { display:"flex", alignItems:"center", gap:12, margin:"0 24px 4px", padding:"10px 14px", borderRadius:10,
    background:T.color.surfaceHigh, color:T.color.onSurface, fontFamily:T.font.sans, fontSize:13, lineHeight:1.4 },
  cahierDismiss: { marginLeft:"auto", border:"none", background:"transparent", cursor:"pointer", color:T.color.onSurfaceVariant, fontSize:13, padding:4 },
  finishLine: { marginTop:14, paddingTop:14, borderTop:"1px solid rgba(3,22,50,0.06)", fontSize:14, fontFamily:T.font.sans, color:T.color.primary },
  statsFootnote: { fontSize:12, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, margin:"12px 0 0", lineHeight:1.5 },
  statsSectionTitle: { fontSize:18, fontFamily:T.font.serif, fontWeight:600, color:T.color.primary, margin:"0 0 4px" },
  statsSectionSub: { fontSize:13, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, margin:"0 0 14px" },
  resetBtn: { display:"block", width:"100%", padding:"13px", border:"none", borderRadius:T.radius.md, background:"transparent", color:T.color.secondary, fontSize:13, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, marginTop:24 },
  // Legacy stats styles (kept to avoid crashes if any references remain)
  bento: { display:"grid", gridTemplateColumns:"repeat(12, minmax(0, 1fr))", gap:24, marginBottom:32 },
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
  // sits beside the result on its first row. It used to be four widths
  // stacked: card 600, banner 520, links as centred text, Continue pushed
  // right in a 480 row. The links, or a dispute's status, span the row below.
  typeFeedback: { width:"100%", maxWidth:420, alignSelf:"center", display:"grid", gridTemplateColumns:"1fr auto", alignItems:"center", gap:10 },
  typeCorrect: { textAlign:"center", padding:"13px 14px", background:"#dcece5", color:"#1f5446", borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  typeClose: { textAlign:"center", padding:"13px 14px", background:T.color.surfaceHigh, color:T.color.primary, borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  typeRevealed: { textAlign:"center", padding:"13px 14px", background:T.color.surfaceHigh, color:T.color.primary, borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  typeWrong: { textAlign:"center", padding:"13px 14px", background:T.color.errorContainer, color:T.color.onErrorContainer, borderRadius:T.radius.md, fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  // Links at either end of the column, their text on its edges.
  typeLinksRow: { gridColumn:"1 / -1", display:"flex", alignItems:"center", justifyContent:"center", flexWrap:"wrap", columnGap:32, rowGap:4, minHeight:24, fontFamily:T.font.sans },
  typeLink: { padding:"4px 0", background:"transparent", border:"none", color:T.color.secondary, fontSize:12, cursor:"pointer", fontFamily:T.font.sans, fontWeight:600, textDecoration:"underline", textUnderlineOffset:3 },
  typeLinkMuted: { color:T.color.onSurfaceVariant, fontWeight:500, opacity:0.8 },
  typeBtnRow: { display:"flex", gap:12, marginTop:8 },
  feedbackRow: { gridColumn:"1 / -1", textAlign:"center", fontFamily:T.font.sans, fontSize:12 },
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
  fbLogSection: { margin:0, padding:"18px 0 2px", fontSize:13, fontWeight:600, fontFamily:T.font.sans, color:T.color.onSurfaceVariant, letterSpacing:"0.02em" },
  fbLogSectionEmpty: { fontSize:14, color:T.color.onSurfaceVariant, padding:"10px 0 14px", borderBottom:"1px solid rgba(3,22,50,0.08)" },
  fbReview: { marginTop:12, padding:"12px 14px", borderRadius:T.radius.md, border:"1px solid rgba(3,22,50,0.08)", fontFamily:T.font.sans },
  fbReviewLabel: { fontSize:13, fontWeight:600 },
  fbReviewText: { fontSize:15, lineHeight:1.5, color:T.color.onSurface, marginTop:4 },
  fbReviewMuted: { fontSize:14, color:T.color.onSurfaceVariant },
  fbReviewDone: { fontSize:14, color:T.color.onSurfaceVariant, overflowWrap:"anywhere" },
  fbReviewFix: { display:"grid", gridTemplateColumns:"auto minmax(0, 1fr)", columnGap:10, rowGap:4, marginTop:10, padding:"8px 10px", background:T.color.surfaceLow, borderRadius:T.radius.md, fontSize:15, lineHeight:1.5 },
  fbReviewFixLabel: { fontSize:13, color:T.color.onSurfaceVariant, lineHeight:"22.5px" },
  fbReviewFixText: { color:T.color.onSurfaceVariant, overflowWrap:"anywhere" },
  fbReviewActions: { display:"flex", gap:8, marginTop:12 },
  fbReviewPrimary: { padding:"7px 16px", background:T.gradient.ink, color:T.color.onPrimary, border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:13, fontWeight:600, fontFamily:T.font.sans },
  fbReviewBtn: { padding:"7px 14px", background:"transparent", color:T.color.onSurfaceVariant, border:"1px solid rgba(3,22,50,0.15)", borderRadius:T.radius.md, cursor:"pointer", fontSize:13, fontWeight:500, fontFamily:T.font.sans },
  fbReviewLink: { padding:0, background:"none", border:"none", color:T.color.primary, textDecoration:"underline", cursor:"pointer", fontSize:13, fontFamily:T.font.sans },
  fbReviewError: { fontSize:13, color:T.color.error, marginTop:8 },
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

