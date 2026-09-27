// Stand-in for the one Claude call inside the cahier upload (POST /v1/messages).
// It answers each class block the way the parser asks (a bare JSON array of
// {front, back, category: "V" | "G"} in a text block):
//   - classes up to RAW's last date: the RAW cards (src/data/cards.js — the list
//     Claude previously extracted from this same cahier) whose dates include
//     the block's date. vocab/expr → "V", gram → "G" (the parser allows only
//     V or G; pron would be "V" but RAW has none).
//   - classes after RAW's last date: hand-written cards (handwritten-cards.mjs).
// The block's date is not in the request (the slicer strips the date line), so
// it is found by matching the block text against the app's own slicer run on
// the same cahier file.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.CLAUDE_PORT || 5993);
const WORK = process.env.WORK;
const APP = path.join(WORK, "app");
const LOG = path.join(WORK, "data", "claude-requests.jsonl");
const CAHIER = "/Users/mboryczka/Downloads/Cahier Matthew.txt";

const { sliceIntoBlocks } = await import(path.join(APP, "api", "parse-cahier.js"));
const { RAW } = await import(path.join(APP, "src", "data", "cards.js"));
const { HANDWRITTEN } = await import("./handwritten-cards.mjs");

const blocks = sliceIntoBlocks(fs.readFileSync(CAHIER, "utf8"));
const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const byText = new Map();
for (const b of blocks) {
  for (const key of [b.text, norm(b.text)]) {
    if (!byText.has(key)) byText.set(key, []);
    if (!byText.get(key).includes(b.date)) byText.get(key).push(b.date);
  }
}
const rawLast = RAW.flatMap((r) => r[3]).sort().at(-1);
console.log(`[claude] ${blocks.length} blocks indexed; RAW last date ${rawLast}; hand-written classes: ${Object.keys(HANDWRITTEN).join(", ")}`);

const CAT = { vocab: "V", expr: "V", gram: "G", pron: "V" };
function cardsFor(date) {
  if (date > rawLast) {
    const hw = HANDWRITTEN[date];
    if (!hw) return { source: "none-after-raw", cards: [] };
    return { source: "handwritten", cards: hw.map(([front, back]) => ({ front, back, category: "V" })) };
  }
  const cards = RAW.filter((r) => r[3].includes(date)).map(([front, back, cat]) => ({ front, back, category: CAT[cat] || "V" }));
  return { source: cards.length ? "raw" : "raw-none", cards };
}

let n = 0;
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const rec = { t: new Date().toISOString(), method: req.method, path: req.url };
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      rec.UNHANDLED = true;
      fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
      console.error(`[claude] !!! unhandled ${req.method} ${req.url}`);
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stand-in" } }));
    }
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const content = body.messages?.[0]?.content;
    const textIn = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text || "").join("") : "";
    const m = textIn.match(/---\n([\s\S]*)\n---\s*$/);
    const blockText = m ? m[1] : "";
    const dates = byText.get(blockText) || byText.get(norm(blockText)) || [];
    let result = { source: "unmatched", cards: [] };
    if (dates.length === 1) result = cardsFor(dates[0]);
    else if (dates.length > 1) {
      const seen = new Set();
      const all = [];
      for (const d of dates) for (const c of cardsFor(d).cards) if (!seen.has(c.front)) { seen.add(c.front); all.push(c); }
      result = { source: "multi-date", cards: all };
    }
    n++;
    Object.assign(rec, {
      model: body.model, max_tokens: body.max_tokens, hasSystem: !!body.system, systemChars: (body.system || "").length,
      apiKeyHeader: String(req.headers["x-api-key"] || "").slice(0, 16) + "…",
      blockChars: blockText.length, dates, source: result.source, cardsReturned: result.cards.length,
      fronts: result.cards.map((c) => c.front),
    });
    fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
    res.writeHead(200, { "content-type": "application/json", "request-id": `req_standin_${n}` });
    res.end(JSON.stringify({
      id: `msg_standin_${n}`, type: "message", role: "assistant", model: body.model || "claude-haiku-4-5",
      content: [{ type: "text", text: JSON.stringify(result.cards) }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: Math.ceil(textIn.length / 4), output_tokens: Math.ceil(JSON.stringify(result.cards).length / 4) },
    }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[claude] stand-in listening on http://127.0.0.1:${PORT}`));
