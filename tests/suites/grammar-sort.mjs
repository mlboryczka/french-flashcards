// The grammar sort (scripts/sort-grammar-cards.mjs), without the network. No
// browser, no Supabase, no Anthropic: the script's functions are called with a
// stand-in database and a stand-in Claude, and any other request fails.
//
// What is under test is the owner's decision of 2026-09-24 — a card must be
// answerable by typing something the app can check — as the script carries it
// out on every deck:
//   - the 117 cards the owner sorted by hand get exactly the owner's sort, and
//     cost no Claude call;
//   - conjugation drills stay, whether or not the owner saw them;
//   - lesson cards and archived cards are not touched, or even asked about;
//   - a new card is not added to a deck that already has its front, in any
//     spelling, archived or not;
//   - --apply backs up before writing, and running it twice writes nothing
//     the second time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { checker } from "../check.mjs";
import * as sort from "../../scripts/sort-grammar-cards.mjs";
import { isConjugationDrill } from "../../src/lib/cardInstruction.js";

const ck = checker();

// Nothing here may leave the machine. The stand-in Claude server below is on
// 127.0.0.1; anything else is refused and counted.
let outside = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (/^https?:\/\/127\.0\.0\.1[:/]/.test(String(url))) return realFetch(url, init);
  outside++;
  throw new Error(`test made a network request: ${url}`);
};

const file = sort.loadDecisions();
const index = sort.indexDecisions(file);
const OWNER = "a1b2c3d4-0000-4000-8000-000000000001";
const OTHER = "f9e8d7c6-0000-4000-8000-000000000002";
const THIRD = "0c0c0c0c-0000-4000-8000-000000000003";

// ── 1. the owner's 117 ──────────────────────────────────────────────────────
console.log("\n  the reviewed sort, reproduced");
{
  // The original deck's grammar and pronunciation cards, as the reviewed file
  // records them — the twins ("s'asseoir / être assis" twice) included, which
  // the back tells apart.
  const rows = file.decisions.map((d, i) => ({
    id: i + 1, user_id: OWNER, front: d.front, back: d.back, category: "G", dates: ["2026-01-01"], source: "demo-seed",
  }));
  const { decided, pending } = sort.decideRows(rows, index);
  ck("all 117 are decided without asking Claude", decided.length === 117 && pending.length === 0,
    `${decided.length} decided, ${pending.length} would be asked`);
  const wrong = decided.filter((it) => {
    const d = file.decisions[it.id - 1];
    return it.decision !== d.decision || JSON.stringify(it.newCards) !== JSON.stringify(d.newCards || []);
  });
  ck("each gets exactly the owner's decision and new cards", wrong.length === 0,
    wrong.slice(0, 3).map((it) => it.front).join("; "));
  const tally = (k) => decided.filter((it) => it.decision === k).length;
  ck("61 kept, 27 converted, 29 archived", tally("keep") === 61 && tally("convert") === 27 && tally("archive") === 29,
    `keep ${tally("keep")} convert ${tally("convert")} archive ${tally("archive")}`);
  ck("every one kept is a conjugation drill", decided.filter((it) => it.decision === "keep").every((it) => isConjugationDrill(it.front)));

  // A deck can hold one row per front. When its back matches neither twin, it
  // gets the conversion: archiving the only copy would lose the French.
  const lone = sort.reviewedDecision({ front: "s'asseoir / être assis", back: "to sit (action) / to be sitting (state)" }, index);
  ck("a twin whose back matches neither copy is converted, not archived", lone?.decision === "convert", lone?.decision);
  const cased = sort.reviewedDecision({ front: "Cela = ça", back: "cela is formal" }, index);
  ck("a front typed with a capital still finds its decision", cased?.decision === "archive", cased?.decision);
}

// ── 2. drills the owner never saw ───────────────────────────────────────────
console.log("\n  conjugation drills stay");
{
  const rows = [
    ["finir → nous", "nous finissons", "G"],
    ["prendre (subj) → que je", "que je prenne", "G"],
    ["aller → futur (je)", "j'irai", "P"],
    ["être → pp", "été", "G"],
    ["pouvoir (conditionnel) → vous", "vous pourriez", "G"],
  ].map(([front, back, category], i) => ({ id: 500 + i, user_id: OTHER, front, back, category, dates: [], source: "cahier-upload" }));
  ck("none of these is in the reviewed file", rows.every((r) => !sort.reviewedDecision(r, index)));
  const { decided, pending } = sort.decideRows(rows, index);
  ck("all kept as drills, none asked about",
    pending.length === 0 && decided.length === rows.length && decided.every((it) => it.decision === "keep" && it.from === "drill"),
    decided.map((it) => `${it.front}:${it.decision}/${it.from}`).join(", "));
}

// ── 3. what is out of scope ─────────────────────────────────────────────────
console.log("\n  lesson and archived cards are left alone");
{
  const rows = [
    { id: 1, user_id: OWNER, front: "relatif → adverbe", back: "relativement", category: "G", source: "lesson:adverbes#k1" },
    { id: 2, user_id: OWNER, front: "Pronoms toniques", back: "moi, toi…", category: "G", source: "archived:demo-seed" },
    { id: 3, user_id: OWNER, front: "le passé simple", back: "literary past", category: "P", source: "archived:" },
    { id: 4, user_id: OWNER, front: "une colline", back: "a hill", category: "V", source: "demo-seed" },
    { id: 5, user_id: OWNER, front: "le passé antérieur", back: "a literary tense", category: "G", source: null },
  ];
  const { decided, pending } = sort.decideRows(rows, index);
  ck("the lesson card, the archived cards and the vocab card are neither decided nor asked about",
    decided.length === 0 && pending.length === 1 && pending[0].id === 5,
    `decided ${decided.map((d) => d.id)} pending ${pending.map((p) => p.id)}`);
  ck("inScope: lesson", !sort.inScope(rows[0]));
  ck("inScope: archived", !sort.inScope(rows[1]) && !sort.inScope(rows[2]));
  ck("inScope: a grammar card with no source", sort.inScope(rows[4]));
}

// ── 4. what Claude's answers must be ────────────────────────────────────────
console.log("\n  Claude's answers are checked, not trusted");
{
  const rule = { front: "le passé antérieur", back: "a literary tense" };
  const cases = [
    ["keep on a rule card", { decision: "keep", why: "", newCards: [] }, rule, false],
    ["keep on an arrow that is still a formula", { decision: "keep", why: "", newCards: [] }, { front: "si + présent → futur", back: "real condition" }, false],
    ["keep on a drill shape isConjugationDrill can't read", { decision: "keep", why: "", newCards: [] }, { front: "aller → nous autres", back: "nous allons" }, true],
    ["archive", { decision: "archive", why: "a rule", newCards: [] }, rule, true],
    ["archive that brings cards", { decision: "archive", why: "", newCards: [{ front: "x", back: "y", category: "V" }] }, rule, false],
    ["convert with nothing", { decision: "convert", why: "", newCards: [] }, rule, false],
    ["convert keeping a respelling", { decision: "convert", why: "", newCards: [{ front: "du riz {ri}", back: "rice", category: "V" }] }, rule, false],
    ["convert keeping a pronunciation note", { decision: "convert", why: "", newCards: [{ front: "du riz", back: "rice (silent z)", category: "V" }] }, rule, false],
    ["convert into a formula", { decision: "convert", why: "", newCards: [{ front: "avoir besoin de + nom", back: "to need", category: "V" }] }, rule, false],
    ["convert into grammar", { decision: "convert", why: "", newCards: [{ front: "mettre → je", back: "je mets", category: "G" }] }, rule, false],
    ["convert into two cards with one front", { decision: "convert", why: "", newCards: [{ front: "savoir", back: "to know", category: "V" }, { front: "Savoir", back: "to know how", category: "V" }] }, rule, false],
    ["convert, clean", { decision: "convert", why: "", newCards: [{ front: "J'y vais", back: "I'm going (there) / I'm off", category: "E" }] }, rule, true],
    ["no answer at all", undefined, rule, false],
  ];
  for (const [name, result, row, ok] of cases) {
    const got = sort.validateClaudeResult(result, row);
    ck(`${name} → ${ok ? "accepted" : "refused"}`, !got.error === ok, got.error || "");
  }
  // Calibration: the checks must pass everything the owner approved.
  const refused = file.decisions
    .filter((d) => d.decision === "convert")
    .map((d) => [d, d.newCards.filter((c) => c.category !== "G")])
    .filter(([, cards]) => cards.length)
    .map(([d, cards]) => [d.front, sort.validateClaudeResult({ decision: "convert", why: "", newCards: cards }, d).error])
    .filter(([, e]) => e);
  ck("every word and sentence card the owner made would pass the same checks", refused.length === 0, JSON.stringify(refused));
}

// ── 5. the whole run, against a stand-in database ──────────────────────────
// Only the query shapes the script makes, over one array. It enforces
// unique (user_id, front) the way Postgres does, so a script that tried to
// insert a duplicate would fail here too.
function fakeDb(initial) {
  const DEFAULTS = { category: "V", dates: [], source: null, fsrs_state: 0, stability: null, reps: 0, en_fsrs_state: 0 };
  const table = initial.map((r) => ({ ...DEFAULTS, ...r }));
  const key = (r) => `${r.user_id}\u0000${r.front}`;
  if (new Set(table.map(key)).size !== table.length) throw new Error("fixture breaks unique (user_id, front)");
  let nextId = Math.max(...table.map((r) => r.id)) + 1;
  const counts = { GET: 0, POST: 0, PATCH: 0 };

  const parse = (p) => {
    const [name, qs = ""] = p.split("?");
    const params = qs.split("&").filter(Boolean).map((part) => {
      const i = part.indexOf("=");
      return [part.slice(0, i), decodeURIComponent(part.slice(i + 1))];
    });
    return { name, params };
  };
  const matches = (row, params) =>
    params.every(([k, v]) => {
      if (["select", "order", "on_conflict"].includes(k)) return true;
      if (v.startsWith("eq.")) return String(row[k]) === v.slice(3);
      if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(row[k]));
      throw new Error(`stand-in db: unsupported filter ${k}=${v}`);
    });
  const project = (row, params) => {
    const sel = params.find(([k]) => k === "select")?.[1] || "*";
    const copy = structuredClone(row);
    return sel === "*" ? copy : Object.fromEntries(sel.split(",").map((c) => [c, copy[c]]));
  };

  const db = async (p, init = {}) => {
    const method = init.method || "GET";
    counts[method]++;
    const { name, params } = parse(p);
    if (name !== "user_cards") throw new Error(`stand-in db: no table ${name}`);
    if (method === "GET") {
      let out = table.filter((r) => matches(r, params)).sort((a, b) => a.id - b.id);
      const range = init.headers?.Range;
      if (range) {
        const [from, to] = range.split("-").map(Number);
        out = out.slice(from, to + 1);
      }
      return out.map((r) => project(r, params));
    }
    if (method === "POST") {
      const ignore = /ignore-duplicates/.test(init.headers?.Prefer || "");
      const added = [];
      for (const r of JSON.parse(init.body)) {
        if (table.some((x) => key(x) === key(r))) {
          if (ignore) continue;
          throw new Error("POST user_cards: 409 duplicate key value violates unique constraint");
        }
        const row = { ...DEFAULTS, ...structuredClone(r), id: nextId++ };
        table.push(row);
        added.push(structuredClone(row));
      }
      return added;
    }
    if (method === "PATCH") {
      const set = JSON.parse(init.body);
      const hit = table.filter((r) => matches(r, params));
      for (const r of hit) {
        if (set.front !== undefined && table.some((x) => x !== r && x.user_id === r.user_id && x.front === set.front)) {
          throw new Error("PATCH user_cards: 409 duplicate key value violates unique constraint");
        }
        Object.assign(r, structuredClone(set));
      }
      return hit.map((r) => structuredClone(r));
    }
    throw new Error(`stand-in db: ${method}`);
  };
  return { db, table, counts };
}

// The owner's deck as the seed builds it: deduped by lowercased front, first
// copy wins (seedDemoDeck), so one row for each of the three twins.
const seen = new Set();
const deckA = [];
for (const d of file.decisions) {
  const k = d.front.toLowerCase().trim();
  if (seen.has(k)) continue;
  seen.add(k);
  deckA.push({ front: d.front, back: d.back, category: "G", dates: [`2026-02-${String(deckA.length % 28 + 1).padStart(2, "0")}`], source: "demo-seed" });
}
let id = 1;
const rows = [
  ...deckA.map((r) => ({ ...r, id: id++, user_id: OWNER })),
  // Already in the deck: exactly, in another spelling, and archived.
  { id: id++, user_id: OWNER, front: "savoir", back: "to know", category: "V", source: "cahier-upload" },
  { id: id++, user_id: OWNER, front: "Connaitre", back: "to know (someone)", category: "V", source: "cahier-upload" },
  { id: id++, user_id: OWNER, front: "un fil", back: "a thread", category: "V", source: "archived:cahier-upload" },
  // The two phrase cards the owner corrected.
  { id: id++, user_id: OWNER, front: "ça faisait 2 jours que j'avais pas fait du tennis", back: "it had been 2 days since I had played tennis", category: "E", source: "demo-seed" },
  { id: id++, user_id: OWNER, front: "s'il est parti à l'heure, il arrivera à temps", back: "if he left on time, he'll arrive on time", category: "E", source: "demo-seed" },
  // Never touched, never asked about.
  { id: id++, user_id: OWNER, front: "relatif → adverbe", back: "relativement", category: "G", source: "lesson:adverbes#k1" },
  { id: id++, user_id: OWNER, front: "le passé simple", back: "literary past", category: "G", source: "archived:demo-seed" },
  { id: id++, user_id: OWNER, front: "une colline", back: "a hill", category: "V", source: "demo-seed" },

  // Another student's cahier-parsed deck: cards the reviewed file doesn't cover.
  { id: id++, user_id: OTHER, front: "mon copain", back: "my boyfriend", category: "G", dates: ["2026-09-10"], source: "cahier-upload", reps: 4, stability: 12 },
  { id: id++, user_id: OTHER, front: "le son 'r'", back: "guttural {rr}, at the back of the throat", category: "P", dates: ["2026-09-10"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "COD placé avant", back: "the past participle agrees", category: "G", dates: ["2026-09-10"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "les verbes pronominaux", back: "se lever, se laver: je me lève, je me lave", category: "G", dates: ["2026-09-03"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "Se lever", back: "to get up", category: "V", dates: ["2026-08-01"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "Pronoms toniques", back: "moi, toi, lui, elle, nous, vous, eux, elles", category: "G", dates: ["2026-09-03"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "vivre → je", back: "je vis", category: "G", dates: ["2026-09-03"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "finir → nous", back: "nous finissons", category: "G", dates: ["2026-09-03"], source: "cahier-upload" },
  { id: id++, user_id: OTHER, front: "s'il est parti à l'heure, il arrivera à temps", back: "if he left on time, he'll arrive in time", category: "E", source: "cahier-upload" },
  // A third deck with one card identical to one above: asked about once.
  { id: id++, user_id: THIRD, front: "le son 'r'", back: "guttural {rr}, at the back of the throat", category: "P", dates: ["2026-09-10"], source: "cahier-upload" },
];

const canned = {
  "mon copain": { decision: "convert", why: "a word filed under grammar", newCards: [{ front: "mon copain", back: "my boyfriend", category: "V" }] },
  "le son 'r'": { decision: "archive", why: "pronunciation only", newCards: [] },
  "COD placé avant": { decision: "keep", why: "looks fine", newCards: [] },
  "les verbes pronominaux": {
    decision: "convert", why: "examples underneath",
    newCards: [{ front: "se lever", back: "to get up", category: "V" }, { front: "Je me lève", back: "I get up / I'm getting up", category: "E" }],
  },
};
let classifyCalls = 0;
const asked = [];
const classify = async (cards) => {
  classifyCalls++;
  asked.push(...cards);
  return cards.map((c) => ({ id: c.id, ...canned[c.front] }));
};

console.log("\n  the proposal (dry run)");
const store = fakeDb(rows);
const before = structuredClone(store.table);
const proposal = await sort.buildProposal({ db: store.db, index, classify });
const deckOf = (p, user) => p.decks.find((d) => d.user_id === user);
const A = deckOf(proposal, OWNER);
const B = deckOf(proposal, OTHER);
const C = deckOf(proposal, THIRD);
const tally = (d, k) => d.items.filter((it) => it.decision === k).length;

ck("a dry run writes nothing", store.counts.POST === 0 && store.counts.PATCH === 0 && JSON.stringify(store.table) === JSON.stringify(before),
  `POST ${store.counts.POST} PATCH ${store.counts.PATCH}`);
ck("Claude is called once, for the four cards nothing else decides",
  classifyCalls === 1 && JSON.stringify(asked.map((c) => c.front).sort()) === JSON.stringify(Object.keys(canned).sort()),
  `${classifyCalls} call(s): ${asked.map((c) => c.front).join(" | ")}`);
ck("the owner's deck: keep 61, convert 27, archive 26 (one row per twin), edit 2",
  tally(A, "keep") === 61 && tally(A, "convert") === 27 && tally(A, "archive") === 26 && A.edits.length === 2 && tally(A, "undecided") === 0,
  `keep ${tally(A, "keep")} convert ${tally(A, "convert")} archive ${tally(A, "archive")} edit ${A.edits.length}`);
ck("its lesson card and archived card are not in the proposal",
  !A.items.some((it) => it.front === "relatif → adverbe" || it.front === "le passé simple"));
const undecided = B.items.filter((it) => it.decision === "undecided");
ck("Claude's \"keep\" on a rule card is left undecided, with the reason",
  undecided.length === 1 && undecided[0].front === "COD placé avant" && /drill/.test(undecided[0].error), JSON.stringify(undecided));
ck("an edit already made is not proposed again", B.edits.length === 0, JSON.stringify(B.edits));
ck("the same card on two decks gets the same answer", C.items[0]?.decision === "archive" && B.items.find((it) => it.front === "le son 'r'")?.decision === "archive");
const previewSkips = A.preview.skips.map((s) => s.front).sort();
ck("the preview already shows the three new cards the deck has", JSON.stringify(previewSkips) === JSON.stringify(["connaître", "savoir", "un fil"]),
  JSON.stringify(A.preview.skips));

const text = sort.summarize(proposal);
ck("the printout names decks by 8 characters of user id, never the whole id",
  text.includes(`deck ${OWNER.slice(0, 8)}…`) && ![OWNER, OTHER, THIRD].some((u) => text.includes(u)));
ck("and gives each non-keep decision a line", text.split("\n").filter((l) => /^  (convert|archive|undecided|edit)/.test(l)).length ===
  proposal.decks.reduce((n, d) => n + d.items.filter((it) => it.decision !== "keep").length + d.edits.length, 0));
// A keep Claude decided leaves a card under grammar on the model's word, so
// the owner has to be able to see it; a drill kept for its shape does not.
const keeps = sort.summarize({ decks: [{ deck: "abcdef12", edits: [], items: [
  { front: "aller → nous autres", back: "nous allons", decision: "keep", from: "claude", why: "a drill", newCards: [] },
  { front: "vivre → je", back: "je vis", decision: "keep", from: "drill", newCards: [] },
] }] });
ck("a keep from Claude gets a line; a drill kept for its shape does not",
  keeps.includes('keep [claude]  "aller → nous autres"') && !keeps.includes("vivre → je"), keeps);
ck("an edit never touches a lesson card",
  sort.planEdits([{ id: 1, user_id: OWNER, front: file.edits[1].front, back: "x", source: "lesson:si#k1" }], index).length === 0);

// Someone edits a card between the dry run and --apply: it is not what was
// reviewed, so it is not written.
store.table.find((r) => r.user_id === OTHER && r.front === "Pronoms toniques").back = "moi, toi, soi";

console.log("\n  --apply");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grammar-sort-"));
const preApply = structuredClone(store.table);
const first = await sort.applyProposal({ db: store.db, proposal: JSON.parse(JSON.stringify(proposal)), backupDir: tmp });
const rep = (user) => first.decks.find((d) => d.deck === user.slice(0, 8));
const a1 = rep(OWNER), b1 = rep(OTHER), c1 = rep(THIRD);

// 40 new cards. Five are the old card's own French tidied — "du riz {ri}" →
// "du riz", "complet / complète" → "complet, complète", "avoir besoin de +
// nom / verbe" → "avoir besoin de", "japonais / japonaise", "il y a {ya} / il
// y en a pas" → "il n'y en a pas" — so those rows are re-filed in place and
// keep their history; 32 are added, 3 skipped.
ck("owner's deck: 32 of the 40 new cards added, 5 re-filed in place, the other 3 skipped",
  a1.inserted === 32 && a1.retagged === 5 && a1.skips.length === 3,
  `added ${a1.inserted}, skipped ${JSON.stringify(a1.skips)}`);
ck("skipped because the deck has them exactly, in another spelling, and archived",
  JSON.stringify(a1.skips.map((s) => s.reason).sort()) ===
    JSON.stringify(['already in the deck as "Connaitre"', 'already in the deck as "savoir"', 'an archived card "un fil" holds it'].sort()),
  JSON.stringify(a1.skips));
ck("48 rule cards archived (22 converted + 26 archived), 2 phrase cards edited", a1.archived === 48 && a1.edited === 2,
  `archived ${a1.archived}, edited ${a1.edited}`);

const live = (user) => store.table.filter((r) => r.user_id === user && !String(r.source ?? "").startsWith("archived:"));
const liveGP = live(OWNER).filter((r) => (r.category === "G" || r.category === "P") && !String(r.source ?? "").startsWith("lesson:"));
ck("what is left under grammar in the owner's deck is conjugation drills only",
  liveGP.every((r) => isConjugationDrill(r.front)) && liveGP.length === 63, `${liveGP.length}: ${liveGP.filter((r) => !isConjugationDrill(r.front)).map((r) => r.front)}`);
const origin = preApply.find((r) => r.user_id === OWNER && r.front === "je mets / le cas");
const drill = store.table.find((r) => r.user_id === OWNER && r.front === "mettre → je");
const sentence = store.table.find((r) => r.user_id === OWNER && r.front === "dans ce cas");
ck("a new card carries the original's dates and source, and its own category",
  drill?.category === "G" && sentence?.category === "E" &&
    JSON.stringify(drill.dates) === JSON.stringify(origin.dates) && sentence.source === "demo-seed" && drill.fsrs_state === 0,
  JSON.stringify({ drill, sentence }));
ck("the converted card itself is archived, not deleted",
  store.table.find((r) => r.id === origin.id)?.source === "archived:demo-seed");
ck("the edits", store.table.some((r) => r.user_id === OWNER && r.front === "ça faisait 2 jours que je n'avais pas fait de tennis" && r.back === "it had been 2 days since I'd played tennis") &&
  store.table.some((r) => r.user_id === OWNER && r.front === "s'il est parti à l'heure, il arrivera à temps" && r.back === "if he left on time, he'll arrive in time"));
const copain = store.table.find((r) => r.user_id === OTHER && r.front === "mon copain");
ck("a word filed under grammar is re-filed in place and keeps its history",
  b1.retagged === 1 && copain.category === "V" && copain.id === rows.find((r) => r.front === "mon copain").id && copain.reps === 4 && copain.stability === 12 &&
    !String(copain.source).startsWith("archived:"), JSON.stringify(copain));
ck("the other deck: \"Je me lève\" added, \"se lever\" skipped for \"Se lever\"",
  b1.inserted === 1 && store.table.some((r) => r.user_id === OTHER && r.front === "Je me lève" && r.category === "E" && r.dates[0] === "2026-09-03") &&
    b1.skips.some((s) => s.front === "se lever"), JSON.stringify(b1));
ck("a card changed since the proposal is not written",
  b1.skips.some((s) => s.front === "Pronoms toniques" && /changed since the proposal/.test(s.reason)) &&
    store.table.find((r) => r.user_id === OTHER && r.front === "Pronoms toniques").source === "cahier-upload", JSON.stringify(b1.skips));
ck("an undecided card is not written", store.table.find((r) => r.front === "COD placé avant").source === "cahier-upload");
ck("the third deck's copy is archived too", c1.archived === 1);
ck("lesson card, archived card and unrelated cards untouched",
  ["relatif → adverbe", "le passé simple", "une colline", "savoir", "Connaitre", "un fil", "vivre → je", "finir → nous"].every((f) =>
    store.table.filter((r) => r.front === f).every((r) => JSON.stringify(r) === JSON.stringify(preApply.find((p) => p.id === r.id)))));

const backup = JSON.parse(fs.readFileSync(first.backupFile, "utf8"));
const expected = a1.archived + a1.edited + a1.retagged + b1.archived + b1.retagged + c1.archived;
ck(`every changed row was backed up, whole and as it was before (${expected})`,
  backup.rows.length === expected &&
    backup.rows.every((r) => JSON.stringify(r) === JSON.stringify(preApply.find((p) => p.id === r.id))),
  `${backup.rows.length} backed up`);
ck("and the backup lists the cards it was about to add", backup.inserts.length === a1.inserted + b1.inserted);

console.log("\n  --apply, again");
const afterFirst = structuredClone(store.table);
const writesBefore = store.counts.POST + store.counts.PATCH;
const second = await sort.applyProposal({ db: store.db, proposal: JSON.parse(JSON.stringify(proposal)), backupDir: tmp });
const sum = (k) => second.decks.reduce((n, d) => n + d[k], 0);
ck("the second run adds, archives, re-files and edits nothing",
  sum("inserted") === 0 && sum("archived") === 0 && sum("retagged") === 0 && sum("edited") === 0,
  JSON.stringify(second.decks.map(({ skips, ...r }) => r)));
ck("makes no write at all, and needs no backup", store.counts.POST + store.counts.PATCH === writesBefore && second.backupFile === null);
ck("and leaves the table exactly as the first run did", JSON.stringify(store.table) === JSON.stringify(afterFirst));
ck("no source was archived twice", !store.table.some((r) => String(r.source ?? "").startsWith("archived:archived:")));
const fronts = store.table.map((r) => `${r.user_id}|${sort.normFront(r.front)}`);
const dupes = fronts.filter((f, i) => fronts.indexOf(f) !== i);
ck("no deck holds the same front twice, in any spelling", dupes.length === 0, dupes.join("; "));

// ── 6. the real classifier, against a stand-in Anthropic ────────────────────
console.log("\n  the Claude request");
{
  let body = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify({ results: [{ id: "c1", decision: "archive", why: "a rule", newCards: [] }] }) }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const real = sort.claudeClassifier({ apiKey: "test-key", file });
    const out = await real([{ id: "c1", front: "le passé antérieur", back: "a literary tense", category: "G" }]);
    ck("asks claude-opus-5-5 for JSON against the schema", body?.model === "claude-opus-5-5" && body?.output_config?.format?.type === "json_schema",
      JSON.stringify({ model: body?.model, output_config: body?.output_config?.format?.type }));
    ck("without forcing a tool or turning thinking off (Opus 5.5 refuses both)", !body?.tool_choice && body?.thinking?.type !== "disabled");
    ck("with the owner's decisions in the prompt", JSON.stringify(body?.system).includes("Pronoms toniques"));
    ck("and hands back the parsed results", out.length === 1 && out[0].decision === "archive", JSON.stringify(out));
  } catch (e) {
    ck("the classifier ran against the stand-in", false, e.message);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
    server.close();
  }
}

ck("no request left the machine", outside === 0, `${outside} outside request(s)`);
fs.rmSync(tmp, { recursive: true, force: true });

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
