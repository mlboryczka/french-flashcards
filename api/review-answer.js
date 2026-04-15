// Vercel serverless function: POST /api/review-answer
//
// Called when a user clicks "My answer should have been accepted".
// Inserts a feedback_submissions row, asks Claude to review, updates
// the row with the verdict, and returns the result.
//
// Request body:
//   { card_id, direction, french, english, user_answer, expected_answer }
//
// Environment variables:
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { card_id, direction, french, english, user_answer, expected_answer } =
    req.body || {};

  if (!card_id || !user_answer || !expected_answer) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
    process.env;
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res
      .status(500)
      .json({ error: "Server misconfigured — missing env vars" });
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  // Extract user_id from the Authorization bearer token (Supabase JWT)
  let userId = null;
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const payload = JSON.parse(
        Buffer.from(authHeader.split(".")[1], "base64").toString()
      );
      userId = payload.sub || null;
    } catch {}
  }

  // 1. Insert the submission row
  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_submissions`,
    {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        user_id: userId,
        card_id,
        direction: direction || "fr",
        card_front: french || "",
        card_back: english || "",
        user_answer,
      }),
    }
  );

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    console.error("Insert failed:", errText);
    return res.status(500).json({ error: "Failed to save submission" });
  }

  const inserted = await insertRes.json();
  const submissionId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;

  // 2. Ask Claude to review
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

  let verdict = "uncertain";
  let reasoning = "LLM review failed";

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      console.error("Anthropic API error:", data);
      reasoning = `API error: ${data.error?.message || "unknown"}`;
    } else {
      const text = data.content?.[0]?.text || "";
      const cleaned = text.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(cleaned);
        if (["accept", "reject", "uncertain"].includes(parsed.verdict)) {
          verdict = parsed.verdict;
          reasoning = parsed.reasoning || "";
        }
      } catch {
        reasoning = `Parse error: ${text.slice(0, 200)}`;
      }
    }
  } catch (err) {
    console.error("LLM call failed:", err);
    reasoning = err.message;
  }

  // 3. Update the row with the verdict
  if (submissionId) {
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback_submissions?id=eq.${submissionId}`,
      {
        method: "PATCH",
        headers: {
          ...sbHeaders,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ llm_verdict: verdict, llm_reasoning: reasoning }),
      }
    );
    if (!updateRes.ok) {
      console.error("Update failed:", await updateRes.text());
    }
  }

  return res.status(200).json({ ok: true, verdict, reasoning });
}
