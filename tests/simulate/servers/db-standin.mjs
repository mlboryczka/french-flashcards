// Stateful stand-in for the Supabase project the app talks to: the subset of
// PostgREST (/rest/v1) and GoTrue (/auth/v1) that supabase-js v2, the app and
// the /api functions actually use. In memory, persisted to disk after writes so
// a restart loses nothing. Every request is logged as JSONL.
//
// Fidelity choices (all modelled on the real schema in supabase/schema.sql and
// migrations/):
//   - NOT NULL, CHECK, UNIQUE, PK and FK constraints are enforced, and a write
//     that violates one fails as a whole (one statement = one transaction).
//   - `real` columns are stored as float4 and printed the way Postgres prints
//     float4 (shortest round-trip), because that is what the app reads back.
//   - timestamptz is printed as PostgREST does ("...+00:00").
//   - Row-level security: a request carrying a user's JWT sees and writes only
//     that user's rows; the service key (Bearer stand-in) bypasses RLS.
//   - Defaults such as now() use this server's real clock (the browser's clock
//     is simulated); the log says so wherever that ends up in a row.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.DB_PORT || 5991);
const WORK = process.env.WORK;
if (!WORK) throw new Error("WORK env var required");
const DATA = path.join(WORK, "data");
const LOG = path.join(DATA, "db-requests.jsonl");
const STATE = path.join(DATA, "db-state.json");
const MAGIC_LOG = path.join(DATA, "magic-links.jsonl");
const SERVICE_KEY = "stand-in";
const JWT_SECRET = "fsrs-test-local-secret";
const SESSION_SECONDS = 10 * 365 * 24 * 3600; // long-lived: the browser clock jumps weeks

fs.mkdirSync(path.join(DATA, "snapshots"), { recursive: true });

// ─── Schema ───────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const C = (type, o = {}) => ({ type, ...o });
const SCHEMA = {
  user_cards: {
    pk: ["id"],
    unique: [["user_id", "front"]],
    fks: [{ col: "batch_id", table: "upload_batches", ref: "id", onDelete: "set null" }],
    cols: {
      id: C("bigint", { identity: true, notNull: true }),
      user_id: C("uuid", { notNull: true }),
      front: C("text", { notNull: true }),
      back: C("text", { notNull: true }),
      category: C("text", { notNull: true, def: () => "V" }),
      dates: C("jsonb", { notNull: true, def: () => [] }),
      source: C("text"),
      flagged_for_review: C("bool", { notNull: true, def: () => false }),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
      batch_id: C("uuid"),
      box: C("smallint", { notNull: true, def: () => 1, check: (v) => v >= 1 && v <= 5, checkName: "user_cards_box_check" }),
      next_due_at: C("timestamptz", { notNull: true, def: nowIso }),
      lapses: C("int", { notNull: true, def: () => 0 }),
      stability: C("real"),
      difficulty: C("real"),
      fsrs_state: C("smallint", { notNull: true, def: () => 0, check: (v) => v >= 0 && v <= 3, checkName: "user_cards_fsrs_state_check" }),
      reps: C("int", { notNull: true, def: () => 0 }),
      last_review: C("timestamptz"),
      last_answer_correct: C("bool"),
      en_stability: C("real"),
      en_difficulty: C("real"),
      en_fsrs_state: C("smallint", { notNull: true, def: () => 0, check: (v) => v >= 0 && v <= 3, checkName: "user_cards_en_fsrs_state_check" }),
      en_reps: C("int", { notNull: true, def: () => 0 }),
      en_lapses: C("int", { notNull: true, def: () => 0 }),
      en_next_due_at: C("timestamptz"),
      en_last_review: C("timestamptz"),
      en_last_answer_correct: C("bool"),
    },
    rls: { select: "own", insert: "own", update: "own", delete: "own" },
  },
  card_reviews: {
    pk: ["id"],
    fks: [{ col: "card_id", table: "user_cards", ref: "id", onDelete: "cascade" }],
    cols: {
      id: C("uuid", { notNull: true }),
      user_id: C("uuid", { notNull: true }),
      card_id: C("bigint", { notNull: true }),
      direction: C("text", { notNull: true, check: (v) => v === "fr" || v === "en", checkName: "card_reviews_direction_check" }),
      answered_at: C("timestamptz", { notNull: true }),
      correct: C("bool", { notNull: true }),
      counted: C("bool", { notNull: true }),
      rating: C("smallint", { check: (v) => v >= 1 && v <= 4, checkName: "card_reviews_rating_check" }),
      state_before: C("smallint"),
      stability_before: C("real"),
      difficulty_before: C("real"),
      last_review_before: C("timestamptz"),
      stability_after: C("real"),
      difficulty_after: C("real"),
      due_after: C("timestamptz"),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
    },
    rls: { select: "own", insert: "own", update: "own", delete: "none" },
  },
  card_progress: {
    pk: ["user_id", "card_id"],
    cols: {
      user_id: C("uuid", { notNull: true }),
      card_id: C("text", { notNull: true }),
      score: C("int", { notNull: true, def: () => 0 }),
      seen: C("int", { notNull: true, def: () => 0 }),
      got: C("int", { notNull: true, def: () => 0 }),
      updated_at: C("timestamptz", { notNull: true, def: nowIso }),
    },
    rls: { select: "own", insert: "own", update: "own", delete: "own" },
  },
  user_review_dates: {
    pk: ["user_id", "review_date"],
    cols: {
      user_id: C("uuid", { notNull: true }),
      review_date: C("date", { notNull: true }),
    },
    rls: { select: "own", insert: "own", update: "none", delete: "own" },
  },
  card_alternates: {
    pk: ["id"],
    unique: [["user_id", "card_id", "direction", "alternate_text"]],
    cols: {
      id: C("uuid", { notNull: true, def: uuid }),
      user_id: C("uuid", { notNull: true }),
      card_id: C("text", { notNull: true }),
      direction: C("text", { notNull: true }),
      alternate_text: C("text", { notNull: true }),
      source_feedback_id: C("uuid"),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
    },
    rls: { select: "own", insert: "own", update: "own", delete: "own" },
  },
  cahier_links: {
    pk: ["user_id"],
    cols: {
      user_id: C("uuid", { notNull: true }),
      doc_id: C("text", { notNull: true }),
      doc_url: C("text", { notNull: true }),
      linked_at: C("timestamptz", { notNull: true, def: nowIso }),
      last_checked_at: C("timestamptz"),
      last_synced_at: C("timestamptz"),
      last_error: C("text"),
      classes: C("jsonb", { notNull: true, def: () => ({}) }),
      last_result: C("jsonb"),
    },
    rls: { select: "own", insert: "own", update: "own", delete: "own" },
  },
  beta_feedback: {
    pk: ["id"],
    cols: {
      id: C("uuid", { notNull: true, def: uuid }),
      user_id: C("uuid"),
      user_email: C("text"),
      message: C("text", { notNull: true }),
      page: C("text"),
      user_agent: C("text"),
      screenshot: C("text"),
      card_context: C("jsonb"),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
      resolved_at: C("timestamptz"),
      resolution: C("text"),
    },
    rls: { select: "own", insert: "authenticated", update: "none", delete: "none" },
  },
  feedback_submissions: {
    pk: ["id"],
    cols: {
      id: C("uuid", { notNull: true, def: uuid }),
      user_id: C("uuid", { notNull: true }),
      user_email: C("text", { notNull: true }),
      card_id: C("text", { notNull: true }),
      card_front: C("text", { notNull: true }),
      card_back: C("text", { notNull: true }),
      direction: C("text", { notNull: true }),
      user_answer: C("text", { notNull: true }),
      llm_verdict: C("text"),
      llm_reasoning: C("text"),
      status: C("text", { notNull: true, def: () => "pending" }),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
      reviewed_at: C("timestamptz"),
    },
    rls: { select: "own", insert: "own", update: "none", delete: "none" },
  },
  upload_batches: {
    pk: ["id"],
    cols: {
      id: C("uuid", { notNull: true, def: uuid }),
      user_id: C("uuid", { notNull: true }),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
      source: C("text"),
      input_chars: C("int"),
      cards_parsed: C("int", { notNull: true, def: () => 0 }),
      cards_accepted: C("int"),
      cards_edited_post_parse: C("int", { notNull: true, def: () => 0 }),
      few_shot_correction_ids: C("uuid[]", { notNull: true, def: () => [] }),
      model: C("text"),
      notes: C("text"),
    },
    rls: { select: "own", insert: "none", update: "none", delete: "none" },
  },
  parse_corrections: {
    pk: ["id"],
    cols: {
      id: C("uuid", { notNull: true, def: uuid }),
      created_at: C("timestamptz", { notNull: true, def: nowIso }),
      batch_id: C("uuid"),
      user_id: C("uuid"),
      card_id: C("bigint"),
      category: C("text", { notNull: true }),
      action: C("text"),
      original_front: C("text"),
      original_back: C("text"),
      corrected_front: C("text"),
      corrected_back: C("text"),
      notes: C("text"),
      used_in_few_shot: C("bool", { notNull: true, def: () => false }),
      promoted_to_rule: C("bool", { notNull: true, def: () => false }),
    },
    rls: { select: "none", insert: "none", update: "none", delete: "none" },
  },
};

// ─── State ────────────────────────────────────────────────────────────────
let db = { tables: {}, seq: {}, users: [], sessions: {}, refresh: {}, magic: [], logSeq: 0 };
for (const t of Object.keys(SCHEMA)) db.tables[t] = [];
if (fs.existsSync(STATE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE, "utf8"));
    db = { ...db, ...loaded, tables: { ...db.tables, ...loaded.tables } };
    console.log(`[db] state loaded: ${Object.entries(db.tables).map(([k, v]) => `${k}=${v.length}`).join(" ")}`);
  } catch (e) {
    console.error("[db] could not load state:", e.message);
  }
}
let dirty = false;
function saveState() {
  if (!dirty) return;
  dirty = false;
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, STATE);
}
setInterval(saveState, 1000).unref?.();
process.on("SIGINT", () => { dirty = true; saveState(); process.exit(0); });
process.on("SIGTERM", () => { dirty = true; saveState(); process.exit(0); });

// ─── Type handling ────────────────────────────────────────────────────────
class PgError extends Error {
  constructor(status, body) { super(body.message); this.status = status; this.body = body; }
}
const pgErr = (status, code, message, details = null, hint = null) => new PgError(status, { code, details, hint, message });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function float4Out(f) {
  if (f == null || !Number.isFinite(f)) return f;
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return s;
  }
  return f;
}
function tsIn(v, col) {
  if (v == null) return null;
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) throw pgErr(400, "22007", `invalid input syntax for type timestamp with time zone: "${v}"`);
  return new Date(ms).toISOString();
}
function tsOut(v) {
  if (v == null) return v;
  const iso = new Date(v).toISOString(); // 2026-09-25T22:00:00.120Z
  let [main, frac] = iso.slice(0, -1).split(".");
  frac = (frac || "").replace(/0+$/, "");
  return `${main}${frac ? "." + frac : ""}+00:00`;
}
function coerceIn(table, col, v) {
  const spec = SCHEMA[table].cols[col];
  if (v === undefined) return undefined;
  if (v === null) return null;
  switch (spec.type) {
    case "bigint": case "int": case "smallint": {
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isInteger(n)) throw pgErr(400, "22P02", `invalid input syntax for type ${spec.type === "int" ? "integer" : spec.type}: "${v}"`);
      if (spec.type === "smallint" && (n < -32768 || n > 32767)) throw pgErr(400, "22003", "smallint out of range");
      return n;
    }
    case "real": {
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || Number.isNaN(n)) throw pgErr(400, "22P02", `invalid input syntax for type real: "${v}"`);
      return Math.fround(n);
    }
    case "bool":
      if (typeof v !== "boolean") throw pgErr(400, "22P02", `invalid input syntax for type boolean: "${v}"`);
      return v;
    case "uuid":
      if (typeof v !== "string" || !UUID_RE.test(v)) throw pgErr(400, "22P02", `invalid input syntax for type uuid: "${v}"`);
      return v.toLowerCase();
    case "timestamptz": return tsIn(v, col);
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw pgErr(400, "22007", `invalid input syntax for type date: "${v}"`);
      return v.slice(0, 10);
    }
    case "jsonb": return JSON.parse(JSON.stringify(v));
    case "uuid[]":
      if (!Array.isArray(v)) throw pgErr(400, "22P02", `malformed array literal: "${v}"`);
      return v;
    default: return typeof v === "string" ? v : String(v);
  }
}
function outVal(table, col, v) {
  const spec = SCHEMA[table].cols[col];
  if (v == null) return v ?? null;
  if (spec.type === "real") return float4Out(v);
  if (spec.type === "timestamptz") return tsOut(v);
  return v;
}

// ─── Auth ─────────────────────────────────────────────────────────────────
const b64u = (s) => Buffer.from(s).toString("base64url");
function signJwt(payload) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
function verifyJwt(tok) {
  const parts = String(tok || "").split(".");
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (sig !== parts[2]) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch { return null; }
}
function userJson(u) {
  return {
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    email_confirmed_at: u.confirmed_at, phone: "", confirmed_at: u.confirmed_at,
    last_sign_in_at: u.last_sign_in_at || u.confirmed_at,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
    identities: [], created_at: u.created_at, updated_at: u.updated_at || u.created_at, is_anonymous: false,
  };
}
function newSession(u) {
  const iat = Math.floor(Date.now() / 1000);
  const session_id = uuid();
  const access_token = signJwt({
    aud: "authenticated", exp: iat + SESSION_SECONDS, iat, iss: `http://127.0.0.1:${PORT}/auth/v1`,
    sub: u.id, email: u.email, phone: "", app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {}, role: "authenticated", aal: "aal1", amr: [{ method: "otp", timestamp: iat }],
    session_id, is_anonymous: false,
  });
  const refresh_token = crypto.randomBytes(12).toString("base64url");
  db.refresh[refresh_token] = u.id;
  dirty = true;
  return { access_token, refresh_token, token_type: "bearer", expires_in: SESSION_SECONDS, user: userJson(u) };
}
// Who is asking: { role: "service" } | { role: "user", user } | { role: "anon" } | { role: "invalid" }
function whoIs(req) {
  const auth = String(req.headers.authorization || "");
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  if (!tok) return { role: "anon" };
  if (tok === SERVICE_KEY) return { role: "service" };
  const claims = verifyJwt(tok);
  if (!claims) return { role: "invalid" };
  const user = db.users.find((u) => u.id === claims.sub);
  if (!user) return { role: "invalid" };
  return { role: "user", user, claims };
}

// ─── PostgREST: parsing ───────────────────────────────────────────────────
function splitTopLevel(s, sep = ",") {
  const out = []; let depth = 0, cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") q = !q;
    if (!q && ch === "(") depth++;
    if (!q && ch === ")") depth--;
    if (!q && depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}
const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s);

// "eq.5" | "not.in.(1,2)" | "is.null" → predicate on a column value
function parseOp(expr) {
  let neg = false;
  if (expr.startsWith("not.")) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf(".");
  const op = dot < 0 ? expr : expr.slice(0, dot);
  const raw = dot < 0 ? "" : expr.slice(dot + 1);
  return { neg, op, raw };
}
function cmpVal(table, col, v) {
  const t = SCHEMA[table].cols[col]?.type;
  if (v == null) return v;
  if (["bigint", "int", "smallint", "real"].includes(t)) return Number(v);
  if (t === "timestamptz") return new Date(v).getTime();
  if (t === "bool") return v === true || v === "true";
  return String(v);
}
function likeRe(pattern, ci) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, ci ? "is" : "s");
}
function makePred(table, col, expr) {
  if (!SCHEMA[table].cols[col]) throw pgErr(400, "42703", `column ${table}.${col} does not exist`);
  const { neg, op, raw } = parseOp(expr);
  let f;
  const cv = (x) => cmpVal(table, col, x);
  switch (op) {
    case "eq": f = (r) => r[col] != null && cv(r[col]) === cv(unquote(raw)); break;
    case "neq": f = (r) => r[col] != null && cv(r[col]) !== cv(unquote(raw)); break;
    case "gt": f = (r) => r[col] != null && cv(r[col]) > cv(unquote(raw)); break;
    case "gte": f = (r) => r[col] != null && cv(r[col]) >= cv(unquote(raw)); break;
    case "lt": f = (r) => r[col] != null && cv(r[col]) < cv(unquote(raw)); break;
    case "lte": f = (r) => r[col] != null && cv(r[col]) <= cv(unquote(raw)); break;
    case "like": { const re = likeRe(unquote(raw), false); f = (r) => r[col] != null && re.test(String(r[col])); break; }
    case "ilike": { const re = likeRe(unquote(raw), true); f = (r) => r[col] != null && re.test(String(r[col])); break; }
    case "is": {
      const v = raw.toLowerCase();
      f = v === "null" ? (r) => r[col] == null : v === "true" ? (r) => r[col] === true : v === "false" ? (r) => r[col] === false : (() => { throw pgErr(400, "PGRST100", `failed to parse filter (is.${raw})`); })();
      break;
    }
    case "in": {
      const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
      const vals = new Set(splitTopLevel(inner).map((x) => cv(unquote(x.trim()))));
      f = (r) => r[col] != null && vals.has(cv(r[col]));
      break;
    }
    case "cs": { const want = JSON.parse(raw.replace(/^\{(.*)\}$/, "[$1]")); f = (r) => Array.isArray(r[col]) && want.every((w) => r[col].includes(w)); break; }
    case "cd": { const want = JSON.parse(raw.replace(/^\{(.*)\}$/, "[$1]")); f = (r) => Array.isArray(r[col]) && r[col].every((w) => want.includes(w)); break; }
    default: throw pgErr(400, "PGRST100", `unsupported filter operator "${op}" (stand-in)`);
  }
  // Postgres three-valued logic: NOT of an unknown (null) comparison is still not true.
  return neg ? (r) => (r[col] == null && op !== "is" ? false : !f(r)) : f;
}
function parseLogic(table, text, isAnd) {
  // text is "(a.eq.1,b.gt.2,and(c.eq.3,d.eq.4))"
  const inner = text.replace(/^\(/, "").replace(/\)$/, "");
  const parts = splitTopLevel(inner).map((p) => p.trim());
  const preds = parts.map((p) => {
    let m;
    if ((m = p.match(/^(not\.)?(and|or)(\(.*\))$/))) {
      const sub = parseLogic(table, m[3], m[2] === "and");
      return m[1] ? (r) => !sub(r) : sub;
    }
    const dot = p.indexOf(".");
    return makePred(table, p.slice(0, dot), p.slice(dot + 1));
  });
  return isAnd ? (r) => preds.every((f) => f(r)) : (r) => preds.some((f) => f(r));
}
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function parseFilters(table, params) {
  const preds = [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    if (k === "or" || k === "and") { preds.push(parseLogic(table, v, k === "and")); continue; }
    if (k === "not.or" || k === "not.and") { const f = parseLogic(table, v, k === "not.and"); preds.push((r) => !f(r)); continue; }
    preds.push(makePred(table, k, v));
  }
  return (r) => preds.every((f) => f(r));
}
function parseSelect(table, sel) {
  if (!sel || sel === "*") return Object.keys(SCHEMA[table].cols).map((c) => ({ col: c, as: c }));
  const out = [];
  for (let item of splitTopLevel(sel.replace(/\s+/g, ""))) {
    if (!item) continue;
    if (item === "*") { out.push(...Object.keys(SCHEMA[table].cols).map((c) => ({ col: c, as: c }))); continue; }
    if (item.includes("(")) throw pgErr(400, "PGRST200", `embedded resource not supported by stand-in: ${item}`);
    let as = null;
    if (item.includes(":")) [as, item] = item.split(":");
    item = item.replace(/::.*$/, "");
    if (!SCHEMA[table].cols[item]) throw pgErr(400, "42703", `column ${table}.${item} does not exist`);
    out.push({ col: item, as: as || item });
  }
  return out;
}
function shapeRow(table, r, sel) {
  const o = {};
  for (const { col, as } of sel) o[as] = outVal(table, col, r[col]);
  return o;
}
function applyOrder(table, rows, order) {
  if (!order) return rows;
  const keys = splitTopLevel(order).map((k) => {
    const [col, ...mods] = k.trim().split(".");
    if (!SCHEMA[table].cols[col]) throw pgErr(400, "42703", `column ${table}.${col} does not exist`);
    const desc = mods.includes("desc");
    const nullsFirst = mods.includes("nullsfirst") ? true : mods.includes("nullslast") ? false : desc; // PG default: NULLS LAST for ASC, FIRST for DESC
    return { col, desc, nullsFirst };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc, nullsFirst } of keys) {
      const va = cmpVal(table, col, a[col]), vb = cmpVal(table, col, b[col]);
      if (va == null && vb == null) continue;
      if (va == null) return nullsFirst ? -1 : 1;
      if (vb == null) return nullsFirst ? 1 : -1;
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
    }
    return 0;
  });
}

// ─── PostgREST: RLS ───────────────────────────────────────────────────────
function visible(table, who, action) {
  if (who.role === "service") return () => true;
  if (who.role !== "user") return () => false;
  const pol = SCHEMA[table].rls?.[action] || "none";
  if (pol === "own") return (r) => r.user_id === who.user.id;
  if (pol === "authenticated") return () => true;
  return () => false;
}
function checkInsertRls(table, who, row) {
  if (who.role === "service") return;
  const pol = SCHEMA[table].rls?.insert || "none";
  if (who.role === "user" && (pol === "authenticated" || (pol === "own" && row.user_id === who.user.id))) return;
  throw pgErr(403, "42501", `new row violates row-level security policy for table "${table}"`);
}

// ─── PostgREST: constraint checks ─────────────────────────────────────────
function checkRow(table, row) {
  for (const [col, spec] of Object.entries(SCHEMA[table].cols)) {
    const v = row[col];
    if (spec.notNull && v == null) {
      throw pgErr(400, "23502", `null value in column "${col}" of relation "${table}" violates not-null constraint`, `Failing row contains (${Object.values(row).map((x) => (x == null ? "null" : typeof x === "object" ? JSON.stringify(x) : x)).join(", ").slice(0, 300)}).`);
    }
    if (spec.check && v != null && !spec.check(v)) {
      throw pgErr(400, "23514", `new row for relation "${table}" violates check constraint "${spec.checkName}"`);
    }
  }
}
function keyOf(row, cols) { return JSON.stringify(cols.map((c) => row[c])); }
function checkUniques(table, rows) {
  const s = SCHEMA[table];
  for (const cols of [s.pk, ...(s.unique || [])]) {
    const seen = new Map();
    for (const r of rows) {
      if (cols.some((c) => r[c] == null)) continue;
      const k = keyOf(r, cols);
      if (seen.has(k)) throw pgErr(409, "23505", `duplicate key value violates unique constraint "${table}_${cols.join("_")}_key"`, `Key (${cols.join(", ")})=(${cols.map((c) => r[c]).join(", ")}) already exists.`);
      seen.set(k, r);
    }
  }
}
function checkFks(table, rows, tables) {
  for (const fk of SCHEMA[table].fks || []) {
    const refIds = new Set(tables[fk.table].map((r) => String(r[fk.ref])));
    for (const r of rows) {
      if (r[fk.col] == null) continue;
      if (!refIds.has(String(r[fk.col]))) {
        throw pgErr(409, "23503", `insert or update on table "${table}" violates foreign key constraint "${table}_${fk.col}_fkey"`, `Key (${fk.col})=(${r[fk.col]}) is not present in table "${fk.table}".`);
      }
    }
  }
}
function cascadeDeletes(table, deletedRows, tables) {
  for (const [t, s] of Object.entries(SCHEMA)) {
    for (const fk of s.fks || []) {
      if (fk.table !== table) continue;
      const ids = new Set(deletedRows.map((r) => String(r[fk.ref])));
      if (fk.onDelete === "cascade") {
        const gone = tables[t].filter((r) => ids.has(String(r[fk.col])));
        if (gone.length) {
          tables[t] = tables[t].filter((r) => !ids.has(String(r[fk.col])));
          cascadeDeletes(t, gone, tables);
        }
      } else if (fk.onDelete === "set null") {
        for (const r of tables[t]) if (ids.has(String(r[fk.col]))) r[fk.col] = null;
      }
    }
  }
}

// ─── PostgREST: handlers ──────────────────────────────────────────────────
function parsePrefer(req) {
  const out = {};
  for (const part of String(req.headers.prefer || "").split(",")) {
    const [k, v] = part.trim().split("=");
    if (k) out[k] = v ?? true;
  }
  return out;
}
function sendRows(res, table, req, rows, sel, status, extraHeaders = {}) {
  const wantsObject = String(req.headers.accept || "").includes("application/vnd.pgrst.object+json");
  const shaped = rows.map((r) => shapeRow(table, r, sel));
  if (wantsObject) {
    if (shaped.length !== 1) {
      const body = { code: "PGRST116", details: `The result contains ${shaped.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" };
      return { status: 406, body };
    }
    return { status, body: shaped[0], headers: extraHeaders };
  }
  return { status, body: shaped, headers: extraHeaders };
}

function restGet(req, table, params, who) {
  const pred = parseFilters(table, params);
  const sel = parseSelect(table, params.get("select"));
  let rows = db.tables[table].filter(visible(table, who, "select")).filter(pred);
  rows = applyOrder(table, rows, params.get("order"));
  const total = rows.length;
  let offset = Number(params.get("offset") || 0);
  let limit = params.has("limit") ? Number(params.get("limit")) : Infinity;
  const range = String(req.headers.range || "");
  const rm = range.match(/^(\d+)-(\d*)$/);
  if (rm) { offset = Number(rm[1]); if (rm[2] !== "") limit = Number(rm[2]) - offset + 1; }
  rows = rows.slice(offset, offset + limit);
  const prefer = parsePrefer(req);
  const totalStr = prefer.count ? String(total) : "*";
  const cr = rows.length ? `${offset}-${offset + rows.length - 1}/${totalStr}` : `*/${totalStr}`;
  const out = sendRows(req.__res, table, req, rows, sel, 200, { "Content-Range": cr });
  out.rowCount = rows.length;
  return out;
}

function buildInsertRow(table, input, providedCols) {
  const spec = SCHEMA[table];
  const row = {};
  for (const col of Object.keys(input)) {
    if (!spec.cols[col]) throw pgErr(400, "PGRST204", `Could not find the '${col}' column of '${table}' in the schema cache`);
  }
  for (const [col, cs] of Object.entries(spec.cols)) {
    if (providedCols.has(col)) {
      const v = input[col];
      row[col] = v === undefined ? null : coerceIn(table, col, v); // defaultToNull: a listed column missing from this object is NULL
    } else if (cs.identity) {
      row[col] = null; // filled when actually inserted
    } else if (cs.def) {
      row[col] = cs.def();
    } else {
      row[col] = null;
    }
  }
  return row;
}

function restPost(req, table, params, who, body) {
  const spec = SCHEMA[table];
  const prefer = parsePrefer(req);
  const list = Array.isArray(body) ? body : [body];
  if (!list.every((x) => x && typeof x === "object")) throw pgErr(400, "PGRST102", "Empty or invalid json");
  const colsParam = params.get("columns");
  const missingDefault = prefer.missing === "default";
  const resolution = prefer.resolution; // merge-duplicates | ignore-duplicates | undefined
  const conflictCols = params.get("on_conflict") ? params.get("on_conflict").split(",").map((s) => s.trim()) : spec.pk;
  for (const c of conflictCols) if (!spec.cols[c]) throw pgErr(400, "42703", `column ${c} does not exist`);
  // Work on a copy; commit only if the whole statement succeeds.
  const tables = { ...db.tables };
  tables[table] = db.tables[table].map((r) => ({ ...r }));
  let seq = db.seq[table] || 0;
  const written = [];
  const touchedKeys = new Set();
  for (const input of list) {
    let provided;
    if (colsParam) provided = new Set(colsParam.split(",").map((c) => unquote(c.trim())));
    else provided = new Set(Object.keys(input));
    if (missingDefault) provided = new Set([...provided].filter((c) => c in input));
    const row = buildInsertRow(table, input, provided);
    checkInsertRls(table, who, row);
    // Identity column: assign now (a conflicting row keeps its own id).
    const idCol = Object.entries(spec.cols).find(([, cs]) => cs.identity)?.[0];
    const proposed = { ...row };
    if (idCol && proposed[idCol] == null) proposed[idCol] = seq + 1; // tentative, for checks
    checkRow(table, proposed);
    const ck = keyOf(row, conflictCols);
    const existing = resolution && !conflictCols.some((c) => row[c] == null)
      ? tables[table].find((r) => keyOf(r, conflictCols) === ck)
      : null;
    if (existing) {
      // DO NOTHING skips a second row with the same key; DO UPDATE refuses the whole statement.
      if (touchedKeys.has(ck) && resolution === "ignore-duplicates") continue;
      if (touchedKeys.has(ck)) throw pgErr(500, "21000", "ON CONFLICT DO UPDATE command cannot affect row a second time", null, "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.");
      touchedKeys.add(ck);
      if (resolution === "ignore-duplicates") continue;
      // merge-duplicates: UPDATE SET <provided cols> = EXCLUDED.<col>
      if (who.role === "user") {
        const pol = spec.rls?.update || "none";
        if (!(pol === "own" && existing.user_id === who.user.id)) throw pgErr(403, "42501", `new row violates row-level security policy (USING expression) for table "${table}"`);
      }
      for (const col of provided) if (col !== idCol || row[col] != null) existing[col] = row[col];
      checkRow(table, existing);
      written.push(existing);
    } else {
      if (touchedKeys.has(ck)) {
        if (resolution === "ignore-duplicates") continue;
        if (resolution === "merge-duplicates") throw pgErr(500, "21000", "ON CONFLICT DO UPDATE command cannot affect row a second time", null, "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.");
      }
      touchedKeys.add(ck);
      if (idCol && row[idCol] == null) row[idCol] = ++seq;
      tables[table].push(row);
      written.push(row);
    }
  }
  checkUniques(table, tables[table]);
  checkFks(table, tables[table], tables);
  db.tables = tables;
  db.seq[table] = seq;
  dirty = true;
  const headers = {};
  if (prefer.count) headers["Content-Range"] = `*/${written.length}`;
  const out = prefer.return === "representation"
    ? sendRows(null, table, req, written, parseSelect(table, params.get("select")), 201, headers)
    : { status: 201, body: null, headers };
  out.affected = written.map((r) => r[spec.pk[0]]);
  return out;
}

function restPatch(req, table, params, who, body) {
  const spec = SCHEMA[table];
  const prefer = parsePrefer(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw pgErr(400, "PGRST102", "Empty or invalid json");
  for (const col of Object.keys(body)) if (!spec.cols[col]) throw pgErr(400, "PGRST204", `Could not find the '${col}' column of '${table}' in the schema cache`);
  const pred = parseFilters(table, params);
  const vis = visible(table, who, "update");
  const tables = { ...db.tables };
  tables[table] = db.tables[table].map((r) => ({ ...r }));
  const hit = tables[table].filter((r) => vis(r) && pred(r));
  const patch = {};
  for (const [k, v] of Object.entries(body)) patch[k] = coerceIn(table, k, v);
  for (const r of hit) {
    Object.assign(r, patch);
    if (who.role === "user" && spec.rls?.update === "own" && r.user_id !== who.user.id) throw pgErr(403, "42501", `new row violates row-level security policy for table "${table}"`);
    checkRow(table, r);
  }
  checkUniques(table, tables[table]);
  checkFks(table, tables[table], tables);
  db.tables = tables;
  dirty = true;
  const headers = prefer.count ? { "Content-Range": `0-${Math.max(0, hit.length - 1)}/${hit.length}` } : {};
  const out = prefer.return === "representation"
    ? sendRows(null, table, req, hit, parseSelect(table, params.get("select")), 200, headers)
    : { status: 204, body: null, headers };
  out.affected = hit.map((r) => r[spec.pk[0]]);
  return out;
}

function restDelete(req, table, params, who) {
  const spec = SCHEMA[table];
  const prefer = parsePrefer(req);
  const pred = parseFilters(table, params);
  const vis = visible(table, who, "delete");
  const tables = { ...db.tables };
  for (const t of Object.keys(tables)) tables[t] = db.tables[t].map((r) => ({ ...r }));
  const gone = tables[table].filter((r) => vis(r) && pred(r));
  const goneSet = new Set(gone);
  tables[table] = tables[table].filter((r) => !goneSet.has(r));
  cascadeDeletes(table, gone, tables);
  db.tables = tables;
  dirty = true;
  const headers = prefer.count ? { "Content-Range": `*/${gone.length}` } : {};
  const out = prefer.return === "representation"
    ? sendRows(null, table, req, gone, parseSelect(table, params.get("select")), 200, headers)
    : { status: 204, body: null, headers };
  out.affected = gone.map((r) => r[spec.pk[0]]);
  return out;
}

// ─── HTTP plumbing ────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD",
  "Access-Control-Expose-Headers": "Content-Range, Content-Location, X-Total-Count, Location",
  "Access-Control-Max-Age": "600",
};
function logLine(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
}
let inflight = 0;

function authRoute(req, res, url, body) {
  const p = url.pathname.replace(/^\/auth\/v1/, "");
  const q = url.searchParams;
  if (p === "/otp" && req.method === "POST") {
    const email = String(body?.email || "").trim().toLowerCase();
    if (!email) return { status: 400, body: { code: 400, error_code: "validation_failed", msg: "missing email" } };
    let u = db.users.find((x) => x.email === email);
    let created = false;
    if (!u) {
      if (body?.create_user === false) return { status: 422, body: { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" } };
      u = { id: uuid(), email, created_at: nowIso(), confirmed_at: null };
      db.users.push(u);
      created = true;
    }
    const token = crypto.randomBytes(16).toString("hex");
    const redirectTo = q.get("redirect_to") || "http://127.0.0.1:5190";
    const link = `http://127.0.0.1:${PORT}/auth/v1/verify?token=${token}&type=magiclink&redirect_to=${encodeURIComponent(redirectTo)}`;
    const entry = { at: nowIso(), email, user_id: u.id, created, token, redirect_to: redirectTo, link, used: false };
    db.magic.push(entry);
    dirty = true;
    fs.appendFileSync(MAGIC_LOG, JSON.stringify(entry) + "\n");
    console.log(`[db] MAGIC LINK for ${email}: ${link}`);
    return { status: 200, body: {} };
  }
  if (p === "/verify" && req.method === "GET") {
    const token = q.get("token");
    const m = db.magic.find((x) => x.token === token);
    if (!m || m.used) {
      const to = (m?.redirect_to || q.get("redirect_to") || "http://127.0.0.1:5190");
      return { status: 303, headers: { Location: `${to}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }, body: null };
    }
    m.used = true;
    const u = db.users.find((x) => x.id === m.user_id);
    u.confirmed_at = u.confirmed_at || nowIso();
    u.last_sign_in_at = nowIso();
    const s = newSession(u);
    // Implicit flow, as GoTrue redirects after verifying a magic link — minus expires_at (see header).
    const frag = `access_token=${s.access_token}&expires_in=${s.expires_in}&refresh_token=${s.refresh_token}&token_type=bearer&type=magiclink`;
    const location = `${m.redirect_to}#${frag}`;
    m.redirected_to = location;
    fs.appendFileSync(MAGIC_LOG, JSON.stringify({ at: nowIso(), verified: m.email, location }) + "\n");
    return { status: 303, headers: { Location: location }, body: null };
  }
  if (p === "/user" && req.method === "GET") {
    const who = whoIs(req);
    if (who.role !== "user") return { status: 403, body: { code: 403, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature" } };
    return { status: 200, body: userJson(who.user) };
  }
  if (p === "/token" && req.method === "POST") {
    const grant = q.get("grant_type");
    if (grant === "refresh_token") {
      const uid = db.refresh[body?.refresh_token];
      const u = uid && db.users.find((x) => x.id === uid);
      if (!u) return { status: 400, body: { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" } };
      return { status: 200, body: newSession(u) };
    }
    return { status: 400, body: { code: 400, error_code: "unsupported_grant_type", msg: `grant_type ${grant} not supported by stand-in` } };
  }
  if (p === "/logout" && req.method === "POST") return { status: 204, body: null };
  if (p === "/settings" && req.method === "GET") {
    return { status: 200, body: { external: { email: true }, disable_signup: false, mailer_autoconfirm: false, phone_autoconfirm: false, sms_provider: "", saml_enabled: false } };
  }
  return { status: 404, body: { code: 404, error_code: "not_found", msg: `stand-in: unknown auth route ${req.method} ${p}` }, unknown: true };
}

function restRoute(req, url, body) {
  const table = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]);
  if (!SCHEMA[table]) {
    return { status: 404, body: { code: "42P01", details: null, hint: null, message: `relation "public.${table}" does not exist` }, unknown: true };
  }
  const who = whoIs(req);
  if (who.role === "invalid") return { status: 401, body: { code: "PGRST301", details: null, hint: null, message: "JWT invalid" } };
  const params = url.searchParams;
  switch (req.method) {
    case "GET": case "HEAD": return restGet(req, table, params, who);
    case "POST": return restPost(req, table, params, who, body);
    case "PATCH": return restPatch(req, table, params, who, body);
    case "DELETE": return restDelete(req, table, params, who);
    default: return { status: 405, body: { message: "method not allowed" } };
  }
}

function debugRoute(req, url, body) {
  const p = url.pathname;
  if (p === "/__health") return { status: 200, body: { ok: true, logSeq: db.logSeq } };
  if (p === "/__dump") return { status: 200, body: { tables: db.tables, seq: db.seq, users: db.users, magic: db.magic, logSeq: db.logSeq } };
  if (p === "/__seq") return { status: 200, body: { logSeq: db.logSeq, inflight } };
  if (p === "/__magic") return { status: 200, body: db.magic };
  if (p === "/__users") return { status: 200, body: db.users };
  let m;
  if ((m = p.match(/^\/__table\/(\w+)$/))) {
    const rows = db.tables[m[1]] || [];
    const from = Number(url.searchParams.get("from") || 0);
    return { status: 200, body: rows.slice(from) };
  }
  if ((m = p.match(/^\/__count\/(\w+)$/))) return { status: 200, body: { count: (db.tables[m[1]] || []).length } };
  if ((m = p.match(/^\/__snapshot\/([\w.:-]+)$/)) && req.method === "POST") {
    const file = path.join(DATA, "snapshots", `${m[1]}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: nowIso(), logSeq: db.logSeq, meta: body || null, user_cards: db.tables.user_cards, card_reviews_count: db.tables.card_reviews.length }));
    return { status: 200, body: { ok: true, file } };
  }
  if (p === "/__save" && req.method === "POST") { dirty = true; saveState(); return { status: 200, body: { ok: true } }; }
  return { status: 404, body: { error: "unknown debug route" } };
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  inflight++;
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let body = null;
    let parseError = null;
    if (raw) { try { body = JSON.parse(raw); } catch (e) { parseError = e.message; } }
    let out;
    const isDebug = url.pathname.startsWith("/__");
    try {
      if (req.method === "OPTIONS") out = { status: 204, body: null };
      else if (parseError) out = { status: 400, body: { code: "PGRST102", message: `Empty or invalid json: ${parseError}` } };
      else if (isDebug) out = debugRoute(req, url, body);
      else if (url.pathname.startsWith("/auth/v1/")) out = authRoute(req, res, url, body);
      else if (url.pathname.startsWith("/rest/v1/")) { req.__res = res; out = restRoute(req, url, body); }
      else out = { status: 404, body: { message: `stand-in: unknown route ${url.pathname}` }, unknown: true };
    } catch (e) {
      if (e instanceof PgError) out = { status: e.status, body: e.body };
      else { console.error("[db] internal error", e); out = { status: 500, body: { code: "XX000", message: `stand-in internal error: ${e.message}` } }; }
    }
    const headers = { ...CORS, ...(out.headers || {}) };
    let payload = "";
    if (out.body !== null && out.body !== undefined && req.method !== "HEAD") {
      payload = JSON.stringify(out.body);
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    res.writeHead(out.status, headers);
    res.end(payload);
    inflight--;
    if (!isDebug && req.method !== "OPTIONS") {
      db.logSeq++;
      const who = whoIs(req);
      const entry = {
        seq: db.logSeq, t: new Date(started).toISOString(), ms: Date.now() - started,
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        prefer: req.headers.prefer || undefined, accept: req.headers.accept || undefined, range: req.headers.range || undefined,
        role: who.role, uid: who.user?.id, origin: req.headers.origin || undefined,
        body: body ?? (raw ? raw.slice(0, 2000) : undefined),
        status: out.status,
      };
      if (out.rowCount != null) entry.rows = out.rowCount;
      if (out.affected) entry.affected = out.affected;
      if (out.status >= 400) entry.error = out.body;
      if (url.pathname.startsWith("/auth/")) entry.resp = out.status < 400 && out.body ? Object.keys(out.body) : undefined;
      if (out.unknown) { entry.UNKNOWN_ROUTE = true; console.error(`[db] !!! UNKNOWN ROUTE ${req.method} ${url.pathname}${url.search}`); }
      logLine(entry);
      dirty = true;
    }
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`[db] stand-in listening on http://127.0.0.1:${PORT}`));
