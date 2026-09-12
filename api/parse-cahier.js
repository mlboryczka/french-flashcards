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

import { requireUser } from "./_lib/auth.js";
import { requireAnthropicKey } from "./_lib/anthropicKey.js";
export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
  // Opt into the longest timeout the plan allows. Hobby caps this at 60s,
  // Pro at 300s. Without this set, Vercel uses the default (10s on Hobby
  // for some functions). Also lets us hit the maximum on Pro without
  // additional config in vercel.json.
  maxDuration: 300,
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

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // ANTHROPIC_API_KEY is deliberately NOT required here any more: the key
  // that pays is the caller's own unless they are the deploy owner, and
  // only the "extract" action spends anything at all.
  const user = await requireUser(req, res);
  if (!user) return;
  const userId = user.id;

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ═════════════════════════════════════════════════════════════════════
  // ACTION DISPATCH
  // ─────────────────────────────────────────────────────────────────────
  // Vercel Hobby caps function execution at 60s. To process a year-long
  // cahier (~150 lessons × ~5s each via Claude Haiku) we'd blow past that.
  // Instead, the client drives the work in three phases:
  //
  //   1. action="slice"   — POST {mode, content} → returns date-keyed blocks
  //                         The client now has the full work-list and can
  //                         track progress ("processing chunk 3 of 8").
  //
  //   2. action="extract" — POST {blocks: [...]} → returns extracted cards
  //                         Called repeatedly with chunks of ~15 blocks.
  //                         Each call finishes in ~10-15s, well under 60s.
  //
  //   3. action="commit"  — POST {cards, replace} → dedupes, expands
  //                         conjugations, writes to Supabase. Cheap, fast.
  //
  // The client accumulates cards across multiple extract calls, then sends
  // them all in one commit. Dedupe runs across the WHOLE cahier so cross-
  // chunk duplicates and polysemy clusters are handled correctly.
  // ═════════════════════════════════════════════════════════════════════

  const action = req.body?.action || "slice";

  if (action === "slice") {
    return await handleSlice(req, res);
  }
  if (action === "extract") {
    // The only action that calls Claude, so the only one that needs a key.
    const apiKey = requireAnthropicKey(req, res, user);
    if (!apiKey) return;
    return await handleExtract(req, res, apiKey);
  }
  if (action === "commit") {
    return await handleCommit(req, res, adminClient, userId);
  }
  return res.status(400).json({ error: `Unknown action: ${action}` });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION 1: SLICE — turn raw cahier text into per-date blocks
// ═══════════════════════════════════════════════════════════════════════════

async function handleSlice(req, res) {
  const { mode, content } = req.body || {};
  if (!mode || !content) {
    return res.status(400).json({ error: "Missing mode or content" });
  }
  if (!["text", "url"].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'text' or 'url'" });
  }

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

  const blocks = sliceIntoBlocks(rawText);
  if (blocks.length === 0) {
    return res.status(400).json({
      error:
        "No lesson dates found. Expected headers like 'Le 10 avril 2026'. " +
        "Check that your cahier has dated entries in French format.",
    });
  }

  console.log(`[parse-cahier] slice: ${blocks.length} blocks`);
  return res.status(200).json({ ok: true, blocks });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION 2: EXTRACT — run Claude on a chunk of blocks, return raw cards
// ═══════════════════════════════════════════════════════════════════════════

async function handleExtract(req, res, apiKey) {
  const { blocks } = req.body || {};
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: "Missing or empty blocks array" });
  }
  if (blocks.length > 30) {
    return res.status(400).json({
      error: "Chunk too large (max 30 blocks). Split into smaller chunks.",
    });
  }

  const anthropic = new Anthropic({ apiKey });
  const cards = [];
  const errors = [];

  // All blocks in the chunk run in parallel — the chunk is sized so that
  // 15 parallel Haiku calls comfortably finish in under 60s even with a
  // few slow outliers.
  const results = await Promise.all(
    blocks.map((b) =>
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
      cards.push(...r);
    }
  }

  console.log(
    `[parse-cahier] extract: ${blocks.length} blocks → ${cards.length} cards (${errors.length} errors)`
  );
  return res.status(200).json({ ok: true, cards, errors });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION 3: COMMIT — dedupe across all cards, expand conjugations, insert
// ═══════════════════════════════════════════════════════════════════════════

async function handleCommit(req, res, adminClient, userId) {
  const { cards: rawCards, replace, batch_id: batchId = null } = req.body || {};
  if (!Array.isArray(rawCards) || rawCards.length === 0) {
    return res.status(400).json({ error: "Missing or empty cards array" });
  }

  const errors = [];

  // Step 0: split // pairs into separate cards. The extraction prompt
  // asks Claude to do this, but as a safety net we also catch any that
  // slipped through. "léger // lourd (adj)" → two cards.
  // The model is told to keep English glosses off the French side, but it
  // slips — "je suis allé (I went (passé composé))" — and a card whose front
  // contains its own answer is worse than no card. Enforce it deterministically.
  const cleanedCards = rawCards.map((c) =>
    c && c.front && c.back
      ? { ...c, front: cleanFrenchFront(c.front, c.back) }
      : c
  );
  const splitCards = splitSlashPairs(cleanedCards);

  // Step 1: expand conjugation tables into drill cards
  const { expanded, drillsGenerated } = expandConjugations(splitCards);

  // Step 2: dedupe with polysemy splitting (cross-chunk: works because
  // we now have the full set of cards in a single function call)
  const { deduped, splits } = dedupeWithPolysemy(expanded);

  // Step 3: write to Supabase
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

  // batch_id is null for legacy clients that don't pass it. Postgres accepts
  // the nullable column, and `user_cards` left-joins against `upload_batches`
  // for any admin-side reporting.
  const rows = deduped.map((c) => ({
    user_id: userId,
    front: c.front,
    back: c.back,
    category: c.category,
    dates: c.dates,
    source: c.source || "cahier-upload",
    batch_id: batchId,
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
    `[parse-cahier] commit: raw=${rawCards.length} slashSplit=${splitCards.length} expanded=${expanded.length} deduped=${deduped.length} inserted=${inserted} drills=${drillsGenerated} splits=${splits} errors=${errors.length}`
  );

  return res.status(200).json({
    ok: true,
    cardsInserted: inserted,
    uniqueCards: deduped.length,
    datesCovered: allDates.length,
    dateRange: allDates.length
      ? [allDates[0], allDates[allDates.length - 1]]
      : null,
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
4. When two items are separated by / on the same line:
   - Gender pairs (un vendeur / une vendeuse) → one card (rule 3)
   - Single-word verb synonyms of the exact same action (mémoriser / retenir) → one card
   - Different expressions or phrases (au début / d'abord, faire payer / to charge) → TWO separate cards, each with its own translation. "au début" = "at the beginning" and "d'abord" = "first" are distinct expressions and must be separate cards.
5. Translate naturally into English. For expressions, give the idiomatic English equivalent, not a literal word-by-word translation.
6. Skip lines that are clearly not flashcard material: homework assignments, URLs, footer references, teacher's personal notes, section headers themselves ("Vocabulaire Expressions", "Prononciation Grammaire").
7. For each card, assign a category:
   - "V" if it came from the Vocabulaire Expressions section
   - "G" if it came from the Prononciation Grammaire section
   Use the position in the text to determine this — items before "Prononciation Grammaire" are V, items after are G.
8. If an item has a SHORT inline English translation (e.g. "louer - to rent", "She had to / she was supposed to = elle devait"), use that translation.
   BUT: if the parenthetical is a LONG contextual explanation of when/why the phrase is used (e.g. "S'il partait à l'heure (he never leaves on time but I imagine a world where he does)"), that is NOT a translation — it's a usage note. Translate the French phrase directly and APPEND the context note in parentheses on the English side. Example: front = "S'il partait à l'heure", back = "If he left on time (he never leaves on time but I imagine a world where he does)". The test: if the parenthetical describes a scenario or situation rather than giving a direct equivalent, translate the French yourself and keep the parenthetical as context.
8b. NEVER leave English on the French side. The front is the prompt — if it contains the translation, the card answers itself. "je suis allé (I went (passé composé))" must become front = "je suis allé", back = "I went (passé composé)". Grammar markers stay on the front: "(adj)", "(f)", "(pl)", "(subj)".
8c. NEVER put two different French headwords on one card. If a spelling covers two words — "les frais" (the costs, a plural noun) and "frais" (fresh, an adjective) — emit TWO cards with the correct front for each: front "les frais" back "the costs / the expenses", and front "frais (adj)" back "fresh". Never join unrelated senses with a semicolon. " / " between near-synonyms of ONE sense is fine.
9. Do not invent cards. Only extract what's actually in the text.
10. If a line pairs two different words with "//" like "léger // lourd (adj)", split them into TWO separate cards: one for "léger (adj)" → "light" and one for "lourd (adj)" → "heavy". Two different French words with different meanings must always be separate cards.
10b. The same goes for " / " joining two DIFFERENT forms or ideas rather than two ways of saying one thing. "il neige / il neigeait" is two tenses, "un avantage / l'inconvénient" is two opposite words, "copier / coller" is two actions: each is TWO cards. " / " stays only for near-synonyms of one meaning ("compter sur / dépendre de") and for gender pairs ("un vendeur / une vendeuse").
10c. A past participle drill asks for the participle, so the participle never appears on the front. "pp de devoir : dû" becomes front "devoir → participe passé", back "dû". Likewise, never put a French form inside a note on the English side: "to re-elect (past participle: réélu)" becomes back "to re-elect", plus a separate "réélire → participe passé" / "réélu" card if the notebook gives the participle.
10d. Copy the French exactly, and never drop a word. If the notebook line is missing a word the grammar requires, restore it — "je sais que peux m'ennuyer" is "je sais que je peux m'ennuyer". A missing subject pronoun or article is a transcription slip, not the French being taught.
10e. No full stop at the end of a front or a back. Keep ? and ! where the French has them.
11. In conversational French, "on" means "we" (not "one"). Translate "on" as "we" unless the context is clearly formal/literary. For example: "on était" = "we were", "on allait" = "we were going", "on s'est dit" = "we said to each other".

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
// Slash-pair splitting: "léger // lourd (adj)" → two separate cards
// ═══════════════════════════════════════════════════════════════════════════

function splitSlashPairs(cards) {
  const out = [];
  for (const c of cards) {
    // Only split on " // " (double slash with spaces) — single "/" is used
    // for gender pairs like "vendeur / vendeuse" which should stay together
    if (!c.front.includes(" // ")) {
      out.push(c);
      continue;
    }
    const frontParts = c.front.split(" // ").map((s) => s.trim());
    const backParts = c.back.split(" // ").map((s) => s.trim());

    // Only split if we get a matching number of front/back parts
    if (frontParts.length !== backParts.length) {
      // Try splitting back on " / " as fallback
      const backAlt = c.back.split(" / ").map((s) => s.trim());
      if (backAlt.length === frontParts.length) {
        for (let i = 0; i < frontParts.length; i++) {
          out.push({ ...c, front: distributeQualifier(frontParts, i), back: backAlt[i] });
        }
      } else {
        // Can't match — keep as-is
        out.push(c);
      }
      continue;
    }

    for (let i = 0; i < frontParts.length; i++) {
      out.push({ ...c, front: distributeQualifier(frontParts, i), back: backParts[i] });
    }
  }
  return out;
}

// If only the last part has a qualifier like "(adj)", "(n)", "(adv)",
// distribute it to all parts. E.g. ["léger", "lourd (adj)"] index 0
// → "léger (adj)"
function distributeQualifier(parts, index) {
  const part = parts[index];
  // Already has a qualifier? Return as-is.
  if (/\([^)]+\)\s*$/.test(part)) return part;
  // Find a qualifier in any other part
  for (const other of parts) {
    const m = other.match(/(\([^)]+\))\s*$/);
    if (m) return `${part} ${m[1]}`;
  }
  return part;
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

// ── French-side gloss stripping ─────────────────────────────────────
// Mirror of src/lib/cardText.js, which applies the same rule at display time
// to decks parsed before this existed.
// The French side of a card should be French.
//
// Cahier lines often carry an inline English gloss — "je suis allé (I went
// (passé composé))" — and the parser has sometimes kept that gloss on the
// front. When it does, the card hands you the answer before you've answered
// it, which is worse than useless: FSRS records a recall you never made.
//
// Rather than migrate thousands of existing rows (and risk mangling the ones
// that are fine), we strip the gloss at the moment the French side is used as
// a *prompt*. The stored row is untouched, and the answer side still shows
// everything.
//
// The test for "this is a gloss, not French" is overlap: if a parenthetical on
// the French side repeats a content word from the English side, it is giving
// the answer away. Grammar tags — (adj), (f), (pl), (passé composé) — are
// exempt, because they are legitimate disambiguators even when the English
// side happens to mention them too.

const GRAMMAR_TAG =
  /^(adj|adv|adje?ctif|n|nom|v|verbe?|f|m|fem|femin(in)?|masc(ulin)?|pl|plur(iel|al)?|sg|sing(ulier)?|nf|nm|inf|infinitif|pp|p\.p\.|part(icipe)?( passé)?|passé( composé)?|imparfait|futur|présent|conditionnel|subjonctif|impératif|fam|familier|litt|litteraire|littéraire)\.?$/i;

function glossWords(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3);
}

// Top-level "(...)" spans, tolerant of the unbalanced parentheses these
// malformed cards tend to have ("je suis allé (I went (passé)" never closes
// its outer group). An unclosed group runs to the end of the string.
function parentheticals(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")") {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          spans.push([start, i + 1]);
          start = -1;
        }
      }
    }
  }
  if (depth > 0 && start !== -1) spans.push([start, text.length]);
  return spans;
}

function cleanFrenchFront(fr, en) {
  if (!fr || !en || !fr.includes("(")) return fr;

  const answerWords = new Set(glossWords(en));
  if (answerWords.size === 0) return fr;

  const spans = parentheticals(fr);
  let out = fr;
  let changed = false;

  // Right to left, so earlier spans keep their indices.
  for (let i = spans.length - 1; i >= 0; i--) {
    const [s, e] = spans[i];
    const inner = fr.slice(s + 1, e).replace(/[()]/g, "").trim();
    if (!inner || GRAMMAR_TAG.test(inner)) continue;
    if (!glossWords(inner).some((w) => answerWords.has(w))) continue;
    out = out.slice(0, s) + out.slice(e);
    changed = true;
  }

  if (!changed) return fr;
  // Tidy up the hole we just left, and any parenthesis orphaned by it.
  const tidied = out.replace(/\s{2,}/g, " ").replace(/\s+([,;.!?])/g, "$1").trim();
  return tidied || fr;
}

