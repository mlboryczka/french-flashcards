# French Flashcards — project context

A spaced-repetition flashcard app for learning French, built around one
person's year of handwritten class notebooks ("cahiers"). You upload a
notebook, Claude parses it into cards, and FSRS decides what you see and when.

Live at `french-flashcards-nine.vercel.app`. Repo `mlboryczka/french-flashcards`.

This document is written to bring a fresh session up to speed. It describes
what exists, why the non-obvious parts are the way they are, and what is
still open.

**How it is organised.** Three parts, and it matters which one you are in:

| Part | What it is |
|---|---|
| **Reference** — Stack through Progress | The app as it is now. If this disagrees with anything below, this wins |
| **History** | One entry per working session, oldest first. Why things are the way they are, including the mistakes |
| **Open items** | What is known to be wrong, missing, or agreed and unbuilt. Last section, so nothing hides after it |

One open item carries a design that is **agreed but not built** and says so:
the lesson-bar-by-section item. Don't read it as a description of the app.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 18, no router, no CSS framework — styles are inline objects in a `S` / `T` theme constant |
| Scheduling | `ts-fsrs` 5.4.2 |
| Auth + data | Supabase (Postgres, magic-link email, RLS), free tier |
| AI | `@anthropic-ai/sdk` ^0.124.0, called only from serverless functions. Model is per route — see the table under Serverless functions. **Each user brings their own API key**, except for the linked cahier (see Who pays for Claude) |
| Hosting | Vercel — `api/*.js` are serverless functions, auto-deploys on push to `main` |

**Free-tier gotcha:** Supabase pauses a project after ~7 days idle, and
`getSession()` then never settles. `App.jsx` races it against a 10s timeout and
catches rejections, so this now surfaces as "Couldn't reach the server" with a
Try again button and a note about paused projects, rather than "Loading…"
forever. Resuming the project in the Supabase dashboard is still the fix.

---

## Working protocol

**Every change is made to the local files first.** The working copy is
`~/Desktop/projects/french-flashcards` on the owner's Mac, on `main`. Edit it
there, run it there, and only then merge to `main` on GitHub. Not in a cloud
container and not straight onto GitHub. Since 2026-09-12 the local copy is
where the next change starts, and GitHub is where finished changes land.

Before starting, check that the local copy has caught up: `git fetch` and
confirm `main` is not behind `origin/main`. Fast-forward it if it is. The
first time this was checked it was 229 commits behind, and one more commit
landed on GitHub within the same session.

**`main` on GitHub is still the only branch that matters.** Vercel deploys
from it, so a change is not live until it is merged there. A feature branch is
invisible to the live app and to anyone looking at it. Local first, then
`main`. There is no stop on a side branch in between.

An agent session may arrive pre-configured with its own feature branch and an
instruction not to push anywhere else. That configuration does not know about
this project. Say so at the START of the session and get it resolved, rather
than working for an hour and pushing somewhere nobody is looking — which is
exactly what happened on 2026-09-08, and cost a whole session's work being
invisible until it was noticed.

It then happened AGAIN on 2026-09-09, with this paragraph already written: the
session took its configured branch at face value, pushed three commits there,
and only reached `main` when the owner asked whether it had. Reading this file
is not the same as acting on it. The check is mechanical — if the session was
handed a branch, say so in the first reply, before any work.

That is what happened on 2026-09-12: the session was handed
`claude/clever-euler-90pskc`, said so in its first reply, and was told to use
`main`. Two sentences at the start instead of an hour of invisible work. Keep
doing that.

**Feedback is cleared when it is fixed, in the same session.** Once the change
an entry asked for has landed, mark that entry resolved with a note saying
what was done: `node scripts/resolve-feedback.mjs <ids> --note "…" --apply`.
The script is the only way: the owner does not fix feedback by hand, so the
feedback log in the app is read-only. The list is then only ever what is still
waiting. An entry that needs no change (the card was right) is resolved too,
with the note saying why. Resolving never deletes; the owner clears resolved
rows when they choose to.

`npm test` before every push. It is 23 suites, and closer to twenty minutes
than a few — most of them drive a real browser at several window sizes. Start
it early rather than last, and don't edit `src/` while it runs: the suites
share one Vite dev server, so a save hot-reloads the app underneath a test
that is mid-assertion.

**Running the suite on the owner's Mac takes two adjustments.**

- `tests/run.mjs` refuses to run while the real `.env.local` is present,
  rather than overwrite it. Don't move that file. Copy the repo to a scratch
  directory without it (`git archive HEAD | tar -x -C <dir>`, or rsync
  `src tests api` over an existing copy), symlink `node_modules` into the
  copy, and run the suite there. The copy has the same code, and the real
  keys never come near the mock.
- Point `CHROME_PATH` at Playwright's Chromium:
  `~/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
  The default path in `tests/harness.mjs` is the Linux container's.

**On the Mac, `reflow` is the one suite that fails, on and off, and that is
the baseline.** Its first check (the tutor reflow ran 0px) fails the same way
on `9b95052`, which passed it in the container, and did again on unchanged
code on 2026-09-25, so that one is this machine's headless Chrome — see the
open item.
A new failure in any other suite is real. (`motion` was a Mac failure until
2026-09-12; its feedback checks now read the running transition instead of
counting frames. `layout`'s "card does not move when graded", 264 → 259, was
filed here as the Mac too, and wasn't: the wrong-answer state was ~174px in a
170px well. It passes since the graded state became one column, 2026-09-13.)

---

## How a session is built

`src/lib/sessionQueue.js` → `buildSession(cards, opts)` deals one **block** of
up to 50 cards. FSRS decides when a seen card comes back; which new card comes
next, and when, is decided here. The rules were agreed with the owner on
2026-09-12 — see that History entry for the reasoning and what was rejected.

**A block is made of questions: a card asked one way round.** Since 2026-09-14
(migration_010) each word or phrase card — stored category `V` or `E` — has
two FSRS states, one for "la pomme → ?" (direction `fr`, the existing columns)
and one for "apple → ?" (`en`, the same eight columns with an `en_` prefix).
Grammar and pronunciation cards are asked only as written and use only the
first. Every rule below — due, missed last time, new, well known, answered
today — reads the question's own direction, through `sideOf(card, dir)` and
`sideColumns(fields, dir)` in `src/lib/directions.js`, the one place that
names the `en_` columns (apart from the deck loader and the reset). A queue
entry is `{ ...card, shownDir, flippable, _bucket }`, and anything that tells
entries apart uses `itemKey` — card and direction — because one card can be in
a block both ways. The owner's decisions, and what they rule out:

- **The direction setting is a filter.** FR→EN deals words and phrases French
  side up, EN→FR English side up, Mixed both. **Grammar and pronunciation come
  up in every setting.** It used to be a coin toss per card in Mixed, with one
  schedule taking both answers.
- **Neither way waits for the other.** Both of a new word's questions are new
  from the start and come through the new-card order below. An early draft
  made English → French wait until the word had been seen in French; the owner
  rejected it: which way is harder differs per student and per card, and a
  gate assumes it. Don't reintroduce it in any form.
- **Both ways of a word may come up the same day, in the same block.** No
  sibling burying.
- **Except a word's two first meetings.** Once a card has been answered for
  the very first time one way (that side's `reps` ≤ 1, last review today), its
  other way waits for a later day; and a block never deals both new questions
  of one card. Otherwise the second comes straight after being shown the
  answer, and FSRS schedules a recall that never happened. This decides only
  when a question is first shown, which FSRS has no say in; the owner accepted
  it on that condition.

Selection is by priority, then **order is randomised**. Those are two separate
decisions and it matters:

1. **Lapses** — missed last time, due today
2. **Reviews** — due today, most overdue first
3. **New** — **only once the due cards run out**, in the order below
4. **Spot-checks** — two well-known cards (stability ≥ 60d), ignoring due
   date; insurance against FSRS being over-confident. Only alongside real
   work, never a card already answered today. That threshold is the whole of
   what "mastered" means — see **Progress, and the "mastered" relic**

**Due today** is due any time before the end of the student's local day
(`endOfLocalDay`), so the day's work doesn't grow while they study.

**There is no new-card limit other than rule 3.** A student behind on reviews
gets review-only blocks until caught up; one who learns a lot of new cards in
a day gets a few review-heavy days after. This reverses the earlier rule that
reserved new-card slots *before* due work so a 1,300-card backlog couldn't
starve new material — the owner's call is that a backlog is exactly when new
material should wait. `buildSession` returns `dueRemaining` so the checkpoint
can say the next blocks are reviews only.

**The order new cards come in** (`orderNewCards`):

- **Inside a lesson** (`lessonMode`): the lesson's `teachingOrder` of sections,
  then the card's place in the lesson array, via `lessonRank` in
  `src/data/lessons/index.js`. The array lists every rule before any exercise;
  `teachingOrder` puts each exercise straight after its rule.
- **Otherwise, from the student's notes:** recent classes first (latest class
  date within 14 days — the Stats group *Last two weeks of class*), newest class first; then older classes (*Older classes*), most classes
  first (`dates.length`), older first class on a tie; then undated cards.
  Tutor chat cards have no class, so `classDaysOf` dates them by
  `created_at` — recent for two weeks, then a word seen once.
- **Then unseen lesson cards**, in lesson order. A student with notes rarely
  gets this far; one with no notes yet gets the lesson rather than an empty
  screen.
- Ties are shuffled, then stable-sorted, so they fall randomly.

The block is then shuffled. Presenting fixed runs (all lapses, then all
reviews) is *blocked practice*, which feels easier during the session and
tests worse afterwards. Mixing is *interleaved practice* — about g = 0.42 in
Brunmair & Richter's (2019) meta-analysis of 59 studies.

Guarded by the `serving` suite (no browser), one check per rule.

**A block is 50 answers, retries included** (`placeRetry`). A missed card
comes back `RE_QUEUE_OFFSET` (20) cards later, or at the end of the block if
fewer are left, and takes the place of the block's last card not yet shown —
which is dealt in the next block instead, since it is still unanswered. The
block never grows, the counter is one running "Card N of 50", and a retry says
"· retry" beside it. No retry when the miss is one of the last two cards, or
when every card still to come is a retry: the card is due again tomorrow, first
in that day's block. A retry is practice; FSRS already has the day's answer.

This replaced appending retries after the block. With blocks of 50, every miss
after card 30 landed past the end, so on 2026-09-14 the owner's block with 21
misses ran to 71 cards and read "Retry 1 of 21" before its checkpoint.

### The checkpoint

After the last card of a block, `data-checkpoint` replaces the card (it
replaced "Session complete!" and the New Session button). It says how the
block went ("50 answers, 43 right first time", no full stop — answers because a block
includes its retries, right first time counting first answers of the day in
either mode), what each area moved (`progressChanges`: lesson, last two weeks
of class, older classes), and then either:

- **Continue**, which deals the next block;
- **"You're all caught up"**, with no Continue, when nothing is due and nothing
  is unseen;

plus, inside a lesson, how many cards from the rest of the deck are due.

**Continue builds from the deck in memory, never a refetch.** Answers write to
Supabase fire-and-forget, and `patch()` in `useUserDeck` applies each write to
the local deck too. A refetch straight after the last answer can return that
card's old state, deal it again as due, and record a second review. The
`session` suite's 113-card backlog proves it: three blocks, 113 writes.

**A full rebuild starts at card 1.** It used to keep the card on screen by
jumping to wherever that card landed in the shuffled block — entering a lesson
could start the student at card 35 of 50, skip 34 cards and end the block
after 16 answers. The card on screen now moves to the front instead.

`applyAnswer(card, got, now, dir)` records to the shown direction only, and returns
that direction's columns — the same object is the database update and the
in-memory patch, so patching every entry of the card with it is right even
with the card in the block both ways. It maps the binary typed result onto two of FSRS's four
ratings — `Again` for a miss, `Good` for a hit. `Hard`/`Easy` exist for apps
where the user self-rates; here the typing check *is* the grade, and inventing
a confidence signal the user never gave would only feed FSRS noise.

**FSRS gets one answer per card per way round per day: the first.** `answer()` skips the
scheduler write when `reviewedToday(sideOf(card, dir).last_review)` (`src/lib/studyDay.js`)
says that way round already had its review on the student's own day. The card is
still shown and graded on screen. This covers the retry after a miss,
Previous card, a reload mid-session and a second device.

Before this, the retry wrote a second review minutes after the student had
been shown the answer, and the scheduler is run with short-term steps off, so
it reads every answer as evidence about memory across days. Measured against
this app's settings, it moved the schedule the wrong way every time: a known
card missed then right on the retry went from due in 3 days to 4, and lost the
`last_answer_correct = false` that puts it first next session; missed twice
counted as forgotten twice, difficulty near its maximum; a new card missed then
right went from due tomorrow to 3 days. `lapses` stored before this fix still
carries those double counts, and with no review log it cannot be corrected.

### Flipping and typing

Two ways to answer, both recorded to FSRS the same way, under the same one
answer per card per day rule:

- **Typing** (the default for a new student). The matcher grades: a small
  typo is right ("close enough"), a wrong article is wrong, Show answer is
  wrong. **Except on a French-answered drill** (a `→` in the front, shown
  French side): there the answer must be exact once case, accents,
  punctuation and parentheses are set aside (`matchAnswer`'s `exact`). The
  tolerance accepted exactly what the drills drill — "je vend" for je vends,
  "que j'aie" for que j'aille, chères and chèrement for cher, évidamment for
  évidemment — and a close enough counts as remembered. Only a real
  conjugation drill or a lesson card is marked exactly; a leftover rule card
  with an arrow and an English answer is not. Exact is exact about what, not
  how it is quoted (`drillAlternates`): an `il/elle` drill takes either
  pronoun, a subjunctive is right with or without its que, a drill stored
  without a pronoun ("vienne") takes the pronoun the instruction line asks
  for ("que je vienne"), and a lesson card takes the lesson's current answer
  even on a row synced before the lesson widened it. Only "/" separates exact
  answers — a comma is part of one. Everywhere, œ may be typed oe, a phone's ’
  is an apostrophe and … is punctuation. Checked, so it is the stronger evidence. Tapping the card with an
  answer typed checks it; Escape clears the box and gives nothing up. An
  accepted "my answer should be accepted" dispute is recorded as right.
- **Flipping.** The student turns the card and grades themselves. Got It and
  Again are offered only once the answer has been seen — before that the one
  button is Show answer, and the grading keys turn the card instead — with
  "Only press Got It if you knew it before turning the card." beneath. FSRS
  learns only what that press says. Just turning a card records nothing.

The last choice is remembered on the browser (`localStorage` `study-mode`).
Tests open in flip mode unless they ask (`openApp({ studyMode })`), because
the suites were written against it.

**Previous card corrects a grade.** Going back and grading a card differently
replaces that day's answer, recomputed from the card's state before it
(`blockAnswersRef`, cleared per block). The block's answer count doesn't move.
Retries are never corrections.

**A failed save is shown and retried** (`save`): "1 answer not saved yet
— retrying" beside the counter, backoff from 3s to 60s, a newer write under
the same key replacing an older one waiting, and a prompt before leaving the page
while anything is unsaved. A schedule write is keyed by card AND direction, so
an English-side answer never replaces a French-side one still waiting for the
same card; an answer record by its own id. The notice counts answers, not writes.

**Every answer is kept** (`card_reviews`, `src/lib/reviewLog.js`): card,
direction, time, right or wrong, whether FSRS counted it, and that direction's
state before and after. Retries and second answers of the day are kept with
`counted` false. The id is made in the browser, so a retried save and a
correction with Previous card rewrite their own row. Nothing reads it yet —
see the open item.

**Changing direction re-deals the rest of the block** (`dirRef`, the effect on
`dir`). Answered entries stay, and the card on screen if its answer has been
seen; later entries the new setting still asks stay where they are; the rest
are replaced by `buildSession(..., { inBlock })`, which deals nothing already
in the block and no second first meeting. The block keeps its count and its
retries, and its length where the deck has enough. It used to turn the
remaining cards round, which can't work once each way is its own entry, and
before that it dealt a new block.

**Switching waits once the answer has been seen** (`toggleTypeMode`,
`pendingTypeMode`). Before the answer is seen, the switch is immediate. After —
a flip, a checked answer, or Show answer — the card is graded the way it was
started and the switch applies from the next card, with "Typing starts from the
next card" (or "Flipping…") beside the chip; pressing again cancels it.
Switching used to reset the card: flip, switch to typing and type what you had
just read, and FSRS recorded a recall that never happened; or Show answer,
switch to flipping and press Got It. `session` checks both, by the writes.

### FSRS configuration (`src/lib/spacedRepetition.js`)

```
request_retention: 0.9      maximum_interval: 3650
enable_short_term: false    enable_fuzz: true
```

`enable_short_term: false` means FSRS never enters the Relearning state, so a
miss is recorded on the row as `last_answer_correct` instead. `sessionQueue`
reads that to find lapses.

The same scheduler runs both directions of a card, each from its own state;
`toFsrsCard` and `fromFsrsCard` take and give one direction under the plain
field names.

---

## The linked cahier

Laura and each student keep the real cahier in a Google Doc — one dated block
per class, newest at the top, the same four headings and a homework line. Until
2026-09-24 a cahier was uploaded once and the deck then drifted behind the
teaching: the owner's deck stopped at the 5 September class while the doc had
twelve classes more.

A student pastes the doc's link once (the upload modal's link tab, "Keep my
deck up to date from this doc"). After that:

- **Only classes the deck hasn't got are parsed.** `cahier_links.classes`
  (migration_011) holds a fingerprint per class already read. Linking a doc
  that was uploaded last month costs nothing for the classes already in the
  deck: they are marked as read from the dates on the student's own cards.
- **New classes become cards straight away** and are scheduled like any other
  new card — due work first, then new cards, most recent class first. No
  review step; the owner's call.
- **A class is parsed once and never again.** Editing or deleting a line in an
  old class changes nothing in the deck. Those cards carry the student's own
  history, and rewriting them behind their back is worse than a stale card.
- **A word taught again keeps the card the student has.** Only the class date
  is added, which is what orders new cards. Front and back are left alone,
  hand-edits included — the one place this differs from an upload, which
  deliberately rewrites them.
- **Nothing is ever deleted.**

**When it runs.** When the app opens, at most hourly per browser
(`useCahierSync`), and once a day for every linked doc (`api/cahier-daily`, a
Vercel cron at 13:00 UTC, which refuses any caller without `CRON_SECRET`).
Reading the doc is a plain text fetch and costs nothing; only an unread class
costs anything. The server refuses two checks within 30 seconds, so opening the
app while the daily job runs can't parse the same class twice.

**A run parses at most 12 classes** (10 from the daily job) and reports how
many are left, and the client loops. A year-old cahier is therefore several
runs rather than one that times out.

**Who pays.** The deploy owner, from `ANTHROPIC_API_KEY` — not the student.
This runs unattended, and a class is a few hundred words: pennies for a class
of students. Every other Claude route still bills the caller. With no key set,
the route stops at once and says which setting is missing.

**What the student sees.** "Your class of 24 September: 31 new cards added to
your deck", dismissible, under the top bar (`data-cahier-notice`); and in the
link tab, when it last checked, what it last added, and why it failed if it
did — a doc whose sharing was turned off says so rather than going quiet.
Linking that fails shows the server's own reason: `sync` in `useCahierSync`
returns `{ ok, error }`, and the dialog reads that, not the hook's state.

**How the link row is written** (`api/cahier-sync.js`). Linking, or relinking
to another doc, writes the whole row with an upsert (`linkDoc`) — the only
write that may create it. Everything after — when it last checked, what it
added, why it failed — is a plain update of that row (`updateLink`). Don't
fold them back into one upsert of the changed fields: Postgres checks an
upsert's insert row first, `doc_id` and `doc_url` are NOT NULL, and every
sync failed that way until 2026-09-25 (see that History entry).

**The doc must be readable by anyone with the link.** That is how it is read
with nobody signed in to Google. Private docs would need Google sign-in — see
the open item.

Guarded by the `cahier-sync` suite (no browser): a stand-in database, doc and
Claude, with the number of Claude calls counted, because that is the bill.
The stand-in refuses an upsert missing a NOT NULL column that has no default
(`REQUIRED`), as Postgres does.

**What the parser makes of the grammar section** (since 2026-09-24, every
path: upload, few-shot upload, sync). Only cards you can answer by typing:
conjugation tables become drills (and the table card itself is no longer
kept — its front listed every answer), a single form becomes a drill
(`infinitive (tense) → person`), and a real word, phrase or example sentence
becomes an ordinary `V` card whatever section it sat in. A rule statement or a
pronunciation note makes no card — only the words or sentences under it do.
The prompt text for this is one block (`WHAT_BECOMES_A_CARD` in
`parse-cahier.js`) shared by both prompts, and `keepAnswerable` enforces it
after the model on all three paths: a `G` card that isn't a drill is dropped
if `isGrammarCard` reads it as a rule or a sound, or it is a whole
conjugation table on one side, and made `V` otherwise.

---

## Card types: grammar / vocab / phrase

`src/lib/cardTypes.js` → `classifyCard(card)`.

Storage keeps four cahier category codes (`V`/`E`/`G`/`P` → vocab/expr/gram/
pron) because that is what the notebook sections are. Those are **not** the
distinction you study by, so the UI collapses them into three:

- **grammar** — a card *about* French rather than a piece of it, judged by
  its shape (`isGrammarCard`), not its stored category: a conjugation drill
  (front contains `→`, e.g. `aller (subjonctif) → ils/elles`), a grammar term
  (`GRAMMAR_TERM`), a formula (`+`, `=`, `vs`), a `{respelling}`, or a back
  that explains a distinction rather than translating. The category only says
  which notebook section a card came from
- **vocab** — one word *or one concept*. `la patate douce` is a sweet potato,
  `le chemin de fer` is a railway: one thing to learn, however many words
  French spells it with. Determiners and compound-noun glue (`de`, `à`) don't
  count toward the size; gender pairs (`un vendeur / une vendeuse`,
  `gros, grosse`) are one headword
- **phrase** — an `expr` card of any length, or anything with a clause: a
  subject pronoun, or more than three real ideas strung together

Used for the **All / Grammar / Vocab / Phrases** filter in the Cards view, the
**By type** panel in Stats, and the tag on each card in Hardest Cards.

**A grammar card is a drill, or it isn't a card** (owner, 2026-09-24). Every
card must be answerable by typing something the matcher can check. So there
are no rule cards (`Pronoms toniques` → "moi, toi, lui/elle…", which nobody
types closely enough to be marked right, so it was always a miss) and no
pronunciation cards (there is no microphone). What remains in `G` is
conjugation drills and lesson cards. Where a rule or
pronunciation card had a real word or example sentence underneath, that is an
ordinary two-way card now. The cahier parser no longer makes either kind (see
*The linked cahier*), the demo deck (`src/data/cards.js`) was sorted by hand
with the owner, and `scripts/sort-grammar-cards.mjs` sorts existing decks.

**Every grammar card says what to type** — one line above the prompt
(`cardInstructionFor` in `src/data/lessons/index.js`, `data-card-instruction`).
`vivre → je` never said which tense, and `relatif → adverbe` read as a word to
translate. A conjugation drill's line comes from its own shape
(`src/lib/cardInstruction.js`): the tense by name and the pronoun the answer
starts with, because the answer includes it — "Present tense, with je", kept to
one short line; a drill naming no tense is the present. The line is in italics,
like the tap hint, so it reads as the app talking rather than part of the card.
Any other lesson card takes its section's line from `LESSON.instructions`. Word
and phrase cards get none: they are translations, and the input already says
which language. Here "grammar" is the stored category (`gram` or `pron`), not
the shape test above, so the adverb lesson's false friends, stored `G`, get
"Translate into English". In English, by the owner's choice.

Note the filter exists by explicit user request. Studying one type at a time
is blocked practice and costs retention; the default is `All`.

---

## Card-quality machinery

Two distinct problems, two mechanisms. Both matter because a bad card is worse
than no card: FSRS records a recall that never happened.

### 1. English gloss on the French side

Cahier lines carry inline glosses and the parser sometimes left them on the
front: `je suis allé (I went (passé)` — the card answers itself.

`src/lib/cardText.js` → `cleanFrenchPrompt(fr, en)` strips a parenthetical
from the French side **only when it repeats a content word from the English
side**. Grammar tags — `(adj)`, `(f)`, `(pl)`, `(passé composé)` — are exempt.

Applied at **display time** (and to text-to-speech), so it fixes the existing
deck with no migration. The stored row and the answer side are untouched. The
same rule also runs over the parser's output so new uploads store clean.

Two more display-time rules sit beside it in `cardText.js`:

- `cleanEnglishPrompt(en)` — English shown as the question loses a note that
  names the French form: `to re-elect (past participle: réélu)` asks for
  `réélire` and prints the participle. Only notes with a colon go; a bare
  `(past participle)` or `(of products)` is a disambiguator and stays.
- `dropFinalPeriod(text)` — no sentence-final full stop on either face. Cards
  are headwords and phrases, most never had one, and the lesson's did. Done at
  display time because editing a lesson card's front changes its identity.

And one rule in the answer matcher: **parentheticals come off the answer
BEFORE it is split on `; , /`.** `seul (only; sole)` used to split inside its
own gloss into `seul (only` and `sole)`, neither of which normalises to
`seul`, so the right answer was marked wrong. 64 cards in the owner's deck had
that shape; none that matched before stops matching.

### 2. One card teaching two different words

`les frais` is a plural noun (costs); `frais` is an adjective (fresh). Sharing
a spelling, they became one card backed by `the costs; the expenses; fresh`.
There is no single right answer to type, so it can't be studied or scheduled.

Three steps. They were a modal in the profile menu once; cleaning up cards
that teach two words is maintenance on a deck, not a task to hand a student,
so the UI went and **`scripts/fix-multi-sense.mjs`** is the caller now.

1. **Scan** — `src/lib/multiSense.js` shortlists candidates, and costs nothing
   because it is pure string work. It reads the deck's own separator
   conventions: a semicolon means senses got run together, so divergent parts
   suffice; a slash is the near-synonym marker (`to unload / to discharge`)
   and a short comma list is a gender pair, so those only count when the parts
   aren't even the same part of speech. That keeps the API bill to the real
   suspects rather than all 8,700 cards.
2. **Check** — Claude decides split-or-keep and writes the correct front for
   each sense: the noun keeps its article (`les frais`), the adjective doesn't
   (`frais (adj)`), verbs go to the infinitive. Told to keep when unsure.
   Writes nothing. `api/split-senses.js` owns the prompt and the tool schema,
   and the script **imports** them rather than copying them, so the two cannot
   drift.
3. **Apply** — `api/apply-splits.js` writes. The original row is rewritten as
   the first sense and **keeps its scheduling history** — it is still the card
   you have been studying, with the other headword's glosses removed. The
   other senses become new cards starting from New, which is honest: you have
   never been tested on them alone. Ownership is checked row by row; malformed
   splits are refused at both ends.

The parser prompt also forbids producing these in the first place.

---

## Serverless functions (`api/`)

| Route | Does |
|---|---|
| `parse-cahier.js` | Notebook text → cards. The big one: section slicing, homework stripping, slash-pair splitting, conjugation expansion, dropping cards nobody could answer (`keepAnswerable`), polysemy-aware dedupe. Its pieces are exported for `cahier-parse.js` and `cahier-sync.js` rather than copied |
| `cahier-sync.js` | The linked cahier: reads the student's Google Doc and parses only the classes the deck hasn't got. Runs on the server's `ANTHROPIC_API_KEY`, not the student's. See *The linked cahier* |
| `cahier-daily.js` | The Vercel cron (13:00 UTC, `vercel.json`) that runs `cahier-sync` for every linked doc, up to 40 a run, least recently checked first. Refuses any caller without `CRON_SECRET` |
| `chat.js` | Tutor chat. Streams (SSE), Sonnet 5 at effort `low`, sent a slice of the deck as context, including the card on screen and **whether its answer has been shown** — until it has, the tutor gives hints, never the answer. Proposes cards via a `propose_flashcards` tool; **never writes** — the client does the RLS-protected insert |
| `split-senses.js` | Audits candidate multi-sense cards. Read-only |
| `apply-splits.js` | Applies approved splits. Service role + manual ownership checks |
| `admin-update-card.js` | Single-card edit. Service role, because RLS was silently returning success with zero rows affected from the client |
| `review-answer.js` | Adjudicates "my answer should have been accepted". Honours `force` without a model call; alternates are per-user |
| ~~`tts.js` / `pronounce.js`~~ | **Deleted.** Unauthenticated proxies to the owner's Azure Speech account. `src/audio.js` now uses the browser's own `speechSynthesis` only |
| `admin-users.js`, `parse-corrections.js`, `upload-batches.js`, `cahier-parse.js` | Admin and upload plumbing |

### Which model each route runs

The model is a constant per file, chosen for that file's job — not something a
router picks per request. The endpoint boundaries already sort the traffic by
kind, so this needs no classifier.

| Route | Model | Why |
|---|---|---|
| `chat.js` | `claude-sonnet-5`, effort `low` | On the latency path; a vocabulary lookup is not hard inference |
| `review-answer.js` | `claude-opus-5` | Rare, and it writes to `card_alternates` and to scheduling. Cost of error is real, so it keeps the strongest model |
| `split-senses.js` | `claude-opus-5` | Batch classification against written-out rules. **Overkill; Sonnet would do**, and being offline it could go through the Batch API at half price |
| `parse-cahier.js`, `cahier-parse.js`, `cahier-sync.js` | `claude-haiku-4-5` | Structured extraction from a regular format. Correct as-is. The sync uses `parse-cahier.js`'s own call |

`api/_lib/` is skipped by Vercel's function discovery (underscore prefix), so
it is import-only.

**Environment:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`,
`ANTHROPIC_API_KEY` (the owner's: the admin's fallback, and what the linked
cahier is parsed with — without it that feature refuses to run), `CRON_SECRET`
(the daily cahier check), plus `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` and `VITE_ADMIN_EMAIL` on the client. Azure Speech
vars are gone with the endpoints that read them.

`VITE_ADMIN_EMAIL` decides only whether the admin menu items are DRAWN.
Anything `VITE_`-prefixed is compiled into the public bundle, so it can never
be a security boundary; `ADMIN_EMAIL` is the one the server checks.

---

## Who pays for Claude

`api/_lib/auth.js` **verifies** the Supabase token (`auth.getUser`) rather
than base64-decoding it. The old version decoded the payload and trusted it,
so an unsigned `{"email":"<admin>"}` passed `requireAdmin` — and the admin
address was public, being read from a `VITE_` variable. That reached
`admin-users.js`, which lists every user's email.

`api/_lib/anthropicKey.js` decides who pays. The caller supplies their own
key in an `x-anthropic-key` header; without one the endpoint answers **402**
with `code: "byok_required"` and the client offers the connect dialog. Only
`ADMIN_EMAIL` falls back to the server's `ANTHROPIC_API_KEY`. The exception
is the linked cahier (`cahier-sync`, `cahier-daily`): it always uses the
server's key, since it runs with no student there to pay — see *The linked
cahier*.

Client side, `src/lib/anthropicKey.js` keeps the key in `localStorage` under
`anthropic-key:<userId>` and `src/ApiKeyModal.jsx` is the UI (profile menu →
Connect Claude account). The key is never written to the database or a log,
so the app is not a custodian of anyone's credentials — the cost is
re-entering it per browser.

Guarded by `tests/suites/auth.mjs`, which points `ANTHROPIC_BASE_URL` at a
local counting server and asserts an unauthenticated caller causes **zero**
billable requests. Its first version watched `globalThis.fetch`, which the
SDK does not use — it passed with the hole deliberately put back. Measure
what the code actually sends.

---

## Maintenance scripts (`scripts/`)

Deck maintenance that is real work but is nobody's *feature*. All of them run
from a terminal against production, read `.env.local` themselves, and
**default to writing nothing** — `--apply` is what makes them write.

| Script | Does |
|---|---|
| `fix-multi-sense.mjs` | The multi-sense cleanup end to end: scan, audit, apply. `DECK_USER_ID` narrows it to one deck; omit it for every user |
| `resolve-disputes.mjs` | Works the backlog of "my answer should have been accepted" claims left in `feedback_submissions` |
| `resolve-feedback.mjs` | Lists open `beta_feedback`, and marks entries resolved (`--note`, `--apply`) once they are fixed. Needs `migration_009` |
| `sort-grammar-cards.mjs` | The one-off clear-out of rule and pronunciation cards from every deck (2026-09-24): keeps conjugation drills, turns the rest into ordinary cards where real French sits underneath, archives what is only a rule or a sound. The owner's hand-made sort of the original 117 (`scripts/data/grammar-sort-decisions.json`) decides every card it covers; Claude decides the rest, checked, and anything that fails the check is left undecided. The dry run writes the proposal to `backups/`; `--apply <proposal>` applies exactly that file, after a full backup. Lesson cards are never touched |
| `reset-fsrs-seed.mjs` | Puts cards still carrying `migration_007`'s guessed state — due at exactly the instant it ran, never answered since — back to not yet seen. `--apply` backs every row up to `backups/` (gitignored) first. Run for all decks on 2026-09-14; a dry run now finds none |

Two things worth knowing about them:

- **They talk to Supabase and Anthropic directly**, not through `api/`, because
  those endpoints require a signed-in browser session. Where a prompt or a tool
  schema is shared with an endpoint it is **imported** from it, never copied.
- **`resolve-disputes.mjs` leaves `uncertain` alone.** It records `accept` (the
  answer goes into `card_alternates` and the row is approved) and `reject`
  (with the reasoning), and stops there: a machine that cannot decide should
  not be the thing that closes a complaint about its own marking.

The dispute backlog exists because nothing writes `feedback_submissions` any
more — a dispute now goes to `/api/review-answer`, which decides and writes
`card_alternates` on the spot. What is in the table is everything raised before
that endpoint existed, or while it was failing. The admin view still lists it.

---

## Migrations

Run in order in the Supabase SQL editor. `migration_006` is **schema only** and
`migration_007` holds all seeding — deliberately separated so re-running 006
can never undo 007.

- `002_parse_corrections` — the ledger that lets the parser learn from admin
  edits: `upload_batches`, `parse_corrections`, and a 90-day aggregate view
  that becomes few-shot guidance on the next upload
- `003_user_cards_rls` — the RLS policies `user_cards` needs. Written because
  the admin card editor's Save appeared to succeed and changed nothing:
  PostgREST returns success with zero rows affected when RLS is on and the
  UPDATE policy is missing. **Search-and-replace the admin email before
  running it.** Re-runnable; each policy is dropped first
- `004_parse_corrections_card_id_bigint` — 002 assumed `user_cards(id)` was a
  uuid and it is a bigint, so every correction insert failed on a
  fire-and-forget path that swallowed the error. The ledger stayed empty while
  looking like it was being written
- `005_spaced_repetition` — Leitner boxes (superseded)
- `006_fsrs` — adds `stability`, `difficulty`, `fsrs_state`, `reps`,
  `last_review`, `last_answer_correct`, plus a check constraint and two indexes
- `007_fsrs_reseed` — idempotent. Resets to New anything with `box <= 1 AND
  lapses = 0 AND NOT EXISTS (card_progress.seen > 0)`; re-seeds the rest from
  the box ladder or the `card_progress.score` ladder
- `008_card_alternates_per_user` — adds `user_id` to `card_alternates`, and
  **deletes the existing rows**. `card_id` is the lowercased front text, which
  is shared across every deck, and the table had no owner: when one student's
  "my answer should have been accepted" was upheld, that answer became
  accepted for *everyone* holding that card. One learner's loose synonym
  silently loosened everyone else's grading. The old rows had no recoverable
  owner, so they go rather than get guessed at
- `009_beta_feedback_resolved` — adds `resolved_at` and `resolution` to
  `beta_feedback`, and the admin UPDATE policy that marking resolved needs.
  Both admin views list only open entries; without this migration they fall
  back to listing everything and say why, rather than showing an empty list.
  Resolving is done by `scripts/resolve-feedback.mjs`; the app has no button.
  **Search-and-replace the admin email before running it**
- `010_two_directions` — the English-side FSRS state on `user_cards` (the eight
  `en_` columns, all new, a check constraint and a due index), and
  `card_reviews`, one row per answer, with owner-only select / insert / update
  policies and no delete. Additive and re-runnable; the existing columns are
  the French-side state, unchanged
- `011_cahier_link` — `cahier_links`: the doc a student studies from, a
  fingerprint per class already turned into cards, when it was last read, what
  it last added and why it last failed. Owner-only policies; no delete policy
  is needed beyond the student's own. See *The linked cahier*

**A cautionary tale worth knowing:** the first version of 006 treated the
`dates` array as review history. It isn't — those are the *lesson* dates a word
appeared on, so every parsed card has them and all 8,703 cards were marked as
reviewed. `isNewCard()` had the same bug, which meant the 20-new-per-session
cap had silently never applied. Production after the repair: 7,361 New /
1,342 Review.

---

## UI layout notes

These look arbitrary and are not. Each one is a bolded claim followed by the
bug that produced it, so the list is searchable by the thing you are about to
touch — `cardArea`, `cardWrap`, the chip rows, the feedback sheet.

They are in roughly the order they were learned, not grouped by topic, and
that is deliberate: several of them interact, and a few exist only because an
earlier fix caused the next problem. The card's size, the space above and below
it, and the panel animation are **one system** — three of these notes are
successive attempts at the same 118px error. So if you are changing any of
them, read the card and motion notes as a set rather than finding the one
bullet that names the property you had in mind.

The rule that governs the whole section: **measure it in a browser.** Several
of these were "fixed" against an assumption and shipped broken.

- **`main` owns the reflow, not the shell.** Both side panels (tutor, feedback)
  push the content column via padding on `<main>`. Padding the shell shrank the
  **sidebar** too, jumping its account block up the page. The sidebar is not
  what either panel covers. *(Since 2026-09-12 only the tutor and the lesson
  notes do; `main` has no `padding-bottom` at all.)*
- **The feedback panel lives inside the sidebar, and moves nothing.** It is an
  inset card (hairline border, soft shadow, 16px in from each sidebar edge,
  ~223px wide) in `data-feedback-dock`, the flex slot between the nav and the
  account block — `sideNav` gave up `flex: 1` so the dock could take the free
  height. The dock pins the panel to its bottom edge and its 24px top padding
  keeps it clear of Tutor; on a short window it holds a 244px floor while open
  and the sidebar scrolls rather than the panel climbing over the nav. It
  replaced a bottom sheet across the content column, which cost the card
  ~140px of height while open, sat far from the link that opened it, and
  produced every sheet note below. The rule it was moved to satisfy: **nothing
  may cover the card.** A popover anchored above the link was tried in mockup
  first and rejected for exactly that — at narrower windows it reached the card.
- **The feedback sheet is offset by `SIDEBAR_WIDTH`** so it centres over the
  content column instead of straddling the nav. *(Bottom sheet only — superseded 2026-09-12: the feedback panel now lives in the sidebar and moves nothing.)*
- **The card is height-driven, with a floor** — `height: 100%`, `min-height:
  170`, `max-height: min(375px, 62.5cqw)`, width following the 1.6:1 ratio
  (`aspect-ratio: 1.6 / 1`). It used to be a fixed
  600×375, and once the window was shorter than that, centring overflowed in
  *both* directions and the top of the card rode up over the counter and the
  back button. The card area also uses `justify-content: safe center`, which
  falls back to top-alignment rather than overflowing upward.

  The `min-height` and the sizing below it were the *second* fix: height-driven
  with no floor meant the card absorbed the entire squeeze when a panel opened
  — at a 700px viewport it collapsed to 80×50 with its text still at 40px,
  while 130px of padding sat unused beneath it.
- **The card text sizes to the card**, not to the page. The card's two faces
  set `container-type: size` (see below for why it is the faces and not the
  card) and the text uses `clamp(19px, 10.7cqh, 40px)` — 40px
  at full size, scaling down with the card so a squeezed card is still legible
  rather than three enormous words.
- **`cardArea` has no bottom padding any more.** It used to carry 130px that
  dropped to 16 when a panel opened, so the space below the card was given up
  before the card gave up anything. `cardTopSpacer` does that job now, and does
  it above the card as well as below, which is what stopped the card sitting
  118px above the window's middle. The `padding-bottom` transition that used to
  ride along with it is gone too: with the value pinned at 0 it could never
  fire, and the motion suite was pointed at it — see the 2026-09-12 entry.
- **Everything under the card sits in a fixed-height well** (`S.belowCard`,
  170px — measured, being the height of the tallest state: a wrong graded
  answer stacks a result banner, the dispute link and the Continue row). *(Since
  2026-09-13 every graded state is 133px on a desktop window, the links being
  one row under Continue; the tallest is a "close" answer on a phone, 162px,
  where that row wraps. See the next note.)* The
  card area centres its contents, so without the well, swapping the typed-answer
  input for the graded state re-centred the whole column and the card jumped
  45px up the page mid-answer. The card now holds one position in every state.
- **Type mode's graded state is one 420px column** (`S.typeFeedback`), the
  width of Again and Got It: the result banner fills it, Continue keeps its own
  size, centred, and **below Continue** one centred row of 12px links, 32px
  apart — "My answer should be accepted", "Mark for review", "Ask the tutor",
  each shown only where it applies (a wrong answer has the outer two, a correct
  one only the middle, a "close" one all three). The owner's order: Continue is
  pressed nearly every time, so it comes straight after the result. Measured
  2026-09-13 at 1400px: 133px for every state, links on one line, card moved
  0px; at 390px a "close" answer wraps "Ask the tutor" onto a second centred
  line, 162px, still inside the well. Before that, the links sat above Continue
  in two rows. It was four widths stacked — banner 520, links
  as centred text, Continue pushed right in a 480 row — sharing no edge.
  Measured: a wrong answer's column is 133px and a "close" one, which carries
  both link rows, 168px; both inside the 170px well. The old wrong state was
  ~174px, which is what `layout`'s "the card does not move when graded" had
  been catching all along (264 → 259) — see the Mac baseline note. A correct
  answer's banner is green (`#dcece5` on `#1f5446`, the Grammar green's
  family) rather than peach.
- **The card's corner controls are matching 30px circles 14px in**: the
  pencil top-right, the flag bottom-right, and in flip mode the ⓘ bottom-right
  with the flag beside it. The pencil was a 42×26 pill and the flag a 22px box,
  so their centres sat 10px apart on the same edge.
- **`cardWrap` uses `align-items: safe center`, not `center`.** Once the well
  reserved 170px, a short window left the card taller than its wrapper, and
  plain centring overflowed it upward into the counter and back button. Safe
  centring falls back to start instead. Both this and `cardArea` need it.
- **One duration and one curve for every panel that moves the page** —
  `src/lib/motion.js`, 420ms and `cubic-bezier(0.22, 0.61, 0.24, 1)`. The
  feedback sheet used to slide in over 180ms with `ease-out` while the page
  made room over 420ms and the card area gave up padding over 200ms with
  `ease`: three timings on screen at once, which is what "jerky" was.
- **The feedback sheet mounts and unmounts through `mounted` / `entered`**,
  the same pattern the tutor uses. It previously had no exit animation at all —
  it vanished in a single frame while the page took 420ms to close the gap
  behind it, the worst jerk of the lot. The sidebar panel keeps the pattern for
  a 200ms fade-and-rise, but starts it from a `useLayoutEffect` that forces
  layout rather than two `requestAnimationFrame`s: where rAF is throttled the
  rAF version left the panel mounted, focused and at opacity 0.
- **The page's padding is driven by `entered`, not by mount**, and reported
  from a `useLayoutEffect`. Both state changes then land in one React commit and
  the two transitions start on the same frame. Reporting the height at mount
  let the page set off two frames before the sheet did, which measured as 32px
  of drift; tying them together makes it 0. *(Bottom sheet only — superseded 2026-09-12: the feedback panel now lives in the sidebar and moves nothing.)*
- **`container-type: size` lives on the card FACES, not on the card.** The
  faces are `inset: 0` so `cqh` resolves identically, and they hold no 3D
  children. Containment on the rotating element is a plausible compositing
  hazard next to `preserve-3d`; measurement in headless Chromium showed the
  rotation still working either way, so treat this as a precaution rather than
  a proven fix.
- **The feedback sheet is content-sized**, roughly 138px: a title row, a field
  that starts at one line and grows to five, and a row of chips. It was ~300px
  — a subtitle, a 90px textarea, a full-width attach row, a full-width dashed
  dropzone and a footer, for what is really one text field. `max-height` is
  `min(300px, 38vh)` as a backstop, not the usual case. *(Bottom sheet only — the sidebar panel's layout is the next note.)*
- **The sidebar panel is three rows, on two shared edges.** ~278px tall:
  - a 13.5px serif title with the ✕;
  - the message box — 180px, about eight lines, growing to about twelve.
    `panels` fails if it starts under 175px, because the streamlining pass cut
    it back to 112px after the owner had asked for it taller, and nobody said
    so;
  - one 30px action row: an "Attach card" checkbox on the left, the paperclip
    and Send on the right.

  The title, message box and checkbox share a left edge; the message box, Send
  and the ✕'s glyph share a right edge. `panels` checks both to the pixel.
  "Attach card", not "Attach current card", because the full label doesn't fit
  on the action row at sidebar width; its tooltip names the card. It is a
  checkbox rather than the filled "About: …" chip it replaced, so it doesn't
  compete with Send. The ✕ is pulled 4px right so its glyph, not its hit area,
  meets the edge. No "⌘↵ to send" hint; the shortcut stays. The whole thing was
  mocked at real size before it was built.
- **An attached screenshot sits inside the message box**, bottom-left, with a ✕
  badge. The box is a container (`data-feedback-field`) around the textarea for
  exactly this, and the textarea's floor drops by the thumbnail's height, so
  the box keeps its size and the rows below never move. The paperclip
  (`data-add-screenshot`) is icon-only, the way message composers do it: a
  tooltip, "Attach a screenshot — or paste one", and paste and drop working
  anywhere on the panel without being advertised.
- **Anything is sendable: a word, or only a screenshot.** A five-character
  minimum refused "test" with a screenshot attached, answered it with "Write a
  few words first", and the red error row that said so made the panel taller.
  A truly empty send now outlines the message box in red and changes its
  placeholder to "Write something, or attach a screenshot"; typing or attaching
  clears it. The error row is kept only for a failed send.
- **The whole sheet is the drop and paste target**, which is what let the
  dedicated dropzone go. Dragging over it outlines the entire panel; the
  Screenshot chip is the click-to-browse affordance. *(Still true of the
  sidebar panel; the paperclip is the click-to-browse way in now.)*
- **The sheet carries `data-feedback-sheet`.** Tests identify it by that marker:
  matching on a line of copy broke when the subtitle went, and matching on "a
  fixed panel containing a textarea" also matched the tutor.
- **Tutor and feedback are mutually exclusive.** Opening one closes the other.
  This used to route through the feedback sheet's own close request so an
  unsent draft still prompted; since the panel keeps its draft on close
  (below), it is a plain `setShowFeedback(false)`.
- **Closing the feedback panel never throws anything away; sending is the only
  thing that clears it.** ✕, Escape, an outside click, the "Send feedback" link
  (a toggle now — it used to only open) and opening the tutor all just put it
  away, and reopening brings the draft back, with a dot on the link meanwhile.
  That retired the "Discard your feedback?" confirm, the Minimize bar (which
  existed only to keep a draft safe) and the close-request handshake. A
  successful send clears the form at once, closes the panel, returns focus to
  the link and announces itself in a toast in the panel's spot
  (`data-feedback-toast`, `role="status"`, 5s, paused on hover). A failed send
  keeps the panel open with the draft and an inline error, or — if it was closed
  mid-send — raises a toast that doesn't time out.
- **The flag on the card opens feedback about that card.** A faint flag beside
  the ⓘ (`data-report-card`, on both faces, hidden while the panel is open)
  opens the panel with "Attach card" ticked, even if it had been
  switched off for the draft. It stops its own mousedown and click so it never
  flips, continues or grades the card.
- **The panel closes if the window goes narrow.** The narrow layout has no
  sidebar to show it in, and left "open" `overlayOpen` would go on swallowing
  the card's keyboard shortcuts.
- **Only the ✕ and the nav item close the tutor; the same for the lesson
  notes.** Neither closes on an outside click or on Escape. You ask the tutor
  about the card in front of you, so clicking back onto that card — or hitting
  Escape to clear the answer box — used to take the answer away mid-read. An
  outside click meaning "done" is a modal's convention and neither panel is a
  modal. The feedback sheet is the one that still dismisses that way, and
  rightly: you open it, use it, and put it away.

  This retired an apparatus, which is the part worth knowing. While the tutor
  closed on an outside click, its listener had to *swallow* the click its own
  mousedown was about to produce — otherwise the dismissing click landed on the
  card underneath and flipped it — while exempting real controls, because the
  swallow was eating clicks on "Send feedback". All of that is gone with the
  behaviour it served. On a narrow screen the scrim still dims the app behind
  the panel, and no longer dismisses it.
- **The study keys work beside the tutor, until you click into it.** When the
  tutor reflows the page rather than covering the card, it is not in
  `overlayOpen`: it is built for studying with it open, and treating it as an
  overlay left Space, Enter and the arrows dead the whole time. The keys
  belong to the tutor only while focus is inside it or the last click landed in
  it (`pointerInTutorRef`, set on `pointerdown` AND `click` — a click from the
  keyboard or assistive tech has no pointer event, and the `session` suite's
  synthetic click is exactly that). That second condition is the "clicked
  somewhere inert in the tutor, then Enter graded the card" bug, which is why
  checking focus alone is not enough. As an overlay (narrow window, no room to
  reflow) it still blocks the keys outright.
- **Nav markers use CSS longhands**, not the `borderRight` shorthand. React
  diffs per property, so a shorthand base plus a longhand override leaves a
  stale value when the item deactivates — both nav items showed a marker.
- **The chip rows scroll; they never wrap.** The top bar and the sub-toolbar
  are single rows of chips above the card, and wrapping is a *step*: 58px tall,
  then one chip no longer fits and it is 97px, with nothing in between. A panel
  reflow narrows the column continuously over 420ms, so it crossed that
  threshold mid-animation and shoved the whole card area down 39px in one
  frame, taking 39px of card height with it (measured at 1400x700 — the single
  worst reflow artefact in the app). `MIN_REFLOW_CONTENT` was supposed to
  prevent this and could not: it guards the column's FINAL width, and the wrap
  threshold sits around 777px, well above the 680 floor. `.chip-row` in
  styles.css keeps both rows one line at every width and scrolls the overflow,
  so the chrome above the card has a constant height and nothing below it
  moves. The scrollbar is hidden because a visible one is itself a height
  change.
- **The feedback sheet sizes itself from `left`/`right`, never `width: 100%`.**
  It is `position: fixed` with an inline `left` of `SIDEBAR_WIDTH`, and a
  percentage width on a fixed element resolves against the VIEWPORT rather than
  the span it occupies. Below a 1176px window (256 + 920) the width won,
  `margin: 0 auto` had no free space left to centre with, and the sheet hung
  off the right edge — 256px of it at a 900px window, carrying its own Minimize
  and Close buttons off-screen. The only way out of the panel was an outside
  click, which nothing advertises. `width: auto` lets left/right size it and
  `maxWidth: 920` still caps it. The minimized bar had the identical bug. *(Bottom sheet only — superseded 2026-09-12: the feedback panel now lives in the sidebar and moves nothing.)*
- **`cardWrap` has a definite flex basis (`0 1 min(375px, 62.5cqw)`), not
  `1 1 auto`.** It
  used to grow to swallow every spare pixel of `cardArea`, and that slack split
  a reflow into two separate motions: the slack went first, so the card slid
  upward at full size, and only once it ran out did the card stop sliding and
  start shrinking. One 420ms animation, two behaviours, with a hard switchover
  ~80% through — and on the way back the easing crossed the handover in about
  two frames, so the card recovered 12 of its 19px in a single one. A definite
  basis leaves no slack to spend first — and the basis is the card's OWN cap,
  the same `min(375px, 62.5cqw)` the card carries as its `maxHeight`, so the
  wrapper can never stand taller than the card inside it. (It once stood 309px
  against a 290px card at an 800px window, and those 19px were an absorber: the
  card sat still for three frames while they were eaten, then started shrinking
  at 0.64px per px the instant the wrapper reached the card's size.) The basis
  must stay definite: `auto` is
  circular against the card's `height: 100%` and collapses it to its 170px
  floor. This also made the card *larger* on short windows (at 700px tall,
  461x288 -> 491x307) because the old `auto` basis was over-shrinking it.
- **The card caps its height against its WIDTH, via a container query.**
  `aspect-ratio` only holds while one axis is free to follow the other, and the
  card had its height driven by the flex column and its width capped by
  `max-width: 100%` — so once the column was the tight axis both were pinned
  and the ratio lost. At an 800px window the card was 464x375, near enough a
  square; at 900 it was 1.5:1. Long-standing, and invisible to a suite that
  varied only the window height. **`cardArea`** is the `container-type:
  inline-size` container — not `cardWrap`, because an element cannot query
  itself — and the card's `maxHeight` is `min(375px, 62.5cqw)`, 62.5 being
  100/1.6. Whichever cap binds first, the card stays 1.6:1. The query resolves
  the same against `cardArea` as it would against the wrapper: the wrapper is
  `min(600, cardArea width)` wide, and above 600 the 375px cap wins anyway. It
  must be INLINE-size: size containment on an ancestor of the rotating card is
  the same hazard as putting it on the card, and the flip was re-verified by
  sampling the transform mid-rotation.
- **`cardTopSpacer` shrinks at factor 2, and the number is load-bearing.**
  Flex shrinks weighted by factor x basis, so the factor sets the spacer's
  share of a squeeze against `cardWrap`'s 375 basis. The original factor of 1
  had the spacer absorbing only 106/481 of a squeeze and handing the card the
  other 78% — when the whole point of the spacer is to give its space up
  *first*. But a high factor is not simply better: push it past what the
  spacer's 106px can cover and it pins at 0 while the deficit is large and only
  comes off the floor as the deficit shrinks, and that pinning is itself a
  handover — the thing "jerky" turned out to be. Measured across window heights
  640-900, worst ratio of fastest to slowest frame: factor 1 gives 6.5x, 8
  gives 3.2x, 4 gives 2.9x, **2 gives 2.0x** — and 1.1x at the short heights
  where the card has real resizing to do. Worst single frame falls from 26px to
  10px. It only bites under pressure; resting geometry at every window height
  is untouched.
- **The layout suite varies the window's WIDTH as well as its height.** The
  height-only loop it had could only ever catch the card being squeezed
  vertically, and the squarish-card bug above lived through it untouched — then
  a later change made it worse before there was a check to say so.
- **The lesson notes panel reflows exactly as the tutor does, and it is now
  measured.** Twice this went down as "unverified" because the fixture left no
  card on screen to watch — the mock answers writes to `user_cards` with
  `200 []` and keeps serving the same fixed deck, so the lesson sync appeared
  to do nothing. Serving the lesson's own cards as the deck (as `lessons` and
  `lesson-sync` do) gives it a card, and at 1600x900, 1400x900 and 1400x700 the
  card does not move at all while the column narrows: both edges still, card
  area jump 0.0px. Same mechanism, same result.
- **`shellNarrow` clips one axis, `shell` clips both.** The card area's two
  decorative blur circles are positioned outside their container on purpose
  (`left:-60` / `right:-60`); the desktop shell's `overflow:hidden` hid that
  fact for a long time. Below 768px the narrow shell clipped nothing and the
  document came out 20px wider than the window. It takes `overflowX` only:
  the narrow layout scrolls vertically by design — its nav is a fixed bottom
  bar — so clipping both axes would be wrong.
- **The sidebar minimizes to a 64px rail** (`data-sidebar-toggle`). At full
  width the button sits in the corner of the top padding; minimized it is the
  **first item in the rail**, styled as a nav item, so its icon shares the
  column's centre line (29.5px) and 50px spacing. Positioned on its own it sat
  2px right of the icons and too close to Cards — the owner spotted it. Minimized: icons
  only, each with its page's name as a title, the marker unchanged, no lesson
  sub-items; the avatar, then the feedback trigger as an icon beneath it, as
  "Send feedback" sits beneath the account at full width. The preference is
  `localStorage["sidebar:minimized"]`. Three things follow from it:
  - **Feedback widens it.** The panel renders inside the sidebar and needs the
    full width to write in, so opening it (from the icon or the flag on the
    card) sets the sidebar full width *without* touching the saved preference,
    and closing it minimizes the sidebar again.
  - **`roomToReflow` subtracts the sidebar's current width**, not 256, so a
    minimized sidebar leaves the tutor room to sit beside the card on
    narrower windows.
  - **The rail does not scroll.** The full sidebar is `overflowY: auto`, which
    forces horizontal clipping too, and the profile menu (200px wide) would
    have been cut off at the rail's edge. Minimized, overflow is visible; the
    rail is short enough never to need to scroll.
  Guarded by the `sidebar` suite. Phones are untouched: no toggle, same
  bottom bar.

---

## Testing

`npm test` — see `tests/README.md`. Twenty-three suites: nine needing no browser,
the rest driving the real app in headless Chromium against a mock Supabase,
asserting on **measured** values (geometry, computed styles, request payloads)
rather than on intent.

`reflow` is the one to reach for when a panel looks wrong: it samples geometry
every frame through a whole open and close, at several window sizes, and fails
on anything that jumps rather than travels. Every reflow bug this app has had
was something downstream of the animating padding moving in a single frame
while the padding itself moved smoothly over twenty-five — invisible to any
check that measures only before and after.

If you change layout, measure it in a browser. Several bugs in this project's
history were "fixed" against an assumption and shipped broken. Two rules the
suite exists to enforce, both learned from checks that lied:

- **Write the assertion from the requirement, not the implementation.** A check
  derived from the code you just wrote can only confirm that code. This suite
  once asserted "the sidebar stops above the panel" and passed for weeks — the
  sidebar shrinking *was* the bug.
- **Never bake in a number describing fixture data.** Read it back from the
  fixture (`servedDeck()`). A hard-coded deck size went stale and reported a
  failure the app hadn't caused. Since a word is asked both ways, a block is not
  the deck size: `firstBlockItems(rows, direction)` in the harness works out a
  first block from the serving rules, not by calling the app's code.
- **Judge an answer by the write, and a write by its keys.** A French-side
  answer writes only the existing columns, an English-side one only `en_`
  columns (`answering`, `serving`); a write to the wrong side corrupts a
  schedule silently, and nothing on screen shows it.
- **A stand-in database must refuse what the live one refuses.** Twice a
  write passed every check against a stand-in that accepted anything and
  failed on the live app at first use: the reset's null in a NOT NULL column
  (2026-09-14) and the linked cahier's partial upsert (2026-09-25).
  Both stand-ins now copy the live constraint: the mock and `answering`
  refuse a null in any column of `USER_CARDS_NOT_NULL` (harness), and
  `cahier-sync`'s refuses an insert missing a column in `REQUIRED`.
- **Find elements by a marker the component owns**, never by their copy or by
  a structural coincidence. `data-feedback-sheet` and `data-attach-card` exist
  for this. Finding the sheet by its subtitle broke when the subtitle was
  deleted; the replacement, "a fixed panel containing a textarea", also matched
  the tutor and made a mutual-exclusion check pass while reporting on the wrong
  panel; and finding the attach chip by the French on it broke when the fixture
  changed.
- **Leave the app in a known state between sections.** A section that opened
  the feedback panel and didn't close it made the next section's click on the
  card read as an outside-click dismissal, which reflowed the page — and looked
  exactly like the card moving 12px on a flip.
- **`settled(page)` waits for `getAnimations()` to go idle.** Polling until a
  value "stops changing" is not enough: the panel easing crawls at the end, so
  three consecutive samples can read identical while the element is still 12px
  from where it lands.

---

## Lessons

A lesson is a fixed set of cards built from a teacher's materials, the same for
everyone. `src/data/lessons/` holds them; `LESSONS` in `index.js` is the
catalogue. There are two: **L'impératif** (108 cards), built from Laura
Caufour's LFL METHOD lesson and exercise PDFs, and **Adjectif ou adverbe ?**
(81 cards, below), written for the app. Each carries its cards, `notes`,
`teachingOrder` and `instructions`.

The shape of it:

- **Static in the app, copied into the deck.** The lesson is shared; adding it
  copies its cards into `user_cards`, and that copy is what makes the
  scheduling personal, since FSRS state lives on the row.
- **Tagged `source = "lesson:<id>#<cardKey>"`.** That column already existed —
  the cahier parser writes `cahier-upload`, the tutor writes `tutor-chat` — so
  lessons needed no migration. The key hashes the front the LESSON ships
  (`src/lib/lessonSource.js`) and is the card's identity. Identity used to be
  the stored front, which meant correcting a typo on a lesson card made the
  sync unable to recognise it: the row was retired as "no longer in the
  lesson", taking its FSRS history, and the uncorrected original was inserted
  in its place. Rows written before keys existed are matched by front and
  re-keyed on the next sync.
- **The sync itself is covered by `lesson-sync`, separately from `lessons`.**
  The `lessons` suite serves the lesson's own cards AS the deck, so the sync it
  triggers finds nothing missing and writes nothing — the path that matters for
  a new account was invisible to it. Worse, the shared mock answers every
  non-GET on `user_cards` with `200 []` and then goes on serving the same fixed
  deck, so an insert that never happened and one that silently failed looked
  identical. `lesson-sync` gives `user_cards` a real in-memory store (GET,
  upsert, delete) and asserts on what the student ends up with: every card of
  every lesson and nothing else; the impératif's cards each keyed and
  studiable, and every one of its note tabs rendering; a second visit writing
  nothing at all; and an existing deck keeping its own cards and their FSRS
  state, including a card whose front a lesson also ships.
- **Synced on load, once per mount.** A student finds every lesson in their
  deck without pressing anything. The lesson is the authority, so the sync also
  *retires* cards it no longer contains: that is how the eight abandoned "state
  the rule" cards were removed from decks that had already added them. Only
  writes when the deck and the lesson actually differ.
- **`lessonFilter` narrows the candidate pool** exactly as `typeFilter` does, so
  a lesson still schedules through FSRS rather than becoming a separate mode.
- **Notes live on the lesson** (`LESSON.notes`) and render in `LessonPanel`, a
  slide-over reusing the tutor's mount/enter mechanics, back on its first tab
  whenever it closes or the lesson changes. Distilled for glancing
  at mid-card, not for reading: tables for paradigms, two columns for
  contrasts, and the rules people get wrong called out on their own.

### Card-design rules the impératif module established

- **Every card is a thing to produce, never a rule to recite.** An early version
  had `impératif : -er et aller devant en / y` answered by `prennent un -s`.
  That is a statement, not a question, and there is nothing to type. Each rule
  is now carried by examples that make you apply it.
- **Every French-answered card carries an arrow in its front.** Load bearing:
  `classifyCard()` treats it as a conjugation drill, `answerLang()` reads it
  to know the typed answer should be French rather than English, and on a
  lesson card it is what gets the answer marked exactly.
- **The card wears its lesson as a badge, and the paradigm drills still name
  the mood.** `finir (impératif) → tu`, the same shape as the deck's own
  `aller (subjonctif) → ils/elles`. They used to rely on the badge alone, and
  `finir → tu` was reported as "not an imperative card" twice with the badge
  on screen: `finis` is also the présent, and a badge is context you glance
  past. The transformation cards (`Tu me dis → à l'impératif`) always named it.
- **A lesson card can be reworded without losing anyone's history.** Identity
  is a hash of the front, so the fifth element of a lesson card is the front it
  used to have, and that stays its identity. The sync rewrites the stored text
  on rows that still show the old wording, and leaves alone any the user edited.
- **Exercises are sampled, not transcribed.** Laura's ~150 items became 49
  cards. A worksheet's twenty pronominal verbs work because they are twenty in
  one sitting; as cards they would be twenty review streams for one rule. The
  test is whether an item teaches something no other card teaches.
- **Every section says what to type** (`LESSON.instructions`, one line per
  section; drills derive theirs). The line must never give the answer away:
  the adverb lesson's two gap sections use the same cue word for opposite
  answers (`cher → Ces chaussures coûtent ___` is cher, `cher → Une victoire
  ___ acquise` is chèrement), so their lines are word for word the same.
- **A lesson never writes over a student's own card.** Missing lesson cards
  are upserted on `(user_id, front)`, so a lesson front the deck already had
  would have become the lesson's card — new back and category, class dates
  gone. `reconcileLessons` now skips those (`taken`) and the student keeps
  theirs. Single-word fronts make it likely: the adverb lesson's false friends
  (`actuellement`) can be in any cahier deck.

### Adjectif ou adverbe ?

The second lesson (`src/data/lessons/adverbes.js`, 81 cards, five notes tabs),
written for the app rather than taken from Laura's sheets: adverbs from
adjectives, and the pairs English speakers mix up — relatif → relativement,
bon or bien, coûter cher but chèrement acquis, -amment or -emment, adjectives
with no -ment form, the -ment false friends, enfin or finalement. Drafted at
124 cards, checked by independent reviews (a native-teacher read, a dictionary
check against Larousse / Le Robert / CNRTL, a marking check, a curriculum
check, each finding re-checked by a skeptic), cut to 81 by the sampling rule,
and approved card by card by the owner.

Things in it that are deliberate:

- **The false friends are one-way** (`G` with no arrow: French shown, English
  typed). Both ways, the English side kept marking right French wrong — for
  "lately", *récemment* is as good as *dernièrement*, and this lesson teaches it.
- **Only three -ément cards.** The accent is the whole point of précisément,
  and accents are ignored everywhere so that English keyboards aren't marked
  down. The three kept are words worth knowing anyway; the rest are in the notes.
- **The gap cards never put the cue in parentheses.** `cleanFrenchPrompt`
  removes a parenthetical from the prompt when it repeats a word of the
  answer, and in `cher → … coûtent ___` the answer is the cue. Cue first, then
  the arrow, then the sentence.

---

## Progress, and the "mastered" relic

**Status: built on 2026-09-12**, as part of the serving strategy (see that
day's History entry). What was built differs from the design below in four
ways, and where they disagree, this paragraph wins:

- **The completion screen is a checkpoint after every block of 50**, not one
  end-of-session screen. See *The checkpoint* under *How a session is built*.
- **Since 2026-09-14 a word counts as remembered only both ways.** Each way
  round has its own schedule, and students never see the split — the owner's
  rule: a positive assessment means the student understands the word in French
  and in English. `rememberedChance` is the product of the two retrievabilities
  for a word or phrase (which errs low: the ways aren't independent, so the true
  chance lies between the product and the weaker way — low is the safer error),
  and the one retrievability for grammar and pronunciation. A word met one way
  only counts for nothing yet, so "remembered" lags "seen" for new words by at
  least a day. **Seen** is a card answered either way. For a few hours the same
  day it was two figures shown to students, "you'd understand" and "you could
  say"; the owner rejected both the split and the words ("say" read as
  speaking). Don't show students the directions.
- **The lesson top bar reads "about 43 of 108 remembered"**, with the "about"
  the wording rules below insist on.
- **The Stats page** (`data-stats-all`, `data-stats-areas`,
  `data-stats-coming-up`) has: Today and Right first time today, counted off
  each card's `last_review` — exact, because FSRS gets one answer per card per
  day; the streak; one three-band bar for the whole deck; *Your progress*, a
  row per lesson, then **Last two weeks of class** and **Older classes** — each
  with its dates beneath ("Classes since 31 August", "May 2025 to 30 August",
  from `areaDates`), because the line between them moves daily and a card changes
  group when its class turns two weeks old. They were "Your recent classes" and
  "Your earlier notes", which read as two kinds of thing when both are the same
  notebook; *Coming up*, which says
  how many cards came due today and, separately, how many older cards are
  still waiting from earlier days, then the cards due on each of the next
  seven days — every one of these counted per way round, so "Today" is
  answers, not cards; *By type* with seen / about remembered in place
  of "mastered", and "right last time" — of the cards seen, how many were right
  on their last answer, off the same FSRS rows — in place of the lifetime
  `card_progress` accuracy; Hardest cards, which adds up forgetting either way
  round; and Reset all progress, which since 2026-09-14 sets both directions'
  schedules on every card back to new (one update, `resetColumns()`) as well as
  clearing `card_progress` and the streak (`user_review_dates`, deleted with
  `.select()` so a delete row security refuses — success, nothing deleted — is
  reported rather than hidden) — before, it cleared only that legacy tally and
  every schedule survived. It leaves `card_reviews` alone. Its confirmation and
  messages never mention directions. Guarded by the `stats`
  suite, whose expected figures are counted from its own fixture.
- **No finish estimates.** See the open item.

The threshold is `SPOT_CHECK_MIN_STABILITY_DAYS` in `spacedRepetition.js`, and
`cardStage` is gone. The one "Mastered" left is a column in the admin-only
users table (`api/admin-users.js`), which counts `card_progress.score >= 3` —
a different, legacy measure no student sees.

### Where "mastered" came from

It is a **Leitner-era survivor**. In the box system (`7faa871`) there were five
boxes and **box 5 was mastered** — a real terminal state that changed
behaviour: a wrong answer reset you to box 1, "or box 2 if previously
mastered". When FSRS replaced the ladder (`7a7ad36`) the boxes went and the
word stayed, re-implemented as a threshold on a continuous variable
(`MASTERED_STABILITY_DAYS = 60`) purely to keep the spot-check bucket working.

So the number answers "which cards are safe to skip?" and is being read as
"which cards have I learned?". Nobody ever picked a threshold for the second
question.

It is also not an FSRS concept. FSRS's states are New, Learning, Review and
Relearning; there is no "mastered". And it is **irrelevant to scheduling** —
nothing about when you next see a card depends on it. It does exactly two
things: gates the spot-check pool, and prints a word on the Stats page.

**Decision: drop it as a learner-facing idea.** Reasons, in order of weight:
re-imposing a binary on a continuous variable throws away the thing FSRS
improved over Leitner; the threshold was chosen for a different question; and
it can be flatly wrong, because one stability covers both directions of a
card, so 60 days can be reached having only ever been asked the easy way.
Keep the threshold as an internal scheduling parameter under an honest name
(`SPOT_CHECK_MIN_STABILITY`) and stop showing the word.

Blast radius is small: `cardStage` feeds four places, all on the Stats page.

### The number FSRS actually offers: retrievability

FSRS models memory with **three** quantities. This app stores two of them and
never computes the third.

| | | |
|---|---|---|
| **Stability** | stored | days until recall decays to 90% |
| **Difficulty** | stored | how hard this card is for you |
| **Retrievability** | **never computed** | probability you would recall it *right now* |

Retrievability is derived, not stored — a function of stability and elapsed
time since the last review, so it changes continuously with nothing written.
`ts-fsrs` exposes it and it works on this app's card shape unchanged:
`scheduler.get_retrievability(toFsrsCard(card), now, false)`. Measured on
synthetic rows, it behaves as documented — stability 60 last seen 60 days ago
returns exactly 90.0%.

**Summed across a set of cards, retrievability is the expected number you
currently know.** "You know about 43 of the 108 impératif cards right now" —
not a bucket, not a threshold, the model's own estimate in cards. It is the
quantity FSRS optimises, and it is what the FSRS tooling ecosystem settled on
(Anki's FSRS add-ons graph it as "memorised").

**It decays.** Stop studying and the number falls, because that is what
happened to your memory. That is the honest behaviour and it is what makes the
number worth watching; it is also the one real design decision here, since a
figure that can go down puts some people off.

### The agreed design (built 2026-09-12 — see Status above for where it differs)

**Two numbers, because either alone lies.** "Seen 61 of 108" says nothing
about whether it stuck; "remember 43" says nothing about how much is left to
meet. Together they are true and useful: you have seen 61, and 43 are
currently in your head.

- **Seen** — cards shown at least once. Counts up, never down. This is the
  "have I worked through the material" question people actually ask.
- **Remembered** — Σ retrievability, rounded to whole cards. Goes up when you
  study, drifts down when you do not.

**Wording matters here and took two passes.** "Mastered" overclaimed;
"known"/"met" were the replacement and were also wrong — *met* is jargon, and
*known* only reads well inside a sentence, not as a label. **Seen** and
**remembered** are plain past participles, symmetric, and need no explanation.
The word **"about"** is load bearing and not optional: `about 43 remembered`,
never a bare `43`. It is an estimate and saying so is what stops this becoming
the next "mastered".

**One bar, three bands**, width = the lesson's card count:

| Band | Fill | Meaning |
|---|---|---|
| Remembered | solid | 43 |
| Seen but not currently remembered | light | 18 |
| Never seen | outline | 47 |

Labelled `61 seen · about 43 remembered · 108 cards`.

**Three places:**

1. **The lesson top bar, while studying** — one number only, since two compete
   in a cramped space: `43 of 108 remembered`. It must not move or animate,
   and it does **not** go on the card; nothing competes with the card.
2. **The completion screen**, replacing "Session complete!" — said as a
   sentence, which cannot be misread the way a one-word label can:

   > **Nothing more due in L'impératif right now.**
   > You've seen 61 of the 108 cards, and you'd remember about 43 of them
   > today — **3 more than when you started.**
   > Next cards due in about 6 hours.

   The delta is the reward and belongs only here.
3. **Stats**, the same three bands for the whole deck, replacing the
   "mastered" wording.

**Two deliberate choices.** Compute "remembered" when the lesson opens and
again at the end, NOT on every answer — a number recomputing per card jitters,
and jitter reads as noise rather than progress; the end-of-session delta is
the payoff. And let it go down: three weeks away should lower it, because that
is what happened to your memory. A bar that only rises is counting clicks.

**Cost:** both numbers come from rows already in the browser — one
`get_retrievability` call per card, no schema change, no new requests. "Next
cards due" is a `min()` over `next_due_at`.

**Also worth having, but blocked:** *true retention* — of the cards recently
asked, the fraction you got right. Measured rather than modelled, and the real
check on whether FSRS is calibrated for you. It exists per session as
`stats.got / stats.seen`; across sessions it needs the review log, kept since
2026-09-14 (`card_reviews`) and not yet read by anything.

Retrievability inherited the direction problem — one number per card covering
both FR→EN and EN→FR — until 2026-09-14, when each direction got its own state
and "remembered" became remembered both ways (see Status above).

---

## History

Newest last. Each entry is one session's work; the reference sections above
are the current state, so where the two touch the same thing, believe them and
read these for why.

### Up to PR #31 — FSRS, the tutor panel, and the first round of UI work

Merged (PR #27 and earlier): FSRS migration, tutor chat panel, browser-speech
TTS fallback, back-button restoration, sidebar alignment, the card fitting the
window, the answer banner showing your own answer, tap-to-continue, French
gloss stripping, and the multi-sense cleanup tool.

Merged since: the Grammar/Vocab/Phrases filter, the reflow moving only the
content column, the test suite, the card-crush fix, the grammar classifier, the
answer-lag fix and the smaller feedback panel (PRs #28, #29, #30).

Merged since that: one duration and one curve for every panel that moves the
page plus a real exit animation on the feedback sheet (0px drift between panel
and page on open, no frame covering more than 12% of the move); the card
holding one position through a flip and through grading, via the fixed-height
well beneath it; `container-type` moved off the rotating card onto its faces
(PR #31).

### 2026-09-08 — ten bugs found by driving the app

Bugs found by driving the app rather than by running the suite:

- **A flip-mode session had no end.** The completion notice was gated on
  `stats.seen > 0`, which counts *typed* answers only, so in the default mode
  you reached the last card and it sat there with "Got It" live — writing a
  fresh FSRS review on every click. 45 reviews landed on one card in a minute.
- **Study shortcuts reached the card through overlays.** Enter in the upload
  dialog, or after clicking anywhere inert in the tutor, graded the hidden card.
- **The typed-answer box asked for the wrong language.** `Type English…` on
  every conjugation drill, whose answer is French. Wrong for the whole
  impératif module and for every drill that predated it.
- **The card sat 118px above the middle of the window** at every height —
  arithmetic, not a rendering quirk. See the card-area notes above.
- **Reflow ran when there was nothing to reflow for.** Gated on "not a phone",
  so at 900px it still fired and left 184px of content column: chips stacked one
  per line, the card went portrait, the answer row ran off the edge. Now gated
  on `MIN_REFLOW_CONTENT` (680px), below which the panel is an overlay.
- **The nav kept the other layout's marker.** Wide marks on the right, narrow on
  top; React diffs styles per property, so crossing 768px left a stale border on
  every item. Every nav style now declares all four sides.
- **Two nav items marked at once.** Studying a lesson is still `mode === "study"`,
  so Cards and the lesson both lit up. `navActive()` gives it to the most
  specific selection, and Cards clears `lessonFilter`.
- **"Loading…" flashed on returning to a backgrounded tab.** Traced by recording
  every distinct screen after a reload. Two causes: `App` dropped to the sign-in
  screen for any null session, including the transient one a token refresh
  reports; and `useProgress` cleared `loaded` on every effect re-run, which
  unmounts the whole tree — the tutor panel and its conversation included.
- **20px of horizontal scroll on a phone.** Decorative blur circles bleeding out
  of `shellNarrow`, which clipped nothing.
- **`user_cards`, `user_review_dates` and `beta_feedback` were missing from
  `supabase/schema.sql`.** A fresh deploy following the README had no deck
  table.

#### The rule that keeps coming up

`loaded` gates the entire tree — `if (!loaded) return <div>Loading…</div>`
unmounts everything, including whatever panel you were using. A refetch for the
same person is a BACKGROUND refresh and must never clear it. Both `useUserDeck`
and `useProgress` now hold a `loadedForUser` ref for this. Both also cache to
localStorage so a fresh boot has something to paint; the deck cache opts out
above 2.5MB, since a deck in the thousands does not fit the quota.

### 2026-09-08 — the tutor: fast, specific, and safe to take cards from

The tutor, which was slow, generic, and hard to get a good card out of.

#### The latency was a default that changed underneath the file

`api/chat.js` passed no `thinking` and no `output_config`. That was written
when omitting `thinking` meant *no thinking*. On Opus 5 an omitted `thinking`
runs **adaptive**, and an omitted effort defaults to **`high`** — so every
two-word lookup was getting a maximum-depth reasoning pass from the most
expensive model, non-streamed, inside Vercel's default 10s function budget.
That is the whole of "the tutor is slow", and none of it was visible in the
code, only in what the code didn't say.

Now: `claude-sonnet-5`, `thinking: {type: "adaptive"}` stated explicitly, and
`output_config: {effort: "low"}`.

**Effort is a ceiling; adaptive thinking is the allocation underneath it.** At
effort `low` a lookup costs almost nothing and a nuance question still gets
more thought than the lookup did. That is per-question compute allocation
decided by something that has read the question — which is the reason there is
no model router here. Routing by question type has to decide before the answer
exists, and in French the difficulty isn't in the surface form: *si* is five
characters and one of the hardest words in the language, and "how do I say I
miss you" looks like translation right up until the inversion. A classifier
good enough to route those correctly would have to know French as well as the
model it was trying to avoid calling.

#### Everything else it needed

- **It streams.** SSE, one JSON event per `data:` line (`text` / `cards` /
  `done` / `error`). Failures *before* the stream opens still answer in JSON,
  so the client's existing error path survives. `maxDuration` is 60.
- **It knows what you're studying.** It used to be sent `deckFronts.slice(0, 60)`
  — sixty fronts by array position, no backs, no history. `src/lib/deckContext.js`
  now picks the cards that bear on the question (scored on shared content words,
  French side weighted double), the cards you recently got wrong, and the card
  on screen. All of it is a filter over an array already in browser memory.
- **`openChat(card)` takes an argument**, and a wrong typed answer offers "Ask
  the tutor" beside the dispute link — in the *same row*, because `belowCard` is
  a measured 170px well and a new line would move the card off its one position.
- **Proposed cards are editable before they are added.** This is what makes the
  cheaper model safe: card quality stops being load-bearing when correcting a
  front costs a keystroke. Fronts are also run through `cleanFrenchPrompt`.
- **A tutor card no longer stamps `dates: [today]`.** Those are the *lesson*
  dates a word appeared on; a card invented in a chat appeared on none, and the
  stamp made tutor cards outrank real ones in the frequency sort.
- **The system prompt stopped lecturing.** It used to require register, gender,
  an example sentence and a false-friend warning on *every* answer. A checklist
  cannot be proportional to the question, which is why a two-word lookup came
  back as five bullets. It is now cached (`cache_control` on the system block),
  which is also why per-request deck context goes in the **user turn**: caching
  is a prefix match, and the old code concatenated the deck onto the end of
  `SYSTEM_PROMPT`, which would have invalidated the cache on every turn.
- **Closing the panel aborts the request** instead of letting the answer land in
  a panel nobody is looking at.

#### Two bugs found by driving it, not by running the suite

- **Editing a card before adding it never showed as added.** `addCard` keyed the
  added-set on the *edited* front while the chip checked the *original*
  proposal, so the two never matched and you could add the same card
  repeatedly. The check now lives inside `ProposedCard`, against its own state.
- Writing the suite: `button:has-text("Send")` also matches **"Send feedback"**,
  which closed the tutor and opened the feedback sheet. `:text-is()` for both
  that and Add, since "Added" contains "Add" too.

#### The SDK, since it came up

The tutor's parameters — `output_config`, adaptive thinking, GA prompt caching
— all postdate `@anthropic-ai/sdk` 0.27.3, which this project was pinned to
when the work started. They reached the API anyway, because that SDK forwards
unknown body keys verbatim (verified by capturing the request it builds, not
assumed). Moot now: `main` bumped the SDK to **^0.124.0** in the same window,
so the parameters are supported rather than merely tolerated.

### 2026-09-08 — six more bugs, from reviewing the tutor branch

Found by a review pass over the whole branch, not by the tutor work itself.

- **Editing a lesson card destroyed it and its scheduling.** The sync
  reconciled by front text, so a corrected front read as "the lesson dropped
  this" — delete the row, re-insert the original, start from New. Identity is
  now a key hashed from the lesson's own front; see the Lessons section.
  `reconcileLessons` (`src/lib/lessonSync.js`) is pure and tested, including
  the case that motivated it. Legacy un-keyed rows matching nothing are now
  **left alone rather than deleted**: they are either a card the lesson retired
  or one the user corrected, and there is no way to tell, so the safe side wins
  and the sync logs them.
- **The keyboard graded the card behind the lesson panel.** `showLessonPanel`
  was missing from `overlayOpen`, so Space flipped and Enter graded a hidden
  card — a real FSRS review for something never seen. Exactly the failure the
  comment above that line documents; the lesson panel was added afterwards and
  never joined the list.
- **The score jumped backwards.** A cached copy counts as loaded, so the app is
  answerable while the real fetch runs. `setProgress(obj)` then overwrote the
  optimistic update with a snapshot taken before it. Local writes since mount
  are now merged over the server rows, and `resetAll` clears the cache — without
  that, a reload undid the reset.
- **A network blip blanked a painted deck.** The error path did `setCards([])`
  over a deck already on screen from cache, which then convinced the lesson sync
  the user owned none of their lesson cards.
- **Both caches survived sign-out.** `deck-cache:<id>` and `progress-cache:<id>`
  sat in localStorage with one person's whole vocabulary and score history.
  Cleared in `handleSignOut`, before the sign-out itself.
- **Dead code in `useUserDeck`** — an unreachable duplicate of the cache write,
  lacking the quota guard the live one has, kept quiet with an
  `eslint-disable no-unreachable`. Deleted.

### 2026-09-08 — the lesson notes, rebuilt from Laura's PDF

`LESSON.notes` was rebuilt from Laura's source PDF. The old distillation had
been cut past usefulness: rules with the examples removed, French specimens
with the captions removed, and two sections that stated no rule at all — tables
with nothing telling you what to do.

- **Sections are an ORDERED list of blocks** (`lead`, `sub`, `note`, `list`,
  `forms`, `pairs`, `table`). Her material interleaves — a rule, its examples, a
  caveat on those examples — which the old fixed note/table/pairs/lines order
  could not express.
- **One tab per section.** Section 3 is taller than the window; on one scroll
  the pronoun rules sat below the fold every time the panel opened.
- **Every example keeps its label, every rule keeps an example.** Her PDF
  captions each specimen block; stripping those left French floating with
  nothing saying what it was. This was the single biggest source of confusion
  in review, three separate times.

Three source errors are corrected rather than reproduced: `Vous lui donnez →
Donnez-lui` (her `Donne-lui` is the *tu* form); `Ne faites pas de bêtises !`
(missing its exclamation mark); and her "EXCEPTION" for `Dis-le-moi`, which is
not one — it obeys the same order as `Dis-le-lui`. It only looked exceptional
because she never states the order, deferring to a pronoun lesson this app does
not have. The panel gives the order instead.

Two sentences are **not hers** and carry rules her prose only implies through
its tables: how the imperative is formed, and `me`/`te` → `moi`/`toi`.

One claim of hers is dropped rather than corrected. She closes the `nous` block
with *"Cependant la première personne est très peu utilisée. La traduction la
plus commune pour « let's » + base verbale est « on » + présent de
l'indicatif."* The first half does not survive the module — `Allons-y !` is card
139, taught as a phrase worth memorising, and sits in her own by-heart list. The
form is unproductive, not rare. So the frequency ranking goes, and the
construction that sentence existed to introduce is shown instead: `On y va` /
`On en parle`, against the same two meanings as the table above. Her sentence is
recorded here if the ranking is ever wanted back.

Also: French spacing before `!` `?` `;` `:` and inside `« »` is applied at
display time as U+202F, so punctuation cannot wrap onto its own line; and lesson
titles render as written — the card badge and filter chip case-folded them,
which loses the name and mangles the accented capital.

#### The notes stay up while you work the card

Only the ✕ and the "Lesson notes" toggle close the panel. The outside-click
handler closed it the moment you clicked into the answer box, and Escape closed
it on the reflex of clearing a field mid-answer; the scrim still dims an
overlay-mode panel but no longer dismisses. That is what separates this panel
from the other two sharing the right-hand slot: the tutor and the feedback
sheet you open, use and put away, so an outside click meaning "done" is right
for them. Notes are reference material you keep beside the work.

Nothing was needed for the keyboard — `overlayOpen` already excluded the lesson
panel, so card shortcuts have always reached the card with it open.

#### A lesson gets its own top bar

The type filter is a whole-deck control that does not survive contact with a
lesson. Of the 108 impératif cards, **80 classify as grammar and 28 as phrase**,
so `Vocab` hands you an empty session and the other two collapse to "drills or
sentences". Hidden inside a lesson.

`enterLesson()` clears `typeFilter` on the way in. Without that, a `Grammar`
selection made on the wider deck goes on narrowing the session with nothing on
screen to say so and no control left to clear it.

The lesson name is a label now, not a button. It sat beside the "Lesson notes"
toggle as an identically shaped pill wearing an ×, so the two read as a pair of
switches when only one is. **Leaving a lesson is the Cards nav item** — the
regression check for the dead 460px strip used to click that ×, so it was
rewired to the surviving route.

Measured at 1400 / 1100 / 900 / 760 / 500 / 390: one row at every width, the
page never scrolls sideways, and the row scrolls internally when tight.

#### The direction toggle is next

`FR→EN / EN→FR / Mixed` steers 28 of the 108 cards — direction only applies to
`flippable` ones (cat vocab or expr), and 80 are grammar, pinned front-as-
written. Three chips, the widest group in the bar, governing a quarter of the
module, and meaningless on `finir → nous`.

### 2026-09-09 — the reflow, measured frame by frame

"The reflow is jerky" had been fixed by eye several times. Sampling geometry
every frame through a whole open and close, at nine window sizes and on both
axes, turned it into four separate measurable faults. The method is the point:
a before/after measurement sees none of them.

- **The chip rows wrapped.** Wrapping is a step — the top bar is 58px tall,
  then one chip no longer fits and it is 97px. A reflow crosses that threshold
  mid-animation, so the card area dropped 39px in a single frame, taking 39px
  of card height with it. `MIN_REFLOW_CONTENT` exists to prevent exactly this
  and cannot: it guards the column's FINAL width, and the wrap threshold is
  around 777px against its 680 floor. Both rows now scroll instead (`.chip-row`).
- **The feedback sheet hung off the right edge**, 256px of it at a 900px
  window, carrying its own Minimize and Close buttons with it — an outside
  click, which nothing advertises, was the only way out. `width: 100%` on a
  fixed element resolves against the viewport, not the left/right span.
- **The card's shape broke when the COLUMN was the tight axis** — 464x375 at an
  800px window, near enough a square. Long-standing, and invisible to a layout
  suite whose loop varied only the window height.
- **The card's speed changed mid-move.** Its size is the last thing to absorb a
  squeeze, queued behind cardArea's centring slack, cardWrap's slack above the
  card's cap, and `cardTopSpacer`. Each has a finite capacity, so each one
  running out changed the rate: 1.00px per px of page movement for four frames
  with the spacer pinned at 0, then 0.31 the instant it came off the floor.

Worth keeping from how these were found:

- **Measure the card against the PAGE.** Per frame, its movement divided by the
  page's: a smooth reflow is a flat line, a lurch is that share changing. Every
  metric that judged the card against itself lied in one direction or the
  other — a percentage of its own travel calls a 5px frame of an 8px resize
  "63% in one frame"; a pixel threshold loose enough for a legitimate 92px
  resize waves through a 12px jump in a 19px move.
- **Judge the EDGES, not the height.** Height is derived, and its rate can
  change with nothing visibly jumping — the top edge slows while the bottom
  carries on. Asserting on height reported lurches nobody could see.
- **A metric that passes is not automatically a good metric.** Each one here
  was run against the pre-session code before being trusted: the edge measure
  reads 3.0x at 1400x700 and 2.7x at 800x700 there, against 1.0-1.1x now, so it
  discriminates rather than merely agreeing.
- **Green suites are not coverage.** The squarish-card bug had been live for a
  long time with everything passing, and a change made partway through this
  session made it worse while the suite stayed green. The loop varied height
  and never width. It now varies both.

### 2026-09-09 — the lesson sync, and the fixture that hid it

Checking that L'impératif reaches a new account turned up no bug, but did turn
up why nobody could have known. The `lessons` suite serves the lesson's own
cards AS the deck, so the sync it triggers finds nothing missing and writes
nothing; and the shared mock answers every non-GET on `user_cards` with
`200 []` and then goes on serving the same fixed deck. An insert that never
happened and one that silently failed look identical from the outside. That is
also why the lesson panel's reflow twice went down as unmeasurable.

`lesson-sync` gives `user_cards` a real in-memory store — select, upsert on
(user_id, front), delete by id — and asserts on what the student is left with:
108 cards in an empty deck, each with the lesson's own answer and its source
key; the lesson in the nav with no add step, dealing a card from itself, all
four note sections rendering; a second visit writing NOTHING, so the FSRS
history survives; and an existing deck keeping its own cards and scheduling.

Verified by reading rather than by test, because a mock cannot: `user_cards`
carries `unique (user_id, front)`, which is what makes the upsert's
`onConflict` resolvable at all, and RLS grants the owner insert, update and
delete. The production build succeeds and all 108 fronts are in the bundle it
emits. The deployed site itself was NOT checked — the sandbox could not reach
it.

### 2026-09-10 — the tutor panel, and its stream

The panel worked and read as a prototype.

- **The composer is one row that grows.** It was two fixed rows against a
  button sized by its own padding, so the two controls stood at different
  heights and read as unrelated. Both are now exactly 41px and share their top
  and bottom edges — measured, not assumed.
- **The thread sits on the composer**, via `margin-top: auto` on the content
  rather than `justify-content` on the scroller: the latter makes an
  overflowing top unreachable in some browsers. The conversation used to be
  stranded at the top of a panel a thousand pixels tall, with the answer and
  the input box at opposite ends of it.
- **The intro paragraph is gone.** It explained what the suggestion chips
  underneath it were already demonstrating. Deleting it broke the `panels` and
  `session` suites, because `layoutProbe` identified the tutor by matching a
  line of that paragraph — the exact anti-pattern `tests/README.md` warns
  about. The panel now carries `data-tutor-panel` and the README lists every
  marker this app owns.
- **The card in view is a chip under the title**, set in the serif this app
  uses for card content everywhere else, rather than grey micro-copy. A first
  attempt labelled it `ON  la moitié`, which read as an on/off state.
- **Your own question is no longer set in the ink gradient** — the app's CTA
  treatment — which made the thing you already know louder than the answer you
  came for.

Then the stream itself: *"it pauses on a grey square, then the words come out
joltingly"* was two separate causes.

- **The pause is adaptive thinking.** The model reasons before it emits a
  token, and the answer bubble was inserted the moment you hit Send, so it sat
  there empty for a second or two. Three breathing dots show until the first
  character arrives: the same wait, reading as work rather than as a broken box.
- **The jolting was one `setState` per SSE delta.** Deltas arrive in uneven
  lumps — a fragment, then half a sentence — so the text landed in the shape
  the network delivered it in. Arrival and display are now decoupled: deltas go
  into a buffer and a `requestAnimationFrame` loop drains it, taking a tenth of
  the backlog each frame with a floor of two characters. A burst is caught up
  on rather than queued, a trickle still advances every frame, and the caret is
  withdrawn only once the buffer is empty — otherwise it vanishes with text
  still to come. Measured: a 208-character answer delivered as one lump is
  revealed over 30 frames, largest single step 22 characters. The `tutor` suite
  drives that case.

### 2026-09-11 — the panels stop dismissing themselves, and the scripts get callers

- **The tutor no longer closes on an outside click or on Escape**, bringing it
  in line with the lesson notes, which had been given that treatment the day
  before. See the UI layout note, which is where the reasoning lives.
- **Two pieces of working machinery got a caller.** The multi-sense cleanup and
  the dispute backlog both had a complete backend and no way to run it — which
  is why `les frais` is *still* in the deck as "the costs; the expenses;
  fresh". `scripts/fix-multi-sense.mjs` and `scripts/resolve-disputes.mjs` are
  those callers; see **Maintenance scripts**. `api/split-senses.js` now exports
  its prompt and tool schema so the script imports them rather than forking a
  second copy that drifts.
- **Found while writing the second script:** `supabase/schema.sql` and the
  admin view disagree about the shape of `feedback_submissions`. It is an open
  item rather than a fix, because there is no way to tell which of the two is
  stale without the live database.
- **Laura's frequency claim about the `nous` form came out of the notes** and
  the construction it existed to introduce went in instead. See the lesson-notes
  entry above.

### 2026-09-12 — this document, audited against the code

Every number and mechanism in the reference sections checked against what the
code actually does. Four claims had gone stale and are corrected above; the
tutor's click-swallowing note described an apparatus that no longer exists; the
multi-sense section still described a UI that was removed; the migrations list
named three of the seven files; and `scripts/` was not mentioned at all. The
document was also reordered into the three parts described at the top —
history entries used to sit on both sides of **Open items**, so three sessions'
work was hiding after what was supposed to be the last section.

What was wrong, for the record, since each one had been true when it was
written:

| Claim | Actually |
|---|---|
| `cardTopSpacer` shrinks at factor 8 | Factor 2. Eight was a step on the way and made the spacer bottom out mid-animation |
| `cardWrap`'s flex basis is `0 1 375px` | `0 1 min(375px, 62.5cqw)` — the card's own cap, so the wrapper cannot stand taller than the card |
| `cardWrap` is the `container-type: inline-size` container | `cardArea` is. An element cannot query itself |
| `cardArea` still declares a dead `padding-bottom` transition | Removed, along with the motion check that was pointed at it |

Six things in the app, with the cleanup that was asked for alongside the doc:

- **`classifyCard` memoises per card object.** The callers ask the same
  question about the same cards over and over — the Stats page classifies the
  whole deck once per type on *every render*, the Hardest Cards list three
  times per row, `buildSession` once per session. Measured on a
  production-size deck of 8,703 cards: 29.4ms per Stats render, every render.
  Now 22.7ms once and 0.5ms after. A `WeakMap` keyed on the card object is
  only safe because cards are never mutated in place — an edited card is a new
  object, so it gets a new answer — and that is written down beside the cache.
  Verified by classifying all 1,001 seed cards through both the old and new
  code: zero disagreements.
- **The dead `padding-bottom` transition is off `cardArea`**, and the motion
  suite's "one duration and one curve" check now measures the feedback sheet's
  `transform` against `main`'s `padding-bottom` — two things that actually
  move — instead of a declaration on a property pinned at 0.
- **One name for the panel clock.** `PANEL_ANIM_MS` / `PANEL_EASING` from
  `lib/motion`, everywhere. `ChatPanel` re-exported them as `CHAT_ANIM_MS` /
  `CHAT_EASING` and `FlashcardApp` drove the page's own reflow through that
  alias, which made the page's timing look like the chat's business.
- **A rejected Anthropic key now offers the dialog.** The client had a
  `BAD_KEY` constant matching a code the server really does send, imported
  nowhere: `byok_required` got a "Connect Claude account" button and
  `bad_key` — the case where the user most needs to replace a key — got the
  error text and no way out. Both offer it now, with the wording the situation
  calls for.
- **`countByType` is gone.** No callers, and never going to have one: the
  Stats panel needs accuracy and stage counts per type, not a bare tally.
- **The test runner's comment named two of the four browserless suites.**

`npm test` green before and after, 15 suites. Nothing about the app's
behaviour changed except the rejected-key button.

#### The dispute view was dead, and dead silently

Settled the same day by querying the live table, which is the only thing that
could settle it. `feedback_submissions` has **`status`** and **`reviewed_at`**,
exactly as `supabase/schema.sql` declares. It has never had `reviewed` or
`action`. So the schema file was right and the app was wrong — the opposite of
a stale schema, which is what a mismatch like this usually is.

`FeedbackAdminView` was broken in five places, all against columns that do not
exist:

| It did | The table has |
|---|---|
| filtered `reviewed = false` | `status = 'pending'` |
| wrote `reviewed` + `action` on approve | `status` + `reviewed_at` |
| wrote `reviewed` + `action` on reject | same |
| rendered `item.french` / `item.english` | `card_front` / `card_back` |
| rendered `item.expected_answer` | the other side of the card |

**Why it survived so long is the lesson, not the column names.** The failing
query's error went to `console.error`, the catch set the list to `[]`, and an
empty list is indistinguishable from "no disputes waiting". Approve and reject
failed the same quiet way. So the backlog this document describes as one
"nobody has looked at" was a backlog nobody *could* look at: the screen said
there was nothing there. The view now renders the failure instead of
collapsing it into the empty state.

Nothing has inserted into `feedback_submissions` since `/api/review-answer`
took over — it decides and writes `card_alternates` on the spot — so what the
repaired view reads is purely the historical backlog, which is what
`scripts/resolve-disputes.mjs` exists to work through. That script was never
broken: it reads the shape off a real row and refuses to PATCH columns it has
not seen, which is exactly the check the admin view lacked.

### 2026-09-12 — how cards are served: the agreed strategy, and stage 1

A long design discussion with the owner settled how a student works through
the app. **All seven stages below were built the same day**, except the finish
estimates in stage 6 (see Open items). The reference sections *How a session
is built* and *Progress, and the "mastered" relic* describe the result; this
entry keeps the reasoning, and what the owner rejected along the way.

**What FSRS does and doesn't decide.** FSRS decides when a card the student has
already seen comes back. It has no opinion on grouping, session length, or which
new card comes next. Those are the app's choices, and this is what they are now.

**Blocks of 50.** There is no Study button: logging in is studying. The app
deals a block of up to 50 cards, then a checkpoint screen replaces "Session
complete!". It shows how the block went, what moved in seen and remembered for
each area the block touched, and a Continue button that deals the next block.
The student can always keep going.

**What goes in a block, in order.**
1. Cards missed last time that are due.
2. Other due cards, most overdue first. Due means due any time today, on the
   student's own clock, so the day's work doesn't grow while they study.
3. New cards, **only once the due cards run out**. This reverses the old rule
   of reserving new-card slots ahead of due work. A student who isn't keeping
   up with reviews should not get new cards on top. A student who learns a lot
   of new cards in one day gets a few review-heavy days afterwards, then new
   cards come back. No daily new-card number, no forecast, no time setting;
   the owner rejected all three.
4. Two or three spot checks.

The block is then shuffled, as now.

**Where new cards come from.**
- Inside a lesson: that lesson only, due and new, new cards in the lesson's own
  order. The next new card is the next unseen one in the lesson, however long
  the student was away. Due cards from elsewhere wait and come first on
  return to normal study, and the checkpoint says how many are waiting.
- Normal study: recent notes first, meaning classes in the last 14 days, newest
  class first. Then earlier notes, most classes first (`dates.length`), older
  class first on a tie. Tutor chat cards count as recent, dated by the day they
  were added (`user_cards.created_at`).
- The Grammar / Vocab / Phrases filter narrows a block the same way a lesson
  does.
- A lesson card, once seen, also comes back in normal study when due.

Hand-built topic categories were proposed and rejected by the owner, as were
fixed sets of 100. The class dates are human-made structure and need no
judgement.

**Review phase.** When the next block will be reviews only, the checkpoint says
so ("You're in a review phase: 140 cards due, new cards come back once those are
done"). The only real end is nothing due and nothing unseen.

**Progress.** Seen, about N remembered (Σ retrievability) and not yet seen, as
already agreed, now per lesson, recent classes and earlier notes. The lesson
top bar shows "43 of 108 remembered" inside a lesson, updating at checkpoints
only. Stats: "This session" becomes "Today" and "Right first time today"; the
streak stays; the new / learning / mastered bar becomes seen / remembered /
not yet seen; a new "Your progress" section with a row per lesson, recent
classes and earlier notes, each with a finish estimate; a new "Coming up" chart
of cards due on each of the next seven days; "By type" keeps accuracy and drops
"mastered"; Hardest cards and Reset stay.

**Build order.**
1. One FSRS answer per card per day. **Built** — see the note under *How a
   session is built*. Guarded by `dates` (the day rule under a pinned timezone)
   and `session` (miss a card, answer its retry, step back and answer again:
   one PATCH per card).
2. The block builder in `sessionQueue.js`: 50, due-then-new, the new-card
   order. **Built** — see *How a session is built*.
3. One progress calculation (seen / about remembered / not yet seen, grouped),
   shared by the checkpoint, the lesson bar and Stats. **Built** —
   `src/lib/progress.js`, guarded by the `progress` suite. About 5ms over an
   8,700-card deck.
4. The checkpoint screen and the "Card 12 of 50" counter. **Built** — see
   *The checkpoint* under *How a session is built*.
5. The lesson top bar. **Built** — `data-lesson-progress`, "about 43 of 108
   remembered", read when a block is dealt and at its checkpoint.
6. The Stats page. **Built**, without finish estimates — see *Progress, and
   the "mastered" relic* and the open item.
7. Tidy-up: drop "mastered" everywhere, remove the dead `freqOnly` filter (no
   control has ever set it), bring this document's reference sections in line.
   **Done.**

No database change is needed for any of it.

**What was verified, and what wasn't.** Every stage went to `main` after the
full suite, run on the owner's Mac (15 of 18, the three failures being the
Mac baseline above). The checkpoint and the Stats page were screenshotted at
1400px and 390px wide, which caught two faults before they shipped: By type
saying "none studied yet" beside a bar of seen cards, and the Stats legend
breaking into ragged columns on a phone. The live bundle was fetched and
confirmed to be the new code. The `created_at` column was confirmed on the
live table, read-only, before the deck loader asked for it.

**Not verified: the live app, signed in, on a real deck.** Signing in needs
the owner's magic link. And testing on the owner's account is not free: every
answer is a real FSRS review, and reaching a checkpoint means answering 50
cards. The options put to the owner were to look without answering (first
block, Stats, the lesson bar) and watch one real block, or to use a throwaway
account the owner creates. See the open item.

**Two bugs found while building, not by the plan:**
- **Entering a lesson could start the block at card 35 of 50.** A full rebuild
  kept the card on screen by jumping to its position in the new shuffled
  block, skipping everything before it. Found because the lesson bar test read
  "about 23" after what should have been a block of 50.
- **A retry, and Previous card, recorded a second FSRS review** — stage 1's
  reason for existing, measured against the scheduler before it was fixed.

### 2026-09-12 — the feedback backlog

All twelve `beta_feedback` entries worked through, each checked for whether
it was one card or a pattern. Read with the service role key from
`.env.local`, owner's deck only (3,927 cards). Work done in the local copy,
per the new first rule of **Working protocol**.

| Feedback | Cause | Fix |
|---|---|---|
| `un sujet, une question` — two cards | Already split in the deck | None needed |
| `les frais`, `planter` — two cards | Unrelated senses on one card | Card data (below) |
| `il neige / il neigeait` — two cards | Two forms joined by ` / ` | Card data; parser rule 10b |
| `Ne me dis pas ça.` — no periods | Lesson and ~50 cahier cards end in a stop | `dropFinalPeriod`; parser rule 10e |
| `seul (only; sole)` — problematic | Matcher split inside the gloss | Matcher fix, 64 cards |
| `finir → tu`, `avoir → vous` — not imperative | Front never named the mood | 27 lesson fronts reworded, history kept |
| `la glycine` — a mistake | It is correct: *glycine* is wisteria | None |
| `je sais que peux m'ennuyer` — ungrammatical | Transcription dropped `je` | Card data; parser rule 10d |
| `pp de devoir : dû` — grammar, not vocab | Answer on the front; `pp` not a grammar term | `pp` in `GRAMMAR_TERM`; card data; parser rule 10c |
| `réélire` — participle is a hint | Form note on the English prompt | `cleanEnglishPrompt`; card data |

**Card data, applied with the owner's go-ahead**, owner's deck only: 36 rows
rewritten in place, so each keeps its FSRS history (11 multi-sense cards
reduced to their first sense, 11 slash pairs to one form, 12 participle drills
to `verbe → participe passé` with the participle as the answer, plus
`réélire` and a wrong `ça va` → "it was okay"), and 16 new cards for the
second halves, starting as New. A split's second half takes a disambiguating
tag on its front (`planter (fam)`, `la mousse (plante)`) because
`(user_id, front)` is unique. Where the second half already existed as its
own card, no new card was made. Fourteen rows turned out to repeat a card
that already exists (`il neige / il neigeait` beside `il neige` and
`il neigeait`; the uncorrected `je sais que peux m'ennuyer` beside the
correct one), and the owner deleted them from the SQL editor. Deck: 3,927
cards before, 3,929 after, and a check against the pre-change snapshot found
exactly those fourteen rows gone and nothing else.

**Archiving, added the same day.** A card can now be taken out of circulation
without deleting it: `source` gains an `archived:` prefix
(`archived:cahier-upload`) and `useUserDeck` drops those rows, so the card is
not studied, listed or counted. `src/lib/archive.js` owns the prefix. No
migration, and clearing the archive later is one line:
`delete from user_cards where source like 'archived:%';`. The row keeps its
`(user_id, front)` slot, so adding a card with that front again — tutor or
lesson sync — upserts onto it and brings it back. There is no archive button
yet; rows are archived from a script or the SQL editor.

**Clearing feedback, added the same day.** The owner's rule: the feedback
list is cleared once the changes are made. `beta_feedback` had no state, so
the only way off the list was deletion. `migration_009` adds `resolved_at`
and `resolution`; both admin views now list only open entries;
`scripts/resolve-feedback.mjs` resolves from a terminal with a note. It is
now a step in *Working protocol*.

**The feedback log became read-only, and was redesigned.** A first version had
"Mark resolved" beside Delete and Edit card. The owner pointed out none of them
is theirs to press: feedback goes through a Claude session, which fixes it and
resolves it. So the entry is information only, mocked up three times with the
owner before it was built:

- the message as the headline (17px), then sender and time to the minute
- the attached card as two lines — type and which side was shown, then front
  and back at 16px, above the 14px of buttons elsewhere in the app
- a screenshot thumbnail beside the card, **always the card's height** — the
  image is absolutely positioned so it can never set the row's height (it did,
  at first, leaving the card box 102px tall around 64px of text)
- click the thumbnail for the full screenshot; Escape or a click closes it and
  leaves the log open, which needs `stopPropagation` because a portal's clicks
  still bubble through the React tree to the log's own overlay — shown at most 560×420, not fitted to the window: a retina screenshot
  filled the whole screen, bigger than the app it was taken from, and a first
  cap of 820×640 looked no different on a laptop
- the scrolling list has 4px of side padding (cancelled by a negative margin)
  so the thumbnail's focus ring isn't clipped: Escape returns focus to the
  thumbnail, and the list cut its ring off down the right side, which looked
  like a white bar through the image

Entries are **numbered 1, 2, 3 down the open list, newest first** — the owner's
choice, so the numbers count what is still waiting and nothing else. That is
the number quoted to a Claude session ("fix feedback 2"), and
`scripts/resolve-feedback.mjs` lists open feedback with the same numbers in
the same order, beside each entry's id. The numbers are positions and shift
as entries arrive or are resolved; resolve by id, after checking the message
matches.

`FeedbackEntry` is shared by both views and carries `data-feedback-entry`,
`data-feedback-card`, `data-feedback-thumb` and `data-feedback-lightbox`.
Measured in headless Chromium with a scratch admin build and routed sample
rows, at 1400px and 390px: card and thumbnail both 64px with the same top,
every entry's left edge identical, no horizontal overflow. There is still no
suite for it, for the `VITE_ADMIN_EMAIL` reason above. No browser
suite covers the admin views — the runner does not set `VITE_ADMIN_EMAIL`, and
setting it would draw admin menu items under every other suite — so it was
checked against the live table instead.

The owner ran migration_009 and the script then resolved all twelve entries,
each with a note saying what was done (#21 and #28 needed no change and say
why). A thirteenth, #33 "test", arrived during the session from the feedback
panel work and was left open: resolving is for what has been dealt with.

**How this was carried out, since it will happen again.** The work was done in a
session worktree and moved into the local copy by fast-forward. Mid-session a
second session committed and pushed five commits to `main` from the local
copy, so the fast-forward was refused (it had uncommitted edits to
`FlashcardApp.jsx`) and the feedback commit was rebased onto its work
instead. Only this document conflicted. Two sessions on one checkout is
survivable because git refuses to overwrite; check `git status` in the local
copy before moving anything into it.

Tests, run on the Mac as *Working protocol* describes: 17 of 18 suites green
after rebasing onto the block and progress work. `layout` failed its "card
does not move when graded" check (264 → 259px), and failed it identically on
the unchanged code. One `reflow` run timed out loading the page and passed on
a re-run.

### 2026-09-12 — the feedback panel: into the sidebar, and closing keeps the draft

Reported: send feedback, click outside, get asked "Discard your feedback?",
and afterwards be unable to tell — short of opening View feedback — whether
anything had been deleted. Nothing ever had been. After a successful insert the
sheet stayed up for 1.5s with a "Thanks!" banner and **the sent text still in
the field**; `handleCloseClick` only exempted `submitting`, so an outside click
in that window read the sent text as a draft and prompted. OK closed the sheet;
Cancel kept it, and then the 1.5s timer closed it anyway. The prompt was a
question with no real answer. The same uncancelled timer could also wipe and
close a draft started within 1.5s of reopening. Separately, "doesn't reflow
well": the page tracked the sheet's height through a `ResizeObserver`, so every
second line typed, a screenshot preview, a banner and Minimize each moved the
card.

Rethought from the lifecycle — draft → sending → sent or failed — against NN/g
(confirmation dialogs; cancel vs close, "when in doubt, save"), the WAI-ARIA
dialog pattern and MDN's popover light-dismiss (Escape closes, focus returns to
the invoker), WCAG 4.1.3 status messages, Vercel Geist's feedback component,
and GOV.UK and Smashing on disabled buttons. Closing never destroys; sending is
the only thing that clears; the outcome is announced; Minimize goes; Escape
closes (the open item had deferred it only because closing went through the
prompt); Send stays enabled and validates on click; ⌘/Ctrl+Enter sends.

**Placement took three passes, and the owner's rule settled it: nothing may
cover the card.** A popover anchored above the link was mocked and rejected — at
narrower windows it reached the card. Keeping the bottom sheet (made narrower,
page making room once) was agreed, then replaced on second thought with the
panel inside the sidebar: it covers nothing, moves nothing, and sits beside the
link that opens it. The cost is width — ~223px, so the field starts at three
lines and the chips stack — and a very short window scrolls the sidebar. The
flag on the card was added in the same pass, so card feedback starts at the card.

Not done: a sentiment row (Vercel, Stripe) — a one-learner beta and a free-text
note is the whole signal; auto-attaching route or viewport — nothing reads it.

Tests. `panels` gained the reported sequence (send, click away at once: no
dialog, one row, toast, empty on reopen), draft survival across every close
including the link's own toggle, the panel's geometry (in the sidebar, below
Tutor, above the account, never over the card, the card unmoved), too-short and
failed sends, and the flag (opens with the card attached, doesn't flip or grade).
`layout` now asserts the panel moves nothing at five heights and on Stats.
`motion` asserts the page holds still on every frame of the open and close and
that the panel fades — read from the running transition, not a frame count, as
this Mac's headless Chrome delivered five frames in 600ms. The page-and-panel
clock check moved to the tutor, and `reflow`'s card-animation loop moved to the
tutor too, since feedback no longer reflows anything.

Full suite on the Mac: 16 of 18. The two failures are the Mac baseline exactly
(`layout` type-mode 264 → 259, `reflow` "the tutor reflow actually ran" 0px);
`motion`, the third baseline failure, now passes because its feedback checks no
longer count frames.

Pushed as `a2de7e2`. Then four rounds of refinement on the live panel, each
pushed and confirmed in the deployed bundle:

- **`1afe607` — streamlined to three rows.** Five stacked rows with an icon on
  its own read as clumsy. Asked for a paperclip next to Send and proper
  alignment, and for a real mockup first: one action row, two shared edges,
  the screenshot inside the message box. The intermediate steps — taller field,
  smaller title and buttons, the "⌘↵" hint removed, "About: …" turned into a
  checkbox, an image icon beside Send — went out folded into this commit.
- **`50c4152` — the message box back up to 180px.** The mockup had set the box
  to 112px, below the height the owner had just asked for, and the build
  followed the mockup without saying the height had gone down. The lesson is
  the obvious one: an explicit ask carries forward through a redesign, and a
  change that reverses one gets called out, not shipped quietly.
- **`7ed3482` — any note is sendable.** The owner typed "test", attached a
  screenshot, and was told to write a few words. The minimum was invented, not
  asked for; it is gone, and an empty send is flagged on the box.

How this session went is worth recording too, because it cost the owner real
patience. The first request was for a strategy and got code; being told so, the
code was stashed without being asked, which was also wrong, and then restored.
Reading "provide the fix" as "build it" and "you did something I didn't ask
for" as "undo it" were both guesses at intent where a question was cheap. The
rule the owner stated: do what is asked, and when it isn't clear whether that
means plan or build, ask.

### 2026-09-12 — the tutor, audited: nineteen fixes

Asked to evaluate the tutor and list everything worth fixing, then to fix all
of it. Found by reading the code, not by driving the live app. Five of the
nineteen corrupted study data or gave answers away, and those are the ones
worth remembering:

- **The panel header showed the answer.** It always printed the French front,
  so on an English-prompt card the answer sat in the header — and, since the
  header follows the session, every next card's answer too. It now shows what
  the card asks (`cardPrompt` in `lib/deckContext.js`, the same cleaning the
  card face uses), with the answer appended only once the card has shown it.
- **The tutor could hand over an unanswered card, and FSRS then recorded a
  recall.** It was sent front and back with no sign of whether the student had
  answered. `tutorCard` in `FlashcardApp` now carries `answered` (sticky for
  that appearance of the card, keyed on queue position and row), and after a
  typed answer `typed` and `result`. The prompt forbids giving an unanswered
  card's answer even when asked, and the card is kept out of the related list
  while unanswered, since that list would give it away.
- **"They just got this wrong" was usually false.** It was read off
  `last_answer_correct`, which is last session's result, and lapse cards come
  first in every block. It now comes from this attempt; the row's result is
  sent separately as "missed it last time".
- **"Ask the tutor" after a miss never sent what was typed.** It does now, with
  the verdict.
- **Add silently overwrote an existing card.** It upserted on `(user_id,
  front)`: the notebook's gloss replaced, `source` set to `tutor-chat` (which
  re-dates the card in `sessionQueue`), a lesson card stripped of its lesson
  tag until the next sync. The chip now checks the deck in the browser,
  ignoring case, and says "Already in your deck as …" with a Replace that
  changes only the back through `/api/admin-update-card`. New cards are
  inserted; only a unique-key conflict falls through to the upsert, because
  that is an archived card coming back.

The rest, briefly. Earlier turns go back with the card they were asked about
and the cards they proposed, as bracketed notes built server-side, so a
follow-up keeps its subject. Card rules the impératif module established are
now in the prompt and enforced in `normalizeCards`: grammar cards must be arrow
drills with a French answer, pronunciation cards are gone. Misses are sent only
when recent (30 days) and sharing a word with the question. Deck matching
folds accents, splits elision, treats `œ`/`æ` as letters and falls back to the
previous question. A stream that ends without `done` reads as cut off;
`max_tokens` and refusal are reported; raw API errors stay in the log. Add
inserts the returned row into the deck (`add` in `useUserDeck`) instead of
refetching thousands. The panel gained New chat (and a fresh thread when opened
from a different card), card-aware suggestions, rendered bold and italics,
focus that stays in the box, a screen-reader announcement, and a thread that
lives in `lib/tutorThreads.js` so the onboarding-to-app swap no longer wipes it;
sign-out clears it.

**The cache open item is settled by the docs, and fixed.** Sonnet 5's minimum
cacheable prefix is 1,024 tokens and the system prompt plus tool schema were
about 900, so the breakpoint cached nothing. A second breakpoint now sits on
the turn before the latest question — the latest carries this turn's
`[Context]`, which is gone from it by the next request — and the window trims
ten turns at a time so the prefix doesn't shift every turn.

**Found by the suite, not by reading:** clicking Send moved focus to a button
that then disabled, dropping focus to the page; the screen-reader region kept
the old answer after New chat, and read `**` aloud; and the first version of
the keyboard fix listened for `pointerdown` only, which `session` caught with a
synthetic click writing three stray reviews.

Tests: `logic` gained matching, misses, context and request-building checks;
`tutor` gained the header on an English-prompt card, unanswered context, Replace
instead of Add, no refetch on Add, earlier turns' notes, focus, New chat, bold,
the keys beside the panel, and a cut-off stream. Full run on the Mac: 16 of 18,
`layout` the baseline and `session` the failure above; after the fix `session`,
`tutor`, `panels` and `logic` all pass. `reflow` passed on this run.

### 2026-09-13 — below the card, aligned

The feedback log's full-size screenshot filled the window; capped at 820×640
it looked unchanged on a laptop, so it is 560×420 now. Its thumbnail's focus
ring, handed back when Escape closes the lightbox, was clipped down the right
by the scrolling list and read as a white bar through the image.

Then the graded typed-answer state, mocked at real size first and adjusted
twice with the owner — Continue keeps its own size rather than filling the
column, and is centred rather than right-aligned; "Correct!" is green. The
owner asked whether to keep "Ask the tutor": kept, because it opens the tutor
already carrying the card, the typed answer and the verdict, and shares the
dispute link's row, so it costs no height. The flag was explained, not changed
beyond its size.

`cards`, `session`, `layout`, `regressions`, `panels` and `types` pass on the
Mac — `layout` in full for the first time on this machine (see the baseline
note). Measured in the app: banner, links and column 420px on the same edges,
Continue centred on the column's centre, the card top unmoved through wrong,
correct and close answers, pencil and flag centred on the same x.

---

### 2026-09-14 — the sidebar minimizes

A button at the top of the sidebar minimizes it to a rail of icons, as mocked
up with the owner; see the UI layout note. The one design question settled
first: "Send feedback" opens a panel inside the sidebar, so from the rail it
widens the sidebar for as long as the panel is open. Measured at 1400px:
256px → 64px, main starts at 64, one nav item marked, feedback icon centred
under the avatar, the account menu fully clickable past the rail, the choice
surviving a reload. New suite `sidebar`, 19 in all.

### 2026-09-14 — the first real blocks: retries past the end, and the FSRS switch's pile

The owner studied on the live app and found the flow "not working", with a
screenshot reading **Retry 1 of 21**. Two causes, neither covered by the
strategy agreed on 2026-09-12, both found by reading the live data before
changing anything.

**Retries ran past the block.** A missed card was re-queued 20 cards later, and
with blocks of 50 every miss after card 30 was appended after card 50. The
owner's block had 21 misses, so it ran to 71 cards with the checkpoint at the
end. The strategy said "a block of 50" and never said what a retry does to
that. Now a block is 50 answers, retries included — see *How a session is
built*. The checkpoint says "50 answers" rather than "50 cards".

**708 cards "due today", 582 of them stamped by the FSRS switch.**
`migration_007` gave every card answered under the box system a guessed state
(stability from its box, mostly 1 day) and made all of them due at the instant
it ran, 2026-09-05 04:19 UTC. Nine days on, none had been answered, FSRS put
recall at about 69%, and the owner was missing around 40%. Under "due first,
new only when due runs out" that meant about fourteen blocks of them before a
single new card. The owner's question was the right one — "I can't possibly
have 700+ cards due in a single day" — because "due" had been counted as one
number: cards whose date is today, and everything left over from earlier days.

Two fixes. **The data:** `scripts/reset-fsrs-seed.mjs` reset those cards to not
yet seen on every deck, with the owner's go-ahead for all decks — 1,200 cards
across 8 decks, 581 on the owner's (one had been answered since the count), 516
on one other. Identified by exact `next_due_at` and the migration's own
`last_review` arithmetic, backed up whole to `backups/` first; a second run
finds none. The owner's deck went from 708 due to 30 due today and 90 older.
They come back through the new-card order, which is honest: the state was a
guess and the cards were not remembered. **The wording:** the checkpoint's
review-phase message and the Stats page's *Coming up* now give "due today" and
"older cards still waiting from earlier days" separately.

Tests: `serving` gains the retry placement rules (including 21 misses in a
block of 50 staying 50); `regressions` replaces the old retry-counter check
with "the checkpoint comes after exactly the block's length in answers, and no
counter reads Retry"; `session` checks a missed card's retry is the block's
last answer with one card displaced and no extra write; `stats` checks today's
and older due cards are counted apart. Full suite on the Mac: 18 of 19, the one
failure `reflow`, which fails two runs in three on unchanged `main` too.

**Checked against the owner's real deck, not just the mock.** A read-only
snapshot of the owner's 3,929 cards (and `card_progress`) was served to the app
locally, every write answered in the browser and recorded, nothing sent to
Supabase. A block missing every third card ended at exactly 50 answers, 15 of
them retries shown inside it, no "Retry N of M", 35 cards recorded once each;
Continue dealt a fresh 50. Every Stats figure was then recounted independently
from the snapshot plus those 35 writes and matched: 82 answered today, 57 right;
237 seen, 3,692 not yet seen; due today and older waiting; each of the next
seven days; L'impératif 43 of 108 seen. Stepping `buildSession` forward on the
same data: the next block is 50 reviews, the one after is 35 reviews and 15
new, then all new, led by words from recent classes and the most classes.

**Found by that check:** *By type* still read accuracy off the lifetime
`card_progress` tally — 58% / 55% / 51%, including old answers on cards now
reset — beside "right first time today 70%". It now reads "right last time"
from the FSRS rows (88% / 89% / 82% on that data, matching an independent
count). `stats` checks it.

Not verified: the live app, signed in, after the fix. See the open item.

### 2026-09-14 — flipping versus typing, and the study flow's exception paths

The owner asked how the two ways of answering should work, and then how a
student going back and forth between them is handled. It wasn't: switching
modes reset the card, so an answer already seen could be given again the other
way. Fixed — see *Flipping and typing*.

Then every exception path in a study session was driven in the app against the
mock, judged by what was written to FSRS rather than what the screen showed.
The findings are open items below, not fixes; the owner was asked which to
take:

- Flip mode grades a card that was never turned (Got It showing, and
  ArrowRight / Enter recording a hit, before the flip).
- An accepted "my answer should be accepted" dispute is still recorded as a
  miss when Continue is pressed.
- Correcting a mistaken grade with Previous card records nothing, because the
  day's answer is already in.
- Tapping the card, or pressing Escape, with an answer typed but not checked
  throws the typed answer away and records a miss.
- A save that fails says nothing on screen.
- Changing direction or the type filter mid-block deals a new block and loses
  the block's running count.

**All seven then fixed the same day**, with the owner's go-ahead, plus
remembering the mode and typing as the default — see *Flipping and typing*.
The new `answering` suite judges each by the writes: an accepted dispute
records a hit; Got It → Previous card → Again records the correction,
recomputed from the prior state (sooner due date, same reps); Escape clears
and records nothing, a tap checks what was typed; a 503 shows the notice and
the retry saves once the server is back; direction keeps the block's count; a
new student opens typing and a chosen flip survives a reload. `session` checks
an unturned card is turned, not graded, by the first key. Tests that answered
with one key press now use two.

One found along the way: after a reload the first block is dealt from the deck
saved in the browser, so cards added or due since that save wait for the next
block. `cards` had relied on a direction change to rebuild; it now clears the
saved deck.

The owner also had the checkpoint's review-phase paragraph removed, and the
full stop after "right first time". Stats' *Coming up* still separates due
today from older cards.

---

### 2026-09-14 — each way round its own schedule, and every answer kept

**What was wrong.** A word or phrase card is asked either way round — "une
colline → ?" and "a hill → ?" — and both answers fed one FSRS state. They are
different skills, and which is harder differs per student and per card, so a
word easy to recognise was pushed weeks out while it still couldn't be
produced, and in Mixed mode the grade depended on a coin toss. Only the current
state was stored, never the answers, so nobody could say which way any past
answer had been. And "Reset all progress" cleared only the legacy
`card_progress` tally: every schedule survived it.

**How the plan changed on review.** A brief for this was written earlier the
same day. Checked against the code with the owner before building, five things
changed. English → French was gated on having seen the word in French; the
owner rejected any gate ("you don't know which way is harder for the
student"). The direction filter as written would have dropped every grammar
card from EN→FR mode; one-way cards now come up in every setting. Changing
direction mid-block could no longer relabel cards, so it re-deals the rest of
the block. The brief's list of places that told entries apart by card alone
missed one, the card kept on screen across a new block; everything now keys on
card and direction (`itemKey`). And the fallback select for a deploy that beat
the migration only half protected — the deck loads, then every English-side
answer fails to save forever — so it was dropped for a read-only check that
the migration ran before pushing. Two additions, both agreed: a word's two
*first* meetings are kept apart (the second waits for a later day, and a block
never deals both), and every answer is kept (`card_reviews`). The owner also
confirmed Reset should reset both ways, and chose to reset their own progress
with the button once this is live, rather than keep the 177 words answered so
far as French-side history.

**What was built.** migration_010 (`en_` columns, `card_reviews`), dry-run
twice on a local Postgres with the Leitner and FSRS columns in place.
`src/lib/directions.js` is the one mapping from a direction to its columns;
`applyAnswer` writes only the shown direction's; `buildSession` deals
questions under the direction setting with the first-meeting rule; `progress`
reports understood and said; Stats counts every figure per way round; the tutor
reads a miss per way round; the save queue keys by card and direction; the deck
cache went to version 2; Reset writes `RESET_COLUMNS` in one update. The
reference sections above describe it.

**Tests.** `serving` gained the two-way rules — each way due on its own, the
filters, grammar in every setting, no gate, first meetings apart, one answer a
day per way, re-dealing — and the write-level check that an answer shown in
French writes only French-side columns and one shown in English only `en_`
ones, each computed from its own history. Each rule was broken on purpose to
see its check fail. `answering` checks the same by the requests the browser
sends, plus a correction and a failed save with the word in the block both
ways, the re-deal, and Reset. `progress`, `stats`, `lessons`, `session`, `types`,
`logic` and `apply-splits` follow the new figures; the mock deck has English
sides, all new, and the harness's `firstBlockItems` counts a block from the
rules.

**Checked against the owner's real deck.** A read-only snapshot of the 3,929
cards, given English sides as migration_010 leaves them (all new), served to
the app locally with every write answered in the browser. A Mixed block
missing every third card: 50 answers, 36 schedule writes, all French side — the
backlog of due reviews filled it, as "due first" says. Then EN→FR and Continue:
50 answers, 36 writes, 28 of them English side (words met for the first time
that way) and 8 French (grammar, asked as written). All 72 writes were for the
card on screen and only to the way round it was shown, none twice, no new word
met both ways; 100 answer records, 72 counted. Stats recounted from the
snapshot plus the writes matched: 158 answers today, 114 right; 3,665 not yet
seen; 3,219 words and phrases, about 28 you could say; 17 due today. Full
suite on the Mac: all 20 suites passed, `reflow` included this time.

The migration is run by the owner in the SQL editor, and the columns were
checked read-only before this was pushed.

**The reset failed on the live app, first press.** "Your progress couldn't be
reset, and nothing was changed." The update cleared `next_due_at` to null, and
the live column is `not null default now()` (migration_005); Postgres refused
the whole statement, so nothing changed, as the message said. Every check had
passed: the mock accepted any write, and the local dry run of migration_010 had
built `user_cards` with that column nullable. Fixed by setting the French
side's due date to the moment of the reset — a never-answered side's due date
is never read. The mock and `answering` now refuse null in every column the
live table declares NOT NULL (`USER_CARDS_NOT_NULL` in the harness, read off
its schema), and the reset check fails against the old code the way the live
app did. **When testing a write, check it against the live table's
constraints, not against a table rebuilt from the migrations.**

**The reset then worked** — checked read-only: all 3,929 cards new both ways,
`card_progress` empty — **but not the streak**, which it never touched. The
owner decided it should, and that directions stay out of sight: after one
block, "about 10 more you'd understand · about 12 more you could say" read as
wrong ("I don't know what 'you could say' means"). Proposals of "remembered
French → English", and of "right shown in French / shown in English", were
both turned down: the split works in the background, and a positive
assessment means the student knows the word both ways. So progress is one
figure again, "about N remembered", counting a word only as far as it is
remembered both ways. The two class groups were renamed at the same time, with
their dates shown. `stats` checks the figure can't count a word seen one way,
that nothing on the page names a direction, and the group dates; `lessons`
that a first block moves "remembered" by its grammar cards alone; `answering`
that Reset clears the streak and says so when a delete is silently refused.
Breaking each — counting the French side alone, skipping the streak delete —
fails those checks. Also fixed: `answering`'s correction check read only
French-side fields, and failed whenever its first card came up in English.

### 2026-09-24 — the cahier keeps the deck up to date

**The problem.** The cahier is a living Google Doc: Laura adds a class after
every lesson. The app read one once, so the deck drifted behind the teaching —
the owner's stopped at the 5 September class while the doc had reached
24 September, twelve classes and ~250 cards later.

**Agreed with the owner.** New classes become cards immediately and are
scheduled like any other new card. A class already read is never read again,
and edits or deletions in old classes change nothing — "No" to offering to
update or archive those cards. Each of Laura's students has their own doc with
her, so one link per student. The owner pays for the parsing, not the students.

**What was built.** `migration_011` (`cahier_links`), `api/cahier-sync.js`
(read the doc, parse only unread classes, write), `api/cahier-daily.js` (the
cron, refusing any caller without `CRON_SECRET`), `src/useCahierSync.js` (the
check on open, at most hourly, and the loop that works through a backlog), the
link tab's "Keep my deck up to date" with its status and Unlink, and the notice
saying what arrived. The reference section *The linked cahier* describes it.

The parser itself was not rewritten: reading the doc, slicing it into classes
and turning a class into cards are now exported from `parse-cahier.js` and
used by both paths, so the two can't drift into parsing the same notebook
differently.

**Two things the sync does that the upload deliberately doesn't.** It merges a
repeated word's class dates instead of rewriting the card (an upload rewrites
front and back on purpose; a background job doing that would undo hand-edits),
and it leaves a class Claude failed on unread, so the next run tries it again
rather than losing it silently.

**Tests** (`cahier-sync`, no browser): a stand-in database, doc and Claude,
with Claude's calls counted at the wire — that count is the bill. Re-parsing
classes already in the deck, overwriting cards the student has, and re-parsing
an edited class were each put back on purpose and failed 2, 3 and 4 checks.

**Found on the way: the installed packages were damaged.** `node_modules` held
26 duplicate folders named `… 2`, dated 19 September, and
`@supabase/supabase-js` had lost its `package.json`, so anything importing the
server code failed to load — `auth` among them. The signature of a file-sync
tool (iCloud or Drive) inside the project folder. `npm ci` repaired it. If the
folder stays synced it will happen again; `node_modules` should be excluded.

### 2026-09-24 — adverbs, and no more cards you can't answer

**Asked for.** A lesson on adjectives and adverbs — relatif / relativement,
and the cases where the adverb is another word or the same word. Then, from
reviewing it: every grammar card should say what it wants typed, and there
should be no card you can't answer by typing — no rule cards, no
pronunciation cards.

**Built.**

- **Adjectif ou adverbe ?** — the second lesson (see *Lessons*). Drafted at
  124 cards, checked by independent reviews, 80 of 99 findings surviving a
  skeptic, cut to 81, then approved card by card by the owner.
- **The instruction line** above every grammar card (see *Card types*).
- **Exact marking for French-answered drills** (see *Flipping and typing*).
  The reviews ran the real matcher on the lesson's own traps and every one
  passed as "close enough": chères, chèrement, évidamment, relatifment. The
  same held for the deck's conjugation drills — "je vend", "il dois".
- **Rule and pronunciation cards gone.** The owner's 117 grammar and
  pronunciation cards were sorted by hand with them: 61 drills kept, 27
  turned into 40 new cards (38 words and phrases, 2 drills), 29 archived.
  Applied to the demo deck, whose `G` section is now 63 drills;
  `scripts/sort-grammar-cards.mjs` applies it to real decks. The parser no
  longer makes them. Two phrase cards were corrected on the way ("…que je
  n'avais pas fait de tennis"; *à temps* is in time, not on time).
- **A lesson no longer writes over a student's card** with the same front.

**Found on the way.** `GRAMMAR_TERM` never matched a term starting or ending
with an accented letter (`\b` without the `u` flag), so "passé composé avec
être" read as a word. The matcher never accepted "oe" for œ, nor a phone's ’ for
an apostrophe. And `lessonRank` keyed lesson cards by their current front while
the sync keys rows by their first one, so the 27 reworded impératif drills —
the forms and irregular sections, taught first — had no rank and were served
last; the `serving` suite missed it because its fixture keyed them the same
wrong way.

**The live sort (applied 2026-09-24, owner's go-ahead).** The live decks held
far more than the 117 the owner reviewed: 1,907 grammar and pronunciation cards
across 8 decks (the owner's alone ~630 — `src/data/cards.js` is an old
snapshot). No `ANTHROPIC_API_KEY` in `.env.local`, so the 1,783 cards the
reviewed file didn't cover were sorted in-session by agents with the script's
own prompt, each batch re-checked by a second (37 changed), then checked by
`validateClaudeResult`. Result: 104 drills kept; ~1,360 re-filed in place as
words and phrases, history kept — most were never rules, just filed under the
grammar heading; ~210 replaced by the French under them; ~240 archived; 111
new cards not added because the deck already had them. Every row touched is in
`backups/grammar-sort-applied-2026-09-24T23-59-01-566Z.json`. Found while
applying: the script replaced a card whenever its new front differed at all —
a full stop, a capital — restarting ~350 cards' history for nothing; a card
tidied into itself now keeps its row (`sameFrench`, or one new card sharing
most of its words). Only one of the 8 accounts studies regularly (the owner's,
34 study days); the rest stopped or never started.

### 2026-09-25 — the linked cahier: a partial upsert that could never work

**What broke.** Every sync after linking failed. The owner's account showed
"Couldn't read that cahier" on a link that had never been checked. Every
status write — when it last checked, what it added, why it failed — went
through the same upsert that links a doc, carrying only the changed fields.
An upsert is an insert that then resolves a conflict, and Postgres checks the
insert row first: it had no `doc_id` or `doc_url`, both NOT NULL, so it failed
before it looked for the row it would have updated. The linking run itself
died at its status write. A run that did parse classes had already written
their cards by then, so it couldn't record them as read, and the next run
would pay to parse them again (without duplicating a card: one already in the
deck is matched by its front, and already carries that class's date).

**Why the tests missed it.** The `cahier-sync` stand-in accepted any upsert.
The same lesson as the reset on 2026-09-14, learned a second time — see the
new rule under *Testing*.

**Why the message said nothing.** The dialog read the hook's `error` state
from the render it was called in, which was stale, so it showed the generic
line while the server had given the reason.

**The fix.** `linkDoc` (an upsert of the whole row) only when linking or
relinking; `updateLink` (a plain update) for everything after. `sync` in
`useCahierSync` returns `{ ok, error }`, and the dialog shows that error. The
stand-in now refuses an upsert missing a NOT NULL column (`REQUIRED`), and
the suite checks that a run records when it looked, both on the run that
links and on one that finds nothing new.

### 2026-09-26 — the instruction line: italics, and one short line

**Asked for.** Every instruction in italics, and whether the line above the
prompt was the best place and way to show one. Five options went to the
owner: italics where it was; italics cut to one line; a fixed line along the
top of the card; just the verb big, with the tense and pronoun in a small line
under it; the line under the prompt as a caption. They chose the second.

**Built.** The line stays directly above the prompt, now italic and medium
weight instead of semibold, like the tap hint at the foot of the card, so it
reads as the app talking rather than part of the card. (Manrope has no italic;
the browser slants it, as it already did for the hint.) A conjugation drill's
line drops what the card already says: "Conjugate in the present subjunctive,
third person plural, with qu'ils or qu'elles", two lines on a wide screen, is
now "Present subjunctive, with qu'ils or qu'elles" — the pronoun names the
person. The imperative reads "Imperative, tu form" and the participle "Past
participle". Lesson section lines kept their wording. Measured in Manrope at a
phone card's width, every drill line fits on one line except the longest kind
(the future perfect with "ils or elles"), which takes two.

**Not chosen, and why.** Under the prompt: the student reads the big text
first and starts answering, and the line exists because the prompt alone was
misread. Along the top: further from the word, easier to miss, and on a phone
it shares the top with the lesson badge. Just the verb: the biggest change,
and drills would stop looking like every other card.

**Shipped in two parts.** The italics went out in 375fd1f, because another
session committed `FlashcardApp.jsx` whole while this change was in it; the
wording followed in its own commit.

## Open items

- **A few rules are filed as words or phrases**, outside the sort (it only
  reads `G`/`P`): "voie passive" → "passive: être + participe passé" and
  "double pronoms (COD + COI)" → "pronoun order…" in the owner's deck. Most of
  the 19 cards `isGrammarCard` flags among words and phrases are fine — "il
  faut + infinitif" → "one must" is a pattern with a translation you can type.
- **"un article" reads as grammar.** `GRAMMAR_TERM` matches `articles?`, so a
  plain word card — "un article", "les articles" — shows under Grammar in the
  filter and in By type. A false positive, not a wrong card; the term needs
  its grammar sense, the way `accords? (?:du|des|avec)` does. The parser's
  backstop (`keepAnswerable`) uses the same test, so such a word filed under
  `G` would be dropped rather than re-filed as a word.
- **The accent in -ément is not checked** (précisément vs précisement), because
  accents are ignored for everyone. The adverb lesson keeps only three such
  cards for that reason.

- **Two-way scheduling has not been checked on the live app.** Tested against
  the mock and a read-only snapshot of the owner's deck (2026-09-14 History).
  Reset all progress has since been used live and left every card new both
  ways. Still worth checking signed in: in Mixed, words come up both ways;
  EN→FR asks grammar as written; a record lands in `card_reviews` for every
  answer.
- **The linked cahier has not yet worked on the live app.** Every sync failed
  until the 2026-09-25 fix, which is tested against the stand-in only. Worth
  checking signed in: the owner's link should show a "last checked" time and
  the classes since 5 September should be in the deck.

- **A private cahier needs Google sign-in.** The linked doc is read with no
  credentials at all, which is why it has to be shared as "anyone with the
  link can view". That is fine for the owner and workable for Laura's students,
  but the link is readable by anyone who has it, and some student or parent
  will object. Reading a private doc means an OAuth flow and Google's
  verification, which is why it wasn't built first.
- **`CRON_SECRET` has to be set in Vercel** for the daily cahier check to run
  at all; without it the route refuses every caller, including the cron. The
  linked doc is still read whenever a student opens the app, so a missing
  secret shows up as "classes arrive late", not as an error.
- **The retry and reset fixes of 2026-09-14 have not been seen on the live
  app.** The owner found both problems by studying on the live app; the fixes
  were tested against the mock only. Worth checking signed in: a block with
  misses still ends at 50 answers with no "Retry N of M" run; the checkpoint
  and Stats say due today and older still waiting separately; new cards start
  arriving once the owner's ~120 remaining due cards are worked through.
- **One browser suite fails on and off on the owner's Mac and passes in the
  container.** `reflow` — see *Working protocol*. On 2026-09-14 it failed two
  runs in three on unchanged `main` ("the tutor reflow actually ran — 0px of
  padding", once a `page.goto` timeout instead), so a failure there is not a
  signal either way. It still does: on 2026-09-25 that first check failed on
  unchanged code, a timing flake rather than a regression. (`layout`'s
  long-standing failure turned out to be a real 5px card shift, fixed
  2026-09-13.) They measure movement frame
  by frame, and this machine's headless Chrome delivers far fewer frames:
  sampling the feedback panel's open measured five in 600ms. `motion` was the
  third, and was fixed by asking the animation itself
  (`getAnimations()`, polled on a 10ms timer rather than rAF) instead of
  counting sampled frames — the same fix would likely rescue `reflow`.
  Until then, reflow changes made on the Mac have no working check, so measure
  by hand in a browser.
- **A screenshot-only feedback note has never been seen in View feedback.**
  The owner has since used the panel signed in on the live app — "test", with
  a screenshot and the card attached (#33) — and it arrived and shows in the
  log with the card and thumbnail side by side. What is still untested is a
  note with a screenshot and no text, which the panel now allows: it arrives
  with an empty `message`, and the entry makes the message its headline.
- **The deck has many near-duplicate cards**, from the same notebook line
  parsed more than once: `rentable` three times, `chiant` three times,
  `décrire` and `élire` each with a gloss-tagged twin. The feedback pass
  removed the fourteen it tripped over; nothing finds the rest. Archiving
  (`src/lib/archive.js`) is the safe way to take them out once found.
- **`FeedbackAdminView` is never rendered.** It holds the answer-dispute
  review and the user feedback list, and nothing in the app mounts it; the
  profile menu's "View feedback" opens `FeedbackReviewModal` instead. It was
  kept in step with the modal (both use `FeedbackEntry`) rather than deleted,
  because the dispute half has no other screen. Wire it up or remove it.
- **Archiving has no UI.** A card is archived by setting `source` to
  `archived:<source>` from a script or the SQL editor. An "Archive" button next
  to "Delete card" in the edit modal would be the natural home.
- **`^0.x` dependency versions can never update themselves.** The Anthropic
  SDK sat on 0.27.0 (Sept 2024) from the first commit until it was bumped to
  0.124.0, because below 1.0 a caret pins the MINOR — `^0.27.0` means 0.27.x
  forever, through every reinstall. The same trap is live again at `^0.124.0`
  and applies to `ts-fsrs` too. Check these deliberately; nothing will
  surface it.
- **Speech is browser-only now.** The Azure endpoints were deleted rather than
  secured. Restoring them means putting them behind `requireUser` and, if the
  owner should not be paying, a per-user credential like the Anthropic one.
- **Finish estimates on the Stats page are not built.** "At your current pace,
  all seen by September 2028" was agreed, but pace needs to know how many new
  cards a student meets per day, and nothing records when a card was first
  seen: `last_review` moves on every review, `created_at` is when the card was
  made. Since 2026-09-14 `card_reviews` records every answer, so a card's first
  answer from then on is known without a new column; before that, it isn't.
  Needs the owner's say-so.
- **The answer record is written and read by nothing.** `card_reviews` has
  kept every answer since 2026-09-14 (migration_010). Nothing yet uses it for a
  true-retention figure across sessions, a progress-over-time graph, or
  re-optimising FSRS parameters against this learner's own answers — which is
  the feature that makes FSRS better than its defaults, and wants a few hundred
  counted answers per direction first. Answers before that date were never
  recorded and can't be recovered.
- **Mobile / PWA.** The layout is responsive and no longer scrolls sideways, but
  there is no install manifest or offline support.
- **The multi-sense cleanup has never actually been run.** The machinery is
  complete and, since 2026-09-11, has a caller — `scripts/fix-multi-sense.mjs`,
  see **Maintenance scripts**. What has not happened is somebody running it
  against the live deck with `--apply`, so `les frais` is still in there as
  "the costs; the expenses; fresh". The audit step has never made a single real
  API call. It needs the owner's key, a dry run read end to end, and then the
  decision to write.
- **The lesson bar should be built on the lesson's own sections.** Agreed but
  not built, and worked out for the impératif. Every card carries a section
  (there: `forms`, `irregular`, `ind2imp`, `negative`, `pronominal`,
  `ex1`…`ex8`, `phrase`) and the bar doesn't read it. The section never
  reaches a stored row, and doesn't have to: `lessonRank` and the instruction
  line (`src/data/lessons/index.js`) already look each lesson card's section
  up in the lesson's own data by its key, and `teachingOrder` on the lesson
  lists the sections in the order they're taught. A per-section bar can read
  the section the same way, with no change to the row.

  The 14 sections group into the four tabs the notes panel already uses, which
  is what would let the bar and the notes share one vocabulary: tapping a chip
  could open the notes at the matching tab. The grouping is by the rule each
  exercise drills rather than by whether it is an exercise, and it is worth
  writing down, because the totals cannot be re-derived from the section names
  alone — `ex8` counts as phrases, `ex1` and `ex2` as forms.

  | Tab | Sections | Cards |
  |---|---|---|
  | Forms | `forms` 9, `irregular` 12, `ex1` 5, `ex2` 4 | 30 |
  | Pronouns | `ind2imp` 8, `negative` 8, `ex3` 6, `ex4` 5, `ex6` 7, `ex7` 12 | 46 |
  | Reflexive | `pronominal` 10, `ex5` 5 | 15 |
  | Phrases | `phrase` 9, `ex8` 8 | 17 |

  Default stays `All` and mixed: your own doc's
  point that blocked practice tests worse applies here too, and the resolution
  is also already in it — interleaving on review and sequencing on first
  exposure are not in conflict.

  **The decision that has to land with it:** a section drill must not write
  FSRS reviews. Ten minutes on the 8 negative cards is dozens of reviews on 8
  cards in one sitting, which is the 45-reviews-in-a-minute bug wearing a new
  hat.
- **The lesson generator is not built.** The idea — parsing Laura's PDFs into
  cards automatically — was scoped but not built. The second lesson
  (*Adjectif ou adverbe ?*) was written for the app, not from her sheets, so
  the impératif is still the one example, and designing from one example
  would be a mistake. Her materials look
  templated (numbered sections, *Détail* callouts, a "phrases à apprendre par
  cœur" list); worth confirming across two or three more lessons first.
- **`expandConjugations` is mood-blind.** `SUBJECT_PRONOUNS` is a fixed
  six-person list indexed positionally and the tense enum has no `impératif`,
  so a three-form table imports as `être → je = "sois"`, and the instruction
  line then asks for the present tense. It did not bite the
  impératif module because those cards were authored rather than parsed, but it
  will bite the next cahier containing a non-indicative paradigm.
- **"Flips look jumpy and glitchy" is reported but unreproduced.** Four
  hypotheses tested and falsified; see the history in git. Note that the
  *reflow* half of this complaint turned out to be four separate, measurable
  bugs, all now fixed and covered by the `reflow` suite — see the chip-row,
  feedback-sheet and `cardWrap` notes above. Whether anything remains wrong
  with the FLIP itself is still open, and should be measured separately from
  the reflow now that the reflow is quiet.

  The last of the jerkiness was a chain of HANDOVERS. The card's size is the
  last thing to absorb a squeeze, behind cardArea's centring slack, cardWrap's
  slack above the card's cap, and cardTopSpacer — and each of those has a
  finite capacity, so each one running out changed the card's speed mid-move.
  Measured as the card's share of each pixel the page gives up, it grew at
  1.00px per px for four frames with the spacer pinned at 0, then dropped to
  0.31 the moment the spacer came off the floor. Removing the slack (cardWrap
  capped to the card's own height, and its flex BASIS set to that cap so flex
  never freezes it) and setting the spacer's shrink factor to 2 leaves one
  constant rate: 0.58px per px from the first frame at 800x700.

  Judge this on the card's EDGES, not its height. Height is derived, and its
  rate can shift with nothing visibly jumping — the top edge slows while the
  bottom carries on. Worst edge-rate spread is 2.0x, against 3.0x before.
  Animating `transform` instead of layout would remove the per-frame layout
  work altogether, and would change what the layout, motion and reflow suites
  assert.
- **The tutor's model change is unmeasured.** `chat.js` moved from Opus 5 to
  Sonnet 5 on reasoning about the task, not on evidence that quality holds for
  French specifically — nuance questions are exactly where a lighter model
  gives a confident wrong answer. The mitigation is that proposed cards are now
  editable, so a bad card costs a keystroke rather than months of reviews. A
  real answer needs ~30-40 real questions with checked answers, run against both
  at a couple of effort levels. Until then: use it, and switch back if it is
  visibly worse. Since 2026-09-12 the prompt also carries rules a lighter model
  may follow less reliably — see the next item.
- **The tutor fixes of 2026-09-12 were tested against a mock, not Claude.**
  The suites prove what the app sends and shows. They cannot prove that the
  model withholds an unanswered card's answer when pushed, writes grammar cards
  as arrow drills, and never imitates the bracketed history notes; nor that
  the conversation cache now hits (`usage.cache_read_input_tokens` above zero
  from the second question); nor Replace against the real
  `/api/admin-update-card`, which the mock does not serve. A handful of real
  questions on the owner's deck would settle all of it — ask on an unanswered
  card without answering it, so no review is written.
- **`split-senses.js` still runs Opus 5** for what is batch classification
  against written-out rules — see the table under Serverless functions. It is
  offline, so it could also go through the Batch API at half price.
- **Answers in the impératif module were written by Claude, not by Laura.** Her
  exercise sheet ships no answer key. Worth a pass from her before it goes to
  students.
