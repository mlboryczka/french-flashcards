// What the upload produced: stand-in card sources, what the dialog reported,
// and what reached the database.
import fs from "node:fs";
import path from "node:path";
const WORK = process.env.WORK;
const DATA = path.join(WORK, "data");
const readJsonl = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const claude = readJsonl(path.join(DATA, "claude-requests.jsonl")).filter((r) => r.path === "/v1/messages");
const api = readJsonl(path.join(DATA, "api-requests.jsonl"));
const db = readJsonl(path.join(DATA, "db-requests.jsonl"));
const events = readJsonl(path.join(DATA, "driver-events.jsonl"));
const dump = JSON.parse(fs.readFileSync(path.join(DATA, "final-dump.json"), "utf8"));
const { RAW } = await import(path.join(WORK, "app/src/data/cards.js"));
const { HANDWRITTEN } = await import(path.join(WORK, "servers/handwritten-cards.mjs"));
const pc = await import(path.join(WORK, "app/api/parse-cahier.js"));
const uid = dump.users.find((u) => u.email === "nora.lindqvist@example.com").id;
const cards = dump.tables.user_cards.filter((c) => c.user_id === uid);
const out = {};
const bySource = {};
for (const r of claude) { bySource[r.source] = bySource[r.source] || { requests: 0, cards: 0 }; bySource[r.source].requests++; bySource[r.source].cards += r.cardsReturned; }
out.claudeStandIn = { requests: claude.length, bySource };
const rawFronts = new Set(RAW.map((r) => r[0]));
const hwFronts = new Set(Object.values(HANDWRITTEN).flat().map((x) => x[0]));
const cahierCards = cards.filter((c) => c.source === "cahier-upload" || c.source === "conjugation-drill");
const baseFront = (f) => f.replace(/ \([^)]*\)$/, "");
out.deckCahierCards = {
  total: cahierCards.length,
  fromRAW: cahierCards.filter((c) => rawFronts.has(c.front) || rawFronts.has(baseFront(c.front))).length,
  fromHandwritten: cahierCards.filter((c) => hwFronts.has(c.front)).length,
  byCategory: cahierCards.reduce((m, c) => ((m[c.category] = (m[c.category] || 0) + 1), m), {}),
};
out.deckAll = { total: cards.length, byCategory: cards.reduce((m, c) => ((m[c.category] = (m[c.category] || 0) + 1), m), {}), bySource: cards.reduce((m, c) => { const s = (c.source || "").split("#")[0]; m[s] = (m[s] || 0) + 1; return m; }, {}) };
const blocks = pc.sliceIntoBlocks(fs.readFileSync("/Users/mboryczka/Downloads/Cahier Matthew.txt", "utf8"));
const cahierDates = [...new Set(blocks.map((b) => b.date))].sort();
const deckDates = new Set(cahierCards.flatMap((c) => c.dates || []));
const withCards = new Set(claude.filter((r) => r.cardsReturned > 0).flatMap((r) => r.dates));
out.classes = {
  inCahier: cahierDates.length, blocksSliced: blocks.length,
  classesWithCardsFromStandIn: withCards.size,
  classesInDeck: deckDates.size,
  classesLost: [...withCards].filter((d) => !deckDates.has(d)).sort(),
  classesWithNoCards: cahierDates.filter((d) => !withCards.has(d)),
};
out.classes.lostRange = [out.classes.classesLost[0], out.classes.classesLost.at(-1)];
out.dialog = {
  progress: events.find((e) => e.type === "upload-done")?.progress,
  alert: events.find((e) => e.type === "upload-done")?.alert,
};
const commitReq = api.find((r) => r.path === "/api/parse-cahier" && r.body?.action === "commit");
out.commitResponse = commitReq?.resp;
const failed = db.filter((e) => e.role === "service" && e.path === "/rest/v1/user_cards" && e.status >= 400);
out.failedUpsert = failed.map((e) => ({ seq: e.seq, status: e.status, rows: e.body.length, error: e.error, duplicateFronts: [...new Set(e.body.map((b) => b.front).filter((f, i, a) => a.indexOf(f) !== i))] }));
const okUps = db.filter((e) => e.role === "service" && e.path === "/rest/v1/user_cards" && e.method === "POST" && e.status < 300);
out.okUpserts = okUps.map((e) => ({ seq: e.seq, rows: e.body.length }));
const batches = dump.tables.upload_batches.filter((b) => b.user_id === uid);
out.uploadBatches = batches.map((b) => ({ cards_parsed: b.cards_parsed, cards_accepted: b.cards_accepted, source: b.source, model: b.model }));
out.uploadBatchesPatch = api.filter((r) => r.path === "/api/upload-batches").map((r) => ({ status: r.status, resp: r.resp }));
out.lessonSync = db.filter((e) => e.role === "user" && e.path === "/rest/v1/user_cards" && e.method === "POST").map((e) => ({ seq: e.seq, t: e.t, rows: Array.isArray(e.body) ? e.body.length : 1, status: e.status }));
fs.writeFileSync(path.join(WORK, "analysis/out/upload.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, (k, v) => (k === "classesLost" || k === "classesWithNoCards" ? `${v.length} classes: ${v.slice(0, 4).join(", ")}${v.length > 4 ? " …" : ""}` : v), 1));
