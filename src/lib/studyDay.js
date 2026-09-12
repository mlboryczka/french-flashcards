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

// Whether a card has already had its review for the day.
//
// FSRS gets one answer per card per day: the first. The app's scheduler runs
// with short-term steps off, which models memory across DAYS, and a second
// answer minutes after the first says nothing about that — you have just been
// shown the answer. Recording it anyway moved the schedule the wrong way every
// time. Measured against this app's own scheduler settings:
//
//   • a known card missed, then right on the retry: due in 3 days became 4,
//     and last_answer_correct flipped back to true, so the miss lost its place
//     at the front of the next session
//   • missed, then wrong again on the retry: counted as forgotten TWICE, with
//     difficulty pushed near its maximum, for one bad moment
//   • a new card missed, then right on the retry: due tomorrow became 3 days,
//     as if it had been learned
//
// Read off the card's own last_review rather than tracked in the session, so
// it covers every route to a second answer: the in-session retry, Previous
// card, a reload mid-session, and a second device on the same day.
export function reviewedToday(lastReview, now = new Date()) {
  if (!lastReview) return false;
  const t = new Date(lastReview);
  if (Number.isNaN(t.getTime())) return false;
  return localISODate(t) === localISODate(now);
}

// The last millisecond of the student's day. A card due any time before this
// is due TODAY: the day's work is known in the morning, rather than growing
// through the afternoon as cards cross their exact due time.
export function endOfLocalDay(now = new Date()) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// The student's local date `days` before `now`, as YYYY-MM-DD — the same
// shape class dates are stored in, so the two compare as strings.
export function localISODateDaysAgo(days, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return localISODate(d);
}
