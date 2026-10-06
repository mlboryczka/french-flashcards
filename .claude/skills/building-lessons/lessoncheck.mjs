#!/usr/bin/env node
// How the app will show and mark every card of a lesson file. Part of the
// building-lessons skill; see SKILL.md, "Checks before committing".
//
//   node lessoncheck.mjs <lesson.js>                       report every card + warnings
//   node lessoncheck.mjs <lesson.js> --try "<front>" "<typed>" [fr|en]
//        mark a typed answer exactly as the app would, for the card with that front,
//        shown French side up (fr, default) or English side up (en)
//   node lessoncheck.mjs --all                              cross-lesson checks over every lesson file
//
// The matcher is lifted from src/FlashcardApp.jsx at run time (lines from
// `function normalize` to the end of `matchAnswer`), so it is the live code.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The project root: this file lives in <root>/.claude/skills/building-lessons/.
const REPO = process.env.REPO || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href);

const { drillInstruction, drillAlternates, isConjugationDrill } = await imp("src/lib/cardInstruction.js");
const { cleanFrenchPrompt, cleanEnglishPrompt, dropFinalPeriod } = await imp("src/lib/cardText.js");
const { lessonCardKey } = await imp("src/lib/lessonSource.js");

// Lift matchAnswer out of FlashcardApp.jsx.
const app = fs.readFileSync(path.join(REPO, "src/FlashcardApp.jsx"), "utf8");
const start = app.indexOf("function normalize(s)");
const mStart = app.indexOf("function matchAnswer(");
const end = app.indexOf("\n}\n", mStart) + 3;
if (start < 0 || mStart < 0 || end < 3) throw new Error("could not find matchAnswer in FlashcardApp.jsx");
const lifted = path.join(os.tmpdir(), `lessoncheck-matcher-${process.pid}.mjs`);
fs.writeFileSync(lifted, app.slice(start, end) + "\nexport { matchAnswer, normalize };\n");
const { matchAnswer } = await import(pathToFileURL(lifted).href + `?t=${Date.now()}`);

const CAT = { V: "vocab", E: "expr", G: "gram", P: "pron" };
const twoWay = (c) => c === "V" || c === "E";

async function loadLesson(file) {
  const abs = path.resolve(file);
  const mod = await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
  const L = mod.default || mod.LESSON;
  if (!L || !Array.isArray(L.cards)) throw new Error(`${file}: no default export with cards`);
  return L;
}

function instructionFor(L, [front, , cat, section]) {
  if (cat !== "G" && cat !== "P") return null;
  return drillInstruction(front) || L.instructions?.[section] || null;
}

// What the app accepts for a card shown one side up, and how strictly.
function marking(L, card, shown) {
  const [front, back, cat] = card;
  const correct = shown === "fr" ? back : front;
  const drill = shown === "fr" && String(front).includes("→"); // every arrow lesson card is exact
  const extra = [...(drill ? drillAlternates(front, back) : []), ...(shown === "fr" ? [back] : [])];
  return { correct, extra, exact: drill };
}

function accepted(correct, extra, exact) {
  // Mirror matchAnswer's alternative-building, for display.
  const strip = (s) => String(s || "").replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const out = [];
  for (const src of [correct, ...extra]) {
    const x = strip(src) || src;
    if (exact) { out.push(...x.split("/").map((s) => s.trim()).filter(Boolean)); continue; }
    for (const sp of x.split("/").map((s) => s.trim()).filter(Boolean)) {
      const sub = sp.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      const tooLong = sub.some((p) => p.split(/\s+/).filter(Boolean).length >= 4 || p.length >= 20);
      if (tooLong) out.push(sp); else out.push(...sub);
    }
  }
  return [...new Set(out)];
}

function shortCommaPieces(s) {
  const x = String(s || "").replace(/\([^()]*\)/g, " ");
  for (const sp of x.split("/")) {
    const sub = sp.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
    if (sub.length < 2) continue;
    const tooLong = sub.some((p) => p.split(/\s+/).filter(Boolean).length >= 4 || p.length >= 20);
    if (!tooLong) return sub;
  }
  return null;
}

async function report(file) {
  const L = await loadLesson(file);
  const warn = [];
  const seenFront = new Map(), seenKey = new Map();
  const order = L.teachingOrder || [];
  console.log(`\n# ${L.id} — ${L.title} — ${L.cards.length} cards`);
  console.log(`subtitle: ${L.subtitle}\nsource: ${L.source}`);
  const counts = {};
  L.cards.forEach((card, i) => {
    const [front, back, cat, section, was] = card;
    counts[section] = (counts[section] || 0) + 1;
    const n = `#${i} [${section}/${cat}]`;
    if (!CAT[cat]) warn.push(`${n} unknown category "${cat}"`);
    if (typeof front !== "string" || typeof back !== "string" || !front.trim() || !back.trim()) warn.push(`${n} empty front or back`);
    if (seenFront.has(front)) warn.push(`${n} duplicate front of #${seenFront.get(front)}: "${front}"`);
    seenFront.set(front, i);
    const key = lessonCardKey(was ?? front);
    if (seenKey.has(key)) warn.push(`${n} key collision with #${seenKey.get(key)}`);
    seenKey.set(key, i);
    if (!order.includes(section)) warn.push(`${n} section "${section}" missing from teachingOrder`);
    const arrow = front.includes("→");
    if (twoWay(cat) && arrow) warn.push(`${n} a ${CAT[cat]} card must not have an arrow: "${front}"`);
    const instr = instructionFor(L, card);
    if ((cat === "G" || cat === "P") && !instr) warn.push(`${n} grammar card with no instruction line: "${front}"`);
    if (instr) {
      const ans = accepted(back, [], true).map((a) => a.toLowerCase());
      for (const a of ans) if (a.length >= 3 && instr.toLowerCase().includes(a)) warn.push(`${n} instruction line contains the answer "${a}"`);
    }
    if (/\([^)]*\)/.test(front) && arrow && !isConjugationDrill(front)) {
      const shownF = cleanFrenchPrompt(front, back);
      if (shownF !== front) warn.push(`${n} cleanFrenchPrompt strips part of the front: "${front}" → "${shownF}"`);
    }
    if (twoWay(cat)) {
      const pf = shortCommaPieces(front);
      if (pf) warn.push(`${n} French side splits on its comma into short pieces, each accepted alone: ${JSON.stringify(pf)}`);
      const pb = shortCommaPieces(back);
      if (pb) warn.push(`${n} English side splits on its comma into short pieces, each accepted alone: ${JSON.stringify(pb)}`);
    }
    if (front.includes("/")) warn.push(`${n} INFO front shows a slash to students: "${front}"`);

    const sides = twoWay(cat) ? ["fr", "en"] : ["fr"];
    const lines = [`${n} ${JSON.stringify(front)} → ${JSON.stringify(back)}${was ? `  (was ${JSON.stringify(was)})` : ""}`];
    if (instr) lines.push(`    line above card: "${instr}"`);
    for (const s of sides) {
      const { correct, extra, exact } = marking(L, card, s);
      const prompt = s === "fr" ? dropFinalPeriod(cleanFrenchPrompt(front, back)) : dropFinalPeriod(cleanEnglishPrompt(back));
      const lang = s === "en" ? "French" : arrow ? "French" : "English";
      lines.push(`    shown ${s === "fr" ? "French" : "English"} side: "${prompt}" — type ${lang}, ${exact ? "EXACT" : "fuzzy"}; accepts ${JSON.stringify(accepted(correct, extra, exact))}`);
    }
    console.log(lines.join("\n"));
  });
  for (const s of order) if (!counts[s]) warn.push(`teachingOrder lists "${s}" but no card uses it`);
  for (const s of Object.keys(L.instructions || {})) if (!counts[s]) warn.push(`instructions has "${s}" but no card uses it`);
  console.log(`\nsections: ${JSON.stringify(counts)}`);
  console.log(warn.length ? `\nWARNINGS (${warn.length}):\n- ${warn.join("\n- ")}` : "\nNo warnings.");
  // Notes shape
  const okBlocks = new Set(["lead", "sub", "note", "list", "forms", "pairs", "table"]);
  for (const sec of L.notes || []) {
    if (!sec.tab || !sec.h || !Array.isArray(sec.blocks)) console.log(`NOTES: bad section ${JSON.stringify(sec).slice(0, 80)}`);
    for (const b of sec.blocks || []) if (!okBlocks.has(b.t)) console.log(`NOTES: unknown block type "${b.t}" in ${sec.tab}`);
  }
}

async function tryOne(file, front, typed, shown = "fr") {
  const L = await loadLesson(file);
  const card = L.cards.find((c) => c[0] === front);
  if (!card) { console.log(`No card with front ${JSON.stringify(front)}`); process.exit(1); }
  const { correct, extra, exact } = marking(L, card, shown);
  const r = matchAnswer(typed, correct, extra, { exact });
  console.log(JSON.stringify({ front, shown, typed, exact, result: r.match ? (r.close ? "close enough (right)" : "right") : r.wrongArticle ? "wrong article" : "wrong" }));
}

async function all() {
  const dir = path.join(REPO, "src/data/lessons");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "index.js");
  const byFront = new Map();
  for (const f of files) {
    const L = await loadLesson(path.join(dir, f));
    for (const [front] of L.cards) {
      if (!byFront.has(front)) byFront.set(front, []);
      byFront.get(front).push(L.id);
    }
  }
  const dups = [...byFront].filter(([, ids]) => ids.length > 1);
  console.log(dups.length ? `Fronts in more than one lesson (they would overwrite each other):\n${dups.map(([f, ids]) => `- ${JSON.stringify(f)}: ${ids.join(", ")}`).join("\n")}` : "No front is in two lessons.");
}

const [a, ...rest] = process.argv.slice(2);
if (a === "--all") await all();
else if (rest[0] === "--try") await tryOne(a, rest[1], rest[2], rest[3]);
else if (a) await report(a);
else console.log("usage: see the top of this file");
