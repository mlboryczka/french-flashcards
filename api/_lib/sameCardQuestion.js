// The one question Claude is asked about near look-alikes (2026-10-06): is
// this new card the same card to learn as one the student already has, or a
// different one?
//
// The fixed rule (src/lib/sameCard.js) settles most new cards. What it can't
// settle without joining words that differ, "le cas" beside "un cas", "l'ami"
// beside "un ami", "après" beside "ensuite / après", is asked here, every
// pair of a run in one call.
//
// A card that is one item of another card's list is the same card (the owner,
// 2026-10-07: "à l'heure" beside "à temps / à l'heure" is one card twice).
// The rule is sure of it when the English agrees word for word; the rest come
// here, and the question says so, with the kinds of card a list only seems to
// hold kept apart: a word inside a sentence with a comma, different words
// grouped on one card, and another meaning of the same spelling. Both kinds
// are in the test of this question (api/_lib/keepApart.js).
//
// The answer decides only whether a card is added: a "same" adds the class
// date to the card the student has, and nothing else about that card
// changes.
//
// If the call fails, or a pair comes back without a clear answer, the card
// waits and its lines stay unread (src/lib/cardMatch.js). Nothing is added on
// a guess.
//
// The question carries a version, a hash of its wording and the model, as
// Claude's marking of answers does (api/_lib/answerChecks.js), so verdicts
// saved under one wording can be told from those saved under the next
// (card_pairs, migration_016).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

export const SAME_CARD_MODEL = "claude-opus-5-5";
// Pairs per call. A new class of about 30 cards raises roughly a dozen.
export const PAIRS_PER_CALL = 50;
// Calls made at once. A first upload of a year's notes raises far more: on a
// copy of the owner's notes read from nothing, 890 pairs, 18 calls (measured
// 2026-10-06). One after another they would outlast the function's five
// minutes, and nothing would be saved.
export const CALLS_AT_ONCE = 4;
// How long the question may take when the caller sets no time.
export const DEFAULT_TIME_MS = 120 * 1000;

export const SAME_CARD_SYSTEM = `You help a French learner keep one flashcard for each thing they learn. Their cards come from their class notes, and the same word is often written a little differently from one class to the next.

For each numbered pair, card A is one the student already has and card B was just made from their notes. Decide whether B is the same card to learn as A.

Answer "same" when learning one card means learning the other: the same French word, phrase or sentence, written another way. For example:
- a different article of the same gender: "un cas" and "le cas"; "un ami" and "l'ami"
- an accent fixed or a typo: "enervé" and "énervé"; "une propositiond" and "une proposition"
- "ne" dropped in speech: "je connais personne" and "je ne connais personne"
- the feminine added to the same word: "japonais" and "japonais, japonaise"
- one item of a list card, which already teaches it, even when the English is worded differently: "à l'heure" and "à temps / à l'heure" (on time); "manquer" and "manquer / rater" (to miss); "après" (after) and "ensuite / après" (then / afterwards); "des yeux" and "un œil, des yeux"
- a number written in digits: "15" and "quinze"
- the same word with its English worded differently: "être assis" = "to be seated" and "to be sitting"

Answer "different" when they teach different things. Keep these apart:
- different words that look alike: "ou" (or) and "où" (where)
- a different gender that changes the meaning: "la poste" (the post office) and "le poste" (the job)
- a word and the same spelling with another meaning: "fin" (the end) and "fin (adj)" (thin); "voler" (to steal) and "voler" (to fly)
- "un état" (a state, a condition) and "l'État" (the State)
- a meaning marked "(fam)" beside the ordinary meaning: "planter" (to plant) and "planter (fam)" (to ditch someone)
- the masculine and the feminine on cards of their own: "vieux" and "vieille"
- the singular and the plural on cards of their own
- an exclamation with a meaning of its own: "Je pense !" (I think so!) and "je pense" (I think)
- a word that is only part of a longer expression: "mieux (adv)" (better) and "encore meilleur / mieux" (even better)
- a word or phrase inside a sentence, even after a comma: "en fait" and "En fait, ça veut dire que"; "la semaine prochaine" and "La semaine prochaine, il va faire froid"
- different words that only appear together on one card, such as examples of one grammar point or opposites: "amener" and "se lever, acheter, amener"; "bon" (good) and "bon / mauvais" (right / wrong)
- a list item with a meaning other than the one the list teaches: "fin" (the end) and "fin, fine" (thin; fine); "une boîte" (a box) and "une boîte / un club" (a nightclub / a club)

When you are unsure, answer "different": a card too many can be removed, a card lost can't be found.

Reply with JSON only: {"verdicts": [{"pair": 1, "verdict": "same"}, ...]}, one entry for every pair.`;

const quote = (s) => JSON.stringify(String(s ?? ""));

// The pairs, as Claude reads them.
export function sameCardPrompt(pairs) {
  return pairs
    .map((p, i) => `Pair ${i + 1}\n  A: ${quote(p.a.front)} = ${quote(p.a.back)}\n  B: ${quote(p.b.front)} = ${quote(p.b.back)}`)
    .join("\n\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pair: { type: "integer" },
          verdict: { type: "string", enum: ["same", "different"] },
        },
        required: ["pair", "verdict"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

// Seven characters that change whenever the question or the model does.
export const SAME_CARD_VERSION = createHash("sha1")
  .update(SAME_CARD_MODEL)
  .update(SAME_CARD_SYSTEM)
  .update(sameCardPrompt([{ a: { front: "\u0001", back: "\u0002" }, b: { front: "\u0003", back: "\u0004" } }]))
  .update(JSON.stringify(SCHEMA))
  .digest("hex")
  .slice(0, 7);

// Claude's reply as one verdict per pair, null where it gave none.
export function readVerdicts(text, count) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || "").replace(/```json|```/g, "").trim());
  } catch {
    parsed = null;
  }
  const out = new Array(count).fill(null);
  for (const v of Array.isArray(parsed?.verdicts) ? parsed.verdicts : []) {
    const i = Number(v?.pair) - 1;
    if (Number.isInteger(i) && i >= 0 && i < count && (v.verdict === "same" || v.verdict === "different")) out[i] = v.verdict;
  }
  return out;
}

async function askOnce(client, pairs, signal) {
  const response = await client.beta.messages.create({
    model: SAME_CARD_MODEL,
    max_tokens: 16000,
    // If the model declines, another one answers in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SAME_CARD_SYSTEM,
    messages: [{ role: "user", content: sameCardPrompt(pairs) }],
  }, { signal });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to compare the cards.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's comparison of the cards was cut off.");
  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return readVerdicts(text, pairs.length);
}

// [{ a: {front, back}, b: {front, back} }] -> ["same" | "different" | null].
//
// The pairs go in calls of PAIRS_PER_CALL, CALLS_AT_ONCE at a time, and no
// call runs past `deadline` (a time in ms), so the reading that asked can
// still save before its function is stopped. A call that fails or runs out of
// time leaves its pairs null: those cards wait, and their lines stay unread
// for the next run. Throws only when no call got an answer, so the caller can
// say why.
export async function askSameCard({ apiKey, pairs, deadline = Date.now() + DEFAULT_TIME_MS }) {
  if (!apiKey) throw new Error("No Anthropic key to compare the cards with.");
  const out = new Array(pairs.length).fill(null);
  if (!pairs.length) return out;
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const chunks = [];
  for (let i = 0; i < pairs.length; i += PAIRS_PER_CALL) chunks.push(i);
  const errors = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const start = chunks[next++];
      const left = deadline - Date.now();
      if (left < 5000) { errors.push(new Error("There wasn't time to compare the cards.")); continue; }
      try {
        const verdicts = await askOnce(client, pairs.slice(start, start + PAIRS_PER_CALL), AbortSignal.timeout(left));
        verdicts.forEach((v, j) => { out[start + j] = v; });
      } catch (e) {
        errors.push(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CALLS_AT_ONCE, chunks.length) }, worker));
  if (errors.length === chunks.length) throw errors[0];
  if (errors.length) console.warn(`[same-card] ${errors.length} of ${chunks.length} calls unanswered; their cards wait:`, errors[0]?.message || errors[0]);
  return out;
}
