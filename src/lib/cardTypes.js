// Three-way card type: grammar, word, phrase.
//
// Storage keeps four category codes (V/E/G/P → vocab/expr/gram/pron) because
// that is what the cahier sections are. Those aren't the distinction you
// actually study by: "vocab" holds both single words and multi-word
// expressions, and "gram"/"pron" are both rules rather than translations.
// This collapses them into the three types that describe what a card asks of
// you:
//
//   grammar  a rule or a conjugation to produce  (gram, pron, conjugation drills)
//   word     one French word to translate        (vocab, single content word)
//   phrase   several words together              (vocab/expr, multi-word)
//
// Word vs phrase is decided on the French side, after stripping the things
// that are attached to a word rather than part of the phrase: articles,
// grammar tags, glosses, and the "/" of a gender pair.

const TYPES = Object.freeze(["grammar", "word", "phrase"]);

export const TYPE_LABEL = Object.freeze({
  grammar: "Grammar",
  word: "Word",
  phrase: "Phrase",
});

export const TYPE_COLOR = Object.freeze({
  grammar: "#2f6f5e",
  word: "#9c4234",
  phrase: "#1a2b48",
});

export const CARD_TYPES = TYPES;

// Determiners and clitics that ride along with a headword and shouldn't make
// it count as a phrase. "l'" and "d'" are handled by the elision rule below.
const DETERMINERS = new Set([
  "un", "une", "des", "le", "la", "les", "du", "de", "d", "l",
  "au", "aux", "à", "a", "mon", "ma", "mes", "ton", "ta", "tes",
  "son", "sa", "ses", "ce", "cet", "cette", "ces",
  // Infinitive markers and reflexive pronouns: "se lever", "s'appeler",
  // "être en train de" is still a phrase because of its other content words.
  "se", "s", "ne", "n",
]);

// "(adj)", "(f)", "(passé composé)" and friends — annotation, not content.
const PAREN = /\([^)]*\)?/g;

function frenchSide(card) {
  if (!card) return "";
  // Grammar drills store the prompt as "infinitive → person"; the French being
  // practised is on the back.
  if (typeof card.f === "string" && card.f.includes("→")) return card.b || "";
  return card.f || "";
}

// Content tokens on the French side, ignoring determiners and annotations.
// "gros, grosse" and "un vendeur / une vendeuse" are one headword listed in
// its variants, not several words. A comma only means that when every part is
// short — "Bonjour, comment ça va ?" is a real phrase.
function firstVariant(text) {
  const slash = text.split(/\s*\/\s*/);
  const head = slash[0];
  const commas = head.split(/\s*,\s*/);
  if (commas.length > 1 && commas.every((part) => part.trim().split(/\s+/).length <= 2)) {
    return commas[0];
  }
  return head;
}

function contentTokens(text) {
  return firstVariant(String(text || "").replace(PAREN, " "))
    // Elision binds to the next word: "l'eau", "s'appeler", "qu'il".
    .replace(/\b([a-zà-ÿ]{1,2})['’]/gi, "$1' ")
    .split(/[\s,;:!?.…]+/)
    .map((t) => t.replace(/^['’-]+|['’-]+$/g, "").toLowerCase())
    .filter(Boolean)
    .filter((t) => !DETERMINERS.has(t.replace(/['’]$/, "")));
}

export function classifyCard(card) {
  if (!card) return "phrase";

  // Rules and drills, whatever they look like.
  if (card.cat === "gram" || card.cat === "pron") return "grammar";
  if (typeof card.f === "string" && card.f.includes("→")) return "grammar";

  // An expression is a phrase by definition, however short — "au début" is
  // two determiner-ish words but it is still something you learn whole.
  if (card.cat === "expr") return "phrase";

  // Everything else is a translation: one word, or more than one.
  return contentTokens(frenchSide(card)).length <= 1 ? "word" : "phrase";
}

// Counts by type, in a fixed order so the UI never reorders between renders.
export function countByType(cards) {
  const counts = { grammar: 0, word: 0, phrase: 0 };
  for (const c of cards || []) counts[classifyCard(c)]++;
  return counts;
}
