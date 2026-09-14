// Card types: the Grammar / Vocab / Phrases filter in the Cards view, and the
// By type breakdown in Stats.
import { openApp, finish, checker, gotoStats, sessionCounter, servedDeck, firstBlockItems } from "../harness.mjs";
import { classifyCard, CARD_TYPES, TYPE_LABEL } from "../../src/lib/cardTypes.js";
import { CAT_DB_TO_UI } from "../../src/lib/cardCategories.js";

const ck = checker();
const { browser, page } = await openApp();

// What the fixture actually contains, so no count is baked in here.
const deck = await servedDeck();
// Counted in questions — a card asked one way round — because that is what a
// block is made of: a word can be in it both ways.
const expected = { grammar: 0, vocab: 0, phrase: 0 };
const items = firstBlockItems(deck);
for (const { row } of items) {
  expected[classifyCard({ f: row.front, b: row.back, cat: CAT_DB_TO_UI[row.category] || "vocab" })]++;
}
console.log(`  fixture: ${deck.length} cards, ${items.length} questions — ${JSON.stringify(expected)}`);

console.log("\n  the filter chips");
const chips = await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .map((b) => b.textContent.trim())
    .filter((t) => ["All", "Grammar", "Vocab", "Phrases"].includes(t))
);
ck("all four chips are in the Cards view", ["All", "Grammar", "Vocab", "Phrases"].every((t) => chips.includes(t)), JSON.stringify(chips));

const all = (await sessionCounter(page)).total;
ck("All shows the whole deck", all === items.length, `${all} vs ${items.length}`);

const counted = {};
for (const type of CARD_TYPES) {
  const label = TYPE_LABEL[type] === "Phrase" ? "Phrases" : TYPE_LABEL[type];
  await page.click(`button:text-is("${label}")`);
  await page.waitForTimeout(900);
  const counter = await sessionCounter(page);
  // A filter with nothing in it has no counter — the app shows an empty state
  // rather than a broken session, and the suite has to survive that too.
  counted[type] = counter ? counter.total : 0;
  ck(`${label} shows exactly its own cards`, counted[type] === expected[type], `${counted[type]} vs ${expected[type]}`);
  if (expected[type] === 0) {
    ck(`${label} with nothing in it says so`, /no cards|nothing|all caught up|session complete/i.test(await page.evaluate(() => document.body.innerText)));
  }
}
ck(
  "the three types account for the whole deck",
  CARD_TYPES.reduce((n, t) => n + counted[t], 0) === all,
  `${CARD_TYPES.map((t) => counted[t]).join(" + ")} vs ${all}`
);

await page.click('button:text-is("All")');
await page.waitForTimeout(900);
ck("All restores the full session", (await sessionCounter(page)).total === all);
ck(
  "the selected chip reads as selected",
  (await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "All");
    return getComputedStyle(b).backgroundColor;
  })) !== "rgba(0, 0, 0, 0)"
);

console.log("\n  the By type panel in Stats");
await gotoStats(page);
const rows = await page.evaluate(() => {
  const h = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "By type");
  if (!h) return null;
  const grid = h.parentElement.querySelector("div:last-child");
  return [...grid.children].map((c) => c.innerText.replace(/\n/g, " · "));
});
console.log("  " + (rows ? rows.join("\n  ") : "(no By type section)"));
ck("the breakdown exists", !!rows && rows.length > 0);
ck(
  "named Grammar / Vocab / Phrase",
  !!rows && ["grammar", "vocab", "phrase"].every((t) => rows.some((r) => new RegExp("^" + t, "i").test(r)))
);
ck("no trace of the old Vocabulary label", !/Vocabulary/.test(await page.evaluate(() => document.body.innerText)));

await finish(browser, ck);
