// Supplementary numbers for the report.
import fs from "node:fs";
import path from "node:path";
if (process.env.TZ !== "America/New_York") throw new Error("TZ");
const WORK = process.env.WORK;
const DATA = path.join(WORK, "data");
const APP = path.join(WORK, "app");
const sr = await import(path.join(APP, "src/lib/spacedRepetition.js"));
const tsf = await import(path.join(APP, "node_modules/ts-fsrs/dist/index.mjs"));
const studyDay = await import(path.join(APP, "src/lib/studyDay.js"));
const readJsonl = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const answers = readJsonl(path.join(DATA, "driver-answers.jsonl"));
const events = readJsonl(path.join(DATA, "driver-events.jsonl"));
const dump = JSON.parse(fs.readFileSync(path.join(DATA, "final-dump.json")));
const uid = dump.users.find((u) => u.email === "nora.lindqvist@example.com").id;
const f4 = (f) => { if (f == null) return f; for (let p = 1; p <= 9; p++) { const s = Number(f.toPrecision(p)); if (Math.fround(s) === f) return s; } return f; };
const reviews = dump.tables.card_reviews.filter((r) => r.user_id === uid).map((r) => ({ ...r, stability_before: f4(r.stability_before), stability_after: f4(r.stability_after) }));
const byId = new Map(reviews.map((r) => [r.id, r]));
const ms = (x) => new Date(x).getTime();
const DAY = 864e5;
const w = sr.scheduler.parameters.w;
const R = (d, S) => tsf.forgetting_curve(w, d, S);
const out = {};
// 1. The 3-day floor: Good answers and FSRS's own predicted recall at the due date it set.
const good = reviews.filter((r) => r.counted && r.rating === 3);
const atDue = good.map((r) => { const ivl = Math.round((ms(r.due_after) - ms(r.answered_at)) / DAY); return { ivl, S: r.stability_after, Rdue: R(ivl, r.stability_after) }; });
out.goodAnswers = good.length;
out.goodWithStabilityBelow3 = atDue.filter((x) => x.S < 3).length;
out.goodIntervalAbove3xS = atDue.filter((x) => x.ivl > x.S * 1.5 && x.ivl === 3).length;
out.predictedRatDue = { median: atDue.map((x) => x.Rdue).sort((a, b) => a - b)[Math.floor(atDue.length / 2)], below085: atDue.filter((x) => x.Rdue < 0.85).length, below075: atDue.filter((x) => x.Rdue < 0.75).length };
out.intervalsAfterGood = atDue.reduce((m, x) => ((m[x.ivl] = (m[x.ivl] || 0) + 1), m), {});
// 2. Stability reached
const maxS = Math.max(...reviews.filter((r) => r.counted).map((r) => r.stability_after));
out.maxStability = maxS;
out.itemsStabilityOver21 = new Set(reviews.filter((r) => r.counted && r.stability_after >= 21).map((r) => `${r.card_id}:${r.direction}`)).size;
// 3. Early reviews: counted reviews answered before the previous review's due date (local day).
const byItem = new Map();
for (const r of reviews.filter((x) => x.counted).sort((a, b) => ms(a.answered_at) - ms(b.answered_at))) { const k = `${r.card_id}:${r.direction}`; if (!byItem.has(k)) byItem.set(k, []); byItem.get(k).push(r); }
let early = 0, earlyRight = 0; const earlyDays = []; let zeroUtc = 0; const earlyBySitting = {};
const ansByReview = new Map(answers.filter((a) => a.review).map((a) => [a.review.id, a]));
for (const L of byItem.values()) for (let i = 1; i < L.length; i++) {
  const p = L[i - 1], r = L[i];
  if (studyDay.localISODate(new Date(r.answered_at)) < studyDay.localISODate(new Date(p.due_after))) {
    early++; if (r.correct) earlyRight++;
    earlyDays.push((ms(p.due_after) - ms(r.answered_at)) / DAY);
    const a = ansByReview.get(r.id); if (a) earlyBySitting[a.blockInSitting === 1 ? "firstBlock" : "laterBlock"] = (earlyBySitting[a.blockInSitting === 1 ? "firstBlock" : "laterBlock"] || 0) + 1;
  }
  if (tsf.dateDiffInDays(new Date(p.answered_at), new Date(r.answered_at)) === 0) zeroUtc++;
}
out.earlyCountedReviews = { n: early, right: earlyRight, medianDaysEarly: earlyDays.sort((a, b) => a - b)[Math.floor(earlyDays.length / 2)], where: earlyBySitting };
out.countedWithZeroUtcDays = zeroUtc;
// 4. Corrections
out.corrections = events.filter((e) => e.type.startsWith("correction")).map((e) => ({ type: e.type, n: e.n, of: e.of, cardId: e.cardId, dir: e.dir, pressed: e.pressed, modelRight: e.modelRight, row: e.row && { correct: e.row.correct, rating: e.row.rating, answered_at: e.row.answered_at }, before: e.beforeRow, after: e.afterRow }));
// 5. Typing
const typed = answers.filter((a) => a.mode === "typed");
out.typing = { n: typed.length, actions: typed.reduce((m, a) => ((m[a.typedAction] = (m[a.typedAction] || 0) + 1), m), {}), verdicts: typed.reduce((m, a) => { const k = (a.appVerdictText || "").split(/[—:]/)[0].trim(); m[k] = (m[k] || 0) + 1; return m; }, {}), counted: typed.filter((a) => a.review?.counted).length, sittings: [...new Set(typed.map((a) => a.sitting))] };
// 6. Midnight list
out.afterMidnight = answers.filter((a) => a.sitting === "S07" && a.review && studyDay.localISODate(new Date(a.review.answered_at)) === "2026-10-02").map((a) => `${a.n}:${a.counter.split(" · ")[0]}${a.retryMarker ? "(retry)" : ""}${a.review.counted ? "*" : ""}`);
// 7. Checkpoint ratios
const cps = JSON.parse(fs.readFileSync(path.join(WORK, "analysis/out/7-checkpoints.json")));
const ratio = (L, k) => { const v = L.filter((x) => x[k] > 0); return v.length ? v.reduce((s, x) => s + x.shown / x[k], 0) / v.length : null; };
const older = cps.filter((c) => c.area === "Older classes");
out.checkpoint = {
  entries: cps.length,
  allShownEqualsRecomputed: cps.every((c) => c.shown === c.recomputedApp),
  olderFromOct10: { meanRatioVsModelSameRule: ratio(older.filter((c) => c.block >= 23), "modelSeenCardsUnseenSideZero"), meanRatioVsModelWithPriors: ratio(older.filter((c) => c.block >= 23), "modelSeenCards") },
  imperatif: { meanRatioVsModel: ratio(cps.filter((c) => c.area === "L'impératif"), "modelSeenCardsUnseenSideZero") },
  last: cps.slice(-2),
  firstDay: cps.filter((c) => c.sitting === "S01"),
};
// 8. First block content
const b1 = JSON.parse(fs.readFileSync(path.join(DATA, "snapshots/block-001-app.json")));
const cards = new Map(dump.tables.user_cards.filter((c) => c.user_id === uid).map((c) => [c.id, c]));
out.firstBlockSources = b1.queue.reduce((m, q) => { const s = (cards.get(q.row_id)?.source || "").split("#")[0]; m[s] = (m[s] || 0) + 1; return m; }, {});
const b2 = JSON.parse(fs.readFileSync(path.join(DATA, "snapshots/block-002-app.json")));
out.secondBlockSources = b2.queue.reduce((m, q) => { const s = (cards.get(q.row_id)?.source || "").split("#")[0]; m[s] = (m[s] || 0) + 1; return m; }, {});
// 9. Retention of first reviews after the 3-day floor vs FSRS prediction
const firstRev = [];
for (const L of byItem.values()) if (L.length >= 2 && L[0].rating === 3 && L[0].state_before === 0) { const r = L[1]; firstRev.push({ correct: r.correct, elapsed: (ms(r.answered_at) - ms(L[0].answered_at)) / DAY, pred: R(tsf.dateDiffInDays(new Date(L[0].answered_at), new Date(r.answered_at)), L[0].stability_after) }); }
out.secondReviewAfterFirstRight = { n: firstRev.length, acc: firstRev.filter((x) => x.correct).length / firstRev.length, meanPred: firstRev.reduce((s, x) => s + x.pred, 0) / firstRev.length };
// 10. Siblings: second-direction priming within a block
out.byDirectionFirstSight = ["fr", "en"].map((d) => { const L = answers.filter((a) => a.firstSight && a.dir === d && a.kind !== "oneway"); return { dir: d, n: L.length, right: L.filter((a) => a.modelRight).length }; });
fs.writeFileSync(path.join(WORK, "analysis/out/extra.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
