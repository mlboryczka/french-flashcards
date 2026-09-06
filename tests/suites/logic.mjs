// The pure classifiers. No browser, no fixtures — just the rules, stated as
// the cases that motivated them.
import { classifyCard } from "../../src/lib/cardTypes.js";
import { looksMultiSense } from "../../src/lib/multiSense.js";
import { cleanFrenchPrompt } from "../../src/lib/cardText.js";
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

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
