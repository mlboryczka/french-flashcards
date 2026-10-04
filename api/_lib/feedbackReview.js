// Claude's review of a piece of feedback, and the owner's Apply and Dismiss.
//
// Reached through /api/review-answer with a `feedback` body, because Vercel's
// Hobby plan deploys at most 12 routes and there are 12. The body is
// { action, id }:
//
//   review   Claude reads the feedback, the card it was about (as it is in the
//            deck now) and any screenshot, and decides what it needs: "card"
//            (editing the card fixes it, with the corrected card), "remove"
//            (the card shouldn't be in the deck), "app" (it needs a change to
//            the app or a lesson, with a brief for a coding session) or "none".
//            The review is saved on the row and nothing else changes.
//              With an id: the admin, for any open entry. View feedback asks
//              for every open entry that has no review yet.
//              Without one: the sender's own browser, straight after sending.
//              It gets the newest unreviewed entry the sender wrote in the
//              last few minutes, so a student can cause one review per piece
//              of feedback they send, and no more.
//            The server's key pays either way: the reviews are for the owner
//            (owner, 2026-10-04).
//   apply    Admin only. Writes Claude's corrected card over the card, in
//            place, so it keeps its schedule, its answer history and its place
//            in any set; or, for "remove", archives the card, which takes it
//            out of study and keeps its answers (src/lib/archive.js). Then
//            resolves the entry saying what changed. Refused if the card has
//            changed since Claude saw it.
//   dismiss  Admin only. Resolves the entry, keeping Claude's reasoning in the
//            note.
//   revert   Admin only, after Apply. Puts the card back as it was (a removed
//            card comes back into the deck) and reopens the entry. Refused if
//            the card has been edited since.
//
// Nothing here deletes anything. The store is passed in so the rules can be
// tested without a database (tests/suites/feedback-review.mjs).

import Anthropic from "@anthropic-ai/sdk";
import { isArchived, archivedSource, ARCHIVE_PREFIX } from "../../src/lib/archive.js";
import { lessonIdOf } from "../../src/lib/lessonSource.js";
import { FEEDBACK_REVIEW_VERSION } from "../../src/lib/feedbackReviewVersion.js";

export const FEEDBACK_MODEL = "claude-opus-5-5";

// How long after sending the sender's browser may ask for the review.
export const SENDER_WINDOW_MS = 10 * 60 * 1000;

// Anthropic refuses images over 5MB. A bigger screenshot is left out and the
// review goes ahead on the words and the card.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SYSTEM_PROMPT = `You review feedback that students send from a French flashcard app, so that the app's owner can act on it quickly. The owner studies with the app too, so some feedback is theirs.

How the app works. Each student has their own deck. Most cards are made by Claude from the student's class notebook; others come from built-in lessons that every student shares. An ordinary card has French on the front and its English meaning on the back, and is asked both ways round: the student sees one side and types the other. A grammar drill has a prompt such as "finir (impératif) → tu" on the front and the form on the back ("finis"), and is only asked that way round.

How a typed answer is marked. Capitals, accents, punctuation and anything in brackets are ignored. "/", ";" and "," separate alternative answers, and any one of them is accepted. Small typos are forgiven, except in grammar drills. In French the article's gender must be right (un is not une); in English "the", "a" and "to" are optional.

A good card teaches one word or phrase in one sense, has an answer that can be typed and checked, and doesn't give its answer away on the side that is shown.

Decide what the feedback needs:
- "card": the card's own text is wrong or badly made, and editing this one card fixes it. For example a wrong or incomplete translation, a typo, a missing alternative answer, or the answer showing on the question side. Give the whole corrected front and back. Change only what the feedback is about, keep the card's style, and leave the front alone unless it is wrong.
- "remove": the card shouldn't be in the deck at all, and taking it out fixes it. For example a word that isn't French, a card that repeats another, or something no student could learn from. Taking a card out keeps its answer history.
- "app": fixing it needs a change to how the app works (marking, layout, buttons, scheduling, something broken), or to a built-in lesson card, which has to be fixed in the lesson for every student. Write a brief for the developer: what the student reported, what is actually wrong, and what you would change.
- "none": nothing should change. The feedback is mistaken, a test, a question, or already dealt with (for example the card already reads the way the student asked).

Check every claim about French yourself; students are sometimes wrong. In "reasoning", tell the owner in one to three plain sentences whether the student is right and why. The owner is not a linguist or a programmer, so avoid jargon. Leave "front" and "back" empty unless the kind is "card", and "brief" empty unless the kind is "app".`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["card", "remove", "app", "none"] },
    reasoning: { type: "string" },
    front: { type: "string" },
    back: { type: "string" },
    brief: { type: "string" },
  },
  required: ["kind", "reasoning", "front", "back", "brief"],
  additionalProperties: false,
};

export function screenshotBlock(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m || m[2].length * 0.75 > MAX_IMAGE_BYTES) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

const quoted = (front, back) => `front "${front}", back "${back}"`;

// What Claude is told about one entry.
export function describeFeedback(row, card, { screenshot = false } = {}) {
  const ctx = row.card_context;
  const lines = [
    `Feedback sent ${String(row.created_at || "").slice(0, 10)}${row.page ? `, from the ${row.page} page` : ""}:`,
    `<feedback>${row.message || "(no text)"}</feedback>`,
    "",
  ];
  if (ctx) {
    const shown = ctx.shown_dir === "en" ? "English" : ctx.shown_dir === "fr" ? "French" : null;
    lines.push(
      `The card on screen when it was sent: ${quoted(ctx.front, ctx.back)}` +
        `${ctx.category === "gram" ? ", a grammar drill" : ""}${shown ? `, shown ${shown} side first` : ""}.`
    );
    if (!card) {
      lines.push("That card is no longer in the student's deck, so it can't be edited.");
    } else {
      const same = card.front === ctx.front && card.back === ctx.back;
      lines.push(same ? "The card in the deck now is the same." : `The card in the deck now: ${quoted(card.front, card.back)}.`);
      if (card.lesson) lines.push(`It is a built-in lesson card (lesson "${card.lesson}").`);
    }
  } else {
    lines.push("No card was attached.");
  }
  if (screenshot) lines.push("The student's screenshot is attached.");
  return lines.join("\n");
}

async function askClaude({ apiKey, row, card }) {
  const image = screenshotBlock(row.screenshot);
  const text = describeFeedback(row, card, { screenshot: !!image });
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: FEEDBACK_MODEL,
    max_tokens: 16000,
    // If the model declines, another one answers in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [...(image ? [image] : []), { type: "text", text }] }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to review this feedback.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's review was cut off.");
  const out = (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(out);
}

// Claude's answer, made safe to store and act on.
export function shapeReview(raw, card) {
  let kind = ["card", "remove", "app", "none"].includes(raw?.kind) ? raw.kind : "none";
  const reasoning = String(raw?.reasoning || "").trim();
  let fix = null;
  if (kind === "card") {
    const front = String(raw.front || "").trim();
    const back = String(raw.back || "").trim();
    if (card && front && back && (front !== card.front || back !== card.back)) fix = { front, back };
    // A card change needs a card to change and something to change on it.
    else kind = "none";
  }
  if (kind === "remove" && !card) kind = "none";
  return {
    kind,
    reasoning,
    fix,
    brief: kind === "app" ? String(raw?.brief || "").trim() : null,
    card: card
      ? { row_id: card.row_id, front: card.front, back: card.back, lesson: card.lesson, source: card.source ?? null }
      : null,
    version: FEEDBACK_REVIEW_VERSION,
    model: FEEDBACK_MODEL,
    at: new Date().toISOString(),
  };
}

const reply = (status, json) => ({ status, json });

// How an applied fix's resolution note starts. Revert looks for them, so that a
// dismissed entry is never "reverted".
const APPLIED_NOTE = "Card changed from";
const REMOVED_NOTE = "Card taken out of the deck, answers kept:";

export async function handleFeedbackRequest({ body, user, isAdmin, store, apiKey, now = Date.now() }) {
  const action = body?.action;
  const id = body?.id ?? null;

  if (action === "review") {
    let row;
    if (id != null) {
      if (!isAdmin) return reply(403, { error: "Admin only" });
      row = await store.feedback(id);
      if (!row) return reply(404, { error: "No such feedback." });
      if (row.resolved_at) return reply(409, { error: "This feedback has already been dealt with." });
    } else {
      row = await store.newestUnreviewed(user.id, new Date(now - SENDER_WINDOW_MS).toISOString());
      if (!row) return reply(200, { ok: true, review: null });
    }
    if (!apiKey) {
      return reply(503, { error: "The server has no Anthropic key, so Claude can't review feedback." });
    }
    const ctx = row.card_context;
    const card = ctx && row.user_id
      ? await store.card({ userId: row.user_id, rowId: ctx.row_id ?? null, front: ctx.front })
      : null;
    const review = shapeReview(await askClaude({ apiKey, row, card }), card);
    await store.saveReview(row.id, review);
    return reply(200, { ok: true, id: row.id, review });
  }

  if (!["apply", "dismiss", "revert"].includes(action)) return reply(400, { error: "Unknown action." });
  if (!isAdmin) return reply(403, { error: "Admin only" });
  if (id == null) return reply(400, { error: "Which feedback?" });
  const row = await store.feedback(id);
  if (!row) return reply(404, { error: "No such feedback." });

  if (action === "revert") return revert(row, user, store);
  if (row.resolved_at) return reply(409, { error: "This feedback has already been dealt with." });

  if (action === "dismiss") {
    const why = row.review?.reasoning;
    await store.resolve(row.id, why ? `Dismissed. Claude's review: ${why}` : "Dismissed.");
    return reply(200, { ok: true });
  }

  const review = row.review;
  if (review?.kind === "remove" && review.card) return remove(row, user, store);
  if (review?.kind !== "card" || !review.fix || !review.card) {
    return reply(409, { error: "Claude didn't suggest a change to the card for this feedback." });
  }
  const { fix } = review;
  const card = await store.card({ userId: row.user_id, rowId: review.card.row_id });
  if (!card) return reply(404, { error: "That card is no longer in the deck." });
  const before = review.card;
  const alreadyFixed = card.front === fix.front && card.back === fix.back;
  if (!alreadyFixed) {
    if (card.front !== before.front || card.back !== before.back) {
      return reply(409, {
        error: "The card has been edited since Claude reviewed it. Ask Claude to review it again.",
        code: "card_changed",
      });
    }
    const { error } = await store.updateCard(card.row_id, row.user_id, fix);
    if (error?.code === "23505") {
      return reply(409, { error: `That deck already has a card "${fix.front}", so this one can't be changed to it.` });
    }
    if (error) throw new Error(error.message || "The card couldn't be saved.");
  }
  await store.resolve(
    row.id,
    `${APPLIED_NOTE} "${before.front} · ${before.back}" to "${fix.front} · ${fix.back}". ${review.reasoning}`.trim()
  );
  return reply(200, {
    ok: true,
    card: { row_id: card.row_id, front: fix.front, back: fix.back },
    own: row.user_id === user.id,
  });
}

// Taking the card out: archived, never deleted, since deleting a card deletes
// every answer recorded against it.
async function remove(row, user, store) {
  const before = row.review.card;
  const card = await store.card({ userId: row.user_id, rowId: before.row_id });
  if (!card) return reply(404, { error: "That card is no longer in the deck." });
  if (card.front !== before.front || card.back !== before.back) {
    return reply(409, {
      error: "The card has been edited since Claude reviewed it. Ask Claude to review it again.",
      code: "card_changed",
    });
  }
  const { error } = await store.setSource(card.row_id, row.user_id, archivedSource(card.source ?? null));
  if (error) throw new Error(error.message || "The card couldn't be taken out.");
  await store.resolve(row.id, `${REMOVED_NOTE} "${before.front} · ${before.back}". ${row.review.reasoning}`.trim());
  return reply(200, { ok: true, removed: true, card: { row_id: card.row_id, front: before.front, back: before.back }, own: row.user_id === user.id });
}

// Undoing an Apply: the card goes back to what Claude saw, and the entry is
// open again with its review, so it can be applied or dismissed afresh.
async function revert(row, user, store) {
  const review = row.review;
  const note = String(row.resolution || "");
  if (row.resolved_at && review?.kind === "remove" && review.card && note.startsWith(REMOVED_NOTE)) {
    const card = await store.card({ userId: row.user_id, rowId: review.card.row_id, includeArchived: true });
    if (!card) return reply(404, { error: "That card is no longer in the deck." });
    if (isArchived(card)) {
      const source = card.source.slice(ARCHIVE_PREFIX.length) || review.card.source || null;
      const { error } = await store.setSource(card.row_id, row.user_id, source);
      if (error) throw new Error(error.message || "The card couldn't be put back.");
    }
    await store.reopen(row.id);
    return reply(200, { ok: true, card: { row_id: card.row_id, front: card.front, back: card.back }, own: row.user_id === user.id });
  }
  const applied = row.resolved_at && note.startsWith(APPLIED_NOTE);
  if (!applied || review?.kind !== "card" || !review.fix || !review.card) {
    return reply(409, { error: "Only a fix that was applied can be reverted." });
  }
  const before = review.card;
  const card = await store.card({ userId: row.user_id, rowId: before.row_id });
  if (!card) return reply(404, { error: "That card is no longer in the deck." });
  if (card.front !== before.front || card.back !== before.back) {
    if (card.front !== review.fix.front || card.back !== review.fix.back) {
      return reply(409, { error: "The card has been edited since the fix was applied, so it can't be reverted." });
    }
    const { error } = await store.updateCard(card.row_id, row.user_id, { front: before.front, back: before.back });
    if (error?.code === "23505") {
      return reply(409, { error: `That deck now has another card "${before.front}", so this one can't be changed back.` });
    }
    if (error) throw new Error(error.message || "The card couldn't be saved.");
  }
  await store.reopen(row.id);
  return reply(200, {
    ok: true,
    card: { row_id: card.row_id, front: before.front, back: before.back },
    own: row.user_id === user.id,
  });
}

// The store, on Supabase with the service role. The service role ignores RLS,
// so every card read and write is held to the feedback sender's user_id here.
const FEEDBACK_COLUMNS =
  "id,user_id,user_email,message,page,screenshot,card_context,created_at,resolved_at,review";

export function supabaseFeedbackStore(db) {
  const shapeCard = (row, includeArchived = false) =>
    row && (includeArchived || !isArchived(row))
      ? { row_id: row.id, front: row.front, back: row.back, lesson: lessonIdOf(row), source: row.source ?? null }
      : null;

  return {
    async feedback(id) {
      const { data, error } = await db.from("beta_feedback").select(FEEDBACK_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },

    async newestUnreviewed(userId, sinceIso) {
      const { data, error } = await db
        .from("beta_feedback")
        .select(FEEDBACK_COLUMNS)
        .eq("user_id", userId)
        .is("review", null)
        .is("resolved_at", null)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] || null;
    },

    // By row id when the feedback has one (sent since 2026-10-04), otherwise by
    // the front, which is unique in a deck.
    // Archived cards count as gone, unless asked for (Revert of a removal).
    async card({ userId, rowId, front, includeArchived = false }) {
      const columns = "id,user_id,front,back,source";
      if (rowId != null) {
        const { data, error } = await db.from("user_cards").select(columns).eq("id", rowId).maybeSingle();
        if (error) throw new Error(error.message);
        if (data) return data.user_id === userId ? shapeCard(data, includeArchived) : null;
      }
      const key = String(front || "").trim();
      if (!key) return null;
      const { data, error } = await db.from("user_cards").select(columns).eq("user_id", userId).ilike("front", key).limit(10);
      if (error) throw new Error(error.message);
      return shapeCard((data || []).find((r) => String(r.front || "").trim().toLowerCase() === key.toLowerCase()));
    },

    async saveReview(id, review) {
      const { error } = await db.from("beta_feedback").update({ review, reviewed_at: review.at }).eq("id", id);
      if (error) throw new Error(error.message);
    },

    async updateCard(rowId, userId, { front, back }) {
      const { error } = await db.from("user_cards").update({ front, back }).eq("id", rowId).eq("user_id", userId);
      return { error };
    },

    async setSource(rowId, userId, source) {
      const { error } = await db.from("user_cards").update({ source }).eq("id", rowId).eq("user_id", userId);
      return { error };
    },

    async reopen(id) {
      const { error } = await db.from("beta_feedback").update({ resolved_at: null, resolution: null }).eq("id", id);
      if (error) throw new Error(error.message);
    },

    async resolve(id, note) {
      const { error } = await db
        .from("beta_feedback")
        .update({ resolved_at: new Date().toISOString(), resolution: note })
        .eq("id", id)
        .is("resolved_at", null);
      if (error) throw new Error(error.message);
    },
  };
}
