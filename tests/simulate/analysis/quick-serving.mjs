// Quick look: was each dealt item due / new at deal time, per the DB snapshot?
import fs from "node:fs";
import path from "node:path";
const WORK = process.env.WORK;
const snapDir = path.join(WORK, "data/snapshots");
const blocks = fs.readdirSync(snapDir).filter((f) => /^block-\d+\.json$/.test(f)).sort();
const endOfLocalDay = (ms) => { const d = new Date(ms); const s = d.toLocaleString("en-US", { timeZone: "America/New_York" }); const loc = new Date(s); const diff = ms - loc.getTime(); loc.setHours(23, 59, 59, 999); return loc.getTime() + diff; };
for (const f of blocks) {
  const db = JSON.parse(fs.readFileSync(path.join(snapDir, f)));
  const app = JSON.parse(fs.readFileSync(path.join(snapDir, f.replace(".json", "-app.json"))));
  const at = app.at;
  const eod = endOfLocalDay(at);
  const by = new Map(db.user_cards.map((r) => [r.id, r]));
  const tally = {};
  const bad = [];
  for (const q of app.queue) {
    if (q.retry) continue;
    const r = by.get(q.row_id);
    const pre = q.dir === "en" ? "en_" : "";
    const state = r[`${pre}fsrs_state`];
    const due = r[`${pre}next_due_at`];
    const kind = state === 0 ? "new" : new Date(due).getTime() <= eod ? "due" : (r[`${pre}stability`] >= 60 ? "spot-eligible" : "NOT-DUE");
    const k = `${q.bucket}->${kind}`;
    tally[k] = (tally[k] || 0) + 1;
    if (kind === "NOT-DUE" || (q.bucket === "new" && kind !== "new")) bad.push({ id: q.row_id, dir: q.dir, bucket: q.bucket, state, due, last: r[`${pre}last_review`] });
  }
  console.log(f, app.local.slice(0, 21), JSON.stringify(tally), bad.length ? `BAD ${bad.length} e.g. ${JSON.stringify(bad[0])}` : "");
}
