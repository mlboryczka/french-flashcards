// POST /api/cahier-parse — the upload dialog's reading step: the classes of
// an upload that have lines not read before, turned into cards by Claude.
//
// Since 2026-10-06 a class is read exactly as the linked notebook reads it
// (extractCardsFromBlock in api/parse-cahier.js: the same instructions, the
// same model), so an upload and the linked notebook make the same card from
// the same line. This step used to have instructions of its own, without the
// linked notebook's rules on full stops, English on the French side and
// " / " lists, plus up to fifteen "recent corrections" from every student's
// edits, which changed from one upload to the next. The same class came back
// spelt differently each time, and each new spelling was a new card.
//
// A class whose lines were partly read before arrives with `newLines`, and
// Claude is told to make cards from those only (src/lib/notesLines.js).
//
// The upload_batches bookkeeping is best-effort: a failure there never blocks
// the upload.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

import { requireUser } from "./_lib/auth.js";
import { requireAnthropicKey } from "./_lib/anthropicKey.js";
// What a card may be, and the code that holds the model to it, are
// parse-cahier.js's: imported, not copied. This file is the upload dialog's
// reading step and parse-cahier's commit is its last, so the two halves of one
// upload must agree on what a card is.
import {
  EXTRACTION_MODEL,
  extractCardsFromBlock,
  keepAnswerable,
  cleanFrenchFront,
  splitSlashPairs,
} from "./parse-cahier.js";
export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const user = await requireUser(req, res);
  if (!user) return;
  const userId = user.id;

  // The key that pays is the caller's own unless they are the deploy owner.
  const apiKey = requireAnthropicKey(req, res, user);
  if (!apiKey) return;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { status, json } = await readClasses({ admin, userId, apiKey, body: req.body || {} });
  return res.status(status).json(json);
}

// The work itself, with the database and the key passed in, so the tests run
// exactly this (tests/suites/repeats.mjs). Returns the reply.
export async function readClasses({ admin, userId, apiKey, body = {} }) {
  const source = body.source || "cahier-parse";

  // Two accepted input shapes:
  //
  //   1. { blocks: [{ date, text, newLines? }, ...] }
  //        One Claude call per class, in parallel. The dialog sends chunks of
  //        ~15 to stay well inside the function's time limit, and passes the
  //        batch_id the first chunk returned so the whole upload is one
  //        upload_batches row.
  //
  //   2. { text: "<lesson text>" }
  //        One call over the whole text, read as one undated class.
  const blocks = Array.isArray(body.blocks) ? body.blocks : null;
  const rawText = (body.text || "").toString();
  const reuseBatchId = body.batch_id || null;

  if (!blocks && (!rawText || rawText.trim().length < 20)) {
    return { status: 400, json: { error: "Provide either `text` (min 20 chars) or `blocks` (non-empty array)" } };
  }
  if (blocks && blocks.length === 0) {
    return { status: 400, json: { error: "blocks array is empty" } };
  }
  if (blocks && blocks.length > 30) {
    return { status: 400, json: { error: "Chunk too large (max 30 blocks). Split into smaller chunks." } };
  }

  const work = blocks
    ? blocks.map((b) => ({ date: b?.date || null, text: String(b?.text || ""), newLines: Array.isArray(b?.newLines) ? b.newLines : null }))
    : [{ date: null, text: rawText, newLines: null }];
  const totalInputChars = work.reduce((n, b) => n + b.text.length, 0);

  // The upload_batches row: reused across chunks, created by the first.
  let batchId = reuseBatchId;
  if (!batchId) {
    try {
      const { data: batchRow, error: batchErr } = await admin
        .from("upload_batches")
        .insert({ user_id: userId, source, input_chars: totalInputChars, few_shot_correction_ids: [], model: EXTRACTION_MODEL })
        .select("id")
        .single();
      if (batchErr) console.warn("[cahier-parse] upload_batches insert failed — continuing without batch_id:", batchErr.message || batchErr);
      else batchId = batchRow?.id || null;
    } catch (e) {
      console.warn("[cahier-parse] upload_batches insert threw:", e?.message || e);
    }
  }

  const anthropic = new Anthropic({ apiKey });
  const cards = [];
  const blockErrors = [];
  const results = await Promise.all(
    work.map((b) =>
      b.text.trim().length < 20
        ? Promise.resolve([])
        : extractCardsFromBlock(anthropic, b).catch((e) => ({ __error: e?.message || String(e), date: b.date }))
    )
  );
  for (const r of results) {
    if (r && r.__error) blockErrors.push({ date: r.date, error: r.__error });
    else if (Array.isArray(r)) {
      // Cleaned and split before they are judged, exactly as the commit and
      // the sync do, so what this returns (and cards_parsed counts) is only
      // cards the student could get. A table passes through for the commit to
      // expand into drills.
      // An undated text has no class date to give its cards.
      const cleaned = r.map((c) => ({ ...c, front: cleanFrenchFront(c.front, c.back), dates: (c.dates || []).filter(Boolean) }));
      cards.push(...keepAnswerable(splitSlashPairs(cleaned)));
    }
  }

  // cards_parsed, added to rather than overwritten, for a multi-chunk upload.
  if (batchId && cards.length > 0) {
    try {
      const { data: cur } = await admin.from("upload_batches").select("cards_parsed").eq("id", batchId).single();
      await admin.from("upload_batches").update({ cards_parsed: (cur?.cards_parsed || 0) + cards.length }).eq("id", batchId);
    } catch (e) {
      console.warn("[cahier-parse] cards_parsed update threw:", e?.message || e);
    }
  }

  if (blockErrors.length && cards.length === 0 && blockErrors.length === work.length) {
    return { status: 500, json: { error: `Claude extraction failed: ${blockErrors[0].error}`, batch_id: batchId, errors: blockErrors } };
  }

  return {
    status: 200,
    json: { ok: true, cards, batch_id: batchId, few_shot_used: 0, model: EXTRACTION_MODEL, errors: blockErrors },
  };
}
