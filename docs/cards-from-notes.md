# How class notes become cards

Most of a student's cards come from their *cahier*, the notebook they keep with
their teacher. Here the teacher and the student keep it together in a Google
Doc, one block per class, each starting with its date, such as "Le 24
septembre 2026". Claude reads each class and turns it into cards.

## Three ways in

- **Linking the Google Doc.** The student pastes the doc's link once, and from
  then on each new class becomes cards by itself.
- **Uploading.** The student pastes the notebook's text, or drops in a .txt,
  .pdf or .docx file, under "Upload document" in the profile menu. It is read
  once.
- **The tutor.** Cards the tutor suggests during a conversation can be added
  with a click.

Lessons are a fourth source, described below.

## The linked notebook

The owner (who runs the app and studies with it) set these rules for the
linked notebook:

- A new class becomes cards straight away, with no review step.
- Each class is read once. Editing or deleting lines in an old class changes
  nothing, because its cards already carry the student's history.
- A word taught again keeps its card and gains the new class's date. Reading
  the notebook never rewrites a card's front or back.
- Nothing is ever deleted.
- The owner pays for the reading, not the student.

The app looks for new classes when the student opens it (at most once an
hour), and a scheduled job on the server reads the linked docs once a day
whether or not anyone opens the app. Reading the doc costs nothing. Only a new
class is sent to Claude (Haiku 4.5), and each class is listed once it has been
read. The doc must be shared as "anyone with the link can view", because the
server reads it without signing in to Google.

A word written another way, such as "un cas" for "le cas" or "gratuit (adj)"
for "gratuit", gets the new date on the card the student already has. The
matching is deliberately narrow, because a wrong match would merge two real
cards: "la poste" (the post office) and "le poste" (the job) stay separate.

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
- `src/lib/sameCard.js`: recognising a word written another way
- `src/lib/cardText.js`: removing an answer from the question side
- `src/lib/cardInstruction.js`: the line saying what to type
- `scripts/fix-multi-sense.mjs`: splitting cards that teach two words
- `src/data/lessons/`: the lessons
