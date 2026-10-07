# How class notes become cards

Most of a student's cards come from their *cahier*, the notebook they keep with
their teacher. Here the teacher and the student keep it together in a Google
Doc, one block per class, each starting with its date, such as "Le 24
septembre 2026". Claude reads each class and turns it into cards.

## Three ways in

- **Linking the Google Doc.** The student pastes the doc's link once, and from
  then on each new class becomes cards by itself.
- **Uploading.** The student pastes the notebook's text, or drops in a .txt,
  .pdf or .docx file, under "Upload document" in the profile menu. Uploading
  an updated notebook reads only what is new in it.
- **The tutor.** Cards the tutor suggests during a conversation can be added
  with a click.

Lessons are a fourth source, described below.

## The linked notebook

The owner (who runs the app and studies with it) set these rules for the
linked notebook:

- A new class becomes cards straight away, with no review step.
- Each line of the notes is read once. A line added to an old class is read
  on its own; deleting a line changes nothing, because its card already
  carries the student's history.
- A word taught again keeps its card and gains the new class's date. Reading
  the notes never rewrites a card's front, back, schedule or answers.
- Nothing is ever deleted.
- The owner pays for the reading, not the student.

The app looks for new classes when the student opens it (at most once an
hour), and a scheduled job on the server reads the linked docs once a day
whether or not anyone opens the app. Reading the doc costs nothing. Only new
lines are sent to Claude (Haiku 4.5), with the rest of their class so it has
the context. The doc must be shared as "anyone with the link can view",
because the server reads it without signing in to Google.

## One card per thing to learn

Claude writes the same line a little differently each time it reads it: a
full stop, a capital, "ne" dropped, the feminine added. In September a whole
notebook uploaded a second time was read again from the top, and the owner
ended up with 73 cards that repeated another one. The owner's rule since then:
"there should be NO duplicates from reuploading an updated cahier".

- **Each line is read once, however the notes come in.** The app keeps one
  record per student of every line of their notes it has read: a short
  fingerprint of each line, grouped by class. The linked doc, the daily
  check, an upload, a second upload of the same notebook, relinking, and
  linking a copy of the doc all share it. An unchanged notebook uploaded again
  asks Claude nothing and adds nothing. A class whose date line is corrected
  is known by its lines, even when its old or new date is another class's
  too, so it isn't read again.
- **One reading at a time.** The daily check and an upload can't read the
  same student's notes at the same moment; the second is told to wait.
- **Saved together.** The new cards and the record of the lines read are
  saved in one step, so a failure can't leave the cards saved and the lines
  marked unread, which is how the next reading used to add new spellings
  beside them.
- **A word written another way is the card the student already has.** A new
  card is compared with every card the student has, those out of study and
  the lessons' cards included. Small differences that never change what is
  learnt (capitals, a final full stop, an article of the same gender, a label
  like "(adj)", "œ" for "oe") settle it at once. A closer call, such as "le
  cas" beside "un cas", "manquer" beside "manquer / rater", "rater /
  manquer" beside "manquer / rater", or a typo fixed, is put to Claude as one
  question: the same card to learn, or different?
  Claude is told what stays apart: "ou" and "où", "la poste" (the post office)
  and "le poste" (the job), "fin" (the end) and "fin (adj)" (thin), a "(fam)"
  meaning beside the ordinary one. If the question can't be answered, those
  cards wait for the next reading rather than going in twice. The morning
  status check uses the same rule and question on the deck itself, and fails
  if a card is in it twice or a card the student removed is back
  ([Evaluation harness](evaluation-harness.md)).
- **A match only adds the date.** The card keeps its French, English,
  category, schedule and answers, and stays in or out of study as it was.

## Removing a card

Removing a card takes it out of study and keeps it, with its answers and the
reason. Because it is still a card the student has, the same word in a later
class only adds its date to it, and a lesson doesn't bring it back. Deleting
used to erase the card and its answers, and the next upload made it again.

"Replace my existing deck", ticked on an upload, takes out of study the cards
from classes that aren't in the upload, and keeps them. A later Replace upload
that has their class again brings them back, unless the same card is in study
by then (a lesson's copy of it, say), which gains their class dates instead.
Lesson cards and cards added from the tutor are left alone. Until the database
update that came with this (migration_016) is run, Replace takes nothing out,
and the upload's message says so.

After an upload, the message says what was added, which classes were already
read, and, by date, any class Claude couldn't read (upload the same notes
again to add it) or whose cards wait on the same-or-different question.

When a lesson drops a card that a word from the student's notes had landed
on, the card stays, as one of the student's own.

## What becomes a card

Only what can be answered by typing becomes a card. A word, phrase or example
sentence becomes a card. A conjugation table becomes one drill per form, such
as "vivre → je" with the answer *vis*, and the table itself is dropped. A
grammar rule or a pronunciation note makes no card, because there is no single
answer to type. This is in Claude's instructions, and it is enforced again in
code on every path, so a card that slips past the instructions is still caught.

A bad card does more harm than a missing one, because FSRS records a recall
that never happened. Three kinds of bad card are handled:

- **The answer showing on the question side.** Class notes often carry a
  translation, as in "je suis allé (I went)". When a bracket on the French side
  repeats a word of the English answer, it is removed before the card is shown.
- **One card teaching two words.** "les frais" (costs) and "frais" (fresh) can
  end up on one card, which then has no single right answer. Claude's
  instructions for the linked notebook and for the tutor forbid such cards. For
  older ones, a script finds likely cases and asks Claude whether to split each
  one; the original card keeps its history as the first meaning, and the other
  meanings become new cards.
- **A grammar card that doesn't say what to type.** Every grammar card has a
  short line above the question saying what is wanted, such as "Present tense,
  with je".

## Lessons

Lessons are fixed sets of cards with notes, the same for every student. There
are seven. Six come from Laura Caufour's LFL METHOD course: the imperative, and
her beginner lessons 1 to 5. The seventh, *Adjectif ou adverbe ?*, was written
for the app and approved card by card.

- The notes sit beside the card while the student answers: tables, contrasts,
  and the mistakes students commonly make.
- The five beginner lessons come up in every student's daily cards from the
  start. The other two come up once the student switches them on, or answers
  a card inside them. Any lesson can be switched off again.
- Each lesson card is identified by its original wording, so a card can be
  reworded later without anyone losing its history.
- When a lesson changes, every deck gets the new cards the next time it loads.
  A card the lesson drops is removed if the student never answered it, and
  archived with its answers if they did.

How lessons are built is written down in the
[building-lessons skill](../.claude/skills/building-lessons/SKILL.md), which
Claude follows when making or changing one.

## Fixing a card

Any card can be edited in the app, and it keeps its schedule. A student who
spots a bad card can flag it from the card itself. Claude reviews the report and
suggests a corrected card, which the owner can apply with one click
([details](where-claude-is-used.md#reviewing-feedback)).

## In the code

- `api/parse-cahier.js`: what becomes a card, shared by every path
- `api/cahier-sync.js` and `api/cahier-daily.js`: the linked notebook
- `src/lib/notesLines.js` and `api/_lib/notesReading.js`: which lines have
  been read, one reading at a time, and saving in one step
- `src/lib/sameCard.js` and `src/lib/cardMatch.js`: recognising a word
  written another way; `api/_lib/sameCardQuestion.js`: the question to Claude
- `api/_lib/removeCard.js`: removing a card
- `src/lib/cardText.js`: removing an answer from the question side
- `src/lib/cardInstruction.js`: the line saying what to type
- `scripts/fix-multi-sense.mjs`: splitting cards that teach two words
- `src/data/lessons/`: the lessons
