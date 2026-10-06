#!/usr/bin/env node
// Print a lesson's notes as the panel reads them, and flag breaches of the
// notes rules in .claude/skills/building-lessons/SKILL.md that a script can see.
//
//   node notescheck.mjs <lesson.js>

import path from "node:path";
import { pathToFileURL } from "node:url";

const file = path.resolve(process.argv[2] || "");
const L = (await import(pathToFileURL(file).href + `?t=${Date.now()}`)).default;
const warn = [];
const out = [];

// The panel's rich(): split on **bold** and *italic*; anything left with a * is a stray.
const richLeft = (s) => String(s).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean)
  .map((p) => p.startsWith("**") ? p.slice(2, -2) : p.startsWith("*") ? p.slice(1, -1) : p);

const JARGON = /\b(agree|agrees|agreement|aspirate|mute h|liaison|elision|elided|determiner|partitive|conjugated|infinitive|subject pronoun|stem|radical)\b/i;
const POINTERS = /\b(above|below|earlier|the others|as before|see the|other tab|Leçon \d|lesson \d|everywhere else)\b/i;

const tabs = (L.notes || []).map((s) => s.tab);
const tabChars = tabs.join("").length;
out.push(`# ${L.title}  —  tabs: ${tabs.join(" · ")}  (${tabChars} characters; keep about 45 or fewer)`);
if (tabChars > 45) warn.push(`tab names total ${tabChars} characters (about 45 fit on one line)`);
let traps = 0;

for (const sec of L.notes || []) {
  out.push(`\n## [${sec.tab}] ${sec.h}`);
  if (sec.blocks?.[0]?.t !== "lead") warn.push(`[${sec.tab}] does not open with a lead`);
  const subs = sec.blocks.map((b, i) => [b, i]).filter(([b]) => b.t === "sub");
  const adv = subs.find(([b]) => /^Detail · advanced$/.test(b.v));
  if (adv && subs[subs.length - 1][1] !== adv[1]) warn.push(`[${sec.tab}] "Detail · advanced" is not the last subheading`);
  for (const b of sec.blocks) {
    const where = `[${sec.tab}] ${b.t}`;
    if (b.t === "lead" || b.t === "note") {
      const left = richLeft(b.v);
      if (left.some((p) => p.includes("*"))) warn.push(`${where}: a * survives the panel's split: ${b.v}`);
      if (/\*\*[^*]*\*[^*]+\*[^*]*\*\*/.test(b.v)) warn.push(`${where}: italics inside bold: ${b.v}`);
      if (/The trap:/.test(b.v)) traps++;
      if (JARGON.test(b.v)) warn.push(`${where}: grammar word "${b.v.match(JARGON)[0]}" — can an example replace it? ${b.v}`);
      if (POINTERS.test(b.v)) warn.push(`${where}: points elsewhere ("${b.v.match(POINTERS)[0]}"): ${b.v}`);
      out.push(`${b.t === "lead" ? "LEAD" : "note"}: ${left.join("")}`);
    } else if (b.t === "sub") {
      if (/\*/.test(b.v)) warn.push(`${where}: markup in a subheading`);
      out.push(`--- ${b.v}`);
    } else if (b.t === "table" || b.t === "pairs") {
      const cols = b.t === "pairs" ? b.head : b.cols;
      const rows = b.t === "pairs" ? b.v : b.rows;
      for (const c of [...cols, ...rows.flat(), b.caption || ""]) if (/\*/.test(c)) warn.push(`${where}: markup in a cell: ${c}`);
      if (POINTERS.test([...cols, b.caption || ""].join(" "))) warn.push(`${where}: heading points elsewhere`);
      if (b.caption) out.push(`(${b.caption})`);
      out.push(`| ${cols.join(" | ")} |`);
      for (const r of rows) out.push(`| ${r.join(" | ")} |`);
    } else if (b.t === "forms") {
      if (!b.label) warn.push(`${where}: forms without a label`);
      for (const f of b.v) if (/\*/.test(f)) warn.push(`${where}: markup in forms: ${f}`);
      out.push(`${b.label}: ${b.v.join(" · ")}`);
    } else if (b.t === "list") {
      for (const it of b.v) {
        const v = typeof it === "string" ? it : it.v;
        if (richLeft(v).some((p) => p.includes("*"))) warn.push(`${where}: a * survives in a list item`);
        out.push(`- ${richLeft(v).join("")}${it.ex ? ` (Example: ${it.ex})` : ""}`);
      }
    } else warn.push(`${where}: unknown block type`);
  }
}
if (traps > 1) warn.push(`${traps} "The trap:" sentences (at most one per lesson)`);
console.log(out.join("\n"));
console.log(warn.length ? `\nNOTES WARNINGS (${warn.length}):\n- ${warn.join("\n- ")}` : "\nNo notes warnings.");
