// The pure classifiers. No browser, no fixtures — just the rules, stated as
// the cases that motivated them.
import { classifyCard } from "../../src/lib/cardTypes.js";
import { looksMultiSense } from "../../src/lib/multiSense.js";
import { cleanFrenchPrompt, cleanEnglishPrompt, dropFinalPeriod } from "../../src/lib/cardText.js";
import { findRelatedCards, recentMisses, relevantMisses, buildTutorContext, cardPrompt } from "../../src/lib/deckContext.js";
import { buildRequestMessages, normalizeCards } from "../../api/chat.js";
import { reconcileLessons } from "../../src/lib/lessonSync.js";
import { planReplace } from "../../src/lib/replaceDeck.js";
import { lessonSource, lessonCardKey } from "../../src/lib/lessonSource.js";
import { isArchived, archivedSource } from "../../src/lib/archive.js";
import { LESSONS } from "../../src/data/lessons/index.js";
import { readFileSync } from "node:fs";
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
  // Missed only asked in English, and more recently than anything else.
  const enMiss = { f: "la pente", b: "the slope", cat: "vocab", last_answer_correct: true, last_review: "2020-01-01",
    en_last_answer_correct: false, en_last_review: "2099-01-01" };
  const withEn = recentMisses([...DECK, enMiss]).map((c) => c.front);
  ck("a card missed only the other way round is a miss, placed by when", withEn[0] === "la pente", withEn.join(", "));
}

console.log("\n  findRelatedCards — the way learners actually type");
{
  const D = [
    { f: "la sœur", b: "the sister" },
    { f: "l’école", b: "the school" },
    { f: "être", b: "to be" },
    { f: "sale", b: "dirty" },
    { f: "salé (adj)", b: "salty" },
  ];
  const fronts = (q) => findRelatedCards(q, D).map((c) => c.front);
  // œ used to be a non-letter, so "sœur" split into "s" and "ur" and matched
  // nothing — typed with or without the ligature.
  ck("\"soeur\" finds la sœur", fronts("what does soeur mean")[0] === "la sœur", fronts("what does soeur mean").join(", "));
  ck("\"sœur\" finds la sœur", fronts("is sœur feminine")[0] === "la sœur", fronts("is sœur feminine").join(", "));
  // Elision: the card is "l’école" with a curly apostrophe, the question
  // names the bare word without its accent.
  ck("\"ecole\" finds l’école", fronts("ecole?")[0] === "l’école", fronts("ecole?").join(", "));
  ck("\"etre\" finds être", fronts("is etre irregular")[0] === "être", fronts("is etre irregular").join(", "));
  // Folding is a fallback, not an equivalence: the accented word outranks.
  ck("an exact accented match outranks a folded one", fronts("salé")[0] === "salé (adj)", fronts("salé").join(", "));
}

console.log("\n  relevantMisses — only the misses that bear on the question");
{
  const NOW = Date.parse("2026-09-12T12:00:00Z");
  const D = [
    { row_id: 1, f: "amener", b: "to bring (a person)", last_answer_correct: false, last_review: "2026-09-10" },
    { row_id: 2, f: "la colline", b: "the hill", last_answer_correct: false, last_review: "2026-09-11" },
    { row_id: 3, f: "emmener", b: "to take (a person)", last_answer_correct: false, last_review: "2026-03-01" },
  ];
  const m = relevantMisses({ question: "amener or apporter?", cards: D, now: NOW }).map((c) => c.front);
  ck("a miss sharing a word with the question is sent", m.includes("amener"), m.join(", "));
  ck("a miss about something else is not", !m.includes("la colline"), m.join(", "));
  const old = relevantMisses({ question: "emmener?", cards: D, now: NOW }).map((c) => c.front);
  ck("a miss from months ago is not recent", old.length === 0, old.join(", "));
}

console.log("\n  buildTutorContext — the card on screen, as the student has it");
{
  const D = [
    // Missed last time asked in English ("a hill → ?"); never answered in French.
    { row_id: 1, f: "une colline", b: "a hill", cat: "vocab", en_last_answer_correct: false, en_last_review: "2026-09-11" },
    { row_id: 2, f: "un coteau", b: "a hillside", last_answer_correct: true },
  ];
  const enCard = { ...D[0], shownDir: "en" };
  ck("an English-prompt card's prompt is the English", cardPrompt(enCard) === "a hill", cardPrompt(enCard));

  const before = buildTutorContext({ question: "what is a hill in French?", cards: D, currentCard: { ...enCard, answered: false } });
  ck("unanswered is stated", before.currentCard.answered === false, JSON.stringify(before.currentCard));
  // The row's last result is last session's. It is not "they just got this wrong".
  ck("last session's miss is not reported as this attempt", !before.currentCard.result && before.currentCard.missedLastTime === true, JSON.stringify(before.currentCard));
  // Each way round is its own schedule: a miss asked in English says nothing
  // about recognising the word in French.
  const frView = buildTutorContext({ question: "what is a hill in French?", cards: D, currentCard: { ...D[0], shownDir: "fr", answered: false } });
  ck("a miss the other way round is not reported for this way", frView.currentCard.missedLastTime === false, JSON.stringify(frView.currentCard));
  ck(
    "an unanswered card is kept out of the related list, which would give its answer away",
    !(before.relatedCards || []).some((c) => c.front === "une colline"),
    JSON.stringify(before.relatedCards)
  );

  const after = buildTutorContext({
    question: "why?",
    cards: D,
    currentCard: { ...enCard, answered: true, result: "wrongArticle", typed: "le colline" },
  });
  ck("what they typed and how it was marked are sent", after.currentCard.typed === "le colline" && after.currentCard.result === "wrongArticle", JSON.stringify(after.currentCard));

  // A follow-up with no content words of its own borrows the last question's.
  const follow = buildTutorContext({ question: "and the plural?", previousQuestion: "what about coteau", cards: D });
  ck("a follow-up still finds the card being discussed", (follow?.relatedCards || []).some((c) => c.front === "un coteau"), JSON.stringify(follow));
}

console.log("\n  /api/chat — what a conversation becomes");
{
  const out = buildRequestMessages({
    messages: [
      { role: "user", content: "why?", about: "a hill" },
      { role: "assistant", content: "Colline is feminine.", cards: [{ front: "une colline", back: "a hill" }] },
      { role: "user", content: "another example?", about: "a hill" },
    ],
    context: { currentCard: { prompt: "a hill", answer: "une colline", answered: false } },
  });
  const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join(""));
  ck("an earlier question keeps the card it was about", /a hill/.test(text(out[0])) && /why\?/.test(text(out[0])), text(out[0]));
  ck("an earlier answer keeps the cards it proposed", /une colline — a hill/.test(text(out[1])), text(out[1]));
  ck("an unanswered card is flagged as not to be revealed", /NOT answered/.test(text(out[2])), text(out[2]));
  ck(
    "the conversation up to the latest question is cached",
    Array.isArray(out[1].content) && out[1].content[0].cache_control?.type === "ephemeral" && typeof out[2].content === "string",
    JSON.stringify(out[1].content).slice(0, 120)
  );

  const cards = normalizeCards({
    cards: [
      { front: "bien que + subjonctif", back: "although", category: "gram" },
      { front: "le e muet", back: "silent e", category: "pron" },
      { front: "venir (subjonctif) → que je", back: "vienne", category: "gram" },
      { front: "une colline", back: "a hill", category: "vocab" },
    ],
  }).map((c) => c.front);
  ck("a grammar card with nothing to produce is dropped", !cards.includes("bien que + subjonctif"), cards.join(", "));
  ck("a pronunciation card is dropped", !cards.includes("le e muet"), cards.join(", "));
  ck("an arrow drill and a word survive", cards.length === 2, cards.join(", "));
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

// A card the student has answered is never deleted by a lesson update: deleting
// a card deletes every answer recorded against it (the owner, 2026-09-25).
console.log("\n  reconcileLessons — a card the student has answered is kept, not deleted");
{
  const LESSON = { id: "test", cards: [["parler → tu", "parle", "G"]] };
  const keyed = (front, row_id, extra = {}) => ({ f: front, b: "x", row_id, source: lessonSource("test", lessonCardKey(front)), ...extra });
  const r = reconcileLessons([LESSON], [
    keyed("parler → tu", 1),
    keyed("dropped, never answered", 2),
    keyed("dropped, answered", 3, { fsrs_state: 2, stability: 4, last_review: "2026-09-20T12:00:00Z" }),
    keyed("dropped, answered only in English", 4, { en_fsrs_state: 2, en_stability: 1, en_last_review: "2026-09-20T12:00:00Z" }),
  ]);
  ck("a dropped card never answered is removed", r.stale.length === 1 && r.stale[0] === 2, r.stale.join(","));
  ck("a dropped card the student has answered is kept out of study instead", r.archive.join(",") === "3,4", r.archive.join(","));
}

// Every lesson card ever released stays recognisable. A deck knows a lesson
// card by its first wording; reword it without keeping that wording as the
// card's fifth element, or drop it, and every deck's copy stops matching and
// is taken out of study. tests/released-lesson-cards.json lists every card
// that has gone out; `node scripts/release-lesson-cards.mjs` adds new ones.
console.log("\n  lessons — every released card still matches its lesson");
{
  const { released, retired = {} } = JSON.parse(readFileSync(new URL("../released-lesson-cards.json", import.meta.url), "utf8"));
  for (const lesson of LESSONS) {
    const now = new Set(lesson.cards.map(([front, , , , was]) => lessonCardKey(was ?? front)));
    const gone = (released[lesson.id] || []).filter((c) => !now.has(c.key) && !(retired[lesson.id] || []).some((r) => r.key === c.key));
    ck(`${lesson.id}: no released card reworded without its first wording, or dropped`, gone.length === 0,
       gone.map((c) => c.front).join(" | "));
    const listed = new Set((released[lesson.id] || []).map((c) => c.key));
    const unlisted = lesson.cards.filter(([front, , , , was]) => !listed.has(lessonCardKey(was ?? front)));
    ck(`${lesson.id}: every card is on the release list (node scripts/release-lesson-cards.mjs)`, unlisted.length === 0,
       unlisted.map(([f]) => f).join(" | "));
  }
}

// "Replace my existing deck" deleted the whole deck before adding the upload,
// and every answer with it: one tick wiped a student's history. The deck
// still becomes the upload, but nothing answered is ever deleted.
console.log("\n  replacing the deck never deletes a card the student has answered");
{
  const row = (id, front, extra = {}) => ({ id, front, source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0, ...extra });
  const existing = [
    row(1, "une colline"),                                         // in the upload
    row(2, "le vélo", { fsrs_state: 2 }),                          // answered, in the upload
    row(3, "chercher", { en_fsrs_state: 2 }),                      // answered one way, not in the upload
    row(4, "ouvrir"),                                              // never answered, not in the upload
    row(5, "parler → tu", { source: lessonSource("imperatif", "k"), fsrs_state: 2 }),
    row(6, "fermer", { source: "lesson:adverbes" }),
    row(7, "occupé", { source: "archived:cahier-upload", fsrs_state: 2 }),
    row(8, "grimper", { source: "tutor-chat" }),
  ];
  const plan = planReplace(existing, ["une colline", "le vélo", "un mot nouveau"]);
  ck("a card the upload also has is left for the upload to update", !plan.remove.includes(1) && !plan.archive.some((r) => r.id === 1) && !plan.archive.some((r) => r.id === 2));
  ck("an answered card the upload doesn't have is kept, out of study", plan.archive.map((r) => r.id).join(",") === "3", plan.archive.map((r) => r.id).join(","));
  ck("a never-answered card the upload doesn't have is removed", plan.remove.join(",") === "4,8", plan.remove.join(","));
  ck("lesson cards and cards already archived are left alone", ![5, 6, 7].some((id) => plan.remove.includes(id) || plan.archive.some((r) => r.id === id)));
  const afterReset = planReplace(existing, ["une colline"], new Set([4]));
  ck("a card reset to never answered but with answers on record is kept, not deleted with them",
     afterReset.archive.some((r) => r.id === 4) && !afterReset.remove.includes(4), `remove ${afterReset.remove.join(",")}`);
}

// A lesson may reword a card. The reworded card must keep its row — and its
// FSRS history — rather than being retired as dropped and re-inserted as New.
console.log("\n  reconcileLessons — a reworded lesson card keeps its row");
{
  const LESSON = { id: "test", cards: [["finir (impératif) → tu", "finis", "G", "forms", "finir → tu"]] };
  const key = lessonCardKey("finir → tu");
  const row = (f, row_id) => ({ f, b: "finis", row_id, source: lessonSource("test", key) });

  const r = reconcileLessons([LESSON], [row("finir → tu", 5)]);
  ck("a renamed card is not retired", r.stale.length === 0, r.stale.join(","));
  ck("a renamed card is not re-inserted", r.missing.length === 0, r.missing.map((c) => c.front).join(", "));
  ck("the stored front is rewritten to the new wording",
     r.retext.length === 1 && r.retext[0].row_id === 5 && r.retext[0].front === "finir (impératif) → tu",
     JSON.stringify(r.retext));

  const mine = reconcileLessons([LESSON], [row("finir → tu (my note)", 5)]);
  ck("a front the user edited is not overwritten by the rename", mine.retext.length === 0, JSON.stringify(mine.retext));

  const done = reconcileLessons([LESSON], [row("finir (impératif) → tu", 5)]);
  ck("once renamed, nothing more is written",
     !done.retext.length && !done.missing.length && !done.stale.length, JSON.stringify(done));
}

// From feedback: grammar drills filed as vocab, and prompts that give the
// answer away or end in a stray full stop.
console.log("\n  card text — what the prompt may not show");
{
  ck("pp drills are grammar", classifyCard({ f: "pp de devoir : dû", b: "past participle of devoir: had to / owed", cat: "gram" }) === "grammar");
  ck("an English prompt drops a note naming the French form",
     cleanEnglishPrompt("to re-elect (past participle: réélu)") === "to re-elect");
  ck("a bare part-of-speech note stays",
     cleanEnglishPrompt("interested (past participle)") === "interested (past participle)");
  ck("other disambiguators stay",
     cleanEnglishPrompt("a range, a line (of products)") === "a range, a line (of products)");
  ck("a sentence-final full stop is dropped", dropFinalPeriod("Ne me dis pas ça.") === "Ne me dis pas ça");
  ck("so is one before a slash", dropFinalPeriod("Je pense à mon projet. / J'y pense.") === "Je pense à mon projet / J'y pense");
  ck("an ellipsis is not a full stop", dropFinalPeriod("c'est pour ça que...") === "c'est pour ça que...");
  ck("nor is etc.", dropFinalPeriod("tout etc.") === "tout etc.");
  ck("? and ! are untouched", dropFinalPeriod("Tu viens ?") === "Tu viens ?");
}

console.log("\n  archive — out of circulation, recoverable");
{
  ck("an archived source keeps where the card came from", archivedSource("cahier-upload") === "archived:cahier-upload");
  ck("archiving twice changes nothing", archivedSource(archivedSource("tutor-chat")) === "archived:tutor-chat");
  ck("an archived row is recognised", isArchived({ source: "archived:cahier-upload" }));
  ck("ordinary rows are not", !isArchived({ source: "cahier-upload" }) && !isArchived({ source: null }) && !isArchived({}));
}

// ── Cahier parser: a card must be answerable by typing ─────────────────────
// The owner's rule (2026-09-24): no grammar-rule cards, no pronunciation
// cards; the grammar that stays is the conjugation drill. api/parse-cahier.js
// enforces it after the model (keepAnswerable) and no longer keeps a
// conjugation table beside its drills (expandConjugations). Every upload path
// runs both. Self-contained — its own import — so it moves or goes as one block.
{
  const { keepAnswerable, expandConjugations } = await import("../../api/parse-cahier.js");
  const G = (front, back, extra = {}) => ({ front, back, category: "G", dates: ["2026-09-24"], ...extra });
  const outcome = (card) => {
    const out = keepAnswerable([card]);
    return out.length === 0 ? "dropped" : out[0].category;
  };

  console.log("\n  cahier parser — a rule or a sound note is not a card");
  for (const [front, back] of [
    ["Pronoms toniques", "moi, toi, lui/elle…"],
    ["qui = sujet / que = COD", "qui = subject / que = direct object"],
    ["moins + adj / moins de + nom", "less + adjective / less + noun"],
    ["du riz {ri}", "riz: silent z"],
    ["vivre : je vis, tu vis, il vit, nous vivons, vous vivez, ils vivent", "to live (present tense)"],
    ["relatif → adverbe", "relativement"],
    // Starts and ends with accented letters: \b missed both edges until
    // GRAMMAR_TERM used \p{L} lookarounds.
    ["passé composé avec être", "passé composé with être"],
  ]) {
    const got = outcome(G(front, back));
    ck(`"${front}" → dropped`, got === "dropped", got === "dropped" ? "" : `kept as ${got}`);
  }

  console.log("\n  cahier parser — a conjugation drill stays grammar");
  for (const [front, back] of [
    ["vivre → je", "je vis"],
    ["aller (subj) → que je", "que j'aille"],
    ["devoir → pp", "dû"],
    ["devoir → participe passé", "dû"],
    ["vivre (présent) → je", "je vis"],
  ]) {
    const got = outcome(G(front, back));
    ck(`"${front}" → G`, got === "G", got === "G" ? "" : `got ${got}`);
  }

  console.log("\n  cahier parser — a real word under the grammar heading is an ordinary card");
  for (const [front, back] of [
    ["mon copain", "my boyfriend"],
    ["du riz", "rice"],
    ["le seul projet que j'ai vu", "the only project I saw"],
  ]) {
    const got = outcome(G(front, back));
    ck(`"${front}" → V`, got === "V", got === "V" ? "" : `got ${got}`);
  }
  {
    const card = G("mon copain", "my boyfriend");
    keepAnswerable([card]);
    ck("re-tagging copies the card rather than editing the caller's", card.category === "G");
    const v = { front: "je viens de + infinitif", back: "I have just + infinitive", category: "V", dates: [] };
    const out = keepAnswerable([v]);
    ck("a V card is left alone, even one shaped like a rule", out.length === 1 && out[0] === v, JSON.stringify(out));
    const table = G("être : je suis, tu es, il est", "to be", {
      conjugation: true, infinitive: "être", tense: "présent", forms: ["je suis", "tu es", "il est", null, null, null],
    });
    ck("a table still waiting to be expanded is passed through for the commit",
       keepAnswerable([table])[0] === table);
  }

  console.log("\n  cahier parser — a table becomes its drills, and only its drills");
  {
    const table = G("vivre : je vis, tu vis, il vit, nous vivons, vous vivez, ils vivent", "to live (present tense)", {
      conjugation: true, infinitive: "vivre", tense: "présent",
      forms: ["je vis", "tu vis", "il vit", "nous vivons", "vous vivez", "ils vivent"],
    });
    const word = { front: "une colline", back: "a hill", category: "V", dates: ["2026-09-24"] };
    const { expanded, drillsGenerated } = expandConjugations([table, word]);
    const fronts = expanded.map((c) => c.front);
    ck("one drill per form", drillsGenerated === 6 && fronts.includes("vivre (présent) → nous"), JSON.stringify(fronts));
    ck("the table card itself is not kept — its front lists every answer",
       !fronts.includes(table.front), JSON.stringify(fronts));
    ck("each drill asks for one form, with its pronoun",
       expanded.find((c) => c.front === "vivre (présent) → il/elle")?.back === "il vit");
    ck("ordinary cards pass through", expanded.some((c) => c.front === "une colline" && c.back === "a hill" && c.category === "V"));
    ck("and every drill survives the answerable check as grammar",
       keepAnswerable(expanded).filter((c) => c.category === "G").length === 6);

    const partial = G("aller : je vais, tu vas, il va", "to go", {
      conjugation: true, infinitive: "aller", tense: "présent", forms: ["je vais", "tu vas", "il va", null, null, null],
    });
    const p = expandConjugations([partial]);
    ck("a table with gaps gives drills for the forms it has, and no table card",
       p.drillsGenerated === 3 && p.expanded.length === 3 && !p.expanded.some((c) => c.front === partial.front),
       JSON.stringify(p.expanded.map((c) => c.front)));

    const noVerb = G("vivre : je vis, tu vis, il vit", "to live", {
      conjugation: true, infinitive: null, tense: "présent", forms: ["je vis", "tu vis", "il vit"],
    });
    const nv = expandConjugations([noVerb]);
    ck("a table that yields no drills is kept for the answerable check to judge",
       nv.drillsGenerated === 0 && nv.expanded.length === 1 && !("conjugation" in nv.expanded[0]),
       JSON.stringify(nv.expanded));
    ck("which drops it", keepAnswerable(nv.expanded).length === 0, JSON.stringify(keepAnswerable(nv.expanded)));
  }
}

// ── Cahier parser: one card per front ──────────────────────────────────────
// The deck holds one card per front, and a save holding two is refused whole.
// On 2026-09-25 "pas aussi … que" ("not as … as"), taught in three classes,
// became three identical cards — a gloss made only of small words scored 0%
// alike even against itself — and the upload lost the 499 cards saved
// alongside them while reporting success. Self-contained, like the block above.
{
  const { dedupeWithPolysemy } = await import("../../api/parse-cahier.js");
  const V = (front, back, date) => ({ front, back, category: "V", dates: [date] });
  const fronts = (r) => r.deduped.map((c) => c.front);
  const unique = (r) => new Set(fronts(r).map((f) => f.toLowerCase())).size === r.deduped.length;

  console.log("\n  cahier parser — one card per front");
  const same = dedupeWithPolysemy([
    V("pas aussi … que", "not as … as", "2026-02-11"),
    V("pas aussi … que", "not as … as", "2026-03-02"),
    V("pas aussi … que", "not as … as", "2026-03-20"),
  ]);
  ck("a word taught in three classes, glossed only in small words, is one card with all three dates",
     same.deduped.length === 1 && same.deduped[0].front === "pas aussi … que" &&
       same.deduped[0].dates.length === 3 && same.splits === 0,
     JSON.stringify(same));

  const little = dedupeWithPolysemy([V("alors", "so", "2026-01-05"), V("alors", "then", "2026-02-05")]);
  ck("two small-word glosses of one little word are one card, not two senses",
     little.deduped.length === 1 && little.splits === 0, JSON.stringify(little));

  const senses = dedupeWithPolysemy([V("si", "if", "2026-01-05"), V("si", "yes, contradicting a negative question", "2026-02-05")]);
  ck("a small-word gloss against a real one is still two senses, on two different fronts",
     senses.deduped.length === 2 && senses.splits === 1 && unique(senses), JSON.stringify(fronts(senses)));

  const sameLabel = dedupeWithPolysemy([
    V("mener", "to run a business or an organisation", "2026-01-05"),
    V("mener", "to run a race across the whole park", "2026-02-05"),
  ]);
  ck("two senses whose labels come out the same are one card, never two with one front",
     sameLabel.deduped.length === 1 && unique(sameLabel) && sameLabel.deduped[0].dates.length === 2,
     JSON.stringify(sameLabel));
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
