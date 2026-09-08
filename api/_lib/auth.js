// Shared auth helpers for /api serverless handlers. Files under api/_lib/
// are skipped by Vercel's function discovery (underscore prefix), so this
// is import-only — never deployed as a route.
//
// Every function here VERIFIES the access token against Supabase rather than
// reading it. The previous version base64-decoded the JWT payload and trusted
// whatever it found, which meant `{"email":"<admin>"}` with no signature was
// enough to pass requireAdmin — and the admin address was public, because it
// is read from a VITE_-prefixed variable that Vite compiles into the client
// bundle. Anyone could list every user's email. Decoding is not verifying.

import { createClient } from "@supabase/supabase-js";

// One client per warm lambda. createClient does no I/O, but there is no
// reason to rebuild it per request either.
let cached = null;
function serviceClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

export function bearerToken(req) {
  const header = req.headers.authorization || "";
  if (!/^Bearer\s+/i.test(header)) return "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

// Returns { id, email } for a valid token, or null. Never throws.
export async function verifyUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const client = serviceClient();
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: (data.user.email || "").toLowerCase() };
  } catch {
    return null;
  }
}

// Verify, or send the response and return null. Callers must AWAIT this and
// `return` when it gives back null.
export async function requireUser(req, res) {
  if (!serviceClient()) {
    res.status(500).json({ error: "Server misconfigured: missing Supabase env vars" });
    return null;
  }
  const user = await verifyUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in first." });
    return null;
  }
  return user;
}

// The deploy owner. Prefer ADMIN_EMAIL: it is server-only, where
// VITE_ADMIN_EMAIL is compiled into the client bundle and therefore public.
// VITE_ADMIN_EMAIL stays as a fallback so an existing deploy keeps working
// until the new variable is set.
export function adminEmail() {
  return (process.env.ADMIN_EMAIL || process.env.VITE_ADMIN_EMAIL || "").toLowerCase();
}

export function isAdmin(user) {
  const admin = adminEmail();
  return !!admin && !!user?.email && user.email === admin;
}

// Verify AND check the caller is the admin. Await it; `return` on null.
export async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!adminEmail()) {
    res.status(500).json({ error: "ADMIN_EMAIL not configured" });
    return null;
  }
  if (!isAdmin(user)) {
    res.status(403).json({ error: "Admin only" });
    return null;
  }
  return user;
}
