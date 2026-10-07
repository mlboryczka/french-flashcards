// What an upload (paste or file) did, said plainly to the student. Pure, so
// the tests run it on the replies of real uploads (tests/suites/repeats.mjs).
//
// An upload reads only lines it hasn't read before (src/lib/notesLines.js), so
// an unchanged one adds nothing. Since 2026-10-06 the message also says what
// didn't happen: it used to say "everything in these notes is already in your
// deck" when a class couldn't be read, or waited on Claude's question, and
// the words of those classes were missing without a word about them. It
// counted a word that already had the class date as one that got it, and
// wrote "1 class was already read and left as they are" and "your 1 card
// from other classes stay as they are": every count is said in the singular
// when it is one (2026-10-07).

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
  const one = cardsFailed === 1;
  const example = failedFronts[0] ? (one ? ` ("${failedFronts[0]}")` : ` (for example "${failedFronts[0]}")`) : "";
  return one
    ? `\n\n1 card couldn't be saved${example}. Check that line in your notes: once it is changed, the next upload reads it again.`
    : `\n\n${cardsFailed} cards couldn't be saved${example}. Check those lines in your notes: once they are changed, the next upload reads them again.`;
}

// `r` is what runUpload returned (src/lib/uploadRun.js): the commit's reply,
// plus the classes Claude couldn't read.
export function uploadResultText(r = {}) {
  const waiting = Array.isArray(r.waitingClasses) ? r.waitingClasses : [];
  const failed = Array.isArray(r.failedClasses) ? r.failedClasses : [];
  const lines = [];
  if (r.cardsInserted) lines.push(`${n(r.cardsInserted, "new card", "new cards")} added to your deck.`);
  else if (!waiting.length && !failed.length && !r.cardsFailed && !r.classesLeftForLink) lines.push("No new cards: everything in these notes is already in your deck.");
  else lines.push("No new cards added this time.");
  if (r.classesUnchanged) {
    lines.push(r.classesUnchanged === 1
      ? "1 class was already read and left as it is."
      : `${r.classesUnchanged} classes were already read and left as they are.`);
  }
  if (r.classesLeftForLink) {
    lines.push(r.classesLeftForLink === 1
      ? "1 class is also in your linked notes, which will check it for lines that haven't become cards yet."
      : `${r.classesLeftForLink} classes are also in your linked notes, which will check them for lines that haven't become cards yet.`);
  }
  if (r.cardsSeenAgain) lines.push(`${n(r.cardsSeenAgain, "word you already have", "words you already have")} got the new class date.`);
  if (failed.length) {
    lines.push(`${yourClasses(failed)} couldn't be read this time. Upload the same notes again to add ${failed.length === 1 ? "it" : "them"}.`);
  }
  if (waiting.length) {
    const its = waiting.length === 1 ? "its" : "their";
    lines.push(`${yourClasses(waiting)} ${waiting.length === 1 ? "waits" : "wait"} until your next upload: some of ${its} words look like cards you have, and that couldn't be checked this time.`);
  }
  if (r.keptOutOfStudy) {
    lines.push(r.keptOutOfStudy === 1
      ? "1 card you never answered is from a class not in this upload: it is out of study now, and kept."
      : `${r.keptOutOfStudy} cards you never answered are from classes not in this upload: they are out of study now, and kept.`);
  }
  if (r.answeredStay) {
    lines.push(r.answeredStay === 1
      ? "1 card you have answered is from a class not in this upload. It stays in study: replacing your deck never takes out a card you have answered."
      : `${r.answeredStay} cards you have answered are from classes not in this upload. They stay in study: replacing your deck never takes out a card you have answered.`);
  }
  if (r.broughtBack) lines.push(`${n(r.broughtBack, "card", "cards")} taken out by an earlier replace came back.`);
  if (r.replaceWaits) {
    const yours = r.replaceWaits === 1
      ? "your card from another class stays as it is"
      : `your ${r.replaceWaits} cards from other classes stay as they are`;
    lines.push(`Nothing was taken out of study. Replacing a deck needs a database update the app's owner hasn't made yet, so these notes were added to your deck, and ${yours}.`);
  }
  return `Done!\n\n${lines.join("\n")}${uploadFailedText(r)}`;
}
