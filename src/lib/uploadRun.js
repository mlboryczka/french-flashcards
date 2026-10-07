// The steps of an upload (paste or file), in the order the server expects
// them (api/parse-cahier.js). Pure apart from `post`, so the tests drive the
// very same steps the upload dialog does (src/CahierUpload.jsx).
//
//   1. slice   the notes cut into classes, one per date line
//   2. plan    which lines are new; this also takes the student's turn to have
//              their notes read, so the daily check can't read the same class
//              at the same moment
//   3. read    only classes with new lines, in chunks, through
//              /api/cahier-parse; a class whose lines were partly read before
//              goes with its new lines, and Claude makes cards from those only
//   4. commit  every new card compared with the deck, the new ones and the
//              lines read saved together, and the turn given back
//
// An unchanged re-upload reads nothing at step 3 (2026-10-06; it used to read
// the whole notebook again, and add Claude's new spellings as new cards).
//
// `post(url, body)` resolves to the server's JSON and throws on an error.
// `onProgress(text)` is told what is happening, in words for the student.

const CHUNK_SIZE = 15;

export async function runUpload({ post, mode = "text", content, replace = false, source = "paste", onProgress = () => {} }) {
  onProgress("Slicing your cahier…");
  const slice = await post("/api/parse-cahier", { action: "slice", mode, content });
  const blocks = (slice.blocks || []).map((b) => ({ date: b.date, text: b.text }));
  if (blocks.length === 0) throw new Error("No lessons found in the input.");

  onProgress("Checking which classes are new…");
  const plan = await post("/api/parse-cahier", { action: "plan", blocks, replace });
  const toRead = (plan.blocks || []).filter((b) => b.read);

  const cards = [];
  const failedDates = [];
  let firstError = null;
  let batchId = null;
  const chunks = Math.ceil(toRead.length / CHUNK_SIZE);
  for (let i = 0; i < toRead.length; i += CHUNK_SIZE) {
    const chunk = toRead.slice(i, i + CHUNK_SIZE);
    onProgress(
      chunks > 1
        ? `Reading your new lessons… (part ${Math.floor(i / CHUNK_SIZE) + 1} of ${chunks})`
        : `Reading your new ${chunk.length === 1 ? "lesson" : "lessons"}…`
    );
    try {
      const data = await post("/api/cahier-parse", {
        blocks: chunk.map((b) => ({ date: b.date, text: b.text, newLines: b.newLines || null })),
        batch_id: batchId,
        source,
      });
      if (!batchId && data.batch_id) batchId = data.batch_id;
      if (Array.isArray(data.cards)) cards.push(...data.cards);
      for (const e of data.errors || []) {
        if (e?.date) failedDates.push(e.date);
        firstError ||= e?.error || null;
      }
    } catch (e) {
      // Those classes stay unread, for the next upload.
      for (const b of chunk) failedDates.push(b.date);
      firstError ||= e.message || String(e);
    }
  }

  if (toRead.length && failedDates.length === toRead.length) {
    // Nothing could be read: give the turn back, and say why.
    await post("/api/parse-cahier", { action: "commit", runId: plan.runId, blocks, cards: [], failedDates, replace: false })
      .catch(() => {});
    throw new Error(`Couldn't read your lessons: ${firstError || "unknown error"}`);
  }

  onProgress(cards.length ? `Saving the new cards to your deck…` : "Checking your deck…");
  const commit = await post("/api/parse-cahier", {
    action: "commit",
    runId: plan.runId,
    replace,
    blocks,
    cards,
    failedDates,
    batch_id: batchId,
  });
  const failedClasses = [...new Set(failedDates)].sort();
  return { ...commit, batch_id: batchId, classesToRead: toRead.length, classesFailed: failedClasses.length, failedClasses };
}
