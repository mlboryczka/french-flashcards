// The guards on every endpoint that spends money.
//
// Written from the requirement, not the implementation: the requirement is
// "a caller without a verified session cannot cause an Anthropic request",
// so the check counts outbound calls to api.anthropic.com rather than
// inspecting how the handler decided. Three of these endpoints previously
// billed the deploy owner for any caller — /api/review-answer for a caller
// with no session at all.

import { checker } from "../check.mjs";

const ck = checker();

// Point Supabase at a closed port. Token verification then genuinely fails,
// which is what an invalid token does — no mock standing in for it.
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.ADMIN_EMAIL = "owner@example.com";
process.env.ANTHROPIC_API_KEY = "sk-ant-server-key-must-never-be-spent-by-others";

// A stand-in for Anthropic that counts what reaches it. The SDK reads
// ANTHROPIC_BASE_URL, so every billable call lands here and nowhere else.
//
// This replaced a counter wrapped around globalThis.fetch, which the SDK
// never calls: it reported "0 Anthropic calls" while a request was going
// out, and the suite passed with the auth hole put back on purpose.
import { createServer } from "node:http";

let anthropicCalls = 0;
const anthropic = createServer((req, res) => {
  anthropicCalls++;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: '{"verdict":"accept","reasoning":"ok"}' }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;

// Token verification fails here by genuinely failing to reach Supabase, and
// @supabase/auth-js logs the resulting network error. That noise is the
// expected path, so mute it — an unexpected failure still shows as a ✗.
const realError = console.error;
console.error = (...a) => {
  const first = String(a[0] ?? "");
  if (/fetch failed|ECONNREFUSED|bad port|AuthRetryableFetchError/i.test(first)) return;
  realError(...a);
};
process.on("unhandledRejection", () => {});

function fakeRes() {
  const r = { code: 0, body: null, ended: false };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  return r;
}
const post = (headers, body) => ({ method: "POST", headers, body, query: {} });

const SPENDERS = [
  ["/api/chat", "../../api/chat.js", { messages: [{ role: "user", content: "hi" }] }],
  ["/api/review-answer", "../../api/review-answer.js",
   { user_answer: "a hill", expected_answer: "a hill", card_id: "une colline" }],
  ["/api/split-senses", "../../api/split-senses.js",
   { cards: [{ row_id: "1", front: "les frais", back: "the costs; fresh" }] }],
  ["/api/cahier-parse", "../../api/cahier-parse.js", { text: "bonjour = hello" }],
];

console.log("\n  no session: the endpoint refuses, and nothing is billed");
for (const [name, path, body] of SPENDERS) {
  const { default: handler } = await import(path);
  const before = anthropicCalls;

  const anon = fakeRes();
  await handler(post({}, body), anon);
  ck(`${name} refuses a caller with no token`,
     (anon.code === 401 || anon.code === 500) && !!anon.body?.error && !anon.body?.verdict,
     `HTTP ${anon.code} ${JSON.stringify(anon.body).slice(0, 80)}`);

  const forged = fakeRes();
  // A JWT whose payload decodes to the admin. This exact shape used to pass:
  // the old auth helper base64-decoded the payload and trusted it.
  const payload = Buffer.from(
    JSON.stringify({ sub: "attacker", email: "owner@example.com" })
  ).toString("base64url");
  await handler(post({ authorization: `Bearer h.${payload}.nosignature` }, body), forged);
  ck(`${name} refuses a forged admin token`, forged.code === 401 || forged.code === 500,
     `HTTP ${forged.code}`);

  // The one that matters: an unauthenticated caller must not be able to
  // cause a billable request, whatever status code comes back.
  ck(`${name} spent nothing`, anthropicCalls === before,
     `${anthropicCalls - before} Anthropic call(s) reached the API`);
}

console.log("\n  admin-only endpoints refuse a forged admin token too");
for (const [name, path] of [
  ["/api/admin-users", "../../api/admin-users.js"],
  ["/api/parse-corrections", "../../api/parse-corrections.js"],
  ["/api/upload-batches", "../../api/upload-batches.js"],
]) {
  const { default: handler } = await import(path);
  const payload = Buffer.from(
    JSON.stringify({ sub: "attacker", email: "owner@example.com" })
  ).toString("base64url");
  const res = fakeRes();
  await handler(
    { method: "GET", headers: { authorization: `Bearer h.${payload}.nosignature` }, query: {}, body: {} },
    res
  );
  ck(`${name} refuses it`, res.code === 401 || res.code === 403 || res.code === 500,
     `HTTP ${res.code}`);
}

console.log("\n  who pays: the caller, unless they are the deploy owner");
const { resolveAnthropicKey } = await import("../../api/_lib/anthropicKey.js");
const OWNER = { id: "u1", email: "owner@example.com" };
const STUDENT = { id: "u2", email: "student@example.com" };
const USER_KEY = "sk-ant-api03-" + "z".repeat(40);

let r = resolveAnthropicKey({ headers: {} }, STUDENT);
ck("a student with no key is refused", r.code === "byok_required" && r.status === 402,
   `${r.code} / HTTP ${r.status}`);

r = resolveAnthropicKey({ headers: { "x-anthropic-key": USER_KEY } }, STUDENT);
ck("a student's own key is what pays", r.key === USER_KEY && r.payer === "user", r.payer);

r = resolveAnthropicKey({ headers: {} }, OWNER);
ck("the deploy owner falls back to the server key",
   r.key === process.env.ANTHROPIC_API_KEY && r.payer === "server", r.payer);

r = resolveAnthropicKey({ headers: { "x-anthropic-key": USER_KEY } }, OWNER);
ck("the owner's own key still wins over the server's", r.key === USER_KEY, r.payer);

r = resolveAnthropicKey({ headers: { "x-anthropic-key": "not-a-key" } }, STUDENT);
ck("junk is rejected before it reaches Anthropic", r.code === "bad_key" && r.status === 400,
   `${r.code} / HTTP ${r.status}`);

// The server key must never be reachable by claiming to be someone else:
// isAdmin compares against the VERIFIED email, and these are the values a
// handler would pass in.
r = resolveAnthropicKey({ headers: {} }, { id: "u3", email: "Owner@Example.com " });
ck("a near-miss on the owner's address does not get the server key",
   r.code === "byok_required", r.code || r.payer);

anthropic.close();

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
