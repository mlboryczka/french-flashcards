// Vercel serverless function: POST /api/parse-cahier
//
// Takes a raw cahier (text or Google Doc link), extracts structured
// flashcards via Claude, dedupes across dates, and writes them into the
// authenticated user's user_cards table.
//
// Request body (JSON):
//   {
//     mode: "text" | "url",
//     content: "<raw text>" | "<google doc url>",
//     replace: true | false     // if true, deletes existing user_cards first
//   }
//
// Quality features layered on top of raw extraction:
//
//   1. Conjugation drill expansion — when Claude flags a card as a
//      conjugation table (e.g. "vivre : je vis, tu vis, il vit..."), we
//      expand it into per-form drill cards ("vivre (présent) → je" / "je
//      vis") AND keep the summary card for passive review.
//
//   2. Polysemy splitting — during dedupe, if the same French front appears
//      with semantically divergent English backs (e.g. "voler" = "to steal"
//      vs "to fly"), we keep BOTH cards with disambiguator parentheticals
//      appended to the front instead of merging them.
//
// Response:
//   {
//     ok: true,
//     cardsInserted: 847,
//     uniqueCards: 812,
//     datesCovered: 152,
//     dateRange: ["2025-05-13", "2026-04-10"],
//     conjugationDrillsGenerated: 48,
//     polysemySplits: 6,
//     errors: []
//   }

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

const DATE_HEADER_RE = /^Le\s+(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})\s*$/im;

const SUBJECT_PRONOUNS = ["je", "tu", "il/elle", "nous", "vous", "ils/elles"];

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

  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return res.status(401).json({ error: "Missing auth token" });
  }

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

  // ── Step 1: get raw text ──────────────────────────────────────────────
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

  console.log(`[parse-cahier] start: ${blocks.length} blocks, user=${userId}`);

  // ── Step 3: Claude extraction ─────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const allCards = [];
  const errors = [];

  // Concurrency: 20 in flight is well within Anthropic's per-org rate limits
  // for Haiku and gets the whole cahier through in ~30-60s instead of ~3min.
  // If you start hitting 429s, drop this to 10.
  const BATCH_SIZE = 20;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((b) =>
        extractCardsFromBlock(anthropic, b).catch((e) => ({
          error: e.message,
          block: b,
        }))
      )
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

  // ── Step 4: expand conjugation tables into drill cards ───────────────
  const { expanded, drillsGenerated } = expandConjugations(allCards);

  // ── Step 5: dedupe with polysemy splitting ───────────────────────────
  const { deduped, splits } = dedupeWithPolysemy(expanded);

  // ── Step 6: write to Supabase ────────────────────────────────────────
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
    source: c.source || "cahier-upload",
  }));

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

  console.log(
    `[parse-cahier] done: blocks=${blocks.length} raw=${allCards.length} expanded=${expanded.length} deduped=${deduped.length} inserted=${inserted} drills=${drillsGenerated} splits=${splits} errors=${errors.length}`
  );

  return res.status(200).json({
    ok: true,
    cardsInserted: inserted,
    uniqueCards: deduped.length,
    datesCovered: allDates.length,
    dateRange: allDates.length
      ? [allDates[0], allDates[allDates.length - 1]]
      : null,
    blocksProcessed: blocks.length,
    conjugationDrillsGenerated: drillsGenerated,
    polysemySplits: splits,
    errors: errors.slice(0, 10),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Google Doc fetch
// ═══════════════════════════════════════════════════════════════════════════

async function fetchGoogleDoc(url) {
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

function sliceIntoBlocks(rawText) {
  const lines = rawText.split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const match = line.trim().match(DATE_HEADER_RE);
    if (match) {
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

  return blocks
    .map((b) => ({ date: b.date, text: stripHomework(b.text).trim() }))
    .filter((b) => b.text.length > 20);
}

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
6. Skip lines that are clearly not flashcard material: homework assignments, URLs, footer references, teacher's personal notes, section headers themselves ("Vocabulaire Expressions", "Prononciation Grammaire").
7. For each card, assign a category:
   - "V" if it came from the Vocabulaire Expressions section
   - "G" if it came from the Prononciation Grammaire section
   Use the position in the text to determine this — items before "Prononciation Grammaire" are V, items after are G.
8. If an item has an inline English translation already in the source (e.g. "louer - to rent"), use that translation.
9. Do not invent cards. Only extract what's actually in the text.

SPECIAL CASE — CONJUGATION TABLES:
If you see a full conjugation listed inline across multiple forms, like:
  "vivre : je vis, tu vis, il vit, nous vivons, vous vivez, ils vivent"
  "que j'aille, que tu ailles, qu'il aille, que nous allions, que vous alliez, qu'ils aillent"
  "je suis, tu es, il est, nous sommes, vous êtes, ils sont"
...extract it as a single card with the full table as the front, set category to "G", AND add these additional fields:
  "conjugation": true
  "infinitive": the verb infinitive (e.g. "vivre", "aller", "être")
  "tense": one of "présent", "subjonctif", "imparfait", "conditionnel", "passé composé", "futur", or "unknown"
  "forms": array of six strings in order [je, tu, il/elle, nous, vous, ils/elles]. Use null for any slot that isn't present in the source.

Example conjugation card:
  {"front": "vivre : je vis, tu vis, il vit, nous vivons, vous vivez, ils vivent",
   "back": "to live (present tense)",
   "category": "G",
   "conjugation": true,
   "infinitive": "vivre",
   "tense": "présent",
   "forms": ["je vis", "tu vis", "il vit", "nous vivons", "vous vivez", "ils vivent"]}

Only use the conjugation flag for FULL tables with 3 or more forms listed. A single form like "je viens de + infinitif" is NOT a conjugation table — it's a regular grammar card.

Return ONLY a JSON array, no preamble, no markdown fences, no explanation. Each element is either:
  {"front": "...", "back": "...", "category": "V" | "G"}
or for conjugation tables:
  {"front": "...", "back": "...", "category": "G", "conjugation": true, "infinitive": "...", "tense": "...", "forms": [...]}

If the block has no extractable cards, return [].

Here is the lesson text:

---
{BLOCK_TEXT}
---`;

async function extractCardsFromBlock(anthropic, block) {
  const prompt = EXTRACTION_PROMPT.replace("{BLOCK_TEXT}", block.text);

  const response = await anthropic.messages.create({
    // Haiku is ~3-5× faster than Sonnet and just as accurate on this task,
    // since the cahier format is very regular and Claude is just doing
    // structured extraction, not reasoning. Sonnet was overkill.
    model: "claude-haiku-4-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((c) => c.type === "text");
  if (!textBlock) {
    throw new Error("Claude returned no text block");
  }
  let jsonText = textBlock.text.trim();
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
      conjugation: c.conjugation === true,
      infinitive: typeof c.infinitive === "string" ? c.infinitive.trim() : null,
      tense: typeof c.tense === "string" ? c.tense.trim() : null,
      forms: Array.isArray(c.forms) ? c.forms : null,
    }))
    .filter((c) => c.front.length > 0 && c.back.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Conjugation expansion
// ═══════════════════════════════════════════════════════════════════════════

function expandConjugations(cards) {
  const output = [];
  let drillsGenerated = 0;

  for (const card of cards) {
    // Always keep the original as a clean card (strip metadata fields)
    output.push({
      front: card.front,
      back: card.back,
      category: card.category,
      dates: card.dates,
      source: "cahier-upload",
    });

    if (!card.conjugation) continue;
    if (!card.infinitive) continue;
    if (!Array.isArray(card.forms) || card.forms.length === 0) continue;

    const tenseLabel =
      card.tense && card.tense !== "unknown" ? ` (${card.tense})` : "";

    for (let i = 0; i < Math.min(6, card.forms.length); i++) {
      const form = card.forms[i];
      if (!form || typeof form !== "string" || !form.trim()) continue;
      const pronoun = SUBJECT_PRONOUNS[i];
      output.push({
        front: `${card.infinitive}${tenseLabel} → ${pronoun}`,
        back: form.trim(),
        category: "G",
        dates: [...card.dates],
        source: "conjugation-drill",
      });
      drillsGenerated++;
    }
  }

  return { expanded: output, drillsGenerated };
}

// ═══════════════════════════════════════════════════════════════════════════
// Dedupe with polysemy splitting
// ═══════════════════════════════════════════════════════════════════════════
//
// If two entries have the same normalized French front but semantically
// divergent English backs, keep BOTH as separate cards with disambiguator
// parentheticals. Otherwise merge (same as plain dedupe).
//
// "Semantically divergent" = Jaccard similarity on content words < 0.3.

function dedupeWithPolysemy(cards) {
  const groups = new Map();
  for (const card of cards) {
    const key = normalizeKey(card.front);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }

  const deduped = [];
  let splits = 0;

  for (const [, group] of groups) {
    if (group.length === 1) {
      deduped.push({ ...group[0], dates: [...group[0].dates] });
      continue;
    }

    const clusters = clusterByBackSimilarity(group);

    if (clusters.length === 1) {
      deduped.push(mergeCluster(clusters[0]));
    } else {
      splits += clusters.length - 1;
      for (const cluster of clusters) {
        const merged = mergeCluster(cluster);
        const disambiguator = shortDisambiguator(merged.back);
        merged.front = `${merged.front} (${disambiguator})`;
        deduped.push(merged);
      }
    }
  }

  return { deduped, splits };
}

function mergeCluster(cluster) {
  const mergedDates = [
    ...new Set(cluster.flatMap((c) => c.dates)),
  ].sort();
  const longest = cluster.reduce((a, b) =>
    b.back.length > a.back.length ? b : a
  );
  return {
    front: longest.front,
    back: longest.back,
    category: longest.category,
    dates: mergedDates,
    source: longest.source || "cahier-upload",
  };
}

function clusterByBackSimilarity(group) {
  const THRESHOLD = 0.3;
  const clusters = [];
  for (const card of group) {
    let placed = false;
    for (const cluster of clusters) {
      if (backSimilarity(card.back, cluster[0].back) >= THRESHOLD) {
        cluster.push(card);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([card]);
    }
  }
  return clusters;
}

function backSimilarity(a, b) {
  const sa = contentWords(a);
  const sb = contentWords(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const w of sa) if (sb.has(w)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "then", "so",
  "it", "its", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their",
  "not", "no", "do", "does", "did",
  "from", "as", "about", "into", "out", "up", "down",
]);

function contentWords(text) {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

function shortDisambiguator(back) {
  const trimmed = back.trim();
  if (trimmed.length <= 30) return trimmed;
  const words = trimmed.split(/\s+/);
  return words.slice(0, 3).join(" ");
}

function normalizeKey(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
