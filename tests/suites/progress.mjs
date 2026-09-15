// Seen, about N remembered, not yet seen — the one progress calculation every
// screen reads. No browser: src/lib/progress.js is pure.
process.env.TZ = "America/New_York";

import {
  retrievability, summarize, aboutRemembered, areaOf, progressByArea, progressChanges, areaDates,
} from "../../src/lib/progress.js";
import { localISODateDaysAgo } from "../../src/lib/studyDay.js";
import { checker } from "../check.mjs";

const ck = checker();
const DAY = 86400000;
const NOW = new Date("2026-09-12T14:00:00Z").getTime();
const close = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

const seenCard = (stabilityDays, lastSeenDaysAgo, extra = {}) => ({
  fsrs_state: 2, stability: stabilityDays, difficulty: 5, reps: 3, lapses: 0,
  last_review: new Date(NOW - lastSeenDaysAgo * DAY).toISOString(),
  next_due_at: new Date(NOW + DAY).toISOString(),
  dates: ["2026-01-10"], source: "cahier-upload", ...extra,
});
const unseen = (extra = {}) => ({ fsrs_state: 0, dates: ["2026-01-10"], source: "cahier-upload", ...extra });
// The same state, as a word's English-side schedule ("apple → ?").
const asEnglishSide = (side) => Object.fromEntries(Object.entries(side)
  .filter(([k]) => ["fsrs_state", "stability", "difficulty", "reps", "lapses", "last_review", "next_due_at"].includes(k))
  .map(([k, v]) => [`en_${k}`, v]));

console.log("\n  the estimate is FSRS's own recall probability right now");
{
  // Stability is defined as the days until recall falls to 90%.
  const r = retrievability(seenCard(60, 60), NOW);
  ck("stability 60, last seen 60 days ago: 90%", close(r, 0.9), r.toFixed(4));
  const fresh = retrievability(seenCard(60, 0), NOW);
  ck("just reviewed: close to 100%", fresh > 0.99, fresh.toFixed(4));
  const later = retrievability(seenCard(10, 30), NOW);
  const sooner = retrievability(seenCard(10, 5), NOW);
  ck("it decays: the same card is less likely recalled the longer it's been", later < sooner, `${later.toFixed(3)} < ${sooner.toFixed(3)}`);
  ck("a card never seen counts as nothing", retrievability(unseen(), NOW) === 0);
  ck("a legacy row with no stability counts as nothing, not NaN",
     retrievability({ fsrs_state: 2, stability: null, last_review: null }, NOW) === 0);
}

console.log("\n  seen, about N remembered, not yet seen");
{
  const cards = [seenCard(60, 60), seenCard(60, 60), seenCard(60, 0), unseen(), unseen()];
  const s = summarize(cards, NOW);
  ck("seen counts cards answered at least once", s.seen === 3, `${s.seen}`);
  ck("not yet seen is the rest", s.notSeen === 2 && s.total === 5, JSON.stringify(s));
  ck("remembered is the sum of the estimates", close(s.remembered, 0.9 + 0.9 + 1, 0.02), s.remembered.toFixed(3));
  ck("shown as a whole number of cards", aboutRemembered(s) === 3, `${aboutRemembered(s)}`);
  const empty = summarize([], NOW);
  ck("an empty area is all zeros", empty.total === 0 && empty.seen === 0 && empty.remembered === 0);
}

// The owner's definition (2026-09-14): a word or phrase is remembered when the
// student would get it right from French AND from English. Students see one
// figure; the two ways are only ever combined.
console.log("\n  a word counts as remembered only as far as it is remembered both ways");
{
  const known = (days) => seenCard(60, days);                // 60, 60 → 90%; 60, 0 → ~100%
  const both = seenCard(60, 60, { cat: "vocab", ...asEnglishSide(known(60)) });
  const frOnly = seenCard(60, 0, { cat: "vocab" });
  const enOnly = unseen({ cat: "vocab", ...asEnglishSide(known(0)) });
  const grammar = seenCard(60, 60, { cat: "gram" });
  const one = (c) => summarize([c], NOW);
  ck("known 90% each way: counts as the chance of both, 81%", close(one(both).remembered, 0.81, 0.02), one(both).remembered.toFixed(3));
  ck("never below what the two ways allow, never above the weaker way",
     one(both).remembered <= 0.9 + 1e-9, one(both).remembered.toFixed(3));
  ck("met only in French, however well: seen, but nothing remembered yet",
     one(frOnly).seen === 1 && one(frOnly).remembered === 0, JSON.stringify(one(frOnly)));
  ck("met only in English: the same", one(enOnly).seen === 1 && one(enOnly).remembered === 0, JSON.stringify(one(enOnly)));
  ck("a grammar card, asked one way, counts as that way", close(one(grammar).remembered, 0.9, 0.02), one(grammar).remembered.toFixed(3));
  ck("and never reads English-side columns it doesn't use",
     close(one({ ...grammar, ...asEnglishSide(unseen()) }).remembered, 0.9, 0.02));
  const s = summarize([both, frOnly, enOnly, grammar], NOW);
  ck("a set adds them up: 0.81 + 0 + 0 + 0.9", close(s.remembered, 1.71, 0.03) && s.seen === 4, JSON.stringify(s));
}

console.log("\n  which area a card counts towards");
{
  ck("a lesson card counts towards its lesson",
     areaOf({ source: "lesson:imperatif#abc", dates: [] }, NOW) === "lesson:imperatif");
  ck("a word from a class three days ago is recent",
     areaOf(unseen({ dates: [localISODateDaysAgo(3, new Date(NOW))] }), NOW) === "recent");
  ck("a word last seen in class a month ago is earlier",
     areaOf(unseen({ dates: [localISODateDaysAgo(30, new Date(NOW))] }), NOW) === "earlier");
  ck("a tutor card added yesterday is recent",
     areaOf({ source: "tutor-chat", dates: [], created_at: new Date(NOW - DAY).toISOString() }, NOW) === "recent");
  ck("a card with no date at all is earlier", areaOf(unseen({ dates: [] }), NOW) === "earlier");
}

console.log("\n  where the line between the two class groups falls");
{
  const since = localISODateDaysAgo(14, new Date(NOW));
  const cards = [unseen({ dates: [since] }), unseen({ dates: ["2025-05-13", "2026-03-01"] }), unseen({ dates: ["2025-11-02"] })];
  const d = areaDates(cards, NOW);
  ck("the recent group starts 14 days back, and a class on that day is in it",
     d.since === since && areaOf(cards[0], NOW) === "recent", JSON.stringify(d));
  ck("the older group's first class is the earliest class of any card in it", d.earliestOlder === "2025-05-13", JSON.stringify(d));
  ck("with no older cards, there is no first class", areaDates([cards[0]], NOW).earliestOlder === null);
}

console.log("\n  what a block changed, per area");
{
  const recentDate = localISODateDaysAgo(2, new Date(NOW));
  const lessonNew = Array.from({ length: 8 }, () => unseen({ source: "lesson:imperatif#k", dates: [] }));
  const notes = Array.from({ length: 5 }, () => unseen({ dates: [recentDate] }));
  const untouched = [seenCard(30, 3)];
  const before = progressByArea([...lessonNew, ...notes, ...untouched], NOW);
  // The block: all 8 lesson cards answered, nothing else.
  const lessonDone = lessonNew.map((c) => ({ ...c, ...seenCard(3, 0), source: c.source, dates: [] }));
  const after = progressByArea([...lessonDone, ...notes, ...untouched], NOW);
  const changes = progressChanges(before, after);
  ck("only the area the block touched is reported", changes.length === 1 && changes[0].area === "lesson:imperatif",
     JSON.stringify(changes.map((c) => c.area)));
  ck("8 more seen", changes[0]?.seenDelta === 8, `${changes[0]?.seenDelta}`);
  ck("about 8 more remembered, just after answering them", changes[0]?.rememberedDelta === 8, `${changes[0]?.rememberedDelta}`);
  ck("the whole deck is summed too", after.all.total === 14 && after.all.seen === 9, JSON.stringify(after.all));
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
