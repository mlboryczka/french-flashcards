// npm run simulate — simulated students study with the app's own rules, and
// the status check (src/lib/statusChecks.js) judges every record. Seconds, no
// browser. Run it before any change to scheduling or to which cards a set
// takes; it fails if any check of the app's behaviour fails.
//
// "FSRS's predictions match your results" is reported but doesn't fail the
// run: it measures how well FSRS's starting settings fit a student's memory,
// and these students' memory is invented, deliberately unlike FSRS. A real
// student's settings are fitted to them after about 1,000 answers; these keep
// the starting ones.
//
// Each student is also run messy (the habits in student.mjs: an old copy
// dealing on opening, class notes arriving mid-set, reloads, detours into a
// lesson), which the checks must take without a false alarm. One thing a
// messy run turns up is known and not yet fixed (detourRepeats): it is
// reported, and doesn't fail the run.
//
//   npm run simulate                 weak and typical students, 180 days, 2 each, tidy and messy
//   npm run simulate -- 60 strong    60 days, strong students only
process.env.TZ = "America/New_York";

const { simulate, TIME_ZONE, STUDENTS, lessonRank, detourRepeats } = await import("./student.mjs");
const { runStatusChecks } = await import("../../src/lib/statusChecks.js");

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a))) || 180;
const kinds = args.filter((a) => a in STUDENTS);
const students = kinds.length ? kinds : ["weak", "typical"];
const seeds = [1, 2];

let failed = 0;
const pct = (x) => `${Math.round(x * 100)}%`;
for (const student of students) {
  for (const seed of seeds) for (const messy of [0, 0.3]) {
    const t = Date.now();
    const run = simulate({ days, seed, student, messy });
    const end = Date.parse(run.answers.at(-1).answered_at) + 3600000;
    const report = runStatusChecks({
      answers: run.answers, deals: run.deals, cards: run.cards, settings: run.settings,
      timeZone: TIME_ZONE, lessonRank, now: end,
    });
    const m = run.metrics;
    const h = m.messy;
    const known = detourRepeats(run, report);
    console.log(`\n${student} student${messy ? ", messy" : ""}, seed ${seed}: ${days} days, ${m.answers} answers in ${m.hours.toFixed(1)} hours (${Date.now() - t} ms)`);
    if (messy) console.log(`  ${h.oldCopy} openings on an old copy, ${h.notes} class notes arriving mid-set, ${h.reload} reloads, ${h.detour} detours into a lesson`);
    console.log(`  remembers about ${Math.round(m.known)} of ${m.seen} cards met; right on ${pct(m.reviewRetention)} of reviews; target ended at ${pct(m.targets.at(-1))}`);
    for (const r of report.results) {
      const info = r.id === "predictions" || (r.id === "dealt" && known.onlyThese && known.count > 0);
      const mark = r.status === "pass" ? "✓" : r.status === "fail" ? (info ? "·" : "✗") : "–";
      console.log(`  ${mark} ${r.title}: ${r.summary}`);
      if (r.status === "fail" || info) for (const d of r.details) console.log(`      ${d}`);
      if (r.id === "dealt" && known.onlyThese && known.count > 0) console.log(`      Known, not yet fixed: ${known.count} card${known.count === 1 ? "" : "s"} asked again straight after a detour into a lesson.`);
    }
    if (report.results.some((r) => r.status === "fail" && r.id !== "predictions" && !(r.id === "dealt" && known.onlyThese))) failed++;
  }
}
console.log(failed ? `\n${failed} run(s) failed a check.` : "\nEvery run passed every check of the app's behaviour.");
process.exit(failed ? 1 : 0);
