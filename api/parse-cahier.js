// Vercel serverless function: POST /api/parse-cahier
//
// The upload of a cahier (pasted or from a file): slices it into one block per
// class, says which lines are new, and saves the cards Claude made from them
// into the signed-in student's deck. The upload dialog drives it in steps
// (src/lib/uploadRun.js); see ACTION DISPATCH below.
//
// Quality features layered on top of raw extraction:
//
//   1. Conjugation drill expansion — when Claude flags a card as a
//      conjugation table (e.g. "vivre : je vis, tu vis, il vit..."), we
//      expand it into per-form drill cards ("vivre (présent) → je" / "je
//      vis"). The table card itself is NOT kept once it has drills: its
//      front lists every answer, so as a card it answers itself.
//
//   2. One card per thing to learn (2026-10-06). Only lines of the notes not
//      read before are read (src/lib/notesLines.js), and every new card is
//      compared with every card the student has, by the rule in
//      src/lib/sameCard.js, before it is added (src/lib/cardMatch.js). A word
//      they already have only gains the class date. Two cards with the same
//      French get labels in brackets only when Claude says their meanings
//      differ ("voler (to steal)", "voler (to fly)").
//
//   3. Only answerable cards — every card must be one you can answer by
//      typing something the app can check (the owner's rule, 2026-09-24).
//      Grammar rules and pronunciation notes are not; keepAnswerable drops
//      any the model produced anyway. See its comment.
//
// The upload used to read every class again on every upload, and to write
// over the English, category, dates and source of any card whose French it
// wrote identically. On 4 September that rewrote the English of 1,429 of the
// owner's cards and added 44 they already had. It does neither now.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

import { requireUser } from "./_lib/auth.js";
// Some of this file's pieces are also the daily cahier sync's (cahier-sync.js):
// reading the doc, slicing it into one block per class, and turning a block
// into cards. They are exported rather than copied, so the two paths can never
// drift into parsing the same notebook differently.
import { requireAnthropicKey, resolveAnthropicKey } from "./_lib/anthropicKey.js";
// The same two tests the app itself uses, imported rather than copied: what the
// study screen calls a conjugation drill, and what the Grammar filter calls a
// rule. If the parser judged cards by different rules from the app, a card it
// let through could still be one the app treats as a rule.
import { isConjugationDrill } from "../src/lib/cardInstruction.js";
import { isGrammarCard } from "../src/lib/cardTypes.js";
import { cardIndex } from "../src/lib/sameCard.js";
import { planReading, readDatesFrom, datesCovered } from "../src/lib/notesLines.js";
import { claimReading, releaseReading, readDeck, saveRun } from "./_lib/notesReading.js";
import { askSameCard } from "./_lib/sameCardQuestion.js";
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
  // A function has five minutes at most, and a year-long cahier is ~150
  // classes at ~5s each through Claude. So the dialog drives the work in
  // steps (src/lib/uploadRun.js):
  //
  //   1. action="slice"   — POST {mode, content} → the classes, one block per
  //                         date.
  //
  //   2. action="plan"    — POST {blocks} → which lines of each class are new.
  //                         This takes the student's turn to read their notes
  //                         (one run at a time), and says which classes need
  //                         reading at all: an unchanged re-upload needs none.
  //
  //   3. /api/cahier-parse — the classes with new lines, read by Claude in
  //                         chunks of ~15, the same way the linked notebook
  //                         reads them.
  //
  //   4. action="commit"  — POST {runId, blocks, cards, replace} → compares
  //                         every new card with the student's deck, saves the
  //                         new ones and the lines read, and gives the turn
  //                         back.
  //
  // "extract" is an older reading step nothing calls now, kept so an upload
  // dialog left open from before still works.
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
  if (action === "plan") {
    return await handlePlan(req, res, adminClient, userId);
  }
  if (action === "commit") {
    return await handleCommit(req, res, adminClient, user);
  }
  return res.status(400).json({ error: `Unknown action: ${action}` });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION 1: SLICE — turn raw cahier text into per-date blocks
// ═══════════════════════════════════════════════════════════════════════════

export async function handleSlice(req, res) {
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
// ACTION 2b: PLAN — which lines of the upload are new
// ═══════════════════════════════════════════════════════════════════════════

export const BUSY_MESSAGE =
  "Your notes are being read already, by the daily check or in another window. Try again in a few minutes.";
const LOST_TURN_MESSAGE =
  "This upload took so long that another reading of your notes started. Nothing was saved; upload again.";

const cleanBlocks = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && typeof b.date === "string" && typeof b.text === "string")
    .map((b) => ({ date: b.date, text: b.text }));

// The classes the linked notebook has read, which count as read here too.
async function linkClasses(adminClient, userId) {
  try {
    const { data, error } = await adminClient.from("cahier_links").select("classes").eq("user_id", userId).maybeSingle();
    return !error && data?.classes && typeof data.classes === "object" ? data.classes : {};
  } catch {
    return {};
  }
}

export async function handlePlan(req, res, adminClient, userId) {
  const blocks = cleanBlocks(req.body?.blocks);
  if (blocks.length === 0) {
    return res.status(400).json({ error: "Missing or empty blocks array" });
  }
  const reading = await claimReading(adminClient, { userId, kind: "upload" });
  if (reading.busy) return res.status(409).json({ ok: false, busy: true, error: BUSY_MESSAGE });
  try {
    const deck = await readDeck(adminClient, userId);
    const plan = planReading({
      blocks, classes: reading.classes, readDates: readDatesFrom(deck.rows, await linkClasses(adminClient, userId)),
    });
    const toRead = plan.filter((p) => p.needsReading).length;
    console.log(`[parse-cahier] plan: ${plan.length} classes, ${toRead} with lines not read before (${reading.mode})`);
    return res.status(200).json({
      ok: true,
      runId: reading.runId,
      mode: reading.mode,
      blocks: plan.map((p) => ({ date: p.date, text: p.text, read: p.needsReading, newLines: p.partial ? p.newLines : null })),
      toRead,
      unchanged: plan.length - toRead,
    });
  } catch (e) {
    await releaseReading(adminClient, userId, reading.runId);
    console.error("[parse-cahier] plan failed:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION 3: COMMIT — compare every new card with the deck, save, record
// ═══════════════════════════════════════════════════════════════════════════
//
// Body: { cards, replace, batch_id, runId, blocks, failedDates }
//   cards        what /api/cahier-parse returned for the classes read
//   blocks       every class of the upload, as sliced, so the lines read are
//                worked out again here rather than taken on trust
//   failedDates  classes Claude couldn't read; their lines stay unread
// An upload dialog from before 2026-10-06 sends only cards, replace and
// batch_id. Its cards are still compared with the deck before anything is
// added, but no lines are recorded.
//
// "Replace my existing deck" works by class (src/lib/replaceDeck.js): a card
// with none of its classes in the upload is taken out of study, kept, and
// marked "replaced". Nothing is ever deleted.

// The question about near look-alikes may take this long from the start of
// the commit, leaving the function's five minutes room to save.
const QUESTION_TIME_MS = 180 * 1000;

export async function handleCommit(req, res, adminClient, user) {
  const startedAt = Date.now();
  const userId = user.id;
  const { cards: rawCards = [], replace = false, batch_id: batchId = null, runId = null, failedDates = [] } = req.body || {};
  const blocks = Array.isArray(req.body?.blocks) ? cleanBlocks(req.body.blocks) : null;
  const legacy = blocks === null;
  if (!Array.isArray(rawCards) || (legacy && rawCards.length === 0)) {
    return res.status(400).json({ error: "Missing or empty cards array" });
  }

  const reading = await claimReading(adminClient, { userId, kind: "upload", runId });
  if (reading.busy) {
    return res.status(409).json({ ok: false, busy: true, error: runId ? LOST_TURN_MESSAGE : BUSY_MESSAGE });
  }
  try {
    const deck = await readDeck(adminClient, userId);
    const plan = legacy
      ? null
      : planReading({ blocks, classes: reading.classes, readDates: readDatesFrom(deck.rows, await linkClasses(adminClient, userId)) });
    const failed = new Set((Array.isArray(failedDates) ? failedDates : []).filter((d) => typeof d === "string"));
    const incoming = cardsFromExtracted(rawCards);
    const read = legacy
      ? new Set(incoming.flatMap((c) => c.dates || []))
      : new Set(plan.filter((p) => p.needsReading && !failed.has(p.date)).map((p) => p.date));

    // Near look-alikes are put to Claude on the student's own key, as the
    // reading was. Without one, those cards wait for the next upload.
    const key = resolveAnthropicKey(req, user);
    const ask = (pairs) =>
      key.key ? askSameCard({ apiKey: key.key, pairs, deadline: startedAt + QUESTION_TIME_MS }) : Promise.reject(new Error(key.error));

    const result = await saveRun({
      admin: adminClient, userId, reading, deck, plan, incoming, read, failedDates: [...failed], ask,
      source: "upload", batchId,
      replaceDates: replace ? (legacy ? read : datesCovered(plan, reading.classes)) : null,
    });

    // How many of the upload's cards arrived, on its batch row. Best-effort.
    if (batchId && result.ok) {
      const { error: batchErr } = await adminClient
        .from("upload_batches")
        .update({ cards_accepted: result.added, cards_edited_post_parse: 0 })
        .eq("id", batchId)
        .eq("user_id", userId);
      if (batchErr) console.warn("[parse-cahier] upload_batches count not saved:", batchErr.message);
    }

    const allDates = [...(legacy ? read : new Set(plan.map((p) => p.date)))].sort();
    const unchanged = plan ? plan.filter((p) => !p.needsReading).length : 0;
    const drills = result.decisions.filter((d) => d.action === "insert" && d.insert.source === "conjugation-drill").length;
    console.log(
      `[parse-cahier] commit (${reading.mode}${legacy ? ", old dialog" : ""}): ${incoming.length} cards from ${read.size} classes read, ` +
      `${result.added} new, ${result.seenAgain} seen again, ${result.waiting} waiting, ${result.questions} questions, ` +
      `${unchanged} classes unchanged, replace: ${result.keptOutOfStudy} out, ${result.broughtBack} back` +
      (result.replaceWaits ? ` (${result.replaceWaits} left in: no migration_016)` : "") + ", " +
      `${result.failed?.length || 0} refused` + (result.ok ? "" : `, NOT SAVED: ${result.error}`)
    );
    if (!result.ok) {
      return res.status(result.lostTurn ? 409 : 500).json({
        ok: false,
        error: result.lostTurn ? LOST_TURN_MESSAGE : `Your cards couldn't be saved: ${result.error}`,
      });
    }
    return res.status(200).json({
      ok: true,
      cardsInserted: result.added,
      cardsSeenAgain: result.seenAgain,
      cardsWaiting: result.waiting,
      classesRead: [...read].filter((d) => !result.waitingDates.includes(d)).length,
      classesUnchanged: unchanged,
      // Classes read whose cards wait on Claude's question, to be read again
      // next time. Classes Claude couldn't read the dialog knows already.
      waitingClasses: result.waitingDates.filter((d) => !failed.has(d)),
      cardsFailed: result.failed.length,
      failedFronts: result.failed.slice(0, 10).map((f) => f.front),
      uniqueCards: incoming.length,
      datesCovered: allDates.length,
      dateRange: allDates.length ? [allDates[0], allDates[allDates.length - 1]] : null,
      conjugationDrillsGenerated: drills,
      polysemySplits: result.labelled,
      questions: result.questions,
      keptOutOfStudy: result.keptOutOfStudy,
      broughtBack: result.broughtBack,
      // Before migration_016 Replace takes nothing out: how many cards it
      // would have, so the student is told why they are still there.
      replaceWaits: result.replaceWaits,
      removed: 0,
      errors: result.failed.length ? [{ step: "save", error: `${result.failed.length} card(s) not saved: ${result.failed[0].error}` }] : [],
    });
  } catch (e) {
    console.error("[parse-cahier] commit failed:", e);
    return res.status(500).json({ error: e.message || String(e) });
  } finally {
    await releaseReading(adminClient, userId, reading.runId);
  }
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

export const EXTRACTION_PROMPT = `You are extracting flashcards from a French student's daily lesson notes.

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

export const EXTRACTION_MODEL = "claude-haiku-4-5";

// Added when only some lines of a class are new (src/lib/notesLines.js): the
// whole class is sent, so Claude has the context, and it is told to make
// cards from the new lines only. The rest of the class already has its cards,
// and reading it again is how a word came back spelt another way.
export const NEW_LINES_NOTE = `Most of this lesson was read before and already has its cards. Make cards ONLY from the new lines listed below; use the rest of the lesson only to understand them. If none of the new lines is flashcard material, return [].

New lines:
{NEW_LINES}`;

export function extractionPrompt(block) {
  const prompt = EXTRACTION_PROMPT.replace("{BLOCK_TEXT}", block.text);
  const lines = Array.isArray(block.newLines) ? block.newLines.filter((l) => typeof l === "string" && l.trim()) : [];
  if (!lines.length) return prompt;
  return `${prompt}\n\n${NEW_LINES_NOTE.replace("{NEW_LINES}", lines.map((l) => `- ${l.trim()}`).join("\n"))}`;
}

export async function extractCardsFromBlock(anthropic, block) {
  const prompt = extractionPrompt(block);

  const response = await anthropic.messages.create({
    // Haiku is ~3-5× faster than Sonnet and just as accurate on this task,
    // since the cahier format is very regular and Claude is just doing
    // structured extraction, not reasoning. Sonnet was overkill.
    model: EXTRACTION_MODEL,
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

// What Claude extracted from a class, made into the cards that are written.
// The same steps as an upload's commit, in the same order: a class's grammar
// rules and pronunciation notes never become cards (a card must be answerable
// by typing), and a plain word the model filed under G becomes V. This path
// matters most for it — it runs unattended, and nobody reviews what it adds.
// Also what the notes-to-cards test judges (api/_lib/notesChecks.js), so the
// test is of exactly what a sync writes. It lives in this file so that the
// test's version, a hash of this file, changes with it.
export function cardsFromExtracted(raw) {
  const cleaned = raw.map((c) => (c && c.front && c.back ? { ...c, front: cleanFrenchFront(c.front, c.back) } : c));
  const { expanded } = expandConjugations(splitSlashPairs(cleaned));
  return mergeRepeats(keepAnswerable(expanded));
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
// One card per thing to learn, inside one reading
// ═══════════════════════════════════════════════════════════════════════════
//
// The same word in two classes of one reading becomes one card with both
// dates, by the same rule that compares a new card with the deck
// (src/lib/sameCard.js). The first spelling read is the one kept.
//
// This used to merge only cards equal once capitals and accents were set
// aside, and split a word whose English was worded differently in two
// classes into two labelled cards, "être assis (to be seated)" and "être
// assis (to be sitting)", with labels that changed with every reading. In
// other students' decks 34 of the 39 repeated pairs came from it. Now a card
// whose French matches another's only loosely, or whose English disagrees,
// is left for the question to Claude (src/lib/cardMatch.js), and only a
// "different" answer gives it a label.
export function mergeRepeats(cards) {
  const kept = [];
  const index = cardIndex([]);
  for (const card of cards || []) {
    if (!card || !card.front || !card.back) continue;
    const dates = Array.isArray(card.dates) ? card.dates : [];
    const same = index.sure(card);
    if (same) {
      same.dates = [...new Set([...same.dates, ...dates])].sort();
      continue;
    }
    const copy = { ...card, dates: [...new Set(dates)].sort() };
    kept.push(copy);
    index.add(copy);
  }
  return kept;
}

// The old name, for the analysis scripts in tests/simulate/analysis that
// still call it. Nothing is labelled here any more, so `splits` is 0.
export function dedupeWithPolysemy(cards) {
  return { deduped: mergeRepeats(cards), splits: 0 };
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

