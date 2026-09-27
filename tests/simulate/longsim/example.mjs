const REPO = "/Users/mboryczka/Desktop/Projects/french-flashcards";
const { applyAnswer } = await import(`${REPO}/src/lib/sessionQueue.js`);
const { sideOf } = await import(`${REPO}/src/lib/directions.js`);
const fmt = (iso) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const days = (a, b) => ((new Date(b) - new Date(a)) / 86400000).toFixed(1);
// A new word, missed the first time on Monday evening, so it is due Tuesday.
const t0 = new Date(2026, 9, 5, 21, 0).getTime();          // Mon 5 Oct, 9pm
let card = { row_id: 1, cat: "vocab", shownDir: "fr" };
card = { ...card, ...applyAnswer(card, false, t0, "fr") };
console.log("Mon 9pm, missed:", "next due", fmt(card.next_due_at), " stability", card.stability);
for (const [label, when] of [["Tue 7:30am", new Date(2026, 9, 6, 7, 30)], ["Tue 12:15pm", new Date(2026, 9, 6, 12, 15)], ["Tue 9pm", new Date(2026, 9, 6, 21, 0)]]) {
  const after = applyAnswer(card, true, when.getTime(), "fr");
  const s = sideOf(after, "fr");
  console.log(`  right again on ${label}: stability ${card.stability} -> ${s.stability.toFixed(2)}, next gap ${days(when, s.next_due_at)} days (due ${fmt(s.next_due_at)})`);
}
// A word answered right Tuesday evening with a 3-day gap, then reviewed Friday morning vs Friday evening.
let c2 = { row_id: 2, cat: "vocab", shownDir: "fr" };
c2 = { ...c2, ...applyAnswer(c2, true, new Date(2026, 9, 6, 21, 0).getTime(), "fr") };
console.log("Tue 9pm, new word right first time: next due", fmt(c2.next_due_at), " stability", c2.stability);
for (const [label, when] of [["Fri 7:30am", new Date(2026, 9, 9, 7, 30)], ["Fri 9pm", new Date(2026, 9, 9, 21, 0)]]) {
  const after = applyAnswer(c2, true, when.getTime(), "fr");
  const s = sideOf(after, "fr");
  console.log(`  right on ${label}: stability ${c2.stability} -> ${s.stability.toFixed(2)}, next gap ${days(when, s.next_due_at)} days`);
}
