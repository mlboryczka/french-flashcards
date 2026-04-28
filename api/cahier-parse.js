// POST /api/cahier-parse — Claude extraction enriched with a few-shot
// block built from recent parse_corrections. The few-shot fetch and the
// upload_batches bookkeeping are best-effort: any failure logs and falls
// through to an unenriched parse so the upload never blocks on the ledger.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
  maxDuration: 300,
};

const DEFAULT_MODEL = "claude-haiku-4-5";

const BASE_SYSTEM = `You are extracting flashcards from a French student's daily lesson notes.

The text below is one lesson day from a cahier (notebook) kept by a French teacher. It contains French vocabulary, expressions, pronunciation notes, and grammar rules.

Your job: extract every French term/phrase/rule as a flashcard with an English translation.

Rules:
1. Preserve the EXACT French spelling including accents, apostrophes, and punctuation. Do not "correct" anything.
2. Keep articles (un, une, le, la, les, des, du) when present — they're semantically meaningful.
3. For gender pairs like "un vendeur / une vendeuse" or "gros, grosse (adj)", keep them as a single card.
4. Translate naturally into English.
5. Skip lines that are clearly not flashcard material (homework, URLs, section headers themselves).
6. Each card gets a category: "V" for Vocabulaire/Expressions, "G" for Prononciation/Grammaire.
7. If a line pairs two different words with "//", split them into separate cards.
8. "on" in conversational French means "we", not "one".

Return ONLY a JSON array. Each element: {"front": "...", "back": "...", "category": "V" | "G"}.
If the block has no extractable cards, return [].`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
    process.env;
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await admin.auth.getUser(
    accessToken
  );
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: "Invalid auth token" });
  }
  const userId = userData.user.id;

  const body = req.body || {};
  const source = body.source || "cahier-parse";
  const model = body.model || DEFAULT_MODEL;

  // Two accepted input shapes, so a long cahier can be chunked by the
  // client while still producing a single upload_batches row:
  //
  //   1. { text: "<lesson text>" }
  //        Single Claude call over the whole text. For short inputs.
  //
  //   2. { blocks: [{ date, text }, ...] }
  //        One Claude call per block, fanned out in parallel. The client
  //        sends small chunks (~15 blocks) to stay under Vercel Hobby's
  //        60s function timeout.
  //
  // Chunked flow also accepts { batch_id: <uuid> } to reuse an existing
  // batch across chunk calls instead of spawning a new row per chunk.
  const blocks = Array.isArray(body.blocks) ? body.blocks : null;
  const rawText = (body.text || "").toString();
  const reuseBatchId = body.batch_id || null;

  if (!blocks && (!rawText || rawText.trim().length < 20)) {
    return res.status(400).json({
      error: "Provide either `text` (min 20 chars) or `blocks` (non-empty array)",
    });
  }
  if (blocks && blocks.length === 0) {
    return res.status(400).json({ error: "blocks array is empty" });
  }
  if (blocks && blocks.length > 30) {
    return res.status(400).json({
      error: "Chunk too large (max 30 blocks). Split into smaller chunks.",
    });
  }

  const totalInputChars = blocks
    ? blocks.reduce((n, b) => n + (b?.text?.length || 0), 0)
    : rawText.length;

  // ── STEP (a) + (b): build few-shot block from recent corrections ───────
  // Best-effort: if any of this fails, we proceed with an empty few-shot
  // block. Never block the user's upload on the ledger.
  //
  // When reusing a batch, we still fetch fresh corrections — but only to
  // enrich this chunk's prompt. The canonical few_shot_correction_ids on
  // the batch row were set when the batch was first created.
  let injectedIds = [];
  let fewShotBlock = "";
  try {
    const { data: corrections, error } = await admin
      .from("parse_corrections")
      .select(
        "id, category, original_front, original_back, corrected_front, corrected_back, notes"
      )
      .eq("promoted_to_rule", false)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      // Graceful degradation: migration not run, table missing, etc.
      console.warn(
        "[cahier-parse] parse_corrections fetch failed — continuing without few-shot:",
        error.message || error
      );
    } else if (Array.isArray(corrections) && corrections.length > 0) {
      const built = buildFewShotBlock(corrections);
      fewShotBlock = built.block;
      injectedIds = built.ids;
    }
  } catch (e) {
    console.warn(
      "[cahier-parse] few-shot fetch threw — continuing without it:",
      e?.message || e
    );
  }

  // ── STEP (c): get or create the upload_batches row ─────────────────────
  // If the client passed batch_id we reuse it; otherwise we create a new
  // row. Best-effort — if this fails we still run the parse so the user
  // gets their cards. batch_id will be null in that case.
  let batchId = reuseBatchId;
  if (!batchId) {
    try {
      const { data: batchRow, error: batchErr } = await admin
        .from("upload_batches")
        .insert({
          user_id: userId,
          source,
          input_chars: totalInputChars,
          few_shot_correction_ids: injectedIds,
          model,
        })
        .select("id")
        .single();
      if (batchErr) {
        console.warn(
          "[cahier-parse] upload_batches insert failed — continuing without batch_id:",
          batchErr.message || batchErr
        );
      } else {
        batchId = batchRow?.id || null;
      }
    } catch (e) {
      console.warn(
        "[cahier-parse] upload_batches insert threw:",
        e?.message || e
      );
    }
  }

  // ── STEP (d): call Claude with the enriched prompt ─────────────────────
  const systemPrompt = fewShotBlock
    ? `${BASE_SYSTEM}\n\n${fewShotBlock}`
    : BASE_SYSTEM;

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let cards = [];
  let claudeError = null;
  const blockErrors = [];

  if (blocks) {
    // Parallel fan-out per block, mirroring api/parse-cahier.js extract.
    const results = await Promise.all(
      blocks.map((b) =>
        callClaudeOnce(anthropic, model, systemPrompt, b?.text || "").then(
          (cs) =>
            cs.map((c) => ({
              ...c,
              dates: b?.date ? [b.date] : [],
            })),
          (e) => ({ __error: e?.message || String(e), date: b?.date })
        )
      )
    );
    for (const r of results) {
      if (r && r.__error) {
        blockErrors.push({ date: r.date, error: r.__error });
      } else if (Array.isArray(r)) {
        cards.push(...r);
      }
    }
    if (cards.length === 0 && blockErrors.length > 0) {
      claudeError = blockErrors[0].error;
    }
  } else {
    try {
      cards = await callClaudeOnce(anthropic, model, systemPrompt, rawText);
    } catch (e) {
      claudeError = e?.message || String(e);
      console.error("[cahier-parse] Claude call failed:", claudeError);
    }
  }

  // ── STEP (e): mark corrections as used_in_few_shot = true ──────────────
  // Only if we actually got cards back AND we injected something. If the
  // parse errored, the corrections weren't really "used" — leave them for
  // next time.
  if (injectedIds.length > 0 && cards.length > 0) {
    try {
      const { error: updErr } = await admin
        .from("parse_corrections")
        .update({ used_in_few_shot: true })
        .in("id", injectedIds);
      if (updErr) {
        console.warn(
          "[cahier-parse] used_in_few_shot update failed:",
          updErr.message || updErr
        );
      }
    } catch (e) {
      console.warn(
        "[cahier-parse] used_in_few_shot update threw:",
        e?.message || e
      );
    }
  }

  // Also increment cards_parsed on the batch row so the admin dashboard
  // can compute "cards edited as a fraction of cards parsed" later. We
  // RPC-style add instead of overwrite to handle multi-chunk uploads
  // correctly — without this, the last chunk would clobber earlier counts.
  if (batchId && cards.length > 0) {
    try {
      const { data: cur } = await admin
        .from("upload_batches")
        .select("cards_parsed")
        .eq("id", batchId)
        .single();
      const prev = cur?.cards_parsed || 0;
      await admin
        .from("upload_batches")
        .update({ cards_parsed: prev + cards.length })
        .eq("id", batchId);
    } catch (e) {
      console.warn(
        "[cahier-parse] cards_parsed update threw:",
        e?.message || e
      );
    }
  }

  if (claudeError && cards.length === 0) {
    return res.status(500).json({
      error: `Claude extraction failed: ${claudeError}`,
      batch_id: batchId,
      errors: blockErrors,
    });
  }

  // ── STEP (f): return cards + batch_id ──────────────────────────────────
  return res.status(200).json({
    ok: true,
    cards,
    batch_id: batchId,
    few_shot_used: injectedIds.length,
    model,
    errors: blockErrors,
  });
}

// Shared per-block Claude call. Returns an array of {front, back, category}.
// Throws on bad response so the caller can aggregate errors across blocks.
async function callClaudeOnce(anthropic, model, systemPrompt, text) {
  if (!text || text.trim().length < 20) return [];
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Here is the lesson text:\n\n---\n${text}\n---`,
      },
    ],
  });
  const textBlock = response.content.find((c) => c.type === "text");
  if (!textBlock) throw new Error("Claude returned no text block");
  let jsonText = textBlock.text.trim();
  jsonText = jsonText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("Claude did not return a JSON array");
  }
  return parsed
    .filter(
      (c) =>
        c &&
        typeof c.front === "string" &&
        typeof c.back === "string" &&
        (c.category === "V" || c.category === "G")
    )
    .map((c) => ({
      front: c.front.trim(),
      back: c.back.trim(),
      category: c.category,
    }))
    .filter((c) => c.front.length > 0 && c.back.length > 0);
}

// Build the few-shot block: group by category, take top 5 categories by
// volume, up to 3 examples each. Returns { block, ids } so the caller
// can stash ids on the batch row + mark them used afterward.
function buildFewShotBlock(rows) {
  const byCat = new Map();
  for (const r of rows) {
    if (!r.category) continue;
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }

  const topCats = [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  if (topCats.length === 0) return { block: "", ids: [] };

  const usedIds = [];
  const sections = [];
  for (const [cat, list] of topCats) {
    const examples = list.slice(0, 3);
    const lines = [];
    for (const ex of examples) {
      usedIds.push(ex.id);
      lines.push(formatExample(cat, ex));
    }
    sections.push(`• ${describeCategory(cat)}:\n${lines.map((l) => `    ${l}`).join("\n")}`);
  }

  const block = [
    "RECENT CORRECTIONS FROM THE EDITOR — examples of mistakes made on",
    "previous uploads that the human editor had to fix. Apply the same",
    "judgment when parsing this lesson; do not repeat these mistakes.",
    "",
    sections.join("\n"),
  ].join("\n");

  return { block, ids: usedIds };
}

function describeCategory(cat) {
  const map = {
    should_split_polysemy:
      "Split polysemous words into separate cards when meanings diverge",
    should_merge_gendered:
      "Keep gendered pairs (masculine/feminine) as a single card",
    wrong_disambiguator:
      "Pick short, meaningful disambiguator parentheticals",
    wrong_card_type: "Classify cards correctly as V (vocab) vs G (grammar)",
    reversed_front_back: "Do not swap front/back fields",
    duplicate_detected: "Do not emit duplicate cards of the same concept",
    spelling_correction:
      "Preserve exact French spelling/accents; do not normalize",
    alternate_answer: "Prefer idiomatic English translations",
    front_text_edit: "Front-side phrasing the editor revised",
    back_text_edit: "Back-side phrasing the editor revised",
    other: "Miscellaneous corrections",
  };
  return map[cat] || cat;
}

function formatExample(cat, row) {
  const of = clip(row.original_front);
  const ob = clip(row.original_back);
  const cf = clip(row.corrected_front);
  const cb = clip(row.corrected_back);

  if (cat === "should_split_polysemy" || cat === "wrong_disambiguator") {
    return `"${of || "?"}" → "${ob || "?"}"  →  fix: "${cf || of}" / "${cb || ob}"`;
  }
  if (cat === "reversed_front_back") {
    return `BAD front="${of}" back="${ob}"  →  fix front="${cf || ob}" back="${cb || of}"`;
  }
  if (cat === "front_text_edit") {
    return `front: "${of}" → "${cf || of}"`;
  }
  if (cat === "back_text_edit") {
    return `back: "${ob}" → "${cb || ob}"`;
  }
  if (cat === "duplicate_detected") {
    return `dup: "${of}" / "${ob}"`;
  }
  if (cat === "alternate_answer") {
    return `"${of}" also accepts: "${cb || ob}"`;
  }
  return `"${of || "?"}" / "${ob || "?"}" → "${cf || "?"}" / "${cb || "?"}"`;
}

function clip(s) {
  if (!s) return "";
  const str = String(s).replace(/\s+/g, " ").trim();
  return str.length > 80 ? str.slice(0, 77) + "..." : str;
}
