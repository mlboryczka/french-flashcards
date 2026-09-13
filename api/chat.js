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
//     messages: [
//       { role: "user", content: "...", about?: "..." },  // about: the card's prompt when asked
//       { role: "assistant", content: "...", cards?: [{ front, back }] },
//     ],
//     context?: {
//       currentCard?: {                           // the card on screen
//         prompt, answer,                         // as the card shows them
//         answered,                               // has the answer been shown yet
//         result?, typed?,                        // this attempt, after a typed answer
//         missedLastTime,
//       },
//       relatedCards?: [{ front, back }],         // deck matches for the question
//       recentMisses?: [{ front, back }],         // misses that bear on the question
//     }
//   }
//
// Response: an SSE stream of JSON events, one per `data:` line —
//   { type: "text",  delta: "..." }              prose, as it is generated
//   { type: "cards", cards: [...] }              card proposals, once complete
//   { type: "done" }                            the answer is complete
//   { type: "error", error: "...", code?: "..." }
// A stream that ends without "done" was cut off — the function ran out of
// time, or the connection dropped — and the client says so.
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
//
// Past the cap the oldest turns go TRIM_STEP at a time rather than one per
// turn. The conversation is cached (see the breakpoint in the handler), and
// a window sliding by one message changes the start of the prefix on every
// request, which would miss the cache every time.
const MAX_TURNS = 20;
const TRIM_STEP = 10;
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

Write plain prose. No bullet lists, headings or tables — they are not rendered and the symbols show. Italics or bold on a French word are fine, sparingly. French in French, everything else in English.

## Context you may be given

The latest user turn may carry a "[Context]" block: the card on their screen, cards already in their deck that relate to the question, and recent misses that bear on it. Use it — refer to their actual cards, tell them when they already have something, point out when your answer contradicts a card they own. Never mention the block itself or that you were given it.

Earlier turns may carry bracketed notes — the card that was on screen when they asked, the cards you proposed. They are for your reference. Never write notes like them yourself.

## The card on screen

They study by recalling the answer before it is shown, and the app records each attempt to decide when they see the card again. So:
- If the card has NOT been answered yet, never state the expected answer, or a form of it, or a word that gives it away — not even if they ask outright. Help them recall it instead: the gender, a related word, a context it turns up in, the first letter. If they want the answer itself, tell them to reveal it on the card.
- If they typed an answer, you are told what they typed and how it was marked. When they ask why, compare what they wrote with the expected answer — that is the question.

## Proposing flashcards

Call propose_flashcards when the exchange contains something worth drilling.
- Explain in text FIRST, then call the tool. Never call it without explaining.
- Every card is a thing to produce: the learner sees one side and types the other. Never a rule to recite — a front like "bien que takes the subjunctive" has nothing to type.
- vocab and expr cards: the front is French, the back is English. Bare vocabulary carries a gendered article ("une colline"), adjectives are tagged ("ennuyeux (adj)"), verbs stay in the infinitive ("décharger").
- gram cards teach a grammar point through one example to produce. The front says what to do with " → " and the back is the FRENCH answer: "venir (subjonctif) → que je" / "vienne", "Il pleut. → bien que" / "bien qu'il pleuve". The arrow is required; it is how the app knows to expect French.
- A vocab or expr back is a short gloss, not a sentence — "a hill", "to unload / to discharge". Use " / " between near-synonyms.
- One card per thing to learn. Propose 1-4; one good card beats four redundant ones. A phrase they asked about is one card — don't also split out its words.
- Never propose a card whose front teaches two different words (les frais "costs" and frais "fresh" are two cards, not one) — there'd be no single right answer to type.
- category: "vocab" single words, "expr" multi-word expressions and idioms, "gram" an arrow drill as above. Pronunciation can't be typed, so it is explained, never carded.
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
                "What the learner is shown: 'une colline', 'ennuyeux (adj)', or for gram a drill with ' → ' like 'venir (subjonctif) → que je'.",
            },
            back: {
              type: "string",
              description:
                "What the learner types: the English gloss ('a hill', 'boring / annoying'), or for gram the French answer ('vienne').",
            },
            category: {
              type: "string",
              enum: ["vocab", "expr", "gram"],
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
//
// Each earlier turn also gets back what grounded it. Deck context rides only
// on the LATEST question and is never stored, so a follow-up used to arrive
// with nothing to say what the earlier "why?" was about — and once the student
// had moved on, "another example?" was answered about the new card. A user
// turn carries the prompt of the card that was on screen when it was asked,
// and an assistant turn the cards it proposed, so "change the second card"
// means something. Both are fixed when the turn is written, so the history
// stays byte-identical from turn to turn and keeps its cache.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const m of raw) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content.trim() : "";
    if (!content) continue;
    const about = role === "user" && typeof m.about === "string" ? m.about.trim().slice(0, 200) : "";
    const proposed = role === "assistant" ? cardList(m.cards).slice(0, 4) : [];
    cleaned.push({
      role,
      content: content.slice(0, MAX_CHARS_PER_MESSAGE),
      about,
      proposed,
    });
  }
  const over = cleaned.length - MAX_TURNS;
  const trimmed = over > 0 ? cleaned.slice(Math.ceil(over / TRIM_STEP) * TRIM_STEP) : cleaned;
  // The Messages API requires the first message to be from the user.
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

// The text a turn is sent as. The latest user turn skips its note: the
// [Context] block describes the same card in full.
function renderTurn(m, isLatest) {
  if (m.role === "user") {
    return m.about && !isLatest
      ? `[Asked while this card was on screen: "${m.about}"]\n${m.content}`
      : m.content;
  }
  return m.proposed.length
    ? `${m.content}\n\n[Cards you proposed: ${m.proposed.join("; ")}]`
    : m.content;
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
  const line = cur && typeof cur === "object" ? currentCardLines(cur) : "";
  if (line) parts.push(line);

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

const clip = (v) => String(v ?? "").trim().slice(0, 200);

const RESULT_TEXT = {
  wrong: "was marked wrong",
  wrongArticle: "has the right word with the wrong article",
  close: "was accepted as close enough",
  correct: "was marked correct",
};

// The card on screen, and where the student is with it. Whether it has been
// answered decides what the tutor may say (see "The card on screen" in the
// system prompt), so it is stated, never left to inference.
function currentCardLines(cur) {
  const prompt = clip(cur.prompt);
  const answer = clip(cur.answer);
  if (!prompt) return "";
  const lines = [`Card on screen: it shows "${prompt}"; the expected answer is "${answer}".`];
  const typed = clip(cur.typed);
  if (!cur.answered) {
    lines.push("They have NOT answered it yet — do not reveal the expected answer.");
  } else if (cur.result === "revealed") {
    lines.push("They couldn't recall it and revealed the answer.");
  } else if (typed && RESULT_TEXT[cur.result]) {
    lines.push(`They typed "${typed}", which ${RESULT_TEXT[cur.result]}.`);
  } else {
    lines.push("The answer is showing.");
  }
  if (cur.missedLastTime) lines.push("They also missed it the last time it came up.");
  return lines.join("\n");
}

// Attach the context to the final user turn, leaving the caller's array alone.
function withContext(messages, contextBlock) {
  const rendered = messages.map((m, i) => ({
    role: m.role,
    content: renderTurn(m, i === messages.length - 1),
  }));
  const last = rendered[rendered.length - 1];
  if (!contextBlock || !last || last.role !== "user") return rendered;
  last.content = `${contextBlock}\n\n${last.content}`;
  return rendered;
}

// Cache the conversation, not just the system prompt.
//
// The system prompt and tool schema come to roughly 900 tokens, under the
// 1,024-token minimum Sonnet 5 will cache, so a breakpoint on them alone
// silently cached nothing — while up to twenty turns of history went out at
// full price on every question. The breakpoint goes on the turn BEFORE the
// latest question: that question carries this turn's [Context] block, which
// is gone from it by the next request, so everything up to the turn before it
// is exactly what the next request will send again.
function withHistoryCache(messages) {
  if (messages.length < 2) return messages;
  const i = messages.length - 2;
  const copy = messages.slice();
  copy[i] = {
    role: copy[i].role,
    content: [{ type: "text", text: copy[i].content, cache_control: { type: "ephemeral" } }],
  };
  return copy;
}

// Validate the model's tool input rather than trusting it toward the DB. The
// client lets the learner edit a proposal before adding it, so this is the
// floor on shape, not on quality.
export function normalizeCards(input) {
  const proposed = Array.isArray(input?.cards) ? input.cards : [];
  return proposed
    .filter((c) => c && typeof c.front === "string" && typeof c.back === "string")
    .slice(0, 4)
    .map((c) => ({
      front: c.front.trim(),
      back: c.back.trim(),
      // Anything else — "pron" from an older prompt, a made-up category — is a
      // card with nothing sensible to type, and falling back to vocab used to
      // file it as a word.
      category: ["vocab", "expr", "gram"].includes(c.category) ? c.category : "",
      note: typeof c.note === "string" ? c.note.trim() : "",
    }))
    // A grammar card without its arrow asks for English (answerLang reads the
    // arrow) and is usually a rule to recite. Neither can be studied.
    .filter((c) => c.front && c.back && c.category && (c.category !== "gram" || c.front.includes("→")));
}

// Everything the model is sent as `messages`, from the request body. Exported
// so the logic suite can check what a turn actually becomes without a model.
export function buildRequestMessages(body) {
  const messages = sanitizeMessages(body?.messages);
  if (!messages.length) return [];
  return withHistoryCache(withContext(messages, buildContextBlock(body?.context)));
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

  const messages = buildRequestMessages(req.body);
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
      // Breakpoint at the end of the stable prefix (tools render before the
      // system prompt, so this covers both). Too short to cache by itself —
      // see withHistoryCache — but on the first question it is the only
      // prefix there is, and once history is added it costs nothing.
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [PROPOSE_TOOL],
      messages,
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

    // An answer that stopped for any reason other than finishing is not a
    // finished answer, however much of it arrived.
    if (final.stop_reason === "max_tokens") {
      send({ type: "error", error: "The answer ran too long and was cut off. Try a narrower question." });
      return res.end();
    }
    if (final.stop_reason === "refusal") {
      send({ type: "error", error: "The tutor couldn't help with that one. Try rephrasing it." });
      return res.end();
    }

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
    } else if (err instanceof Anthropic.APIError && err.status === 529) {
      message = "Claude is overloaded right now — give it a minute and try again.";
    } else if (err instanceof Anthropic.APIError) {
      // The raw API message is for the log above, not for a student.
      message = `The tutor couldn't answer (error ${err.status ?? "unknown"}). Try again.`;
    } else {
      message = "The tutor couldn't answer. Try again.";
    }
    send({ type: "error", error: message, ...(code ? { code } : null) });
    res.end();
  }
}
