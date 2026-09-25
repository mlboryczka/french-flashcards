// Whether a new card is one the deck already has, written another way — so the
// linked cahier adds a class date to the card the student has instead of a
// second copy of it ("gratuit" and "gratuit (adj)", "le cas" and "un cas").
// Pure, and shared by the sync and its tests.
//
// Deliberately narrow, because a wrong match loses a real card. The French
// has to be the same apart from things that never change the meaning:
// capitals, spacing, a trailing full stop, question mark or ellipsis, a hyphen
// or a space ("sans-abris" / "sans abris"), an article of the same gender and
// number (le/un, la/une, les/des), a feminine or plural marker ("attirant(e)"),
// or a grammar label in brackets ("(adj)", "(adv)", "(subj)", "(imparfait)").
// Accents are kept — ou/où, sur/sûr, pécher/pêcher are different words — and
// so is every other bracket: "(fam)", "(plante)", "(politique)" or an English
// gloss can be the very thing that tells two meanings apart, and cards split
// by meaning were split on purpose. The same gender rule keeps "la poste" (the
// post office) apart from "le poste" (a job).
//
// And the English has to agree: at least one word of substance in common. A
// label can hide a different word with the same spelling — "fin" (the end)
// beside "fin (adj)" (thin) — and the English is what tells them apart.

const LABELS = /\((?:adj|adjectif|adv|adverbe|subj|subjonctif|imparfait)\.?\)/gi;
const ARTICLE = { un: "le", une: "la", des: "les" };

export function sameCardKey(front) {
  let s = String(front ?? "").normalize("NFC").toLowerCase().replace(/[’`]/g, "'");
  s = s.replace(LABELS, " ");
  // A feminine or plural marker on a word: attirant(e), un(e), ami(e)s.
  s = s.replace(/([a-zà-ÿ])\((?:e|s|es)\)/g, "$1");
  s = s.replace(/-/g, " ");
  s = s.replace(/[\s.?!…]+$/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(un|une|des) /, (m, a) => `${ARTICLE[a]} `);
  return s;
}

const STOP = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "by", "is", "are", "be",
  "and", "or", "but", "it", "its", "this", "that", "one", "some", "someone", "something",
  "adj", "adv", "noun", "verb", "etc",
]);
const words = (text) =>
  new Set(String(text ?? "").toLowerCase().split(/[^a-z']+/).filter((w) => w.length >= 3 && !STOP.has(w)));

export function sameMeaning(backA, backB) {
  const a = words(backA);
  const b = words(backB);
  if (a.size === 0 || b.size === 0) return false;
  for (const w of a) if (b.has(w)) return true;
  return false;
}

// The card in `byKey` (sameCardKey -> cards) that `card` is another spelling
// of, or null.
export function findSameCard(card, byKey) {
  const candidates = byKey.get(sameCardKey(card.front)) || [];
  return candidates.find((c) => sameMeaning(c.back, card.back)) || null;
}
