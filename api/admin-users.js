// Vercel serverless function: GET /api/admin-users
//
// Returns aggregated user stats for the admin dashboard.
// Requires service role key (bypasses RLS) and admin auth check.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_ADMIN_EMAIL } =
    process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  // Verify caller is admin via their JWT
  const authHeader = req.headers.authorization || "";
  let userEmail = null;
  if (authHeader.startsWith("Bearer ")) {
    try {
      const payload = JSON.parse(
        Buffer.from(authHeader.split(".")[1], "base64").toString()
      );
      userEmail = payload.email || null;
    } catch {}
  }

  const adminEmail = (VITE_ADMIN_EMAIL || "").toLowerCase();
  if (!userEmail || userEmail.toLowerCase() !== adminEmail) {
    return res.status(403).json({ error: "Admin only" });
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    // Get all users from auth.users via admin API
    const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=500`, {
      headers: {
        ...sbHeaders,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    const usersData = await usersRes.json();
    const authUsers = usersData.users || usersData || [];

    // Get card counts per user
    const cardsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/admin_user_stats`,
      {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({}),
      }
    );

    // If the RPC doesn't exist, fall back to simpler queries
    let cardStats = {};
    let progressStats = {};

    if (cardsRes.ok) {
      const rpcData = await cardsRes.json();
      for (const row of rpcData || []) {
        cardStats[row.user_id] = { deck_size: row.deck_size };
        progressStats[row.user_id] = {
          studied: row.studied,
          mastered: row.mastered,
        };
      }
    } else {
      // Fallback: query user_cards and card_progress directly
      const deckRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_cards?select=user_id&order=user_id`,
        { headers: sbHeaders }
      );
      const deckRows = deckRes.ok ? await deckRes.json() : [];
      for (const row of deckRows) {
        if (!cardStats[row.user_id]) cardStats[row.user_id] = { deck_size: 0 };
        cardStats[row.user_id].deck_size++;
      }

      const progRes = await fetch(
        `${SUPABASE_URL}/rest/v1/card_progress?select=user_id,score&order=user_id`,
        { headers: sbHeaders }
      );
      const progRows = progRes.ok ? await progRes.json() : [];
      for (const row of progRows) {
        if (!progressStats[row.user_id])
          progressStats[row.user_id] = { studied: 0, mastered: 0 };
        progressStats[row.user_id].studied++;
        if (row.score >= 3) progressStats[row.user_id].mastered++;
      }
    }

    // Merge
    const users = authUsers.map((u) => ({
      id: u.id,
      email: u.email || "unknown",
      created: u.created_at,
      last_sign_in: u.last_sign_in_at,
      deck_size: cardStats[u.id]?.deck_size || 0,
      studied: progressStats[u.id]?.studied || 0,
      mastered: progressStats[u.id]?.mastered || 0,
    }));

    // Sort by last active
    users.sort(
      (a, b) =>
        new Date(b.last_sign_in || 0) - new Date(a.last_sign_in || 0)
    );

    return res.status(200).json({ ok: true, users });
  } catch (err) {
    console.error("admin-users error:", err);
    return res.status(500).json({ error: err.message });
  }
}
