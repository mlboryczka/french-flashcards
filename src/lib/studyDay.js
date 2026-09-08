// Which calendar day a review counts towards.
//
// This is the user's own day, not UTC. It used to be
// `new Date().toISOString().slice(0, 10)`, which rolls over at midnight in
// London — early evening across the Americas. That broke the streak in both
// directions at once:
//
//   • Study at 10am and again at 8pm in New York and the two land on
//     different UTC dates. One day of work counts as two.
//   • Study Monday 10am and Tuesday 8pm and they record as Monday and
//     Wednesday. The Tuesday-shaped hole resets the streak to zero on two
//     consecutive days of studying.
//
// Kept here rather than in the component so it can be tested against a fixed
// timezone, which is the only way to catch this class of bug.

export function localISODate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
