// Which day a review counts towards. Run under a fixed timezone, because a
// timezone bug is invisible from the timezone it was written in.
// Pin the timezone before the first Date is constructed. Without this the
// suite passes trivially on a machine that happens to run in UTC — which is
// what CI does, and is exactly how a timezone bug survives a test suite.
process.env.TZ = "America/New_York";

import { checker } from "../check.mjs";
import { localISODate, reviewedToday, endOfLocalDay, startOfLocalDay } from "../../src/lib/studyDay.js";
import { scheduleAnswer } from "../../src/lib/spacedRepetition.js";

const ck = checker();
console.log(`\n  running as TZ=${process.env.TZ} (UTC-4/5)`);

// Guard the guard: if setting TZ didn't take, every check below is vacuous.
ck("the timezone actually applied",
   new Date("2026-03-10T01:00:00Z").getHours() === 21,
   `local hour is ${new Date("2026-03-10T01:00:00Z").getHours()}, expected 21`);

// 8pm in New York is already tomorrow in UTC. The old code used
// toISOString(), so this evening session was filed under the next day.
const evening = new Date("2026-03-10T01:00:00Z"); // 2026-03-09 21:00 in NY
const morning = new Date("2026-03-09T14:00:00Z"); // 2026-03-09 10:00 in NY

ck("a morning session is filed under the local day",
   localISODate(morning) === "2026-03-09", localISODate(morning));
ck("so is an evening one, after UTC has already rolled over",
   localISODate(evening) === "2026-03-09", localISODate(evening));
ck("both sessions on one day count as ONE day",
   localISODate(morning) === localISODate(evening),
   `${localISODate(morning)} vs ${localISODate(evening)}`);
ck("which UTC got wrong", evening.toISOString().slice(0, 10) === "2026-03-10",
   "the bug this replaces");

// Two consecutive evenings must be two consecutive days, with no hole
// between them for the streak to break on.
const monEve = new Date("2026-03-10T01:00:00Z"); // Mon 9th, 9pm NY
const tueEve = new Date("2026-03-11T01:00:00Z"); // Tue 10th, 9pm NY
ck("consecutive evenings are consecutive days",
   localISODate(monEve) === "2026-03-09" && localISODate(tueEve) === "2026-03-10",
   `${localISODate(monEve)} → ${localISODate(tueEve)}`);

// Morning then next evening — the pairing that used to record Mon and Wed
// and reset the streak on two days of unbroken study.
ck("morning then next evening leaves no gap",
   localISODate(morning) === "2026-03-09" && localISODate(tueEve) === "2026-03-10",
   `${localISODate(morning)} → ${localISODate(tueEve)}`);

// Padding, on a date where it matters.
ck("single-digit months and days are padded",
   localISODate(new Date(2026, 0, 5, 12)) === "2026-01-05",
   localISODate(new Date(2026, 0, 5, 12)));

// ── One FSRS answer per card per day ─────────────────────────────────────
// A card already reviewed today must not be reviewed again. "Today" is the
// student's own day, so the same UTC trap applies here as to the streak.
console.log("\n  a card has had its review for the day");
ck("a card never reviewed has not",
   reviewedToday(null, evening) === false);
ck("a garbage timestamp does not block the answer",
   reviewedToday("not a date", evening) === false);
ck("reviewed this morning, answered again this evening: already reviewed",
   reviewedToday(morning.toISOString(), evening) === true);
ck("reviewed last night at 9pm, answered this morning: a new day, records",
   reviewedToday(new Date("2026-03-09T01:00:00Z").toISOString(), morning) === false,
   "Mar 8th 9pm NY vs Mar 9th 10am NY");
ck("reviewed at 9pm, answered at 10pm: same local day even though UTC has rolled over",
   reviewedToday(evening.toISOString(), new Date("2026-03-10T02:00:00Z")) === true);

// ── The day starts at 4am ────────────────────────────────────────────────
// As Anki's does. A session that runs past midnight is one day's work: with
// midnight as the line, cards answered at 10:30pm were counted again at
// 12:30am as the next day's review (the simulated student test, 2026-09-25).
console.log("\n  the student's day runs from 4am to 4am");
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min);
ck("12:30am belongs to the day before", localISODate(at(2026, 10, 2, 0, 30)) === "2026-10-01", localISODate(at(2026, 10, 2, 0, 30)));
ck("so does 3:59am", localISODate(at(2026, 10, 2, 3, 59)) === "2026-10-01", localISODate(at(2026, 10, 2, 3, 59)));
ck("4am starts the new day", localISODate(at(2026, 10, 2, 4, 0)) === "2026-10-02", localISODate(at(2026, 10, 2, 4, 0)));
ck("answered at 10:30pm, again at 12:30am: already reviewed today",
   reviewedToday(at(2026, 10, 1, 22, 30).toISOString(), at(2026, 10, 2, 0, 30)) === true);
ck("answered at 3am, again at 9am: a new day, records",
   reviewedToday(at(2026, 10, 2, 3, 0).toISOString(), at(2026, 10, 2, 9, 0)) === false);
ck("the day ends at 3:59:59.999 the next morning",
   endOfLocalDay(at(2026, 10, 1, 10)) === at(2026, 10, 2, 4).getTime() - 1,
   new Date(endOfLocalDay(at(2026, 10, 1, 10))).toString());
ck("at 1am the day still began at 4am yesterday",
   startOfLocalDay(at(2026, 10, 2, 1)) === at(2026, 10, 1, 4).getTime(),
   new Date(startOfLocalDay(at(2026, 10, 2, 1))).toString());
// The clocks go back at 2am on 1 November 2026: 1:30am happens twice, and
// both belong to 31 October, whose day is 25 hours long.
const firstOneThirty = new Date("2026-11-01T05:30:00Z");  // 1:30 EDT
const secondOneThirty = new Date("2026-11-01T06:30:00Z"); // 1:30 EST
ck("both 1:30ams of the night the clocks go back belong to 31 October",
   localISODate(firstOneThirty) === "2026-10-31" && localISODate(secondOneThirty) === "2026-10-31",
   `${localISODate(firstOneThirty)} / ${localISODate(secondOneThirty)}`);
ck("and that day ends at 4am standard time",
   endOfLocalDay(at(2026, 10, 31, 22)) === new Date("2026-11-01T09:00:00Z").getTime() - 1,
   new Date(endOfLocalDay(at(2026, 10, 31, 22))).toISOString());

// ── FSRS counts the gap between answers in the student's days ────────────
// ts-fsrs counts by UTC date, and UTC's day turns at 8pm in New York. A word
// answered at 9pm and again the next morning was "0 days apart", so the right
// answer earned nothing, while one answered the next evening earned a day's
// credit. The student's calendar is what counts: same day apart, same credit.
console.log("\n  FSRS counts the days between answers the way the student lives them");
{
  const missedMonNight = scheduleAnswer({ fsrs_state: 0 }, false, at(2026, 10, 5, 21).getTime());
  const tueMorning = scheduleAnswer(missedMonNight, true, at(2026, 10, 6, 7, 30).getTime());
  const tueNight = scheduleAnswer(missedMonNight, true, at(2026, 10, 6, 21).getTime());
  ck("missed on Monday at 9pm, right on Tuesday morning: a day's credit, as on Tuesday at 9pm",
     tueMorning.stability === tueNight.stability && tueMorning.stability > missedMonNight.stability,
     `Mon ${missedMonNight.stability} → Tue am ${tueMorning.stability} / Tue pm ${tueNight.stability}`);

  const learnedTueNight = scheduleAnswer({ fsrs_state: 0 }, true, at(2026, 10, 6, 21).getTime());
  const friMorning = scheduleAnswer(learnedTueNight, true, at(2026, 10, 9, 7, 30).getTime());
  const friNight = scheduleAnswer(learnedTueNight, true, at(2026, 10, 9, 21).getTime());
  ck("learned on Tuesday at 9pm, right on Friday: morning or night, the same three days' credit",
     friMorning.stability === friNight.stability,
     `Fri am ${friMorning.stability} / Fri pm ${friNight.stability}`);

  const due = new Date(learnedTueNight.next_due_at);
  ck("the next due date keeps the clock time of the answer",
     due.getHours() === 21 && due.getMinutes() === 0, due.toString());
  const lateNight = scheduleAnswer({ fsrs_state: 0 }, false, at(2026, 10, 1, 23, 50).getTime());
  ck("a miss at 11:50pm is due the next day, not two days on",
     localISODate(new Date(lateNight.next_due_at)) === "2026-10-02", lateNight.next_due_at);
  const afterMidnight = scheduleAnswer({ fsrs_state: 0 }, false, at(2026, 10, 2, 0, 20).getTime());
  ck("and so is a miss at 12:20am, which belongs to the day before",
     localISODate(new Date(afterMidnight.next_due_at)) === "2026-10-02", afterMidnight.next_due_at);
}

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
