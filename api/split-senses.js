// Vercel serverless function: POST /api/split-senses
//
// Decides which cards are secretly two cards.
//
// The cahier parser sometimes emits one card for two headwords that share a
// spelling — "les frais" (costs) and "frais" (fresh) become a single card
// backed by "the costs; the expenses; fresh". That card is unstudiable: there
// is no single right answer, so FSRS has nothing to schedule on.
//
// The client shortlists candidates with lib/multiSense (cheap, local, over-
// selects) and sends them here in batches. This endpoint asks Claude to make
// the actual call — split or keep — because getting the FRONT right for each
// sense is the part that needs judgement: the noun keeps its article ("les
// frais"), the adjective doesn't ("frais"), a verb goes to the infinitive.
//
// Nothing is written here. Proposals go back to the client, the user approves
// them, and /api/apply-splits performs the writes.
//
// Request body (JSON):
//   { cards: [{ row_id, front, back, category }, ...] }   // max 25
// Response:
//   { results: [{ row_id, action: "split" | "keep", reason, cards: [...] }] }

import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "./_lib/auth.js";
import { requireAnthropicKey } from "./_lib/anthropicKey.js";

export const MODEL = "claude-opus-5";
export const MAX_CARDS = 25;

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

export const SYSTEM_PROMPT = `You are auditing a French flashcard deck built from a learner's class notebook. Each card has a French front and an English back.

Some cards conflate two DIFFERENT French headwords that happen to share a spelling. The classic case:

  front: "les frais"   back: "the costs; the expenses; fresh"

"les frais" is a plural noun meaning costs/expenses. "frais" is a separate adjective meaning fresh. One card cannot teach both — there is no single correct answer to type — so it must become two cards:

  { front: "les frais",  back: "the costs / the expenses" }
  { front: "frais (adj)", back: "fresh" }

Your job, for each card: decide whether it is ONE headword or SEVERAL, and when it is several, write the correct card for each.

SPLIT when the glosses belong to different words:
- Different parts of speech (a noun gloss and an adjective gloss; a noun and a verb).
- Unrelated meanings that only share a spelling (homographs).

KEEP when the glosses are one word's near-synonyms or shades of one meaning:
- "to unload / to discharge" — one verb, two English renderings.
- "gros, grosse" — one adjective, masculine and feminine.
- "un vendeur / une vendeuse" — one noun, two genders.
- "half; the middle" — genuinely close senses of one noun; keep unless the French really is two words.
- Anything where you are not confident it's two headwords. Keeping a slightly untidy card is much better than inventing a wrong one.

When you split, get the FRONT right for each sense — this is the whole point:
- Nouns carry their article and number as the deck writes them: "les frais", "une colline", "le verre".
- Adjectives are bare and tagged: "frais (adj)", "léger (adj)".
- Verbs are infinitives: "louer", "geler".
- Never leave two split cards with the same front. If you cannot give them distinct, correct fronts, KEEP instead.
- Never put English on the front, and never invent a French word that wasn't implied by the original front.

Backs: use " / " between near-synonyms of the one sense you kept for that card. Never use a semicolon.
Category: keep the original card's category unless the split clearly changes it ("vocab" single words, "expr" multi-word expressions, "gram" grammar, "pron" pronunciation).

Call report_splits exactly once, with one entry for every card you were given, in the order given.`;

export const REPORT_TOOL = {
  name: "report_splits",
  description:
    "Report, for every card you were given, whether it should be split into separate headwords and what those cards should be.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        description: "One entry per input card, in the same order.",
        items: {
          type: "object",
          properties: {
            row_id: { type: "string", description: "The row_id of the card, echoed back exactly." },
            action: {
              type: "string",
              enum: ["split", "keep"],
              description: "\"split\" if this is more than one headword, otherwise \"keep\".",
            },
            reason: {
              type: "string",
              description: "One short sentence the learner will read, saying why.",
            },
            cards: {
              type: "array",
              description:
                "When action is \"split\", the 2+ cards to replace it with. Omit or leave empty when keeping.",
              items: {
                type: "object",
                properties: {
                  front: { type: "string", description: "French side." },
                  back: { type: "string", description: "English side." },
                  category: { type: "string", enum: ["vocab", "expr", "gram", "pron"] },
                },
                required: ["front", "back", "category"],
              },
            },
          },
          required: ["row_id", "action", "reason"],
        },
      },
    },
    required: ["results"],
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // A verified session, and a key of their own to spend. The JWT used to
  // be decoded rather than verified, and the deploy owner's key paid for
  // every caller.
  const user = await requireUser(req, res);
  if (!user) return;
  const apiKey = requireAnthropicKey(req, res, user);
  if (!apiKey) return;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const cards = Array.isArray(body?.cards) ? body.cards.slice(0, MAX_CARDS) : [];
  if (cards.length === 0) {
    return res.status(400).json({ error: "No cards given" });
  }

  const payload = cards.map((c) => ({
    row_id: String(c.row_id),
    front: String(c.front || "").slice(0, 300),
    back: String(c.back || "").slice(0, 300),
    category: String(c.category || "vocab"),
  }));

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_splits" },
      messages: [
        {
          role: "user",
          content:
            "Audit these cards:\n\n" +
            JSON.stringify(payload, null, 2),
        },
      ],
    });

    const call = msg.content.find(
      (b) => b.type === "tool_use" && b.name === "report_splits"
    );
    const raw = Array.isArray(call?.input?.results) ? call.input.results : [];

    // Trust nothing: keep only proposals that name a card we sent, actually
    // produce 2+ cards, and give every card a distinct non-empty front. A
    // malformed split would otherwise become a broken row in the deck.
    const byId = new Map(payload.map((c) => [c.row_id, c]));
    const results = [];
    for (const r of raw) {
      const original = byId.get(String(r?.row_id));
      if (!original) continue;
      const proposed = (Array.isArray(r?.cards) ? r.cards : [])
        .map((c) => ({
          front: String(c?.front || "").trim(),
          back: String(c?.back || "").trim(),
          category: ["vocab", "expr", "gram", "pron"].includes(c?.category)
            ? c.category
            : original.category,
        }))
        .filter((c) => c.front && c.back);
      const fronts = new Set(proposed.map((c) => c.front.toLowerCase()));
      const valid =
        r?.action === "split" && proposed.length >= 2 && fronts.size === proposed.length;
      results.push({
        row_id: original.row_id,
        original,
        action: valid ? "split" : "keep",
        reason: String(r?.reason || "").slice(0, 240),
        cards: valid ? proposed : [],
      });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("split-senses failed:", err);
    const status = err?.status === 429 || err?.status === 529 ? 503 : 500;
    return res.status(status).json({
      error:
        status === 503
          ? "Claude is busy — try that batch again in a moment."
          : "Couldn't audit those cards.",
    });
  }
}
