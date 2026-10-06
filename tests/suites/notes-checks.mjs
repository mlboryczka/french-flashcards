// Claude turning class notes into cards, tested against the owner's
// corrections (api/_lib/notesChecks.js): what each correction makes a case of,
// finding its class in the cahier, judging a reading of the class, only the
// admin seeing the list, and the test the server runs on its own: every
// case's class read three times, counted and kept. With a stand-in store,
// cahier and reading. No browser, nothing leaves the machine.

import { checker } from "../check.mjs";

const ck = checker();
const {
  handleNotesChecks, buildCases, judge, caseKind, summarize, runNotesTest, notesPass, NOTES_RUNS, NOTES_PROMPT_VERSION,
} = await import("../../api/_lib/notesChecks.js");

const OWNER = "owner";
const corrections = [
  { id: "c1", user_id: OWNER, card_id: 1, action: "edit", created_at: "2026-04-24T10:00:00Z",
    original_front: "une propositiond", original_back: "a proposal", corrected_front: "une proposition", corrected_back: "a proposal" },
  { id: "c2", user_id: OWNER, card_id: 2, action: "edit", created_at: "2026-04-26T10:00:00Z",
    original_front: "si j'avais un travail", original_back: "if I had a job — présent général", corrected_front: "si j'avais un travail", corrected_back: "if I had a job" },
  { id: "c3", user_id: OWNER, card_id: 99, action: "delete", created_at: "2026-04-28T10:00:00Z",
    original_front: "Naza", original_back: "Naza (brand name)", corrected_front: null, corrected_back: null },
  { id: "c4", user_id: OWNER, card_id: 98, action: "delete", created_at: "2026-05-12T10:00:00Z",
    original_front: "que = COD", original_back: "that = direct object", corrected_front: null, corrected_back: null },
  { id: "c5", user_id: OWNER, card_id: 3, action: "edit", created_at: "2026-04-30T10:00:00Z",
    original_front: "amener (to bring (a person))", original_back: "to bring (a person)", corrected_front: "amener", corrected_back: "to bring (a person)" },
  { id: "c6", user_id: OWNER, card_id: 4, action: "edit", created_at: "2026-05-02T10:00:00Z",
    original_front: "16 = seize", original_back: "16 = sixteen", corrected_front: "16 = seize", corrected_back: "16 = sixteen" },
  { id: "c7", user_id: OWNER, card_id: 97, action: "delete", created_at: "2026-05-01T10:00:00Z",
    original_front: "Place de l'adverbe : Les adverbes vont toujours après le verbe SAUF : bien, beaucoup", original_back: "Adverb placement", corrected_front: null, corrected_back: null },
];
const cards = [
  { id: 1, front: "une proposition", dates: ["2025-09-22"] },
  { id: 2, front: "si j'avais un travail", dates: ["2026-01-05"] },
  { id: 3, front: "amener", dates: ["2025-08-14", "2026-05-19"] },
  { id: 4, front: "16 = seize", dates: ["2025-10-17"] },
];
// The notebook, newest class first as the owner writes it. "que = COD" is in
// a class after its correction too: the one before is the one meant.
const blocks = [
  { date: "2026-06-12", text: "que = COD\nqui = sujet" },
  { date: "2026-05-19", text: "amener (to bring a person) again" },
  { date: "2026-05-07", text: "Les pronoms relatifs\nque = COD" },
  { date: "2026-01-05", text: "si j'avais un travail\nprésent général" },
  { date: "2025-12-18", text: "Place de l'adverbe : Les adverbes vont toujours après le verbe SAUF : bien, beaucoup" },
  { date: "2025-10-21", text: "Naza\nune marque" },
  { date: "2025-09-22", text: "une proposition (f)" },
  { date: "2025-08-14", text: "amener (to bring (a person))" },
];

console.log("\n  what each correction is a case of");
{
  ck("a changed front", caseKind(corrections[0]) === "front");
  ck("a changed back", caseKind(corrections[1]) === "back");
  ck("a deletion", caseKind(corrections[2]) === "delete");
  ck("an edit that changed nothing isn't a case", caseKind(corrections[5]) === null);
}

console.log("\n  finding each case's class");
{
  const cases = buildCases(corrections, new Map(cards.map((c) => [c.id, c])), blocks);
  const by = Object.fromEntries(cases.map((c) => [c.id, c]));
  ck("six cases from seven corrections", cases.length === 6, cases.map((c) => c.id).join());
  ck("a card still in the deck: by its own class date", by.c1.date === "2025-09-22" && by.c2.date === "2026-01-05");
  ck("of several dates, the class whose text holds it", by.c5.date === "2025-08-14", by.c5.date);
  ck("a deleted card: by the class that holds its text", by.c3.date === "2025-10-21");
  ck("and the one from before the correction, not a later one", by.c4.date === "2026-05-07", by.c4.date);
  ck("a long rule found by its text", by.c7.date === "2025-12-18");
}

console.log("\n  judging one reading of a class");
{
  const c = (id) => corrections.find((x) => x.id === id);
  ck("the corrected card, made right: no repeat, made",
     JSON.stringify(judge(c("c1"), [{ front: "une proposition", back: "a proposal" }])) === '{"repeated":false,"made":true}');
  ck("the same stray letter again: repeated", judge(c("c1"), [{ front: "une propositiond", back: "x" }]).repeated);
  ck("a gloss stuck on again, worded differently: repeated", judge(c("c5"), [{ front: "amener (to bring)", back: "to bring" }]).repeated);
  ck("but a longer card that only starts the same isn't", !judge(c("c5"), [{ front: "amener quelqu'un", back: "to bring someone" }]).repeated);
  ck("the note taken off the back, back again: repeated",
     judge(c("c2"), [{ front: "si j'avais un travail", back: "if I had a job (présent général)" }]).repeated);
  ck("without it: not", !judge(c("c2"), [{ front: "si j'avais un travail", back: "if I had a job" }]).repeated);
  ck("a deleted card made again, in other capitals and spacing: repeated", judge(c("c3"), [{ front: " naza ", back: "a brand" }]).repeated);
  ck("a deleted rule made again, worded a little differently: repeated",
     judge(c("c7"), [{ front: "Place de l'adverbe: les adverbes vont après le verbe", back: "x" }]).repeated);
  ck("a deletion is never 'made'", judge(c("c3"), []).made === null);
}

console.log("\n  the test, as the server runs it on its own");
{
  const store = {
    saved: [],
    async corrections() { return { rows: corrections }; },
    async cards(ids) { return { rows: cards.filter((x) => ids.includes(x.id)) }; },
    async link(user) { return { row: user === OWNER ? { doc_url: "https://docs.google.com/document/d/abc" } : null }; },
    async runs() { return { rows: this.saved }; },
    async saveRun(row) { const run = { id: `run${this.saved.length + 1}`, ...row }; this.saved.push(run); return { row: run }; },
  };
  let reads = [];
  // The stand-in Claude: repeats the stray letter in one reading out of three,
  // and makes "Naza" into a card every time.
  const read = async (block) => {
    reads.push(block.date);
    const n = reads.filter((d) => d === block.date).length;
    if (block.date === "2025-09-22") return [{ front: n === 2 ? "une propositiond" : "une proposition", back: "a proposal" }];
    if (block.date === "2025-10-21") return [{ front: "Naza", back: "a brand" }];
    return [{ front: "autre chose", back: "something else" }];
  };
  const env = { store, readDoc: async () => "the cahier", blocksOf: () => blocks };

  for (const action of ["list"]) {
    const r = await handleNotesChecks({ body: { action }, isAdmin: false, ...env });
    ck(`a student can't ${action}`, r.status === 403);
  }
  const list = await handleNotesChecks({ body: { action: "list" }, isAdmin: true, ...env });
  ck("the list gives every case with its class, and the version of how a class is read",
     list.status === 200 && list.json.cases.length === 6 && list.json.cases.every((c) => c.date) && list.json.version === NOTES_PROMPT_VERSION &&
     !("user_id" in list.json.cases[0]));
  const gone = await handleNotesChecks({ body: { action: "test", ids: ["c1"] }, isAdmin: true, ...env });
  ck("there's no test to start by hand any more", gone.status === 400);
  ck("and nothing was read for the list", reads.length === 0);

  const done = await runNotesTest({ ...env, read });
  const classes = new Set(buildCases(corrections, new Map(cards.map((c) => [c.id, c])), blocks).map((c) => c.date)).size;
  ck(`every case's class read ${NOTES_RUNS} times, once for all the cases it holds`, reads.length === classes * NOTES_RUNS, `${reads.length} readings of ${classes} classes`);
  const run = store.saved[0];
  const by = Object.fromEntries(run.results.map((r) => [r.id, r]));
  ck("the stray letter came back in one reading of three", JSON.stringify(by.c1.repeated) === "[false,true,false]" && JSON.stringify(by.c1.made) === "[true,false,true]", JSON.stringify(by.c1));
  ck("the deleted card came back every time", by.c3.repeated.every(Boolean));
  ck("the run is kept and counted: no repeat on four, sometimes on one, every time on one",
     run.kind === "notes" && run.version === NOTES_PROMPT_VERSION && JSON.stringify([done.summary.every, done.summary.sometimes, done.summary.never]) === "[4,1,1]" && run.passed === 4,
     JSON.stringify(done.summary));
  ck("a case passes only when the mistake came back in none of the readings",
     notesPass({ repeated: [false, null, false] }) && !notesPass({ repeated: [false, true, false] }) && !notesPass({ repeated: [null, null, null] }));

  const before = store.saved.length;
  const flaky = async (block) => { if (block.date === "2025-10-21") throw new Error("Claude returned non-JSON"); return read(block); };
  const partly = await runNotesTest({ ...env, read: flaky });
  const kept = store.saved.at(-1);
  ck("a class Claude couldn't read leaves its cases untried: kept apart, not counted as mistakes",
     store.saved.length === before + 1 && partly.summary.untried === 1 && partly.summary.cases === 5 &&
     kept.results.find((r) => r.id === "c3").repeated.every((v) => v === null), JSON.stringify(partly.summary));
  ck("and each case keeps the class it was judged on", kept.results.every((r) => typeof r.date === "string"));

  reads = [];
  const late = await runNotesTest({ ...env, read, deadline: -1 });
  ck("past the time limit nothing is read, and no run is kept", reads.length === 0 && !!late.skipped && store.saved.length === before + 1, JSON.stringify(late));
}

console.log("\n  counting");
{
  ck("a reading that failed doesn't count against Claude",
     summarize([{ repeated: [false, null, false] }]).every === 1);
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
