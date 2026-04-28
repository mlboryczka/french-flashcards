// Client helper for the parse-corrections ledger. All writes are
// fire-and-forget: a network failure must not block the user's edit /
// delete / upload flow. postCorrection swallows every failure mode (auth
// missing, non-2xx, network error, malformed JSON) and returns null, so
// callers don't need their own try/catch.

import { supabase } from "../supabase";

// Mirror of the category CHECK constraint in
// migrations/migration_002_parse_corrections.sql. Update both together.
export const CORRECTION_CATEGORIES = Object.freeze({
  SHOULD_SPLIT_POLYSEMY: "should_split_polysemy",
  SHOULD_MERGE_GENDERED: "should_merge_gendered",
  WRONG_DISAMBIGUATOR: "wrong_disambiguator",
  WRONG_CARD_TYPE: "wrong_card_type",
  REVERSED_FRONT_BACK: "reversed_front_back",
  DUPLICATE_DETECTED: "duplicate_detected",
  SPELLING_CORRECTION: "spelling_correction",
  ALTERNATE_ANSWER: "alternate_answer",
  FRONT_TEXT_EDIT: "front_text_edit",
  BACK_TEXT_EDIT: "back_text_edit",
  OTHER: "other",
});

export const CORRECTION_ACTIONS = Object.freeze({
  EDIT: "edit",
  DELETE: "delete",
  APPROVE_ALTERNATE: "approve_alternate",
  MERGE: "merge",
  SPLIT: "split",
  RECLASSIFY: "reclassify",
  OTHER: "other",
});

async function postCorrection(body) {
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token || "";
  try {
    const res = await fetch("/api/parse-corrections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[parseCorrections] log failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    console.warn("[parseCorrections] log network error:", e?.message || e);
    return null;
  }
}

/**
 * Fire-and-forget log to the parse_corrections ledger.
 *
 * @param {Object} payload
 * @param {string} payload.category        — one of CORRECTION_CATEGORIES
 * @param {string} [payload.action]        — one of CORRECTION_ACTIONS
 * @param {number} [payload.card_id]       — user_cards.id (bigint)
 * @param {string} [payload.batch_id]      — upload_batches.id (uuid)
 * @param {string} [payload.original_front]
 * @param {string} [payload.original_back]
 * @param {string} [payload.corrected_front]
 * @param {string} [payload.corrected_back]
 * @param {string} [payload.notes]
 */
export async function logCorrection(payload) {
  if (!payload || !payload.category) {
    console.warn("[parseCorrections] logCorrection called without category");
    return null;
  }
  return postCorrection(payload);
}
