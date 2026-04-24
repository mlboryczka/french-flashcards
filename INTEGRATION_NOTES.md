# Parse corrections ledger — integration notes

This file lists the four places in the existing React / serverless code that
need to be updated to start writing to the `parse_corrections` ledger. The
new files (migration, client helper, three API endpoints) are already in the
tree and are safe to ship ahead of the migration — every write/read is
wrapped in try/catch and silently no-ops on 404/503.

The snippets below are drop-in: every integration calls into
`src/lib/parseCorrections.js`, which is the single place that knows about
the endpoint URL and fire-and-forget semantics.

## 0. Shared import

Add to the top of `src/FlashcardApp.jsx` (and `src/CahierUpload.jsx` where
needed):

```js
import {
  logCorrection,
  CORRECTION_CATEGORIES,
  CORRECTION_ACTIONS,
} from "./lib/parseCorrections";
// From CahierUpload.jsx use "./lib/parseCorrections" (same — it's one dir up).
```

---

## 1. `EditCardModal` save — log which field changed

File: `src/FlashcardApp.jsx` — `saveCardEdit` at roughly line 745, and the
`onSave` callback at roughly line 1021.

Capture the original front/back on open so we can diff them on save, and
call `logCorrection` after the DB update succeeds.

Modify `saveCardEdit` to return the original values as well:

```js
// src/FlashcardApp.jsx — replace the body of saveCardEdit
const saveCardEdit = async (rowId, newFront, newBack) => {
  // Find current values before the update so we can report diffs.
  const existing = userCards.find((c) => c.row_id === rowId);
  const originalFront = existing?.f ?? null;
  const originalBack = existing?.b ?? null;

  const { error } = await supabase
    .from("user_cards")
    .update({
      front: newFront.trim(),
      back: newBack.trim(),
      flagged_for_review: false,
    })
    .eq("id", rowId);
  if (error) {
    console.error("Card update failed:", error);
    return false;
  }

  // Log the correction. Fire-and-forget — do NOT await.
  const frontChanged = originalFront !== null && originalFront !== newFront.trim();
  const backChanged = originalBack !== null && originalBack !== newBack.trim();
  if (frontChanged || backChanged) {
    logCorrection({
      category: frontChanged
        ? CORRECTION_CATEGORIES.FRONT_TEXT_EDIT
        : CORRECTION_CATEGORIES.BACK_TEXT_EDIT,
      action: CORRECTION_ACTIONS.EDIT,
      card_id: rowId,
      batch_id: existing?.batch_id || null, // may be null for legacy cards
      original_front: originalFront,
      original_back: originalBack,
      corrected_front: newFront.trim(),
      corrected_back: newBack.trim(),
    });
  }

  reloadDeck();
  return true;
};
```

Also add `batch_id` to the shape returned by `useUserDeck.js` so `existing.batch_id`
exists:

```js
// src/useUserDeck.js — in the .select() call, include batch_id
.select("id, front, back, category, dates, flagged_for_review, batch_id")

// and in the shape mapping:
{
  f: row.front,
  b: row.back,
  // ...existing fields
  batch_id: row.batch_id || null,
}
```

---

## 2. Admin card delete — prompt for category, log before deleting

File: `src/FlashcardApp.jsx` — the `onDelete` callback of `EditCardModal` at
roughly line 1026, and/or the `deleteCard` helper at roughly line 758.

Replace the existing `onDelete` handler with one that:

- pops a `window.prompt` so the admin can pick a category
  (default `duplicate_detected`),
- logs the correction with the original front/back captured **before**
  deletion (otherwise the row is gone by the time we read it),
- then calls `deleteCard`.

```js
// src/FlashcardApp.jsx — inside the <EditCardModal ... /> JSX
onDelete={async () => {
  if (!confirm("Delete this card? This cannot be undone.")) return;

  // Category prompt. Default is duplicate_detected (most common reason
  // admins delete). Admin can override with any of the other codes.
  const CATEGORY_MENU = [
    "duplicate_detected",
    "should_split_polysemy",
    "should_merge_gendered",
    "wrong_disambiguator",
    "wrong_card_type",
    "reversed_front_back",
    "spelling_correction",
    "other",
  ];
  const categoryInput = window.prompt(
    `Why are you deleting this card?\n\nPick one:\n  ${CATEGORY_MENU.join(
      "\n  "
    )}\n\n(press Enter to accept the default)`,
    "duplicate_detected"
  );
  // Cancel = null. Treat as abort.
  if (categoryInput === null) return;
  const category = CATEGORY_MENU.includes(categoryInput.trim())
    ? categoryInput.trim()
    : "duplicate_detected";

  // Log BEFORE deleting — after the delete, the front/back are gone.
  logCorrection({
    category,
    action: CORRECTION_ACTIONS.DELETE,
    card_id: editingCard.row_id,
    batch_id: editingCard.batch_id || null,
    original_front: editingCard.f,
    original_back: editingCard.b,
  });

  const ok = await deleteCard(editingCard.row_id);
  if (ok) setEditingCard(null);
}}
```

---

## 3. `FeedbackReviewModal` / `FeedbackAdminView` approve — log alternate

File: `src/FlashcardApp.jsx` — the `approve` handler at roughly line 1730.

After the successful `card_alternates.insert`, log a correction with
`category = alternate_answer`, `action = approve_alternate`. Use the
feedback item's card front/back as the "original" fields and the approved
user answer as the corrected back.

```js
// src/FlashcardApp.jsx — inside approve(), after the alt insert succeeds
const approve = async (item) => {
  setActing(item.id);
  const { error: altErr } = await supabase.from("card_alternates").insert({
    card_id: item.card_id,
    direction: item.direction,
    alternate_text: item.user_answer,
    source_feedback_id: item.id,
  });
  if (altErr) {
    console.error("Alt insert failed:", altErr);
    setActing(null);
    return;
  }

  // Log the alternate approval so future parses know this answer is valid.
  // Fire-and-forget. card_id is the legacy lowercased-front id (not a uuid),
  // so we leave card_id null on the ledger row and stash the context in
  // original_front/back.
  logCorrection({
    category: CORRECTION_CATEGORIES.ALTERNATE_ANSWER,
    action: CORRECTION_ACTIONS.APPROVE_ALTERNATE,
    original_front: item.french || item.card_front || null,
    original_back: item.english || item.expected_answer || item.card_back || null,
    corrected_back: item.user_answer,
    notes: `direction=${item.direction}`,
  });

  const { error: upErr } = await supabase
    .from("feedback_submissions")
    .update({
      reviewed: true,
      reviewed_at: new Date().toISOString(),
      action: "approved",
    })
    .eq("id", item.id);
  if (upErr) console.error("Review mark failed:", upErr);
  await load();
  setActing(null);
};
```

---

## 4. `CahierUpload` accept — thread `batch_id`, then PATCH accepted count

Two changes in `src/CahierUpload.jsx` / the commit path:

### 4a. Include `batch_id` on every inserted `user_cards` row

If you are switching to the new `/api/cahier-parse` endpoint, its response
contains `batch_id`. Pass that through to the server insert step so every
row in `user_cards` carries the batch id that produced it.

In `api/parse-cahier.js` — extend the commit-phase row mapping to accept a
`batch_id` from the incoming cards (or from a top-level `batch_id` field
on the commit body):

```js
// api/parse-cahier.js — inside handleCommit()
const batchId = req.body?.batch_id || null;

const rows = deduped.map((c) => ({
  user_id: userId,
  front: c.front,
  back: c.back,
  category: c.category,
  dates: c.dates,
  source: c.source || "cahier-upload",
  batch_id: batchId, // NEW — null for legacy/unbatched flows
}));
```

And in `src/CahierUpload.jsx` — when you call the commit action, forward
the batch id returned by the parse step:

```js
// src/CahierUpload.jsx — inside handleSubmit, replace the commit call
const commitData = await callApi(session.access_token, {
  action: "commit",
  cards: allCards,
  replace,
  batch_id: parseResponse?.batch_id || null, // NEW
});
```

(`parseResponse` is the return value from whichever call produced
`batch_id` — either `/api/cahier-parse` or the slice/extract flow adapted
to create a batch up front.)

### 4b. PATCH the batch with the accepted count after commit

Right after the commit returns, tell `upload_batches` how many cards
actually landed:

```js
// src/CahierUpload.jsx — inside handleSubmit, after the commit succeeds
if (parseResponse?.batch_id && commitData?.cardsInserted != null) {
  try {
    await fetch(
      `/api/upload-batches?id=${encodeURIComponent(parseResponse.batch_id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          cards_accepted: commitData.cardsInserted,
          cards_edited_post_parse: 0,
        }),
      }
    );
  } catch (e) {
    // Non-fatal: the batch row just won't have accepted_count filled in.
    console.warn("[CahierUpload] upload_batches PATCH failed:", e?.message || e);
  }
}
```

> **Note on URL shape:** Vercel serverless files at `api/upload-batches.js`
> don't support `/api/upload-batches/:id` without a `[id].js` file. The
> endpoint accepts `?id=<uuid>` as a query parameter, which keeps the
> handler in a single file.

---

## Verification checklist after migration is run

1. Open the card editor, edit a card's back text, save. Confirm a row
   appears in `parse_corrections` with `category = back_text_edit`.
2. Open the admin card view, delete a card, accept the default category.
   Confirm a row with `category = duplicate_detected` and original
   front/back captured.
3. Approve a feedback submission. Confirm a row with
   `category = alternate_answer`.
4. Upload a cahier. Confirm a new `upload_batches` row with
   `few_shot_correction_ids` populated (non-empty once there are
   corrections to inject) and `cards_accepted` matching the insert count.
5. `select * from correction_patterns_90d;` should return one row per
   category that has any corrections in the last 90 days.
