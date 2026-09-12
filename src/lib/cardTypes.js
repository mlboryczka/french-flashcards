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

// Is this card ABOUT French, rather than a piece of French?
//
// The stored category can't answer that. The cahier parser assigns it by
// POSITION — everything after the "Prononciation Grammaire" heading becomes
// G — so that bucket holds whatever the teacher happened to write in the
// grammar section, including plain vocabulary ("mon copain") and example
// sentences ("le seul projet que j'ai vu"). Trusting the tag put those in the
// Grammar filter. The category is a section marker, not a card type.
//
// So grammar is decided by what the card looks like. Every pattern below was
// derived from the 117 cards in this deck's grammar and pronunciation
// sections; see tests/suites/logic.mjs, which runs the whole corpus through it.

// Bare "(adj)" / "(adv)" / "(pp: agi)" are part-of-speech tags on ordinary
// vocabulary — hundreds of cards carry them, and they mean nothing here.
const POS_TAG = /\((?:adj|adv|n|nom|v|f|m|pl|pp)[^)]*\)/gi;

// Metalinguistic vocabulary. "accord" needs its grammar sense, or "se mettre
// d'accord" reads as grammar; "son" is left out entirely because the sound
// term is indistinguishable from the possessive, and phonetic cards are caught
// by the brace rule anyway.
const GRAMMAR_TERM =
  /\b(pronoms?|toniques?|articles?|partitifs?|accords? (?:du|des|avec)|participes?|cod|coi|relatifs?|sujet|négation|liaison|élision|conjugaison|imparfait|conditionnel|subjonctif|indicatif|impératif|plus-que-parfait|passé composé|présent|futur|auxiliaire|préposition|infinitif|placement|prononcé|prononciation|voie passive)\b/i;

// Pattern templates: "il faut + infinitif", "pas aussi … que", "cela = ça".
// An ellipsis only marks a template when something follows it — a trailing "…"
// is just an unfinished phrase ("c'est pour ça que …").
const FORMULA = /→|\s\+\s|(?:…|\.\.\.)\s*[a-zà-ÿ]|\s=\s|\bvs\b/i;

// Phonetic respelling: "du riz {ri}", "complet / complète … {complèt}".
const PHONETIC = /\{[^}]+\}/;

// A French front carrying an English aside is describing usage, not naming a
// thing: "dans 10 minutes (from now) / en 10 minutes (within)".
const ENGLISH_ASIDE =
  /\((?:with|from|within|opinion|in mind|action|state|subject|direct|indirect)[^)]*\)/i;

// A back that explains a distinction instead of translating one thing.
const EXPLAINS =
  /\bvs\b|pronounced|silent|(?:participle|pp) agrees|agrees with|\bmasc:|\bfem:|\baction:|\bstate:|order of|only used|contraction|rhymes|negation/i;

export function isGrammarCard(card) {
  const front = String(card?.f ?? "");
  const back = String(card?.b ?? "");
  if (front.includes("→")) return true; // conjugation drill, definitive
  if (PHONETIC.test(front) || PHONETIC.test(back)) return true;
  const f = front.replace(POS_TAG, " ");
  return (
    GRAMMAR_TERM.test(f) ||
    FORMULA.test(f) ||
    ENGLISH_ASIDE.test(front) ||
    EXPLAINS.test(back) ||
    /\s\+\s/.test(back)
  );
}

// Memoised per card OBJECT, because the callers ask the same question about
// the same cards over and over: the Stats page classifies the whole deck three
// times per render (once per type), the Hardest Cards list asks three times per
// row, and buildSession filters the deck by type on every session. On a
// production-size deck of 8,703 cards those three Stats passes measured 29ms,
// repeated on every render while Stats is on screen.
//
// A WeakMap is safe here only because cards are never mutated in place: a card
// row is replaced wholesale, so an edited card is a NEW object and gets a new
// answer. Copies (`{...card, _bucket}`) simply miss and are classified once.
// Keyed weakly, so nothing is held alive for the cache's sake.
const CACHE = new WeakMap();

export function classifyCard(card) {
  if (!card) return "phrase";

  const hit = CACHE.get(card);
  if (hit !== undefined) return hit;
  const type = classify(card);
  CACHE.set(card, type);
  return type;
}

function classify(card) {
  if (isGrammarCard(card)) return "grammar";

  // An expression is a phrase by definition, however short — "au début" is
  // two small words but you learn it whole, as a turn of phrase.
  if (card.cat === "expr") return "phrase";

  const all = tokens(frenchSide(card));
  // A subject or a clause marker means this is a sentence, not a headword.
  if (all.some((t) => CLAUSE_WORDS.has(t.replace(/['’]$/, "")))) return "phrase";

  const units = all.filter((t) => !GLUE.has(t.replace(/['’]$/, "")));
  return units.length <= MAX_CONCEPT_UNITS ? "vocab" : "phrase";
}

