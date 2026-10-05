---
name: building-lessons
description: How to build or revise a lesson in this app (cards, instruction lines and notes), both from Laura Caufour's LFL METHOD materials and written from scratch, with every decision the owner has made so far. Use whenever a lesson is created, changed, reviewed, or its notes are rewritten.
---

# Building lessons

A lesson is a fixed set of cards plus notes, the same for every student, in
`src/data/lessons/<id>.js` and listed in `LESSONS` in `src/data/lessons/index.js`.
There are two kinds:

- **From Laura's materials**: L'impératif (built 2026-09-08 from her lesson and
  exercise PDFs); Leçons 2 to 5 (built 2026-10-04 from her Google folder, not
  yet reviewed by the owner).
- **Written for the app**: Adjectif ou adverbe ? (built 2026-09-24, notes
  rebuilt 2026-10-04).

Read both existing lesson files before starting. Their header comments record
why things are the way they are, and the impératif is the model for structure.

## Working with the owner

- **Show everything before it goes in.** Post the full card list and the
  notes for review before anything is added to the app (owner, 2026-09-24).
- **Show notes in the browser panel, not as screenshots in chat** (owner,
  2026-10-04). Run a private preview copy (see *Previewing* below), open it in
  the browser pane, and apply each piece of feedback to the preview as it
  arrives, reloading so the owner sees it.
- **Evaluate when asked to evaluate.** Keep the evaluation separate from the
  proposed changes, and give each change as its exact old and new wording.
- **Nothing goes live without a yes.** Commit locally, then ask before pushing
  to main, which deploys to students. Say if another session's unpushed
  commits would go out with yours.
- **Never cost a student progress** (owner, 2026-09-25). See *Changing a
  lesson that is already live*.

## Card rules (both kinds)

1. **Every card asks for something to type that the app can check.** No rule
   cards ("Pronoms toniques", "-er verbs take an -s before en/y"), no
   pronunciation cards, nothing answered by reciting a rule (owner, 2026-09-08
   and 2026-09-24). A rule is learned by cards that make you apply it.
2. **Each card teaches something no other card does.** Sample exercises;
   don't transcribe them. Twenty items drilling one rule in a worksheet become
   a few cards (impératif exercise 5: 20 items to 4 cards). The adverb draft
   went from 124 cards to 81 on this rule.
3. **Shape:** `[front, back, category, section, previousFront?]`. The front is
   always the French, because the app reads it aloud and cleans it as French,
   even when the exercise asks English to French.
4. **Categories:** `G` grammar (one way, French front shown, gets an
   instruction line), `E` phrases and `V` words (asked both ways, like the
   student's own cards).
5. **Every French-answered grammar front has an arrow (→).** The app reads it
   to ask for French and to mark exactly, accents aside. Typo tolerance would
   pass the very mistakes a lesson tests (*chères* for *cher*, *évidamment*).
6. **Accents are never checked**, so don't build cards whose point is an
   accent. That's why the adverb lesson has only three -ément cards.
7. **A drill names its mood in the front**: `finir (impératif) → tu`. A
   lesson badge alone wasn't enough: *finis* is also the présent, and students
   reported the card as wrong (2026-09-12).
8. **A gap card never puts its cue in parentheses**: write
   `cher → Ces chaussures coûtent ___`. `cleanFrenchPrompt` strips a
   parenthetical that repeats a word of the answer.
9. **Make a card one-way if the reverse would mark right answers wrong.** The
   adverb false friends are French shown, English typed, because several
   French words fit one English meaning.
10. **Alternatives in the back are separated by " / "**, e.g. `"vite / rapidement"`.
    List every answer a teacher would accept.
11. **No full stop at the end of a card face** (2026-09-12).

## Instruction lines

Every grammar card shows one short line in italics above the prompt, saying
exactly what to type (owner, 2026-09-24 and 2026-09-26).

- In English, and specific: "Present tense, with je", not "Conjugate".
- A drill's line is built from its front (`src/lib/cardInstruction.js`).
  Any other lesson card takes its section's line from `LESSON.instructions`.
- **Never give the answer away.** Two sections using the same cue for
  different answers get the same line: `cher → … coûtent ___` is *cher*,
  `cher → Une victoire ___ acquise` is *chèrement*, and both say "Fill the gap
  using the word given, in the form that fits".
- Phrase and word cards get no line; their input already says which language.

## From Laura's materials

- **Credit her.** `source: "LFL METHOD by Laura Caufour"`. It shows on the
  Lessons page and under the title in the notes.
- **Her answers stand where her key gives one.** Where her sheet is wrong,
  the card has the correct French and her mistake isn't copied. Record every
  departure in the file's header comment. The impératif's: *Donnez-lui* (her
  table had *Donne-lui* for *vous*), *Ne prends pas de douche* (the partitive
  changes under negation), a missing "!", and *Dis-le-moi*, which isn't an
  exception to pronoun order.
- **Her "phrases à apprendre par cœur"** become phrase cards.
- **The notes are her lesson, translated into English and restructured** to
  be read at a glance (see *Notes*). Keep her rules and examples. If you add a
  sentence that states a rule she only implies through a table, say in the
  header comment that it isn't hers (the impératif has two).
- **What the Leçons 2–5 session did, not yet reviewed by the owner:** her
  vocabulary lists became word cards; audio exercises and true/false questions
  about a dialogue were left out, since they can't be typed cards; Claude read
  her Drive files through the Google Drive connector and copied them into a
  working folder for checking.

## Written for the app

- The owner names the topic and the confusion it should fix ("students don't
  know when the adverb is the adjective itself"). Claude drafts a grouped list
  first and says whether there's enough for a lesson.
- **Check the draft independently before showing it:** a native-teacher read,
  a dictionary check (Larousse, Le Robert, CNRTL), a marking check (right
  answers marked wrong, wrong answers let through), a teaching check (repeats,
  missing common pairs) and a notes check. A sceptic then tries to disprove
  each finding before it's applied.
- The owner reviews it card by card before it goes in (2026-09-24).
- `source: "Written for this app"` for the Lessons page, and
  `creditInNotes: false`, so the notes panel shows no line under the title
  (owner, 2026-10-04).

## Notes

The notes panel (`src/LessonPanel.jsx`) is opened mid-card because the card
in front of the student doesn't make sense. It has to answer that at a
glance. It is not a handout.

### Structure, on the impératif's model

- **Tab names are one or two plain words a learner knows**: Use · Forms ·
  Pronouns · Reflexive; Use · Forms · Expressions · False friends. Never
  "Rule", "Other word", "As adverbs", or a bare suffix like "-ment" (owner,
  2026-10-04). The names must fit on one line across the 460px panel: about
  45 characters across all tabs.
- **The first tab says what the grammar is for, the second how to form it**,
  then one tab per topic.
- **Every tab opens with its rule in one sentence** (`lead`).
- **Special cases go under subheadings** (`sub`): "Adjectives ending in a
  vowel", "Very irregular verbs", "fort or fortement?".
- **Side points go last in their tab, under "Detail · advanced".**
- **At most one "The trap:" sentence per lesson**, for the commonest mistake.
- Every card's answer, or the rule that gives it, must be findable in the tab
  a stuck student would open. Check this card by card.

### Elements

| Block | Use |
|---|---|
| `lead` | The tab's rule, one sentence, first block. |
| `note` | Explanation, one to three short sentences. |
| `sub` | Subheading for a special case. Space above it, no line. |
| `table` / `pairs` | Examples in columns. `bold` picks the bold column of a `table`; `pairs` always bolds the first. |
| `forms` | A row of examples with the "Examples" label and red bar. Every set of French specimens has a label. |
| `list` | Bulleted list; used once, in the impératif's Use tab. Prefer sentences. |

The only line inside the notes is the one under a table's column names
(owner, 2026-10-04). The `lessons` suite fails on any other line.

### Wording (owner, 2026-10-04, after a line-by-line review)

Each of these drew "unclear" and was rewritten:

- **Say the one point directly.** "Fort and fortement mean different things,
  and you choose by meaning. If you mean loudly, use fort: *elles parlent trop
  fort*. If you mean sharply or strongly, use fortement: *les prix ont
  fortement augmenté*." Not "These adjectives also have a -ment adverb. Use it
  with any other verb, and expect a slightly different meaning".
- **Never point back to another section** ("outside the expressions above",
  "the one adverb that can change", "everywhere else"). Each note stands alone.
- **No placeholder words**: "the others", "a situation", "for taste". Name the
  actual words, or give the rule plainly ("bon and meilleur are for food and
  drink").
- **No grammar jargon an example can replace**: "agrees", "aspirate h", "mute
  h", "with no -ment on the feminine". Show the form: "*évident →
  évidemment*, not évidentement".
- **Give the English for every French example**, including the one in a
  tab's opening sentence.
- **Plain column headings**: "Without -ment / With -ment", not "Plain word /
  -ment form".
- **Cut what helps no card**: pronunciation tangents ("both endings sound the
  same"), second meanings, rare exceptions (gai → gaiement, assidûment, fou /
  mou / nouveau were cut on 2026-09-25). If a rule then needs rephrasing so an
  exception doesn't contradict it, rephrase it: "drop the -e after a vowel" so
  *fou → folle → follement* still fits.
- **No subtitle that says nothing**: "Written for this app" was removed from
  under the notes' title.

### Markup

`**bold**` and `*italic*` only, in `lead` and `note`. Never put italics inside
bold (`**… *tout***`): the panel shows stray asterisks and flips the italics.
Table cells, `forms` and `pairs` take no markup. Before showing notes, run each
`lead` and `note` through the panel's split (`rich()` in `LessonPanel.jsx`)
and confirm no `*` survives.

## Changing a lesson that is already live

- **To reword a card, keep its first front as the fifth element.** The card's
  identity is a hash of that front; without it, everyone's copy is taken out
  of study and the new wording dealt as unseen.
- **A dropped card is deleted only if no one ever answered it**; an answered
  one is archived with its answers and comes back if the card returns.
- **A changed answer alone isn't written to existing rows**, but marking also
  accepts the lesson's current answer (`lessonBackFor`).
- **After adding cards**, run `node scripts/release-lesson-cards.mjs`. The
  `logic` suite fails if a released card no longer matches its lesson.
- **New lessons go at the end of `LESSONS`** and start switched off on Cards
  for every student, so nobody's daily cards change until they switch it on
  (owner, 2026-10-04).
- **`teachingOrder`** lists the sections in the order new cards are dealt:
  each exercise straight after the rule it drills, not every rule before every
  exercise (2026-09-12).
- Notes can change freely: they hold no progress.

## Previewing for the owner

Never create test students on the live app (owner, 2026-10-04). Preview on a
private copy:

1. Copy the repo to the scratchpad without `node_modules`, `.git` or `tests`,
   and symlink `node_modules`.
2. Make a stand-in from `tests/mock-supabase.mjs` on a spare port that serves
   the lessons' own cards (`source: lessonSource(id, lessonCardKey(front))`)
   with `user_metadata.lessons_in_cards` switched on.
3. In the copy's `vite.config.js`, set `server.watch: { usePolling: true,
   interval: 300 }`: file changes under the scratchpad aren't otherwise seen.
4. Start the copy's Vite with `VITE_SUPABASE_URL` pointing at the stand-in,
   open it with `preview_start`, set the test session from
   `tests/harness.mjs` in localStorage (`sb-127-auth-token`), reload, open the
   lesson from the sidebar and click Lesson notes.
5. Background servers stop after two hours at most; restart them if the owner
   is still reviewing.

## Checks before committing

- `lessons` suite (browser): tabs, no stray lines, French spacing, panel
  behaviour. It only opens the impératif; check other lessons' lines yourself.
- `logic` (released cards) and `instructions` (instruction lines) suites.
- Run browser suites without moving `.env.local`: start the stand-in and Vite
  yourself with env vars on a free port, and pass `APP_URL` and `MOCK_URL`.
- Update the lesson's section of `french flashcards context.md`.

## Where these decisions come from

- L'impératif's first build (2026-09-08): its commit messages (`git log --
  src/data/lessons/imperatif.js`) and the file's header comment.
- Its rework (2026-09-12 to 09-14): the archived sessions "Clone
  french-flashcards to ~/Desktop/projects" and "Student app usage strategy"
  (drills name the mood, reworded cards keep their history, teaching order,
  blocks of 50 inside a lesson).
- The adverb lesson (2026-09-23 to 09-25): the archived sessions "Adverbs and
  adjectives module" and "Adjectif ou adverbe lesson removal".
- The notes standard and wording rules (2026-10-04): the session that rebuilt
  the adverb notes.
- Leçons 2 to 5 (2026-10-04): the session "Flashcard lessons from Google
  folder".

## Not yet decided

- **Which table column is bold.** Proposed 2026-10-04 that bold always go on
  the form being taught; today the impératif's Pronouns tables bold the
  indicative, not the imperative. The owner hasn't decided.
- **Leçons 2 to 5** are on the owner's Mac, not live, and their notes predate
  the wording rules above.
