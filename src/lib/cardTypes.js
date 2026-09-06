// Three-way card type: grammar, vocab, phrase.
//
// Storage keeps four category codes (V/E/G/P → vocab/expr/gram/pron) because
// that is what the cahier sections are. Those aren't the distinction you
// actually study by: the "vocab" section holds both single words and whole
// expressions, and gram/pron are both rules rather than translations.
//
//   grammar  a rule or a form to produce   ("aller (subjonctif) → ils/elles")
//   vocab    one word or one concept       ("une colline", "la patate douce")
//   phrase   a string of words             ("je n'ai jamais été aussi …")
//
// Vocab is a CONCEPT, not a token count: "la patate douce" is a sweet potato,
// "le chemin de fer" is a railway — one thing you learn, however many words
// French spells it with. What makes something a phrase is a clause: a subject,
// a conjugated verb, several ideas strung together.

export const CARD_TYPES = Object.freeze(["grammar", "vocab", "phrase"]);

export const TYPE_LABEL = Object.freeze({
  grammar: "Grammar",
  vocab: "Vocab",
  phrase: "Phrase",
});

export const TYPE_COLOR = Object.freeze({
  grammar: "#2f6f5e",
  vocab: "#9c4234",
  phrase: "#1a2b48",
});

// A concept can be several words long, but not many. Past this, it's a phrase.
const MAX_CONCEPT_UNITS = 3;

// Determiners, and the prepositions that glue a compound noun together
// ("chemin de fer", "machine à laver", "pomme de terre"). Neither adds a
// separate idea, so neither counts toward the concept's size.
const GLUE = new Set([
  "un", "une", "des", "le", "la", "les", "du", "de", "d", "l",
  "au", "aux", "à", "a", "en", "mon", "ma", "mes", "ton", "ta", "tes",
  "son", "sa", "ses", "ce", "cet", "cette", "ces", "notre", "votre", "leur",
  // Reflexive and infinitive markers: "se lever", "s'appeler".
  "se", "s",
]);

// A subject pronoun or a clause marker means there's a sentence here, not a
// headword. "il" is deliberately absent from GLUE for this reason.
const CLAUSE_WORDS = new Set([
  "je", "j", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  "ça", "ca", "c", "ce", "qui", "que", "qu", "quoi", "dont", "où",
  "comment", "pourquoi", "quand", "si", "ne", "n", "y",
]);

// "(adj)", "(f)", "(passé composé)" and friends — annotation, not content.
const PAREN = /\([^)]*\)?/g;

function frenchSide(card) {
  if (!card) return "";
  // Conjugation drills store the prompt as "infinitive → person"; the French
  // being practised is on the back.
  if (typeof card.f === "string" && card.f.includes("→")) return card.b || "";
  return card.f || "";
}

// "gros, grosse" and "un vendeur / une vendeuse" are one headword listed in
// its variants, not several words. A comma only means that when every part is
// short — "Bonjour, comment ça va ?" is a real phrase.
function firstVariant(text) {
  const head = text.split(/\s*\/\s*/)[0];
  const commas = head.split(/\s*,\s*/);
  if (commas.length > 1 && commas.every((p) => p.trim().split(/\s+/).length <= 2)) {
    return commas[0];
  }
  return head;
}

function tokens(text) {
  return firstVariant(String(text || "").replace(PAREN, " "))
    // Elision binds to the next word: "l'eau", "s'appeler", "qu'il".
    .replace(/\b([a-zà-ÿ]{1,2})['’]/gi, "$1' ")
    .split(/[\s,;:!?.…]+/)
    .map((t) => t.replace(/^['’-]+|['’-]+$/g, "").toLowerCase())
    .filter(Boolean);
}

export function classifyCard(card) {
  if (!card) return "phrase";

  // Rules and drills, whatever they look like.
  if (card.cat === "gram" || card.cat === "pron") return "grammar";
  if (typeof card.f === "string" && card.f.includes("→")) return "grammar";

  // An expression is a phrase by definition, however short — "au début" is
  // two small words but you learn it whole, as a turn of phrase.
  if (card.cat === "expr") return "phrase";

  const all = tokens(frenchSide(card));
  // A subject or a clause marker means this is a sentence, not a headword.
  if (all.some((t) => CLAUSE_WORDS.has(t.replace(/['’]$/, "")))) return "phrase";

  const units = all.filter((t) => !GLUE.has(t.replace(/['’]$/, "")));
  return units.length <= MAX_CONCEPT_UNITS ? "vocab" : "phrase";
}

// Counts by type, in a fixed order so the UI never reorders between renders.
export function countByType(cards) {
  const counts = { grammar: 0, vocab: 0, phrase: 0 };
  for (const c of cards || []) counts[classifyCard(c)]++;
  return counts;
}
