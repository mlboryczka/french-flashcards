// Which day a review counts towards. Run under a fixed timezone, because a
// timezone bug is invisible from the timezone it was written in.
// Pin the timezone before the first Date is constructed. Without this the
// suite passes trivially on a machine that happens to run in UTC — which is
// what CI does, and is exactly how a timezone bug survives a test suite.
process.env.TZ = "America/New_York";

import { checker } from "../check.mjs";
import { localISODate } from "../../src/lib/studyDay.js";

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
   localISODate(new Date(2026, 0, 5)) === "2026-01-05",
   localISODate(new Date(2026, 0, 5)));

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
