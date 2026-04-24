// Vercel serverless function: /api/parse-corrections
//
// POST   → log a correction (admin-only)
// GET    → list recent corrections (?limit=N)
// GET ?aggregate=true → return correction_patterns_90d view rows
//
// Auth mirrors api/admin-users.js: decode the JWT email from the Bearer
// token and check against VITE_ADMIN_EMAIL. DB writes use the service role
// key so RLS can't get in the way (we've already gated on admin email).
//
// Graceful degradation: if the tables do not yet exist (migration_002 has
// not been run), DB calls error with PostgreSQL code 42P01 ("relation does
// not exist"). We detect that and return 503 with a "migration not run"
// body so the client can silently disable itself.

import { createClient } from "@supabase/supabase-js";

// PostgREST / PostgreSQL error codes that indicate the tables don't exist
// yet — e.g. migration has not been run. Return 503 so the client knows to
// back off gracefully instead of treating it as a real error.
function isMissingRelationError(err) {
  if (!err) return false;
  const code = err.code || err?.details?.code;
  // 42P01 = undefined_table (PostgreSQL). PostgREST surfaces it in `code`.
  if (code === "42P01") return true;
  const msg = String(err.message || err.msg || "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("relation") &&
      (msg.includes("parse_corrections") ||
        msg.includes("upload_batches") ||
        msg.includes("correction_patterns_90d"))
  );
}

function migrationNotRunResponse(res, detail) {
  return res.status(503).json({
    error: "migration not run",
    detail: detail || "parse_corrections / upload_batches tables not found",
  });
}

function extractEmailFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8")
    );
    return payload.email || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_ADMIN_EMAIL } =
    process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  const userEmail = extractEmailFromJwt(req.headers.authorization || "");
  const adminEmail = (VITE_ADMIN_EMAIL || "").toLowerCase();
  if (!adminEmail) {
    return res.status(500).json({ error: "VITE_ADMIN_EMAIL not configured" });
  }
  if (!userEmail || userEmail.toLowerCase() !== adminEmail) {
    return res.status(403).json({ error: "Admin only" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.method === "POST") {
    return handlePost(req, res, admin);
  }
  if (req.method === "GET") {
    if (req.query?.aggregate === "true") {
      return handleAggregate(req, res, admin);
    }
    return handleList(req, res, admin);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

async function handlePost(req, res, admin) {
  const body = req.body || {};
  const {
    category,
    action = null,
    card_id = null,
    batch_id = null,
    original_front = null,
    original_back = null,
    corrected_front = null,
    corrected_back = null,
    notes = null,
  } = body;

  if (!category || typeof category !== "string") {
    return res.status(400).json({ error: "category is required" });
  }

  // Pull user_id off the JWT so corrections are attributable even when the
  // body omits it. We still let body override for edge cases (e.g. logging
  // a correction on behalf of another user from the admin view).
  let jwtUserId = null;
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const parts = authHeader.slice(7).split(".");
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64").toString("utf8")
      );
      jwtUserId = payload.sub || null;
    } catch {}
  }
  const user_id = body.user_id || jwtUserId;

  try {
    const { data, error } = await admin
      .from("parse_corrections")
      .insert({
        category,
        action,
        user_id,
        card_id,
        batch_id,
        original_front,
        original_back,
        corrected_front,
        corrected_back,
        notes,
      })
      .select("id")
      .single();

    if (error) {
      if (isMissingRelationError(error)) {
        return migrationNotRunResponse(res, error.message);
      }
      console.error("[parse-corrections] insert failed:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, id: data?.id || null });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return migrationNotRunResponse(res, err.message);
    }
    console.error("[parse-corrections] insert threw:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function handleList(req, res, admin) {
  const limitRaw = parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, 500)
    : 50;

  try {
    const { data, error } = await admin
      .from("parse_corrections")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingRelationError(error)) {
        return migrationNotRunResponse(res, error.message);
      }
      console.error("[parse-corrections] list failed:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, corrections: data || [] });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return migrationNotRunResponse(res, err.message);
    }
    console.error("[parse-corrections] list threw:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function handleAggregate(_req, res, admin) {
  try {
    const { data, error } = await admin
      .from("correction_patterns_90d")
      .select("*");

    if (error) {
      if (isMissingRelationError(error)) {
        return migrationNotRunResponse(res, error.message);
      }
      console.error("[parse-corrections] aggregate failed:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, patterns: data || [] });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return migrationNotRunResponse(res, err.message);
    }
    console.error("[parse-corrections] aggregate threw:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
