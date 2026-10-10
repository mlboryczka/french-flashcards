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
// A line of a class read a second time comes back with "(fam)" added, which
// the rule can't join and the question calls different. So any reading of a
// line already read shows up as an extra card, in every path (2026-10-06: the
// stand-in used to drop a full stop or flip a capital, which the rule always
// joins, and the sync could send whole old classes with every check green).
// The few tests where a line is rightly read twice (a class whose cards
// waited, a save that failed) switch to that gentler respelling.
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
import { readFileSync } from "node:fs";
import { checker } from "../check.mjs";
import { fakeSupabase } from "../fake-supabase.mjs";
import { localPostgres } from "../local-postgres.mjs";

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
  reads: [], questions: [], pairsAsked: [], questionFails: false, judge: null, seen: new Map(),
  // `readFailIf(lesson)` fails the reading of each class it picks.
  // `respell` is how a line read a second time comes back: "strict" adds
  // "(fam)", which makes a card of its own; "rule" drops a full stop or flips
  // the first capital, which the rule joins.
  readFailIf: null, respell: "strict",
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
    const read = { lesson, newLines: newPart ? lines : null };
    claude.reads.push(read);
    // A 400 is not retried by the SDK, so a failed reading fails at once.
    if (claude.readFailIf?.(lesson)) return reply("", 400);
    const cls = classKey(read);
    const cards = [];
    for (const line of lines) {
      const i = line.indexOf(" = ");
      if (i < 0) continue;
      let front = line.slice(0, i).trim();
      // A line of a class read a second time comes back spelt differently,
      // as the real model's do: this is how a re-read made a second card.
      const n = claude.seen.get(`${cls}|${line}`) || 0;
      claude.seen.set(`${cls}|${line}`, n + 1);
      if (n > 0 && claude.respell === "strict") front = `${front} (fam)`;
      else if (n > 0) front = front.endsWith(".") ? front.slice(0, -1) : `${front[0] === front[0].toUpperCase() ? front[0].toLowerCase() : front[0].toUpperCase()}${front.slice(1)}`;
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
// Which class a line belongs to, for "read before": the class it is in, by
// name, or else by its first card line.
const classKey = (read) => {
  const c = classOf(read);
  return c !== "?" ? c : read.lesson.split("\n").map((l) => l.trim()).find((l) => l.includes(" = ")) || "?";
};
// Readings of a class that went with only its new lines, and those lines.
const newLinesOf = (name) => claude.reads.filter((x) => classOf(x) === name).map((x) => (x.newLines ? x.newLines.join(" / ") : "the whole class"));

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
const { isSureMatch, cardIndex, formsOfOneWord } = await import("../../src/lib/sameCard.js");
const { matchNewCards, plannedWrites } = await import("../../src/lib/cardMatch.js");
const { reconcileLessons } = await import("../../src/lib/lessonSync.js");
const { lessonCardKey } = await import("../../src/lib/lessonSource.js");
const { askSameCard, PAIRS_PER_CALL, CALLS_AT_ONCE } = await import("../../api/_lib/sameCardQuestion.js");
const { uploadResultText, classDay } = await import("../../src/lib/uploadText.js");
const { updateCard } = await import("../../api/admin-update-card.js");
const { planReading } = await import("../../src/lib/notesLines.js");
const { sliceIntoBlocks, mergeRepeats } = await import("../../api/parse-cahier.js");
const { SAME_CARD_SYSTEM } = await import("../../api/_lib/sameCardQuestion.js");
const { lookalikes } = await import("../../src/lib/statusChecks.js");
const { classFingerprint } = await import("../../api/_lib/notesReading.js");
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
  claude.respell = "strict";
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
  // A repeat put away by the clean-up, a lesson card, a tutor card, and a
  // card added from a podcast passage (2026-10-09), which has no class dates
  // either and must be left alone the same way.
  cards(admin).push({ id: 9001, user_id: USER, front: "gratuit (adj)", back: "free", category: "V", dates: [D.C3], source: "archived:cahier-upload",
    fsrs_state: 0, en_fsrs_state: 0, ...(migrated ? { archived_reason: "duplicate", merged_into: byFront(admin, "gratuit").id } : {}) });
  cards(admin).push({ id: 9002, user_id: USER, front: "Je vais bien", back: "I'm fine", category: "V", dates: [], source: "lesson:lecon1#k9", fsrs_state: 2, en_fsrs_state: 0 });
  cards(admin).push({ id: 9003, user_id: USER, front: "une falaise", back: "a cliff", category: "V", dates: [], source: "tutor-chat", fsrs_state: 0, en_fsrs_state: 0 });
  cards(admin).push({ id: 9004, user_id: USER, front: "un cortège", back: "a protest march", category: "V", dates: [],
    source: "podcast:3f2a9c4e-0000-4000-8000-000000000001", fsrs_state: 0, en_fsrs_state: 0 });
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
    // A class with a line added (C6) or a typo fixed (C5) goes to Claude with
    // that line, and Claude is told to make cards from it only. Sent whole,
    // its old lines would be read again.
    const partly = { C5: "une proposition = a proposal", C6: "un écureuil = a squirrel" };
    const whole = Object.entries(partly).filter(([name, line]) => newLinesOf(name).some((l) => l !== line));
    ck(`${label}: an old class with a line added or fixed went with only that line`, whole.length === 0,
       whole.map(([name]) => `${name}: ${newLinesOf(name).join("; ")}`).join(" | "));
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
  ck(`${label}: the lesson, tutor and podcast cards are left as they were`,
     now.cards.find((r) => r.id === 9002)?.source === "lesson:lecon1#k9" && now.cards.find((r) => r.id === 9003)?.source === "tutor-chat" &&
     now.cards.find((r) => r.id === 9004)?.source === "podcast:3f2a9c4e-0000-4000-8000-000000000001");
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

  // The same words, or list parts, in another order, and "ils/elles" for
  // "ils" (2026-10-06). The near search compared whole fronts and list parts
  // against whole cards, never parts in another order, so each of these went
  // in as a second card with no question asked. Two are real: foisydm's
  // "amener / apporter" and "apporter, amener (ici)", a word taught again;
  // nguyen's "ils veulent" and "ils/elles veulent".
  const ORDER = [
    [["un vendeur / une vendeuse", "a salesman / a saleswoman"], ["une vendeuse / un vendeur", "a saleswoman / a salesman"]],
    [["au début / d'abord", "at first"], ["d'abord / au début", "first; at the beginning"]],
    [["vieux, vieille", "old"], ["vieille, vieux", "old"]],
    [["manquer / rater", "to miss"], ["rater / manquer", "to miss"]],
    [["amener / apporter", "to bring, to take"], ["apporter, amener (ici)", "to bring (here)"]],
    [["ils veulent", "they want"], ["ils/elles veulent", "they want"]],
    [["il dit", "he says / he tells"], ["il/elle/on dit", "he/she/we says / he/she/we tells"]],
    [["aux : à + les", "to the (contraction of à and les)"], ["À + LES : aux", "to the (contraction of à + les)"]],
  ];
  const slipped = [];
  for (const [[f1, b1], [f2, b2]] of ORDER) {
    const asked = [];
    const m = await matchNewCards({
      incoming: [{ front: f2, back: b2, dates: ["2026-01-05"] }],
      deck: [{ id: 1, front: f1, back: b1, dates: ["2025-11-04"], source: "cahier-upload" }],
      ask: async (pairs) => { asked.push(...pairs); return pairs.map(() => "same"); },
    });
    if (!(asked.length === 1 && m.decisions[0].action === "join" && m.decisions[0].row.id === 1)) slipped.push(`${f2}: ${m.decisions[0].action}, ${asked.length} asked`);
  }
  ck("the same words in another order, and \"il/elle\" for \"il\", are put to Claude, and its \"same\" joins them", slipped.length === 0, slipped.join("; "));
}

console.log("\n  keep apart: words that look alike are never joined by the rule, and a \"different\" answer keeps both");
{
  const PAIRS = [
    ["ou", "or", "où", "where"], ["la poste", "the post office", "le poste", "the job"], ["fin", "the end", "fin (adj)", "thin"],
    ["un état", "a state", "l'État", "the State"], ["voler", "to steal", "voler", "to fly"],
    ["planter", "to plant", "planter (fam)", "to ditch someone"], ["vieux", "old", "vieille", "old (feminine)"],
    ["encore meilleur / mieux", "even better", "mieux (adv)", "better"],
  ];
  // Two of demarajackson's cards the rule joined as one card twice
  // (2026-10-06): a label in brackets that repeats a card's own English still
  // tells two meanings apart, and "quite" or "was" in both English sides
  // isn't English that agrees.
  const RULE_ONLY = [
    ["pas mal", "not bad; quite good", "pas mal (quite a lot;)", "quite a lot; quite a bit; a good deal"],
    ["ça allait", "it was okay", "ça allait ?", "how was it going?"],
  ];
  const joined = [...PAIRS, ...RULE_ONLY].filter(([a, b, c, d]) => isSureMatch({ front: a, back: b }, { front: c, back: d }));
  ck("the fixed rule joins none of them, \"pas mal\" (not bad) and \"pas mal (quite a lot)\" included", joined.length === 0, joined.map((p) => `${p[0]} ~ ${p[2]}`).join(", "));

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

console.log("\n  a card that is one item of another card's list is that card (the owner, 2026-10-07)");
{
  // "à l'heure" beside "à temps / à l'heure" is one card twice. The rule is
  // sure of it when every word of the list's English is in the card's; the
  // others are put to Claude, whose question now says the same. Real pairs
  // from the students' decks.
  const ITEMS = [
    ["à temps / à l'heure", "on time", "à l'heure", "on time"],
    ["On y va / Allons-y", "Let's go", "Allons-y !", "Let's go!"],
    ["épais, épaisse", "thick", "épais", "thick"],
    ["un œil, des yeux", "an eye, eyes", "des yeux", "eyes"],
    ["un œil, des yeux", "an eye, eyes", "un œil", "an eye"],
    ["un infirmier, une infirmière", "a nurse (male/female)", "une infirmière", "a nurse (female)"],
    ["fin, fine", "thin; fine", "fin (thin; fine)", "thin; fine"],
    ["léger, légère (adj)", "light", "léger (adj)", "light"],
    ["frapper, taper", "to hit, to strike", "taper", "to hit, to strike"],
    ["tous les ans = chaque année", "every year", "tous les ans", "every year"],
    ["un cheveu, des cheveux", "a hair, hairs", "les cheveux", "the hair"],
  ];
  const missed = ITEMS.filter(([a, b, c, d]) => !isSureMatch({ front: a, back: b }, { front: c, back: d }) || !isSureMatch({ front: c, back: d }, { front: a, back: b }));
  ck("each item of a list card, with English that agrees, is surely that card, either way round", missed.length === 0, missed.map((m) => m[2]).join(", "));
  // What a list only seems to hold: a word inside a sentence with a comma,
  // different words grouped on one card, another meaning of the same
  // spelling, a word standing for a longer expression. All real.
  const APART = [
    ["se lever, acheter, amener", "to get up, to buy, to bring/take", "amener", "to bring (someone, towards here)"],
    ["En fait, ça veut dire que", "In fact, that means that", "en fait", "actually / in fact"],
    ["La semaine prochaine, il va faire froid", "Next week, it's going to be cold", "la semaine prochaine", "next week"],
    ["pour l'instant, ça va", "for now, it's going okay, for the moment, things are fine", "pour l'instant", "for now / for the moment"],
    ["Mon frère et moi, on est allés", "My brother and I went", "on est allés", "we went"],
    ["Aujourd'hui, c'est le 3 octobre", "Today is October 3rd", "aujourd'hui", "today"],
    ["Non, ils n'ont rien dit", "No, they didn't say anything / No, they said nothing", "Ils n'ont rien dit ?", "They didn't say anything? / Didn't they say anything?"],
    ["fin, fine", "thin; fine", "fin (end)", "end"],
    ["bon/mauvais", "right/wrong", "bon (adj)", "good"],
    ["une boîte / un club", "a nightclub / a club", "une boîte", "a box"],
    ["encore meilleur / mieux", "even better", "mieux (adv)", "better"],
    ["oui / non", "yes / no", "oui", "yes"],
    ["ensuite / après", "then / afterwards", "après", "after"],
  ];
  const swallowed = APART.filter(([a, b, c, d]) => isSureMatch({ front: a, back: b }, { front: c, back: d }));
  ck("the rule joins none of what a list only seems to hold, nor an item whose English is worded differently", swallowed.length === 0,
     swallowed.map((m) => `${m[2]} ~ ${m[0]}`).join(", "));
  const unasked = APART.filter(([a, b, c, d]) => !cardIndex([{ id: 1, front: a, back: b }]).near({ front: c, back: d }).length);
  ck("each of those is put to Claude instead", unasked.length === 0, unasked.map((m) => m[2]).join(", "));
  ck("and the question says an item of a list is the same card, and what a list only seems to hold is not",
     /one item of a list card[^\n]*"à l'heure" and "à temps \/ à l'heure"[^\n]*"après" \(after\) and "ensuite \/ après"/.test(SAME_CARD_SYSTEM) &&
       /inside a sentence, even after a comma: "en fait" and "En fait, ça veut dire que"/.test(SAME_CARD_SYSTEM) &&
       /only appear together on one card[^\n]*"amener" and "se lever, acheter, amener"/.test(SAME_CARD_SYSTEM) &&
       /a meaning other than the one the list teaches: "fin" \(the end\) and "fin, fine"/.test(SAME_CARD_SYSTEM));

  // The merge inside one reading: the item joins the list card, whichever
  // came first, and the list card is the one kept.
  const merged = mergeRepeats([
    { front: "à l'heure", back: "on time", category: "V", dates: ["2026-01-05"] },
    { front: "à temps / à l'heure", back: "on time", category: "V", dates: ["2026-01-12"] },
    { front: "épais, épaisse", back: "thick", category: "V", dates: ["2026-01-05"] },
    { front: "épais", back: "thick", category: "V", dates: ["2026-01-19"] },
    { front: "amener", back: "to bring", category: "V", dates: ["2026-01-05"] },
    { front: "se lever, acheter, amener", back: "to get up, to buy, to bring", category: "V", dates: ["2026-01-12"] },
  ]);
  ck("inside one reading, an item and its list card are one card: the list card, with both classes",
     merged.length === 4 && JSON.stringify(merged.find((c) => c.front === "à temps / à l'heure")?.dates) === '["2026-01-05","2026-01-12"]' &&
       JSON.stringify(merged.find((c) => c.front === "épais, épaisse")?.dates) === '["2026-01-05","2026-01-19"]' &&
       !merged.some((c) => c.front === "à l'heure" || c.front === "épais"),
     JSON.stringify(merged.map((c) => [c.front, c.dates])));
  ck("  but not different words grouped on one card", merged.some((c) => c.front === "amener") && merged.some((c) => c.front === "se lever, acheter, amener"));
  // A list card read after two of its items takes in both (2026-10-07). It
  // used to take the place of only the first item it found, and the other
  // was left beside it: "à l'heure", "à temps", then "à temps / à l'heure"
  // gave "à l'heure" and the list card, and the card-writer then joined the
  // list card to "à l'heure", so "à temps" was never made. The owner's
  // "rater", "manquer" and "manquer / rater" went the same way.
  const V = (front, back, date) => ({ front, back, category: "V", dates: [date] });
  const both = [
    [V("à l'heure", "on time", "2026-01-05"), V("à temps", "on time", "2026-01-12"), V("à temps / à l'heure", "on time", "2026-01-19")],
    [V("rater", "to miss", "2025-12-01"), V("manquer", "to miss", "2025-12-24"), V("manquer / rater", "to miss", "2025-12-24")],
  ].map((group) => mergeRepeats(group));
  ck("inside one reading, a list card read after two of its items is one card with every class",
     both.every((m) => m.length === 1) && JSON.stringify(both[0][0].dates) === '["2026-01-05","2026-01-12","2026-01-19"]' &&
       both[0][0].front === "à temps / à l'heure" && both[1][0].front === "manquer / rater",
     JSON.stringify(both.map((m) => m.map((c) => [c.front, c.dates]))));
  // An item read again after the list card took its place lands on the list
  // card, its class date with it: through the copy the list card replaced
  // when the rule finds only that copy ("in time" agrees with "on time", but
  // not every word of the list's English is in it).
  const again = [
    mergeRepeats([V("à l'heure", "on time", "2026-01-05"), V("à temps / à l'heure", "on time", "2026-01-12"), V("à l'heure", "on time", "2026-01-19")]),
    mergeRepeats([V("à l'heure", "on time", "2026-01-05"), V("à temps / à l'heure", "on time", "2026-01-12"), V("à l'heure", "in time", "2026-01-19")]),
  ];
  ck("  an item, its list card, then the item again: one card, the list card, with all three classes",
     again.every((m) => m.length === 1 && m[0].front === "à temps / à l'heure" && JSON.stringify(m[0].dates) === '["2026-01-05","2026-01-12","2026-01-19"]'),
     JSON.stringify(again.map((m) => m.map((c) => [c.front, c.dates]))));

  // A new list card is never joined to one of its items the student has
  // (2026-10-07). The owner's "taper" (to hit, to strike) was made on 15
  // April, and "frapper, taper" on 4 September only added a date to it:
  // their one "frapper" card was lost. Now the item they have gains the
  // date, and each other item becomes a card. 31 such pairs were in the
  // live decks, the list made after the item.
  const REVERSE = [
    [{ front: "taper", back: "to hit, to strike" }, { front: "frapper, taper", back: "to hit, to strike" }, "frapper"],
    [{ front: "à l'heure", back: "on time" }, { front: "à temps / à l'heure", back: "on time" }, "à temps"],
    [{ front: "connu", back: "known, famous" }, { front: "connu/célèbre", back: "known, famous" }, "célèbre"],
    [{ front: "un(e) coloc", back: "a roommate" }, { front: "un(e) colocataire, un(e) coloc", back: "a roommate" }, "un(e) colocataire"],
  ];
  const lost = [];
  for (const [have, list, word] of REVERSE) {
    for (const source of ["cahier-upload", "archived:cahier-upload"]) {
      const asked = [];
      const m = await matchNewCards({
        incoming: [{ ...list, category: "V", dates: ["2026-09-04"] }],
        deck: [{ id: 1, ...have, dates: ["2026-04-15"], source }],
        ask: async (pairs) => { asked.push(...pairs); return pairs.map(() => "same"); },
      });
      const joined = m.decisions.find((d) => d.action === "join");
      const made = m.decisions.filter((d) => d.action === "insert").map((d) => d.insert);
      if (!(asked.length === 0 && joined?.row.id === 1 && joined.card.front === have.front && made.length === 1 && made[0].front === word &&
            made[0].back === list.back && JSON.stringify(made[0].dates) === '["2026-09-04"]' && m.decisions.length === 2)) {
        lost.push(`${list.front} beside ${source === "cahier-upload" ? "" : "a removed "}${have.front}: ${m.decisions.map((d) => `${d.card.front} ${d.action}`).join(", ")}, ${asked.length} asked`);
      }
    }
  }
  ck("a new list card beside one of its items: the item gains the date and the list's other word becomes a card, with no question",
     lost.length === 0, lost.join("; "));
  ck("  and the card the student removed stays removed: only the new word goes into study",
     (await matchNewCards({ incoming: [{ front: "frapper, taper", back: "to hit, to strike", dates: ["2026-09-04"] }],
       deck: [{ id: 1, front: "taper", back: "to hit, to strike", dates: [], source: "archived:cahier-upload" }], ask: async () => [] }))
       .decisions.every((d) => (d.card.front === "taper" ? d.action === "join" && d.row.source.startsWith("archived:") : d.action === "insert")));
  // But a list card that holds only forms of the word the student has is
  // that card: "bon, bonne" beside "bon" adds a date to "bon", as before.
  // Of the 31 real pairs, 25 are such forms ("lent, lente", "un joueur, une
  // joueuse", "frais, fraîche", "15 = quinze"); a card of its own for each
  // feminine, with the same English, would be a card asked "good" whose
  // answer "bon" is marked wrong. The other words become cards.
  const FORMS = [
    [["bon", "good"], ["bon, bonne", "good"], []],
    [["un joueur", "a player"], ["un joueur, une joueuse", "a player"], []],
    [["frais (adj)", "fresh"], ["frais, fraîche", "fresh"], []],
    [["vieux (adj)", "old"], ["vieux, vieille", "old"], []],
    [["les cheveux", "the hair"], ["un cheveu, des cheveux", "a hair, hair"], []],
    [["quinze", "fifteen"], ["15 = quinze", "fifteen"], []],
    [["un connard", "a jerk"], ["un connard, une connasse", "a jerk"], ["une connasse"]],
  ];
  const formsWrong = [];
  for (const [[f1, b1], [f2, b2], made] of FORMS) {
    const asked = [];
    const m = await matchNewCards({
      incoming: [{ front: f2, back: b2, dates: ["2026-09-04"] }],
      deck: [{ id: 1, front: f1, back: b1, dates: ["2026-04-15"], source: "cahier-upload" }],
      ask: async (pairs) => { asked.push(...pairs); return pairs.map(() => "different"); },
    });
    const w = plannedWrites(m.decisions);
    if (JSON.stringify(w.inserts.map((i) => i.front)) !== JSON.stringify(made) || w.updates[0]?.id !== 1 || asked.length) {
      formsWrong.push(`${f2} beside ${f1}: new ${w.inserts.map((i) => i.front).join(", ") || "none"}, ${asked.length} asked`);
    }
  }
  ck("  a new list card of forms of the word the student has only adds its date; a different word on it becomes a card",
     formsWrong.length === 0, formsWrong.join("; "));
  const isForm = [["japonais", "japonaise"], ["étranger", "étrangère"], ["conservateur", "conservatrice (adj)"], ["un infirmier", "une infirmière"],
    ["beau", "belle"], ["gentil", "gentille"], ["un cheval", "des chevaux"], ["secret (adj)", "secrète"], ["significatif", "significative"]];
  const notForm = [["frapper", "taper"], ["à temps", "à l'heure"], ["un(e) colocataire", "un(e) coloc"], ["connu", "célèbre"], ["un connard", "une connasse"],
    ["soir", "soirée"], ["jour", "journée"], ["un an", "une année"], ["matin", "matinée"], ["manquer", "rater"]];
  ck("  forms of one word, told from different words",
     isForm.every(([a, b]) => formsOfOneWord(a, b) && formsOfOneWord(b, a)) && notForm.every(([a, b]) => !formsOfOneWord(a, b)),
     JSON.stringify([isForm.filter(([a, b]) => !formsOfOneWord(a, b)), notForm.filter(([a, b]) => formsOfOneWord(a, b))]));
  {
    const m = await matchNewCards({
      incoming: [{ front: "bon, bonne", back: "good, fine", dates: ["2026-09-04"] }],
      deck: [{ id: 1, front: "bon", back: "good", dates: ["2026-04-15"], source: "cahier-upload" }],
      ask: async (pairs) => pairs.map(() => "same"),
    });
    ck("  and so when Claude calls such a list card the same as the word the student has",
       m.decisions.length === 2 && m.decisions.every((d) => d.action === "join" && d.row.id === 1), JSON.stringify(m.decisions.map((d) => [d.card.front, d.action])));
  }
  // The same when Claude calls the list card the same card as an item whose
  // English is worded differently: "après" (after) gains the date, and
  // "ensuite" becomes a card. A "different" keeps the list card whole, and
  // no answer leaves it waiting.
  const apres = (verdict) => matchNewCards({
    incoming: [{ front: "ensuite / après", back: "then / afterwards", category: "V", dates: ["2026-09-04"] }],
    deck: [{ id: 1, front: "après", back: "after", dates: ["2026-04-15"], source: "cahier-upload" }],
    ask: async (pairs) => pairs.map(() => verdict),
  });
  const [same, different, none] = [await apres("same"), await apres("different"), await apres(null)];
  ck("  Claude's \"same\" for a new list card and one of its items: that item gains the date, and the other becomes a card",
     same.decisions.length === 2 && same.decisions.some((d) => d.card.front === "après" && d.action === "join" && d.row.id === 1) &&
       same.decisions.some((d) => d.action === "insert" && d.insert.front === "ensuite" && d.insert.back === "then / afterwards"),
     JSON.stringify(same.decisions.map((d) => [d.card.front, d.action])));
  ck("  its \"different\" makes the list card, and no answer leaves it waiting",
     different.decisions.length === 1 && different.decisions[0].insert?.front === "ensuite / après" &&
       none.decisions.length === 1 && none.decisions[0].action === "wait",
     JSON.stringify([different.decisions.map((d) => [d.card.front, d.action]), none.decisions.map((d) => [d.card.front, d.action])]));

  // The upload and the sync, against a deck with the list cards: an item
  // the rule is sure of only adds its class date, with no question; one
  // worded differently is put to Claude, and its "same" adds the date; what
  // a list only seems to hold is put to Claude, and its "different" adds a
  // card.
  const LISTS = C("Le 5 janvier 2026", "à temps / à l'heure = on time", "ensuite / après = then / afterwards",
    "se lever, acheter, amener = to get up, to buy, to bring", "un œil, des yeux = an eye, eyes");
  const ITEMS_CLASS = C("Le 12 janvier 2026", "à l'heure = on time", "après = after", "amener = to bring", "des yeux = eyes", "une montagne = a mountain");
  const judge = (a, b) => (pairKey(a, b) === pairKey("ensuite / après", "après") ? "same" : "different");
  for (const via of ["upload", "sync"]) {
    const admin = fakeSupabase();
    claude.seen = new Map();
    claude.respell = "strict";
    if (via === "upload") await upload(admin, notebook(LISTS));
    else { doc.text = notebook(LISTS); await syncAll(admin, { url: URL_1 }); }
    resetCalls();
    claude.judge = judge;
    const r = via === "upload" ? await upload(admin, notebook(LISTS, ITEMS_CLASS)) : (doc.text = notebook(LISTS, ITEMS_CLASS), await syncAll(admin));
    claude.judge = null;
    const asked = claude.pairsAsked.map((p) => p.b);
    const live = inStudy(admin).map((c) => c.front).sort();
    ck(`${via}: an item of a list card only adds its class date to the list card`,
       r.ok !== false && byFront(admin, "à temps / à l'heure").dates.includes("2026-01-12") && byFront(admin, "un œil, des yeux").dates.includes("2026-01-12") &&
         !live.includes("à l'heure") && !live.includes("des yeux"), JSON.stringify(live));
    ck(`${via}: the rule settles those with no question asked`, !asked.includes("à l'heure") && !asked.includes("des yeux"), asked.join(" | "));
    ck(`${via}: one worded differently is put to Claude, and its "same" adds the date`,
       asked.includes("après") && !live.includes("après") && byFront(admin, "ensuite / après").dates.includes("2026-01-12"), asked.join(" | "));
    ck(`${via}: what a list only seems to hold is put to Claude, and its "different" makes a card`,
       asked.includes("amener") && live.includes("amener") && live.includes("une montagne") && live.length === 6, JSON.stringify(live));
  }
  // The other way round: the items first, the list cards in a later class.
  // Each list's words the student hasn't got become cards; the items they
  // have only gain the class date; what a list only seems to hold stays one
  // list card.
  const LISTS_LATER = { ...LISTS, dateLine: "Le 19 janvier 2026" };
  for (const via of ["upload", "sync"]) {
    const admin = fakeSupabase();
    claude.seen = new Map();
    claude.respell = "strict";
    if (via === "upload") await upload(admin, notebook(ITEMS_CLASS));
    else { doc.text = notebook(ITEMS_CLASS); await syncAll(admin, { url: URL_1 }); }
    resetCalls();
    claude.judge = judge;
    const r = via === "upload" ? await upload(admin, notebook(ITEMS_CLASS, LISTS_LATER)) : (doc.text = notebook(ITEMS_CLASS, LISTS_LATER), await syncAll(admin));
    claude.judge = null;
    const live = inStudy(admin).map((c) => c.front).sort();
    const want = ["à l'heure", "à temps", "après", "amener", "des yeux", "ensuite", "se lever, acheter, amener", "un œil", "une montagne"].sort();
    ck(`${via}: list cards after their items: the words the student hasn't got become cards, and nothing is lost`,
       r.ok !== false && JSON.stringify(live) === JSON.stringify(want), JSON.stringify(live));
    ck(`${via}: the items they have gain the later class's date`,
       ["à l'heure", "après", "des yeux"].every((f) => byFront(admin, f).dates.includes("2026-01-19")) && byFront(admin, "à temps")?.dates.join() === "2026-01-19");
    const rows = inStudy(admin);
    const twice = rows.flatMap((a, i) => rows.slice(i + 1).filter((b) => isSureMatch(a, b)).map((b) => `${a.front} ~ ${b.front}`));
    ck(`${via}: and no card in study is one item of another's list`, twice.length === 0, twice.join("; "));
  }
  // One reading with two items and their list card makes the list card
  // alone, with every class, whichever way round the notes have them (the
  // newest class is read first).
  {
    const got = [];
    for (const order of [[0, 1, 2], [2, 1, 0]]) {
      const classes = [C("Le 5 janvier 2026", "à l'heure = on time"), C("Le 12 janvier 2026", "à temps = on time"), C("Le 19 janvier 2026", "à temps / à l'heure = on time")];
      const admin = fakeSupabase();
      claude.seen = new Map();
      const r = await upload(admin, notebook(...order.map((i) => classes[i])));
      got.push(r.ok !== false && JSON.stringify(inStudy(admin).map((c) => [c.front, c.dates])));
    }
    ck("one upload with two items and their list card, in either order: the list card alone, with all three classes",
       got.every((g) => g === JSON.stringify([["à temps / à l'heure", ["2026-01-05", "2026-01-12", "2026-01-19"]]])), got.join(" | "));
  }
}

console.log("\n  a class held over two days is one class, dated its first day (2026-10-07)");
{
  for (const line of ["Le 28 et 29 septembre 2026", "Les 28 et 29 septembre 2026", "Le 28 & 29 septembre 2026", "Le 28, 29 et 30 septembre 2026"]) {
    const text = notebook(C("Le 25 septembre 2026", "actualiser = to refresh", "un résumé = a summary"),
      C(line, "la queue = the line", "pas grand chose à dire = not much to say"), C("Le 30 septembre 2026", "un costume = a suit", "en Asie = in Asia"));
    const blocks = sliceIntoBlocks(text);
    const b = blocks.find((x) => x.date === "2026-09-28");
    ck(`"${line}" starts a class dated 2026-09-28, with its own lines`,
       blocks.length === 3 && !!b && /la queue/.test(b.text) && !blocks.some((x) => x.date !== "2026-09-28" && /la queue/.test(x.text)),
       JSON.stringify(blocks.map((x) => [x.date, x.text.split("\n").length])));
  }
  ck("and \"Le 1er et 2 octobre 2026\" is dated the 1st", sliceIntoBlocks(notebook(C("Le 1er et 2 octobre 2026", "l'espoir = hope", "faire le ménage = to clean")))[0]?.date === "2026-10-01");
  // The owner's notes as they are (2026-10-07): the class used to be read as
  // the end of the 30 September class and cut off with its homework.
  const owner = "Le 30 septembre 2026\n\nVocabulaire\n\tExpressions\n\ts’asseoir\nun costume\n\tPour la prochaine fois :\n\n\n" +
    "Le 28 et 29 septembre 2026\n\nVocabulaire\n\tExpressions\n\tla queue\nespagnol (adj)\n\tpas grand chose à dire\nil y a personne\n\tPour la prochaine fois :\n";
  const ob = sliceIntoBlocks(owner);
  ck("in the owner's own layout, its lines are no longer cut off with the class above's homework",
     ob.length === 2 && /pas grand chose à dire/.test(ob.find((x) => x.date === "2026-09-28")?.text || ""), JSON.stringify(ob));
  const admin = fakeSupabase();
  claude.seen = new Map();
  await upload(admin, notebook(C("Le 30 septembre 2026", "un costume = a suit"), C("Le 28 et 29 septembre 2026", "la queue = the line", "il y a personne = there's nobody")));
  ck("an upload makes its cards, dated the class's first day", JSON.stringify(byFront(admin, "la queue")?.dates) === '["2026-09-28"]' &&
     JSON.stringify(byFront(admin, "il y a personne")?.dates) === '["2026-09-28"]', JSON.stringify(cards(admin).map((c) => [c.front, c.dates])));
}

console.log("\n  the upload's message says one as one (2026-10-07)");
{
  const left = uploadResultText({ cardsInserted: 0, classesUnchanged: 250, classesLeftForLink: 50 });
  ck("a pasted upload doesn't claim everything is in the deck while the linked notes still have classes to check",
     !/everything in these notes is already in your deck/.test(left) && /50 classes are also in your linked notes, which will check them/.test(left), left);
  ck("and says one class in the singular",
     /1 class is also in your linked notes, which will check it/.test(uploadResultText({ classesLeftForLink: 1 })));
  const one = uploadResultText({ cardsInserted: 0, replaceWaits: 1 });
  ck("one card from another class before the migration", one.includes("and your card from another class stays as it is.") && !/1 card from other classes stay/.test(one), one);
  ck("several", uploadResultText({ replaceWaits: 3 }).includes("and your 3 cards from other classes stay as they are."));
  const out1 = uploadResultText({ keptOutOfStudy: 1 });
  ck("one card taken out", out1.includes("1 card you never answered is from a class not in this upload: it is out of study now, and kept.") && !/their progress/.test(out1), out1);
  const failed1 = uploadResultText({ cardsFailed: 1, failedFronts: ["une phrase"] });
  ck("one card refused: its French, not \"for example\", and that line",
     failed1.includes('1 card couldn\'t be saved ("une phrase"). Check that line in your notes: once it is changed, the next upload reads it again.'), failed1);
  const failed3 = uploadResultText({ cardsFailed: 3, failedFronts: ["une phrase"] });
  ck("several refused: those lines", failed3.includes('3 cards couldn\'t be saved (for example "une phrase"). Check those lines in your notes: once they are changed, the next upload reads them again.'), failed3);
  ck("one answered card left in study", uploadResultText({ answeredStay: 1 }).includes("1 card you have answered is from a class not in this upload. It stays in study"));
}

// ── The headline test, in every way the notes come in ────────────────────
let beforeOf = () => null;
async function headlineVia(label, { build = "upload", run, readCheck = true, expectRead } = {}) {
  console.log(`\n  ${label}`);
  const admin = await usedDeck({ via: build });
  const before = snapshot(admin);
  beforeOf = (row) => before.cards.find((b) => b.id === row.id) || null;
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
  // "une propositiond" already had its class date: it is not a word that got
  // one (the reply said 25 here, and 24 had).
  const gained = admin.tables.user_cards.filter((row) => (row.dates || []).length > (beforeOf(row)?.dates || []).length && beforeOf(row)).length;
  ck("upload: \"words you already have\" counts only cards that gained a class date", r.cardsSeenAgain === gained, `${r.cardsSeenAgain} said, ${gained} gained`);
  const text = uploadResultText(r);
  ck("upload: the message says what happened, and nothing that didn't",
     text.includes("5 new cards added to your deck.") && text.includes("4 classes were already read and left as they are.") &&
       text.includes(`${gained} words you already have got the new class date.`) && !/everything in these notes|couldn't|wait/.test(text), text);
  const pairs = admin.tables.card_pairs;
  // "manquer" is an item of a list card the student has, and the new
  // "japonais, japonaise" holds their "japonais" and its feminine: the rule
  // settles both without a question (2026-10-07).
  ck("upload: each of Claude's answers is kept, with the question's version",
     pairs.length >= 5 && pairs.every((p) => p.version && /^[0-9a-f]{7}$/.test(p.version) && p.card_a) &&
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
  claude.respell = "rule"; // nothing was saved, so reading those lines again is right
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
  ck("and the message doesn't say everything is already in the deck", /1 card couldn't be saved \("une phrase/.test(uploadResultText(r)) &&
     /Check that line in your notes: once it is changed, the next upload reads it again\./.test(uploadResultText(r)) &&
     !/everything in these notes/.test(uploadResultText(r)), uploadResultText(r));
  headline("one card refused", admin, before);
  await secondTimeAsksNothing("one card refused", admin, () => upload(admin, withBad));
  // Replace still works when a card is refused; it used to quietly become an add.
  const admin2 = await usedDeck();
  const r2 = await upload(admin2, notebook(C1, C2, C4, C5, C6, { ...C7, lines: [`${tooLong} = a long sentence`, "une colline = a hill"] }), { replace: true });
  ck("a refused card doesn't turn Replace into an add", r2.cardsFailed === 1 && r2.keptOutOfStudy > 0 && isOut(byFront(admin2, "un ami")),
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
  const waitText = uploadResultText(r1);
  ck("the message names the classes that wait, and doesn't say everything is already in the deck",
     r1.waitingClasses?.length > 0 && waitText.includes(classDay(r1.waitingClasses[0])) && waitText.includes(classDay(r1.waitingClasses.at(-1))) &&
       /wait until your next upload/.test(waitText) &&
       !/everything in these notes/.test(waitText), waitText);
  resetCalls();
  claude.respell = "rule"; // the waiting classes' lines weren't recorded, so they are read again
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
  // "gratuit" is answered: it stays in study whatever the classes say
  // (2026-10-07). The other three never were.
  const c3 = ["enervé (adj)", "manquer / rater", "un ami"];
  ck("cards never answered with none of their classes in the upload leave study, marked replaced",
     r.ok !== false && r.keptOutOfStudy === 3 && c3.every((f) => isOut(byFront(admin, f)) && byFront(admin, f).archived_reason === "replaced"),
     JSON.stringify(c3.map((f) => byFront(admin, f)?.source)));
  ck("an answered card stays in study, schedule and all, whatever the classes say",
     !isOut(byFront(admin, "gratuit")) && byFront(admin, "gratuit").stability === 5.5 && r.answeredStay === 1, JSON.stringify({ answeredStay: r.answeredStay }));
  ck("and the message says so plainly",
     uploadResultText(r).includes("3 cards you never answered are from classes not in this upload: they are out of study now, and kept.") &&
       uploadResultText(r).includes("1 card you have answered is from a class not in this upload. It stays in study: replacing your deck never takes out a card you have answered."),
     uploadResultText(r));
  ck("nothing is deleted", cards(admin).length === before.cards.length);
  // The database holds to it too, whatever it is asked (migration_016's
  // save_notes_reading, written out in tests/fake-supabase.mjs).
  {
    const db = fakeSupabase();
    db.tables.user_cards.push(
      { id: 1, user_id: USER, front: "pas grand chose à dire", back: "not much to say", dates: [], source: "cahier-upload", fsrs_state: 2, en_fsrs_state: 0 },
      { id: 2, user_id: USER, front: "en anglais", back: "in English", dates: [], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 1 },
      { id: 3, user_id: USER, front: "jamais vu", back: "never seen", dates: [], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 });
    db.tables.notes_read.push({ user_id: USER, classes: {}, run_id: "run-1" });
    const { data } = await db.rpc("save_notes_reading", { p_user_id: USER, p_run_id: "run-1", p_archive: [1, 2, 3].map((id) => ({ id, reason: "replaced" })) });
    ck("the save itself never takes an answered card out for a Replace, either way round",
       data?.archived === 1 && !isOut(db.tables.user_cards[0]) && !isOut(db.tables.user_cards[1]) && isOut(db.tables.user_cards[2]), JSON.stringify(data));
  }
  // That copy is written out by hand, so the SQL itself is checked too: its
  // refusal is a clause of save_notes_reading's step that takes cards out,
  // and deleting it broke no test (2026-10-07). The clause must be there and
  // name all six signs of an answer, the same six the copy and the app
  // (src/lib/replaceDeck.js's answered) look at.
  {
    const sql = readFileSync(new URL("../../migrations/migration_016_notes_read_once.sql", import.meta.url), "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function public.save_notes_reading("));
    const body = fn.slice(0, fn.indexOf("$$;")).replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
    const step = /update public\.user_cards c set source = 'archived:' \|\| coalesce\(c\.source, ''\), archived_reason = a\.reason.*?returning c\.id/.exec(body)?.[0] || "";
    const clause = /and \(a\.reason is distinct from 'replaced' or \((.*?)\)\) returning/.exec(step)?.[1] || "";
    const SIX = ["coalesce(c.fsrs_state, 0) = 0", "coalesce(c.en_fsrs_state, 0) = 0", "coalesce(c.reps, 0) = 0", "coalesce(c.en_reps, 0) = 0",
      "c.last_review is null", "c.en_last_review is null"];
    const missing = SIX.filter((t) => !clause.split(" and ").map((x) => x.trim()).includes(t));
    ck("migration_016's own save refuses a Replace of an answered card: the clause is there, naming all six signs of an answer",
       !!step && !!clause && missing.length === 0, step ? `missing: ${missing.join(", ") || "none"}` : "no archive step found");
    const fake = readFileSync(new URL("../fake-supabase.mjs", import.meta.url), "utf8");
    const copy = /const answeredRow = \(r\) => ([^;]*);/.exec(fake)?.[1] || "";
    ck("  and the hand-written copy the tests run looks at the same six",
       ["fsrs_state", "en_fsrs_state", "reps", "en_reps", "last_review", "en_last_review"].every((col) => new RegExp(`r\\.${col}\\b`).test(copy)), copy);
  }
  // Where this machine has Postgres, the real function is run on real rows.
  {
    const { db: pg, why } = await localPostgres();
    if (!pg) console.log(`  (not run here: the real save_notes_reading on a local Postgres; ${why})`);
    else {
      try {
        const U = "00000000-0000-0000-0000-0000000000a1", RUN = "11111111-1111-1111-1111-111111111111";
        // One card for each sign of an answer, alone, so leaving any one of
        // them out of the clause shows; one never answered; and one answered
        // that the student removes.
        const SIGNS = [["fsrs_state", "2"], ["en_fsrs_state", "1"], ["reps", "3"], ["en_reps", "2"], ["last_review", "now()"], ["en_last_review", "now()"]];
        const values = SIGNS.map(([col, v], i) =>
          `(${9001 + i}, '${U}', 'carte ${i + 1}', 'card ${i + 1}', 'cahier-upload', ${["fsrs_state", "en_fsrs_state", "reps", "en_reps", "last_review", "en_last_review"].map((c) => (c === col ? v : c.endsWith("review") ? "null" : "0")).join(", ")})`);
        const setup = pg.sql(`
          insert into auth.users (id) values ('${U}');
          insert into public.user_cards (id, user_id, front, back, source, fsrs_state, en_fsrs_state, reps, en_reps, last_review, en_last_review) values
            ${values.join(",\n            ")},
            (9007, '${U}', 'jamais vu', 'never seen', 'cahier-upload', 0, 0, 0, 0, null, null),
            (9008, '${U}', 'déjà vu', 'already seen', 'cahier-upload', 2, 0, 4, 0, now(), null);
          insert into public.notes_read (user_id, run_id) values ('${U}', '${RUN}');`);
        const saved = pg.sql(`select public.save_notes_reading('${U}', '${RUN}', p_archive => '${JSON.stringify(
          [9001, 9002, 9003, 9004, 9005, 9006, 9007].map((id) => ({ id, reason: "replaced" })).concat([{ id: 9008, reason: "removed" }]))}'::jsonb) ->> 'archived'`);
        const rows = pg.sql(`select string_agg(id || ':' || coalesce(archived_reason, 'in study'), ', ' order by id) from public.user_cards where user_id = '${U}'`);
        const want = [...SIGNS.map((_, i) => `${9001 + i}:in study`), "9007:replaced", "9008:removed"].join(", ");
        ck("on a local Postgres, the real save takes out for a Replace only the card never answered, whichever sign of an answer a card has; a card the student removes goes out answered or not",
           setup.ok && saved.out === "2" && rows.out === want, `${setup.err || saved.err || ""} archived ${saved.out}: ${rows.out}`);
      } finally {
        pg.stop();
      }
    }
  }
  ck("the removed card stays removed", byFront(admin, "Naza").archived_reason === "removed");
  ck("lesson and tutor cards are left alone", !isOut(byFront(admin, "Je vais bien")) && !isOut(byFront(admin, "une falaise")));
  ck("the other classes are untouched", ["soulagé (adj)", "le soleil", "le travail"].every((f) => !isOut(byFront(admin, f))));
  const added = await upload(admin, notebook(C1, C2, C3, C4, C5, C6));
  ck("an upload that adds brings none of them back", added.ok !== false && c3.every((f) => isOut(byFront(admin, f))));
  const back = await upload(admin, notebook(C1, C2, C3, C4, C5, C6), { replace: true });
  ck("a Replace with the class again brings its cards back",
     back.broughtBack === 3 && c3.every((f) => !isOut(byFront(admin, f))) && byFront(admin, "gratuit").stability === 5.5, JSON.stringify(back).slice(0, 160));
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
  // With no lines on record, a class under a retyped date can't be known by
  // them, so it is read again and the rule keeps its words to their cards.
  claude.respell = "rule";
  const r = await upload(admin, NOTEBOOK_2);
  ck("classes whose dates are on cards are not read", r.ok !== false && !classesRead().some((c) => ["C1", "C2", "C3", "C5", "C6"].includes(c)), classesRead().join(","));
  headline("first run after the fix", admin, before, {
    readCheck: false,
    // A line added to a class the record had no lines for can't be told apart.
    expectNew: EXPECTED_NEW.filter((f) => f !== "un écureuil"),
  });
  await secondTimeAsksNothing("first run after the fix", admin, () => upload(admin, NOTEBOOK_2));
}

console.log("\n  the first run after the fix: a class the linked notebook read when it was shorter (2026-10-07)");
{
  // The link keeps a fingerprint of each class as it read it. The owner's
  // 2 October class was read with 4 lines and has 16 now; counting all 16 as
  // read would mean the 12 added since never become cards. Where the
  // fingerprint no longer matches, only lines on a card count as read. Where
  // it matches, or there is none, the class counts as read whole, as before,
  // a line that made no card (a grammar rule) included.
  //
  // A line is on a card in four ways (src/lib/notesLines.js's lineMatcher):
  // a card's French, one part of a list card ("rater" of "manquer / rater"),
  // a drill's answer ("Je vais au cinéma"), and two words with " // " between
  // them that each have a card ("le jour // la journée"). The class gained
  // one line of each besides the two on no card; only those two are read.
  const K1 = C("Le 1 décembre 2025", "un lit = a bed", "une table = a table", "moins + adj / moins de + nom");
  const K2 = C("Le 8 décembre 2025", "une lampe = a lamp", "un tapis = a rug");
  const ON_CARDS = ["rater = to miss", "Je vais au cinéma", "le jour // la journée"];
  const K2b = { ...K2, lines: [...K2.lines, "se moucher = to blow one's nose", ...ON_CARDS, "à partir de lundi = from Monday"] };
  const NEW_LINES = ["se moucher = to blow one's nose", "à partir de lundi = from Monday"];
  const DK1 = "2025-12-01", DK2 = "2025-12-08";
  const textOf = (nb, date) => sliceIntoBlocks(nb).find((b) => b.date === date).text;
  const deckRows = () => [
    { id: 1, user_id: USER, front: "un lit", back: "a bed", dates: [DK1], source: "cahier-upload", fsrs_state: 2, en_fsrs_state: 0 },
    { id: 2, user_id: USER, front: "une table", back: "a table", dates: [DK1], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 },
    { id: 3, user_id: USER, front: "une lampe", back: "a lamp", dates: [DK2], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 },
    { id: 4, user_id: USER, front: "Un tapis.", back: "a rug", dates: [DK2], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 },
    { id: 5, user_id: USER, front: "manquer / rater", back: "to miss", dates: ["2025-11-03"], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 },
    { id: 6, user_id: USER, front: "Je (aller) → au cinéma", back: "Je vais au cinéma", dates: ["2025-11-03"], source: "conjugation-drill", fsrs_state: 0, en_fsrs_state: 0 },
    { id: 7, user_id: USER, front: "le jour", back: "the day", dates: ["2025-11-03"], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 },
    { id: 8, user_id: USER, front: "la journée", back: "the day (its length)", dates: ["2025-11-03"], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0 },
  ];
  const DECK = deckRows().length;
  const linkWith = (k2) => ({ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: { [DK1]: classFingerprint(textOf(notebook(K1), DK1)), [DK2]: k2 } });
  const setup = (k2, { migrated = true } = {}) => {
    const admin = fakeSupabase({ migrated });
    admin.tables.user_cards.push(...deckRows());
    admin.tables.cahier_links.push(linkWith(k2));
    claude.seen = new Map();
    claude.respell = "strict";
    resetCalls();
    return admin;
  };
  const shorter = classFingerprint(textOf(notebook(K2), DK2));
  const recorded = (admin) => admin.tables.notes_read.find((r) => r.user_id === USER)?.classes || {};
  const fromLink = (admin) =>
    runUpload({ post: poster(admin), mode: "url", content: URL_1, replace: false, source: "link" }).catch((e) => ({ ok: false, error: e.message }));
  const readsOnlyNew = (label, r, admin) => {
    const k2Reads = claude.reads.filter((x) => /une lampe/.test(x.lesson));
    ck(`${label}: the class read when it was shorter has only its lines with no card read`,
       r.ok !== false && k2Reads.length === 1 && JSON.stringify(k2Reads[0].newLines) === JSON.stringify(NEW_LINES),
       JSON.stringify(claude.reads.map((x) => x.newLines || x.lesson.split("\n")[0])));
    ck(`${label}: and they become cards, dated that class`, ["se moucher", "à partir de lundi"].every((f) => JSON.stringify(byFront(admin, f)?.dates) === JSON.stringify([DK2])),
       JSON.stringify(cards(admin).map((c) => c.front)));
    ck(`${label}: the class whose fingerprint matches is not read, the line that made no card included`, !claude.reads.some((x) => /un lit/.test(x.lesson)),
       claude.reads.length + " readings");
    ck(`${label}: nothing else is added`, cards(admin).length === DECK + 2, JSON.stringify(cards(admin).map((c) => c.front)));
  };
  // The sync and an upload of the doc's link read the doc's own text, which
  // the fingerprints were taken from.
  for (const via of ["sync", "upload of the doc's link"]) {
    const admin = setup(shorter);
    doc.text = notebook(K1, K2b);
    const r = via === "sync" ? await syncAll(admin) : await fromLink(admin);
    readsOnlyNew(via, r, admin);
    await secondTimeAsksNothing(`${via}, after the class read when it was shorter`, admin, () => (via === "sync" ? syncAll(admin) : fromLink(admin)));
  }
  // Pasted text, or a file, is never byte for byte the doc's export: a .docx
  // has a blank line after every paragraph, a paste can lose a tab or a
  // trailing space. On the owner's notes every fingerprinted class then
  // looked changed, and 21 lines read before were read again. So such an
  // upload reads none of those lines and records none of them, and the
  // next sync, on the doc's own text, reads only the two with no card.
  const asDocx = (text) => text.split("\n").map((l) => (l ? `${l}  ` : l)).join("\n\n");
  for (const [shape, text] of [["pasted as the doc has it", notebook(K1, K2b)], ["from a .docx, a blank line after every line", asDocx(notebook(K1, K2b))]]) {
    const admin = setup(shorter);
    doc.text = notebook(K1, K2b);
    const r = await upload(admin, text);
    ck(`an upload ${shape}: no line of a class the notebook fingerprinted is read again`,
       r.ok !== false && claude.reads.length === 0 && cards(admin).length === DECK, `${claude.reads.length} readings, ${cards(admin).length} cards`);
    ck(`an upload ${shape}: and the class that changed is left unrecorded, for the sync`, !(DK2 in recorded(admin)), JSON.stringify(Object.keys(recorded(admin))));
    resetCalls();
    const s2 = await syncAll(admin);
    readsOnlyNew(`the sync after an upload ${shape}`, s2, admin);
    await secondTimeAsksNothing(`an upload ${shape}, then the sync`, admin, () => upload(admin, text));
  }
  // "already in your deck" is what linking writes for a class on a card: no
  // fingerprint, so the class counts as read whole, as before.
  {
    const admin = setup("already in your deck");
    const r = await upload(admin, notebook(K1, K2b));
    ck("a class with no fingerprint still counts as read whole", r.ok !== false && claude.reads.length === 0 && cards(admin).length === DECK, `${claude.reads.length} readings`);
  }
  // Before migration_016 a class is known by its date only, as it always
  // was: there is no record to remember the class's other lines were read.
  {
    const admin = setup(shorter, { migrated: false });
    const r = await upload(admin, notebook(K1, K2b));
    doc.text = notebook(K1, K2b);
    const s2 = await syncAll(admin);
    ck("before migration_016 nothing changes: the class waits for the migration", r.ok !== false && s2.ok && claude.reads.length === 0 && cards(admin).length === DECK,
       `${claude.reads.length} readings`);
  }
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

  // The route itself (api/admin-update-card.js), as the app's Remove card
  // calls it: { action: "remove", row_id } and nothing else.
  const db = fakeSupabase();
  db.auth = {
    getUser: async (token) => (token === "student-token"
      ? { data: { user: { id: USER } }, error: null }
      : { data: { user: null }, error: { message: "invalid token" } }),
  };
  db.tables.user_cards.push(
    { id: 41, user_id: USER, front: "un tabouret", back: "a stool", source: "cahier-upload", dates: [D.C1], fsrs_state: 2, stability: 3.5, reps: 2 },
    { id: 42, user_id: "someone-else", front: "une chaise", back: "a chair", source: "cahier-upload", dates: [] },
  );
  db.tables.card_reviews.push({ id: 1, user_id: USER, card_id: 41, direction: "fr", rating: 3 });
  const reviewsBefore = JSON.stringify(db.tables.card_reviews);
  const log = console.log;
  const call = async (body, token = "student-token") => {
    const res = fakeRes();
    console.log = () => {};
    try { await updateCard(db, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res); } finally { console.log = log; }
    return res;
  };
  const own = await call({ action: "remove", row_id: 41 });
  const row41 = db.tables.user_cards.find((r) => r.id === 41);
  ck("the route takes the student's own card out of study and marks it removed, with no front or back sent",
     own.code === 200 && own.body?.ok && isOut(row41) && row41.archived_reason === "removed", `${own.code} ${JSON.stringify(own.body)}`);
  ck("and keeps the row, its schedule and its answers", row41.stability === 3.5 && row41.reps === 2 && JSON.stringify(db.tables.card_reviews) === reviewsBefore);
  const theirs = await call({ action: "remove", row_id: 42 });
  ck("another student's card: refused (403) and left in study", theirs.code === 403 && !isOut(db.tables.user_cards.find((r) => r.id === 42)), String(theirs.code));
  const which = await call({ action: "remove" });
  ck("no row_id: refused (400)", which.code === 400, String(which.code));
  const anon = await call({ action: "remove", row_id: 42 }, null);
  ck("no session: refused (401)", anon.code === 401, String(anon.code));
  ck("no row is ever deleted", db.tables.user_cards.length === 2);
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
  const blind = reconcileLessons([lecon], [], out.map((c) => ({ ...c, reason: null })));
  ck("before migration_016 no row says why: the lesson's own cards come back, as they did",
     blind.missing.some((m) => m.front === "Je vais bien") && blind.missing.some((m) => m.front === "Bonjour"), JSON.stringify(blind.missing.map((m) => m.front)));
  ck("but a card of the student's own out of study is still theirs, and the lesson goes without it",
     blind.taken.some((t) => t.front === "Salut !") && !blind.missing.some((m) => m.front === "Salut !"), JSON.stringify(blind.missing.map((m) => m.front)));

  // The owner's 16650 "après" (2026-10-07): the clean-up put it away as a
  // repeat of "ensuite / après", and before migration_016 the row couldn't
  // say so. Leçon 2 has "après", and its insert, an upsert on the French,
  // landed on that row: new English, class dates cleared, back in study
  // beside the card it repeats. A card of the student's own out of study is
  // never taken over, whatever took it out and whether or not the row says.
  const lecon2 = { id: "lecon2", cards: [["après", "after", "V"], ["avant", "before", "V"]] };
  const ownList = [{ f: "ensuite / après", b: "then / afterwards", source: "cahier-upload", row_id: 16631, dates: ["2026-04-14"] }];
  for (const reason of [null, "duplicate", "replaced", "removed", "something else"]) {
    const away16650 = [{ f: "après", b: "afterwards", source: "archived:cahier-upload", row_id: 16650, reason }];
    const l = reconcileLessons([lecon2], ownList, away16650);
    ck(`a lesson never takes over a card of the student's own out of study (${reason ?? "no reason recorded"})`,
       !l.missing.some((m) => m.front === "après") && (l.taken.some((t) => t.front === "après") || l.away.some((t) => t.front === "après")) &&
         l.missing.some((m) => m.front === "avant"),
       JSON.stringify({ missing: l.missing.map((m) => m.front), taken: l.taken, away: l.away }));
  }
  const respelt = reconcileLessons([{ id: "lecon1", cards: [["Rends-moi mon livre !", "Give me my book back!", "V"]] }], [],
    [{ f: "rends-moi mon livre", b: "give me back my book", source: "archived:cahier-upload", row_id: 3425, reason: null }]);
  ck("nor beside one, written another way", respelt.taken.length === 1 && respelt.missing.length === 0, JSON.stringify(respelt.missing));

  // A word from the notes lands on a lesson card the student has (it only
  // adds its class date), and the lesson later drops that card. The line is
  // recorded as read, so no upload would make the card again: deleting it
  // lost the word for good. It stays, as the student's own card.
  const db = fakeSupabase();
  claude.seen = new Map();
  db.tables.user_cards.push({ id: 7, user_id: USER, front: "actuellement", back: "currently", category: "V", dates: [],
    source: `lesson:adverbes#${lessonCardKey("actuellement")}`, fsrs_state: 0, en_fsrs_state: 0 });
  await upload(db, notebook(C("Le 6 janvier 2026", "actuellement = currently", "une écharpe = a scarf")));
  const row = db.tables.user_cards.find((r) => r.id === 7);
  ck("a word in the notes that is a lesson card only adds its class date to it",
     row.dates.includes("2026-01-06") && !db.tables.user_cards.some((r) => r.id !== 7 && /^actuellement$/i.test(r.front)));
  const deck = db.tables.user_cards.filter((r) => !isOut(r)).map((r) => ({ f: r.front, b: r.back, source: r.source, row_id: r.id, dates: r.dates, fsrs_state: r.fsrs_state, en_fsrs_state: r.en_fsrs_state }));
  const dropped = reconcileLessons([{ id: "adverbes", cards: [["lentement", "slowly", "V"]] }], deck);
  ck("when the lesson drops it, it becomes one of the student's own cards, not deleted or put away",
     dropped.adopt.includes(7) && !dropped.stale.includes(7) && !dropped.archive.includes(7), JSON.stringify({ adopt: dropped.adopt, stale: dropped.stale, archive: dropped.archive }));
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

console.log("\n  a class Claude couldn't read stays unread, on the upload and on the sync");
{
  const isC7 = (lesson) => lesson.split("\n").some((l) => l.trim() === C7.lines[0]);
  const C7_WORDS = ["une colline", "grimper"];
  const c7Lines = (admin) => (admin.tables.notes_read[0]?.classes?.[D.C7] || []).length;
  for (const via of ["upload", "sync"]) {
    const admin = await usedDeck({ via });
    const before = snapshot(admin);
    const linesBefore = c7Lines(admin);
    doc.text = NOTEBOOK_2;
    resetCalls();
    claude.readFailIf = isC7;
    const r1 = via === "upload" ? await upload(admin, NOTEBOOK_2) : await sync(admin);
    claude.readFailIf = null;
    const added1 = cards(admin).filter((c) => !before.cards.some((b) => b.id === c.id)).map((c) => c.front);
    ck(`${via}: the other classes are read and saved`, r1.ok !== false && ["le brouillard", "un parapluie", "un écureuil"].every((f) => added1.includes(f)),
       `${JSON.stringify(r1).slice(0, 160)}; added ${added1.join(" | ")}`);
    ck(`${via}: none of the words of the class Claude couldn't read is added`, !added1.some((f) => C7_WORDS.includes(f)), added1.join(" | "));
    ck(`${via}: and none of its lines is recorded as read`, c7Lines(admin) === linesBefore, `${c7Lines(admin)} lines recorded`);
    if (via === "upload") {
      ck("upload: the message names the class that couldn't be read, and says to upload again",
         JSON.stringify(r1.failedClasses) === JSON.stringify([D.C7]) &&
           uploadResultText(r1).includes(`Your class of ${classDay(D.C7)} couldn't be read this time. Upload the same notes again to add it.`),
         uploadResultText(r1));
    } else {
      ck("sync: the reply names it, and counts it as still to read", r1.errors?.some((e) => e.date === D.C7) && r1.remaining === 1, JSON.stringify(r1).slice(0, 200));
    }
    resetCalls();
    const r2 = via === "upload" ? await upload(admin, NOTEBOOK_2) : await syncAll(admin);
    ck(`${via}: the next run reads only that class, and adds its words`,
       r2.ok !== false && JSON.stringify(classesRead()) === JSON.stringify(["C7"]) && C7_WORDS.every((f) => byFront(admin, f) && !isOut(byFront(admin, f))),
       `${classesRead().join(",")}; ${JSON.stringify(r2).slice(0, 120)}`);
    headline(`${via}, after a class Claude couldn't read`, admin, before, { readCheck: false });
  }

  // Nothing added because of what didn't happen: the message must not say
  // everything is already in the deck. A class Claude couldn't read beside
  // one with only old words; then a class whose one card waits on Claude's
  // question.
  const OLD_WORDS = C("Le 25 novembre 2025", "le travail = work", "alors = so");
  const LOOKALIKE = C("Le 2 décembre 2025", "le cas = the case");
  {
    const admin = await usedDeck();
    claude.readFailIf = isC7;
    const r = await upload(admin, notebook(C1, C2, C3, C4, C5, C6, C7, OLD_WORDS));
    claude.readFailIf = null;
    const text = uploadResultText(r);
    ck("nothing added and a class not read: the message says so, and not that everything is in the deck",
       r.ok !== false && r.cardsInserted === 0 && text.startsWith("Done!\n\nNo new cards added this time.") && !/everything in these notes/.test(text) &&
         text.includes(`Your class of ${classDay(D.C7)} couldn't be read this time`), text);
    claude.questionFails = true;
    const w = await upload(admin, notebook(C1, C2, C3, C4, C5, C6, OLD_WORDS, LOOKALIKE));
    claude.questionFails = false;
    const wText = uploadResultText(w);
    ck("nothing added and a class waiting: the message names it, and doesn't say everything is in the deck",
       w.ok !== false && w.cardsInserted === 0 && JSON.stringify(w.waitingClasses) === JSON.stringify(["2025-12-02"]) &&
         wText.includes(`Your class of ${classDay("2025-12-02")} waits until your next upload: some of its words look like cards you have`) &&
         !/everything in these notes/.test(wText), wText);
  }

  // Every class failing: the upload says so, saves no card, and gives the
  // turn back, so the daily check isn't kept waiting.
  const admin = await usedDeck();
  const before = snapshot(admin);
  admin.tables.cahier_links.push({ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: {}, last_checked_at: null });
  doc.text = NOTEBOOK_2;
  resetCalls();
  claude.readFailIf = () => true;
  const r = await upload(admin, NOTEBOOK_2);
  claude.readFailIf = null;
  ck("when no class can be read, the upload says so and saves no card",
     r.ok === false && /Couldn't read your lessons/.test(r.error) && JSON.stringify(snapshot(admin).cards) === JSON.stringify(before.cards), r.error);
  const after = await sync(admin);
  ck("and the turn is free straight afterwards: a sync isn't told the notes are busy", after.ok && !after.busy && after.cardsAdded === 5,
     JSON.stringify(after).slice(0, 160));
}

console.log("\n  a class moved to another date is known by its lines, even onto a date another class has");
{
  // The owner's linked notes have "Le 27 octobre 2025" twice, the first
  // almost certainly meant for the 28th. A teacher who pastes a new class
  // under a header copied from the last one, then corrects it, is the same
  // case. The old date is still in the notes, so the moved class used to be
  // read again from scratch.
  const OLD = C("Le 5 octobre 2026", "un ordinateur portable = a laptop", "la souris = the mouse", "un clavier = a keyboard", "Je suis en retard = I'm late");
  const NEW = C("Le 5 octobre 2026", "une pomme de terre = a potato", "un poireau = a leek", "les haricots verts = green beans", "J'ai faim = I'm hungry");
  const LATER = C("Le 9 octobre 2026", "une tasse = a cup", "une assiette = a plate", "une fourchette = a fork");
  const fixed = { ...NEW, dateLine: "Le 6 octobre 2026" };
  const movedOnto = { ...LATER, dateLine: "Le 5 octobre 2026" };
  for (const via of ["upload", "sync"]) {
    const admin = fakeSupabase();
    claude.seen = new Map();
    claude.respell = "strict";
    const run = async (text, opts) => {
      if (via === "upload") return upload(admin, text, opts);
      doc.text = text;
      return syncAll(admin, admin.tables.cahier_links.length ? {} : { url: URL_1 });
    };
    const first = await run(notebook(OLD, NEW, LATER));
    ck(`${via}: two classes under one date are both read`, first.ok !== false && cards(admin).length === 11, `${cards(admin).length} cards`);
    for (const [label, text] of [
      ["the class with the duplicated date corrected", notebook(OLD, fixed, LATER)],
      ["a class moved onto a date another class already has", notebook(OLD, fixed, movedOnto)],
    ]) {
      const before = snapshot(admin);
      resetCalls();
      const r = await run(text);
      ck(`${via}, ${label}: nothing is read and no card is added`,
         r.ok !== false && claude.reads.length === 0 && admin.tables.user_cards.length === before.cards.length,
         `${claude.reads.length} readings: ${classesRead().join(",")}; ${admin.tables.user_cards.length - before.cards.length} cards added`);
    }
    if (via === "upload") {
      const r = await upload(admin, notebook(OLD, fixed, movedOnto), { replace: true });
      ck("upload: and Replace takes none of their cards out", r.ok !== false && r.keptOutOfStudy === 0 && inStudy(admin).length === 11, JSON.stringify(r).slice(0, 160));
      const one = await upload(admin, notebook(OLD));
      ck("upload: one unchanged class says so, in the singular",
         uploadResultText(one).includes("No new cards: everything in these notes is already in your deck.\n1 class was already read and left as it is."), uploadResultText(one));
    }
  }
  // As the plan sees it: the moved class's lines were read under its old date.
  const rec = { "2026-10-05": [] };
  const p0 = planReading({ blocks: sliceIntoBlocks(notebook(OLD, NEW)), classes: {} });
  for (const p of p0) rec[p.date] = [...new Set([...rec[p.date], ...p.fpsAll])];
  const p1 = planReading({ blocks: sliceIntoBlocks(notebook(OLD, fixed)), classes: rec });
  const moved = p1.find((p) => p.date === "2026-10-06");
  ck("the plan: the corrected class has no new line, and came from the date it shared", moved && !moved.needsReading && moved.retypedFrom === "2026-10-05",
     JSON.stringify(p1.map((p) => [p.date, p.newLines.length, p.retypedFrom])));
  const p2 = planReading({ blocks: sliceIntoBlocks(notebook(OLD, { ...fixed, lines: [...fixed.lines, "un navet = a turnip"] })), classes: rec });
  const added = p2.find((p) => p.date === "2026-10-06");
  ck("the plan: a line added to the moved class is read on its own", added?.partial && JSON.stringify(added.newLines) === JSON.stringify(["un navet = a turnip"]),
     JSON.stringify(added?.newLines));
  const p3 = planReading({ blocks: sliceIntoBlocks(notebook(OLD, { ...NEW, dateLine: "Le 7 octobre 2026", lines: ["un navet = a turnip", "une courgette = a courgette", "J'ai faim = I'm hungry"] })), classes: rec });
  ck("the plan: a new class sharing a line with an old one is still read", p3.find((p) => p.date === "2026-10-07")?.needsReading === true);
}

console.log("\n  Replace never brings a card back beside a lesson card that is the same card");
{
  // A Replace without a class takes its cards out. While "je vais bien" is
  // out, the lesson sync used not to count it as the student's, and added its
  // own "Je vais bien"; a later Replace with the class then brought the
  // student's back beside it: one card twice, which nothing would put away.
  // Since 2026-10-07 the lesson sync counts every card of the student's own,
  // out of study too, so it no longer adds one; a lesson card added before
  // that (or by an older copy of the app) is still the reason the student's
  // stays out.
  const X = C("Le 6 janvier 2026", "je vais bien = I'm fine", "une écharpe = a scarf", "un bonnet = a hat");
  const Y = C("Le 13 janvier 2026", "un manteau = a coat", "des gants = gloves");
  const DX = "2026-01-06";
  const admin = fakeSupabase();
  claude.seen = new Map();
  claude.respell = "strict";
  await upload(admin, notebook(X, Y));
  const r1 = await upload(admin, notebook(Y), { replace: true });
  ck("a Replace without the class takes its cards out", r1.keptOutOfStudy === 3 && isOut(byFront(admin, "je vais bien")), JSON.stringify(r1).slice(0, 160));
  const shape = (row) => ({ f: row.front, b: row.back, source: row.source, row_id: row.id, dates: row.dates || [], fsrs_state: row.fsrs_state, en_fsrs_state: row.en_fsrs_state, reason: row.archived_reason ?? null });
  const lecon = { id: "lecon1", cards: [["Je vais bien", "I'm fine", "V"]] };
  const sync1 = reconcileLessons([lecon], inStudy(admin).map(shape), cards(admin).filter(isOut).map(shape));
  ck("the lesson sync now leaves the word to the student's card out of study", sync1.taken.some((t) => t.front === "Je vais bien") && !sync1.missing.length,
     JSON.stringify(sync1.missing));
  // As an older copy of the app would have done.
  cards(admin).push({ id: 9100, user_id: USER, front: "Je vais bien", back: "I'm fine", category: "V", dates: [], source: `lesson:lecon1#${lessonCardKey("Je vais bien")}`, fsrs_state: 0, en_fsrs_state: 0 });
  const r2 = await upload(admin, notebook(X, Y), { replace: true });
  ck("a Replace with the class again brings back its other cards", r2.broughtBack === 2 && !isOut(byFront(admin, "une écharpe")) && !isOut(byFront(admin, "un bonnet")),
     JSON.stringify(r2).slice(0, 160));
  ck("but not the one whose word is in study on the lesson card: it stays out, kept",
     isOut(byFront(admin, "je vais bien")) && byFront(admin, "je vais bien").archived_reason === "replaced");
  ck("and the lesson card gains its class date instead", (byFront(admin, "Je vais bien").dates || []).includes(DX), JSON.stringify(byFront(admin, "Je vais bien").dates));
  const live = inStudy(admin);
  const twice = live.flatMap((a, i) => live.slice(i + 1).filter((b) => isSureMatch(a, b)).map((b) => `${a.front} ~ ${b.front}`));
  ck("no two cards in study are one card", twice.length === 0, twice.join("; "));
}

// ═════════════════════════════════════════════════════════════════════════
console.log("\n  before migration_016: everything keeps working, by class date");
{
  const admin = await usedDeck({ migrated: false });
  ck("removing works without the reason column: the card is out of study and kept", isOut(byFront(admin, "Naza")) && byFront(admin, "Naza").archived_reason === undefined);
  const before = snapshot(admin);
  resetCalls();
  claude.respell = "rule"; // by date only, the retyped class is read again
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
  claude.respell = "rule";
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
  claude.respell = "rule";
  const s1 = await sync(flaky);
  const s2 = await syncAll(flaky);
  ck("a sync whose record failed after its cards were saved reads the class again",
     !s1.ok && s2.ok && claude.reads.filter((x) => classOf(x) === "C7").length === 2, `${claude.reads.filter((x) => classOf(x) === "C7").length} readings of the class`);
  headline("before migration_016, the record failing after the cards", flaky, before3, {
    expectNew: EXPECTED_NEW.filter((f) => f !== "un écureuil"), readCheck: false,
  });

  // Replace takes nothing out before the migration: a card taken out then
  // could never say a Replace took it, so no later Replace would bring it
  // back, and its class, being on a card, would never be read again.
  const admin4 = await usedDeck({ migrated: false });
  const before4 = snapshot(admin4);
  const r4 = await upload(admin4, notebook(C1, C2, C4, C5, C6), { replace: true });
  const c3 = ["gratuit", "enervé (adj)", "manquer / rater", "un ami"];
  ck("Replace before migration_016 takes nothing out, and deletes nothing",
     r4.ok !== false && c3.every((f) => !isOut(byFront(admin4, f))) && cards(admin4).length === before4.cards.length && r4.keptOutOfStudy === 0,
     JSON.stringify(r4).slice(0, 200));
  ck("and the reply says how many cards stayed, and why", r4.replaceWaits === 4 &&
     /Nothing was taken out of study\. Replacing a deck needs a database update/.test(uploadResultText(r4)) && /your 4 cards from other classes/.test(uploadResultText(r4)),
     uploadResultText(r4));
  // The owner runs the migration; a later Replace with every class has
  // nothing to bring back, because nothing went.
  const after4 = fakeSupabase({ migrated: true, tables: admin4.tables });
  const r5 = await upload(after4, notebook(C1, C2, C3, C4, C5, C6), { replace: true });
  ck("after the migration, Replace with the classes again leaves every card in study",
     r5.ok !== false && c3.every((f) => !isOut(byFront(after4, f))) && byFront(after4, "gratuit").stability === 5.5 && r5.keptOutOfStudy === 0,
     JSON.stringify(r5).slice(0, 200));
  const r6 = await upload(after4, notebook(C1, C2, C4, C5, C6), { replace: true });
  const unanswered3 = c3.filter((f) => f !== "gratuit");
  ck("and a Replace without a class now takes its cards never answered out, marked so they can come back",
     r6.ok !== false && unanswered3.every((f) => isOut(byFront(after4, f)) && byFront(after4, f).archived_reason === "replaced") &&
       !isOut(byFront(after4, "gratuit")) && r6.answeredStay === 1, JSON.stringify(r6).slice(0, 160));
  const r7 = await upload(after4, notebook(C1, C2, C3, C4, C5, C6), { replace: true });
  ck("and the next Replace with the class brings them back",
     r7.broughtBack === 3 && c3.every((f) => !isOut(byFront(after4, f))) && byFront(after4, "gratuit").stability === 5.5, JSON.stringify(r7).slice(0, 160));
}

server.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
