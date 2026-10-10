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
import { choicesOf, startedLessons, lessonsInCards, onCards, setKeyOf, dealScopeOf } from "../../src/lib/lessonChoice.js";
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

  // A dropped card that a class of the student's notes landed on (it carries
  // the class date) is their notes card too: the line is recorded as read,
  // so nothing would make it again. It becomes an ordinary card, answered or
  // not (2026-10-06).
  const n = reconcileLessons([LESSON], [
    keyed("parler → tu", 1),
    keyed("actuellement", 5, { dates: ["2026-01-05"] }),
    keyed("lentement", 6, { dates: ["2026-01-05"], fsrs_state: 2, stability: 3 }),
    keyed("doucement", 7, { dates: [] }),
  ]);
  ck("a dropped card with class dates from the notes is kept as the student's own, answered or not",
     n.adopt.join(",") === "5,6" && !n.stale.includes(5) && !n.archive.includes(6), JSON.stringify({ adopt: n.adopt, stale: n.stale, archive: n.archive }));
  ck("one with no class date is still removed", n.stale.join(",") === "7", n.stale.join(","));
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
// and every answer with it: one tick wiped a student's history. Then it
// matched cards by their exact French and deleted those never answered. Since
// 2026-10-06 it works by class and deletes nothing: a card with none of its
// classes in the upload leaves study, marked "replaced", and comes back when a
// later Replace has its class again.
console.log("\n  replacing the deck works by class and never deletes a card");
{
  const row = (id, front, dates, extra = {}) => ({ id, front, dates, source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0, ...extra });
  const existing = [
    row(1, "une colline", ["2026-01-05"]),                                   // its class is in the upload
    row(2, "le vélo", ["2026-01-05", "2026-02-05"], { fsrs_state: 2 }),        // one of its classes is
    row(3, "chercher", ["2026-02-05"], { en_fsrs_state: 2 }),                 // answered, its class isn't
    row(4, "ouvrir", ["2026-02-05"]),                                        // never answered, its class isn't
    row(5, "parler → tu", [], { source: lessonSource("imperatif", "k"), fsrs_state: 2 }),
    row(6, "grimper", [], { source: "tutor-chat" }),
    row(7, "occupé", ["2026-02-05"], { source: "archived:cahier-upload", archived_reason: "removed" }),
    row(8, "fermer", ["2026-01-05"], { source: "archived:cahier-upload", archived_reason: "replaced" }),
    row(9, "partir", ["2026-03-05"], { source: "archived:cahier-upload", archived_reason: "replaced" }),
  ];
  const plan = planReplace(existing, ["2026-01-05"]);
  const out = plan.archive.map((r) => r.id).join(",");
  ck("a card with a class in the upload stays", !plan.archive.some((r) => r.id === 1 || r.id === 2));
  ck("a card never answered with none of its classes in the upload leaves study", out === "4", out);
  // An answered card stays in study whatever the classes say (2026-10-07):
  // the owner's "Le 28 et 29 septembre 2026" wasn't read as a date, and a
  // Replace took out "pas grand chose à dire", answered five times.
  ck("an answered card stays in study whatever the classes say, and is counted", plan.stay.map((r) => r.id).join(",") === "3",
     plan.stay.map((r) => r.id).join(","));
  const oneWay = [
    row(11, "a", ["2026-02-05"], { fsrs_state: 1 }),
    row(12, "b", ["2026-02-05"], { en_fsrs_state: 3 }),
    row(13, "c", ["2026-02-05"], { reps: 2 }),
    row(14, "d", ["2026-02-05"], { en_reps: 1 }),
    row(15, "e", ["2026-02-05"], { last_review: "2026-02-06T08:00:00Z" }),
    row(16, "f", ["2026-02-05"], { en_last_review: "2026-02-06T08:00:00Z" }),
    row(17, "g", ["2026-02-05"]),
  ];
  const ow = planReplace(oneWay, ["2026-01-05"]);
  ck("answered either way round, by any sign of an answer, counts", ow.stay.length === 6 && ow.archive.map((r) => r.id).join(",") === "17",
     JSON.stringify({ stay: ow.stay.map((r) => r.id), out: ow.archive.map((r) => r.id) }));
  ck("nothing is ever deleted", !("remove" in plan));
  ck("lesson and tutor cards are left alone", !plan.archive.some((r) => r.id === 5 || r.id === 6));
  // A card added with "Add to my cards" under a podcast passage (2026-10-09)
  // belongs to the student as a tutor card does: it has no class dates, so a
  // Replace would otherwise take it out unanswered, for good.
  const added = planReplace([
    row(21, "un cortège", [], { source: "podcast:3f2a9c4e-0000-4000-8000-000000000001" }),
    row(22, "grimper", [], { source: "tutor-chat" }),
    row(23, "ouvrir", []),
  ], ["2026-01-05"]);
  ck("a card added from a podcast passage is left alone, as a tutor card is, while a notes card with no class in the upload leaves",
     added.archive.map((r) => r.id).join(",") === "23", added.archive.map((r) => r.id).join(","));
  ck("a card a Replace took out comes back when its class is in the upload", plan.restore.map((r) => r.id).join(",") === "8",
     plan.restore.map((r) => r.id).join(","));
  ck("a card the student removed never does", !plan.restore.some((r) => r.id === 7));
  const blind = planReplace(existing, ["2026-01-05"], { reasons: false });
  ck("before migration_016, when the reason isn't known, nothing comes back", blind.restore.length === 0);

  // A card a Replace took out doesn't come back beside a card in study that
  // is the same card: a lesson card added meanwhile, or another copy it is
  // bringing back. The card in study gains its dates (2026-10-06).
  const twins = [
    row(1, "je vais bien", ["2026-01-05"], { source: "archived:cahier-upload", archived_reason: "replaced", fsrs_state: 2 }),
    row(2, "Je vais bien", [], { source: lessonSource("lecon1", "k") }),
    row(3, "une écharpe", ["2026-01-05"], { source: "archived:cahier-upload", archived_reason: "replaced" }),
    row(4, "Une écharpe", ["2026-01-05"], { source: "archived:cahier-upload", archived_reason: "replaced" }),
  ].map((r) => ({ ...r, back: { 1: "I'm fine", 2: "I'm fine", 3: "a scarf", 4: "a scarf" }[r.id] }));
  const t = planReplace(twins, ["2026-01-05"]);
  ck("a card whose word is in study on another card stays out, and that card is named to gain its dates",
     !t.restore.some((r) => r.id === 1) && t.kept.some((k) => k.row.id === 1 && k.into.id === 2), JSON.stringify(t.kept.map((k) => [k.row.id, k.into.id])));
  ck("of two copies a Replace took out, one comes back", t.restore.map((r) => r.id).join(",") === "3" && t.kept.some((k) => k.row.id === 4 && k.into.id === 3),
     JSON.stringify({ restore: t.restore.map((r) => r.id), kept: t.kept.map((k) => [k.row.id, k.into.id]) }));
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

// ── Cahier parser: one card per thing to learn, inside one reading ──────────
// The deck holds one card per front, and a save holding two is refused whole.
// On 2026-09-25 "pas aussi … que" ("not as … as"), taught in three classes,
// became three identical cards and the upload lost the 499 cards saved
// alongside them. Since 2026-10-06 the merge inside one reading is the rule
// every card-writer uses (src/lib/sameCard.js); what it can't settle is put
// to Claude by the matcher, and only a "different" answer makes a label
// (src/lib/cardMatch.js, tested with a stand-in Claude in the repeats suite).
{
  const { mergeRepeats } = await import("../../api/parse-cahier.js");
  const { matchNewCards, plannedWrites } = await import("../../src/lib/cardMatch.js");
  const V = (front, back, date) => ({ front, back, category: "V", dates: [date] });

  console.log("\n  cahier parser — one card per thing to learn");
  const same = mergeRepeats([
    V("pas aussi … que", "not as … as", "2026-02-11"),
    V("pas aussi … que", "not as … as", "2026-03-02"),
    V("pas aussi … que", "not as … as", "2026-03-20"),
  ]);
  ck("a word taught in three classes, glossed only in small words, is one card with all three dates",
     same.length === 1 && same[0].front === "pas aussi … que" && same[0].dates.length === 3, JSON.stringify(same));

  const spelt = mergeRepeats([V("soulagé (adj)", "relieved", "2026-01-05"), V("Soulagé", "relieved", "2026-02-05"), V("Je pars.", "I'm leaving", "2026-01-05"), V("je pars", "I'm leaving", "2026-02-05")]);
  ck("the same word spelt two ways in two classes is one card, the first spelling kept",
     spelt.length === 2 && spelt[0].front === "soulagé (adj)" && spelt[0].dates.length === 2 && spelt[1].front === "Je pars.", JSON.stringify(spelt.map((c) => c.front)));

  const assis = mergeRepeats([V("être assis", "to be seated", "2026-01-05"), V("être assis", "to be sitting", "2026-02-05")]);
  ck("the same word with English worded differently is not split into labelled cards by the merge", assis.every((c) => c.front === "être assis"),
     JSON.stringify(assis.map((c) => c.front)));
  const asked = [];
  const sameAnswer = await matchNewCards({ incoming: assis, deck: [], ask: async (pairs) => { asked.push(...pairs); return pairs.map(() => "same"); } });
  const one = plannedWrites(sameAnswer.decisions);
  ck("Claude is asked, and \"same\" makes one card with both dates", asked.length === 1 && one.inserts.length === 1 && one.inserts[0].dates.length === 2,
     JSON.stringify(one.inserts));

  const senses = [V("voler", "to steal", "2026-01-05"), V("voler", "to fly", "2026-02-05")];
  const apart = plannedWrites((await matchNewCards({ incoming: senses, deck: [], ask: async (pairs) => pairs.map(() => "different") })).decisions);
  ck("\"different\" makes two cards, and never two with one front", apart.inserts.map((c) => c.front).join(" | ") === "voler | voler (to fly)",
     apart.inserts.map((c) => c.front).join(" | "));

  const failed = await matchNewCards({ incoming: senses, deck: [], ask: async () => { throw new Error("down"); } });
  ck("no answer: the card waits rather than being added on a guess", failed.decisions.filter((d) => d.action === "wait").length === 1,
     JSON.stringify(failed.decisions.map((d) => d.action)));
}

// ── Which lessons come up on Cards ─────────────────────────────────────────
// The owner's rules (2026-10-04): a lesson the student has answered cards in
// is on until they say otherwise, one they haven't started is off, and My
// cahier is every card that isn't a lesson's.
{
  console.log("\n  lesson switches and My cahier");
  const ids = ["imperatif", "adverbes"];
  const card = (source, extra = {}) => ({ cat: "vocab", f: "x", b: "y", source, fsrs_state: 0, en_fsrs_state: 0, ...extra });
  const answeredEnOnly = card("lesson:imperatif#k1", { en_fsrs_state: 2 });
  const untouched = card("lesson:adverbes#k2");
  const own = card("cahier-upload");
  const tutor = card("tutor-chat");
  const cards = [answeredEnOnly, untouched, own, tutor];
  const started = startedLessons(cards);

  ck("a lesson answered only English side up counts as started", started.has("imperatif") && !started.has("adverbes"),
     JSON.stringify([...started]));
  const byDefault = lessonsInCards(ids, started, {});
  ck("without a choice, a started lesson is on and an untouched one is off",
     byDefault.has("imperatif") && !byDefault.has("adverbes"), JSON.stringify([...byDefault]));
  const chosen = lessonsInCards(ids, started, { imperatif: false, adverbes: true });
  ck("the student's choice overrides that, either way", !chosen.has("imperatif") && chosen.has("adverbes"),
     JSON.stringify([...chosen]));
  const catalogue = LESSONS.map((l) => l.id);
  const fresh = lessonsInCards(catalogue, new Set(), {});
  ck("without a choice, the five basic lessons are on and L'impératif and the adverbs are off",
     ["lecon1", "lecon2", "lecon3", "lecon4", "lecon5"].every((id) => fresh.has(id)) &&
     !fresh.has("imperatif") && !fresh.has("adverbes"), JSON.stringify([...fresh]));
  ck("a basic lesson switched off by hand stays off", !lessonsInCards(catalogue, new Set(), { lecon1: false }).has("lecon1"));

  const all = { scope: "all", lessonsOn: byDefault, lessonIds: ids };
  const cahier = { scope: "cahier", lessonsOn: byDefault, lessonIds: ids };
  ck("Everything deals the student's own cards and the lessons switched on",
     onCards(own, all) && onCards(tutor, all) && onCards(answeredEnOnly, all) && !onCards(untouched, all));
  ck("My cahier deals no lesson card, and does deal words added from the tutor",
     onCards(own, cahier) && onCards(tutor, cahier) && !onCards(answeredEnOnly, cahier) && !onCards(untouched, cahier));
  ck("a card from a lesson no longer in the catalogue is dealt as before",
     onCards(card("lesson:retired#k3"), { ...all, lessonsOn: new Set() }));

  ck("the whole deck and a lesson keep the set keys they had, so kept sets come back",
     setKeyOf("all", "all", "all") === "all|all" && setKeyOf("grammar", "all", "all") === "grammar|all" &&
     setKeyOf("all", "imperatif", "cahier") === "all|imperatif");
  ck("My cahier keeps a set of its own", setKeyOf("all", "all", "cahier") === "all|all|cahier");
  ck("a set's record says which lessons were off", dealScopeOf("all|all", "adverbes") === "all|all|off=adverbes" &&
     dealScopeOf("all|all", "") === "all|all");

  ck("choices are read from the account, and junk there is ignored",
     choicesOf({ user_metadata: { lessons_in_cards: { imperatif: true } } }).imperatif === true &&
     Object.keys(choicesOf({ user_metadata: { lessons_in_cards: ["imperatif"] } })).length === 0 &&
     Object.keys(choicesOf(null)).length === 0);
}

// The tutor on Podcasts (owner only, 2026-10-09). There is no card on screen
// there: the tutor is told the RFI episode, its transcript and the passage
// being answered, and until the passage is answered it must not translate or
// summarise it, because that is the exercise.
console.log("\n  the tutor on Podcasts — the episode and the passage, instead of a card");
{
  const { PODCAST_TRANSCRIPT_MAX, podcastAbout } = await import("../../src/lib/deckContext.js");
  const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join(""));
  const passageFr = "Les manifestants ont défilé dans le calme jusqu’à la place de la République.";
  // Long enough to be cut by the 200-character limit cards get, with a marker
  // well past it, and another past the transcript's own limit.
  const middle = "BIEN-AU-DELA-DE-DEUX-CENTS";
  const beyond = "AU-DELA-DE-LA-LIMITE";
  const transcript = `Bonsoir à tous. ${"Il fait beau. ".repeat(40)}${middle} ${"x".repeat(PODCAST_TRANSCRIPT_MAX)}${beyond}`;
  const podcast = (passage) => ({
    key: "pod:ep-1:s1-abcdef12",
    episode: { title: "Les mots de l’info : défiler", date: "Tuesday 6 October", show: "Les mots de l’info" },
    passage,
    transcript,
  });
  const unanswered = podcast({ fr: passageFr, kind: "translate", answered: false, typed: "the protesters", verdict: null });

  const ctx = buildTutorContext({ question: "what does défiler mean?", cards: [], podcast: unanswered });
  ck("the passage on screen is sent, marked as not answered", ctx?.podcast?.passage?.fr === passageFr && ctx.podcast.passage.answered === false,
     JSON.stringify(ctx?.podcast?.passage));
  ck("a half-typed answer is not sent before the passage is checked", !("typed" in (ctx?.podcast?.passage || {})),
     JSON.stringify(ctx?.podcast?.passage));
  ck("the transcript is kept up to its limit and no further",
     ctx?.podcast?.transcript.length === PODCAST_TRANSCRIPT_MAX && ctx.podcast.transcript.includes(middle) && !ctx.podcast.transcript.includes(beyond),
     `${ctx?.podcast?.transcript.length} characters`);
  ck("no card is described on Podcasts", !ctx?.currentCard, JSON.stringify(Object.keys(ctx || {})));
  const withCard = buildTutorContext({ question: "why?", cards: [], currentCard: { f: "une colline", b: "a hill", shownDir: "fr", answered: false }, podcast: unanswered });
  ck("a card on screen is what the tutor is told about, never both", !!withCard?.currentCard && !withCard.podcast, JSON.stringify(Object.keys(withCard || {})));

  const about = podcastAbout(unanswered);
  ck("a question keeps the episode and the start of its passage as what it was about",
     about.length <= 200 && about.includes("Les mots de l’info") && about.includes("Les manifestants"), about);
  ck("never the transcript", !about.includes("Bonsoir"), about);

  const out = buildRequestMessages({
    messages: [
      { role: "user", content: "a hint?", about },
      { role: "assistant", content: "Think of a parade." },
      { role: "user", content: "what does défiler mean?" },
    ],
    context: ctx,
  });
  const last = text(out[out.length - 1]);
  ck("an earlier question keeps what was on screen, without calling it a card",
     /Asked while this was on screen/.test(text(out[0])) && /Les manifestants/.test(text(out[0])) && !/this card/.test(text(out[0])), text(out[0]));
  ck("the passage goes with the latest question", last.includes(passageFr), last.slice(0, 300));
  ck("an unanswered passage is flagged as not to be translated", /NOT answered/.test(last) && /do not translate/.test(last), last.slice(0, 400));
  ck("it says which exercise the passage is", /translate it into English/.test(last), last.slice(0, 400));
  // The server clips on its own as well: a request built some other way is
  // held to the same limit.
  const raw = text(buildRequestMessages({
    messages: [{ role: "user", content: "what does défiler mean?" }],
    context: { podcast: { ...ctx.podcast, transcript } },
  }).at(-1));
  ck("the transcript reaches the tutor well past the 200 characters a card gets, up to its limit",
     last.includes(middle) && raw.includes(middle) && !raw.includes(beyond), `${raw.length} characters sent from ${transcript.length}`);
  ck("the earlier turns carry no transcript, so the history stays the same from turn to turn",
     !text(out[0]).includes("Bonsoir") && !text(out[1]).includes("Bonsoir"), text(out[0]).slice(0, 120));

  const answeredCtx = buildTutorContext({
    question: "why only partly?",
    cards: [],
    podcast: podcast({ fr: passageFr, kind: "gist", answered: true, typed: "People marched calmly", verdict: "partly" }),
  });
  const after = text(buildRequestMessages({ messages: [{ role: "user", content: "why only partly?" }], context: answeredCtx }).at(-1));
  ck("once checked, what they typed and how it was marked are sent",
     after.includes("People marched calmly") && /partly right/.test(after) && !/NOT answered/.test(after), after.slice(0, 400));
  ck("a gist passage is described as giving the idea", /give the idea of it in English/.test(after), after.slice(0, 400));

  const episodeOnly = buildTutorContext({ question: "what does amerrir mean?", cards: [], podcast: podcast(null) });
  const epText = text(buildRequestMessages({ messages: [{ role: "user", content: "what does amerrir mean?" }], context: episodeOnly }).at(-1));
  ck("with no passage on screen, the episode and its transcript still go", /Podcast episode on screen/.test(epText) && epText.includes(middle) && !/passage on their screen/.test(epText),
     epText.slice(0, 200));
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
