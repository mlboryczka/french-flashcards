// Finding cards that are secretly two cards.
//
// "les frais" is a plural noun meaning costs. "frais" is an adjective meaning
// fresh. They share a spelling, so the cahier parser sometimes emits one card
// whose back is "the costs; the expenses; fresh" — three glosses for two
// unrelated headwords. That card can't be studied (there is no single right
// answer) and FSRS can't schedule it (there is no single "did you recall it").
//
// This is the cheap first pass: it runs over the whole deck in the browser and
// shortlists the cards worth sending to Claude, so a 9,000-card deck costs one
// scan rather than 9,000 API calls. It deliberately over-selects — deciding
// whether two glosses are really two headwords needs judgement, and that
// happens server-side in /api/split-senses.

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "then", "so",
  "it", "its", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their",
  "not", "no", "do", "does", "did",
  "from", "as", "about", "into", "out", "up", "down",
  "one", "someone", "something", "oneself",
]);

// Divergence threshold, matching the parser's own polysemy splitter.
const THRESHOLD = 0.3;

function contentWords(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^\w\s']/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
  );
}

function similarity(a, b) {
  const sa = contentWords(a);
  const sb = contentWords(b);
  if (sa.size === 0 || sb.size === 0) return 1; // can't judge — assume same
  let hits = 0;
  for (const w of sa) if (sb.has(w)) hits++;
  return hits / (sa.size + sb.size - hits);
}

// Candidate glosses on the back. Semicolons and slashes are the deck's two
// separator conventions; a comma only counts when every part is short, so
// "i wrote it correctly, except for the article" stays one gloss.
export function splitGlosses(back) {
  const text = String(back || "").trim();
  if (!text) return [];
  let parts = text.split(/\s*;\s*/);
  if (parts.length === 1) parts = text.split(/\s+\/\s+|\//);
  if (parts.length === 1) {
    const commas = text.split(/\s*,\s*/);
    if (
      commas.length > 1 &&
      commas.every((p) => p.trim().split(/\s+/).length <= 3)
    ) {
      parts = commas;
    }
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Rough part of speech from the shape of an English gloss. Two glosses with
// different parts of speech are almost never the same word — "the costs" and
// "fresh" can't both be one headword.
function posHint(gloss) {
  const g = gloss.toLowerCase().trim();
  if (/^to\s/.test(g)) return "verb";
  if (/^(a|an|the)\s/.test(g)) return "noun";
  return "other";
}

// True when the back holds glosses that look like different headwords rather
// than synonyms of one. This only shortlists — /api/split-senses decides.
//
// The two separators mean different things in this deck. A semicolon is used
// where senses were run together, so divergent parts are enough to flag it. A
// slash is the deck's near-synonym marker ("to unload / to discharge") and a
// short comma list is a gender pair ("gros, grosse"), so those are only
// suspicious when the parts aren't even the same part of speech.
export function looksMultiSense(card) {
  const back = card?.b ?? card?.back;
  const glosses = splitGlosses(back);
  if (glosses.length < 2) return false;

  const divergent = glosses.some((a, i) =>
    glosses.slice(i + 1).some((b) => similarity(a, b) < THRESHOLD)
  );
  if (!divergent) return false;

  if (/;/.test(String(back || ""))) return true;
  return new Set(glosses.map(posHint)).size > 1;
}

export function findMultiSenseCards(cards) {
  return (cards || []).filter(looksMultiSense);
}
