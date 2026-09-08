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

// Function words carry no signal and match everything. English and French
// together, since a question mixes both ("what does chouette mean").
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
]);

// Split on anything that isn't a letter or an apostrophe. Accented letters are
// kept: `à` and `a` are different words in French and folding them would match
// the wrong things.
function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/**
 * Cards in the deck that relate to what was just asked.
 *
 * Scored by shared content words. A hit on the French side counts double: if
 * the learner typed a French word, the card carrying that word is the one they
 * mean, whereas a shared English word is often incidental ("to go" matches
 * hundreds of backs).
 *
 * @param {string} question   what the learner typed
 * @param {Array}  cards      shaped deck rows from useUserDeck ({ f, b, ... })
 * @param {number} limit      how many to return
 * @returns {Array<{front: string, back: string}>}
 */
export function findRelatedCards(question, cards, limit = 8) {
  const asked = new Set(words(question));
  if (!asked.size || !Array.isArray(cards)) return [];

  const scored = [];
  for (const c of cards) {
    if (!c?.f) continue;
    let score = 0;
    for (const w of words(c.f)) if (asked.has(w)) score += 2;
    for (const w of words(c.b)) if (asked.has(w)) score += 1;
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

/**
 * Assemble everything the tutor endpoint is given about the learner's deck.
 * Returns undefined when there is nothing worth sending, so the request body
 * stays clean rather than carrying three empty arrays.
 *
 * @param {object} opts
 * @param {string} opts.question     what the learner typed
 * @param {Array}  opts.cards        shaped deck rows
 * @param {object} [opts.currentCard] the card on screen, if any
 */
export function buildTutorContext({ question, cards, currentCard }) {
  const ctx = {};

  if (currentCard?.f) {
    ctx.currentCard = {
      front: currentCard.f,
      back: currentCard.b,
      missed: currentCard.last_answer_correct === false,
    };
  }

  const related = findRelatedCards(question, cards);
  if (related.length) ctx.relatedCards = related;

  const misses = recentMisses(cards);
  if (misses.length) ctx.recentMisses = misses;

  return Object.keys(ctx).length ? ctx : undefined;
}
