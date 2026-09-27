// Checks A–H and behaviour metrics 1–7 on the recorded run.
// Run with TZ=America/New_York (the app's local-day functions read the process zone).
import fs from "node:fs";
import path from "node:path";

if (process.env.TZ !== "America/New_York") throw new Error("run with TZ=America/New_York");
const WORK = process.env.WORK;
const DATA = path.join(WORK, "data");
const OUT = path.join(WORK, "analysis", "out");
fs.mkdirSync(OUT, { recursive: true });
const APP = path.join(WORK, "app");
const sr = await import(path.join(APP, "src/lib/spacedRepetition.js"));
const tsf = await import(path.join(APP, "node_modules/ts-fsrs/dist/index.mjs"));
const studyDay = await import(path.join(APP, "src/lib/studyDay.js"));
const progressLib = await import(path.join(APP, "src/lib/progress.js"));
const { Memory } = await import(path.join(WORK, "driver/model.mjs"));

const DAY = 864e5;
const readJsonl = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const answers = readJsonl(path.join(DATA, "driver-answers.jsonl"));
const events = readJsonl(path.join(DATA, "driver-events.jsonl"));
const dbLog = readJsonl(path.join(DATA, "db-requests.jsonl"));
const dump = JSON.parse(fs.readFileSync(path.join(DATA, "final-dump.json"), "utf8"));
const user = dump.users.find((u) => u.email === "nora.lindqvist@example.com");
const UID = user.id;
const cards = dump.tables.user_cards.filter((r) => r.user_id === UID);
const cardById = new Map(cards.map((c) => [c.id, c]));
// The dump holds the stand-in's internal float4 values; the app received PostgREST's printed
// form (shortest decimal that round-trips in float4), and computed with that. Use the printed form.
function float4Out(f) { if (f == null || !Number.isFinite(f)) return f; for (let p = 1; p <= 9; p++) { const s = Number(f.toPrecision(p)); if (Math.fround(s) === f) return s; } return f; }
const REAL_REV = ["stability_before", "difficulty_before", "stability_after", "difficulty_after"];
const reviews = dump.tables.card_reviews.filter((r) => r.user_id === UID).map((r) => { const o = { ...r }; for (const c of REAL_REV) o[c] = float4Out(o[c]); return o; });
for (const c of cards) for (const col of ["stability", "difficulty", "en_stability", "en_difficulty"]) c[col] = float4Out(c[col]);
const ms = (x) => (x == null ? null : new Date(x).getTime());
const localDate = (t) => studyDay.localISODate(new Date(t));
const eod = (t) => studyDay.endOfLocalDay(new Date(t));
const f4 = (x) => (x == null ? null : Math.fround(x));
const eqF4 = (a, b) => (a == null && b == null) || (a != null && b != null && Math.fround(a) === Math.fround(b));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const fmt = (x, d = 3) => (x == null || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const isTwoWay = (c) => c.category === "V" || c.category === "E";
const itemKey = (id, dir) => `${id}:${dir}`;
const report = [];
const say = (...a) => { const s = a.join(" "); report.push(s); console.log(s); };
const results = {}; // machine-readable

// Real (non-correction) answers, and the review rows they wrote
const realAnswers = answers.filter((a) => !a.isCorrection);
const corrections = answers.filter((a) => a.isCorrection);
const reviewById = new Map(reviews.map((r) => [r.id, r]));
function timeline(k) {
  const [id, dir] = k.split(":");
  return answers.filter((a) => String(a.cardId) === id && a.dir === dir).map((a) => {
    const r = a.review && reviewById.get(a.review.id);
    return `${a.simLocal || a.review?.answered_at} ${a.sitting}/b${a.block} ${a.queueEntry?.bucket || "?"}${a.retryMarker ? "+retry" : ""} ${a.pressed}${r ? (r.counted ? " counted" : " not-counted") : ""}${r?.counted ? ` S ${r.stability_before ?? "new"}→${r.stability_after} due ${String(r.due_after).slice(0, 16)}` : ""}`;
  });
}
const kindOfCard = new Map(); for (const a of answers) if (a.cardId != null && a.kind) kindOfCard.set(a.cardId, a.kind);
const kindOf = (id) => kindOfCard.get(id) || (cardById.get(id) && !isTwoWay(cardById.get(id)) ? "oneway" : "vocab");

// Sittings and blocks from the event log
const sittingStarts = events.filter((e) => e.type === "sitting-start");
const blockStarts = events.filter((e) => e.type === "block-start");
const checkpoints = events.filter((e) => e.type === "checkpoint");
const sittingOfBlock = new Map(blockStarts.map((b) => [b.block, b.sitting]));

// ── Write log: user_cards PATCHes from the app, matched to counted reviews ─
const patches = dbLog.filter((e) => e.method === "PATCH" && e.path === "/rest/v1/user_cards" && e.role === "user");
const reviewPosts = dbLog.filter((e) => e.method === "POST" && e.path === "/rest/v1/card_reviews");
function patchFor(rev) {
  const id = rev.card_id;
  const col = rev.direction === "en" ? "en_last_review" : "last_review";
  const t = ms(rev.answered_at);
  return patches.filter((p) => p.query?.id === `eq.${id}` && p.body && p.body[col] != null && ms(p.body[col]) === t);
}

// ═════ A. Recompute every counted review with ts-fsrs ═════════════════════
const byItem = new Map();
for (const r of reviews) {
  const k = itemKey(r.card_id, r.direction);
  if (!byItem.has(k)) byItem.set(k, []);
  byItem.get(k).push(r);
}
for (const list of byItem.values()) list.sort((a, b) => ms(a.answered_at) - ms(b.answered_at));
const counted = reviews.filter((r) => r.counted).sort((a, b) => ms(a.answered_at) - ms(b.answered_at));

function fuzzRangeGood(card, now, rating) {
  // Every interval the app could have produced for this answer, over all fuzz draws.
  const rec = sr.scheduler.repeat(card, now);
  const S = [0, rec[1].card.stability, rec[2].card.stability, rec[3].card.stability, rec[4].card.stability];
  const elapsed = card.state === sr.State.New ? 0 : tsf.dateDiffInDays(card.last_review, now);
  const maxI = sr.scheduler.parameters.maximum_interval;
  const base = (s) => Math.min(Math.max(1, Math.round(s * sr.scheduler.interval_modifier)), maxI);
  const fz = (ivl, f) => { if (ivl < 2.5) return Math.round(ivl); const { min_ivl, max_ivl } = tsf.get_fuzz_range(ivl, elapsed, maxI); return Math.floor(f * (max_ivl - min_ivl + 1) + min_ivl); };
  const set = new Set();
  for (let k = 0; k < 4000; k++) {
    const f = k / 4000;
    let again = fz(base(S[1]), f), hard = fz(base(S[2]), f), good = fz(base(S[3]), f);
    again = Math.min(again, hard); hard = Math.max(hard, again + 1); good = Math.max(good, hard + 1);
    set.add(rating === 1 ? again : good);
  }
  return [...set].sort((a, b) => a - b);
}

const A = { total: counted.length, stabOk: 0, diffOk: 0, dueExact: 0, dueExactViaChain: 0, dueInRange: 0, dueOut: 0, fails: [], seedExamples: [], elapsed: [] };
const recomputed = new Map(); // review id -> { card (full precision) }
for (const [k, list] of byItem) {
  let reps = 0, lapses = 0, prevFull = null, prevDue = null;
  for (const r of list) {
    if (!r.counted) continue;
    const t = new Date(r.answered_at);
    // Before-state exactly as the app recorded it (float4 in the table), plus reps/lapses from the chain.
    const pRows = patchFor(r);
    const before = {
      fsrs_state: r.state_before, stability: r.stability_before, difficulty: r.difficulty_before,
      reps, lapses, last_review: r.last_review_before, next_due_at: prevDue,
    };
    const card = sr.toFsrsCard(before);
    const next = sr.scheduler.next(card, t, r.rating).card;
    const stabOk = eqF4(next.stability, r.stability_after);
    const diffOk = eqF4(next.difficulty, r.difficulty_after);
    let dueExact = ms(next.due) === ms(r.due_after);
    let viaChain = false;
    let nextChain = null;
    if (!dueExact && prevFull) {
      // The app may have used the full-precision state it computed in the same page session.
      const c2 = { ...card, stability: prevFull.stability, difficulty: prevFull.difficulty };
      nextChain = sr.scheduler.next(c2, t, r.rating).card;
      if (ms(nextChain.due) === ms(r.due_after)) { dueExact = true; viaChain = true; }
    }
    const ivlDays = Math.round((ms(r.due_after) - t.getTime()) / DAY);
    const range = fuzzRangeGood(card, t, r.rating);
    const inRange = range.includes(ivlDays);
    if (stabOk) A.stabOk++;
    if (diffOk) A.diffOk++;
    if (dueExact && !viaChain) A.dueExact++;
    if (viaChain) A.dueExactViaChain++;
    if (!dueExact && inRange) A.dueInRange++;
    if (!dueExact && !inRange) A.dueOut++;
    // The PATCH that saved it must agree with the review row.
    const pb = pRows[0]?.body;
    const pre = r.direction === "en" ? "en_" : "";
    const patchAgrees = pb ? eqF4(pb[`${pre}stability`], r.stability_after) && ms(pb[`${pre}next_due_at`]) === ms(r.due_after) : null;
    if (!stabOk || !diffOk || (!dueExact && !inRange) || patchAgrees === false) {
      A.fails.push({ id: r.id, item: k, at: r.answered_at, rating: r.rating, before, recorded: { S: r.stability_after, D: r.difficulty_after, due: r.due_after }, recomputed: { S: next.stability, D: next.difficulty, due: next.due.toISOString() }, ivlDays, range: [range[0], range.at(-1)], patchAgrees });
    }
    if (A.seedExamples.length < 3 && dueExact && r.state_before === 2) A.seedExamples.push({ item: k, at: r.answered_at, seed: `${t.getTime()}_${reps + 1}_${r.difficulty_before * r.stability_before}`, due: r.due_after });
    // Elapsed time: what ts-fsrs used vs the clock and the calendar.
    if (r.state_before === 2 && r.last_review_before) {
      const lr = new Date(r.last_review_before);
      A.elapsed.push({
        item: k, from: r.last_review_before, to: r.answered_at,
        exactDays: (t - lr) / DAY, utcDays: tsf.dateDiffInDays(lr, t),
        localDays: Math.round((ms(`${localDate(t)}T12:00:00Z`) - ms(`${localDate(lr)}T12:00:00Z`)) / DAY),
        fromLocal: new Date(lr).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }),
        toLocal: t.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }),
        rating: r.rating, S_before: r.stability_before,
        R_used: tsf.forgetting_curve(sr.scheduler.parameters.w, tsf.dateDiffInDays(lr, t), r.stability_before),
        R_exact: Math.pow(1 + (Math.pow(0.9, 1 / -sr.scheduler.parameters.w[20]) - 1) * ((t - lr) / DAY) / r.stability_before, -sr.scheduler.parameters.w[20]),
        S_after: r.stability_after,
      });
    }
    // Advance the chain
    reps += 1;
    lapses = next.lapses;
    prevFull = nextChain || next;
    prevDue = r.due_after;
    recomputed.set(r.id, { S: next.stability, D: next.difficulty, due: next.due.toISOString(), lapses: next.lapses, reps: next.reps });
    if (pb && (pb[`${pre}reps`] !== next.reps || pb[`${pre}lapses`] !== next.lapses)) {
      A.fails.push({ id: r.id, item: k, kind: "reps/lapses", patch: { reps: pb[`${pre}reps`], lapses: pb[`${pre}lapses`] }, chain: { reps: next.reps, lapses: next.lapses } });
    }
  }
}
results.A = { ...A, elapsed: undefined };
say("\n══ A. Recompute counted reviews with ts-fsrs (retention 0.9, max 3650, fuzz on, short-term off) ══");
say(`counted reviews: ${A.total}; stability match (float4): ${A.stabOk}; difficulty match: ${A.diffOk}`);
say(`due exact (seed reproduced from recorded before-state): ${A.dueExact}; exact only via in-memory full-precision chain: ${A.dueExactViaChain}; not exact but inside fuzz range: ${A.dueInRange}; OUTSIDE range: ${A.dueOut}`);
say(`failures: ${A.fails.length}`);
for (const f of A.fails.slice(0, 3)) say("  e.g.", JSON.stringify(f));
say(`fuzz seed = "<answered_at ms>_<reps after>_<D×S before>", e.g. ${JSON.stringify(A.seedExamples[0])}`);
// Elapsed-time semantics
const el = A.elapsed;
const elUtcNeLocal = el.filter((e) => e.utcDays !== e.localDays);
const eveningToMorning = el.filter((e) => e.localDays === 1 && e.exactDays < 1);
const zeroUtc = el.filter((e) => e.utcDays === 0);
say(`elapsed days used by ts-fsrs = whole UTC calendar days (dateDiffInDays). Of ${el.length} reviews of seen items: UTC≠local-date in ${elUtcNeLocal.length}; counted with 0 UTC days elapsed: ${zeroUtc.length}.`);
const cases = [...zeroUtc.slice(0, 2), ...elUtcNeLocal.filter((e) => e.utcDays > e.localDays).slice(0, 1), ...eveningToMorning.filter((e) => e.utcDays === 1).slice(0, 1)];
for (const c of cases) say(`  ${c.item}: ${c.fromLocal} → ${c.toLocal} (exact ${fmt(c.exactDays, 2)} d, local ${c.localDays} d, UTC ${c.utcDays} d used) R used ${fmt(c.R_used)} vs R at exact time ${fmt(c.R_exact)}; rating ${c.rating}; S ${fmt(c.S_before, 2)}→${fmt(c.S_after, 2)}`);
results.elapsedSummary = { n: el.length, utcNeLocal: elUtcNeLocal.length, zeroUtc: zeroUtc.length, eveningToMorning: eveningToMorning.length, eveningToMorningAsZero: eveningToMorning.filter((e) => e.utcDays === 0).length, eveningToMorningAsOne: eveningToMorning.filter((e) => e.utcDays === 1).length };
say(`evening→next-morning reviews (local +1 day, <24 h): ${eveningToMorning.length}; treated as 0 days: ${results.elapsedSummary.eveningToMorningAsZero}, as 1 day: ${results.elapsedSummary.eveningToMorningAsOne}`);
fs.writeFileSync(path.join(OUT, "A-elapsed.json"), JSON.stringify(el, null, 1));
fs.writeFileSync(path.join(OUT, "A-failures.json"), JSON.stringify(A.fails, null, 1));

// ═════ B. Chain ══════════════════════════════════════════════════════════
const B = { pairs: 0, breaks: [], finalChecked: 0, finalMismatch: [], countedWithoutPatch: [], patchFailed: [] };
for (const [k, list] of byItem) {
  const c = list.filter((r) => r.counted);
  for (let i = 0; i < c.length; i++) {
    const r = c[i];
    if (i === 0) {
      if (r.state_before !== 0 || r.stability_before != null) B.breaks.push({ item: k, at: r.answered_at, why: "first counted review does not start from New", r });
      continue;
    }
    const p = c[i - 1];
    B.pairs++;
    const ok = r.state_before === 2 && eqF4(r.stability_before, p.stability_after) && eqF4(r.difficulty_before, p.difficulty_after) && ms(r.last_review_before) === ms(p.answered_at);
    if (!ok) B.breaks.push({ item: k, prev: { at: p.answered_at, S: p.stability_after, D: p.difficulty_after }, next: { at: r.answered_at, state_before: r.state_before, S: r.stability_before, D: r.difficulty_before, last: r.last_review_before } });
  }
  if (!c.length) continue;
  const [id, dir] = k.split(":");
  const row = cardById.get(Number(id));
  const pre = dir === "en" ? "en_" : "";
  const last = c.at(-1);
  B.finalChecked++;
  const rc = recomputed.get(last.id);
  const ok = eqF4(row[`${pre}stability`], last.stability_after) && eqF4(row[`${pre}difficulty`], last.difficulty_after) && ms(row[`${pre}next_due_at`]) === ms(last.due_after) && ms(row[`${pre}last_review`]) === ms(last.answered_at) && row[`${pre}reps`] === c.length && row[`${pre}fsrs_state`] === 2 && row[`${pre}last_answer_correct`] === last.correct && (!rc || row[`${pre}lapses`] === rc.lapses);
  if (!ok) B.finalMismatch.push({ item: k, row: { S: row[`${pre}stability`], D: row[`${pre}difficulty`], due: row[`${pre}next_due_at`], last: row[`${pre}last_review`], reps: row[`${pre}reps`], lapses: row[`${pre}lapses`], lac: row[`${pre}last_answer_correct`] }, lastReview: { S: last.stability_after, D: last.difficulty_after, due: last.due_after, at: last.answered_at, correct: last.correct }, countedReviews: c.length, chainLapses: rc?.lapses });
}
// Items whose row moved without a counted review, or never-counted rows that changed
for (const row of cards) {
  for (const dir of isTwoWay(row) ? ["fr", "en"] : ["fr"]) {
    const pre = dir === "en" ? "en_" : "";
    const c = (byItem.get(itemKey(row.id, dir)) || []).filter((r) => r.counted);
    if (!c.length && row[`${pre}fsrs_state`] !== 0) B.finalMismatch.push({ item: itemKey(row.id, dir), why: "row has FSRS state but no counted review" });
  }
}
for (const r of counted) {
  const p = patchFor(r);
  if (!p.length) B.countedWithoutPatch.push({ id: r.id, item: itemKey(r.card_id, r.direction), at: r.answered_at });
  else if (!p.some((x) => x.status < 300)) B.patchFailed.push({ id: r.id, statuses: p.map((x) => x.status) });
}
results.B = { pairs: B.pairs, breaks: B.breaks.length, finalChecked: B.finalChecked, finalMismatch: B.finalMismatch.length, countedWithoutPatch: B.countedWithoutPatch.length, patchFailed: B.patchFailed.length };
say("\n══ B. Chain (before-state = previous after-state; row = last counted review) ══");
say(`consecutive counted pairs: ${B.pairs}; breaks: ${B.breaks.length}; items checked against final row: ${B.finalChecked}; final mismatches: ${B.finalMismatch.length}; counted reviews with no matching user_cards write: ${B.countedWithoutPatch.length}; writes that failed: ${B.patchFailed.length}`);
for (const b of [...B.breaks.slice(0, 2), ...B.finalMismatch.slice(0, 2), ...B.countedWithoutPatch.slice(0, 1)]) say("  e.g.", JSON.stringify(b));
fs.writeFileSync(path.join(OUT, "B-chain.json"), JSON.stringify(B, null, 1));

// ═════ C. One counted review per item per local day ═══════════════════════
const C = { dup: [], retriesCounted: [], sameDayRepeats: 0, sameDayRepeatsCounted: [], spot: { n: 0, counted: 0 } };
const perItemDay = new Map();
for (const r of counted) {
  const k = `${itemKey(r.card_id, r.direction)}@${localDate(ms(r.answered_at))}`;
  perItemDay.set(k, (perItemDay.get(k) || 0) + 1);
}
for (const [k, n] of perItemDay) if (n > 1) C.dup.push({ k, n });
// Answers joined to their rows
const ansRow = realAnswers.map((a) => ({ a, r: a.review ? reviewById.get(a.review.id) : null }));
const seenOnDay = new Map();
for (const { a, r } of ansRow) {
  if (!r) continue;
  if ((a.retryMarker || a.queueEntry?.retry) && r.counted) C.retriesCounted.push({ n: a.n, item: itemKey(a.cardId, a.dir), at: r.answered_at });
  const k = `${itemKey(a.cardId, a.dir)}@${localDate(ms(r.answered_at))}`;
  if (seenOnDay.has(k) && !(a.retryMarker || a.queueEntry?.retry)) {
    C.sameDayRepeats++;
    if (r.counted) C.sameDayRepeatsCounted.push({ n: a.n, k, earlier: realAnswers.filter((x) => x.n < a.n && itemKey(x.cardId, x.dir) === itemKey(a.cardId, a.dir) && x.review && localDate(ms(x.review.answered_at)) === k.split("@")[1]).map((x) => ({ n: x.n, retry: x.retryMarker, counted: x.review.counted, at: x.simLocal })) });
  }
  seenOnDay.set(k, true);
  if (a.queueEntry?.bucket === "spot" && !a.retryMarker) { C.spot.n++; if (r.counted) C.spot.counted++; }
}
results.C = { dupCounted: C.dup.length, retriesCounted: C.retriesCounted.length, sameDayNonRetryRepeats: C.sameDayRepeats, sameDayRepeatsCounted: C.sameDayRepeatsCounted.length, spot: C.spot };
say("\n══ C. At most one counted review per item per local day ══");
say(`item-days with >1 counted review: ${C.dup.length}; retries recorded as counted: ${C.retriesCounted.length}; same-day non-retry repeats (e.g. re-dealt): ${C.sameDayRepeats}, of which counted: ${C.sameDayRepeatsCounted.length}; spot-check answers: ${C.spot.n} (counted: ${C.spot.counted})`);
for (const d of C.sameDayRepeatsCounted.slice(0, 4)) say("  counted repeat:", JSON.stringify(d));
for (const d of C.dup.slice(0, 3)) say("  e.g.", JSON.stringify(d), JSON.stringify((byItem.get(d.k.split("@")[0]) || []).filter((r) => r.counted).map((r) => [r.answered_at, r.rating])));

// ═════ D. Direction integrity ═════════════════════════════════════════════
const D = { patches: patches.length, mixed: [], wrongDir: [], otherCols: [] };
for (const p of patches) {
  const keys = Object.keys(p.body || {});
  const en = keys.filter((k) => k.startsWith("en_"));
  const fr = keys.filter((k) => !k.startsWith("en_"));
  const sched = new Set(["stability", "difficulty", "fsrs_state", "reps", "lapses", "next_due_at", "last_review", "last_answer_correct"]);
  if (en.length && fr.length) D.mixed.push({ seq: p.seq, keys });
  if (fr.some((k) => !sched.has(k)) || en.some((k) => !sched.has(k.slice(3)))) D.otherCols.push({ seq: p.seq, keys });
}
// Each counted review's write touched only its own direction
for (const r of counted) {
  for (const p of patchFor(r)) {
    const keys = Object.keys(p.body);
    const wrong = r.direction === "en" ? keys.some((k) => !k.startsWith("en_")) : keys.some((k) => k.startsWith("en_"));
    if (wrong) D.wrongDir.push({ review: r.id, dir: r.direction, keys });
  }
}
results.D = { patches: D.patches, mixed: D.mixed.length, wrongDir: D.wrongDir.length, otherCols: D.otherCols.length };
say("\n══ D. Direction integrity ══");
say(`user_cards writes by the app: ${D.patches}; writes touching both directions: ${D.mixed.length}; writes touching the other direction than the one answered: ${D.wrongDir.length}; writes with non-schedule columns: ${D.otherCols.length}`);

// ═════ E. Serving ═════════════════════════════════════════════════════════
const snapDir = path.join(DATA, "snapshots");
const E = { blocks: 0, dealt: 0, byClass: {}, violations: [], newWhileDueLeft: [], lapsesNotFirst: [], notMostOverdue: [], bothNewSameBlock: [], secondDirSameDay: [], bucketMismatch: [], staleFirstBlocks: [], shownNotDealt: [] };
const sideOf = (row, dir) => { const pre = dir === "en" ? "en_" : ""; return { state: row[`${pre}fsrs_state`], due: row[`${pre}next_due_at`], S: row[`${pre}stability`], last: row[`${pre}last_review`], lac: row[`${pre}last_answer_correct`] }; };
const blockInfo = [];
for (const bs of blockStarts) {
  const label = `block-${String(bs.block).padStart(3, "0")}`;
  const fDb = path.join(snapDir, `${label}.json`), fApp = path.join(snapDir, `${label}-app.json`);
  if (!fs.existsSync(fDb) || !fs.existsSync(fApp)) continue;
  const db = JSON.parse(fs.readFileSync(fDb)); const app = JSON.parse(fs.readFileSync(fApp));
  const rows = db.user_cards.filter((r) => r.user_id === UID);
  const by = new Map(rows.map((r) => [r.id, r]));
  const at = app.at; const end = eod(at); const today = localDate(at);
  // The truth at deal time
  const dueItems = [], newItems = [];
  for (const r of rows) for (const dir of isTwoWay(r) ? ["fr", "en"] : ["fr"]) {
    const s = sideOf(r, dir);
    if (s.state === 0) newItems.push(itemKey(r.id, dir));
    else if (ms(s.due) <= end) dueItems.push({ k: itemKey(r.id, dir), due: ms(s.due), lapse: s.lac === false });
  }
  const dealt = app.queue.filter((q) => !q.retry);
  const dealtSet = new Set(dealt.map((q) => itemKey(q.row_id, q.dir)));
  const cls = {};
  const firstOfSitting = bs.blockNo === 1;
  let stale = 0;
  for (const q of dealt) {
    const r = by.get(q.row_id); const s = sideOf(r, q.dir);
    let c;
    if (s.state === 0) c = "new";
    else if (ms(s.due) <= end) c = s.lac === false ? "due-lapse" : "due";
    else if (s.S >= 60 && localDate(ms(s.last)) !== today) c = "spot";
    else c = "NOT-DUE";
    cls[c] = (cls[c] || 0) + 1;
    E.byClass[c] = (E.byClass[c] || 0) + 1;
    const expect = { new: ["new"], lapse: ["due-lapse"], review: ["due"], spot: ["spot"] }[q.bucket] || [];
    if (!expect.includes(c)) { E.bucketMismatch.push({ block: bs.block, item: itemKey(q.row_id, q.dir), bucket: q.bucket, truth: c, lastReview: s.last, due: s.due }); stale++; }
    if (c === "NOT-DUE") E.violations.push({ block: bs.block, sitting: bs.sitting, item: itemKey(q.row_id, q.dir), bucket: q.bucket, due: s.due, last: s.last });
  }
  E.dealt += dealt.length; E.blocks++;
  if (firstOfSitting && stale) E.staleFirstBlocks.push({ block: bs.block, sitting: bs.sitting, mismatched: stale, of: dealt.length });
  // New items only when no due item was left out
  const dealtNewTrue = dealt.filter((q) => sideOf(by.get(q.row_id), q.dir).state === 0).length;
  const dueLeft = dueItems.filter((d) => !dealtSet.has(d.k));
  if (dealtNewTrue > 0 && dueLeft.length > 0) E.newWhileDueLeft.push({ block: bs.block, sitting: bs.sitting, newDealt: dealtNewTrue, dueLeftOut: dueLeft.length, dueTotal: dueItems.length });
  // Missed-last-time first
  const lapsesLeft = dueLeft.filter((d) => d.lapse);
  const nonLapseDealt = dealt.filter((q) => { const s = sideOf(by.get(q.row_id), q.dir); return !(s.state !== 0 && ms(s.due) <= end && s.lac === false); }).length;
  if (lapsesLeft.length && nonLapseDealt) E.lapsesNotFirst.push({ block: bs.block, sitting: bs.sitting, lapsesLeftOut: lapsesLeft.length, nonLapseDealt });
  // Most overdue first
  const dueRevDealt = dealt.map((q) => ({ q, s: sideOf(by.get(q.row_id), q.dir) })).filter(({ s }) => s.state !== 0 && ms(s.due) <= end && s.lac !== false);
  const revLeft = dueLeft.filter((d) => !d.lapse);
  if (revLeft.length && dueRevDealt.length) {
    const latestDealt = Math.max(...dueRevDealt.map(({ s }) => ms(s.due)));
    const earliestLeft = Math.min(...revLeft.map((d) => d.due));
    if (latestDealt > earliestLeft) E.notMostOverdue.push({ block: bs.block, sitting: bs.sitting, latestDealtDue: new Date(latestDealt).toISOString(), earliestLeftDue: new Date(earliestLeft).toISOString() });
  }
  // A word's two new items in one block
  const newCards = new Map();
  for (const q of dealt) if (sideOf(by.get(q.row_id), q.dir).state === 0) newCards.set(q.row_id, (newCards.get(q.row_id) || 0) + 1);
  for (const [id, n] of newCards) if (n > 1) E.bothNewSameBlock.push({ block: bs.block, card: id });
  blockInfo.push({ block: bs.block, sitting: bs.sitting, blockNo: bs.blockNo, at, today, dealt: dealt.length, cls, dueAtDeal: dueItems.length, dueLapses: dueItems.filter((d) => d.lapse).length, newAvail: newItems.length, dueLeftOut: dueLeft.length, stale });
}
// Answers must be dealt items or retries of this block's misses
{
  const dealtByBlock = new Map();
  for (const bs of blockStarts) {
    const fApp = path.join(snapDir, `block-${String(bs.block).padStart(3, "0")}-app.json`);
    if (fs.existsSync(fApp)) dealtByBlock.set(bs.block, new Set(JSON.parse(fs.readFileSync(fApp)).queue.map((q) => itemKey(q.row_id, q.dir))));
  }
  // The direction switch re-deals the rest of its block: those items are the block's too.
  const sw = events.find((x) => x.type === "direction-switch");
  if (sw) {
    const b = answers.find((a) => a.counter === sw.counterAfter)?.block;
    const set = dealtByBlock.get(b);
    const after = answers.filter((a) => a.block === b && !a.retryMarker && !a.isCorrection && a.idx >= sw.atIdx && set && !set.has(itemKey(a.cardId, a.dir)));
    E.redealFromAnswers = { block: b, items: after.map((a) => itemKey(a.cardId, a.dir)), dirsAfterSwitch: [...new Set(answers.filter((a) => a.block === b && a.idx >= sw.atIdx).map((a) => a.dir))] };
    const f = path.join(snapDir, `block-${String(b).padStart(3, "0")}.json`);
    const rowsB = new Map(JSON.parse(fs.readFileSync(f)).user_cards.map((r) => [r.id, r]));
    const at0 = blockInfo.find((x) => x.block === b)?.at;
    E.redealFromAnswers.truth = after.map((a) => { const s2 = sideOf(rowsB.get(a.cardId), a.dir); return s2.state === 0 ? "new" : ms(s2.due) <= eod(at0) ? "due" : "NOT-DUE"; });
    for (const k of E.redealFromAnswers.items) set.add(k);
  }
  const missedInBlock = new Map();
  for (const a of answers) {
    if (a.isCorrection) { if (a.pressed === "wrong") { const m2 = missedInBlock.get(a.block) || new Set(); m2.add(itemKey(a.cardId, a.dir)); missedInBlock.set(a.block, m2); } continue; }
    const k = itemKey(a.cardId, a.dir);
    const set = dealtByBlock.get(a.block);
    const miss = missedInBlock.get(a.block) || new Set();
    if (a.retryMarker) { if (!miss.has(k)) E.shownNotDealt.push({ n: a.n, block: a.block, item: k, why: "retry of an item not missed earlier in the block" }); }
    else if (set && !set.has(k)) E.shownNotDealt.push({ n: a.n, block: a.block, item: k, why: "not in the dealt block" });
    if (a.pressed === "wrong") miss.add(k);
    missedInBlock.set(a.block, miss);
  }
}
// Second direction's first meeting on a later day
{
  const firstDay = new Map();
  for (const r of [...reviews].sort((a, b) => ms(a.answered_at) - ms(b.answered_at))) {
    const k = itemKey(r.card_id, r.direction);
    if (!firstDay.has(k)) firstDay.set(k, { day: localDate(ms(r.answered_at)), at: r.answered_at });
  }
  for (const c of cards) if (isTwoWay(c)) {
    const a = firstDay.get(itemKey(c.id, "fr")), b = firstDay.get(itemKey(c.id, "en"));
    if (a && b && a.day === b.day) E.secondDirSameDay.push({ card: c.id, front: c.front, fr: a.at, en: b.at });
  }
}
const firstBlockIds = new Set(blockStarts.filter((b) => b.blockNo === 1).map((b) => b.block));
const split = (L) => ({ firstOfSitting: L.filter((x) => firstBlockIds.has(x.block)).length, continuation: L.filter((x) => !firstBlockIds.has(x.block)).length });
E.split = { notDue: split(E.violations), bucketMismatch: split(E.bucketMismatch), newWhileDueLeft: split(E.newWhileDueLeft), lapsesNotFirst: split(E.lapsesNotFirst), notMostOverdue: split(E.notMostOverdue) };
const firstDealt = blockInfo.filter((b) => firstBlockIds.has(b.block)).reduce((s, b) => s + b.dealt, 0);
const contDealt = blockInfo.filter((b) => !firstBlockIds.has(b.block)).reduce((s, b) => s + b.dealt, 0);
E.split.dealt = { firstOfSitting: firstDealt, continuation: contDealt };
results.E = { split: E.split, blocks: E.blocks, dealt: E.dealt, byClass: E.byClass, notDueDealt: E.violations.length, bucketMismatch: E.bucketMismatch.length, staleFirstBlocks: E.staleFirstBlocks.length, newWhileDueLeft: E.newWhileDueLeft.length, lapsesNotFirst: E.lapsesNotFirst.length, notMostOverdue: E.notMostOverdue.length, bothNewSameBlock: E.bothNewSameBlock.length, secondDirSameDay: E.secondDirSameDay.length, shownNotDealt: E.shownNotDealt.length };
say("\n══ E. Serving (every dealt item vs the database at deal time) ══");
say(`blocks: ${E.blocks}; dealt items: ${E.dealt}; truth at deal time: ${JSON.stringify(E.byClass)}`);
say(`dealt but neither due, new nor spot-eligible: ${E.violations.length}; bucket ≠ truth: ${E.bucketMismatch.length}; first-of-sitting blocks with stale buckets: ${E.staleFirstBlocks.length}/${blockStarts.filter((b) => b.blockNo === 1).length}`);
say(`blocks dealing new items while due items were left out: ${E.newWhileDueLeft.length}; blocks where missed-last-time items were left out while others were dealt: ${E.lapsesNotFirst.length}; not most-overdue-first: ${E.notMostOverdue.length}`);
say(`split by block type (first block of a sitting = dealt at app open / later blocks = dealt at Continue): ${JSON.stringify(E.split)}`);
say(`both new items of one word in one block: ${E.bothNewSameBlock.length}; words whose two directions were first met the same day: ${E.secondDirSameDay.length}; answers not traceable to the dealt block or a retry: ${E.shownNotDealt.length}`);
for (const v of [...E.violations.slice(0, 2), ...E.staleFirstBlocks.slice(0, 2), ...E.newWhileDueLeft.slice(0, 2), ...E.secondDirSameDay.slice(0, 2)]) say("  e.g.", JSON.stringify(v));
if (E.redealFromAnswers) say(`direction switch (FR→EN at card 21, block ${E.redealFromAnswers.block}): directions answered after the switch ${JSON.stringify(E.redealFromAnswers.dirsAfterSwitch)}; items brought in by the re-deal ${JSON.stringify(E.redealFromAnswers.items)} — truth ${JSON.stringify(E.redealFromAnswers.truth)}`);
for (const v of E.bucketMismatch.filter((x) => x.truth === "NOT-DUE").slice(0, 2)) { say(`  timeline of ${v.item} (dealt as "${v.bucket}" in block ${v.block}, truth ${v.truth}):`); for (const l of timeline(v.item)) say("     " + l); }
for (const v of E.bucketMismatch.filter((x) => x.bucket === "new" && x.truth !== "new").slice(0, 1)) { say(`  timeline of ${v.item} (dealt as "new" in block ${v.block}, truth ${v.truth}):`); for (const l of timeline(v.item)) say("     " + l); }
// Mechanism: is each first block consistent with the state at the PREVIOUS app open (the deck
// the app last fetched, which is what localStorage holds)? The deal time's own day is used.
{
  const firsts = blockStarts.filter((b) => b.blockNo === 1).sort((a, b) => a.block - b.block);
  const mech = [];
  for (let i = 1; i < firsts.length; i++) {
    const cur = firsts[i];
    // The previous open's fetch: S01's last full fetch came after the upload; later opens fetch at load.
    const prevSnapFile = i === 1 ? null : path.join(snapDir, `block-${String(firsts[i - 1].block).padStart(3, "0")}.json`);
    const app = JSON.parse(fs.readFileSync(path.join(snapDir, `block-${String(cur.block).padStart(3, "0")}-app.json`)));
    const nowDb = new Map(JSON.parse(fs.readFileSync(path.join(snapDir, `block-${String(cur.block).padStart(3, "0")}.json`))).user_cards.map((r) => [r.id, r]));
    // For S02 the cached deck is the post-upload deck: every card new.
    const prevRows = prevSnapFile ? new Map(JSON.parse(fs.readFileSync(prevSnapFile)).user_cards.map((r) => [r.id, r])) : null;
    const end = eod(app.at);
    const consistent = (rowMap, q) => {
      if (!rowMap) return q.bucket === "new";
      const s2 = sideOf(rowMap.get(q.row_id), q.dir);
      if (q.bucket === "new") return s2.state === 0;
      if (q.bucket === "lapse") return s2.state !== 0 && ms(s2.due) <= end && s2.lac === false;
      if (q.bucket === "review") return s2.state !== 0 && ms(s2.due) <= end && s2.lac !== false;
      return true;
    };
    const dealt = app.queue.filter((q) => !q.retry);
    mech.push({ block: cur.block, sitting: cur.sitting, consistentWithPrevOpen: dealt.filter((q) => consistent(prevRows, q)).length, consistentWithDbNow: dealt.filter((q) => consistent(nowDb, q)).length, of: dealt.length });
  }
  E.mechanism = mech;
  const tot = mech.reduce((a, m) => ({ prev: a.prev + m.consistentWithPrevOpen, now: a.now + m.consistentWithDbNow, of: a.of + m.of }), { prev: 0, now: 0, of: 0 });
  say(`mechanism: first blocks' buckets consistent with the deck as of the PREVIOUS app open: ${tot.prev}/${tot.of}; consistent with the database at deal time: ${tot.now}/${tot.of}`);
  say(`  per block (prev-open/now/of): ${mech.map((m) => `${m.sitting}:${m.consistentWithPrevOpen}/${m.consistentWithDbNow}/${m.of}`).join(" ")}`);
  results.E.mechanism = tot;
}
const bucketTally = {}; for (const v of E.bucketMismatch) { const k = `${v.bucket}->${v.truth}`; bucketTally[k] = (bucketTally[k] || 0) + 1; }
say(`bucket≠truth by kind: ${JSON.stringify(bucketTally)}; in first-of-sitting blocks: ${E.bucketMismatch.filter((v) => blockStarts.find((b) => b.block === v.block)?.blockNo === 1).length}`);
results.E.bucketTally = bucketTally;
fs.writeFileSync(path.join(OUT, "E-serving.json"), JSON.stringify({ ...E, blockInfo }, null, 1));

// ═════ F. Coverage ════════════════════════════════════════════════════════
const F = { caughtUpEvents: events.filter((e) => e.type === "caught-up"), perSitting: [] };
const answersBySitting = new Map();
for (const a of realAnswers) { if (!answersBySitting.has(a.sitting)) answersBySitting.set(a.sitting, []); answersBySitting.get(a.sitting).push(a); }
for (const s of sittingStarts.filter((s, i, arr) => arr.findLastIndex((x) => x.id === s.id) === i)) {
  const first = blockInfo.find((b) => b.sitting === s.id && b.blockNo === 1);
  if (!first) continue;
  const db = JSON.parse(fs.readFileSync(path.join(snapDir, `block-${String(first.block).padStart(3, "0")}.json`)));
  const rows = db.user_cards.filter((r) => r.user_id === UID);
  const end = eod(first.at);
  const dueStart = [];
  for (const r of rows) for (const dir of isTwoWay(r) ? ["fr", "en"] : ["fr"]) { const s2 = sideOf(r, dir); if (s2.state !== 0 && ms(s2.due) <= end) dueStart.push(itemKey(r.id, dir)); }
  const ans = answersBySitting.get(s.id) || [];
  const shown = new Set(ans.map((a) => itemKey(a.cardId, a.dir)));
  const dueShown = dueStart.filter((k) => shown.has(k)).length;
  const newIntro = ans.filter((a) => a.review && reviewById.get(a.review.id)?.counted && reviewById.get(a.review.id)?.state_before === 0).length;
  const retries = ans.filter((a) => a.retryMarker).length;
  const blocks = blockInfo.filter((b) => b.sitting === s.id).length;
  F.perSitting.push({ id: s.id, date: s.date, time: s.time, blocks, answers: ans.length, retries, newIntroduced: newIntro, dueAtStart: dueStart.length, dueShown, dueLeftUndone: dueStart.length - dueShown, accuracyFirst: ans.filter((a) => !a.retryMarker).length ? ans.filter((a) => !a.retryMarker && a.pressed === "right").length / ans.filter((a) => !a.retryMarker).length : null });
}
results.F = { caughtUp: F.caughtUpEvents.length, perSitting: F.perSitting };
say("\n══ F. Coverage / load per sitting ══");
say("sitting date time blocks answers retries newIntroduced dueAtStart dueShown dueLeftUndone firstTryAcc");
for (const p of F.perSitting) say(`${p.id} ${p.date} ${p.time} ${p.blocks} ${p.answers} ${p.retries} ${p.newIntroduced} ${p.dueAtStart} ${p.dueShown} ${p.dueLeftUndone} ${fmt(p.accuracyFirst, 2)}`);
say(`sittings that ended "caught up": ${F.caughtUpEvents.length}`);
// Per local day: due at the day's first deal, how many were answered that day, what was still due at day end.
F.perDay = [];
{
  const days = [...new Set(blockInfo.map((b) => b.today))].sort();
  for (const d of days) {
    const firstB = blockInfo.filter((b) => b.today === d).sort((a, b) => a.at - b.at)[0];
    const lastCp = checkpoints.filter((c) => { const f = path.join(snapDir, `cp-${String(c.block).padStart(3, "0")}.json`); return fs.existsSync(f) && localDate(JSON.parse(fs.readFileSync(f)).meta.simMs) === d; }).at(-1);
    const snapStart = JSON.parse(fs.readFileSync(path.join(snapDir, `block-${String(firstB.block).padStart(3, "0")}.json`))).user_cards.filter((r) => r.user_id === UID);
    const end = eod(firstB.at);
    const dueStart = new Set();
    for (const r of snapStart) for (const dir of isTwoWay(r) ? ["fr", "en"] : ["fr"]) { const s2 = sideOf(r, dir); if (s2.state !== 0 && ms(s2.due) <= end) dueStart.add(itemKey(r.id, dir)); }
    let stillDue = null;
    if (lastCp) {
      const snapEnd = JSON.parse(fs.readFileSync(path.join(snapDir, `cp-${String(lastCp.block).padStart(3, "0")}.json`)));
      stillDue = 0;
      for (const r of snapEnd.user_cards.filter((x) => x.user_id === UID)) for (const dir of isTwoWay(r) ? ["fr", "en"] : ["fr"]) { const s2 = sideOf(r, dir); if (s2.state !== 0 && ms(s2.due) <= end && localDate(ms(s2.last)) !== d) stillDue++; }
    }
    const dayAns = realAnswers.filter((a) => a.review && localDate(ms(a.review.answered_at)) === d);
    const answeredItems = new Set(dayAns.map((a) => itemKey(a.cardId, a.dir)));
    F.perDay.push({ day: d, answers: dayAns.length, dueAtStart: dueStart.size, dueAnswered: [...dueStart].filter((k) => answeredItems.has(k)).length, stillDueAtEnd: stillDue, newIntroduced: dayAns.filter((a) => { const r = reviewById.get(a.review.id); return r?.counted && r.state_before === 0; }).length, firstTryAcc: dayAns.filter((a) => !a.retryMarker).length ? +(dayAns.filter((a) => !a.retryMarker && a.pressed === "right").length / dayAns.filter((a) => !a.retryMarker).length).toFixed(2) : null });
  }
  say("day answers dueAtStart dueAnswered stillDueAtEnd newIntroduced firstTryAcc");
  for (const p of F.perDay) say(`${p.day} ${p.answers} ${p.dueAtStart} ${p.dueAnswered} ${p.stillDueAtEnd} ${p.newIntroduced} ${p.firstTryAcc}`);
  // Post-break backlog: sittings from 7 Oct until a block deals genuinely new items (due work exhausted)
  const post = blockInfo.filter((b) => b.today >= "2026-10-07");
  const firstNew = post.find((b) => (b.cls.new || 0) > 0 && b.dueLeftOut === 0);
  const sittingsIdx = [...new Set(post.map((b) => b.sitting))];
  F.backlogClearedAt = firstNew ? { block: firstNew.block, sitting: firstNew.sitting, date: firstNew.today, sittingsFromBreak: sittingsIdx.indexOf(firstNew.sitting) + 1 } : null;
  F.backlogNeverCleared = !firstNew;
  say(`post-break (from Wed 7 Oct): first block whose due work was exhausted (new items dealt, nothing due left out): ${JSON.stringify(F.backlogClearedAt)}`);
  results.F.perDay = F.perDay; results.F.backlogClearedAt = F.backlogClearedAt;
}
fs.writeFileSync(path.join(OUT, "F-coverage.json"), JSON.stringify(F, null, 1));

// ═════ G. Day boundaries ══════════════════════════════════════════════════
const G = {};
{
  const s07 = realAnswers.filter((a) => a.sitting === "S07");
  const after = s07.filter((a) => a.review && localDate(ms(a.review.answered_at)) === "2026-10-02");
  G.midnight = { answersInSitting: s07.length, afterMidnight: after.length, firstAfter: after[0] ? { n: after[0].n, at: after[0].review.answered_at, counter: after[0].counter } : null, countedAfter: after.filter((a) => a.review.counted).length };
  const itemsBefore = new Set(s07.filter((a) => a.review && localDate(ms(a.review.answered_at)) === "2026-10-01").map((a) => itemKey(a.cardId, a.dir)));
  G.midnight.itemsOnBothSides = after.filter((a) => itemsBefore.has(itemKey(a.cardId, a.dir))).map((a) => ({ n: a.n, item: itemKey(a.cardId, a.dir), counted: a.review.counted, retry: a.retryMarker }));
  // Next sitting (Fri 08:00): items answered after midnight shown again, and their counting
  const s08 = realAnswers.filter((a) => a.sitting === "S08");
  const afterSet = new Map(after.map((a) => [itemKey(a.cardId, a.dir), a]));
  G.midnight.nextMorningRepeats = s08.filter((a) => afterSet.has(itemKey(a.cardId, a.dir))).map((a) => ({ n: a.n, item: itemKey(a.cardId, a.dir), counted: a.review?.counted }));
  // DST weekend
  const dstSittings = ["S31", "S32", "S33", "S34"];
  G.dst = {};
  for (const id of dstSittings) {
    const L = realAnswers.filter((a) => a.sitting === id);
    G.dst[id] = { answers: L.length, counted: L.filter((a) => a.review?.counted).length, localDates: [...new Set(L.map((a) => a.review && localDate(ms(a.review.answered_at))))], firstLocal: L[0]?.simLocal };
  }
  const s31 = new Map(realAnswers.filter((a) => a.sitting === "S31" && a.review?.counted).map((a) => [itemKey(a.cardId, a.dir), a]));
  G.dst.recountedWithin2h = realAnswers.filter((a) => a.sitting === "S32" && a.review?.counted && s31.has(itemKey(a.cardId, a.dir))).map((a) => {
    const r = reviewById.get(a.review.id);
    return { item: itemKey(a.cardId, a.dir), prev: s31.get(itemKey(a.cardId, a.dir)).review.answered_at, now: r.answered_at, hours: (ms(r.answered_at) - ms(r.last_review_before)) / 36e5, utcDaysUsed: tsf.dateDiffInDays(new Date(r.last_review_before), new Date(r.answered_at)), rating: r.rating, S: [r.stability_before, r.stability_after], due: r.due_after };
  });
  const nov1 = counted.filter((r) => localDate(ms(r.answered_at)) === "2026-11-01");
  const perItem = new Map(); for (const r of nov1) { const k = itemKey(r.card_id, r.direction); perItem.set(k, (perItem.get(k) || 0) + 1); }
  G.dst.nov1CountedTwice = [...perItem].filter(([, n]) => n > 1).length;
  G.dst.nov1Counted = nov1.length;
}
results.G = G;
say("\n══ G. Day boundaries ══");
say(`S07 (Thu 1 Oct 23:50): ${G.midnight.answersInSitting} answers, ${G.midnight.afterMidnight} after midnight (from answer n=${G.midnight.firstAfter?.n}, ${G.midnight.firstAfter?.at}, "${G.midnight.firstAfter?.counter}"), ${G.midnight.countedAfter} of them counted; same item on both sides of midnight: ${G.midnight.itemsOnBothSides.length} ${JSON.stringify(G.midnight.itemsOnBothSides.slice(0, 3))}; shown again Fri 08:00: ${G.midnight.nextMorningRepeats.length} (counted ${G.midnight.nextMorningRepeats.filter((x) => x.counted).length})`);
say(`DST weekend: ${JSON.stringify(G.dst, (k, v) => (k === "recountedWithin2h" ? `${v.length} items` : v))}`);
for (const x of G.dst.recountedWithin2h.slice(0, 2)) say("  re-counted ~2 h apart:", JSON.stringify(x));
fs.writeFileSync(path.join(OUT, "G-boundaries.json"), JSON.stringify(G, null, 1));

// ═════ H. Saves and stability ═════════════════════════════════════════════
const H = {};
{
  const appReqs = dbLog.filter((e) => e.role === "user");
  H.appRequests = appReqs.length;
  H.failed = appReqs.filter((e) => e.status >= 400).map((e) => ({ seq: e.seq, method: e.method, path: e.path, status: e.status, error: e.error }));
  H.serviceFailed = dbLog.filter((e) => e.role === "service" && e.status >= 400).map((e) => ({ seq: e.seq, method: e.method, path: e.path, status: e.status, rows: Array.isArray(e.body) ? e.body.length : 1, error: e.error?.message }));
  const byReviewId = new Map();
  for (const p of reviewPosts) { const id = p.body?.id; if (!id) continue; byReviewId.set(id, (byReviewId.get(id) || 0) + 1); }
  H.reviewUpsertsRepeated = [...byReviewId].filter(([, n]) => n > 1).length;
  // Console messages were logged with the console level as their type ("error" / "warning").
  const consoleEv = events.filter((e) => (e.type === "error" || e.type === "warning") && typeof e.text === "string");
  H.consoleErrors = consoleEv.filter((e) => !/favicon\.ico/.test(e.loc || "")).map((e) => `${e.type}: ${e.text.slice(0, 160)} @${e.loc}`);
  H.consoleFavicon = consoleEv.filter((e) => /favicon\.ico/.test(e.loc || "")).length;
  H.pageErrors = events.filter((e) => e.type === "pageerror").map((e) => e.message);
  H.requestFailed = events.filter((e) => e.type === "request-failed").length;
  H.httpErrors = events.filter((e) => e.type === "http-error").map((e) => `${e.method} ${e.url.slice(0, 80)} ${e.status}`);
  H.answers = realAnswers.length;
  H.rowPerAnswer = realAnswers.filter((a) => a.reviewRowsNew === 1).length;
  H.reviewMismatch = realAnswers.filter((a) => a.REVIEW_MISMATCH).length;
  H.gradeMismatch = realAnswers.filter((a) => a.GRADE_MISMATCH).length;
  H.unsavedNotices = realAnswers.filter((a) => a.unsavedNotice).length;
  H.reviewsInDb = reviews.length;
  H.corrections = corrections.length;
  H.warn = events.filter((e) => e.type === "warn").map((e) => e.msg);
  H.driverErrors = events.filter((e) => e.type === "driver-error").map((e) => e.message);
}
results.H = H;
say("\n══ H. Saves and stability ══");
say(`app requests: ${H.appRequests}; failed (≥400): ${H.failed.length} ${JSON.stringify(H.failed.slice(0, 3))}`);
say(`server-side (service key) failures: ${JSON.stringify(H.serviceFailed)}`);
say(`answers: ${H.answers}; exactly one new card_reviews row per answer: ${H.rowPerAnswer}; card/direction mismatches: ${H.reviewMismatch}; grade mismatches: ${H.gradeMismatch}; corrections: ${H.corrections}; rows in table: ${H.reviewsInDb}; review upserts sent more than once: ${H.reviewUpsertsRepeated}; "not saved yet" notices seen: ${H.unsavedNotices}`);
say(`console errors (excl. ${H.consoleFavicon} favicon 404s): ${H.consoleErrors.length} ${JSON.stringify([...new Set(H.consoleErrors)].slice(0, 4))}; page errors: ${H.pageErrors.length}; failed requests: ${H.requestFailed}; HTTP errors seen by the page: ${JSON.stringify([...new Set(H.httpErrors)])}; driver warnings: ${H.warn.length}`);

// ═════ Behaviour 1. Calibration ═══════════════════════════════════════════
const w = sr.scheduler.parameters.w;
const decay = -w[20]; const factor = Math.pow(0.9, 1 / decay) - 1;
const Rexact = (days, S) => Math.pow(1 + (factor * days) / S, decay);
const cal = [];
for (const { a, r } of ansRow) {
  if (!r || !r.counted || r.state_before !== 2) continue;
  const lr = ms(r.last_review_before), t = ms(r.answered_at);
  cal.push({
    n: a.n, dir: a.dir, kind: a.kind, correct: r.correct, modelP: a.p, modelPraw: a.p_raw,
    R_used: tsf.forgetting_curve(w, tsf.dateDiffInDays(new Date(lr), new Date(t)), r.stability_before),
    R_exact: Rexact((t - lr) / DAY, r.stability_before),
    scheduledIvl: (() => { const L = (byItem.get(itemKey(r.card_id, r.direction)) || []).filter((x) => x.counted && ms(x.answered_at) < t); const p = L.at(-1); return p ? (ms(p.due_after) - ms(p.answered_at)) / DAY : null; })(),
    elapsed: (t - lr) / DAY, bucket: a.queueEntry?.bucket, S: r.stability_before, primed: a.primed,
  });
}
function calib(list, key) {
  const bins = [[0, 0.7], [0.7, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 0.95], [0.95, 1.0001]];
  const rows = bins.map(([lo, hi]) => { const L = list.filter((x) => x[key] >= lo && x[key] < hi); return { bin: `${lo}-${hi > 1 ? 1 : hi}`, n: L.length, meanPred: L.length ? L.reduce((s, x) => s + x[key], 0) / L.length : null, actual: L.length ? L.filter((x) => x.correct).length / L.length : null }; });
  const eps = 1e-6;
  const ll = -list.reduce((s, x) => s + (x.correct ? Math.log(Math.max(eps, x[key])) : Math.log(Math.max(eps, 1 - x[key]))), 0) / list.length;
  const rmse = Math.sqrt(list.reduce((s, x) => s + (x[key] - (x.correct ? 1 : 0)) ** 2, 0) / list.length);
  // RMSE over bins (FSRS's usual calibration RMSE), weighted by count
  const binR = Math.sqrt(rows.filter((r) => r.n).reduce((s, r) => s + r.n * (r.meanPred - r.actual) ** 2, 0) / list.length);
  return { rows, logLoss: ll, rmse, rmseBins: binR, n: list.length, meanPred: list.reduce((s, x) => s + x[key], 0) / list.length, actual: list.filter((x) => x.correct).length / list.length };
}
const calUsed = calib(cal, "R_used"), calExact = calib(cal, "R_exact"), calModel = calib(cal, "modelP");
results.calibration = { R_used: calUsed, R_exact: calExact, modelP: calModel };
say("\n══ 1. Calibration on counted reviews of seen items ══");
for (const [name, c] of [["FSRS R (UTC-day elapsed, as used)", calUsed], ["FSRS R (exact elapsed)", calExact], ["hidden model p", calModel]]) {
  say(`${name}: n=${c.n}, mean predicted ${fmt(c.meanPred)}, actual ${fmt(c.actual)}, log-loss ${fmt(c.logLoss)}, RMSE ${fmt(c.rmse)}, binned RMSE ${fmt(c.rmseBins)}`);
  say("   " + c.rows.map((r) => `${r.bin}: n=${r.n} pred ${fmt(r.meanPred, 2)} act ${fmt(r.actual, 2)}`).join(" | "));
}

// ═════ 2. Retention on scheduled reviews ══════════════════════════════════
const sched = cal.filter((x) => x.bucket === "review" || x.bucket === "lapse");
const ret = (L) => (L.length ? `${pct(L.filter((x) => x.correct).length, L.length)} (n=${L.length})` : "n/a");
const ivlBin = (d) => (d < 1.5 ? "≤1d" : d < 3.5 ? "2-3d" : d < 7.5 ? "4-7d" : d < 15 ? "8-14d" : ">14d");
results.retention = {
  all: ret(sched), byDir: { fr: ret(sched.filter((x) => x.dir === "fr" && x.kind !== "oneway")), en: ret(sched.filter((x) => x.dir === "en")), oneway: ret(sched.filter((x) => x.kind === "oneway")) },
  byKind: { vocab: ret(sched.filter((x) => x.kind === "vocab")), expr: ret(sched.filter((x) => x.kind === "expr")), oneway: ret(sched.filter((x) => x.kind === "oneway")) },
  byBucket: { review: ret(sched.filter((x) => x.bucket === "review")), lapse: ret(sched.filter((x) => x.bucket === "lapse")) },
  byElapsed: Object.fromEntries(["≤1d", "2-3d", "4-7d", "8-14d", ">14d"].map((b) => [b, ret(sched.filter((x) => ivlBin(x.elapsed) === b))])),
  byScheduledInterval: Object.fromEntries(["≤1d", "2-3d", "4-7d", "8-14d", ">14d"].map((b) => [b, ret(sched.filter((x) => x.scheduledIvl != null && ivlBin(x.scheduledIvl) === b))])),
  onTimeVsOverdue: { onTime: ret(sched.filter((x) => x.scheduledIvl != null && x.elapsed <= x.scheduledIvl + 1)), overdueMoreThan1d: ret(sched.filter((x) => x.scheduledIvl != null && x.elapsed > x.scheduledIvl + 1)) },
  primedVsNot: { primed: ret(sched.filter((x) => x.primed)), notPrimed: ret(sched.filter((x) => !x.primed)) },
  notDueButCounted: ret(cal.filter((x) => x.bucket === "new" || x.bucket === "spot")),
};
say("\n══ 2. Achieved retention on due reviews (target 90%) ══");
say(JSON.stringify(results.retention, null, 1));

// ═════ 3. Load per day ════════════════════════════════════════════════════
const byDay = new Map();
for (const a of realAnswers) {
  const d = a.review ? localDate(ms(a.review.answered_at)) : a.sittingDate;
  if (!byDay.has(d)) byDay.set(d, { answers: 0, retries: 0, newIntro: 0, countedDue: 0, right: 0 });
  const x = byDay.get(d); x.answers++; if (a.retryMarker) x.retries++;
  const r = a.review && reviewById.get(a.review.id);
  if (r?.counted && r.state_before === 0) x.newIntro++;
  if (r?.counted && r.state_before === 2) x.countedDue++;
  if (a.pressed === "right") x.right++;
}
results.loadByDay = Object.fromEntries(byDay);
say("\n══ 3. Load per local day ══");
say("day answers retries newIntroduced countedReviews right");
for (const [d, x] of [...byDay].sort()) say(`${d} ${x.answers} ${x.retries} ${x.newIntro} ${x.countedDue} ${x.right}`);

// ═════ 4. Intervals ═══════════════════════════════════════════════════════
const firstIvl = { right: [], wrong: [] };
const growth = [];
const oddRepeats = [];
for (const [k, list] of byItem) {
  const c = list.filter((r) => r.counted);
  let streak = [];
  for (const r of c) {
    const ivl = (ms(r.due_after) - ms(r.answered_at)) / DAY;
    if (r.state_before === 0) (r.correct ? firstIvl.right : firstIvl.wrong).push(ivl);
    if (r.correct) streak.push(ivl); else streak = [];
    if (streak.length >= 2) growth.push({ k, step: streak.length, ratio: streak.at(-1) / streak.at(-2), ivl: streak.at(-1) });
  }
  // right answers followed by the same short interval again
  for (let i = 1; i < c.length; i++) {
    const i0 = (ms(c[i - 1].due_after) - ms(c[i - 1].answered_at)) / DAY, i1 = (ms(c[i].due_after) - ms(c[i].answered_at)) / DAY;
    if (c[i - 1].correct && c[i].correct && i1 <= i0 && i1 <= 3) oddRepeats.push({ k, prev: [c[i - 1].answered_at, i0, c[i - 1].stability_after], next: [c[i].answered_at, i1, c[i].stability_after], elapsedUtc: tsf.dateDiffInDays(new Date(c[i - 1].answered_at), new Date(c[i].answered_at)) });
  }
}
const dist = (L) => { const m = {}; for (const x of L) m[Math.round(x)] = (m[Math.round(x)] || 0) + 1; return m; };
const byStep = {}; for (const g of growth) { (byStep[g.step] ||= []).push(g.ratio); }
results.intervals = { firstRight: dist(firstIvl.right), firstWrong: dist(firstIvl.wrong), growthByStep: Object.fromEntries(Object.entries(byStep).map(([s, L]) => [s, { n: L.length, medianRatio: L.sort((a, b) => a - b)[Math.floor(L.length / 2)] }])), rightThenNoGrowth: oddRepeats.length };
say("\n══ 4. Intervals ══");
say(`first interval after a new item answered right (days: count): ${JSON.stringify(results.intervals.firstRight)}; wrong: ${JSON.stringify(results.intervals.firstWrong)}`);
say(`interval growth over successive rights (step: median ratio): ${JSON.stringify(results.intervals.growthByStep)}`);
say(`right answer followed by another right answer with no longer (≤3 d) interval: ${oddRepeats.length}`);
for (const o of oddRepeats.slice(0, 3)) say("  e.g.", JSON.stringify(o));
fs.writeFileSync(path.join(OUT, "4-intervals.json"), JSON.stringify({ firstIvl, growth, oddRepeats }, null, 1));

// ═════ 5. Siblings ════════════════════════════════════════════════════════
{
  const byCardDay = new Map();
  for (const a of realAnswers) {
    if (a.retryMarker || !a.review || a.kind === "oneway") continue;
    const k = `${a.cardId}@${localDate(ms(a.review.answered_at))}`;
    if (!byCardDay.has(k)) byCardDay.set(k, []);
    byCardDay.get(k).push(a);
  }
  let sameDay = 0, sameBlock = 0, firstRight = 0, secondRight = 0, pairs = 0;
  for (const L of byCardDay.values()) {
    const dirs = new Set(L.map((a) => a.dir));
    if (dirs.size < 2) continue;
    sameDay++;
    const fa = L[0], sa = L.find((a) => a.dir !== fa.dir);
    if (fa.block === sa.block) sameBlock++;
    pairs++; if (fa.pressed === "right") firstRight++; if (sa.pressed === "right") secondRight++;
  }
  results.siblings = { cardDaysBothDirections: sameDay, sameBlock, firstAcc: pairs ? firstRight / pairs : null, secondAcc: pairs ? secondRight / pairs : null, pairs };
  say("\n══ 5. Siblings ══");
  say(`card-days with both directions asked: ${sameDay} (same block: ${sameBlock}); accuracy first-asked ${fmt(results.siblings.firstAcc, 2)} vs second-asked ${fmt(results.siblings.secondAcc, 2)} (n=${pairs})`);
}

// ═════ 6. Spot-checks ═════════════════════════════════════════════════════
{
  const spots = ansRow.filter(({ a }) => a.queueEntry?.bucket === "spot" && !a.retryMarker);
  const moves = spots.map(({ a, r }) => {
    const prevDue = (() => { const L = (byItem.get(itemKey(a.cardId, a.dir)) || []).filter((x) => x.counted && ms(x.answered_at) < ms(r.answered_at)); return L.at(-1)?.due_after; })();
    return { n: a.n, correct: r?.correct, counted: r?.counted, prevDue, newDue: r?.due_after, shiftDays: prevDue && r?.due_after ? (ms(r.due_after) - ms(prevDue)) / DAY : null };
  });
  results.spot = { n: spots.length, acc: spots.length ? spots.filter(({ r }) => r?.correct).length / spots.length : null, moves };
  say("\n══ 6. Spot-checks ══");
  say(`spot-checks: ${spots.length}; accuracy ${fmt(results.spot.acc, 2)}; due-date shifts (days): ${JSON.stringify(moves.map((m) => m.shiftDays == null ? null : Math.round(m.shiftDays)))}`);
}

// ═════ 7. Checkpoint "about N remembered" vs the hidden model ═════════════
{
  // Rebuild the hidden memory as of each checkpoint from the answer log.
  const areaName = { recent: "Last two weeks of class", earlier: "Older classes", "lesson:imperatif": "L'impératif", "lesson:adverbes": "Adjectif ou adverbe ?" };
  const shape = (r) => ({ ...r, f: r.front, b: r.back, cat: { V: "vocab", E: "expr", G: "gram", P: "pron" }[r.category] || "vocab", dates: r.dates || [], row_id: r.id });
  const out = [];
  for (const cp of checkpoints) {
    const label = `cp-${String(cp.block).padStart(3, "0")}.json`;
    const f = path.join(snapDir, label);
    if (!fs.existsSync(f)) continue;
    const snap = JSON.parse(fs.readFileSync(f));
    const T = snap.meta?.simMs;
    const rows = snap.user_cards.filter((r) => r.user_id === UID).map(shape);
    const mem = new Memory();
    for (const a of answers) { if (a.cardId == null || a.modelShownAt > T) continue; const it = mem.item(a.cardId, a.dir, a.kind, a.nDates); it.S = a.S_after; it.lastShown = a.modelShownAt; }
    const appAreas = progressLib.progressByArea(rows, T);
    for (const area of cp.areas || []) {
      const key = Object.entries(areaName).find(([, v]) => v === area.area)?.[0];
      if (!key) continue;
      const inArea = rows.filter((r) => progressLib.areaOf(r, T) === key);
      let trueSeen = 0, trueAll = 0, trueSeenZero = 0;
      for (const r of inArea) {
        const dirs = isTwoWay(r) ? ["fr", "en"] : ["fr"];
        const ps = dirs.map((d) => { const it = mem.items.get(itemKey(r.id, d)); const p = mem.pNow(it, T); return p == null ? { p: mem.firstSightP(kindOf(r.id), d, (r.dates || []).length), seen: false } : { p, seen: true }; });
        const both = ps.reduce((x, y) => x * y.p, 1);
        trueAll += both;
        const appSeen = dirs.some((d) => (d === "fr" ? r.fsrs_state : r.en_fsrs_state) !== 0);
        if (appSeen) { trueSeen += both; trueSeenZero += ps.reduce((x, y) => x * (y.seen ? y.p : 0), 1); }
      }
      const appVal = key.startsWith("lesson:") ? appAreas.lessons[key.slice(7)] : appAreas[key];
      out.push({ block: cp.block, sitting: cp.sitting, at: cp.simLocal, area: area.area, shown: area.aboutRemembered, recomputedApp: appVal ? Math.round(appVal.remembered) : null, seen: area.seen, modelSeenCards: +trueSeen.toFixed(1), modelSeenCardsUnseenSideZero: +trueSeenZero.toFixed(1), modelWholeArea: +trueAll.toFixed(1) });
    }
  }
  results.checkpointRemembered = out;
  say("\n══ 7. Checkpoint \"about N remembered\" vs hidden model ══");
  say("block sitting area shown(app) recomputed seen | model: seen cards / seen, unseen side=0 / whole area");
  for (const o of out.filter((x, i) => i % Math.max(1, Math.floor(out.length / 24)) === 0 || i === out.length - 1)) say(`${o.block} ${o.sitting} ${o.area} ${o.shown} ${o.recomputedApp} ${o.seen} | ${o.modelSeenCards} / ${o.modelSeenCardsUnseenSideZero} / ${o.modelWholeArea}`);
  fs.writeFileSync(path.join(OUT, "7-checkpoints.json"), JSON.stringify(out, null, 1));
}

// ═════ Typed answers ══════════════════════════════════════════════════════
{
  const typed = realAnswers.filter((a) => a.mode === "typed");
  const mm = typed.filter((a) => a.typedMismatch);
  results.typed = { n: typed.length, modelRightAppWrong: mm.filter((a) => a.typedMismatch === "model-right-app-wrong").map((a) => ({ n: a.n, prompt: a.prompt, typed: a.typed, expected: a.expected, verdict: a.appVerdictText })), modelWrongAppRight: mm.filter((a) => a.typedMismatch === "model-wrong-app-right").map((a) => ({ n: a.n, prompt: a.prompt, typed: a.typed, expected: a.expected, verdict: a.appVerdictText })) };
  say("\n══ Typing sittings ══");
  say(`typed answers: ${typed.length}; model right but app marked wrong: ${results.typed.modelRightAppWrong.length}; model wrong but app marked right: ${results.typed.modelWrongAppRight.length}`);
  for (const x of [...results.typed.modelRightAppWrong.slice(0, 4), ...results.typed.modelWrongAppRight.slice(0, 2)]) say("  ", JSON.stringify(x));
}

// ═════ Run summary ════════════════════════════════════════════════════════
results.summary = {
  answers: realAnswers.length, corrections: corrections.length, counted: counted.length, sittings: new Set(realAnswers.map((a) => a.sitting)).size,
  days: new Set(realAnswers.map((a) => a.review && localDate(ms(a.review.answered_at)))).size, blocks: blockStarts.length,
  deck: { total: cards.length, byCategory: cards.reduce((m, c) => ((m[c.category] = (m[c.category] || 0) + 1), m), {}), bySource: cards.reduce((m, c) => { const s = (c.source || "").split("#")[0]; m[s] = (m[s] || 0) + 1; return m; }, {}) },
  itemsIntroduced: new Set(counted.filter((r) => r.state_before === 0).map((r) => itemKey(r.card_id, r.direction))).size,
  modelRight: realAnswers.filter((a) => a.modelRight).length,
};
say("\n══ Summary ══");
say(JSON.stringify(results.summary));
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(OUT, "report.txt"), report.join("\n"));
