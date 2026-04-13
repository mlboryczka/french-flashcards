// Vercel serverless function: POST /api/parse-cahier
//
// Takes a raw cahier (text, PDF, DOCX, or Google Doc link), extracts
// structured flashcards via Claude, dedupes across dates, and writes them
// into the authenticated user's user_cards table.
//
// Request body (JSON):
//   {
//     mode: "text" | "url",
//     content: "<raw text>" | "<google doc url>",
//     replace: true | false     // if true, deletes existing user_cards first
//   }
//
// For file uploads (PDF/DOCX), the frontend extracts text client-side via
// pdf.js / mammoth and sends it as mode:"text". Keeps this function simple
// and avoids shipping heavy parsers server-side.
//
// Response:
//   {
//     ok: true,
//     cardsInserted: 847,
//     datesCovered: 152,
//     dateRange: ["2025-05-13", "2026-04-10"],
//     errors: []
//   }
//
// Environment variables:
//   ANTHROPIC_API_KEY            — Claude API key
//   SUPABASE_URL                 — project URL
//   SUPABASE_SERVICE_ROLE_KEY    — service role key (bypasses RLS)

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

const MONTHS_FR = {
  janvier: "01", février: "02", fevrier: "02",
  mars: "03", avril: "04", mai: "05", juin: "06",
  juillet: "07", août: "08", aout: "08",
  septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12",
};

// Matches "Le 10 avril 2026", "Le 1er avril 2026", "Le 31 mars 2026"
const DATE_HEADER_RE = /^Le\s+(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})\s*$/im;

// ═══════════════════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
    process.env;
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Auth — the frontend sends the user's access token in Authorization header
  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  // Resolve the user from their token
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await adminClient.auth.getUser(
    accessToken
  );
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: "Invalid auth token" });
  }
  const userId = userData.user.id;

  const { mode, content, replace } = req.body || {};
  if (!mode || !content) {
    return res.status(400).json({ error: "Missing mode or content" });
  }
  if (!["text", "url"].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'text' or 'url'" });
  }

  // ── Step 1: get the raw text ──────────────────────────────────────────
  let rawText;
  try {
    rawText = mode === "url" ? await fetchGoogleDoc(content) : content;
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!rawText || rawText.length < 50) {
    return res.status(400).json({ error: "Input is empty or too short" });
  }
  if (rawText.length > 500_000) {
    return res.status(400).json({
      error: "Input too large (max ~500K characters). Try a shorter cahier.",
    });
  }

  // ── Step 2: slice into per-date blocks ────────────────────────────────
  const blocks = sliceIntoBlocks(rawText);
  if (blocks.length === 0) {
    return res.status(400).json({
      error:
        "No lesson dates found. Expected headers like 'Le 10 avril 2026'. " +
        "Check that your cahier has dated entries in French format.",
    });
  }

  // ── Step 3: send each block to Claude for extraction ──────────────────
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const allCards = [];
  const errors = [];

  // Process in small parallel batches to avoid rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((b) => extractCardsFromBlock(anthropic, b).catch((e) => ({ error: e.message, block: b })))
    );
    for (const r of results) {
      if (r.error) {
        errors.push({ date: r.block?.date, error: r.error });
      } else {
        allCards.push(...r);
      }
    }
  }

  if (allCards.length === 0) {
    return res.status(500).json({
      error: "Claude returned no cards from any block",
      errors: errors.slice(0, 5),
    });
  }

  // ── Step 4: dedupe ────────────────────────────────────────────────────
  const deduped = dedupeCards(allCards);

  // ── Step 5: write to Supabase ─────────────────────────────────────────
  if (replace) {
    const { error: delErr } = await adminClient
      .from("user_cards")
      .delete()
      .eq("user_id", userId);
    if (delErr) {
      console.error("delete failed:", delErr);
      return res.status(500).json({ error: "Failed to clear existing deck" });
    }
  }

  const rows = deduped.map((c) => ({
    user_id: userId,
    front: c.front,
    back: c.back,
    category: c.category,
    dates: c.dates,
    source: "cahier-upload",
  }));

  // Upsert in chunks of 500 to stay under PostgREST limits
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error: insErr, count } = await adminClient
      .from("user_cards")
      .upsert(chunk, { onConflict: "user_id,front", count: "exact" });
    if (insErr) {
      console.error("upsert failed on chunk starting at", i, insErr);
      errors.push({ step: "upsert", error: insErr.message });
      continue;
    }
    inserted += count || chunk.length;
  }

  const allDates = [...new Set(deduped.flatMap((c) => c.dates))].sort();

  return res.status(200).json({
    ok: true,
    cardsInserted: inserted,
    uniqueCards: deduped.length,
    datesCovered: allDates.length,
    dateRange: allDates.length ? [allDates[0], allDates[allDates.length - 1]] : null,
    blocksProcessed: blocks.length,
    errors: errors.slice(0, 10),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Google Doc fetch
// ═══════════════════════════════════════════════════════════════════════════

async function fetchGoogleDoc(url) {
  // Accept a variety of Google Doc URL formats and extract the doc ID
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error(
      "Not a recognized Google Doc URL. Expected format: https://docs.google.com/document/d/..."
    );
  }
  const docId = match[1];
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(exportUrl);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Google Doc isn't publicly viewable. In Google Docs: File → Share → General access → 'Anyone with the link' → Viewer. Then paste the link again."
      );
    }
    throw new Error(`Google Doc fetch failed: HTTP ${res.status}`);
  }
  return await res.text();
}

// ═══════════════════════════════════════════════════════════════════════════
// Slicing
// ═══════════════════════════════════════════════════════════════════════════

// Split the raw cahier into blocks, one per lesson date.
// Returns: [{ date: "2026-04-10", text: "...block contents..." }, ...]
function sliceIntoBlocks(rawText) {
  const lines = rawText.split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const match = line.trim().match(DATE_HEADER_RE);
    if (match) {
      // Save previous block
      if (current) blocks.push(current);
      const [, day, monthName, year] = match;
      const month = MONTHS_FR[monthName.toLowerCase()];
      if (!month) {
        current = null;
        continue;
      }
      const isoDate = `${year}-${month}-${day.padStart(2, "0")}`;
      current = { date: isoDate, text: "" };
    } else if (current) {
      current.text += line + "\n";
    }
  }
  if (current) blocks.push(current);

  // Filter out empty blocks and "Pour la prochaine fois" sections within each
  return blocks
    .map((b) => ({
      date: b.date,
      text: stripHomework(b.text).trim(),
    }))
    .filter((b) => b.text.length > 20);
}

// Remove "Pour la prochaine fois : ..." through end of block (it's homework
// notes, not flashcard material)
function stripHomework(text) {
  const idx = text.search(/Pour la prochaine fois\s*:/i);
  if (idx === -1) return text;
  return text.slice(0, idx);
}

// ═══════════════════════════════════════════════════════════════════════════
// Claude extraction
// ═══════════════════════════════════════════════════════════════════════════

const EXTRACTION_PROMPT = `You are extracting flashcards from a French student's daily lesson notes.

The text below is one lesson day from a cahier (notebook) kept by a French teacher. It contains French vocabulary, expressions, pronunciation notes, and grammar rules, organized under two headers:
- "Vocabulaire Expressions" — vocabulary words AND expressions/phrases, mixed together
- "Prononciation Grammaire" — pronunciation notes AND grammar rules, mixed together

Your job: extract every French term/phrase/rule as a flashcard with an English translation.

Rules:
1. Preserve the EXACT French spelling including accents, apostrophes, and punctuation. Do not "correct" anything.
2. Keep articles (un, une, le, la, les, des, du) when present — they're semantically meaningful in French.
3. For gender pairs like "un vendeur / une vendeuse" or "gros, grosse (adj)", keep them as a single card.
4. For synonyms separated by / like "mémoriser / retenir", keep them as a single card with the / preserved.
5. Translate naturally into English. For expressions, give the idiomatic English equivalent, not a literal word-by-word translation.
6. Skip lines that are clearly not flashcard material: homework assignments, URLs, footer references, teacher's personal notes like "Pour la prochaine fois", section headers themselves ("Vocabulaire Expressions", "Prononciation Grammaire").
7. For each card, assign a category:
   - "V" if it came from the Vocabulaire Expressions section
   - "G" if it came from the Prononciation Grammaire section
   Use the position in the text to determine this — items before "Prononciation Grammaire" are V, items after are G.
8. If an item has an inline English translation already in the source (e.g. "louer - to rent"), use that translation.
9. Do not invent cards. Only extract what's actually in the text.

Return ONLY a JSON array, no preamble, no markdown fences, no explanation. Each element:
{"front": "<french>", "back": "<english>", "category": "V" | "G"}

If the block has no extractable cards, return [].

Here is the lesson text:

---
{BLOCK_TEXT}
---`;

async function extractCardsFromBlock(anthropic, block) {
  const prompt = EXTRACTION_PROMPT.replace("{BLOCK_TEXT}", block.text);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((c) => c.type === "text");
  if (!textBlock) {
    throw new Error("Claude returned no text block");
  }
  let jsonText = textBlock.text.trim();

  // Strip markdown fences if Claude added them despite instructions
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${jsonText.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Claude did not return a JSON array");
  }

  // Tag every card with this block's date, validate shape
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
      dates: [block.date],
    }))
    .filter((c) => c.front.length > 0 && c.back.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Dedupe
// ═══════════════════════════════════════════════════════════════════════════

// Collapse duplicates by normalized French front, merging dates arrays.
// Preserves the first-seen casing/spacing of the front and back.
function dedupeCards(cards) {
  const byKey = new Map();
  for (const card of cards) {
    const key = normalizeKey(card.front);
    const existing = byKey.get(key);
    if (existing) {
      // Merge dates, dedupe, keep sorted
      const mergedDates = [...new Set([...existing.dates, ...card.dates])].sort();
      existing.dates = mergedDates;
      // If the existing back is much shorter than the new one, prefer the longer
      // (usually means the first occurrence was terse and a later one has more detail)
      if (card.back.length > existing.back.length + 10) {
        existing.back = card.back;
      }
    } else {
      byKey.set(key, { ...card, dates: [...card.dates] });
    }
  }
  return Array.from(byKey.values());
}

function normalizeKey(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents for matching only
    .replace(/\s+/g, " ")
    .trim();
}
