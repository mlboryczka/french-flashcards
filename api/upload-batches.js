// Vercel serverless function: /api/upload-batches
//
// POST                                → create a new batch row
// GET                                 → list recent batches
// PATCH /api/upload-batches?id=<uuid> → update cards_accepted /
//                                       cards_edited_post_parse / notes
//
// PATCH uses ?id= rather than path-param because flat-file Vercel routes
// can't do /:id routing without an [id].js file.

import { createClient } from "@supabase/supabase-js";
import { extractUserIdFromJwt, requireAdmin } from "./_lib/auth.js";

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  if (!requireAdmin(req, res)) return;

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

  const { data, error } = await admin
    .from("upload_batches")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    console.error("[upload-batches] insert failed:", error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, batch: data });
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

  const { data, error } = await admin
    .from("upload_batches")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[upload-batches] update failed:", error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, batch: data });
}

async function handleList(req, res, admin) {
  const limitRaw = parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, 500)
    : 50;

  const { data, error } = await admin
    .from("upload_batches")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[upload-batches] list failed:", error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, batches: data || [] });
}
