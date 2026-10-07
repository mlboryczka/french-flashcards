// Whether a new card is one the student already has, written another way.
// Pure, with no imports, so the server's card-writers, the lesson sync in the
// browser and the status checks all run the very same rule.
//
// Since 2026-10-06 every path that writes a card from the student's notes uses
// it: an upload (add or Replace), the linked notebook's sync, the merge inside
// one reading, and the lesson sync's "the student already has this card". The
// owner: "there should be NO duplicates from reuploading an updated cahier".
// Before that, the upload knew a card only by its exact French, and 73 cards
// in the owner's deck repeated another one.
//
// Two steps.
//
// 1. The sure rule (isSureMatch). The French has to be the same apart from
//    things that never change what is learnt, and the English has to agree.
//    sameCardKey below is where it started: capitals, spacing, a trailing
//    full stop, question mark or ellipsis, a hyphen or a space, an article of
//    the same gender and number (le/un, la/une, les/des), a feminine or
//    plural marker ("attirant(e)"), a grammar label ("(adj)", "(adv)",
//    "(subj)", "(imparfait)"), ’ against '. Each addition in sureKey fixes a
//    miss that was seen in a real deck:
//      œ as oe, and "..." as "…", anywhere in the front ("ma sœur");
//      a pronunciation respelling in braces ("un fils {fiss}");
//      the labels (m), (f) and (pl) ("des écouteurs (m)");
//      a bracket that only repeats the card's own English ("tout d'un coup
//      (suddenly; all at once)");
//      in a drill, "il" for "il/elle" and "que je" for "je".
//    English agrees when the two share a word of substance, or when it is
//    word for word the same once a/an/the/to are set aside, which is what
//    catches "so", "to go" and "it is". A drill's answer is French, so two
//    drills agree only when their answers are the same.
//    One change goes the other way: a final "!" is kept, because "Je pense !"
//    (I think so!) is not "je pense" (I think). Two fronts that differ only by
//    it are the same card when their English has the same words: "Rends-moi
//    mon livre !" (Give me my book back!) and "rends-moi mon livre" (give me
//    back my book).
//    Accents are kept (ou/où, sur/sûr), and so is any other bracket: "(fam)",
//    "(plante)" or a gloss can be what tells two meanings apart.
//
// 2. The near search (nearCandidates). Fixed rules loose enough to catch the
//    rest also join words that differ ("un état" and "l'État"), so near
//    look-alikes are only candidates: each is put to Claude as one yes/no
//    question, "the same card to learn, or different" (api/_lib/
//    sameCardQuestion.js). A near look-alike is: the same words once accents,
//    "ne", articles and brackets are set aside; one half of a list card
//    ("manquer" and "manquer / rater"; "japonais" and "japonais, japonaise");
//    brackets around a French word; one word more or fewer in a phrase of
//    three or more, with English agreeing; a number and its word; or a typo
//    of one or two letters, with English agreeing. On the owner's 63 groups of
//    repeated cards (2026-10-06) the two steps together reached all 63.

const LABELS = /\((?:adj|adjectif|adv|adverbe|subj|subjonctif|imparfait)\.?\)/gi;
const ARTICLE = { un: "le", une: "la", des: "les" };

// The original rule, kept as it was: the base the sure rule builds on.
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

// At least one word of substance in common.
export function sameMeaning(backA, backB) {
  const a = words(backA);
  const b = words(backB);
  if (a.size === 0 || b.size === 0) return false;
  for (const w of a) if (b.has(w)) return true;
  return false;
}

// ── English, compared ──────────────────────────────────────────────────────

const EN_STOP = new Set(["a", "an", "the", "to", "of", "is", "it", "be", "so", "and", "or", "for", "with", "in", "on", "at"]);
const enWords = (s) => String(s ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z']+/).filter(Boolean);
const enNorm = (s) => enWords(s).filter((w) => !["a", "an", "the", "to"].includes(w)).join(" ");
const glossWordsOf = (s) => new Set(enWords(s).filter((w) => w.length >= 3 && !EN_STOP.has(w)));
const tidyAnswer = (s) =>
  String(s ?? "").normalize("NFC").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").replace(/[\s.]+$/, "").trim();

export const isDrillFront = (front) => String(front ?? "").includes("→");

// The English of two cards agrees: a word of substance in common, or the same
// words in the same order once a/an/the/to are set aside ("so", "to go").
// Drills answer in French, so theirs must be the same answer.
export function englishAgrees(a, b) {
  if (isDrillFront(a?.front) || isDrillFront(b?.front)) return tidyAnswer(a?.back) === tidyAnswer(b?.back);
  if (sameMeaning(a?.back, b?.back)) return true;
  const na = enNorm(a?.back);
  return !!na && na === enNorm(b?.back);
}

// The same English words, in any order: "Give me my book back!" and "give me
// back my book". What lets a final "!" go.
export function sameWords(backA, backB) {
  const set = (s) => new Set(enWords(s).filter((w) => !["a", "an", "the"].includes(w)));
  const a = set(backA);
  const b = set(backB);
  if (a.size === 0 || a.size !== b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

// ── The sure rule ───────────────────────────────────────────────────────────

const GENDER_LABELS = /\((?:m|f|n|nm|nf|pl|m\/f|masc|fém|fem)\.?\)/gi;

// The French of a card as the sure rule compares it, and whether it ends in
// "!". `back` is needed because a bracket that only repeats the card's own
// English is set aside.
export function sureKey(front, back) {
  let s = String(front ?? "").normalize("NFC")
    .replace(/œ/g, "oe").replace(/Œ/g, "Oe").replace(/æ/g, "ae").replace(/Æ/g, "Ae")
    .replace(/\.\.\./g, "…");
  s = s.replace(/\{[^}]*\}/g, " ");
  s = s.replace(GENDER_LABELS, " ");
  const gloss = glossWordsOf(back);
  s = s.replace(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (m, inner) => {
    const w = enWords(inner).filter((x) => x.length >= 3 && !EN_STOP.has(x));
    return w.length && w.every((x) => gloss.has(x)) ? " " : m;
  });
  s = s.replace(/\s*…\s*/g, " ");
  const bang = /!$/.test(s.replace(/[\s.]+$/, ""));
  let k = sameCardKey(s);
  k = k
    .replace(/→ (?:que |qu')(je|j'|tu|nous|vous)$/, (m, p) => `→ ${p === "j'" ? "je" : p}`)
    .replace(/→ qu'(?:il\/elle|il|elle)$/, "→ il/elle")
    .replace(/→ qu'(?:ils\/elles|ils|elles)$/, "→ ils/elles")
    .replace(/→ (?:il|elle|on|il\/elle\/on)$/, "→ il/elle")
    .replace(/→ (?:ils|elles)$/, "→ ils/elles");
  return { key: k.replace(/\s+/g, " ").trim(), bang };
}

// Two cards are surely the same card to learn.
export function isSureMatch(a, b) {
  const pa = sureKey(a?.front, a?.back);
  const pb = sureKey(b?.front, b?.back);
  if (!pa.key || pa.key !== pb.key) return false;
  if (!englishAgrees(a, b)) return false;
  return pa.bang === pb.bang || sameWords(a?.back, b?.back);
}

// ── The near search ─────────────────────────────────────────────────────────

const stripAccents = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// The French with accents, "ne", articles, brackets, braces and punctuation
// set aside, and l'/d'/j'/qu' spelt out.
export function looseKey(front) {
  let s = String(front ?? "").normalize("NFC").toLowerCase().replace(/[’‘`]/g, "'").replace(/œ/g, "oe").replace(/æ/g, "ae");
  s = s.replace(/\{[^}]*\}/g, " ").replace(/\([^)]*\)/g, " ");
  s = stripAccents(s)
    .replace(/\bj'/g, "je ").replace(/\bn'/g, " ").replace(/\bne\b/g, " ")
    .replace(/\bl'/g, "le ").replace(/\bd'/g, "de ").replace(/\bqu'/g, "que ");
  return s.replace(/[^a-z0-9 ]+/g, " ").replace(/\b(?:le|la|les|un|une|des)\b/g, " ").replace(/\s+/g, " ").trim();
}

const looseKeepBrackets = (front) => looseKey(String(front ?? "").replace(/[()]/g, " "));

// The parts of a list card: "manquer / rater", "japonais, japonaise".
export function partsOf(front) {
  const t = String(front ?? "");
  const bySlash = t.split(/\s+\/\s+/).map((p) => p.trim()).filter(Boolean);
  if (bySlash.length >= 2) return bySlash;
  const ps = t.split(/\s*\/\s*|\s*,\s*|\s+=\s+/).map((p) => p.trim()).filter(Boolean);
  return ps.length >= 2 && ps.length <= 5 && ps.every((p) => p.split(/\s+/).length <= 6) && !/[.!?]$/.test(t.trim()) ? ps : [];
}

// Edit distance, given up past two.
function within2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > 2) return false;
    prev = cur;
  }
  return prev[b.length] <= 2;
}

const startsWithNumber = (front) => /^[0-9]/.test(String(front ?? "").trim());
const isArchivedRow = (row) => typeof row?.source === "string" && row.source.startsWith("archived:");
const isLessonRow = (row) => typeof row?.source === "string" && row.source.startsWith("lesson:");

// The keys a card is looked up by, worked out once per card object.
const KEYS = new WeakMap();
function keysOf(card) {
  let k = KEYS.get(card);
  if (k) return k;
  const sure = sureKey(card.front, card.back);
  const loose = looseKey(card.front);
  const lw = loose ? loose.split(" ") : [];
  k = {
    sure: sure.key,
    loose,
    kb: looseKeepBrackets(card.front),
    parts: partsOf(card.front).map(looseKey).filter(Boolean),
    drop: lw.length >= 3 ? [loose, ...lw.map((_, i) => lw.filter((__, j) => j !== i).join(" "))] : [],
    answer: startsWithNumber(card.front) || isDrillFront(card.front) ? looseKey(card.back) : "",
    typo: loose.length >= 5 && !isDrillFront(card.front) ? loose : "",
  };
  KEYS.set(card, k);
  return k;
}

const push = (map, key, card) => {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(card);
  else map.set(key, [card]);
};

// Every card a student has, indexed for both steps. `cards` are rows with at
// least front and back (and source, to tell what is in study). Cards added
// later with add() are found too, which is how two spellings in one reading
// end up as one card.
export function cardIndex(cards = []) {
  const bySure = new Map();
  const byLoose = new Map();
  const byKB = new Map();
  const byPart = new Map();
  const byDrop = new Map();
  const byAnswer = new Map();
  const byLen = new Map();

  const add = (card) => {
    const k = keysOf(card);
    push(bySure, k.sure, card);
    push(byLoose, k.loose, card);
    push(byKB, k.kb, card);
    for (const p of k.parts) push(byPart, p, card);
    for (const d of new Set(k.drop)) push(byDrop, d, card);
    push(byAnswer, k.answer, card);
    if (k.typo) push(byLen, k.typo.length, card);
  };

  // The card `card` surely is, or null. When several are, one in study comes
  // first, so a class date lands on the card being studied rather than on a
  // copy put away; then the one with the same French exactly.
  const sure = (card) => {
    const list = (bySure.get(keysOf(card).sure) || []).filter((c) => c !== card && isSureMatch(c, card));
    if (!list.length) return null;
    const rank = (c) => (isArchivedRow(c) ? 2 : 0) + (c.front === card.front ? 0 : 1);
    return list.slice().sort((x, y) => rank(x) - rank(y))[0];
  };

  // The near look-alikes of `card` that the sure rule doesn't settle.
  const near = (card) => {
    const k = keysOf(card);
    const found = new Set();
    const take = (list, test = null) => {
      for (const c of list || []) {
        if (c === card || found.has(c)) continue;
        if (isLessonRow(c) && isLessonRow(card)) continue;
        if (test && !test(c)) continue;
        found.add(c);
      }
    };
    take(byLoose.get(k.loose));
    for (const p of k.parts) take(byLoose.get(p));
    take(byPart.get(k.loose));
    take(byKB.get(k.kb));
    // One word more or fewer, with English agreeing. A drill answers in
    // French, so its answer has to be the same: compared as English, "ils
    // vivent" and "ils suivent" share "ils", and every "→ ils/elles" drill
    // paired with every other (95 of the 958 questions the owner's deck
    // raised, 2026-10-06).
    for (const d of new Set(k.drop)) take(byDrop.get(d), (c) => englishAgrees(c, card));
    if (k.answer) {
      take(byLoose.get(k.answer));
      take(byAnswer.get(k.answer), (c) => !(isDrillFront(c.front) && isDrillFront(card.front)));
    }
    take(byAnswer.get(k.loose));
    if (k.typo) {
      for (let len = k.typo.length - 2; len <= k.typo.length + 2; len++) {
        take(byLen.get(len), (c) => {
          const other = keysOf(c).typo;
          return other !== k.typo && within2(other, k.typo) && englishAgrees(c, card);
        });
      }
    }
    return [...found].filter((c) => !isSureMatch(c, card));
  };

  for (const c of cards || []) add(c);
  return { add, sure, near };
}
