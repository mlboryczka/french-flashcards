// Which Anthropic account pays for this request.
//
// The rule: you bring your own key, or you don't get to spend. The one
// exception is the deploy owner, whose requests fall back to the server's
// ANTHROPIC_API_KEY so their own use of the app is unchanged.
//
// Before this, /api/chat and /api/split-senses accepted any signed-in caller
// and /api/review-answer accepted anyone at all — all three billing the
// deploy owner's Anthropic account. A JWT is not a spending limit.
//
// The key arrives per-request in a header and is never written down: not to
// a database, not to a log, not to an error message. It exists for the
// lifetime of the request and goes out again in the Authorization header of
// the call to Anthropic. The client keeps it in the user's own browser.

import { isAdmin } from "./auth.js";

export const KEY_HEADER = "x-anthropic-key";

// Anthropic keys are `sk-ant-` followed by an opaque token. Checking the
// shape here means an obviously-wrong value fails fast with a message that
// says so, instead of becoming a 401 from Anthropic that reads like the
// tutor being broken.
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;

export function looksLikeAnthropicKey(value) {
  return typeof value === "string" && KEY_SHAPE.test(value.trim());
}

// Returns { key, payer } or { error, code, status }.
export function resolveAnthropicKey(req, user) {
  const supplied = String(req.headers[KEY_HEADER] || "").trim();

  if (supplied) {
    if (!looksLikeAnthropicKey(supplied)) {
      return {
        error:
          "That doesn't look like an Anthropic API key. They start with \"sk-ant-\" and come from console.anthropic.com.",
        code: "bad_key",
        status: 400,
      };
    }
    return { key: supplied, payer: "user" };
  }

  if (isAdmin(user) && process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, payer: "server" };
  }

  return {
    error:
      "Connect your own Claude account to use this. Add an Anthropic API key in your profile menu — it stays in this browser and is only used for your own requests.",
    code: "byok_required",
    // 402 rather than 401: you ARE signed in, you just have nothing to pay
    // with. The client tells the two apart to decide what to prompt for.
    status: 402,
  };
}

// Resolve, or send the response and return null. Callers `return` on null.
export function requireAnthropicKey(req, res, user) {
  const result = resolveAnthropicKey(req, user);
  if (result.error) {
    res.status(result.status).json({ error: result.error, code: result.code });
    return null;
  }
  return result.key;
}
