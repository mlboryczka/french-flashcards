// Long-horizon policy simulation. Uses the app's own pure modules (read-only
// imports) to deal blocks and schedule answers, with a hidden student memory
// model that is deliberately NOT FSRS. Run with TZ=America/New_York.
//
//   node longsim.mjs [days] [seeds]
//
// Variants:
//   current      the app as it is
//   localDays    elapsed days counted by the student's local calendar (fix)
//   siblings     localDays + one direction of a word per day
//   newCap       localDays + at most 25 new items a day
//   ret85        localDays + request retention 0.85
//   noSpot       localDays + no spot-checks
//   all          localDays + siblings + newCap

const REPO = "/Users/mboryczka/Desktop/Projects/french-flashcards";
const { buildSession, placeRetry, applyAnswer: appApplyAnswer } = await import(`${REPO}/src/lib/sessionQueue.js`);
const { toFsrsCard, fromFsrsCard, RE_QUEUE_OFFSET, State } = await import(`${REPO}/src/lib/spacedRepetition.js`);
const { sideOf, sideColumns, isTwoWay, otherDirection, directionsOf } = await import(`${REPO}/src/lib/directions.js`);
const { reviewedToday, localISODate } = await import(`${REPO}/src/lib/studyDay.js`);
const { RAW } = await import(`${REPO}/src/data/cards.js`);
const { LESSONS, lessonRank } = await import(`${REPO}/src/data/lessons/index.js`);
const { lessonSource, lessonCardKey } = await import(`${REPO}/src/lib/lessonSource.js`);
const { fsrs, Rating } = await import(`${REPO}/node_modules/ts-fsrs/dist/index.mjs`);

const DAYS = +(process.argv[2] || 180);
const SEEDS = +(process.argv[3] || 4);
const MID = Math.min(90, Math.floor((+(process.argv[2] || 180)) / 2));
const DAY = 86400000;
const HOUR = 3600000;

// ── seeded RNG ─────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng) {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── the deck, shaped as useUserDeck shapes it ─────────────────────────
function makeDeck() {
  const seen = new Set();
  const cards = [];
  let rowId = 1;
  const blank = {
    next_due_at: null, lapses: 0, stability: null, difficulty: null, fsrs_state: 0, reps: 0,
    last_review: null, last_answer_correct: null,
    en_next_due_at: null, en_lapses: 0, en_stability: null, en_difficulty: null, en_fsrs_state: 0,
    en_reps: 0, en_last_review: null, en_last_answer_correct: null,
  };
  for (const [f, b, cat, dates] of RAW) {
    const id = f.toLowerCase().trim();
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({ f, b, cat, dates: dates || [], freq: (dates || []).length, id, row_id: rowId++, source: "cahier-upload", created_at: null, ...blank });
  }
  for (const lesson of LESSONS) {
    for (const [front, back, cat, , was] of lesson.cards) {
      const id = front.toLowerCase().trim();
      if (seen.has(id)) continue;
      seen.add(id);
      cards.push({
        f: front, b: back, cat: cat || "gram", dates: [], freq: 0, id, row_id: rowId++,
        source: lessonSource(lesson.id, lessonCardKey(was ?? front)), created_at: null, ...blank,
      });
    }
  }
  return cards;
}

// ── hidden student ────────────────────────────────────────────────────
const STUDENTS = {
  weak: { kRight: 1.2, kWrong: 0.4, gBase: 1.5, gSlope: 4.0 },
  typical: { kRight: 2.4, kWrong: 0.5, gBase: 1.8, gSlope: 14.0 },
};
let STUDENT = STUDENTS[process.env.STUDENT || "weak"];

class Student {
  constructor(seed) {
    this.rng = mulberry32(seed);
    this.items = new Map(); // key -> { m, S, last, shown }
    this.traitRng = mulberry32(seed ^ 0x9e3779b9);
  }
  key(card, dir) { return `${card.row_id}:${dir}`; }
  trait(card, dir) {
    const k = this.key(card, dir);
    let it = this.items.get(k);
    if (!it) {
      // Traits drawn from a per-item RNG so every variant sees the same item.
      const r = mulberry32((card.row_id * 7919 + (dir === "en" ? 1 : 0)) ^ 0x51ed27);
      const m = Math.min(2.8, Math.max(0.35, Math.exp(0.45 * normal(r))));
      const twoWay = isTwoWay(card);
      const dirF = !twoWay ? 0.7 : dir === "en" ? 0.55 : 1.0;
      const catF = card.cat === "expr" ? 0.8 : 1.0;
      const b = !twoWay ? 0.12 : dir === "en" ? 0.08 : 0.22;
      const n = Math.max(1, (card.dates || []).length);
      it = { m, dirF, catF, pFirst: Math.min(0.8, 1 - Math.pow(1 - b, n)), S: null, last: null };
      this.items.set(k, it);
    }
    return it;
  }
  // Probability right now, and the raw (unprimed) recall.
  prob(card, dir, now) {
    const it = this.trait(card, dir);
    if (it.last === null) return { p: it.pFirst, pRaw: it.pFirst, t: null, first: true };
    const t = (now - it.last) / DAY;
    const pRaw = Math.pow(0.9, t / it.S);
    let p = pRaw;
    if (isTwoWay(card)) {
      const o = this.items.get(this.key(card, otherDirection(dir)));
      if (o && o.last !== null && now - o.last <= 12 * HOUR) p = 1 - (1 - p) * 0.35;
    }
    if (now - it.last <= 2 * HOUR) p = Math.max(p, 0.85);
    return { p, pRaw, t, first: false };
  }
  answer(card, dir, now) {
    const it = this.trait(card, dir);
    const pr = this.prob(card, dir, now);
    const got = this.rng() < pr.p;
    if (pr.first) {
      it.S = (got ? STUDENT.kRight : STUDENT.kWrong) * it.m * it.dirF * it.catF;
    } else if (pr.t >= 0.5) {
      it.S = got ? it.S * (STUDENT.gBase + STUDENT.gSlope * (1 - (process.env.GROWTH_RAW ? pr.pRaw : pr.p))) : Math.max(0.3, it.S * 0.3);
    }
    it.last = now;
    return { got, ...pr };
  }
  // Expected number of items known at `now` (true memory).
  truePr(card, dir, now) {
    const it = this.items.get(this.key(card, dir));
    if (!it || it.last === null) return 0;
    return Math.pow(0.9, (now - it.last) / DAY / it.S);
  }
}

// ── scheduling variants ───────────────────────────────────────────────
// Same settings as src/lib/spacedRepetition.js, retention aside.
const schedulers = {
  0.9: fsrs({ request_retention: 0.9, maximum_interval: 3650, enable_fuzz: true, enable_short_term: false }),
  0.85: fsrs({ request_retention: 0.85, maximum_interval: 3650, enable_fuzz: true, enable_short_term: false }),
};

// A timestamp re-expressed so that its UTC fields are the student's local
// fields: ts-fsrs then counts elapsed days by the local calendar.
const toLocalAsUTC = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
};
const fromLocalAsUTC = (ms) => {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()).getTime();
};

function unfloor(next, got, nowMs, sched, v) {
  if (!v.noFloor || !got) return next;
  const ivl = sched.next_interval(next.stability, next.elapsed_days ?? 0);
  return { ...next, scheduled_days: ivl, due: new Date(nowMs + ivl * DAY) };
}

function applyVariant(card, got, now, dir, v) {
  if (!v.localDays && v.retention === 0.9 && !v.noFloor) return appApplyAnswer(card, got, now, dir);
  const side = sideOf(card, dir);
  const sched = schedulers[v.retention];
  if (!v.localDays) {
    let { card: next } = sched.next(toFsrsCard(side), new Date(now), got ? Rating.Good : Rating.Again);
    next = unfloor(next, got, now, sched, v);
    return sideColumns(fromFsrsCard(next, got), dir);
  }
  const shifted = { ...side, last_review: side.last_review ? new Date(toLocalAsUTC(new Date(side.last_review).getTime())).toISOString() : null };
  let { card: next } = sched.next(toFsrsCard(shifted), new Date(toLocalAsUTC(now)), got ? Rating.Good : Rating.Again);
  next = unfloor(next, got, toLocalAsUTC(now), sched, v);
  const out = fromFsrsCard(next, got);
  out.next_due_at = new Date(fromLocalAsUTC(new Date(out.next_due_at).getTime())).toISOString();
  out.last_review = new Date(now).toISOString();
  return sideColumns(out, dir);
}

const sameLocalDay = (a, b) => localISODate(new Date(a)) === localISODate(new Date(b));

// The deck as a block builder sees it under a variant: for "siblings", a
// word's second direction is kept for another day.
function viewForBuild(deck, now, v) {
  if (!v.siblings) return deck;
  const tomorrowNoon = (() => { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.toISOString(); })();
  const endToday = (() => { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); })();
  return deck.map((c) => {
    if (!isTwoWay(c)) return c;
    const fr = sideOf(c, "fr"), en = sideOf(c, "en");
    const doneToday = (s) => s.fsrs_state !== 0 && s.last_review && sameLocalDay(s.last_review, now);
    const dueToday = (s) => s.fsrs_state !== 0 && s.next_due_at && new Date(s.next_due_at).getTime() <= endToday;
    let hide = null;
    if (doneToday(fr) && !doneToday(en)) hide = "en";
    else if (doneToday(en) && !doneToday(fr)) hide = "fr";
    else if (!doneToday(fr) && !doneToday(en)) {
      if (dueToday(fr) && dueToday(en)) hide = new Date(fr.next_due_at) <= new Date(en.next_due_at) ? "en" : "fr";
      else if (dueToday(fr) && en.fsrs_state === 0) hide = "en";
      else if (dueToday(en) && fr.fsrs_state === 0) hide = "fr";
    }
    if (!hide) return c;
    // Hidden for today: not new, not due, not well known.
    return { ...c, ...sideColumns({ fsrs_state: State.Review, next_due_at: tomorrowNoon, stability: 1 }, hide) };
  });
}

function buildBlock(deck, now, v, newToday) {
  const { queue } = buildSession(viewForBuild(deck, now, v), {
    now, direction: "mix", lessonRank, spotCheckSlots: v.noSpot ? 0 : 2,
  });
  if (!v.newCap) return queue;
  let room = Math.max(0, v.newCap - newToday);
  return queue.filter((it) => it._bucket !== "new" || room-- > 0);
}

// ── one run ───────────────────────────────────────────────────────────
function run(v, seed) {
  const deck = makeDeck();
  const byRow = new Map(deck.map((c) => [c.row_id, c]));
  const student = new Student(seed);
  const sched = mulberry32(seed * 31 + 7); // the study calendar, same across variants
  const start = new Date(2026, 8, 25, 0, 0, 0).getTime();
  const TIMES = [[7, 30], [12, 15], [18, 0], [20, 45], [22, 30]];
  const m = {
    answers: 0, counted: 0, newIntroduced: 0, dueReviews: 0, dueRight: 0, spot: 0, spotRight: 0,
    predSum: 0, ll: 0, perDay: [], dueLeft: [], calib: new Map(), sibSameDay: 0, sibFirst: 0, sibSecondRight: 0, sibSecondN: 0,
    zeroDayCounted: 0, knownAt: {},
  };
  for (let day = 0; day < DAYS; day++) {
    // Calendar drawn first so every variant studies on the same days/times.
    const studies = day === 0 || sched() < 0.85;
    const [h, mi] = TIMES[Math.floor(sched() * TIMES.length)];
    const r = sched();
    const blocks = day === 0 ? 4 : r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
    const dayStart = new Date(start); dayStart.setDate(dayStart.getDate() + day);
    let now = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), day === 0 ? 18 : h, day === 0 ? 0 : mi).getTime();
    let answersToday = 0, newToday = 0;
    const shownToday = new Map(); // cardId -> first dir shown today
    if (studies) {
      for (let b = 0; b < blocks; b++) {
        let block = buildBlock(deck, now, v, newToday);
        if (!block.length) break;
        for (let idx = 0; idx < block.length; idx++) {
          const item = block[idx];
          const card = byRow.get(item.row_id);
          const dir = item.shownDir;
          const side = sideOf(card, dir);
          const counted = !item._retry && !reviewedToday(side.last_review, new Date(now));
          const wasNew = side.fsrs_state === 0;
          // FSRS's prediction before the answer.
          let predR = null;
          if (counted && !wasNew && side.stability > 0 && side.last_review) {
            const tExact = Math.max(0, (now - new Date(side.last_review).getTime()) / DAY);
            predR = schedulers[0.9].forgetting_curve(tExact, side.stability);
          }
          // Sibling bookkeeping: both directions of a word on one day.
          if (isTwoWay(card) && counted) {
            const first = shownToday.get(card.row_id);
            if (first && first !== dir) m.sibSameDay++;
            if (!first) shownToday.set(card.row_id, dir);
          }
          const res = student.answer(card, dir, now);
          m.answers++; answersToday++;
          if (counted) {
            if (!wasNew && side.last_review) {
              const lr = new Date(side.last_review).getTime();
              const utcGap = Math.floor((Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - Date.UTC(new Date(lr).getUTCFullYear(), new Date(lr).getUTCMonth(), new Date(lr).getUTCDate())) / DAY);
              if (utcGap === 0) m.zeroDayCounted++;
              const localGap = Math.round((new Date(localISODate(new Date(now))).getTime() - new Date(localISODate(new Date(lr))).getTime()) / DAY);
              if (utcGap < localGap) m.gapShort = (m.gapShort || 0) + 1;
              if (utcGap > localGap) m.gapLong = (m.gapLong || 0) + 1;
              m.gapN = (m.gapN || 0) + 1;
            }
            const sr = applyVariant(card, res.got, now, dir, v);
            Object.assign(card, sr);
            m.counted++;
            if (wasNew) { m.newIntroduced++; newToday++; }
            if (item._bucket === "spot") { m.spot++; if (res.got) m.spotRight++; }
            else if (!wasNew) {
              m.dueReviews++; if (res.got) m.dueRight++;
              if (predR !== null) {
                m.predSum += predR;
                const pr = Math.min(0.9999, Math.max(0.0001, predR));
                m.ll += -(res.got ? Math.log(pr) : Math.log(1 - pr));
                const bin = predR < 0.7 ? "<0.70" : predR < 0.8 ? "0.70-0.80" : predR < 0.85 ? "0.80-0.85" : predR < 0.9 ? "0.85-0.90" : predR < 0.95 ? "0.90-0.95" : ">=0.95";
                const cb = m.calib.get(bin) || { n: 0, pred: 0, right: 0 };
                cb.n++; cb.pred += predR; cb.right += res.got ? 1 : 0;
                m.calib.set(bin, cb);
              }
            }
          }
          if (!res.got) {
            block = placeRetry(block, idx, { ...item, ...card, shownDir: dir, _rid: Math.random().toString(36).slice(2) }, RE_QUEUE_OFFSET);
          }
          now += 9000;
        }
        now += 60000;
      }
    }
    m.perDay.push(answersToday);
    // Due work left undone at the end of the day.
    const endDay = new Date(dayStart); endDay.setHours(23, 59, 59, 999);
    let left = 0;
    for (const c of deck) for (const d of directionsOf(c)) {
      const s = sideOf(c, d);
      if (s.fsrs_state !== 0 && s.next_due_at && new Date(s.next_due_at).getTime() <= endDay.getTime()) left++;
    }
    m.dueLeft.push(left);
    if (day === MID - 1 || day === DAYS - 1) {
      const t = endDay.getTime();
      let items = 0, words = 0, seenItems = 0;
      for (const c of deck) {
        const dirs = directionsOf(c);
        const ps = dirs.map((d) => student.truePr(c, d, t));
        items += ps.reduce((a, b) => a + b, 0);
        words += dirs.length === 2 ? ps[0] * ps[1] : ps[0];
        for (const d of dirs) if (sideOf(c, d).fsrs_state !== 0) seenItems++;
      }
      m.knownAt[day + 1] = { items, words, seenItems };
    }
  }
  return m;
}

const VARIANTS = {
  current: { localDays: false, retention: 0.9 },
  localDays: { localDays: true, retention: 0.9 },
  siblings: { localDays: true, retention: 0.9, siblings: true },
  newCap: { localDays: true, retention: 0.9, newCap: 25 },
  ret85: { localDays: true, retention: 0.85 },
  noSpot: { localDays: true, retention: 0.9, noSpot: true },
  all: { localDays: true, retention: 0.9, siblings: true, newCap: 25 },
  noFloor: { localDays: false, retention: 0.9, noFloor: true },
  bothFixes: { localDays: true, retention: 0.9, noFloor: true },
  bothNoSpot: { localDays: true, retention: 0.9, noFloor: true, noSpot: true },
};

const pick = process.argv[4] ? process.argv[4].split(",") : Object.keys(VARIANTS);
const out = {};
for (const name of pick) {
  const runs = [];
  for (let s = 1; s <= SEEDS; s++) runs.push(run(VARIANTS[name], 1000 + s));
  const avg = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  const studyDays = (r) => r.perDay.filter((x) => x > 0);
  const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const calib = {};
  for (const r of runs) for (const [k, v] of r.calib) {
    const c = (calib[k] ||= { n: 0, pred: 0, right: 0 });
    c.n += v.n; c.pred += v.pred; c.right += v.right;
  }
  out[name] = {
    answers: Math.round(avg((r) => r.answers)),
    answersPerStudyDay: +avg((r) => r.answers / studyDays(r).length).toFixed(1),
    p90AnswersPerStudyDay: Math.round(avg((r) => pct(studyDays(r), 0.9))),
    maxAnswersDay: Math.round(avg((r) => Math.max(...r.perDay))),
    newIntroduced: Math.round(avg((r) => r.newIntroduced)),
    dueRetention: +avg((r) => r.dueRight / r.dueReviews).toFixed(3),
    fsrsPredicted: +avg((r) => r.predSum / r.dueReviews).toFixed(3),
    logLoss: +avg((r) => r.ll / r.dueReviews).toFixed(4),
    spotChecks: Math.round(avg((r) => r.spot)),
    spotRight: +avg((r) => (r.spot ? r.spotRight / r.spot : 0)).toFixed(3),
    siblingSameDay: Math.round(avg((r) => r.sibSameDay)),
    zeroDayCounted: Math.round(avg((r) => r.zeroDayCounted)),
    gapShort: Math.round(avg((r) => r.gapShort || 0)),
    gapLong: Math.round(avg((r) => r.gapLong || 0)),
    reviewsWithGap: Math.round(avg((r) => r.gapN || 0)),
    avgDueLeftEndOfDay: +avg((r) => r.dueLeft.reduce((a, b) => a + b, 0) / r.dueLeft.length).toFixed(1),
    [`day${MID}`]: {
      itemsKnown: Math.round(avg((r) => r.knownAt[MID].items)),
      wordsKnownBothWays: Math.round(avg((r) => r.knownAt[MID].words)),
      itemsSeen: Math.round(avg((r) => r.knownAt[MID].seenItems)),
    },
    [`day${DAYS}`]: {
      itemsKnown: Math.round(avg((r) => r.knownAt[DAYS].items)),
      wordsKnownBothWays: Math.round(avg((r) => r.knownAt[DAYS].words)),
      itemsSeen: Math.round(avg((r) => r.knownAt[DAYS].seenItems)),
    },
    knownPer100Answers: +avg((r) => (100 * r.knownAt[DAYS].items) / r.answers).toFixed(2),
    calibration: Object.fromEntries(
      Object.entries(calib).sort().map(([k, c]) => [k, { n: c.n, predicted: +(c.pred / c.n).toFixed(3), actual: +(c.right / c.n).toFixed(3) }])
    ),
  };
  console.error(`done ${name}`);
}
console.log(JSON.stringify(out, null, 2));
