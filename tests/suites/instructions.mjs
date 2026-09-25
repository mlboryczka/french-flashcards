// What a grammar card asks you to type, and which lesson cards may be written
// into a deck. No browser: the rules, stated as the cases that motivated them.
import { drillInstruction, personAlternates, drillAlternates, isConjugationDrill } from "../../src/lib/cardInstruction.js";
import { LESSONS, cardInstructionFor } from "../../src/data/lessons/index.js";
import { lessonSource, lessonCardKey } from "../../src/lib/lessonSource.js";
import { reconcileLessons } from "../../src/lib/lessonSync.js";
import { checker } from "../check.mjs";

const ck = checker();
const CAT = { V: "vocab", E: "expr", G: "gram", P: "pron" };

console.log("\n  drillInstruction — the tense and the person, by name");
for (const [front, want] of [
  // "vivre → je" never said which tense; a drill with none named is the present.
  ["vivre → je", "Conjugate in the present tense, first person singular, with je"],
  ["vivre → il/elle", "Conjugate in the present tense, third person singular, with il or elle"],
  ["vivre → ils/elles", "Conjugate in the present tense, third person plural, with ils or elles"],
  ["aller (subj) → que je", "Conjugate in the present subjunctive, first person singular, with que je"],
  ["aller (subj) → qu'ils", "Conjugate in the present subjunctive, third person plural, with qu'ils"],
  ["devoir → imparfait (je)", "Conjugate in the imperfect, first person singular, with je"],
  ["devoir → conditionnel passé (je)", "Conjugate in the past conditional, first person singular, with je"],
  ["venir → imparfait (ils)", "Conjugate in the imperfect, third person plural, with ils"],
  ["devoir → pp", "Give the past participle"],
  // The cahier parser's shapes.
  ["vivre (présent) → nous", "Conjugate in the present tense, first person plural, with nous"],
  // A table expands to "(subjonctif) → je" with "que j'aille" as the answer.
  ["aller (subjonctif) → ils/elles", "Conjugate in the present subjunctive, third person plural, with qu'ils or qu'elles"],
  ["aller (subjonctif) → je", "Conjugate in the present subjunctive, first person singular, with que je"],
  ["réélire → participe passé", "Give the past participle"],
  // The imperative has no pronoun to type, so the person is named instead.
  ["finir (impératif) → tu", "Give the imperative, second person singular (the tu form)"],
  // Not drills: these get their line from a lesson section, or none.
  ["relatif → adverbe", null],
  ["Tu me dis → à l'impératif", null],
  ["bon ou bien → Il parle ___ anglais", null],
  ["si + présent → futur", null],
  // A tense in brackets that isn't one we can name gets no line, rather than
  // being introduced as the present.
  ["vivre (temps inconnu) → je", null],
  ["Ordre des pronoms: me/te → le/la/les → lui/leur → y → en", null],
]) {
  const got = drillInstruction(front);
  ck(`${front} → ${want}`, got === want, got === want ? "" : `got ${got}`);
}

console.log("\n  personAlternates — il/elle takes either pronoun");
for (const [front, back, want] of [
  ["vivre → il/elle", "il vit", ["elle vit"]],
  ["vivre → ils/elles", "ils vivent", ["elles vivent"]],
  ["vivre → je", "je vis", []],
  ["aller (subj) → qu'il", "qu'il aille", []],
]) {
  const got = personAlternates(front, back);
  ck(`${front} / ${back} → ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
}

console.log("\n  drillAlternates — a subjunctive with or without its que");
for (const [front, back, want] of [
  ["aller (subjonctif) → je", "que j'aille", ["j'aille"]],
  ["aller (subj) → qu'il", "qu'il aille", ["il aille"]],
  ["aller (subjonctif) → je", "j'aille", ["que j'aille"]],
  ["aller (subjonctif) → ils/elles", "qu'ils aillent", ["qu'elles aillent", "ils aillent", "elles aillent"]],
  ["vivre → il/elle", "il vit", ["elle vit"]],
  // Stored with no pronoun (the tutor writes these): the line says "with que
  // je", so that is what gets typed.
  ["venir (subjonctif) → que je", "vienne", ["que je vienne"]],
  ["aller (futur) → je", "irai", ["j'irai"]],
]) {
  const got = drillAlternates(front, back);
  const ok = want.every((w) => got.includes(w));
  ck(`${front} / ${back} → also ${JSON.stringify(want)}`, ok, `got ${JSON.stringify(got)}`);
}

console.log("\n  every lesson grammar card says what to type");
for (const lesson of LESSONS) {
  const missing = [];
  for (const [f, b, c] of lesson.cards) {
    const card = { f, b, cat: CAT[c], source: lessonSource(lesson.id, lessonCardKey(f)) };
    const line = cardInstructionFor(card);
    if (c === "G" && !line) missing.push(f);
    if (c !== "G" && line) missing.push(`${f} (a ${CAT[c]} card has a line)`);
  }
  ck(`${lesson.id}: ${lesson.cards.length} cards, every grammar card has a line and no other card does`, missing.length === 0, missing.join(" | "));
}
// The two gap sections share one cue per word ("cher → … coûtent ___" wants
// cher, "cher → … ___ acquise" wants chèrement), so their lines must not
// differ, or the line gives the answer away.
const adverbes = LESSONS.find((l) => l.id === "adverbes");
ck("adverbes: the two gap sections have the same line", adverbes?.instructions?.invariable === adverbes?.instructions?.meaning);
ck("a deck drill gets its line with no lesson", cardInstructionFor({ f: "vendre → nous", b: "nous vendons", cat: "gram" })?.includes("first person plural"));
ck("a vocab card gets no line", cardInstructionFor({ f: "la moitié", b: "half", cat: "vocab" }) === null);

console.log("\n  a reworded lesson card keeps its place, keyed as the sync keys it");
{
  const { lessonRank } = await import("../../src/data/lessons/index.js");
  const imperatif = LESSONS.find((l) => l.id === "imperatif");
  const renamed = imperatif.cards.filter((c) => c[4]);
  const unranked = renamed.filter(([f, b, c, , was]) =>
    lessonRank({ f, b, cat: CAT[c], source: lessonSource("imperatif", lessonCardKey(was)) }) === null);
  ck(`all ${renamed.length} reworded impératif cards are ranked`, renamed.length > 0 && unranked.length === 0,
     unranked.map(([f]) => f).slice(0, 3).join(" | "));
}

console.log("\n  conjugation drills are the only grammar cards left in the demo deck");
const { RAW } = await import("../../src/data/cards.js");
const leftover = RAW.filter(([f, , c]) => (c === "gram" || c === "pron") && !isConjugationDrill(f)).map(([f]) => f);
ck("no rule or pronunciation card in RAW", leftover.length === 0, leftover.slice(0, 5).join(" | "));

console.log("\n  reconcileLessons never writes over the student's own card");
{
  const lesson = { id: "t", cards: [["actuellement", "currently", "G", "x"], ["relatif → adverbe", "relativement", "G", "y"]] };
  const own = { f: "actuellement", b: "currently / at the moment", cat: "vocab", source: "cahier-upload", row_id: 1 };
  const { missing, taken } = reconcileLessons([lesson], [own]);
  ck("the lesson card whose front the deck already has is not inserted", !missing.some((m) => m.front === "actuellement"));
  ck("and is reported as taken", taken.length === 1 && taken[0].front === "actuellement");
  ck("the other lesson card is still inserted", missing.some((m) => m.front === "relatif → adverbe"));
  const again = reconcileLessons([lesson], []);
  ck("with no such card in the deck, it is inserted", again.missing.length === 2 && again.taken.length === 0);
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
