const REPO = "/Users/mboryczka/Desktop/Projects/french-flashcards";
const { applyAnswer } = await import(`${REPO}/src/lib/sessionQueue.js`);
const { sideOf } = await import(`${REPO}/src/lib/directions.js`);
const DAY = 86400000;
// Two words, each reviewed exactly when due (noon), always right from the
// point shown. Word A: right from the start. Word B: missed the first time
// and once more on its second review, then right every time.
function run(pattern) {
  let card = { row_id: 1, cat: "vocab", shownDir: "fr" };
  let t = new Date(2026, 9, 5, 12, 0).getTime();
  const rows = [];
  for (const got of pattern) {
    card = { ...card, ...applyAnswer(card, got, t, "fr") };
    const s = sideOf(card, "fr");
    const gap = Math.round((new Date(s.next_due_at) - t) / DAY);
    rows.push({ got, difficulty: +s.difficulty.toFixed(2), gap });
    t = new Date(s.next_due_at).getTime();
    const d = new Date(t); d.setHours(12, 0, 0, 0); t = d.getTime();
  }
  return rows;
}
const A = run(Array(9).fill(true));
const B = run([false, true, false, ...Array(9).fill(true)]);
console.log("A (right from the start):", A.map(r => `${r.gap}d`).join(" "), " difficulty after:", A.at(-1).difficulty);
console.log("B (missed twice early): ", B.map(r => (r.got ? "" : "x") + `${r.gap}d`).join(" "), " difficulty after:", B.at(-1).difficulty);
console.log("B difficulty over time:", B.map(r => r.difficulty).join(" "));
