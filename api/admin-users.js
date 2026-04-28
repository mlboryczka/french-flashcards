// Vercel serverless function: GET /api/admin-users
//
// Returns aggregated user stats for the admin dashboard.
// Requires service role key (bypasses RLS) and admin auth check.
//
// "Last active" is computed from user_review_dates (the streak table),
// which timestamps every review. Falls back to last_sign_in_at for users
// who have never reviewed a card.

import { requireAdmin } from "./_lib/auth.js";

// PostgREST caps unbounded queries at 1000 rows by default. With multiple
// active users, user_cards / card_progress / user_review_dates all exceed
// that. Paginate via offset/limit instead of truncating silently.
async function fetchAllRows(baseUrl, headers, pageSize = 1000) {
  const out = [];
  let offset = 0;
  // Safety cap: 200 pages = 200k rows. If we ever hit this, the underlying
  // query needs to be narrowed — but it avoids a runaway loop on a bug.
  for (let i = 0; i < 200; i++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}offset=${offset}&limit=${pageSize}`;
    const res = await fetch(url, { headers });
    if (!res.ok) break;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  if (!requireAdmin(req, res)) return;

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    // Get all users from auth.users via admin API
    const usersRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`,
      { headers: sbHeaders }
    );
    const usersData = await usersRes.json();
    const authUsers = usersData.users || usersData || [];

    // Deck size per user + per-user set of valid card IDs. Filters orphaned
    // card_progress rows left behind when a card's front text was edited.
    // Must paginate — without offset/limit, PostgREST caps at 1000 rows and
    // any user whose cards fall past that cutoff silently shows deck=0.
    const cardStats = {};
    const validCardIdsByUser = {};
    const deckRows = await fetchAllRows(
      `${SUPABASE_URL}/rest/v1/user_cards?select=user_id,front&order=user_id`,
      sbHeaders
    );
    for (const row of deckRows) {
      if (!cardStats[row.user_id]) cardStats[row.user_id] = { deck_size: 0 };
      cardStats[row.user_id].deck_size++;
      if (!validCardIdsByUser[row.user_id]) validCardIdsByUser[row.user_id] = new Set();
      // card_progress.card_id is the lowercased, trimmed front text
      // (see FlashcardApp.jsx: "card_progress rows continue to match via
      // the lowercased-front id").
      validCardIdsByUser[row.user_id].add(
        String(row.front || "").toLowerCase().trim()
      );
    }

    // Progress stats per user, filtered to cards still in the user's deck
    const progressStats = {};
    const progRows = await fetchAllRows(
      `${SUPABASE_URL}/rest/v1/card_progress?select=user_id,card_id,score&order=user_id`,
      sbHeaders
    );
    for (const row of progRows) {
      const validIds = validCardIdsByUser[row.user_id];
      if (!validIds) continue; // user has no deck — skip
      const cid = String(row.card_id || "").toLowerCase().trim();
      if (!validIds.has(cid)) continue; // orphaned progress row, don't count
      if (!progressStats[row.user_id]) {
        progressStats[row.user_id] = { studied: 0, mastered: 0 };
      }
      progressStats[row.user_id].studied++;
      if (row.score >= 3) progressStats[row.user_id].mastered++;
    }

    // Last activity per user — max(created_at) from user_review_dates.
    // This reflects actual app usage (card reviews), not just login.
    const lastActiveByUser = {};
    const reviewRows = await fetchAllRows(
      `${SUPABASE_URL}/rest/v1/user_review_dates?select=user_id,created_at&order=created_at.desc`,
      sbHeaders
    );
    for (const row of reviewRows) {
      // Rows come back sorted desc by created_at, so the first one we see
      // per user is the most recent.
      if (!lastActiveByUser[row.user_id]) {
        lastActiveByUser[row.user_id] = row.created_at;
      }
    }

    // Merge everything
    const users = authUsers.map((u) => {
      const lastReview = lastActiveByUser[u.id] || null;
      const lastSignIn = u.last_sign_in_at || null;
      // Prefer review timestamp (actual activity). Fall back to sign-in for
      // users who have never reviewed a card.
      const lastActive = lastReview || lastSignIn;
      return {
        id: u.id,
        email: u.email || "unknown",
        created: u.created_at,
        last_active: lastActive,
        last_sign_in: lastSignIn,
        last_review: lastReview,
        deck_size: cardStats[u.id]?.deck_size || 0,
        studied: progressStats[u.id]?.studied || 0,
        mastered: progressStats[u.id]?.mastered || 0,
      };
    });

    // Sort by last active, most recent first
    users.sort(
      (a, b) => new Date(b.last_active || 0) - new Date(a.last_active || 0)
    );

    return res.status(200).json({ ok: true, users });
  } catch (err) {
    console.error("admin-users error:", err);
    return res.status(500).json({ error: err.message });
  }
}
