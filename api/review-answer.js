// Vercel serverless function: POST /api/review-answer
// Called by the client after a feedback submission is inserted into Supabase.
// Fetches the row, asks Claude whether the user's answer should have been
// accepted, then updates the row with the verdict.
//
// Environment variables required (set in Vercel dashboard):
//   ANTHROPIC_API_KEY            — server-side, NOT prefixed with VITE_
//   SUPABASE_URL                 — same as VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY    — service role, NOT the anon key
//
// The service role key bypasses RLS so the function can update any row
// regardless of which user submitted it.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { submissionId } = req.body || {};
  if (!submissionId) {
    return res.status(400).json({ error: "Missing submissionId" });
  }

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured — missing env vars" });
  }

  // 1. Fetch the submission row using the service role key
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  const fetchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_submissions?id=eq.${submissionId}&select=*`,
    { headers: sbHeaders }
  );
  const rows = await fetchRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(404).json({ error: "Submission not found" });
  }
  const row = rows[0];

  // 2. Construct the prompt for Claude
  const shownSide = row.direction === "fr" ? "French" : "English";
  const expectedSide = row.direction === "fr" ? "English" : "French";
  const prompt = `You are reviewing a French learner's flashcard answer. Decide whether their answer should be accepted as equivalent to the expected answer.

The card showed the ${shownSide} side: "${row.card_front}"
The expected ${expectedSide} answer was: "${row.card_back}"
The user typed: "${row.user_answer}"

Consider:
- Synonyms and near-synonyms (e.g., "salesperson" vs "salesman/saleswoman", "couch" vs "sofa")
- Minor phrasing variations that preserve meaning
- Whether the user's answer demonstrates correct understanding of the word
- For French answers, grammatical gender must be correct (un vs une, le vs la matter)
- For English answers, articles (a/an/the) are interchangeable

Do NOT accept:
- Answers in the wrong language
- Answers with wrong grammatical gender in French
- Answers that mean something different
- Answers that are partially correct but miss the core meaning

Respond with ONLY a JSON object, no other text:
{"verdict": "accept" | "reject" | "uncertain", "reasoning": "one sentence explanation"}`;

  // 3. Call the Anthropic API
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
        model: "claude-sonnet-4-5",
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
      // Strip any code fences the model might add
      const cleaned = text.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(cleaned);
        if (["accept", "reject", "uncertain"].includes(parsed.verdict)) {
          verdict = parsed.verdict;
          reasoning = parsed.reasoning || "";
        }
      } catch (parseErr) {
        reasoning = `Parse error: ${text.slice(0, 200)}`;
      }
    }
  } catch (err) {
    console.error("LLM call failed:", err);
    reasoning = err.message;
  }

  // 4. Update the submission row with the verdict
  const updateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_submissions?id=eq.${submissionId}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ llm_verdict: verdict, llm_reasoning: reasoning }),
    }
  );
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error("Supabase update failed:", errText);
  }

  return res.status(200).json({ verdict, reasoning });
}
