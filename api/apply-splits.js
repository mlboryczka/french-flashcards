// Vercel serverless function: POST /api/apply-splits
//
// Applies the splits the user approved in the multi-sense cleanup.
//
// For each approved card: the original row is rewritten as the FIRST sense
// and keeps its scheduling history (it is still the card you have been
// studying, just with the other headword's glosses removed), and the
// remaining senses are inserted as new rows starting from scratch — they are
// words you have effectively never been tested on on their own.
//
// Uses the service role key for the same reason /api/admin-update-card does:
// RLS on user_cards silently returned success with zero rows affected from
// the client. Ownership is therefore enforced by hand — every row is fetched
// and checked against the caller's id before anything is written.
//
// Request body (JSON):
//   { splits: [{ row_id, cards: [{ front, back, category }, ...] }, ...] }
// Response:
//   { ok: true, updated: n, inserted: n, skipped: [{ row_id, reason }] }

import { createClient } from "@supabase/supabase-js";

const CAT_UI_TO_DB = { vocab: "V", expr: "E", gram: "G", pron: "P" };
const MAX_SPLITS = 100;

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  const accessToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return res.status(401).json({ error: "Missing auth token" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await admin.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: "Invalid auth token" });
  }
  const userId = userData.user.id;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const splits = Array.isArray(body?.splits) ? body.splits.slice(0, MAX_SPLITS) : [];
  if (splits.length === 0) return res.status(400).json({ error: "No splits given" });

  const rowIds = [...new Set(splits.map((s) => String(s?.row_id)).filter(Boolean))];
  const { data: rows, error: fetchErr } = await admin
    .from("user_cards")
    .select("id, user_id, front, back, category, dates, batch_id")
    .in("id", rowIds);
  if (fetchErr) {
    console.error("[apply-splits] fetch failed:", fetchErr);
    return res.status(500).json({ error: fetchErr.message });
  }
  const owned = new Map(
    (rows || []).filter((r) => r.user_id === userId).map((r) => [r.id, r])
  );

  const skipped = [];
  const inserts = [];
  const updates = [];

  for (const split of splits) {
    const rowId = String(split?.row_id || "");
    const existing = owned.get(rowId);
    if (!existing) {
      skipped.push({ row_id: rowId, reason: "not your card, or no longer there" });
      continue;
    }
    const cards = (Array.isArray(split?.cards) ? split.cards : [])
      .map((c) => ({
        front: String(c?.front || "").trim(),
        back: String(c?.back || "").trim(),
        category: CAT_UI_TO_DB[c?.category] || existing.category || "V",
      }))
      .filter((c) => c.front && c.back);

    // Same guards as the proposal endpoint, re-checked here: a request can
    // reach this route without having come from that one.
    const fronts = new Set(cards.map((c) => c.front.toLowerCase()));
    if (cards.length < 2 || fronts.size !== cards.length) {
      skipped.push({ row_id: rowId, reason: "split was malformed" });
      continue;
    }

    const [first, ...rest] = cards;
    updates.push({ id: rowId, front: first.front, back: first.back, category: first.category });
    for (const c of rest) {
      inserts.push({
        user_id: userId,
        front: c.front,
        back: c.back,
        category: c.category,
        // The lesson dates belong to the original notebook entry, so both
        // halves inherit them. Scheduling state does not: a sense you have
        // never been asked for on its own is a new card.
        dates: Array.isArray(existing.dates) ? existing.dates : [],
        batch_id: existing.batch_id || null,
        flagged_for_review: false,
      });
    }
  }

  let updated = 0;
  for (const u of updates) {
    const { error } = await admin
      .from("user_cards")
      .update({ front: u.front, back: u.back, category: u.category })
      .eq("id", u.id)
      .eq("user_id", userId);
    if (error) {
      console.error("[apply-splits] update failed:", u.id, error);
      skipped.push({ row_id: u.id, reason: error.message });
    } else {
      updated++;
    }
  }

  let inserted = 0;
  if (inserts.length > 0) {
    const { data, error } = await admin.from("user_cards").insert(inserts).select("id");
    if (error) {
      console.error("[apply-splits] insert failed:", error);
      return res.status(500).json({
        error: `Rewrote ${updated} cards but couldn't add the new ones: ${error.message}`,
      });
    }
    inserted = (data || []).length;
  }

  return res.status(200).json({ ok: true, updated, inserted, skipped });
}
