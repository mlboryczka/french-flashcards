// Vercel serverless function: POST /api/review-answer
//
// Called when a user clicks "My answer should have been accepted".
// Asks Claude Opus to review, and if accepted, auto-inserts the answer
// as an alternate into card_alternates so the matcher accepts it going forward.
//
// Request body:
//   { card_id, direction, french, english, user_answer, expected_answer }
//
// Returns:
//   { ok, verdict: "accept"|"reject"|"uncertain", reasoning: "..." }

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { card_id, direction, french, english, user_answer, expected_answer } =
    req.body || {};

  if (!user_answer || !expected_answer) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
    process.env;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });
  }

  // 1. Ask Claude to review
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
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return res
        .status(502)
        .json({ error: `Anthropic API: ${data.error?.message || "unknown"}` });
    }

    const text = data.content?.[0]?.text || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const verdict = parsed.verdict || "uncertain";
    const reasoning = parsed.reasoning || "";

    // 2. If accepted, auto-insert into card_alternates
    if (verdict === "accept" && card_id && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const insertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/card_alternates`,
          {
            method: "POST",
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              card_id,
              direction: direction || "fr",
              alternate_text: user_answer,
            }),
          }
        );
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          console.error("card_alternates insert failed:", errText);
          // Don't fail the whole request — the verdict is still valid
        }
      } catch (dbErr) {
        console.error("card_alternates insert error:", dbErr);
      }
    }

    return res.status(200).json({ ok: true, verdict, reasoning });
  } catch (err) {
    console.error("review-answer failed:", err);
    return res.status(500).json({ error: err.message });
  }
}
