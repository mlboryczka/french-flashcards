// Vercel serverless function: POST /api/chat
//
// A French tutor chat. The user asks about a word, phrase, or grammar
// point; Claude explains it and — when there's something worth drilling —
// proposes flashcards via a tool call. The client renders those proposals
// as "Add to deck" chips; nothing is written to user_cards here.
//
// Keeping the write on the client matters: user_cards is RLS-protected
// (migration_003), so the insert runs as the signed-in user with their own
// anon-key session. This endpoint never touches the service role key and
// so can't write to another user's deck even if the JWT check were wrong.
//
// Request body (JSON):
//   {
//     messages: [{ role: "user" | "assistant", content: "..." }, ...],
//     recentFronts?: ["la moitié", ...]   // for duplicate awareness
//   }
//
// Response:
//   { reply: "<prose explanation>", cards: [{ front, back, category, note }] }
//   or { error: "..." } on 4xx/5xx
//
// Who pays: the caller's own Anthropic key, sent in an x-anthropic-key
// header and never stored server-side. Without one this answers 402. The
// deploy owner (ADMIN_EMAIL) falls back to the server's ANTHROPIC_API_KEY.
// See api/_lib/anthropicKey.js.
//
// Environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — to VERIFY the caller's token
//   ADMIN_EMAIL                             — the one account that may fall back
//   ANTHROPIC_API_KEY                       — optional, owner's requests only

import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "./_lib/auth.js";
import { requireAnthropicKey } from "./_lib/anthropicKey.js";

// Opus 5 thinks before it answers, so a tutoring question does not fit in
// Vercel's default function timeout. Without this the request is killed
// mid-thought and the client shows its 504 message.
export const config = { maxDuration: 60 };

const MODEL = "claude-opus-5";

// Cost guardrails. The client sends the whole visible thread on every turn,
// so without a cap a long session grows the bill quadratically.
const MAX_TURNS = 20;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_RECENT_FRONTS = 60;

const SYSTEM_PROMPT = `You are a French tutor helping an English-speaking learner who keeps a spaced-repetition flashcard deck.

When the learner asks about a word, phrase, or grammar point, explain it the way a good tutor would:
- What it means, and the register (formal / everyday / slang / dated).
- Grammatical gender for nouns, and the article that goes with it.
- One natural example sentence in French with its English translation.
- Any false-friend or common-mistake warning that actually applies.
- If they give you an English word with several distinct French equivalents, distinguish them rather than picking one arbitrarily.

Keep it tight — a short paragraph or a few bullets, not an essay. Answer in English; French for the French.

## Proposing flashcards

When the exchange contains something worth drilling, call the propose_flashcards tool. Guidelines:
- Write the explanation as text FIRST, then call the tool. Never call the tool without explaining.
- The front is French, the back is English. Match the deck's existing style: bare vocabulary items carry a gendered article ("une colline"), adjectives are tagged ("ennuyeux (adj)"), verbs stay in the infinitive ("décharger").
- The back is a short gloss, not a sentence — "a hill", "to unload / to discharge". Use " / " to separate near-synonyms.
- Propose 1-4 cards. One good card beats four redundant ones. A phrase the learner asked about is one card; don't also split out each word in it.
- category: "vocab" for single words, "expr" for multi-word expressions and idioms, "gram" for grammar patterns, "pron" for pronunciation points.
- The note field is a one-line reason this card is worth having. It is shown to the learner and is not stored.
- If the learner is just chatting, asking a follow-up, or the answer has nothing drillable in it, don't call the tool at all.
- You may be shown some fronts already in their deck. Don't propose a card that duplicates one of those; say it's already in the deck instead.`;

const PROPOSE_TOOL = {
  name: "propose_flashcards",
  description:
    "Propose flashcards for the learner to add to their French deck. Call this only when the conversation contains something worth drilling, and only after explaining it in text.",
  input_schema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        description: "The proposed cards, 1-4 of them.",
        items: {
          type: "object",
          properties: {
            front: {
              type: "string",
              description:
                "The French side, e.g. 'une colline' or 'ennuyeux (adj)'.",
            },
            back: {
              type: "string",
              description:
                "The English gloss, e.g. 'a hill' or 'boring / annoying'.",
            },
            category: {
              type: "string",
              enum: ["vocab", "expr", "gram", "pron"],
              description: "Which part of the deck this belongs to.",
            },
            note: {
              type: "string",
              description:
                "One line on why this card earns its place. Shown to the learner, not stored.",
            },
          },
          required: ["front", "back", "category"],
        },
      },
    },
    required: ["cards"],
  },
};

// Trim the thread to something bounded before it reaches the API. Keeps the
// most recent turns — the front of a long conversation matters least for a
// lookup, and dropping it keeps latency and cost flat as the session runs on.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const m of raw) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content.trim() : "";
    if (!content) continue;
    cleaned.push({ role, content: content.slice(0, MAX_CHARS_PER_MESSAGE) });
  }
  const trimmed = cleaned.slice(-MAX_TURNS);
  // The Messages API requires the first message to be from the user.
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Signed in, with something to pay with. The token is verified against
  // Supabase, not just decoded — and the key that pays is the caller's own
  // unless the caller is the deploy owner.
  const user = await requireUser(req, res);
  if (!user) return;
  const apiKey = requireAnthropicKey(req, res, user);
  if (!apiKey) return;

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length) {
    return res.status(400).json({ error: "No message to answer." });
  }

  // Fronts already in the deck, so Claude can say "you already have that"
  // instead of proposing a duplicate the upsert would silently merge.
  const recentFronts = Array.isArray(req.body?.recentFronts)
    ? req.body.recentFronts
        .filter((f) => typeof f === "string" && f.trim())
        .slice(0, MAX_RECENT_FRONTS)
    : [];

  const system = recentFronts.length
    ? `${SYSTEM_PROMPT}\n\n## Already in their deck\n\n${recentFronts.join(", ")}`
    : SYSTEM_PROMPT;

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools: [PROPOSE_TOOL],
      messages,
    });

    let reply = "";
    let cards = [];
    for (const block of response.content || []) {
      if (block.type === "text") {
        reply += block.text;
      } else if (block.type === "tool_use" && block.name === "propose_flashcards") {
        // Tool inputs are already parsed objects from the SDK, but the model
        // decides the shape — validate rather than trusting it into the DB.
        const proposed = Array.isArray(block.input?.cards) ? block.input.cards : [];
        cards = proposed
          .filter((c) => c && typeof c.front === "string" && typeof c.back === "string")
          .slice(0, 4)
          .map((c) => ({
            front: c.front.trim(),
            back: c.back.trim(),
            category: ["vocab", "expr", "gram", "pron"].includes(c.category)
              ? c.category
              : "vocab",
            note: typeof c.note === "string" ? c.note.trim() : "",
          }))
          .filter((c) => c.front && c.back);
      }
    }

    if (!reply.trim() && !cards.length) {
      return res.status(502).json({ error: "The tutor returned an empty response. Try rephrasing." });
    }

    return res.status(200).json({ ok: true, reply: reply.trim(), cards });
  } catch (err) {
    console.error("chat failed:", err);
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Rate limited — give it a moment and try again." });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      // Almost always the user's own key now, so say which one is wrong.
      return res.status(401).json({
        error: "Anthropic rejected that API key. Check it in your profile menu.",
        code: "bad_key",
      });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Anthropic API: ${err.message}` });
    }
    return res.status(500).json({ error: err.message || "Chat failed" });
  }
}
