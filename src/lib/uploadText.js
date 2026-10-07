// What an upload (paste or file) did, said plainly to the student. Pure, so
// the tests run it on the replies of real uploads (tests/suites/repeats.mjs).
//
// An upload reads only lines it hasn't read before (src/lib/notesLines.js), so
// an unchanged one adds nothing. Since 2026-10-06 the message also says what
// didn't happen: it used to say "everything in these notes is already in your
// deck" when a class couldn't be read, or waited on Claude's question, and
// the words of those classes were missing without a word about them. It
// counted a word that already had the class date as one that got it, and
// wrote "1 class was already read and left as they are".

const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

// A class date as the student sees it: "11 November" (in their own locale).
export const classDay = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" });

// "Your class of 11 November", "Your classes of 11 and 18 November", "Your
// 4 classes from 2 October to 18 November".
function yourClasses(dates) {
  const d = [...new Set(dates)].sort();
  if (d.length === 1) return `Your class of ${classDay(d[0])}`;
  if (d.length === 2) return `Your classes of ${classDay(d[0])} and ${classDay(d[1])}`;
  return `Your ${d.length} classes from ${classDay(d[0])} to ${classDay(d[d.length - 1])}`;
}

// Cards the database couldn't save. Said plainly: the upload once reported
// success with 500 of its cards missing. A line is read once, so uploading
// the same notes again doesn't retry it; changing the line does.
export function uploadFailedText({ cardsFailed = 0, failedFronts = [] } = {}) {
  if (!cardsFailed) return "";
  const example = failedFronts[0] ? ` (for example "${failedFronts[0]}")` : "";
  return `\n\n${n(cardsFailed, "card", "cards")} couldn't be saved${example}. Check that line in your notes: once it is changed, the next upload reads it again.`;
}

// `r` is what runUpload returned (src/lib/uploadRun.js): the commit's reply,
// plus the classes Claude couldn't read.
export function uploadResultText(r = {}) {
  const waiting = Array.isArray(r.waitingClasses) ? r.waitingClasses : [];
  const failed = Array.isArray(r.failedClasses) ? r.failedClasses : [];
  const lines = [];
  if (r.cardsInserted) lines.push(`${n(r.cardsInserted, "new card", "new cards")} added to your deck.`);
  else if (!waiting.length && !failed.length && !r.cardsFailed) lines.push("No new cards: everything in these notes is already in your deck.");
  else lines.push("No new cards added this time.");
  if (r.classesUnchanged) {
    lines.push(r.classesUnchanged === 1
      ? "1 class was already read and left as it is."
      : `${r.classesUnchanged} classes were already read and left as they are.`);
  }
  if (r.cardsSeenAgain) lines.push(`${n(r.cardsSeenAgain, "word you already have", "words you already have")} got the new class date.`);
  if (failed.length) {
    lines.push(`${yourClasses(failed)} couldn't be read this time. Upload the same notes again to add ${failed.length === 1 ? "it" : "them"}.`);
  }
  if (waiting.length) {
    const its = waiting.length === 1 ? "its" : "their";
    lines.push(`${yourClasses(waiting)} ${waiting.length === 1 ? "waits" : "wait"} until your next upload: some of ${its} words look like cards you have, and that couldn't be checked this time.`);
  }
  if (r.keptOutOfStudy) lines.push(`${n(r.keptOutOfStudy, "card is", "cards are")} from classes not in this upload: out of study now, with their progress kept.`);
  if (r.broughtBack) lines.push(`${n(r.broughtBack, "card", "cards")} taken out by an earlier replace came back.`);
  if (r.replaceWaits) {
    lines.push(`Nothing was taken out of study. Replacing a deck needs a database update the app's owner hasn't made yet, so these notes were added to your deck, and your ${n(r.replaceWaits, "card", "cards")} from other classes stay as they are.`);
  }
  return `Done!\n\n${lines.join("\n")}${uploadFailedText(r)}`;
}
