// Client helper for the parse-corrections ledger.
//
// Everything here is fire-and-forget: callers (card editor, admin delete,
// feedback approval, cahier upload) should not block the UI on these
// calls, and none of them throw. If the server endpoint returns 404/500
// (typically "migration not run yet"), we swallow silently and log to the
// console — the feature is designed to be safe to deploy before the
// migration is applied.

import { supabase } from "../supabase";

// Keep in sync with the CHECK constraint in migration_002_parse_corrections.sql.
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
  // Grab the session token if there is one, but never block the fetch on
  // it — we'd rather see a 401 in the Network tab than silently swallow
  // the call. The previous "disable for session" cache has been removed
  // for the same reason.
  let accessToken = "";
  try {
    const s = await supabase.auth.getSession();
    accessToken = s?.data?.session?.access_token || "";
  } catch (e) {
    console.warn("[parseCorrections] session read failed:", e?.message || e);
  }

  const url = "/api/parse-corrections";
  console.log("[parseCorrections] about to fetch", url, "hasToken?", !!accessToken);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[parseCorrections] log failed: HTTP ${res.status} ${text.slice(0, 200)}`
      );
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    console.warn("[parseCorrections] log network error:", e?.message || e);
    return null;
  }
}

// Fire-and-forget. Callers should NOT await the result when they care about
// UI responsiveness; await only if you want the returned id for chaining.
//
// payload fields (all optional except category):
//   category          — one of CORRECTION_CATEGORIES values (required)
//   action            — one of CORRECTION_ACTIONS values
//   card_id           — user_cards.id (uuid) if applicable
//   batch_id          — upload_batches.id (uuid); may be null for legacy cards
//   original_front    — text before the correction
//   original_back     — text before the correction
//   corrected_front   — text after the correction
//   corrected_back    — text after the correction
//   notes             — free-form string
export async function logCorrection(payload) {
  console.log("[parseCorrections] logCorrection called with", payload);
  if (!payload || !payload.category) {
    console.warn("[parseCorrections] logCorrection called without category");
    return null;
  }
  // Never throw out to the caller — swallow and log.
  try {
    return await postCorrection(payload);
  } catch (e) {
    console.warn("[parseCorrections] logCorrection caught:", e?.message || e);
    return null;
  }
}

export async function getRecentCorrections(limit = 50) {
  if (endpointDisabled) return [];
  let session;
  try {
    const s = await supabase.auth.getSession();
    session = s?.data?.session;
  } catch {
    return [];
  }
  if (!session?.access_token) return [];

  try {
    const res = await fetch(
      `/api/parse-corrections?limit=${encodeURIComponent(limit)}`,
      {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }
    );
    if (res.status === 404 || res.status === 503) {
      endpointDisabled = true;
      return [];
    }
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return data?.corrections || [];
  } catch (e) {
    console.warn(
      "[parseCorrections] getRecentCorrections error:",
      e?.message || e
    );
    return [];
  }
}

export async function getCorrectionPatterns() {
  if (endpointDisabled) return [];
  let session;
  try {
    const s = await supabase.auth.getSession();
    session = s?.data?.session;
  } catch {
    return [];
  }
  if (!session?.access_token) return [];

  try {
    const res = await fetch("/api/parse-corrections?aggregate=true", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.status === 404 || res.status === 503) {
      endpointDisabled = true;
      return [];
    }
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return data?.patterns || [];
  } catch (e) {
    console.warn(
      "[parseCorrections] getCorrectionPatterns error:",
      e?.message || e
    );
    return [];
  }
}
