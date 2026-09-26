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
//     replace: true | false     // if true, the deck becomes the upload — but
//                               // nothing studied is lost: see src/lib/replaceDeck.js
//   }
//
// Quality features layered on top of raw extraction:
//
//   1. Conjugation drill expansion — when Claude flags a card as a
//      conjugation table (e.g. "vivre : je vis, tu vis, il vit..."), we
//      expand it into per-form drill cards ("vivre (présent) → je" / "je
//      vis"). The table card itself is NOT kept once it has drills: its
//      front lists every answer, so as a card it answers itself.
//
//   2. Polysemy splitting — during dedupe, if the same French front appears
//      with semantically divergent English backs (e.g. "voler" = "to steal"
//      vs "to fly"), we keep BOTH cards with disambiguator parentheticals
//      appended to the front instead of merging them.
//
//   3. Only answerable cards — every card must be one you can answer by
//      typing something the app can check (the owner's rule, 2026-09-24).
//      Grammar rules and pronunciation notes are not; keepAnswerable drops
//      any the model produced anyway. See its comment.
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
// Some of this file's pieces are also the daily cahier sync's (cahier-sync.js):
// reading the doc, slicing it into one block per class, and turning a block
// into cards. They are exported rather than copied, so the two paths can never
// drift into parsing the same notebook differently.
import { requireAnthropicKey } from "./_lib/anthropicKey.js";
// The same two tests the app itself uses, imported rather than copied: what the
// study screen calls a conjugation drill, and what the Grammar filter calls a
// rule. If the parser judged cards by different rules from the app, a card it
// let through could still be one the app treats as a rule.
import { isConjugationDrill } from "../src/lib/cardInstruction.js";
import { planReplace } from "../src/lib/replaceDeck.js";
import { archivedSource } from "../src/lib/archive.js";
import { isGrammarCard } from "../src/lib/cardTypes.js";
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

  // Step 1b: drop the rule and pronunciation cards the model produced despite
  // being told not to, and re-tag as V the plain words it filed under G.
  // After expansion, so a table has already become its drills.
  const answerable = keepAnswerable(expanded);

  // Step 2: dedupe with polysemy splitting (cross-chunk: works because
  // we now have the full set of cards in a single function call)
  const { deduped, splits } = dedupeWithPolysemy(answerable);

  // Step 3: write to Supabase. A replace used to delete the whole deck here,
  // first, and every answer with it. It now happens after the upload's cards
  // are in, and keeps everything the student has answered; see below.

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

  // A save is all or nothing: one card Postgres won't take and it refuses the
  // whole statement. A refused save is tried again in smaller pieces, down to
  // single cards, so only the cards that really can't be saved are left out.
  // Those are counted and named in the reply: they used to be hidden behind
  // "ok", and a student was told 573 cards had arrived when 1,073 should have.
  // Only a refusal about the cards themselves (codes 21, 22, 23) is worth
  // splitting; anything else — the database unreachable — fails the lot.
  let inserted = 0;
  const failed = [];
  const saveRows = async (chunk) => {
    const { error: insErr, count } = await adminClient
      .from("user_cards")
      .upsert(chunk, { onConflict: "user_id,front", count: "exact" });
    if (!insErr) {
      inserted += count || chunk.length;
      return;
    }
    const aboutTheCards = /^2[123]/.test(String(insErr.code || ""));
    if (chunk.length > 1 && aboutTheCards) {
      const size = chunk.length > 50 ? 50 : 1;
      for (let i = 0; i < chunk.length; i += size) await saveRows(chunk.slice(i, i + size));
      return;
    }
    console.error("upsert refused", chunk.length, "card(s):", insErr);
    for (const r of chunk) failed.push({ front: r.front, error: insErr.message });
  };
  for (let i = 0; i < rows.length; i += 500) await saveRows(rows.slice(i, i + 500));
  if (failed.length) {
    errors.push({ step: "upsert", error: `${failed.length} card(s) not saved: ${failed[0].error}` });
  }

  // Replace: the cards the upload doesn't have. Only once the upload's own
  // cards are all in — a replace that failed half way used to leave a deck
  // emptied and half refilled. See src/lib/replaceDeck.js.
  let removed = 0;
  let keptOutOfStudy = 0;
  if (replace && errors.length === 0) {
    try {
      const existing = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await adminClient
          .from("user_cards")
          .select("id, front, source, fsrs_state, en_fsrs_state")
          .eq("user_id", userId)
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        existing.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const fronts = rows.map((r) => r.front);
      // A card put back to never answered by "Reset all progress" still has
      // its answers on record; it is kept too, not deleted with them.
      const candidates = planReplace(existing, fronts).remove;
      const withHistory = new Set();
      for (let i = 0; i < candidates.length; i += 200) {
        const { data, error } = await adminClient
          .from("card_reviews")
          .select("card_id")
          .eq("user_id", userId)
          .in("card_id", candidates.slice(i, i + 200));
        if (error) throw error;
        for (const r of data || []) withHistory.add(r.card_id);
      }
      const plan = planReplace(existing, fronts, withHistory);
      for (let i = 0; i < plan.remove.length; i += 200) {
        // Never answered, checked again by the database itself: a card
        // answered on another device meanwhile is not deleted.
        const { error, count } = await adminClient
          .from("user_cards")
          .delete({ count: "exact" })
          .in("id", plan.remove.slice(i, i + 200))
          .eq("user_id", userId)
          .eq("fsrs_state", 0)
          .eq("en_fsrs_state", 0);
        if (error) throw error;
        removed += count || 0;
      }
      const bySource = new Map();
      for (const row of plan.archive) {
        const to = archivedSource(row.source);
        if (!bySource.has(to)) bySource.set(to, []);
        bySource.get(to).push(row.id);
      }
      for (const [source, ids] of bySource) {
        for (let i = 0; i < ids.length; i += 200) {
          const { error } = await adminClient
            .from("user_cards")
            .update({ source })
            .in("id", ids.slice(i, i + 200))
            .eq("user_id", userId);
          if (error) throw error;
        }
      }
      keptOutOfStudy = plan.archive.length;
    } catch (e) {
      console.error("replace clean-up failed:", e);
      errors.push({ step: "replace", error: e.message || String(e) });
    }
  }

  const allDates = [...new Set(deduped.flatMap((c) => c.dates))].sort();

  console.log(
    `[parse-cahier] commit: raw=${rawCards.length} slashSplit=${splitCards.length} expanded=${expanded.length} notAnswerable=${expanded.length - answerable.length} deduped=${deduped.length} inserted=${inserted} drills=${drillsGenerated} splits=${splits} replaced: removed=${removed} keptOutOfStudy=${keptOutOfStudy} errors=${errors.length}`
  );

  return res.status(200).json({
    // Not ok only when nothing at all was saved, so the dialog shows an
    // error; a partial save reports what's missing through cardsFailed.
    ok: !(inserted === 0 && failed.length > 0),
    error: inserted === 0 && failed.length > 0
      ? `None of the ${failed.length} cards could be saved: ${failed[0].error}`
      : undefined,
    cardsInserted: inserted,
    cardsFailed: failed.length,
    failedFronts: failed.slice(0, 10).map((f) => f.front),
    uniqueCards: deduped.length,
    datesCovered: allDates.length,
    dateRange: allDates.length
      ? [allDates[0], allDates[allDates.length - 1]]
      : null,
    conjugationDrillsGenerated: drillsGenerated,
    polysemySplits: splits,
    // A replace: never-answered cards the upload didn't have, deleted; and
    // answered ones taken out of study with their history kept.
    removed,
    keptOutOfStudy,
    errors: errors.slice(0, 10),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Google Doc fetch
// ═══════════════════════════════════════════════════════════════════════════

export async function fetchGoogleDoc(url) {
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

export function sliceIntoBlocks(rawText) {
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

// What may become a card, how each kind of item under "Prononciation
// Grammaire" is treated, the conjugation-table special case, and the reply
// format. Shared by this file's prompt and cahier-parse.js's (the upload
// dialog's extract step), so the two upload paths can't drift into different
// ideas of what a card is. The owner's rule behind it, 2026-09-24: a card must
// be answerable by typing something the app can check. A grammar rule has no
// one answer to type, and the app has no microphone for a pronunciation note.
//
// keepAnswerable enforces the same rule in code, because the model won't
// always follow it — the prompt is the first line, not the only one.
//
// A drill's persons are listed word for word because keepAnswerable keeps a
// drill only when parseDrill knows its person: "qu'il/elle" is one, but "que
// il/elle" and "qu'il/qu'elle" are not, and a drill written that way would be
// dropped as a rule.
export const WHAT_BECOMES_A_CARD = `WHAT BECOMES A CARD:
The student sees one side of a card and TYPES the other, and the app checks what they typed. So every card needs one answer that can be typed and checked. The app has no microphone, and a rule cannot be typed back as an answer: grammar rules and pronunciation notes are NOT cards.

Categories — do not decide them by where an item sits in the text:
- "V" — every ordinary card: a French word, expression or sentence on the front, its English translation on the back. That is everything from "Vocabulaire Expressions", AND every real French word, phrase or example sentence found under "Prononciation Grammaire".
- "G" — ONLY a conjugation drill (below) or a conjugation table (SPECIAL CASE below). Nothing else is ever "G".

What to do with each item under "Prononciation Grammaire":
- A full conjugation table (3 or more forms) → the SPECIAL CASE below.
- A single conjugated form, or a past participle → one drill card, category "G". The front is "infinitive (tense) → person", or "infinitive → participe passé" for a participle; the back is the form, with its pronoun. The tense is one of: présent, imparfait, futur, passé composé, plus-que-parfait, conditionnel, subjonctif, impératif. The person is written exactly as one of: je, tu, il/elle, nous, vous, ils/elles — and for the subjonctif, exactly as one of: que je, que tu, qu'il/elle, que nous, que vous, qu'ils/elles.
    "je vis (vivre)" → front "vivre (présent) → je", back "je vis"
    "que j'aille" → front "aller (subjonctif) → que je", back "que j'aille"
    "pp de devoir : dû" → front "devoir → participe passé", back "dû"
- A real French word, phrase or example sentence → an ordinary card, category "V", with its English translation. Drop any {respelling} or sound note from both sides.
    "mon copain" → front "mon copain", back "my boyfriend"
- A rule, explanation or pattern → NO card. "moins + adj / moins de + nom", "qui = sujet / que = COD", "passé composé avec être", "Pronoms toniques : moi, toi, lui/elle…" all produce nothing. The one exception: each FULL French example sentence the rule gives becomes its own "V" card with its English translation.
    "qui = sujet : l'homme qui parle" → one card: front "l'homme qui parle", back "the man who is speaking"
- A pronunciation note → NO card about the sound. The real French word it is about becomes a "V" card with its English translation, and nothing about how it sounds.
    "du riz {ri} — silent z" → front "du riz", back "rice"
  A note with no real word in it (a sound, a spelling pattern, a list of letters) produces nothing.

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

Only use the conjugation flag for FULL tables with 3 or more forms listed. A single form is not a table: it is a drill card (above). A pattern like "je viens de + infinitif" is a rule, so it is no card at all.

Return ONLY a JSON array, no preamble, no markdown fences, no explanation. Each element is either:
  {"front": "...", "back": "...", "category": "V" | "G"}
or for conjugation tables:
  {"front": "...", "back": "...", "category": "G", "conjugation": true, "infinitive": "...", "tense": "...", "forms": [...]}

If the block has no extractable cards, return [].`;

const EXTRACTION_PROMPT = `You are extracting flashcards from a French student's daily lesson notes.

The text below is one lesson day from a cahier (notebook) kept by a French teacher, organized under two headers:
- "Vocabulaire Expressions" — vocabulary words AND expressions/phrases, mixed together
- "Prononciation Grammaire" — pronunciation notes, grammar rules, conjugations and example sentences, mixed together

Your job: turn every French word, expression and sentence into a flashcard with an English translation, and every conjugated form into a drill. Grammar rules and pronunciation notes are not cards — see WHAT BECOMES A CARD below.

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
7. For each card, assign a category, "V" or "G", as set out under WHAT BECOMES A CARD below. "G" is ONLY for conjugation drills and conjugation tables; every other card is "V", whichever section it came from.
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

${WHAT_BECOMES_A_CARD}

Here is the lesson text:

---
{BLOCK_TEXT}
---`;

export async function extractCardsFromBlock(anthropic, block) {
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

export function splitSlashPairs(cards) {
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

// A table becomes one drill per form, and the table card itself goes. It used
// to be kept "for passive review", but its front — "vivre : je vis, tu vis,
// il vit, …" — lists every answer, so it answers itself and isn't a drill;
// there is nothing on it to type that the card hasn't already shown.
//
// A table that yields no drills (no infinitive, no usable forms) is kept as a
// plain card, stripped of its metadata, and left to keepAnswerable, which
// drops it — a whole table on one side is not a card either.
export function expandConjugations(cards) {
  const output = [];
  let drillsGenerated = 0;

  for (const card of cards) {
    const drills = card.conjugation ? conjugationDrills(card) : [];
    if (drills.length === 0) {
      // A clean card (metadata fields stripped).
      output.push({
        front: card.front,
        back: card.back,
        category: card.category,
        dates: card.dates,
        source: "cahier-upload",
      });
      continue;
    }
    output.push(...drills);
    drillsGenerated += drills.length;
  }

  return { expanded: output, drillsGenerated };
}

function conjugationDrills(card) {
  if (!card.infinitive) return [];
  if (!Array.isArray(card.forms) || card.forms.length === 0) return [];

  const tenseLabel =
    card.tense && card.tense !== "unknown" ? ` (${card.tense})` : "";

  const drills = [];
  for (let i = 0; i < Math.min(6, card.forms.length); i++) {
    const form = card.forms[i];
    if (!form || typeof form !== "string" || !form.trim()) continue;
    const pronoun = SUBJECT_PRONOUNS[i];
    drills.push({
      front: `${card.infinitive}${tenseLabel} → ${pronoun}`,
      back: form.trim(),
      category: "G",
      dates: Array.isArray(card.dates) ? [...card.dates] : [],
      source: "conjugation-drill",
    });
  }
  return drills;
}

// ═══════════════════════════════════════════════════════════════════════════
// Only cards that can be answered by typing
// ═══════════════════════════════════════════════════════════════════════════
//
// The owner's rule (2026-09-24): a card must be answerable by typing something
// the app can check. A grammar rule — "Pronoms toniques" → "moi, toi,
// lui/elle…", "qui = sujet / que = COD" — has no one answer to type. A
// pronunciation note — "du riz {ri}" → "riz: silent z" — is about a sound,
// and the app has no microphone. Neither is a card any more. The grammar that
// stays is the conjugation drill: "vivre (présent) → je" / "je vis".
//
// The prompt (WHAT_BECOMES_A_CARD) says all this, and the model mostly
// listens. "Mostly" is the problem: for as long as this parser has existed it
// was told to tag by POSITION, everything under the grammar heading G, and a
// rule card that slips through is shown, failed and rescheduled for ever. So
// the rule is enforced here too, on every card, in every upload path: the
// upload dialog's commit (below), cahier-parse's extract, and the linked-doc
// sync (cahier-sync.js).
//
// Run it AFTER expandConjugations, so a table has already become its drills.
// Only G cards are judged, in this order:
//   1. a conjugation drill stays G;
//   2. a table still waiting to be expanded (conjugation: true) passes
//      through, for expandConjugations to turn into drills — cahier-parse
//      runs this before the commit expands;
//   3. anything that reads as a rule or a sound note — isGrammarCard, the
//      test the Grammar filter uses — or as a whole conjugation table on one
//      side is dropped;
//   4. what is left is a real word or sentence that happened to sit under the
//      grammar heading ("mon copain", "le seul projet que j'ai vu"), and it
//      becomes an ordinary card, V.
// V cards are left alone. Pure: returns a new array, and a re-tagged card is a
// copy, never the caller's object.
export function keepAnswerable(cards) {
  const out = [];
  for (const card of cards || []) {
    if (!card || card.category !== "G") {
      out.push(card);
      continue;
    }
    if (isConjugationDrill(card.front)) {
      out.push(card);
      continue;
    }
    if (card.conjugation === true) {
      out.push(card);
      continue;
    }
    if (
      isGrammarCard({ f: card.front, b: card.back }) ||
      isConjugationTable(card.front) ||
      isConjugationTable(card.back)
    ) {
      continue;
    }
    out.push({ ...card, category: "V" });
  }
  return out;
}

// A whole conjugation table on one side — "vivre : je vis, tu vis, il vit, …",
// "que j'aille, que tu ailles, qu'il aille". isGrammarCard doesn't catch one,
// because there is no rule vocabulary in it, so it is named here: three or
// more comma-separated parts that each start with a subject pronoun. Only ever
// asked of G cards, so a V sentence that lists three clauses is never judged.
const PERSON_START =
  /^(?:que\s+|qu['’])?(?:j['’]|(?:je|tu|il|elle|on|nous|vous|ils|elles)(?:\/(?:il|elle|ils|elles))?\s)/i;

function isConjugationTable(text) {
  // "vivre : je vis, …" — the infinitive and its colon come off first.
  const body = String(text || "").replace(/^[^:,]*:\s*/, "");
  return body.split(/\s*[,;]\s*/).filter((part) => PERSON_START.test(part)).length >= 3;
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

export function dedupeWithPolysemy(cards) {
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
      const senses = clusters.map((cluster) => {
        const merged = mergeCluster(cluster);
        merged.front = `${merged.front} (${shortDisambiguator(merged.back)})`;
        return merged;
      });
      // Two senses can come out with the same label — two long glosses that
      // share their first three words — and that is one card, not two.
      const distinct = mergeSameFront(senses);
      splits += distinct.length - 1;
      deduped.push(...distinct);
    }
  }

  // No two cards may leave here with the same front. The deck allows one card
  // per front, and a save holding two is refused whole: every card in it is
  // lost, not just the repeat. On 2026-09-25 one word taught in three classes
  // took 499 other cards down with it.
  return { deduped: mergeSameFront(deduped), splits };
}

// Cards whose fronts match once case, accents and spacing are set aside,
// merged into one: the longest back, every date.
function mergeSameFront(cards) {
  const byFront = new Map();
  for (const card of cards) {
    const key = normalizeKey(card.front);
    if (!byFront.has(key)) byFront.set(key, []);
    byFront.get(key).push(card);
  }
  return [...byFront.values()].map((group) =>
    group.length === 1 ? group[0] : { ...mergeCluster(group), front: group[0].front }
  );
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
  // Both glosses are only small words — "not as … as", "it is", "so": the
  // translation of a little word, not two senses of it. This used to score 0,
  // even for a gloss against itself, so a word taught in three classes became
  // three cards with one front.
  if (sa.size === 0 && sb.size === 0) return 1;
  // Only one side is small words ("pas": "not" against "step"): compare every
  // word, small ones included.
  if (sa.size === 0 || sb.size === 0) return jaccard(allWords(a), allWords(b));
  return jaccard(sa, sb);
}

function jaccard(sa, sb) {
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

function allWords(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s']/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function contentWords(text) {
  return new Set([...allWords(text)].filter((w) => w.length >= 2 && !STOP_WORDS.has(w)));
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

export function cleanFrenchFront(fr, en) {
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

