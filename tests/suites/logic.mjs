// The pure classifiers. No browser, no fixtures — just the rules, stated as
// the cases that motivated them.
import { classifyCard } from "../../src/lib/cardTypes.js";
import { looksMultiSense } from "../../src/lib/multiSense.js";
import { cleanFrenchPrompt } from "../../src/lib/cardText.js";
import { findRelatedCards, recentMisses } from "../../src/lib/deckContext.js";
import { reconcileLessons } from "../../src/lib/lessonSync.js";
import { lessonSource, lessonCardKey } from "../../src/lib/lessonSource.js";
import { checker } from "../check.mjs";

const ck = checker();
const table = (name, cases, run) => {
  console.log(`\n  ${name}`);
  for (const [input, want, note] of cases) {
    const got = run(input);
    ck(
      `${JSON.stringify(typeof input === "object" ? input.f ?? input.b : input)} → ${want}`,
      got === want,
      got === want ? note || "" : `got ${got}`
    );
  }
};

// The stored category is a SECTION marker, not a card type: the parser tags
// everything after the "Prononciation Grammaire" heading as G, so that bucket
// holds plain vocabulary and example sentences too. These two were reported
// from the live Grammar filter.
table("classifyCard — a section tag is not a card type", [
  [{ cat: "gram", f: "mon copain", b: "my boyfriend" }, "vocab", "tagged G, but it is a word"],
  [{ cat: "gram", f: "le seul projet que j'ai vu", b: "the only project I saw" }, "phrase", "tagged G, but it is a sentence"],
  [{ cat: "gram", f: "la voiture", b: "the car" }, "vocab"],
], classifyCard);

table("classifyCard — grammar is a rule or a form to produce", [
  [{ cat: "gram", f: "aller (subjonctif) → ils/elles", b: "aillent" }, "grammar"],
  [{ cat: "vocab", f: "vivre → nous", b: "nous vivons" }, "grammar", "drill, whatever the category says"],
  [{ cat: "pron", f: "liaison" }, "grammar"],
  [{ cat: "gram", f: "le subjonctif" }, "grammar"],
], classifyCard);

table("classifyCard — vocab is a CONCEPT, not a word count", [
  [{ cat: "vocab", f: "la patate douce", b: "the sweet potato" }, "vocab"],
  [{ cat: "vocab", f: "le chemin de fer", b: "the railway" }, "vocab", "de is glue"],
  [{ cat: "vocab", f: "une pomme de terre", b: "a potato" }, "vocab"],
  [{ cat: "vocab", f: "une machine à laver", b: "a washing machine" }, "vocab"],
  [{ cat: "vocab", f: "une colline" }, "vocab"],
  [{ cat: "vocab", f: "grimper" }, "vocab"],
  [{ cat: "vocab", f: "se lever" }, "vocab", "reflexive infinitive"],
  [{ cat: "vocab", f: "s'appeler" }, "vocab", "elision"],
  [{ cat: "vocab", f: "un vendeur / une vendeuse" }, "vocab", "gender pair"],
  [{ cat: "vocab", f: "gros, grosse (adj)" }, "vocab", "variant list"],
  [{ cat: "vocab", f: "léger (adj)" }, "vocab"],
  [{ cat: "vocab", f: "après-midi" }, "vocab"],
  [{ cat: "vocab", f: "l'eau" }, "vocab"],
  [{ cat: "vocab", f: "tomber amoureux", b: "to fall in love" }, "vocab", "one concept"],
], classifyCard);

table("classifyCard — a phrase has a clause", [
  [{ cat: "expr", f: "au début" }, "phrase", "expressions are phrases however short"],
  [{ cat: "vocab", f: "je n'ai jamais été aussi célibataire de ma vie" }, "phrase"],
  [{ cat: "expr", f: "Bonjour, comment ça va ?" }, "phrase"],
  [{ cat: "vocab", f: "ça s'est bien passé" }, "phrase"],
  [{ cat: "vocab", f: "il ne faut pas exagérer" }, "phrase"],
  [{ cat: "vocab", f: "le chemin de fer de montagne à crémaillère" }, "phrase", "too many ideas"],
], classifyCard);

table("looksMultiSense — shortlists real suspects only", [
  ["the costs; the expenses; fresh", true, "the les frais case"],
  ["half; the middle", true],
  ["to rent; to hire; to praise", true],
  ["the costs / fresh", true, "mixed part of speech"],
  ["a glass / to freeze", true],
  ["a hill", false],
  ["to unload / to discharge", false, "slash is the synonym marker"],
  ["to memorise / to retain", false],
  ["fat, big", false],
  ["gros, grosse", false, "gender pair"],
  ["at the beginning", false],
  ["light / not heavy", false],
  ["to charge (a fee)", false],
  ["I have never been so single in my life", false],
], (back) => looksMultiSense({ b: back }));

// The deck's own grammar and pronunciation sections are the corpus every
// pattern in isGrammarCard was derived from. If a change stops recognising
// them, this catches it.
console.log("\n  classifyCard — against the real cahier corpus");
const { RAW } = await import("../../src/data/cards.js");
const section = RAW.filter(([, , c]) => c === "gram" || c === "pron");
const missed = section.filter(([f, b, c]) => classifyCard({ f, b, cat: c }) !== "grammar");
ck(
  `every card in the grammar and pronunciation sections reads as grammar (${section.length})`,
  missed.length === 0,
  missed.length ? missed.map(([f]) => f).join("; ").slice(0, 160) : ""
);
const vocabSection = RAW.filter(([, , c]) => c === "vocab" || c === "expr");
const pulled = vocabSection.filter(([f, b, c]) => classifyCard({ f, b, cat: c }) === "grammar");
// These are real grammar patterns the parser filed under vocab — "il faut +
// infinitif", "après avoir + participe passé". A handful is right; a flood
// means a pattern has gone too broad.
ck(
  `few vocab cards get pulled into grammar (${pulled.length} of ${vocabSection.length})`,
  pulled.length <= 30,
  pulled.length > 30 ? pulled.slice(0, 8).map(([f]) => f).join("; ") : ""
);

console.log("\n  cleanFrenchPrompt — strips a gloss, keeps grammar tags");
for (const [fr, en, want] of [
  ["je suis allé (I went (passé)", "I went (passé composé)", "je suis allé"],
  ["je suis allé (I went (passé composé))", "I went", "je suis allé"],
  ["louer (to rent)", "to rent", "louer"],
  ["grand (adj)", "big (adj)", "grand (adj)"],
  ["le poisson (pl. poissons)", "the fish (plural)", "le poisson (pl. poissons)"],
  ["acheter (qqch)", "to buy (something)", "acheter (qqch)"],
  ["au début", "at the beginning", "au début"],
  ["gros, grosse (adj)", "fat, big", "gros, grosse (adj)"],
]) {
  const got = cleanFrenchPrompt(fr, en);
  ck(`${JSON.stringify(fr)} → ${JSON.stringify(want)}`, got === want, got === want ? "" : `got ${JSON.stringify(got)}`);
}

// What the tutor gets told about the deck. The requirement is "the cards that
// bear on THIS question", so the cases are questions with a known right answer
// — not a restatement of how the scorer works.
const DECK = [
  { f: "apporter", b: "to bring (an object)", freq: 3, last_answer_correct: true, last_review: "2026-09-01" },
  { f: "amener", b: "to bring (a person)", freq: 2, last_answer_correct: false, last_review: "2026-09-06" },
  { f: "la colline", b: "the hill", freq: 5, last_answer_correct: false, last_review: "2026-09-07" },
  { f: "le chemin de fer", b: "the railway", freq: 1, last_answer_correct: null, last_review: null },
  { f: "décharger", b: "to unload / to discharge", freq: 1, last_answer_correct: true, last_review: "2026-08-30" },
];

console.log("\n  findRelatedCards — the cards this question is about");
{
  const fronts = (q) => findRelatedCards(q, DECK).map((c) => c.front);

  const pair = fronts("What's the difference between amener and apporter?");
  ck(
    "a question naming two cards returns both",
    pair.includes("amener") && pair.includes("apporter"),
    pair.join(", ") || "nothing"
  );

  const hill = fronts("is colline feminine?");
  ck("a question naming one French word finds its card", hill[0] === "la colline", hill.join(", ") || "nothing");

  // The trap: every question is mostly function words. If those match, the
  // tutor is handed twelve arbitrary cards on every turn and the context is
  // worse than none.
  ck(
    "a question of only function words matches nothing",
    fronts("what is the difference between these?").length === 0,
    fronts("what is the difference between these?").join(", ")
  );

  // "to unload" shares "to" with three backs; only the real match should win.
  const unload = fronts("how do I say to unload?");
  ck("a shared function word in the gloss is not a match", unload.length === 1 && unload[0] === "décharger", unload.join(", ") || "nothing");
}

console.log("\n  recentMisses — what they are actually getting wrong");
{
  const missed = recentMisses(DECK).map((c) => c.front);
  // The migration_006 shape of bug: null means "never reviewed", not "missed".
  // Treating it as falsy sweeps the entire unreviewed deck in.
  ck(
    "an unreviewed card is not a miss",
    !missed.includes("le chemin de fer"),
    missed.join(", ") || "nothing"
  );
  ck("only the missed cards come back", missed.length === 2, missed.join(", "));
  ck("most recently missed first", missed[0] === "la colline", missed.join(", "));
}

// Keeping a deck in step with a lesson. The requirement that costs real data:
// the lesson may withdraw a card, and the user may correct one, and those two
// must not look the same — retiring a corrected card destroys its FSRS history.
console.log("\n  reconcileLessons — the lesson is the authority, the edit is the user's");
{
  const LESSON = {
    id: "test",
    cards: [
      ["parler → tu", "parle", "G"],
      ["finir → tu", "finis", "G"],
    ],
  };
  const stored = (front, key, row_id) => ({
    f: front,
    b: "x",
    row_id,
    source: key === null ? lessonSource("test") : lessonSource("test", key),
  });

  const empty = reconcileLessons([LESSON], []);
  ck("a deck without the lesson is given all of it", empty.missing.length === 2, String(empty.missing.length));
  ck("inserted cards carry their key", empty.missing.every((c) => /#/.test(c.source)));

  const full = [
    stored("parler → tu", lessonCardKey("parler → tu"), 1),
    stored("finir → tu", lessonCardKey("finir → tu"), 2),
  ];
  const same = reconcileLessons([LESSON], full);
  ck(
    "a deck already in step is left completely alone",
    !same.missing.length && !same.stale.length && !same.rekey.length,
    `+${same.missing.length} -${same.stale.length} ~${same.rekey.length}`
  );

  // The bug this exists for: correcting a typo used to make the row
  // unrecognisable, so it was retired and re-inserted uncorrected — losing the
  // scheduling history built up on it.
  const edited = [
    stored("parler → tu (corrected)", lessonCardKey("parler → tu"), 1),
    stored("finir → tu", lessonCardKey("finir → tu"), 2),
  ];
  const afterEdit = reconcileLessons([LESSON], edited);
  ck("an edited front is not retired", afterEdit.stale.length === 0, afterEdit.stale.join(","));
  ck("an edited card is not re-inserted from the lesson", afterEdit.missing.length === 0,
     afterEdit.missing.map((c) => c.front).join(", "));

  // Still has to work: this is how eight unanswerable cards were withdrawn
  // from decks that had already added them.
  const withdrawn = [
    ...full,
    stored("state the rule", lessonCardKey("state the rule"), 9),
  ];
  const afterWithdraw = reconcileLessons([LESSON], withdrawn);
  ck("a card the lesson dropped is retired", afterWithdraw.stale.length === 1 && afterWithdraw.stale[0] === 9,
     afterWithdraw.stale.join(","));

  // Rows written before keys existed.
  const legacy = [stored("parler → tu", null, 1), stored("who knows", null, 7)];
  const afterLegacy = reconcileLessons([LESSON], legacy);
  ck("a legacy row matching the lesson is re-keyed, not duplicated",
     afterLegacy.rekey.length === 1 && afterLegacy.missing.length === 1,
     `rekey ${afterLegacy.rekey.length}, missing ${afterLegacy.missing.map((c) => c.front).join(", ")}`);
  ck("a legacy row matching nothing is never deleted",
     afterLegacy.stale.length === 0 && afterLegacy.unkeyed.length === 1,
     `stale ${afterLegacy.stale.join(",")}`);
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
