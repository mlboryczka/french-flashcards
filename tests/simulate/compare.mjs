// npm run simulate:compare — which "How much to remember" choice leaves a
// student remembering the most for the time they spend?
//
// The same simulated students (same cards, same days off, same luck at the
// start) study for six months under each choice. Reported for each: how many
// cards they'd remember at the end, how many hours it took, and the two
// divided — cards remembered per hour of study. Averaged over several runs,
// and only a difference that holds for every kind of student and both study
// habits is worth acting on: the students' memory is invented
// (tests/simulate/student.mjs), so a result is only as good as that.
//
// Two habits: studying the same number of sets a day whatever is due, and
// keeping going until the day's due cards are done (up to six sets).
//
//   npm run simulate:compare                180 days, 4 runs per student
//   npm run simulate:compare -- 120 6       120 days, 6 runs
process.env.TZ = "America/New_York";

const { simulate, STUDENTS } = await import("./student.mjs");

const [daysArg, seedsArg] = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const days = daysArg || 180;
const seeds = Array.from({ length: seedsArg || 4 }, (_, i) => 101 + i);
const CHOICES = [["Automatic", "auto"], ["Lighter load (85%)", 0.85], ["Standard (90%)", 0.9], ["Remember more (95%)", 0.95]];

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const pad = (s, n) => String(s).padEnd(n);

const HABITS = [["sets", "the same number of sets a day"], ["due", "until the day's due cards are done"]];
const out = {};
for (const [habit, habitLabel] of HABITS) for (const student of Object.keys(STUDENTS)) {
  console.log(`\n${student} student studying ${habitLabel}: ${days} days, ${seeds.length} runs each`);
  console.log(`  ${pad("choice", 22)}${pad("remembered", 13)}${pad("hours", 9)}${pad("per hour", 12)}${pad("answers/day", 13)}right on reviews`);
  const key = `${student}/${habit}`;
  out[key] = {};
  for (const [label, target] of CHOICES) {
    const runs = seeds.map((seed) => simulate({ days, seed, student, target, habit }).metrics);
    const known = runs.map((m) => m.known);
    const perHour = runs.map((m) => m.knownPerHour);
    const row = {
      remembered: mean(known), hours: mean(runs.map((m) => m.hours)), perHour: mean(perHour), perHourSd: sd(perHour),
      answersPerDay: mean(runs.map((m) => m.answers / days)), retention: mean(runs.map((m) => m.reviewRetention)),
    };
    out[key][label] = row;
    console.log(`  ${pad(label, 22)}${pad(Math.round(row.remembered), 13)}${pad(row.hours.toFixed(1), 9)}${pad(`${row.perHour.toFixed(1)} ±${row.perHourSd.toFixed(1)}`, 12)}${pad(row.answersPerDay.toFixed(0), 13)}${Math.round(row.retention * 100)}%`);
  }
}
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
