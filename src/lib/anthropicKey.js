// The user's own Anthropic API key, kept in their browser.
//
// Anything in this app that calls Claude — the tutor, the answer reviewer,
// the cahier parser — spends real money. It used to spend the deploy
// owner's: /api/chat and /api/split-senses took any signed-in caller, and
// /api/review-answer took anyone at all. Now the key that pays is the
// caller's own, and the server refuses (402) without one. The deploy owner
// is the single exception and falls back to the server's key.
//
// Why localStorage and not the database: storing other people's API keys
// makes you their custodian. Here the key never leaves the user's machine
// except as a header on their own requests, so there is nothing on the
// server to leak. The cost is re-entering it per browser.
//
// It IS readable by any script running on this origin, so an XSS on the app
// would expose it — same exposure as the Supabase session token sitting
// beside it. Keys are revocable at console.anthropic.com.

const PREFIX = "anthropic-key:";

// Matches the server's check in api/_lib/anthropicKey.js. Validating here
// too means an obvious typo is caught before it costs a round trip.
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;

export const KEY_HEADER = "x-anthropic-key";

export function looksLikeAnthropicKey(value) {
  return typeof value === "string" && KEY_SHAPE.test(value.trim());
}

export function readKey(userId) {
  if (!userId) return "";
  try {
    return localStorage.getItem(PREFIX + userId) || "";
  } catch {
    // Private windows and blocked site data both throw here. No key is a
    // valid state — the endpoints say so clearly.
    return "";
  }
}

export function writeKey(userId, key) {
  if (!userId) return false;
  try {
    localStorage.setItem(PREFIX + userId, key.trim());
    return true;
  } catch {
    return false;
  }
}

export function clearKey(userId) {
  if (!userId) return;
  try {
    localStorage.removeItem(PREFIX + userId);
  } catch {}
}

export function hasKey(userId) {
  return !!readKey(userId);
}

// Headers to merge into any fetch that reaches an endpoint which calls
// Claude. Empty when there is no key — the server then answers 402 with a
// message telling the user to add one, which is a better prompt than
// anything the client could guess at.
export function keyHeaders(userId) {
  const key = readKey(userId);
  return key ? { [KEY_HEADER]: key } : {};
}

// Show a key without showing it: sk-ant-…last four.
export function maskKey(key) {
  if (!key) return "";
  const t = key.trim();
  return t.length <= 12 ? "sk-ant-…" : `sk-ant-…${t.slice(-4)}`;
}

// The server sends this code with a 402 when there is nothing to pay with.
export const BYOK_REQUIRED = "byok_required";
export const BAD_KEY = "bad_key";
