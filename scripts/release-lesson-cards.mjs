#!/usr/bin/env node
// Record every lesson card that has gone out to students' decks.
//
//   node scripts/release-lesson-cards.mjs
//
// A lesson card is known in every deck by its FIRST wording (lessonCardKey of
// its fifth element if it was reworded, else of its front). If a card is
// reworded without keeping that first wording, or dropped from its lesson,
// every deck's copy stops matching, and the lesson sync takes it out of study.
// tests/released-lesson-cards.json lists every card identity ever released, and
// the `logic` suite fails if one of them stops matching a card in its lesson
// without being moved to "retired" on purpose.
//
// Run this after adding cards to a lesson: it appends the new ones and never
// removes anything. Retiring a card is a hand edit to the file, on purpose.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LESSONS } from "../src/data/lessons/index.js";
import { lessonCardKey } from "../src/lib/lessonSource.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "tests", "released-lesson-cards.json");

const list = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { released: {}, retired: {} };
let added = 0;
for (const lesson of LESSONS) {
  const have = new Set((list.released[lesson.id] || []).map((c) => c.key));
  for (const [front, , , , was] of lesson.cards) {
    const first = was ?? front;
    const key = lessonCardKey(first);
    if (have.has(key)) continue;
    (list.released[lesson.id] ||= []).push({ key, front: first });
    have.add(key);
    added++;
  }
}
fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + "\n");
console.log(added ? `Added ${added} card(s) to ${path.relative(ROOT, FILE)}.` : "Every lesson card is already on the list.");
