// Re-runs the upload's own card pipeline (the snapshot's exported functions)
// on exactly what the Claude stand-in returns, to find why a commit chunk
// was refused.
import fs from "node:fs";
import path from "node:path";
const WORK = process.env.WORK;
const APP = path.join(WORK, "app");
const pc = await import(path.join(APP, "api/parse-cahier.js"));
const { RAW } = await import(path.join(APP, "src/data/cards.js"));
const { HANDWRITTEN } = await import(path.join(WORK, "servers/handwritten-cards.mjs"));
const blocks = pc.sliceIntoBlocks(fs.readFileSync("/Users/mboryczka/Downloads/Cahier Matthew.txt", "utf8"));
const rawLast = RAW.flatMap((r) => r[3]).sort().at(-1);
const CAT = { vocab: "V", expr: "V", gram: "G", pron: "V" };
const cardsFor = (date) => date > rawLast
  ? (HANDWRITTEN[date] || []).map(([front, back]) => ({ front, back, category: "V" }))
  : RAW.filter((r) => r[3].includes(date)).map(([front, back, cat]) => ({ front, back, category: CAT[cat] }));
// cahier-parse's callClaudeOnce post-processing, per block
let all = [];
for (const b of blocks) {
  const cards = cardsFor(b.date).map((c) => ({ ...c, dates: [b.date] }));
  const cleaned = cards.map((c) => ({ ...c, front: pc.cleanFrenchFront(c.front, c.back) }));
  all.push(...pc.keepAnswerable(pc.splitSlashPairs(cleaned)));
}
// the commit
const cleanedCards = all.map((c) => (c && c.front && c.back ? { ...c, front: pc.cleanFrenchFront(c.front, c.back) } : c));
const splitCards = pc.splitSlashPairs(cleanedCards);
const { expanded } = pc.expandConjugations(splitCards);
const answerable = pc.keepAnswerable(expanded);
const { deduped, splits } = pc.dedupeWithPolysemy(answerable);
console.log({ raw: all.length, expanded: expanded.length, answerable: answerable.length, deduped: deduped.length, splits });
const byFront = new Map();
deduped.forEach((c, i) => { if (!byFront.has(c.front)) byFront.set(c.front, []); byFront.get(c.front).push({ i, c }); });
for (const [f, list] of byFront) if (list.length > 1) console.log("DUPLICATE FRONT", JSON.stringify(f), "at indexes", list.map((x) => x.i), list.map((x) => x.c.back));
const splitOnes = deduped.filter((c) => /\)$/.test(c.front)).slice(0, 0);
// which chunk(s) of 500 hold duplicates
for (let i = 0; i < deduped.length; i += 500) {
  const fr = deduped.slice(i, i + 500).map((c) => c.front);
  const dups = fr.filter((f, j) => fr.indexOf(f) !== j);
  console.log(`chunk ${i / 500}: rows ${fr.length}, duplicate fronts ${dups.length}`, dups.slice(0, 5));
}
// the two polysemy splits
const groups = new Map();
for (const c of answerable) { const k = c.front.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
for (const [k, g] of groups) { const backs = [...new Set(g.map((c) => c.back))]; if (backs.length > 1) { const outs = deduped.filter((d) => d.front.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").startsWith(k)); if (outs.length > 1) console.log("SPLIT GROUP", k, "→", outs.map((o) => o.front)); } }
