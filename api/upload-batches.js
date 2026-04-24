// Vercel serverless function: /api/upload-batches
//
// POST                         → create a new batch row
// GET                          → list recent batches
// PATCH /api/upload-batches?id=<uuid>
//                              → update cards_accepted / cards_edited_post_parse
//                                (client sends this after a commit finishes)
//
// Admin-only, mirroring api/admin-users.js auth. Writes use the service
// role key. Graceful-degrades to 503 "migration not run" when the tables
// are missing.
//
// NOTE on PATCH routing: Vercel serverless functions don't do path-param
// routing for flat files (.../upload-batches/:id needs an [id].js file).
// We accept the id as a query parameter instead; the client helper passes
// it that way. The spec-style "PATCH /:id" in the prompt is served via
// `PATCH /api/upload-batches?id=<uuid>`.

import { createClient } from "@supabase/supabase-js";

function isMissingRelationError(err) {
  if (!err) return false;
  const code = err.code || err?.details?.code;
  if (code === "42P01") return true;
  const msg = String(err.message || err.msg || "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    (msg.includes("relation") && msg.includes("upload_batches"))
  );
}

function migrationNotRunResponse(res, detail) {
  return res.status(503).json({
    error: "migration not run",
    detail: detail || "upload_batches table not found",
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

function extractUserIdFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8")
    );
    return payload.sub || null;
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
    return handleCreate(req, res, admin);
  }
  if (req.method === "PATCH") {
    return handleUpdate(req, res, admin);
  }
  if (req.method === "GET") {
    return handleList(req, res, admin);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleCreate(req, res, admin) {
  const body = req.body || {};
  const user_id = body.user_id || extractUserIdFromJwt(req.headers.authorization || "");
  if (!user_id) {
    return res.status(400).json({ error: "user_id required" });
  }

  const row = {
    user_id,
    source: body.source || null,
    input_chars:
      typeof body.input_chars === "number" ? body.input_chars : null,
    cards_parsed:
      typeof body.cards_parsed === "number" ? body.cards_parsed : 0,
    cards_accepted:
      typeof body.cards_accepted === "number" ? body.cards_accepted : null,
    cards_edited_post_parse:
      typeof body.cards_edited_post_parse === "number"
        ? body.cards_edited_post_parse
        : 0,
    few_shot_correction_ids: Array.isArray(body.few_shot_correction_ids)
      ? body.few_shot_correction_ids
      : [],
    model: body.model || null,
    notes: body.notes || null,
  };

  try {
    const { data, error } = await admin
      .from("upload_batches")
      .insert(row)
      .select("*")
      .single();

    if (error) {
      if (isMissingRelationError(error)) {
        return migrationNotRunResponse(res, error.message);
      }
      console.error("[upload-batches] insert failed:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, batch: data });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return migrationNotRunResponse(res, err.message);
    }
    console.error("[upload-batches] insert threw:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function handleUpdate(req, res, admin) {
  const id = req.query?.id || req.body?.id;
  if (!id) {
    return res.status(400).json({ error: "id required (query ?id=<uuid>)" });
  }

  const body = req.body || {};
  const patch = {};
  if (typeof body.cards_accepted === "number") {
    patch.cards_accepted = body.cards_accepted;
  }
  if (typeof body.cards_edited_post_parse === "number") {
    patch.cards_edited_post_parse = body.cards_edited_post_parse;
  }
  if (typeof body.notes === "string") {
    patch.notes = body.notes;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error:
        "no updatable fields provided (cards_accepted, cards_edited_post_parse, notes)",
    });
  }

  try {
    const { data, error } = await admin
      .from("upload_batches")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      if (isMissingRelationError(error)) {
        return migrationNotRunResponse(res, error.message);
      }
      console.error("[upload-batches] update failed:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, batch: data });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return migrationNotRunResponse(res, err.message);
    }
    console.error("[upload-batches] update threw:", err);
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
      .from("upload_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingRelationError(error)) {
        return migrationNotRunResponse(res, error.message);
      }
      console.error("[upload-batches] list failed:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, batches: data || [] });
  } catch (err) {
    if (isMissingRelationError(err)) {
      return migrationNotRunResponse(res, err.message);
    }
    console.error("[upload-batches] list threw:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
