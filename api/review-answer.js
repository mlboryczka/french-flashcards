// Vercel serverless function: POST /api/review-answer
//
// Called when a user clicks "My answer should have been accepted".
// Asks Claude to review, and if accepted, records the answer as an alternate
// in card_alternates so the matcher accepts it going forward.
//
// Request body:
//   { card_id, direction, french, english, user_answer, expected_answer,
//     force? }
//
// Returns:
//   { ok, verdict: "accept"|"reject"|"uncertain", reasoning: "..." }
//
// This route used to have NO authentication of any kind. Anyone who could
// reach the URL could spend the deploy owner's Anthropic credit and write
// rows with the service role key. It now requires a verified session, and
// the Anthropic key that pays is the caller's own unless they are the
// deploy owner.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { requireUser } from "./_lib/auth.js";
import { requireAnthropicKey } from "./_lib/anthropicKey.js";

export const config = { maxDuration: 60 };

const MODEL = "claude-opus-5";

// Record an accepted answer as an alternate for THIS user.
//
// card_alternates was global: no user_id, written with the service role,
// read by every client with no filter. One person's accepted answer silently
// became everyone's. migration_008 adds the column; the write and the read
// are both scoped to the owner now.
async function recordAlternate({ userId, card_id, direction, user_answer }) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!card_id || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.from("card_alternates").upsert(
    {
      user_id: userId,
      card_id,
      direction: direction || "fr",
      alternate_text: user_answer,
    },
    { onConflict: "user_id,card_id,direction,alternate_text" }
  );
  // Don't fail the request over it — the verdict is still worth returning.
  if (error) console.error("card_alternates write failed:", error.message);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const {
    card_id,
    direction,
    french,
    english,
    user_answer,
    expected_answer,
    force,
  } = req.body || {};

  if (!user_answer || !expected_answer) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // "Accept anyway" — the user overriding a reject. This is their own deck
  // and their own alternate, so it needs no model call and costs nothing.
  //
  // The client has always sent this flag and the server has always ignored
  // it: the override re-ran the same review, and when Claude rejected again
  // nothing was written — while the UI said "this answer will be
  // remembered". It wasn't. It is now.
  if (force === true) {
    await recordAlternate({ userId: user.id, card_id, direction, user_answer });
    return res.status(200).json({
      ok: true,
      verdict: "accept",
      reasoning: "Accepted at your request.",
      forced: true,
    });
  }

  const apiKey = requireAnthropicKey(req, res, user);
  if (!apiKey) return;

  const shownSide = direction === "fr" ? "French" : "English";
  const expectedSide = direction === "fr" ? "English" : "French";
  const prompt = `You are reviewing a French learner's flashcard answer. Decide whether their answer should be accepted as equivalent to the expected answer.

The card showed the ${shownSide} side: "${french || ""}"
The expected ${expectedSide} answer was: "${expected_answer}"
The user typed: "${user_answer}"

Consider:
- Synonyms and near-synonyms (e.g., "instead of" vs "in place of", "salesperson" vs "salesman")
- Minor phrasing variations that preserve meaning
- Whether the user's answer demonstrates correct understanding
- For French answers, grammatical gender must be correct (un vs une, le vs la)
- For English answers, articles (a/an/the) are interchangeable

Do NOT accept:
- Answers in the wrong language
- Answers with wrong grammatical gender in French
- Answers that mean something different
- Answers that are partially correct but miss the core meaning

Respond with ONLY a JSON object, no other text:
{"verdict": "accept" | "reject" | "uncertain", "reasoning": "one sentence explanation"}`;

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Guarded: an unparseable reply used to throw and surface as a 500 whose
    // message was a JSON syntax error.
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("review-answer: unparseable verdict:", text.slice(0, 200));
    }
    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({
        ok: true,
        verdict: "uncertain",
        reasoning: "Couldn't read a clear verdict — use “Accept anyway” if you're sure.",
      });
    }

    const verdict = ["accept", "reject", "uncertain"].includes(parsed.verdict)
      ? parsed.verdict
      : "uncertain";
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

    if (verdict === "accept") {
      await recordAlternate({ userId: user.id, card_id, direction, user_answer });
    }

    return res.status(200).json({ ok: true, verdict, reasoning });
  } catch (err) {
    console.error("review-answer failed:", err);
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({
        error: "Anthropic rejected that API key. Check it in your profile menu.",
        code: "bad_key",
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Rate limited — give it a moment." });
    }
    return res.status(500).json({ error: err.message });
  }
}
