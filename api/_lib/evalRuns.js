// When the tests of Claude's work run, and what they report (2026-10-06).
//
// Two tests, both run by the server on their own (api/cahier-daily.js, one
// daily schedule each), never by a button: the owner's decisions in the app
// already are the right answers, and asking them again was busywork (owner,
// 2026-10-06).
//
//   answers  Claude's verdicts on "My answer should have been accepted"
//            (api/_lib/answerChecks.js)
//   notes    Claude reading class notes into cards, against the owner's
//            corrections (api/_lib/notesChecks.js)
//
// A test is due when it has never run, when the way Claude is asked has
// changed since its last run (its version), or a week after its last run (less
// half a day, since a run is stamped when it ends and the schedule fires any
// time in its hour). On any other day the schedule does nothing and costs
// nothing.
//
// Each case is asked three times, and Claude can answer differently each
// time with nothing changed, so one run's case is one of:
//   pass     right every time
//   fail     wrong more often than right
//   mixed    in between
//   untried  no usable answer at all (a time limit, Claude unavailable):
//            says nothing about Claude, and counts for nothing
//
// The red dot is for a change that made Claude worse, not for chance. It
// lights for a case that passed in the run before a change to how Claude is
// asked (a different version) and fails in the run after it, judged against
// the same right answer both times. Two runs of the same version differ only
// by chance, so between them nothing lights the dot (a reviewer worked it out
// at a few borderline cases lighting it most weeks). Cases Claude gets wrong
// are listed in the Status window either way.

export const RERUN_DAYS = 7;
const DAY = 86400000;
const SLACK = DAY / 2;

export function isDue(latest, version, now = Date.now()) {
  if (!latest) return true;
  if (latest.version !== version) return true;
  return now - Date.parse(latest.ran_at) >= RERUN_DAYS * DAY - SLACK;
}

// `right` of `asked` usable answers, as one of the four outcomes above.
export function outcome(right, asked) {
  if (!asked) return "untried";
  if (right === asked) return "pass";
  if (right * 2 < asked) return "fail";
  return "mixed";
}

// Cases that passed in `previous` and fail in `latest`, when a change came
// between them. `judge(case)` gives a case's outcome; `key(case)` what it was
// judged against (the right answer), which must be the same in both runs.
export function regressions(latest, previous, judge, key = () => "") {
  if (!latest || !previous || latest.version === previous.version) return [];
  const before = new Map((previous.results || []).filter((c) => judge(c) === "pass").map((c) => [c.id, key(c)]));
  return (latest.results || [])
    .filter((c) => before.has(c.id) && before.get(c.id) === key(c) && judge(c) === "fail")
    .map((c) => c.id);
}

// A run's cases counted. Untried cases are left out of the count and
// reported apart.
export function tally(cases, judge) {
  const out = { cases: 0, every: 0, sometimes: 0, never: 0, untried: 0 };
  for (const c of cases) {
    const o = judge(c);
    if (o === "untried") { out.untried++; continue; }
    out.cases++;
    if (o === "pass") out.every++;
    else if (o === "fail") out.never++;
    else out.sometimes++;
  }
  return out;
}

// Run `jobs` (functions returning promises) at most `limit` at a time; once
// `deadline` passes, jobs not yet started resolve to null rather than run.
export async function pooled(jobs, limit, deadline = Infinity) {
  const out = new Array(jobs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      if (Date.now() > deadline) continue;
      try { out[i] = await jobs[i](); } catch (e) { out[i] = { error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}
