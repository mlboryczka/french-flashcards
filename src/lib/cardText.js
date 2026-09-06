// The French side of a card should be French.
//
// Cahier lines often carry an inline English gloss — "je suis allé (I went
// (passé composé))" — and the parser has sometimes kept that gloss on the
// front. When it does, the card hands you the answer before you've answered
// it, which is worse than useless: FSRS records a recall you never made.
//
// Rather than migrate thousands of existing rows (and risk mangling the ones
// that are fine), we strip the gloss at the moment the French side is used as
// a *prompt*. The stored row is untouched, and the answer side still shows
// everything.
//
// The test for "this is a gloss, not French" is overlap: if a parenthetical on
// the French side repeats a content word from the English side, it is giving
// the answer away. Grammar tags — (adj), (f), (pl), (passé composé) — are
// exempt, because they are legitimate disambiguators even when the English
// side happens to mention them too.

const GRAMMAR_TAG =
  /^(adj|adv|adje?ctif|n|nom|v|verbe?|f|m|fem|femin(in)?|masc(ulin)?|pl|plur(iel|al)?|sg|sing(ulier)?|nf|nm|inf|infinitif|pp|p\.p\.|part(icipe)?( passé)?|passé( composé)?|imparfait|futur|présent|conditionnel|subjonctif|impératif|fam|familier|litt|litteraire|littéraire)\.?$/i;

function contentWords(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3);
}

// Top-level "(...)" spans, tolerant of the unbalanced parentheses these
// malformed cards tend to have ("je suis allé (I went (passé)" never closes
// its outer group). An unclosed group runs to the end of the string.
function parentheticals(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")") {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          spans.push([start, i + 1]);
          start = -1;
        }
      }
    }
  }
  if (depth > 0 && start !== -1) spans.push([start, text.length]);
  return spans;
}

export function cleanFrenchPrompt(fr, en) {
  if (!fr || !en || !fr.includes("(")) return fr;

  const answerWords = new Set(contentWords(en));
  if (answerWords.size === 0) return fr;

  const spans = parentheticals(fr);
  let out = fr;
  let changed = false;

  // Right to left, so earlier spans keep their indices.
  for (let i = spans.length - 1; i >= 0; i--) {
    const [s, e] = spans[i];
    const inner = fr.slice(s + 1, e).replace(/[()]/g, "").trim();
    if (!inner || GRAMMAR_TAG.test(inner)) continue;
    if (!contentWords(inner).some((w) => answerWords.has(w))) continue;
    out = out.slice(0, s) + out.slice(e);
    changed = true;
  }

  if (!changed) return fr;
  // Tidy up the hole we just left, and any parenthesis orphaned by it.
  const tidied = out.replace(/\s{2,}/g, " ").replace(/\s+([,;.!?])/g, "$1").trim();
  return tidied || fr;
}
