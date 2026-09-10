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
//     context?: {
//       currentCard?:  { front, back, missed },   // the card on screen
//       relatedCards?: [{ front, back }],         // deck matches for the question
//       recentMisses?: [{ front, back }],         // what they keep getting wrong
//     }
//   }
//
// Response: an SSE stream of JSON events, one per `data:` line —
//   { type: "text",  delta: "..." }              prose, as it is generated
//   { type: "cards", cards: [...] }              card proposals, once complete
//   { type: "done" }
//   { type: "error", error: "...", code?: "..." }
// Failures BEFORE the stream opens — not signed in, no key, empty body —
// answer in JSON with a 4xx status, so the client's key prompt still fires on
// a 402. A key Anthropic rejects can only be discovered once generation has
// started, so that one arrives as an error EVENT carrying the same code.
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

// The answer streams, so the wall-clock limit is no longer a cliff — but the
// function still needs room. Vercel's default is 10s.
export const config = { maxDuration: 60 };

// Sonnet rather than Opus. Answering "what's the difference between amener and
// apporter" is not a hard inference problem, and this endpoint is on the
// latency path — you are waiting at the panel for it.
const MODEL = "claude-sonnet-5";

// Effort is a CEILING on how much reasoning the model may spend; adaptive
// thinking then varies underneath it, per question. A lookup costs almost
// nothing while a nuance question still gets more thought than the lookup did
// — compute matched to the question, decided by something that has read the
// question rather than by a router guessing from its surface form.
//
// This used to be absent, which is not the same as off: with no `thinking` and
// no `output_config`, Opus 5 runs adaptive thinking at effort HIGH, so every
// vocabulary lookup was getting a maximum-depth reasoning pass. That was the
// bulk of the latency, and it read as "the tutor is slow".
const EFFORT = "low";

// Cost guardrails. The client sends the whole visible thread on every turn,
// so without a cap a long session grows the bill quadratically.
const MAX_TURNS = 20;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_CONTEXT_CARDS = 12;

// Kept deliberately short and free of a per-answer checklist. The previous
// version demanded register, gender, an example sentence and a false-friend
// warning on EVERY answer, which is why a two-word lookup came back as five
// bullets: a checklist cannot be proportional to the question.
//
// This text is the cached prefix — it must not carry anything that varies per
// request. Deck context goes in the user turn instead; see buildContextBlock.
const SYSTEM_PROMPT = `You are helping an English-speaking learner of French. They keep a spaced-repetition flashcard deck and are asking you about something they've hit.

Answer the question that was asked, at the length it deserves. A word lookup is a line. A question about a distinction between two words is a short paragraph. Nobody wants a lesson they didn't ask for.

Add register, gender, an example sentence, or a false-friend warning ONLY when it changes the answer — not as a matter of routine. If the learner's question rests on a wrong assumption, say so first.

Write plain prose. No markdown, no bullet lists, no bold — it is rendered as raw text and the asterisks show. French in French, everything else in English.

## Context you may be given

The user turn may carry a "[Context]" block: the card they are looking at, cards already in their deck that relate to the question, and cards they have recently got wrong. Use it — refer to their actual cards, tell them when they already have something, point out when your answer contradicts a card they own. Never mention the block itself or that you were given it.

## Proposing flashcards

Call propose_flashcards when the exchange contains something worth drilling.
- Explain in text FIRST, then call the tool. Never call it without explaining.
- The front is French, the back is English. Bare vocabulary carries a gendered article ("une colline"), adjectives are tagged ("ennuyeux (adj)"), verbs stay in the infinitive ("décharger").
- The back is a short gloss, not a sentence — "a hill", "to unload / to discharge". Use " / " between near-synonyms.
- One card per thing to learn. Propose 1-4; one good card beats four redundant ones. A phrase they asked about is one card — don't also split out its words.
- Never propose a card whose front teaches two different words (les frais "costs" and frais "fresh" are two cards, not one) — there'd be no single right answer to type.
- category: "vocab" single words, "expr" multi-word expressions and idioms, "gram" grammar patterns, "pron" pronunciation points.
- note: one line on why this card earns its place. Shown to the learner, not stored.
- If a card in their deck already covers it, say so instead of proposing a duplicate.
- If they're just chatting, or nothing in the answer is drillable, don't call the tool at all.`;

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

function cardLine(c) {
  const front = String(c?.front ?? "").trim().slice(0, 200);
  const back = String(c?.back ?? "").trim().slice(0, 200);
  if (!front) return "";
  return back ? `${front} — ${back}` : front;
}

function cardList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(cardLine).filter(Boolean).slice(0, MAX_CONTEXT_CARDS);
}

// Render the deck context as a block prefixed to the learner's own question.
//
// It goes in the USER TURN, not appended to the system prompt. Caching is a
// prefix match, so per-request text in the system prompt would invalidate the
// cached prefix every single turn — which is what the previous version did,
// concatenating the deck onto the end of SYSTEM_PROMPT. Sonnet also does not
// accept mid-conversation system messages, so the user turn is the channel.
//
// Only the LAST user message is augmented, and the client never sees the
// augmented copy, so context is rebuilt fresh each turn and never piles up.
function buildContextBlock(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = [];

  const cur = ctx.currentCard;
  if (cur && typeof cur === "object" && cardLine(cur)) {
    parts.push(
      `Card on screen: ${cardLine(cur)}${cur.missed ? " (they just got this wrong)" : ""}`
    );
  }

  const related = cardList(ctx.relatedCards);
  if (related.length) {
    parts.push(`Cards already in their deck related to this:\n${related.join("\n")}`);
  }

  const misses = cardList(ctx.recentMisses);
  if (misses.length) {
    parts.push(`Cards they have recently got wrong:\n${misses.join("\n")}`);
  }

  if (!parts.length) return "";
  return `[Context]\n${parts.join("\n\n")}\n[/Context]`;
}

// Attach the context to the final user turn, leaving the caller's array alone.
function withContext(messages, contextBlock) {
  if (!contextBlock || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  return [
    ...messages.slice(0, -1),
    { role: "user", content: `${contextBlock}\n\n${last.content}` },
  ];
}

// Validate the model's tool input rather than trusting it toward the DB. The
// client lets the learner edit a proposal before adding it, so this is the
// floor on shape, not on quality.
function normalizeCards(input) {
  const proposed = Array.isArray(input?.cards) ? input.cards : [];
  return proposed
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

  // Everything above can still answer in JSON — including the 402 that makes
  // the client offer its "connect a key" button. From here the stream is open,
  // so failures have to travel as SSE events instead.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Vercel's edge buffers proxied responses by default, which would hold the
    // whole stream until it finished and undo the point of streaming.
    "X-Accel-Buffering": "no",
  });

  // Closing the panel aborts the browser's fetch. Without passing that on, the
  // generation keeps running upstream and keeps spending the caller's credit
  // on an answer nobody will read.
  //
  // This hangs off the RESPONSE, not the request: Vercel parses req.body before
  // the handler runs, so by now the request stream is already destroyed and has
  // emitted its own "close". Listening there would arm nothing.
  let clientGone = false;
  let upstream = null;
  res.on("close", () => {
    if (res.writableEnded) return; // finished normally
    clientGone = true;
    upstream?.abort();
  });

  const send = (event) => {
    if (clientGone) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const anthropic = new Anthropic({ apiKey });
    const stream = anthropic.messages.stream({
      model: MODEL,
      // Generous because streaming took the HTTP timeout off the table, and
      // because this ceiling covers the thinking blocks as well as the answer
      // and the tool call. The prompt is what keeps answers short; a low
      // max_tokens would only truncate one mid-sentence.
      max_tokens: 8000,
      // Explicit rather than implied. An absent `thinking` is not "off" — it is
      // the model's default, and that default has already changed once
      // underneath this file.
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      // The system prompt and tool schema are the only stable prefix, so the
      // breakpoint goes at the end of it.
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [PROPOSE_TOOL],
      messages: withContext(messages, buildContextBlock(req.body?.context)),
    });
    upstream = stream;

    stream.on("text", (delta) => send({ type: "text", delta }));

    const final = await stream.finalMessage();

    let cards = [];
    for (const block of final.content || []) {
      if (block.type === "tool_use" && block.name === "propose_flashcards") {
        cards = normalizeCards(block.input);
      }
    }
    if (cards.length) send({ type: "cards", cards });

    send({ type: "done" });
    res.end();
  } catch (err) {
    // An abort we asked for is the expected end of a cancelled request, and
    // there is nobody left to tell either way.
    if (clientGone) return res.end();
    console.error("chat failed:", err);

    let message = err?.message || "Chat failed";
    let code = "";
    if (err instanceof Anthropic.RateLimitError) {
      message = "Rate limited — give it a moment and try again.";
    } else if (err instanceof Anthropic.AuthenticationError) {
      // Almost always the caller's own key. It cannot be checked before the
      // request, so unlike the missing-key 402 this arrives mid-stream — the
      // code is what lets the client offer the same "fix your key" action.
      message = "Anthropic rejected that API key. Check it in your profile menu.";
      code = "bad_key"; // matches resolveAnthropicKey's code for a rejected key
    } else if (err instanceof Anthropic.APIError) {
      message = `Anthropic API: ${err.message}`;
    }
    send({ type: "error", error: message, ...(code ? { code } : null) });
    res.end();
  }
}
