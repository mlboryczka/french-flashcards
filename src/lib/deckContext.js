// Picking the slice of the deck that is relevant to a tutor question.
//
// The tutor used to be sent `deckFronts.slice(0, 60)` — sixty French strings
// chosen by array position, with no backs and no history. As duplicate
// detection on a deck in the thousands that is a lottery, and as context it is
// nothing. Everything needed is already in the browser: useUserDeck shapes
// every row with its back, its lapses and its last result.
//
// Matching is a filter over an array already in memory — no API call, no
// embeddings, no index. The question is short and the deck is a few thousand
// rows, so a scan per question is far cheaper than the request it rides on.

import { cleanFrenchPrompt, cleanEnglishPrompt, dropFinalPeriod } from "./cardText.js";

// Function words carry no signal and match everything. English and French
// together, since a question mixes both ("what does chouette mean"). Checked
// against the accent-folded form too, so "où" is as dead as "ou".
const STOP = new Set([
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "do", "does", "did",
  "how", "what", "when", "where", "which", "who", "why", "can", "could",
  "would", "should", "i", "you", "it", "to", "of", "in", "on", "for", "and",
  "or", "but", "with", "say", "says", "said", "mean", "means", "meaning",
  "use", "uses", "using", "used", "difference", "between", "my", "me",
  "there", "this", "that", "these", "those", "some", "any", "not", "no",
  // French
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "est",
  "sont", "que", "qui", "quoi", "pour", "avec", "dans", "sur", "je", "tu",
  "il", "elle", "on", "nous", "vous", "ils", "elles", "ce", "cette", "ces",
  "au", "aux", "en", "ne", "pas", "se", "sa", "son", "ses",
  // What an apostrophe leaves behind once elision is split off: qu'il, jusqu'à.
  "qu", "jusqu", "lorsqu", "puisqu",
]);

// Accents and ligatures off. Learners on an English keyboard type "ecole" and
// "soeur", and a match that needs the accent finds nothing for them.
export function fold(word) {
  return String(word || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae");
}

// Split on anything that isn't a letter. Accented letters and the ligatures
// œ/æ are letters — `sœur` used to fall apart into "s" and "ur". Apostrophes
// split too, straight or curly, so the elided article comes off and "l'école"
// is the word "école" (the "l" is then too short to count). Both the question
// and the card go through this, so "aujourd'hui" splitting in two still matches
// itself.
function words(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFC")
    .split(/[^a-zà-öø-ÿœæ]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && !STOP.has(fold(w)));
}

/**
 * Cards in the deck that relate to what was just asked.
 *
 * Scored by shared content words. A hit on the French side outweighs one on
 * the English: if the learner typed a French word, the card carrying that word
 * is the one they mean, whereas a shared English word is often incidental ("to
 * go" matches hundreds of backs). An exact French hit beats one that only
 * matches with the accents off, since `à` and `a`, `sale` and `salé` are
 * different words — but the unaccented match still counts, because that is
 * how most learners type.
 *
 * @param {string} question   what the learner typed
 * @param {Array}  cards      shaped deck rows from useUserDeck ({ f, b, ... })
 * @param {number} limit      how many to return
 * @returns {Array<{front: string, back: string}>}
 */
export function findRelatedCards(question, cards, limit = 8) {
  const askedWords = words(question);
  if (!askedWords.length || !Array.isArray(cards)) return [];
  const asked = new Set(askedWords);
  const askedFolded = new Set(askedWords.map(fold));

  const scored = [];
  for (const c of cards) {
    if (!c?.f) continue;
    let score = 0;
    for (const w of words(c.f)) {
      if (asked.has(w)) score += 3;
      else if (askedFolded.has(fold(w))) score += 2;
    }
    for (const w of words(c.b)) if (asked.has(w) || askedFolded.has(fold(w))) score += 1;
    if (score > 0) scored.push({ card: c, score });
  }

  // Highest score first; ties go to the card seen in more lessons, which is
  // the deck's own signal for how central a word is.
  scored.sort((a, b) => b.score - a.score || (b.card.freq || 0) - (a.card.freq || 0));

  return scored.slice(0, limit).map(({ card }) => ({ front: card.f, back: card.b }));
}

/**
 * The cards most recently got wrong. `last_answer_correct` is null on rows
 * that predate FSRS and false only on a real miss, so the strict comparison
 * matters — `!c.last_answer_correct` would sweep in every unreviewed card.
 *
 * @param {Array}  cards  shaped deck rows from useUserDeck
 * @param {number} limit  how many to return
 * @returns {Array<{front: string, back: string}>}
 */
export function recentMisses(cards, limit = 6) {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter((c) => c?.last_answer_correct === false && c.f)
    .sort((a, b) => new Date(b.last_review || 0) - new Date(a.last_review || 0))
    .slice(0, limit)
    .map((c) => ({ front: c.f, back: c.b }));
}

const MISS_WINDOW_DAYS = 30;

/**
 * Misses worth telling the tutor about for THIS question: recent, and sharing
 * a word with the question or the card on screen.
 *
 * Sending every miss on every turn, under a prompt that says "use it", was an
 * invitation to answer a question about amener with "by the way, you keep
 * missing la colline". A miss from last spring is not what they keep getting
 * wrong either.
 */
export function relevantMisses({ question, currentCard, cards, now = Date.now(), limit = 6 }) {
  if (!Array.isArray(cards)) return [];
  const topic = new Set(
    words(`${question || ""} ${currentCard?.f || ""} ${currentCard?.b || ""}`).map(fold)
  );
  if (!topic.size) return [];
  const since = now - MISS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return cards
    .filter((c) =>
      c?.last_answer_correct === false && c.f &&
      c.row_id !== currentCard?.row_id &&
      c.last_review && new Date(c.last_review).getTime() >= since &&
      words(`${c.f} ${c.b}`).some((w) => topic.has(fold(w)))
    )
    .sort((a, b) => new Date(b.last_review) - new Date(a.last_review))
    .slice(0, limit)
    .map((c) => ({ front: c.f, back: c.b }));
}

/**
 * What the card on screen is asking, as the card face shows it: the French
 * with its gloss stripped, or the English with any note naming the French form
 * stripped. The tutor's header shows this, never the raw front — on an
 * English-prompt card the front IS the answer.
 */
export function cardPrompt(card) {
  if (!card) return "";
  return dropFinalPeriod(
    card.shownDir === "en" ? cleanEnglishPrompt(card.b) : cleanFrenchPrompt(card.f, card.b)
  );
}

/** The side the student is being asked for. */
export function cardAnswer(card) {
  if (!card) return "";
  return dropFinalPeriod(card.shownDir === "en" ? card.f : card.b);
}

/**
 * Assemble everything the tutor endpoint is given about the learner's deck.
 * Returns undefined when there is nothing worth sending, so the request body
 * stays clean rather than carrying three empty arrays.
 *
 * @param {object} opts
 * @param {string} opts.question          what the learner typed
 * @param {string} [opts.previousQuestion] their question before this one, for
 *   follow-ups with no content words of their own ("and the feminine?")
 * @param {Array}  opts.cards             shaped deck rows
 * @param {object} [opts.currentCard]     the card on screen, with the study
 *   view's live state: `answered`, and after a typed answer `typed` and `result`
 */
export function buildTutorContext({ question, previousQuestion, cards, currentCard }) {
  const ctx = {};

  if (currentCard?.f) {
    ctx.currentCard = {
      prompt: cardPrompt(currentCard),
      answer: cardAnswer(currentCard),
      // Until the answer has been shown, the tutor must not be the thing that
      // shows it: a recall FSRS records after the tutor said the word is a
      // recall that never happened.
      answered: !!currentCard.answered,
      // What happened THIS time, from the study view — not from the row. The
      // row's last_answer_correct is the previous session's result, and
      // reading it as "they just got this wrong" told the tutor that about
      // every lapse card before the student had answered it.
      ...(currentCard.result ? { result: currentCard.result } : null),
      ...(currentCard.typed ? { typed: String(currentCard.typed).slice(0, 200) } : null),
      missedLastTime: currentCard.last_answer_correct === false,
    };
  }

  let related = findRelatedCards(question, cards);
  if (!related.length && previousQuestion) related = findRelatedCards(previousQuestion, cards);
  // "What's the French for a hill?" matches the card being asked, and the
  // related list would hand over its answer beside the instruction not to.
  if (currentCard?.f && !currentCard.answered) {
    related = related.filter((c) => c.front !== currentCard.f);
  }
  if (related.length) ctx.relatedCards = related;

  const misses = relevantMisses({ question, currentCard, cards });
  if (misses.length) ctx.recentMisses = misses;

  return Object.keys(ctx).length ? ctx : undefined;
}
