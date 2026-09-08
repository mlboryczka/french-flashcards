// Vercel serverless function: /api/parse-corrections
//
// POST   → log a correction (admin-only)
// GET    → list recent corrections (?limit=N)
// GET ?aggregate=true → return correction_patterns_90d view rows
//
// DB writes use the service role key (RLS is enforced upstream by the
// admin-email gate).

import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "./_lib/auth.js";

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  const admin_user = await requireAdmin(req, res);
  if (!admin_user) return;

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

  const user_id = body.user_id || admin_user.id;

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
    console.error("[parse-corrections] insert failed:", error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, id: data?.id || null });
}

async function handleList(req, res, admin) {
  const limitRaw = parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, 500)
    : 50;

  const { data, error } = await admin
    .from("parse_corrections")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[parse-corrections] list failed:", error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, corrections: data || [] });
}

async function handleAggregate(_req, res, admin) {
  const { data, error } = await admin
    .from("correction_patterns_90d")
    .select("*");

  if (error) {
    console.error("[parse-corrections] aggregate failed:", error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, patterns: data || [] });
}
