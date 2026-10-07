// No card made twice from the same notes (2026-10-06). The owner: "there
// should be NO duplicates from reuploading an updated cahier".
//
// No browser. The upload runs the dialog's own steps (src/lib/uploadRun.js)
// through the server's own handlers, and the linked notebook runs syncUser,
// all against a stand-in database (tests/fake-supabase.mjs, which refuses what
// the live one refuses and runs migration_016's two functions), a stand-in
// Google Doc, and a stand-in Claude that reads a line "French = English" as
// that card, counts every call, and answers the same-or-different question
// from a hand-written list of the pairs that really are one card.
//
// The headline test, run in every way the notes can come in:
//   a deck is built from a 6-class notebook and made to look used (answers,
//   a French and an English edited by the student, a card removed, a repeat
//   put away, a lesson card, a tutor card). Then the notebook comes back
//   updated: the same 6 classes, one with a line added, one with a typo
//   fixed, one with its date line retyped, and 2 new classes with 4 new words
//   and every old word written in each way seen to slip through before.
//   Every time: exactly 5 new cards (the 4 words and the added line), no
//   reading of an unchanged class, no two cards in study that are one card,
//   every old card as it was (id, text, schedule, answers) with its new class
//   dates, the student's edits kept, the removed and put-away cards still out
//   of study, nothing deleted, and a second identical upload that asks Claude
//   nothing and adds nothing.

import { createServer } from "node:http";
import { checker } from "../check.mjs";
import { fakeSupabase } from "../fake-supabase.mjs";

const ck = checker();

process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
delete process.env.ADMIN_EMAIL;
delete process.env.VITE_ADMIN_EMAIL;

// ── The notebooks ─────────────────────────────────────────────────────────
const C = (dateLine, ...lines) => ({ dateLine, lines });
const C1 = C("Le 2 octobre 2025", "soulagé (adj) = relieved", "Je pars. = I'm leaving", "De toutes façons = anyway",
  "une carrière = a career", "aujourd'hui = today", "aller (présent) → il/elle = il va");
const C2 = C("Le 9 octobre 2025", "un fils {fiss} = a son", "tout d'un coup = suddenly; all at once", "alors = so",
  "aller = to go", "un cas = an instance", "ma soeur = my sister");
const C3 = C("Le 16 octobre 2025", "Naza = Naza (a name)", "gratuit = free", "enervé (adj) = annoyed",
  "manquer / rater = to miss", "un ami = a friend");
const C4 = C("Le 21 octobre 2025", "le soleil = the sun", "être assis = to be seated", "japonais = Japanese",
  "il fait beau = the weather is nice");
const C5 = C("Le 28 octobre 2025", "une propositiond = a proposal", "Je parle jamais de Pierre. = I never talk about Pierre",
  "les poils = hair; fur", "ne ... jamais = never");
const C6 = C("Le 4 novembre 2025", "rends-moi mon livre = give me back my book", "il fait froid = it is cold", "le travail = work");

// The same classes updated, and two new ones.
const C4b = { ...C4, dateLine: "Le 23 octobre 2025" };
const C5b = { ...C5, lines: C5.lines.map((l) => l.replace("une propositiond", "une proposition")) };
const C6b = { ...C6, lines: [...C6.lines, "un écureuil = a squirrel"] };
const C7 = C("Le 11 novembre 2025", "une colline = a hill", "grimper = to climb", "Soulagé = relieved", "Je pars = I'm leaving",
  "de toutes façons = anyway", "la carrière = the career", "aujourd’hui = today", "un fils = a son",
  "Tout d'un coup = all of a sudden", "Alors = so", "Aller = to go", "le cas = the case", "ma sœur = my sister",
  "naza = Naza (a name)", "gratuit (adj) = free", "aller (présent) → il = il va");
const C8 = C("Le 18 novembre 2025", "le brouillard = fog", "un parapluie = an umbrella", "l'ami = the friend",
  "énervé = annoyed", "manquer = to miss", "japonais, japonaise = Japanese", "être assis = to be sitting",
  "Je parle jamais de Pierre = I never talk about Pierre", "ne … jamais = never", "je vais bien = I'm fine",
  "Rends-moi mon livre ! = Give me my book back!", "le travail = work");

const notebook = (...classes) =>
  [...classes].reverse().map((c) => `${c.dateLine}\nVocabulaire Expressions\n${c.lines.join("\n")}\n`).join("\n");
const NOTEBOOK_1 = notebook(C1, C2, C3, C4, C5, C6);
const NOTEBOOK_2 = notebook(C1, C2, C3, C4b, C5b, C6b, C7, C8);
const D = { C1: "2025-10-02", C2: "2025-10-09", C3: "2025-10-16", C4: "2025-10-21", C4b: "2025-10-23", C5: "2025-10-28", C6: "2025-11-04", C7: "2025-11-11", C8: "2025-11-18" };

const EXPECTED_NEW = ["une colline", "grimper", "le brouillard", "un parapluie", "un écureuil"];
// Each new spelling of an old word, the card it is, and the class it adds.
const SAME_AS = [
  ["Soulagé", "soulagé (adj)", D.C7], ["Je pars", "Je pars.", D.C7], ["de toutes façons", "De toutes façons", D.C7],
  ["la carrière", "une carrière", D.C7], ["aujourd’hui", "aujourd'hui", D.C7], ["un fils", "un fils {fiss}", D.C7],
  ["Tout d'un coup", "tout d'un coup", D.C7], ["Alors", "alors", D.C7], ["Aller", "aller", D.C7], ["le cas", "un cas", D.C7],
  ["ma sœur", "ma soeur", D.C7], ["naza", "Naza", D.C7], ["gratuit (adj)", "gratuit", D.C7],
  ["aller (présent) → il", "aller (présent) → il/elle", D.C7],
  ["l'ami", "un ami", D.C8], ["énervé", "enervé (adj)", D.C8], ["manquer", "manquer / rater", D.C8],
  ["japonais, japonaise", "japonais", D.C8], ["être assis", "être assis", D.C8],
  ["Je parle jamais de Pierre", "Je parle jamais de Pierre", D.C8], ["ne … jamais", "ne ... jamais", D.C8],
  ["je vais bien", "Je vais bien", D.C8], ["Rends-moi mon livre !", "rends-moi mon livre", D.C8], ["le travail", "le travail", D.C8],
  ["une proposition", "une propositiond", D.C5],
];
// The pairs that really are one card, as Claude should judge them.
const plain = (f) => String(f).toLowerCase().replace(/[.\s]+$/, "");
const pairKey = (a, b) => [plain(a), plain(b)].sort().join(" | ");
const ONE_CARD = new Set([
  ["un cas", "le cas"], ["un ami", "l'ami"], ["enervé (adj)", "énervé"], ["manquer / rater", "manquer"],
  ["japonais", "japonais, japonaise"], ["être assis", "être assis"], ["une propositiond", "une proposition"],
].map(([a, b]) => pairKey(a, b)));

// ── The stand-in Claude ───────────────────────────────────────────────────
const claude = {
  reads: [], questions: [], pairsAsked: [], questionFails: false, readFails: false, judge: null, seen: new Map(),
  // For the question's own checks: fail every call whose pairs `failIf`
  // picks (retries included), hold each answer this long, and the most calls
  // seen at once.
  failIf: null, holdMs: 0, inFlight: 0, mostAtOnce: 0,
};
const resetCalls = () => { claude.reads = []; claude.questions = []; claude.pairsAsked = []; };
const unquote = (s) => JSON.parse(s);
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    const reply = (text, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(code === 200 ? JSON.stringify({
        id: "msg", type: "message", role: "assistant", model: "test",
        content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }) : JSON.stringify({ type: "error", error: { type: "api_error", message: "stand-in down" } }));
    };
    const content = typeof json.messages?.[0]?.content === "string" ? json.messages[0].content : "";
    if (String(json.system || "").includes("keep one flashcard for each thing they learn")) {
      claude.questions.push(content);
      if (claude.questionFails || claude.failIf?.(content)) return reply("", 500);
      if (claude.holdMs) {
        claude.inFlight++;
        claude.mostAtOnce = Math.max(claude.mostAtOnce, claude.inFlight);
        return setTimeout(() => { claude.inFlight--; answerQuestion(); }, claude.holdMs);
      }
      return answerQuestion();
    }
    function answerQuestion() {
      const pairs = [...content.matchAll(/Pair (\d+)\n {2}A: (".*?") = (".*?")\n {2}B: (".*?") = (".*?")(?:\n|$)/g)]
        .map((m) => ({ n: Number(m[1]), a: unquote(m[2]), b: unquote(m[4]) }));
      claude.pairsAsked.push(...pairs);
      const judge = claude.judge || ((a, b) => (ONE_CARD.has(pairKey(a, b)) ? "same" : "different"));
      return reply(JSON.stringify({ verdicts: pairs.map((p) => ({ pair: p.n, verdict: judge(p.a, p.b) })) }));
    }
    // A reading of a class: every "French = English" line is a card, or only
    // the new lines when Claude is told which they are.
    const lesson = /Here is the lesson text:\n\n---\n([\s\S]*?)\n---/.exec(content)?.[1] || "";
    const newPart = /New lines:\n([\s\S]*)$/.exec(content)?.[1];
    const lines = (newPart ? newPart.split("\n").map((l) => l.replace(/^- /, "")) : lesson.split("\n")).map((l) => l.trim()).filter(Boolean);
    claude.reads.push({ lesson, newLines: newPart ? lines : null });
    if (claude.readFails) return reply("", 500);
    const cards = [];
    for (const line of lines) {
      const i = line.indexOf(" = ");
      if (i < 0) continue;
      let front = line.slice(0, i).trim();
      // A line read a second time comes back spelt a little differently, as
      // the real model's do: this is how a re-read made a second card.
      const n = claude.seen.get(line) || 0;
      claude.seen.set(line, n + 1);
      if (n > 0) front = front.endsWith(".") ? front.slice(0, -1) : `${front[0] === front[0].toUpperCase() ? front[0].toLowerCase() : front[0].toUpperCase()}${front.slice(1)}`;
      cards.push({ front, back: line.slice(i + 3).trim(), category: front.includes("→") ? "G" : "V" });
    }
    reply(JSON.stringify(cards));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

// Which class a reading was of, by its first line.
const classOf = (read) => {
  for (const [name, c] of Object.entries({ C1, C2, C3, C4, C5, C6, C5b, C6b, C7, C8 })) {
    if (read.lesson.split("\n").some((l) => l.trim() === c.lines[0])) return name.replace(/b$/, "");
  }
  return "?";
};
const classesRead = () => [...new Set(claude.reads.map(classOf))].sort();

// ── The Google Doc ────────────────────────────────────────────────────────
const doc = { text: "" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("docs.google.com")) return new Response(doc.text, { status: 200, headers: { "content-type": "text/plain" } });
  return realFetch(url, init);
};

// ── The app's own code ────────────────────────────────────────────────────
const { handleSlice, handlePlan, handleCommit } = await import("../../api/parse-cahier.js");
const { readClasses } = await import("../../api/cahier-parse.js");
const { syncUser } = await import("../../api/cahier-sync.js");
const { removeCard } = await import("../../api/_lib/removeCard.js");
const { runUpload } = await import("../../src/lib/uploadRun.js");
const { isSureMatch, cardIndex } = await import("../../src/lib/sameCard.js");
const { reconcileLessons } = await import("../../src/lib/lessonSync.js");
const { lessonCardKey } = await import("../../src/lib/lessonSource.js");
const { askSameCard, PAIRS_PER_CALL, CALLS_AT_ONCE } = await import("../../api/_lib/sameCardQuestion.js");
const { supabaseFeedbackStore } = await import("../../api/_lib/feedbackReview.js");

const USER = "00000000-0000-0000-0000-00000000000a";
const KEY = "sk-ant-test-key-0123456789abcdef";
const URL_1 = "https://docs.google.com/document/d/DOC1/edit";
const URL_COPY = "https://docs.google.com/document/d/DOC1-copy/edit";

const fakeRes = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
function poster(admin, { pauseAfterPlan = null } = {}) {
  return async (url, body) => {
    if (url === "/api/cahier-parse") {
      const { status, json } = await readClasses({ admin, userId: USER, apiKey: KEY, body });
      if (status >= 400 || !json.ok) throw new Error(json.error || `HTTP ${status}`);
      return json;
    }
    const req = { method: "POST", body, headers: { "x-anthropic-key": KEY } };
    const res = fakeRes();
    if (body.action === "slice") await handleSlice(req, res);
    else if (body.action === "plan") await handlePlan(req, res, admin, USER);
    else if (body.action === "commit") await handleCommit(req, res, admin, { id: USER, email: "student@example.com" });
    if (res.code >= 400 || !res.body?.ok) throw new Error(res.body?.error || `HTTP ${res.code}`);
    if (body.action === "plan" && pauseAfterPlan) await pauseAfterPlan();
    return res.body;
  };
}
const upload = (admin, content, { replace = false, pauseAfterPlan = null } = {}) =>
  runUpload({ post: poster(admin, { pauseAfterPlan }), mode: "text", content, replace, source: "paste" })
    .catch((e) => ({ ok: false, error: e.message, threw: true }));
const sync = (admin, opts = {}) =>
  syncUser({ admin, apiKey: "sk-ant-server-key-0123456789abcdef", userId: USER, force: true, ...opts })
    .catch((e) => ({ ok: false, error: e.message, threw: true }));
async function syncAll(admin, opts = {}) {
  let r;
  for (let i = 0; i < 10; i++) {
    r = await sync(admin, i === 0 ? opts : {});
    if (!r.ok || !r.remaining) break;
  }
  return r;
}

// ── Building the used deck ────────────────────────────────────────────────
const isOut = (r) => typeof r.source === "string" && r.source.startsWith("archived:");
const cards = (admin) => admin.tables.user_cards;
const byFront = (admin, front) => cards(admin).find((r) => r.front === front);
const inStudy = (admin) => cards(admin).filter((r) => !isOut(r));
const ANSWERED = ["soulagé (adj)", "Je pars.", "alors", "un cas", "le travail", "gratuit"];

async function usedDeck({ migrated = true, via = "upload" } = {}) {
  const admin = fakeSupabase({ migrated });
  claude.seen = new Map(); // a new student: nothing of theirs read yet
  if (via === "upload") {
    const r = await upload(admin, NOTEBOOK_1);
    if (!r.ok) throw new Error(`building the deck failed: ${r.error}`);
  } else {
    doc.text = NOTEBOOK_1;
    const r = await syncAll(admin, { url: URL_1 });
    if (!r.ok) throw new Error(`building the deck failed: ${r.error}`);
  }
  let review = 1;
  for (const front of ANSWERED) {
    const row = byFront(admin, front);
    Object.assign(row, { fsrs_state: 2, stability: 5.5, difficulty: 4.2, reps: 3, lapses: 1, next_due_at: "2025-12-01T08:00:00Z",
      last_review: "2025-11-10T08:00:00Z", en_fsrs_state: 1, en_stability: 1.2 });
    admin.tables.card_reviews.push({ id: review++, user_id: USER, card_id: row.id, direction: "fr", rating: 3 });
  }
  // The student's own edits, as the app saves them.
  byFront(admin, "Je parle jamais de Pierre.").front = "Je parle jamais de Pierre";
  byFront(admin, "les poils").back = "hair / hairs";
  // Removed, the way the app removes a card now.
  const removed = await removeCard({ admin, userId: USER, rowId: byFront(admin, "Naza").id });
  if (removed.status !== 200) throw new Error(`removing a card failed: ${JSON.stringify(removed.json)}`);
  // A repeat put away by the clean-up, a lesson card, a tutor card.
  cards(admin).push({ id: 9001, user_id: USER, front: "gratuit (adj)", back: "free", category: "V", dates: [D.C3], source: "archived:cahier-upload",
    fsrs_state: 0, en_fsrs_state: 0, ...(migrated ? { archived_reason: "duplicate", merged_into: byFront(admin, "gratuit").id } : {}) });
  cards(admin).push({ id: 9002, user_id: USER, front: "Je vais bien", back: "I'm fine", category: "V", dates: [], source: "lesson:lecon1#k9", fsrs_state: 2, en_fsrs_state: 0 });
  cards(admin).push({ id: 9003, user_id: USER, front: "une falaise", back: "a cliff", category: "V", dates: [], source: "tutor-chat", fsrs_state: 0, en_fsrs_state: 0 });
  return admin;
}

const snapshot = (admin) => JSON.parse(JSON.stringify({ cards: admin.tables.user_cards, reviews: admin.tables.card_reviews }));
const SCHEDULE = ["fsrs_state", "stability", "difficulty", "reps", "lapses", "next_due_at", "last_review", "en_fsrs_state", "en_stability"];

// Every check of the headline test.
function headline(label, admin, before, { expectNew = EXPECTED_NEW, expectRead = ["C5", "C6", "C7", "C8"], readCheck = true } = {}) {
  const now = snapshot(admin);
  const oldIds = new Set(before.cards.map((r) => r.id));
  const added = now.cards.filter((r) => !oldIds.has(r.id));
  ck(`${label}: exactly the new words arrive, and nothing else`,
     JSON.stringify(added.map((r) => plain(r.front)).sort()) === JSON.stringify(expectNew.map(plain).sort()) && added.every((r) => !isOut(r)),
     added.map((r) => r.front).join(" | "));
  if (readCheck) {
    ck(`${label}: no class read that had nothing new`, JSON.stringify(classesRead()) === JSON.stringify([...expectRead].sort()),
       classesRead().join(","));
  }
  const live = now.cards.filter((r) => !isOut(r));
  const pairs = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) if (isSureMatch(live[i], live[j])) pairs.push(`${live[i].front} ~ ${live[j].front}`);
  ck(`${label}: no two cards in study are one card by the rule`, pairs.length === 0, pairs.join("; "));
  const strays = SAME_AS.filter(([spelling, old]) => plain(spelling) !== plain(old) && live.some((r) => plain(r.front) === plain(spelling)));
  ck(`${label}: no card in study is a new spelling of an old one`, strays.length === 0, strays.map((s) => s[0]).join(", "));
  const changed = [];
  for (const old of before.cards) {
    const row = now.cards.find((r) => r.id === old.id);
    if (!row) { changed.push(`${old.front}: gone`); continue; }
    for (const k of ["front", "back", "category", "source", "archived_reason", ...SCHEDULE]) {
      if (JSON.stringify(row[k] ?? null) !== JSON.stringify(old[k] ?? null)) changed.push(`${old.front}: ${k}`);
    }
    if (!(old.dates || []).every((d) => row.dates.includes(d))) changed.push(`${old.front}: lost a date`);
  }
  ck(`${label}: every old card keeps its id, text, category, schedule and place in or out of study`, changed.length === 0, changed.join("; "));
  ck(`${label}: every answer on record is kept`, JSON.stringify(now.reviews) === JSON.stringify(before.reviews));
  const missingDates = SAME_AS.filter(([, old, date]) => !(now.cards.find((r) => r.front === old)?.dates || []).includes(date));
  ck(`${label}: each old word taught again gains its new class date`, missingDates.length === 0, missingDates.map((m) => `${m[1]} ${m[2]}`).join(", "));
  ck(`${label}: the student's edits are kept`,
     !!now.cards.find((r) => r.front === "Je parle jamais de Pierre") && !now.cards.some((r) => r.front === "Je parle jamais de Pierre.") &&
       now.cards.find((r) => r.front === "les poils")?.back === "hair / hairs");
  ck(`${label}: the removed card and the put-away repeat stay out of study`,
     isOut(now.cards.find((r) => r.front === "Naza")) && isOut(now.cards.find((r) => r.front === "gratuit (adj)")) &&
       !live.some((r) => /^naza$/i.test(r.front)));
  ck(`${label}: the lesson and tutor cards are left as they were`,
     now.cards.find((r) => r.id === 9002)?.source === "lesson:lecon1#k9" && now.cards.find((r) => r.id === 9003)?.source === "tutor-chat");
}

async function secondTimeAsksNothing(label, admin, run) {
  const before = snapshot(admin);
  resetCalls();
  const r = await run();
  const after = snapshot(admin);
  const moved = after.cards.filter((c, i) => JSON.stringify(c) !== JSON.stringify(before.cards[i])).map((c) => c.front);
  ck(`${label}: the same notes again ask Claude nothing and add nothing`,
     r.ok !== false && claude.reads.length === 0 && claude.questions.length === 0 && JSON.stringify(after) === JSON.stringify(before),
     `${claude.reads.length} readings, ${claude.questions.length} questions, changed: ${moved.join(" | ")}, ${JSON.stringify(r).slice(0, 120)}`);
}

// ═════════════════════════════════════════════════════════════════════════
console.log("\n  the rule: every spelling seen to slip through is one card, and look-alikes that differ are not");
{
  const sure = [
    ["soulagé (adj)", "relieved", "Soulagé", "relieved"], ["Je pars.", "I'm leaving", "Je pars", "I'm leaving"],
    ["une carrière", "a career", "la carrière", "the career"], ["aujourd'hui", "today", "aujourd’hui", "today"],
    ["un fils {fiss}", "a son", "un fils", "a son"], ["tout d'un coup (suddenly; all at once)", "suddenly; all at once", "tout d'un coup", "suddenly"],
    ["alors", "so", "Alors", "so"], ["aller", "to go", "Aller", "to go"], ["c'est", "it is", "C'est", "it is"],
    ["ma soeur", "my sister", "ma sœur", "my sister"], ["ne ... jamais", "never", "ne … jamais", "never"],
    ["des écouteurs", "earphones", "des écouteurs (m)", "earphones"], ["aller (présent) → il/elle", "il va", "aller (présent) → il", "il va"],
    ["aller (subjonctif) → que je", "que j'aille", "aller (subjonctif) → je", "que j'aille"],
    ["rends-moi mon livre", "give me back my book", "Rends-moi mon livre !", "Give me my book back!"],
  ];
  const missed = sure.filter(([a, b, c, d]) => !isSureMatch({ front: a, back: b }, { front: c, back: d }));
  ck("each verified spelling is surely the same card", missed.length === 0, missed.map((m) => m[2]).join(", "));
  ck("but \"Je pense !\" (I think so!) is not \"je pense\" (I think)", !isSureMatch({ front: "je pense", back: "I think" }, { front: "Je pense !", back: "I think so!; You bet!" }));
}

console.log("\n  keep apart: words that look alike are never joined by the rule, and a \"different\" answer keeps both");
{
  const PAIRS = [
    ["ou", "or", "où", "where"], ["la poste", "the post office", "le poste", "the job"], ["fin", "the end", "fin (adj)", "thin"],
    ["un état", "a state", "l'État", "the State"], ["voler", "to steal", "voler", "to fly"],
    ["planter", "to plant", "planter (fam)", "to ditch someone"], ["vieux", "old", "vieille", "old (feminine)"],
    ["encore meilleur / mieux", "even better", "mieux (adv)", "better"],
  ];
  const joined = PAIRS.filter(([a, b, c, d]) => isSureMatch({ front: a, back: b }, { front: c, back: d }));
  ck("the fixed rule joins none of them", joined.length === 0, joined.map((p) => `${p[0]} ~ ${p[2]}`).join(", "));

  const admin = fakeSupabase();
  const first = notebook(C("Le 1 septembre 2025", ...PAIRS.map(([a, b]) => `${a} = ${b}`)));
  await upload(admin, first);
  resetCalls();
  claude.judge = () => "different";
  const second = notebook(C("Le 1 septembre 2025", ...PAIRS.map(([a, b]) => `${a} = ${b}`)), C("Le 8 septembre 2025", ...PAIRS.map(([, , c, d]) => `${c} = ${d}`)));
  const r = await upload(admin, second);
  claude.judge = null;
  const live = inStudy(admin);
  const asked = new Set(claude.pairsAsked.map((p) => p.b));
  ck("the near ones were put to Claude", ["où", "le poste", "fin (adj)", "l'État", "voler", "planter (fam)", "mieux (adv)"].every((f) => asked.has(f)),
     [...asked].join(" | "));
  ck("and every one of the 16 cards is in study", r.ok && live.length === 16, `${live.length}: ${live.map((c) => c.front).join(" | ")}`);
  ck("only the card whose French was taken got a label, from its English", !!live.find((c) => c.front === "voler (to fly)") && !!live.find((c) => c.front === "voler"),
     live.filter((c) => /voler/.test(c.front)).map((c) => c.front).join(" | "));
}

// ── The headline test, in every way the notes come in ────────────────────
async function headlineVia(label, { build = "upload", run, readCheck = true, expectRead } = {}) {
  console.log(`\n  ${label}`);
  const admin = await usedDeck({ via: build });
  const before = snapshot(admin);
  resetCalls();
  const r = await run(admin);
  ck(`${label}: it reports success`, r.ok !== false, JSON.stringify(r).slice(0, 200));
  headline(label, admin, before, { readCheck, expectRead });
  return { admin, r };
}

{
  const { admin, r } = await headlineVia("upload, added to the deck", { run: (a) => upload(a, NOTEBOOK_2) });
  ck("upload: the classes partly read before were sent with only their new line",
     claude.reads.filter((x) => classOf(x) === "C6")[0]?.newLines?.join() === "un écureuil = a squirrel" &&
       claude.reads.filter((x) => classOf(x) === "C5")[0]?.newLines?.join() === "une proposition = a proposal",
     JSON.stringify(claude.reads.map((x) => x.newLines)));
  ck("upload: the retyped date was recognised, and its class not read", !claude.reads.some((x) => classOf(x) === "C4"));
  ck("upload: the reply counts what happened", r.cardsInserted === 5 && r.classesUnchanged === 4 && r.cardsWaiting === 0,
     JSON.stringify({ added: r.cardsInserted, unchanged: r.classesUnchanged, waiting: r.cardsWaiting, again: r.cardsSeenAgain }));
  const pairs = admin.tables.card_pairs;
  ck("upload: each of Claude's answers is kept, with the question's version",
     pairs.length >= 7 && pairs.every((p) => p.version && /^[0-9a-f]{7}$/.test(p.version) && p.card_a) &&
       pairs.some((p) => p.verdict === "same" && p.b_front === "le cas"),
     `${pairs.length} kept`);
  await secondTimeAsksNothing("upload", admin, () => upload(admin, NOTEBOOK_2));
}

{
  const { admin, r } = await headlineVia("upload, replacing the deck", { run: (a) => upload(a, NOTEBOOK_2, { replace: true }) });
  ck("replace: with every class still there, nothing is taken out", r.keptOutOfStudy === 0, JSON.stringify(r).slice(0, 160));
  await secondTimeAsksNothing("replace", admin, () => upload(admin, NOTEBOOK_2, { replace: true }));
}

{
  const { admin } = await headlineVia("linked notebook, the daily sync", {
    build: "sync", run: async (a) => { doc.text = NOTEBOOK_2; return syncAll(a); },
  });
  await secondTimeAsksNothing("sync", admin, () => syncAll(admin));
  const reads = admin.calls.length;
  await sync(admin);
  const deckReads = admin.calls.slice(reads).filter((c) => c.table === "user_cards").length;
  ck("a daily check with nothing new doesn't even read the deck", deckReads === 0, `${deckReads} reads of user_cards`);
}

{
  const { admin } = await headlineVia("uploaded, then the same notes linked: one record for both", {
    run: async (a) => { doc.text = NOTEBOOK_2; return syncAll(a, { url: URL_1 }); },
  });
  await secondTimeAsksNothing("upload then link", admin, () => upload(admin, NOTEBOOK_2));
}

{
  const { admin } = await headlineVia("unlinked and linked again", {
    build: "sync",
    run: async (a) => {
      a.tables.cahier_links = a.tables.cahier_links.filter((l) => l.user_id !== USER); // Unlink, as the app does
      doc.text = NOTEBOOK_2;
      return syncAll(a, { url: URL_1 });
    },
  });
  ck("unlink left the record of lines read alone", (admin.tables.notes_read || []).length === 1);
  await secondTimeAsksNothing("relinked", admin, () => syncAll(admin));
}

{
  const { admin } = await headlineVia("a copy of the doc linked instead", {
    build: "sync", run: async (a) => { doc.text = NOTEBOOK_2; return syncAll(a, { url: URL_COPY }); },
  });
  await secondTimeAsksNothing("copy", admin, () => syncAll(admin));
}

console.log("\n  two runs at once");
{
  const admin = await usedDeck();
  const before = snapshot(admin);
  admin.tables.cahier_links.push({ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: {}, last_checked_at: null });
  doc.text = NOTEBOOK_2;
  resetCalls();
  let syncDuring = null;
  const up = upload(admin, NOTEBOOK_2, { pauseAfterPlan: async () => { syncDuring = await sync(admin); } });
  const r = await up;
  ck("a sync while an upload is reading is told to wait, and reads nothing",
     syncDuring?.ok && syncDuring.busy === true && /being read already/.test(syncDuring.skipped || "") && syncDuring.cardsAdded === 0,
     JSON.stringify(syncDuring));
  ck("the upload finishes", r.ok !== false, JSON.stringify(r).slice(0, 160));
  headline("upload with a sync in the middle", admin, before);
  const both = await Promise.all([sync(admin), sync(admin)]);
  // The upload's four readings, and not one more.
  ck("two syncs at once after it: neither reads anything already read", both.every((x) => x.ok) && claude.reads.length === 4, `${claude.reads.length} readings`);

  // Two syncs started together on a deck with new classes: one reads, one waits.
  const admin2 = await usedDeck({ via: "sync" });
  const before2 = snapshot(admin2);
  doc.text = NOTEBOOK_2;
  resetCalls();
  const pair = await Promise.all([sync(admin2), sync(admin2)]);
  ck("two syncs started together: one reads and one is told to wait",
     pair.filter((x) => /being read already/.test(x.skipped || "")).length === 1 && pair.filter((x) => x.cardsAdded > 0).length === 1,
     JSON.stringify(pair.map((x) => x.skipped || x.cardsAdded)));
  headline("two syncs started together", admin2, before2);

  // A turn never given back runs out.
  const admin3 = await usedDeck();
  const plan = await poster(admin3)("/api/parse-cahier", { action: "plan", blocks: [{ date: D.C7, text: C7.lines.join("\n") }] });
  doc.text = NOTEBOOK_2;
  admin3.tables.cahier_links.push({ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: {}, last_checked_at: null });
  const blocked = await sync(admin3);
  admin3.tables.notes_read[0].run_expires_at = new Date(Date.now() - 1000).toISOString();
  const after = await syncAll(admin3);
  ck("an upload that never finished holds the turn only until it runs out",
     !!plan.runId && /being read already/.test(blocked.skipped || "") && after.ok && after.cardsAdded === 5, JSON.stringify({ blocked: blocked.skipped, after: after.cardsAdded }));

  // An upload whose turn runs out while it reads, and the daily check comes,
  // reads and saves meanwhile: the upload has lost its turn, even though the
  // check has given it back, and saves nothing. The record changed under it.
  const admin4 = await usedDeck();
  const before4 = snapshot(admin4);
  admin4.tables.cahier_links.push({ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: {}, last_checked_at: null });
  doc.text = NOTEBOOK_2;
  resetCalls();
  let meanwhile = null;
  const lostTurn = await upload(admin4, NOTEBOOK_2, {
    pauseAfterPlan: async () => {
      admin4.tables.notes_read[0].run_expires_at = new Date(Date.now() - 1000).toISOString();
      meanwhile = await syncAll(admin4);
    },
  });
  ck("an upload whose turn was taken meanwhile saves nothing, and says to upload again",
     lostTurn.ok === false && /another reading of your notes started/.test(lostTurn.error) && meanwhile?.ok && meanwhile.cardsAdded === 5,
     JSON.stringify({ upload: lostTurn.error, sync: meanwhile?.cardsAdded }));
  headline("an upload that lost its turn to the daily check", admin4, before4, { readCheck: false });
  await secondTimeAsksNothing("after the lost turn", admin4, () => upload(admin4, NOTEBOOK_2));
}

console.log("\n  a failure between saving the cards and recording the lines");
{
  // The save fails before the database commits: nothing is saved, the lines
  // stay unread, and the next upload does it all.
  const admin = await usedDeck();
  const before = snapshot(admin);
  const failing = fakeSupabase({ tables: admin.tables, faults: { rpc: { name: "save_notes_reading", times: 1 } } });
  resetCalls();
  const r1 = await upload(failing, NOTEBOOK_2);
  ck("a save that fails says so", r1.ok === false && /couldn't be saved/i.test(r1.error), JSON.stringify(r1).slice(0, 160));
  ck("and saved nothing at all", JSON.stringify(snapshot(failing).cards) === JSON.stringify(before.cards));
  resetCalls();
  const r2 = await upload(failing, NOTEBOOK_2);
  ck("the next upload succeeds", r2.ok !== false, JSON.stringify(r2).slice(0, 160));
  headline("after a save that failed", failing, before);

  // The database commits and the reply is lost (the function cut off after
  // it): cards and lines were saved together, so nothing is read again.
  const admin2 = await usedDeck();
  const before2 = snapshot(admin2);
  const cut = fakeSupabase({ tables: admin2.tables, faults: { rpc: { name: "save_notes_reading", times: 1, after: true } } });
  resetCalls();
  const lost = await upload(cut, NOTEBOOK_2);
  ck("a reply lost after the save is reported", lost.ok === false, JSON.stringify(lost).slice(0, 120));
  headline("after a lost reply", cut, before2);
  await secondTimeAsksNothing("after a lost reply", cut, () => upload(cut, NOTEBOOK_2));
}

console.log("\n  one card the database refuses");
{
  const admin = await usedDeck();
  const before = snapshot(admin);
  const tooLong = `une phrase ${"très ".repeat(700)}longue`;
  const withBad = notebook(C1, C2, C3, C4b, C5b, C6b, { ...C7, lines: [...C7.lines, `${tooLong} = a long sentence`] }, C8);
  resetCalls();
  const saves = admin.calls.filter((c) => c.rpc === "save_notes_reading").length;
  const r = await upload(admin, withBad);
  ck("the refused card is reported, by its French", r.ok !== false && r.cardsFailed === 1 && r.failedFronts?.[0]?.startsWith("une phrase"), JSON.stringify({ failed: r.cardsFailed }));
  ck("and the rest is saved with the lines read in one step, not two",
     admin.calls.filter((c) => c.rpc === "save_notes_reading").length - saves === 1);
  headline("one card refused", admin, before);
  await secondTimeAsksNothing("one card refused", admin, () => upload(admin, withBad));
  // Replace still works when a card is refused; it used to quietly become an add.
  const admin2 = await usedDeck();
  const r2 = await upload(admin2, notebook(C1, C2, C4, C5, C6, { ...C7, lines: [`${tooLong} = a long sentence`, "une colline = a hill"] }), { replace: true });
  ck("a refused card doesn't turn Replace into an add", r2.cardsFailed === 1 && r2.keptOutOfStudy > 0 && isOut(byFront(admin2, "gratuit")),
     JSON.stringify({ failed: r2.cardsFailed, out: r2.keptOutOfStudy }));
}

console.log("\n  when Claude can't answer the question, those cards wait");
{
  const admin = await usedDeck();
  const before = snapshot(admin);
  claude.questionFails = true;
  resetCalls();
  const r1 = await upload(admin, NOTEBOOK_2);
  claude.questionFails = false;
  const added1 = snapshot(admin).cards.filter((c) => !before.cards.some((b) => b.id === c.id)).map((c) => c.front);
  ck("nothing from a class with an unanswered question is added", r1.ok !== false && r1.cardsWaiting > 0 &&
     !added1.some((f) => ["une colline", "grimper", "le brouillard", "un parapluie"].includes(f)), `${r1.cardsWaiting} waiting; added ${added1.join(", ")}`);
  ck("and no card is added on a guess", !added1.some((f) => SAME_AS.some(([s]) => s === f)));
  resetCalls();
  const r2 = await upload(admin, NOTEBOOK_2);
  ck("the next upload reads only the waiting classes again", r2.ok !== false && classesRead().every((c) => ["C5", "C7", "C8"].includes(c)), classesRead().join(","));
  headline("after waiting for Claude", admin, before, { readCheck: false });
}

console.log("\n  Replace works by class, never deletes, and leaves lesson and tutor cards alone");
{
  const admin = await usedDeck();
  const before = snapshot(admin);
  const without3 = notebook(C1, C2, C4, C5, C6);
  const r = await upload(admin, without3, { replace: true });
  const c3 = ["gratuit", "enervé (adj)", "manquer / rater", "un ami"];
  ck("cards with none of their classes in the upload leave study, marked replaced",
     r.ok !== false && c3.every((f) => isOut(byFront(admin, f)) && byFront(admin, f).archived_reason === "replaced"), JSON.stringify(c3.map((f) => byFront(admin, f)?.source)));
  ck("nothing is deleted, and an answered card keeps its schedule", cards(admin).length === before.cards.length && byFront(admin, "gratuit").stability === 5.5);
  ck("the removed card stays removed", byFront(admin, "Naza").archived_reason === "removed");
  ck("lesson and tutor cards are left alone", !isOut(byFront(admin, "Je vais bien")) && !isOut(byFront(admin, "une falaise")));
  ck("the other classes are untouched", ["soulagé (adj)", "le soleil", "le travail"].every((f) => !isOut(byFront(admin, f))));
  const added = await upload(admin, notebook(C1, C2, C3, C4, C5, C6));
  ck("an upload that adds brings none of them back", added.ok !== false && c3.every((f) => isOut(byFront(admin, f))));
  const back = await upload(admin, notebook(C1, C2, C3, C4, C5, C6), { replace: true });
  ck("a Replace with the class again brings its cards back, history and all",
     back.broughtBack === 4 && c3.every((f) => !isOut(byFront(admin, f))) && byFront(admin, "gratuit").stability === 5.5, JSON.stringify(back).slice(0, 160));
  ck("but not the card the student removed", isOut(byFront(admin, "Naza")));
}

console.log("\n  the first run after the fix: what the deck holds counts as read");
{
  // A deck made before the record existed: cards with class dates, and the
  // owner's link holding the classes it read. Nothing is read to fill it in.
  const admin = await usedDeck();
  admin.tables.notes_read = [];
  admin.tables.cahier_links.push({ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: { [D.C6]: "abc" } });
  const before = snapshot(admin);
  resetCalls();
  const r = await upload(admin, NOTEBOOK_2);
  ck("classes whose dates are on cards are not read", r.ok !== false && !classesRead().some((c) => ["C1", "C2", "C3", "C5", "C6"].includes(c)), classesRead().join(","));
  headline("first run after the fix", admin, before, {
    readCheck: false,
    // A line added to a class the record had no lines for can't be told apart.
    expectNew: EXPECTED_NEW.filter((f) => f !== "un écureuil"),
  });
  await secondTimeAsksNothing("first run after the fix", admin, () => upload(admin, NOTEBOOK_2));
}

console.log("\n  a removed card is kept, out of study, and never comes back");
{
  const admin = await usedDeck();
  const row = byFront(admin, "Naza");
  ck("removing keeps the row, out of study, with the reason and its dates",
     !!row && isOut(row) && row.archived_reason === "removed" && !!row.archived_at && row.dates.includes(D.C3));
  const other = fakeSupabase();
  other.tables.user_cards.push({ id: 5, user_id: "someone-else", front: "x", back: "y", source: "cahier-upload" });
  const refused = await removeCard({ admin: other, userId: USER, rowId: 5 });
  ck("another student's card can't be removed", refused.status === 403 && !isOut(other.tables.user_cards[0]));
}

console.log("\n  the lesson sync uses the same rule");
{
  const lesson = { id: "imperatif", cards: [["Rends-moi mon livre !", "Give me my book back!", "V", "x"], ["Viens ici !", "Come here!", "V", "y"]] };
  const own = [{ f: "rends-moi mon livre", b: "give me back my book", source: "cahier-upload", row_id: 1 }];
  const { missing, taken } = reconcileLessons([lesson], own);
  ck("a lesson card the student already has, written another way, is not added", taken.some((t) => t.front === "Rends-moi mon livre !") && !missing.some((m) => m.front === "Rends-moi mon livre !"));
  ck("and the lesson's other cards are", missing.some((m) => m.front === "Viens ici !"));

  const lecon = { id: "lecon1", cards: [["Je vais bien", "I'm fine", "V"], ["Bonjour", "Hello", "V"], ["Salut !", "Hi!", "V"]] };
  const out = [
    { f: "Je vais bien", b: "I'm fine", source: `archived:lesson:lecon1#${lessonCardKey("Je vais bien")}`, row_id: 7, reason: "removed" },
    { f: "salut", b: "hi", source: "archived:cahier-upload", row_id: 8, reason: "removed" },
    { f: "Bonjour", b: "Hello", source: `archived:lesson:lecon1#${lessonCardKey("Bonjour")}`, row_id: 9, reason: null },
  ];
  const r = reconcileLessons([lecon], [], out);
  ck("a lesson card the student removed is not put back in study", r.away.some((a) => a.front === "Je vais bien") && !r.missing.some((m) => m.front === "Je vais bien"),
     JSON.stringify(r.missing.map((m) => m.front)));
  ck("nor one that is a card of their own they removed", r.taken.some((t) => t.front === "Salut !") && !r.missing.some((m) => m.front === "Salut !"));
  ck("a card a lesson dropped and brings back still comes back, history and all (owner, 2026-09-25)", r.missing.some((m) => m.front === "Bonjour"));
  ck("before migration_016 no row says why, and nothing changes", reconcileLessons([lecon], [], out.map((c) => ({ ...c, reason: null }))).missing.length === 3);
}

console.log("\n  Remove card in View feedback says why, as a student's Remove does");
for (const migrated of [true, false]) {
  const db = fakeSupabase({ migrated });
  db.tables.user_cards.push({ id: 77, user_id: USER, front: "estar", back: "to be", source: "cahier-upload", dates: [] });
  const store = supabaseFeedbackStore(db);
  const row = () => db.tables.user_cards.find((c) => c.id === 77);
  const off = await store.setSource(77, USER, "archived:cahier-upload");
  ck(`${migrated ? "after" : "before"} migration_016: the card is out of study${migrated ? ", marked removed" : ""}`,
     !off.error && isOut(row()) && (migrated ? row().archived_reason === "removed" : row().archived_reason === undefined), JSON.stringify(row()));
  const on = await store.setSource(77, USER, "cahier-upload");
  ck(`${migrated ? "after" : "before"} migration_016: Revert puts it back with no reason left on it`, !on.error && !isOut(row()) && (row().archived_reason ?? null) === null);
}

console.log("\n  the question: calls side by side, a failed call's cards wait, and a time limit");
{
  const many = Array.from({ length: PAIRS_PER_CALL * 3 }, (_, i) => ({ a: { front: `mot${i}`, back: `word ${i}` }, b: { front: `un mot${i}`, back: `a word ${i}` } }));
  resetCalls();
  claude.holdMs = 80;
  claude.mostAtOnce = 0;
  claude.failIf = (content) => content.includes('"un mot60"');
  const verdicts = await askSameCard({ apiKey: KEY, pairs: many });
  claude.failIf = null;
  claude.holdMs = 0;
  ck("the pairs go in calls of 50, several at a time", claude.mostAtOnce >= 2 && claude.mostAtOnce <= CALLS_AT_ONCE, `${claude.mostAtOnce} at once`);
  const unanswered = verdicts.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  ck("a call that fails leaves only its own pairs unanswered, to wait",
     unanswered.length === PAIRS_PER_CALL && unanswered[0] === PAIRS_PER_CALL && verdicts.filter(Boolean).length === PAIRS_PER_CALL * 2,
     `${unanswered.length} unanswered, from ${unanswered[0]}`);
  resetCalls();
  let late = null;
  await askSameCard({ apiKey: KEY, pairs: many.slice(0, 3), deadline: Date.now() + 1000 }).catch((e) => { late = e.message; });
  ck("with no time left it asks nothing and says why, so the cards wait", /time/.test(late || "") && claude.questions.length === 0, late);
  claude.questionFails = true;
  let down = null;
  await askSameCard({ apiKey: KEY, pairs: many.slice(0, 3) }).catch((e) => { down = e.message; });
  claude.questionFails = false;
  ck("when no call is answered it says so", !!down, down);
}

// ═════════════════════════════════════════════════════════════════════════
console.log("\n  before migration_016: everything keeps working, by class date");
{
  const admin = await usedDeck({ migrated: false });
  ck("removing works without the reason column: the card is out of study and kept", isOut(byFront(admin, "Naza")) && byFront(admin, "Naza").archived_reason === undefined);
  const before = snapshot(admin);
  resetCalls();
  const r = await upload(admin, NOTEBOOK_2);
  ck("an upload works", r.ok !== false, JSON.stringify(r).slice(0, 160));
  // By date only: the retyped class reads again (its cards only gain the
  // date), and a line added to an old class waits for the migration.
  headline("before migration_016, upload", admin, before, { expectNew: EXPECTED_NEW.filter((f) => f !== "un écureuil"), expectRead: ["C4", "C7", "C8"] });
  await secondTimeAsksNothing("before migration_016, upload", admin, () => upload(admin, NOTEBOOK_2));

  const admin2 = await usedDeck({ migrated: false, via: "sync" });
  const before2 = snapshot(admin2);
  doc.text = NOTEBOOK_2;
  resetCalls();
  const s = await syncAll(admin2);
  ck("the sync works", s.ok, JSON.stringify(s).slice(0, 160));
  headline("before migration_016, sync", admin2, before2, { expectNew: EXPECTED_NEW.filter((f) => f !== "un écureuil"), expectRead: ["C4", "C7", "C8"] });

  // The cards saved and the class not recorded (the link's update failing):
  // the next sync reads it again, and the rule keeps it to one card each.
  const admin3 = await usedDeck({ migrated: false, via: "sync" });
  const before3 = snapshot(admin3);
  const flaky = fakeSupabase({ migrated: false, tables: admin3.tables, faults: { update: { table: "cahier_links", times: 1 } } });
  doc.text = NOTEBOOK_2;
  resetCalls();
  const s1 = await sync(flaky);
  const s2 = await syncAll(flaky);
  ck("a sync whose record failed after its cards were saved reads the class again",
     !s1.ok && s2.ok && claude.reads.filter((x) => classOf(x) === "C7").length === 2, `${claude.reads.filter((x) => classOf(x) === "C7").length} readings of the class`);
  headline("before migration_016, the record failing after the cards", flaky, before3, {
    expectNew: EXPECTED_NEW.filter((f) => f !== "un écureuil"), readCheck: false,
  });

  const admin4 = await usedDeck({ migrated: false });
  const r4 = await upload(admin4, notebook(C1, C2, C4, C5, C6), { replace: true });
  ck("Replace works, taking cards out without deleting any", r4.ok !== false && isOut(byFront(admin4, "gratuit")) && cards(admin4).length === before.cards.length,
     JSON.stringify(r4).slice(0, 160));
}

server.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
