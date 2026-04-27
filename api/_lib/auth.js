// Shared auth helpers for /api serverless handlers. Files under api/_lib/
// are skipped by Vercel's function discovery (underscore prefix), so this
// is import-only — never deployed as a route.

function decodeJwtPayload(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function extractEmailFromJwt(authHeader) {
  return decodeJwtPayload(authHeader)?.email || null;
}

export function extractUserIdFromJwt(authHeader) {
  return decodeJwtPayload(authHeader)?.sub || null;
}

// Verify the caller is the configured admin. Returns the JWT email on
// success, or sends a response and returns null on failure — caller should
// `return null` from the handler when this returns null.
export function requireAdmin(req, res) {
  const adminEmail = (process.env.VITE_ADMIN_EMAIL || "").toLowerCase();
  if (!adminEmail) {
    res.status(500).json({ error: "VITE_ADMIN_EMAIL not configured" });
    return null;
  }
  const userEmail = extractEmailFromJwt(req.headers.authorization || "");
  if (!userEmail || userEmail.toLowerCase() !== adminEmail) {
    res.status(403).json({ error: "Admin only" });
    return null;
  }
  return userEmail;
}
