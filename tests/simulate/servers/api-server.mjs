// Runs the snapshot's /api functions behind a small Vercel-style wrapper.
// Only the three the upload needs are real; anything else under /api is
// logged loudly and answered harmlessly.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.API_PORT || 5992);
const WORK = process.env.WORK;
const APP = path.join(WORK, "app");
const LOG = path.join(WORK, "data", "api-requests.jsonl");

process.env.SUPABASE_URL = "http://127.0.0.1:5991";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:5993";
// No server-side Anthropic key: students bring their own (x-anthropic-key).
delete process.env.ANTHROPIC_API_KEY;
// Production has the owner's address here; a dummy keeps the student a non-admin.
process.env.ADMIN_EMAIL = "owner@example.invalid";

const HANDLERS = {
  "parse-cahier": () => import(path.join(APP, "api", "parse-cahier.js")),
  "cahier-parse": () => import(path.join(APP, "api", "cahier-parse.js")),
  "upload-batches": () => import(path.join(APP, "api", "upload-batches.js")),
};

const log = (e) => fs.appendFileSync(LOG, JSON.stringify(e) + "\n");

function wrapRes(res, record) {
  const w = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(obj) {
      record.status = this.statusCode;
      record.resp = summarize(obj);
      res.writeHead(this.statusCode, { "Content-Type": "application/json", ...this.headers });
      res.end(JSON.stringify(obj));
      return this;
    },
    send(x) {
      record.status = this.statusCode;
      const isObj = x && typeof x === "object" && !Buffer.isBuffer(x);
      record.resp = isObj ? summarize(x) : String(x).slice(0, 500);
      res.writeHead(this.statusCode, { "Content-Type": isObj ? "application/json" : "text/plain", ...this.headers });
      res.end(isObj ? JSON.stringify(x) : x);
      return this;
    },
    end(x) { record.status = this.statusCode; res.writeHead(this.statusCode, this.headers); res.end(x); return this; },
  };
  return w;
}
function summarize(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out[k] = v.length > 20 ? `[array of ${v.length}]` : v;
    else out[k] = v;
  }
  return out;
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const name = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    const record = { t: new Date().toISOString(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
    let body = raw;
    if ((req.headers["content-type"] || "").includes("application/json") && raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    // What was asked, without the whole cahier in the log line.
    if (body && typeof body === "object") {
      record.body = {};
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) record.body[k] = `[array of ${v.length}]`;
        else if (typeof v === "string" && v.length > 300) record.body[k] = `[string of ${v.length} chars]`;
        else record.body[k] = v;
      }
    }
    record.hasKeyHeader = !!req.headers["x-anthropic-key"];
    const fakeReq = { method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), body, url: req.url };
    const wres = wrapRes(res, record);
    const started = Date.now();
    try {
      if (!HANDLERS[name]) {
        record.UNHANDLED = true;
        console.error(`[api] !!! unhandled route ${req.method} ${url.pathname} — answering harmlessly`);
        const harmless = name === "cahier-sync" ? { ok: true, cardsAdded: 0, newClasses: [], remaining: 0, linked: false } : { ok: true, standIn: true };
        wres.status(200).json(harmless);
      } else {
        const mod = await HANDLERS[name]();
        await mod.default(fakeReq, wres);
      }
    } catch (e) {
      console.error("[api] handler threw", e);
      record.threw = String(e?.stack || e);
      if (!res.headersSent) wres.status(500).json({ error: String(e?.message || e) });
    }
    record.ms = Date.now() - started;
    log(record);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[api] listening on http://127.0.0.1:${PORT}`));
