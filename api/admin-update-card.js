// Vercel serverless function: POST /api/admin-update-card
//
// Updates a single user_cards row on behalf of the authenticated user.
// Uses the service role key so RLS policies on user_cards can't silently
// block the update (which is what was happening from the client — updates
// returned success with 0 rows affected, the modal would close, and the
// change would quietly never persist).
//
// Request body: { row_id, front, back }
// Response:     { ok: true, row: <updated row> }
//               or { error: "..." } on 4xx/5xx

import { createClient } from "@supabase/supabase-js";

// Force Vercel to parse JSON bodies for us. Without this, some runtime
// combinations deliver req.body as undefined or a raw stream.
export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" },
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the JWT and get the user id. We use this to scope the update
  // to rows owned by the caller — the service role bypasses RLS, so we
  // must enforce ownership manually here.
  const { data: userData, error: userErr } = await admin.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: "Invalid auth token" });
  }
  const userId = userData.user.id;

  // Defensive: support req.body arriving as a JSON string (some Vercel
  // runtime combos pass the raw body through instead of parsing).
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {}
  }
  if (!body || typeof body !== "object") {
    body = {};
  }
  console.log("[admin-update-card] body keys:", Object.keys(body));

  const { row_id, front, back, original_front } = body;
  if (typeof front !== "string" || typeof back !== "string") {
    return res.status(400).json({ error: "front and back are required strings" });
  }

  // Dual-lookup strategy. The client sometimes hits this endpoint with
  // row_id undefined (we've seen it in prod — the React state carrying
  // the edit card loses its row_id somehow). As a fallback we can match
  // by the user's lowercased-trimmed French front text, which is unique
  // per user by construction. At least one of row_id or original_front
  // must be present.
  let existing = null;
  if (row_id && typeof row_id === "string") {
    const { data, error } = await admin
      .from("user_cards")
      .select("id, user_id, front")
      .eq("id", row_id)
      .maybeSingle();
    if (error) {
      console.error("[admin-update-card] fetch by id failed:", error);
      return res.status(500).json({ error: error.message });
    }
    existing = data;
  }
  if (!existing && typeof original_front === "string" && original_front.trim()) {
    const key = original_front.trim().toLowerCase();
    const { data, error } = await admin
      .from("user_cards")
      .select("id, user_id, front")
      .eq("user_id", userId)
      .ilike("front", original_front.trim())
      .limit(10);
    if (error) {
      console.error("[admin-update-card] fetch by front failed:", error);
      return res.status(500).json({ error: error.message });
    }
    existing = (data || []).find(
      (r) => String(r.front || "").toLowerCase().trim() === key
    );
  }
  if (!existing) {
    return res.status(404).json({
      error: `Card not found. (row_id=${JSON.stringify(row_id)}, original_front=${JSON.stringify(original_front)})`,
    });
  }
  if (existing.user_id !== userId) {
    return res.status(403).json({ error: "Not your card" });
  }

  const { data: updated, error: updErr } = await admin
    .from("user_cards")
    .update({
      front: front.trim(),
      back: back.trim(),
      flagged_for_review: false,
    })
    .eq("id", existing.id)
    .select()
    .single();
  if (updErr) {
    console.error("[admin-update-card] update failed:", updErr);
    return res.status(500).json({ error: updErr.message });
  }

  return res.status(200).json({ ok: true, row: updated });
}
