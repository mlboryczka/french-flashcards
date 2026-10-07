// A stand-in for the Supabase service client, in memory, for suites with no
// browser. It answers the calls the server code makes through supabase-js
// (from(...).select/insert/upsert/update/delete with filters, and rpc) and
// refuses what the live database refuses, because a lenient stand-in has
// twice passed a write that then failed on the live app:
//
//   NOT NULL columns, the deck's one card per French side (23505), a French
//   side too long for that index (54000, as Postgres says it), a column that
//   doesn't exist (42703 on a read, PGRST204 on a write), a table or function
//   that doesn't exist (PGRST205, PGRST202). A statement is all or nothing.
//
// `migrated: false` is the database before migration_016: no notes_read, no
// card_pairs, no archived_reason/archived_at/merged_into on user_cards, and
// neither of its functions. The two functions are written out here from the
// SQL in migrations/migration_016_notes_read_once.sql, statement by statement.
//
// `faults` lets a suite break one call on purpose:
//   faults.rpc = { name, times, error, after }  fail that function `times`
//     times; with `after: true` the work is done and then the reply is lost,
//     as when a function is cut off after the database committed
//   faults.update = { table, times, error }     fail updates to a table

const POST_016_COLUMNS = { user_cards: ["archived_reason", "archived_at", "merged_into"] };
const POST_016_TABLES = ["notes_read", "card_pairs"];
const NOT_NULL = {
  user_cards: ["user_id", "front", "back"],
  cahier_links: ["user_id", "doc_id", "doc_url"],
  notes_read: ["user_id"],
  card_pairs: ["user_id", "verdict"],
};
const UNIQUE = { user_cards: ["user_id", "front"], cahier_links: ["user_id"], notes_read: ["user_id"] };
const DEFAULTS = {
  user_cards: () => ({ category: "V", dates: [], source: null, fsrs_state: 0, en_fsrs_state: 0, created_at: new Date().toISOString() }),
  notes_read: () => ({ classes: {}, run_id: null, run_kind: null, run_started_at: null, run_expires_at: null }),
  card_pairs: () => ({ asked_at: new Date().toISOString() }),
};
const INDEX_LIMIT = 2704;

const clone = (v) => JSON.parse(JSON.stringify(v));
const err = (code, message) => ({ code, message });

export function fakeSupabase({ tables = {}, migrated = true, faults = {}, now = () => Date.now() } = {}) {
  const db = { ...tables };
  for (const t of ["user_cards", "cahier_links", "card_reviews", "upload_batches"]) db[t] ||= [];
  if (migrated) for (const t of POST_016_TABLES) db[t] ||= [];
  let nextId = 1 + Math.max(0, ...db.user_cards.map((r) => Number(r.id) || 0), 1000);
  const calls = [];

  const tableExists = (name) => migrated || !POST_016_TABLES.includes(name);
  const missingCols = (name, cols) => (migrated ? [] : (POST_016_COLUMNS[name] || []).filter((c) => cols.includes(c)));

  // Checks a row as Postgres would on insert; returns an error or null.
  const refuse = (name, row) => {
    for (const k of NOT_NULL[name] || []) {
      if (row[k] === undefined || row[k] === null) return err("23502", `null value in column "${k}" of relation "${name}" violates not-null constraint`);
    }
    if (name === "user_cards" && Buffer.byteLength(String(row.front)) > INDEX_LIMIT) {
      return err("54000", `index row size exceeds btree version 4 maximum ${INDEX_LIMIT} for index "user_cards_user_id_front_key"`);
    }
    if (name === "user_cards" && /\u0000/.test(`${row.front}${row.back}`)) return err("22P05", "unsupported Unicode escape sequence");
    return null;
  };
  const sameKey = (name, a, b) => (UNIQUE[name] || []).length > 0 && UNIQUE[name].every((k) => a[k] === b[k]);
  const withDefaults = (name, row) => {
    const base = DEFAULTS[name] ? DEFAULTS[name]() : {};
    const out = { ...base, ...row };
    if (name === "user_cards" && out.id == null) out.id = nextId++;
    if (name === "card_pairs" && out.id == null) out.id = `pair-${Math.random().toString(36).slice(2)}`;
    return out;
  };

  function from(name) {
    const q = { filters: [], order: null, range: null, limit: null, op: "select", cols: "*", payload: null, opts: {}, wantRows: false, single: null };
    const b = {};
    const filt = (fn) => { q.filters.push(fn); return b; };
    b.select = (cols = "*", opts = {}) => {
      if (q.op === "select") { q.cols = cols; q.opts = { ...q.opts, ...opts }; } else q.wantRows = true;
      return b;
    };
    b.eq = (c, v) => filt((r) => r[c] === v);
    b.neq = (c, v) => filt((r) => r[c] !== v);
    b.in = (c, vs) => filt((r) => vs.includes(r[c]));
    b.is = (c, v) => filt((r) => (v === null ? r[c] == null : r[c] === v));
    b.lt = (c, v) => filt((r) => r[c] < v);
    b.gt = (c, v) => filt((r) => r[c] > v);
    b.ilike = (c, v) => filt((r) => String(r[c] || "").toLowerCase() === String(v).toLowerCase());
    b.order = (c, o = {}) => { q.order = [c, o.ascending !== false]; return b; };
    b.range = (a, z) => { q.range = [a, z]; return b; };
    b.limit = (n) => { q.limit = n; return b; };
    b.insert = (rows) => { q.op = "insert"; q.payload = rows; return b; };
    b.upsert = (rows, opts = {}) => { q.op = "upsert"; q.payload = rows; q.opts = opts; return b; };
    b.update = (patch, opts = {}) => { q.op = "update"; q.payload = patch; q.opts = opts; return b; };
    b.delete = (opts = {}) => { q.op = "delete"; q.opts = opts; return b; };
    b.maybeSingle = () => { q.single = "maybe"; return b; };
    b.single = () => { q.single = "one"; return b; };
    b.then = (resolve, reject) => Promise.resolve().then(run).then(resolve, reject);

    const run = () => {
      calls.push({ table: name, op: q.op });
      if (!tableExists(name)) return { data: null, error: err("PGRST205", `Could not find the table 'public.${name}' in the schema cache`), count: null };
      const rows = (db[name] ||= []);
      const matching = () => rows.filter((r) => q.filters.every((f) => f(r)));
      const shape = (list) => {
        if (q.single === "maybe") return { data: list[0] ?? null, error: list.length > 1 ? err("PGRST116", "more than one row") : null };
        if (q.single === "one") return list.length === 1 ? { data: list[0], error: null } : { data: null, error: err("PGRST116", `${list.length} rows`) };
        return { data: list, error: null };
      };

      if (q.op === "select") {
        const cols = q.cols === "*" ? [] : q.cols.split(",").map((c) => c.trim()).filter(Boolean);
        const gone = missingCols(name, cols);
        if (gone.length) return { data: null, error: err("42703", `column ${name}.${gone[0]} does not exist`) };
        let list = matching();
        if (q.order) {
          const [c, asc] = q.order;
          list = list.slice().sort((x, y) => ((x[c] ?? "") < (y[c] ?? "") ? -1 : (x[c] ?? "") > (y[c] ?? "") ? 1 : 0) * (asc ? 1 : -1));
        }
        if (q.range) list = list.slice(q.range[0], q.range[1] + 1);
        if (q.limit != null) list = list.slice(0, q.limit);
        list = list.map((r) => (cols.length ? Object.fromEntries(cols.map((c) => [c, clone(r[c] ?? null)])) : clone(r)));
        return { ...shape(list), count: list.length };
      }

      const payloadCols = (p) => [...new Set((Array.isArray(p) ? p : [p]).flatMap((r) => Object.keys(r || {})))];
      if (q.op === "insert" || q.op === "upsert" || q.op === "update") {
        const gone = missingCols(name, payloadCols(q.payload));
        if (gone.length) return { data: null, error: err("PGRST204", `Could not find the '${gone[0]}' column of '${name}' in the schema cache`) };
      }

      if (q.op === "update") {
        const f = faults.update;
        if (f && f.table === name && f.times > 0) { f.times--; return { data: null, error: f.error || err("XX000", "the update failed") }; }
        const hit = matching();
        const after = hit.map((r) => ({ ...r, ...clone(q.payload) }));
        // migration_016's trigger: a card back in study loses its reason.
        if (name === "user_cards" && migrated && "source" in q.payload) {
          for (const r of after) if (!(typeof r.source === "string" && r.source.startsWith("archived:"))) { r.archived_reason = null; r.archived_at = null; }
        }
        if (name === "user_cards") {
          for (const r of after) {
            const bad = refuse(name, r);
            if (bad) return { data: null, error: bad };
            if (rows.some((o) => !hit.includes(o) && sameKey(name, o, r))) return { data: null, error: err("23505", "duplicate key value violates unique constraint") };
          }
        }
        hit.forEach((r, i) => Object.assign(r, after[i]));
        return { data: q.wantRows ? clone(hit) : null, error: null, count: hit.length };
      }

      if (q.op === "delete") {
        const hit = matching();
        db[name] = rows.filter((r) => !hit.includes(r));
        return { data: q.wantRows ? clone(hit) : null, error: null, count: hit.length };
      }

      // insert / upsert: checked whole first, then written.
      const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => clone(r));
      const conflictKeys = q.op === "upsert" ? (q.opts.onConflict || "id").split(",").map((s) => s.trim()) : UNIQUE[name] || [];
      const planned = [];
      for (const row of list) {
        const full = withDefaults(name, row);
        const bad = refuse(name, full);
        if (bad) return { data: null, error: bad, count: null };
        const found = rows.find((r) => conflictKeys.length && conflictKeys.every((k) => r[k] === row[k])) ||
          planned.find((p) => p.kind === "insert" && conflictKeys.length && conflictKeys.every((k) => p.row[k] === row[k]))?.row;
        if (found) {
          if (q.op === "insert") return { data: null, error: err("23505", "duplicate key value violates unique constraint"), count: null };
          if (q.opts.ignoreDuplicates) continue;
          planned.push({ kind: "update", target: found, patch: row });
        } else {
          if (rows.some((r) => sameKey(name, r, full))) return { data: null, error: err("23505", "duplicate key value violates unique constraint"), count: null };
          planned.push({ kind: "insert", row: full });
        }
      }
      const written = [];
      for (const p of planned) {
        if (p.kind === "insert") { rows.push(p.row); written.push(p.row); continue; }
        Object.assign(p.target, p.patch);
        if (name === "user_cards" && migrated && "source" in p.patch && !String(p.target.source ?? "").startsWith("archived:")) {
          p.target.archived_reason = null;
          p.target.archived_at = null;
        }
        written.push(p.target);
      }
      if (q.single) return { ...shape(clone(written)), count: written.length };
      return { data: q.wantRows ? clone(written) : null, error: null, count: written.length };
    };
    return b;
  }

  // ── migration_016's functions ─────────────────────────────────────────
  const merged = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].sort();
  const fns = {
    claim_notes_reading({ p_user_id, p_run_id, p_kind, p_lease_seconds = 600, p_renew = false }) {
      let row = db.notes_read.find((r) => r.user_id === p_user_id);
      if (!row) { row = withDefaults("notes_read", { user_id: p_user_id }); db.notes_read.push(row); }
      const t = now();
      // Renewing takes only this run's own turn, never a free one.
      const free = row.run_id === p_run_id ||
        (!p_renew && (row.run_id == null || row.run_expires_at == null || Date.parse(row.run_expires_at) < t));
      if (!free) return { data: { claimed: false, run_kind: row.run_kind, run_started_at: row.run_started_at, run_expires_at: row.run_expires_at } };
      if (row.run_id !== p_run_id) row.run_started_at = new Date(t).toISOString();
      row.run_id = p_run_id;
      row.run_kind = p_kind;
      row.run_expires_at = new Date(t + Math.max(Number(p_lease_seconds) || 600, 30) * 1000).toISOString();
      return { data: { claimed: true, classes: clone(row.classes || {}) } };
    },
    save_notes_reading({ p_user_id, p_run_id, p_inserts = [], p_dates = [], p_archive = [], p_restore = [], p_pairs = [], p_classes = null, p_finish = true }) {
      const rec = db.notes_read.find((r) => r.user_id === p_user_id && r.run_id === p_run_id);
      if (!rec) return { error: err("NR409", "This reading of the notes lost its turn: another one started after it ran out of time.") };
      const out = { inserted: 0, joined: 0, dated: 0, archived: 0, restored: 0, pairs: 0, refused: [] };
      // A card the database can't hold is left out and named, inside the step
      // (the function's one-at-a-time fallback); the rest is saved.
      for (const x of p_inserts || []) {
        const row = withDefaults("user_cards", {
          user_id: p_user_id, front: x.front, back: x.back, category: x.category ?? "V",
          dates: x.dates ?? [], source: x.source ?? null, batch_id: x.batch_id ?? null,
        });
        const bad = refuse("user_cards", row);
        if (bad) { out.refused.push({ front: x.front, error: bad.message, code: bad.code }); continue; }
        const found = db.user_cards.find((r) => r.user_id === p_user_id && r.front === x.front);
        if (found) { found.dates = merged(found.dates, x.dates); out.joined++; } else { db.user_cards.push(row); out.inserted++; }
      }
      for (const u of p_dates || []) {
        const r = db.user_cards.find((c) => c.id === u.id && c.user_id === p_user_id);
        if (r) { r.dates = merged(r.dates, u.dates); out.dated++; }
      }
      // "Replace" never takes out a card answered either way round.
      const answeredRow = (r) => (r.fsrs_state ?? 0) !== 0 || (r.en_fsrs_state ?? 0) !== 0 || (r.reps ?? 0) > 0 ||
        (r.en_reps ?? 0) > 0 || r.last_review != null || r.en_last_review != null;
      for (const a of p_archive || []) {
        const r = db.user_cards.find((c) => c.id === a.id && c.user_id === p_user_id);
        if (r && a.reason === "replaced" && answeredRow(r)) continue;
        if (r && !(typeof r.source === "string" && r.source.startsWith("archived:"))) {
          r.source = `archived:${r.source ?? ""}`; r.archived_reason = a.reason; r.archived_at = new Date(now()).toISOString(); out.archived++;
        }
      }
      for (const id of p_restore || []) {
        const r = db.user_cards.find((c) => c.id === id && c.user_id === p_user_id);
        if (r && typeof r.source === "string" && r.source.startsWith("archived:") && r.archived_reason === "replaced") {
          r.source = r.source.slice(9) || null; r.archived_reason = null; r.archived_at = null; out.restored++;
        }
      }
      const idOf = (front) => db.user_cards.find((c) => c.user_id === p_user_id && c.front === front)?.id ?? null;
      for (const x of p_pairs || []) {
        if (!["same", "different"].includes(x.verdict)) continue;
        if (x.card_a != null && !db.user_cards.some((c) => c.id === x.card_a && c.user_id === p_user_id)) continue;
        db.card_pairs.push(withDefaults("card_pairs", {
          user_id: p_user_id, card_a: x.card_a ?? idOf(x.a_new_front), card_b: x.card_b ?? idOf(x.b_new_front),
          a_front: x.a_front, a_back: x.a_back, b_front: x.b_front, b_back: x.b_back,
          verdict: x.verdict, version: x.version, model: x.model, source: x.source,
        }));
        out.pairs++;
      }
      if (p_classes != null) rec.classes = clone(p_classes);
      if (p_finish) { rec.run_id = null; rec.run_kind = null; rec.run_expires_at = null; }
      rec.updated_at = new Date(now()).toISOString();
      return { data: out };
    },
  };

  const rpc = async (name, params = {}) => {
    calls.push({ rpc: name, params: clone(params) });
    if (!migrated || !fns[name]) return { data: null, error: err("PGRST202", `Could not find the function public.${name} in the schema cache`) };
    const f = faults.rpc;
    if (f && f.name === name && f.times > 0 && !f.after) { f.times--; return { data: null, error: f.error || err("XX000", "connection lost") }; }
    // All or nothing: a function that fails part way changes nothing.
    const before = clone({ user_cards: db.user_cards, notes_read: db.notes_read, card_pairs: db.card_pairs });
    const keepNext = nextId;
    try {
      const r = fns[name](params);
      if (r.error) { Object.assign(db, before); nextId = keepNext; return { data: null, error: r.error }; }
      if (f && f.name === name && f.times > 0 && f.after) { f.times--; return { data: null, error: f.error || err("XX000", "the reply was lost") }; }
      return { data: r.data, error: null };
    } catch (e) {
      Object.assign(db, before);
      nextId = keepNext;
      return { data: null, error: e && e.code ? e : err("XX000", String(e?.message || e)) };
    }
  };

  return { from, rpc, tables: db, calls };
}
