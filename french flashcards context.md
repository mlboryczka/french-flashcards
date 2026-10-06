# French Flashcards — project context

A flashcard app for learning French with spaced repetition. It is built around
the student's class notebook, the *cahier*, which the teacher (Laura) and the
student keep in a Google Doc. Claude turns each class into cards, and FSRS, a
model of memory, decides which card comes up when. There are also built-in
lessons with notes.

The app is called **Déjà Review** (owner, 2026-10-06): a flashcard app that
starts with French and is meant for other languages later. The sign-in page
and the browser tab carry the name; the repo, the live address and this
document keep the old one.

Live at `french-flashcards-nine.vercel.app`, deployed by Vercel from `main`.
Repo: `mlboryczka/french-flashcards`.

"The owner" is the person who runs the app and studies with it. Their decisions
are marked *(owner, date)*; don't undo one without asking them.

This document brings a new session up to speed. It has three parts:

- **Reference**, from *Stack* to *The status check and the simulations*: the
  app as it is now. Where it and History disagree, the reference is right.
- **History**: one short entry per working session, oldest first. It records
  why things are the way they are.
- **Open items**: what is known to be wrong or missing, and what is agreed but
  not built. It is the last section.

Keep it that way: when a change lands, update the reference section it touches,
add a History entry, and update Open items. If the change touches something
the public pages describe (`README.md` and `docs/`, written for people reading
the repository), update those too.

---

## Stack

- **Frontend:** Vite and React 18, with no router and no CSS framework. Styles
  are inline objects: `S` in each component, the theme `T` in `src/theme.js`.
- **Scheduling:** `ts-fsrs` 5.4.2. The server fits each student's settings with
  the official FSRS optimizer, `@open-spaced-repetition/binding` 0.5.0.
- **Data and sign-in:** Supabase, free tier: Postgres with row-level security,
  and magic-link email. A sign-in link works once. Opened again (a second
  click, an older email after a newer one, or a work email system that opens
  links to scan them), Supabase sends the browser back with the reason in the
  address bar, and the sign-in page says "That sign-in link has expired or was
  already used. Send yourself a new one." (`src/Auth.jsx`). Supabase also
  allows one link a minute per address, and the page shows its "you can only
  request this after N seconds".
- **AI:** `@anthropic-ai/sdk` ^0.124.0, used only by the serverless functions
  and the scripts, with a model per route (see *Serverless functions*).
  Students bring their own API key; the owner and the linked cahier use the
  server's (see *Who pays for Claude*).
- **Hosting:** Vercel, which deploys `main` automatically: `api/*.js` are
  serverless functions, plus four daily cron runs in `vercel.json` (see
  *Serverless functions*). The Hobby plan deploys at most 12 functions, and
  there are 12 (`api/_lib/` doesn't count).
  A 13th fails the whole deployment, as `api/fsrs-fit.js` did on 2026-09-26.

`npm run dev` doesn't serve `api/`, so uploading, the tutor, disputing a mark
and the daily FSRS check work only on the deployed site.

A free Supabase project pauses after about a week idle. The app then says
"Couldn't reach the server" after 10 seconds (`App.jsx`); resume the project in
the Supabase dashboard.

---

## Working protocol

**Do only what the owner asked.** Propose anything else in one line and wait
for a yes (owner, 2026-09-25).

**Work in the local copy, and push finished work to `main`** (since
2026-09-12): not in a cloud container, and not straight onto GitHub. The copy
is `~/Desktop/Projects/french-flashcards` on the owner's Mac. Vercel deploys
from `main`, so nothing is live until it is there.

- First `git fetch`, and fast-forward `main` if it is behind `origin/main`.
- If the session was set up on another branch or in a worktree, say so in the
  first reply and use `main`. Work pushed elsewhere is invisible to the owner;
  whole sessions were lost that way (2026-09-08, 2026-09-09).

**Resolve feedback in the session that fixes it:**
`node scripts/resolve-feedback.mjs <ids> --note "what was done" --apply`, also
for an entry that needed no change (the note says why). In the app the owner
resolves entries only with Apply or Dismiss under Claude's review (see *View
feedback and Claude's review*). Resolving deletes nothing.

**No change may cost a student their progress** (owner, 2026-09-25): their
schedules both ways round, the record of every answer (`card_reviews`), the
streak, and their place in the set they are working through. Before any change
(code, a lesson edit, a data script), check it can't delete or rewrite these;
if it could, say so and wait for a yes.

- What has cost progress before: deleting answered cards, which deletes their
  answers (the lesson sync and "Replace my existing deck", until
  2026-09-25/26); a script rewriting schedules (the agreed reset of
  2026-09-14); and reloads discarding the set on screen (until 2026-09-26).
- Take a card out of study by archiving it (`src/lib/archive.js`). Never
  delete an answered card.

**Other sessions edit this working copy at the same time.**

- Check `git status` and `git diff` before editing, and commit only your own
  changes.
- To commit your tested copy of a file that also holds another session's
  unfinished edits, stage it without touching the working file:
  `git update-index --cacheinfo 100644,$(git hash-object -w <your copy>),<path>`.
- If their half-finished change breaks the app, test on a clean copy:
  `git archive HEAD | tar -x -C <dir>`, your files copied in, `node_modules`
  symlinked, Vite on its own port.
- Their simulations can slow the machine enough to fail a timed check. Rerun
  that suite alone before believing it.

**Live data.** The real `.env.local` holds the live project's keys, service key
included: the app run with it, and every script in `scripts/`, works on live
data. If Claude Code refuses to touch production, give the owner the command
to run in their terminal (not the Supabase SQL editor).

**`npm test` before every push.** It runs the 34 suites in `tests/suites` (16
without a browser, 18 in headless Chromium) in about twenty minutes, so start
it early. `npm test -- <name>` runs only the suites whose names contain
`<name>`. Don't edit `src/` while browser suites run: a save reloads the app
under a running test. For a small change the owner wants the result in
minutes: run the suites that cover it, and offer the full run in one line
(owner, 2026-09-25).

**On the owner's Mac,** `tests/run.mjs` won't start browser suites while the
real `.env.local` is present. Don't move that file. Use a clean copy, or start
the pieces yourself, with Vite on a free port (other sessions may be using
5174), since environment variables beat `.env.local`:

```
node tests/mock-supabase.mjs        # the mock, port 5999
VITE_SUPABASE_URL=http://127.0.0.1:5999 VITE_SUPABASE_ANON_KEY=test.key npx vite --port 5174 --strictPort
APP_URL=http://localhost:5174 NO_PROXY='*' node tests/suites/<name>.mjs
```

Set `CHROME_PATH` to Playwright's Chromium,
`~/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
the default in `tests/harness.mjs` is the Linux container's.

**`reflow` fails on and off on the Mac, and that is the baseline.** Its first
check ("the tutor reflow actually ran") fails there on unchanged code (see
*Open items*). A new failure in any other suite is real.

---

## How a session is built

`buildSession(cards, opts)` in `src/lib/sessionQueue.js` deals a block of up to
50 cards (`BLOCK_SIZE`), or the 20, 30 or 100 the student picks under "Cards in
a set" (below); the student sees it as a set, and newer code says set too.
FSRS decides when a card already seen comes back. Which cards make a block,
and which new card comes next, are the app's rules (owner, 2026-09-12).
The cards come from the whole deck, or from one lesson or type when the student
narrows it. On Cards, "the whole deck" means the student's own cards and the
lessons they have switched on, or only their own under My cahier; see
*Which lessons come up on Cards*.

**A block is made of questions: a card asked one way round.** Since 2026-09-14
(migration_010) a word or phrase card has two FSRS states: `fr` for
"la pomme → ?" (the original columns) and `en` for "apple → ?" (the same eight
columns prefixed `en_`). Grammar and pronunciation cards are asked as written,
and have only `fr`. Every rule reads the question's own way round, through
`sideOf(card, dir)` and `sideColumns(fields, dir)` in `src/lib/directions.js`.
Each entry is the card plus `shownDir`, `flippable` and `_bucket`. A card can
be in a block both ways, so entries are told apart by `itemKey` (card and way
round).

The owner's decisions on the two ways round (2026-09-14):

- The direction setting is a filter: FR→EN asks words and phrases in French,
  EN→FR in English, Mixed both. Grammar and pronunciation come up in every
  setting.
- Neither way waits for the other; both questions of a new word are new from
  the start. The owner rejected any gate, because which way is harder differs
  per student and per card. Don't reintroduce one in any form.
- Both ways of a word may come up on the same day, even in the same block (no
  sibling burying).
- A word's two first meetings are kept apart. Once a card is answered for the
  first time one way, the other way waits for a later day, and a block never
  deals both new questions of one card; otherwise the second would come just
  after the student saw the answer. The owner accepted this because it only
  decides when a question is first shown, which FSRS has no say in.

**What goes in a block, by priority:** cards missed last time and due today;
other cards due today, most overdue first; then new cards, only once the due
cards run out.

- Due today means due before the student's day ends (`endOfLocalDay`), so the
  day's work doesn't grow while they study. The day runs from 4am to 4am
  (`DAY_STARTS_AT_HOUR` in `src/lib/studyDay.js`, since 2026-09-26), so a
  session past midnight is one day; the streak, one answer a day and the kept
  set follow it.
- There is no other limit on new cards: no daily number, forecast or time
  setting. A backlog is exactly when new cards should wait (owner,
  2026-09-12).
- There are no spot-checks: a card is dealt only when due. The two well-known
  cards each block carried were dropped on 2026-09-26; in a simulation they
  cost study time and taught nothing.

**New cards come in this order** (`orderNewCards`). Inside a lesson: the
lesson's `teachingOrder` of sections, then each card's place in the lesson
(`lessonRank`). Otherwise: cards from classes in the last 14 days (*Last two
weeks of class*), newest class first; then *Older classes*, the words from the
most classes first (`dates.length`); then undated cards; then unseen lesson
cards. A card added from the tutor is dated by its `created_at`. Ties come in
random order.

**Then the block is shuffled,** because runs of one kind are blocked practice,
which tests worse than mixed. A lesson's block is shuffled too (owner,
2026-09-25). Guarded by `serving`.

**Each deal is recorded** in `dealt_sets` (`recordDeal`, `src/lib/dealLog.js`;
migration_013, run 2026-09-28), with what the app believed about each card at
the time, for the status check. The app never waits for this write. Its
`scope` is the set's key, plus on Cards "|off=a,b" for the lessons switched
off (`dealScopeOf`), which the status check reads to rebuild what the set
could have been dealt from.

**A block is as many answers as its size, retries included** (`placeRetry`).

- A missed card comes back 20 cards later (`RE_QUEUE_OFFSET`), or at the end
  of the block if fewer are left. It takes the place of the block's last card
  not yet shown, which moves to a later block, so the block never grows.
- No retry when the miss is one of the last two cards, or only retries are left
  to come. The miss is recorded, and the card comes first on the day it is
  next due.
- A retry is practice: FSRS already has the day's answer.
- A miss changed to right with Previous card withdraws its retry
  (`withdrawRetry`) and puts back, at the end, the card that retry replaced
  (`_displaced`).
- **Mark for review**, offered under a typed answer the app accepted, saves it
  as a miss (`markForReview`). The card moves on at once, so for five seconds
  the toolbar says, in red, that it now counts as wrong and when it comes
  back: "Marked for review: counted as wrong, back later in this set", or
  "back tomorrow" when there is no room for a retry (owner, 2026-10-05 and
  2026-10-06). It names no card: a long front ran it off the top bar.
- The counter reads "Card N of 50", or of the size chosen. On a retry it adds
  "· retry"; otherwise it adds the block's relearning, review and new counts
  as they are now (`countBuckets`). Then comes "· N retries to come".

**Cards in a set** (since 2026-10-04): 20, 30, 50 or 100, in the Settings menu
behind the gear, kept in this browser (`localStorage` `set-size`; `SET_SIZES`
in `FlashcardApp.jsx`). Since 2026-10-06 a new size changes the set on screen,
not only the next one: the cards not yet reached are dealt again to the new
length (`redealRest`), and the card on screen, every answer and the retries
lined up stay. A size below the card on screen ends the set on it. At the end
of a set, the new size is for the next one. The size is kept with the set
(`study-place:`), so a reload or a trip into a lesson and back shows it too; a
set that came out short because the deck ran out isn't topped up unless the
size changed. Guarded by `set-size`.

**An answer** (`answer()` in `FlashcardApp.jsx`) writes the schedule of the way
round shown if FSRS counts it, a record in `card_reviews`, the streak's day
(`user_review_dates`), and the legacy `card_progress` tally.
`applyAnswer(card, got, now, dir)` returns that way round's columns, used for
both the database and the deck in memory. Right is FSRS's `Good` and wrong is
`Again`; the check is the grade, so there is no Hard or Easy.

**FSRS gets one answer per card per way round per day: the first.** A retry,
or an answer when `reviewedToday(sideOf(card, dir).last_review)` is true, is
graded on screen but not scheduled. This covers retries, Previous card,
reloads and second devices: an answer given just after seeing the answer says
nothing about memory across days. Lapse counts from before 2026-09-12 still
include such answers.

### The checkpoint

After a block's last card, the checkpoint (`data-checkpoint`) replaces the
card. It says how the block went, "50 answers, 43 right first time": answers
include retries, and right first time counts the answers FSRS counted. It
shows what each area moved (`progressChanges`), and inside a lesson how many
cards elsewhere are due. Then comes Continue, or "You're all caught up" when
nothing is due or new. The owner had the headline's full stop and a "reviews
only" message removed (2026-09-14).

**Continue deals from the deck in memory, never from a refetch,** which
straight after the last answer can return that card's old state and deal it
again. `patch()` in `useUserDeck` applies each answer to the deck in memory.
Continue then runs `checkElsewhere` (below). Guarded by `session`.

**A new block starts at card 1.** If the card on screen is in it, that card
moves to the front.

### The deck a block is dealt from

The deck in memory can be out of date. On opening the app it is the copy saved
in the browser (`deck-cache:`), written only when a fetch lands, so it can be
days old; a deck over 2.5MB isn't saved (the owner's was over on 2026-09-25).
And an open page misses answers given on another device. So the deck-build
effect in `FlashcardApp.jsx` deals again (`dealtSeqRef`, `dealtDayRef`):

- **When a fetch lands after the block was dealt** (`freshSeq`). A block not
  yet started (nothing answered or seen) is dealt again. One under way keeps
  every card shown, answered or waiting as a retry, and the rest is dealt again
  (`redealRest`, which calls `buildSession` with `inBlock`).
- **When the student's day turns:** a new block, whatever state the last one
  was in (owner, 2026-09-26).
- **On returning to the tab, and on Continue:** `checkElsewhere` asks for the
  ids of `card_reviews` rows since ten minutes before the deck was fetched, at
  most every 15 seconds. An id this page didn't write means another device
  answered, and the deck is read again.

**A fetch never undoes an answer the page has given.** A fetch can read a row
before the answer's save lands, so `useUserDeck` keeps what each answer wrote
for an hour, and lays it over any fetch with an older `last_review` for that
way round (`withLocalAnswers`). Reset all progress clears these.

The lesson sync also waits for the fetched deck: in the saved copy, a card
answered since looks unanswered. Guarded by `regressions` and `serving`.

### Where the student is: the set on screen, kept

Each set is kept in the browser as it changes (`src/lib/studyPlace.js`,
`study-place:<user>`), one per filter (`typeFilter|lessonFilter`, and
`typeFilter|all|cahier` for My cahier, from `setKeyOf`). A reload, which is how
every update arrives, puts the student back on the same card with the same
count and retries.

- Kept: the cards and ways round (their details are read from the deck again),
  the retries and the cards they replaced, the position, the score, the
  checkpoint, the answers given (for Previous card), the progress figures the
  checkpoint compares against, and the lesson, type and direction, where the
  app opens.
- The card on screen keeps whether its answer was seen, what was typed, and
  whether it was accepted. A card whose answer was seen comes back showing it,
  so it can't be graded as if new.
- Going to another set and back brings the first one back, if it was dealt
  today. Its cards not yet reached are dealt again from the deck as it is now,
  unless nothing has changed.
- A set lasts for the day it was dealt, in that browser: each browser keeps
  its own place, for now (owner, 2026-09-26).
- Signing out clears it. Reset all progress clears the sets but keeps the
  lesson, type and direction.
- It is saved 400ms after a change, and at once when the page is hidden, so a
  flip never waits on storage.
- `scheduledRef` stops the deck-build effect dealing twice before its deck
  lands; React's strict mode runs it twice on mount.

Guarded by `regressions`.

### Flipping and typing

Typing is the default for a new student, and the browser remembers the last
choice (`localStorage` `study-mode`). Tests open in flip mode unless they ask
(`openApp({ studyMode })`).

**Typing.** The matcher (`matchAnswer`) grades the answer.

- A small typo is right ("Close enough"). A wrong article is wrong. Show answer
  counts as wrong. Tapping the card with an answer typed checks it; Escape only
  clears the box.
- A conjugation drill or lesson card answered in French (a `→` in the front,
  shown in French) must be exact, apart from case, accents, punctuation and
  parentheses: typo tolerance accepted the very mistakes being drilled, like
  "je vend" for je vends.
- Exact allows for how an answer is written (`drillAlternates`): either
  pronoun on an `il/elle` drill, a subjunctive with or without its que, the
  pronoun the instruction line asks for, and the lesson's current answer
  (`lessonBackFor`). Only "/" separates exact answers; a comma is part of one.
- Anywhere, œ may be typed oe, a curly ’ counts as an apostrophe, and … as
  punctuation.

**"My answer should be accepted"** asks Claude to look again
(`/api/review-answer`); after a refusal, "Accept anyway" accepts. An accepted
answer is saved to `card_alternates` for next time, recorded as right, counted
as right first time, and shown in green (owner, 2026-09-27). If the student
moves on before the check comes back (Continue, Enter, Previous card), the
first mark, wrong, stands, and the late result changes nothing on screen
(`disputeRef`; owner, 2026-09-27). An acceptance is kept with the set, so it
survives a reload before Continue.

**Flipping.** The student turns the card and grades themselves. Got It and
Again appear only once the answer has been seen, with "Only press Got It if you
knew it before turning the card." Before that, the grading keys turn the card.
Turning a card records nothing.

**Previous card corrects a grade.** If the corrected answer was the one FSRS
counted, the schedule is worked out again from the card's state before it
(`blockAnswersRef`, kept with the set). The count of answers doesn't change,
and answering a retry is never a correction. A right answer changed to a miss
gets a retry if none is coming.

**A failed save is shown and retried** (`save`): "1 answer not saved yet —
retrying" by the counter, retries backing off from 3 to 60 seconds, and a
warning before leaving the page. A newer write replaces an older one waiting
under the same key: card and way round for a schedule, so an English-side
answer never replaces a French-side one; the id for a record.

**Every answer is kept** in `card_reviews` (`src/lib/reviewLog.js`): the card,
the way round, the time, right or wrong, whether FSRS counted it (retries and
second answers of the day don't count), and that way round's state before and
after. A counted answer also saves the target, weights and time zone it was
scheduled with, and the card's counts before it (migration_013, run
2026-09-28). The id is made in the browser, so a retried save or a correction
rewrites its own row.

- It is read by `checkElsewhere`, Stats "Today" (every answer, retries
  included), `api/fsrs-fit.js`, the status check, and "Replace my existing
  deck" (`api/parse-cahier.js`), which archives rather than deletes a card
  with answers on record.
- Reset all progress leaves it alone. Deleting a card deletes its answers.

**Changing direction re-deals the rest of the block** (the effect on `dir`).
Answered cards stay, as do the card on screen if its answer was seen and later
cards the new setting still asks. The rest are replaced by
`buildSession(…, { inBlock })`, which deals nothing already in the block and no
second first meeting. The block keeps its count and its retries.

**Switching between flipping and typing waits once the answer has been seen**
(`pendingTypeMode`). The card is graded the way it was started, and the switch
applies from the next card, so an answer seen one way can't be given the other
way. Guarded by `session`.

### FSRS configuration

`scheduleAnswer` in `src/lib/spacedRepetition.js` schedules every answer with
the module's `scheduler`, which `useFsrsSettings` replaces with the student's
own settings (`applySettings`). Everything that schedules or estimates recall
reads it, for both ways of a card, each from its own state (`toFsrsCard` and
`fromFsrsCard` convert one way round).

**The same for everyone** (`FSRS_CONFIG`): no short-term steps, a ten-year
maximum gap (3650 days), and fuzz on. With no short-term steps FSRS never marks
a card as relearning, so a miss is stored as `last_answer_correct = false`,
which `buildSession` reads.

**Each student's own** (owner, 2026-09-26), kept in `fsrs_settings`
(migration_012, run 2026-09-27):

- **The target** (`request_retention`) is how likely a card should be
  remembered when it comes back. The student picks it under "How much to
  remember" in the profile menu: Automatic (the default), Lighter load (85%),
  Standard (90%) or Remember more (95%).
- **Automatic** starts at 90%. Each study day, the app notes whether the day
  began with due cards left over. When 5 of the last 7 study days did, the
  target drops two points, not below 85%; when 5 of 7 didn't, it rises two,
  not above 90%. It moves at most once a week.
- **The weights** are FSRS's 21 numbers for how the student forgets. Everyone
  starts on `STARTING_WEIGHTS` (`src/lib/fsrsSettings.js`), fitted to
  right/wrong answers from the FSRS team's open data, because ts-fsrs's
  defaults assume four buttons. Changing them needs a new `STARTING_VERSION`,
  which is what makes the server recompute stored estimates.
- **A student's own weights** come from `api/fsrs-fit.js`, which the app calls
  once a study day. From about 1,000 counted answers, it tests a fit made on
  the older 80% against the newest 20%. Only if the fit predicts them better
  than the weights in use does it adopt a fit made on all the answers. It
  tries again after 500 more answers and 30 days. The optimizer loads only
  when a fit is due; if it fails, the student keeps their weights.
- **When the weights in use change,** the server recomputes each card's
  stability and difficulty from its counted answers
  (`apply_memory_estimates`). Due dates don't move, and a card answered
  meanwhile is left alone.
- A new target or new weights never move a due date; they apply from each
  card's next answer. Without the table, the app uses the starting weights and
  90%, and writes nothing.

**Days are the student's days.** ts-fsrs counts days by UTC date, which changes
at 8pm in New York, so answers at 9pm and the next morning were "0 days apart".
`toFsrsTime` and `fromFsrsTime` give it times whose UTC date is the student's
day; the server does the same in the student's time zone.

**The gap after an answer comes from the card's own estimate:** the day its
chance of being remembered falls to the target (`next_interval`), plus fuzz.
Before 2026-09-26, ts-fsrs's ordering of four buttons' gaps made every right
answer wait at least three days, as this app has no Hard button.

---

## The linked cahier

Laura and each student keep the real cahier in a Google Doc: one block per
class, each starting with a date line such as "Le 24 septembre 2026". A
student links their doc once, in the upload dialog's third tab, "Google Doc
link" (owner, 2026-09-25; `src/CahierUpload.jsx`). Each new class then becomes
cards on its own. There is no tick box: linking is what keeps the deck up to
date. Unlinking removes only the link.

**The owner's rules (2026-09-24):**

- New classes become cards at once, with no review step.
- A class is parsed once. Editing or deleting lines in an old class changes
  nothing, because those cards carry the student's history.
- A word taught again keeps its card and gains only the class date. The sync
  never rewrites a front or back (an upload does).
- Nothing is ever deleted.
- The deploy owner pays for the parsing (the server's `ANTHROPIC_API_KEY`),
  not the student.

**Which classes are parsed.** A class is known by its date, and
`cahier_links.classes` (migration_011) lists those already read. Linking marks
every date already on the student's cards as read. A class Claude fails on is
retried on the next run.

**A word written another way** ("gratuit (adj)" for "gratuit", "un cas" for
"le cas") gets the date on the card the deck has. `src/lib/sameCard.js` is
narrow on purpose, because a wrong match loses a real card: "la poste" and "le
poste", "planter" and "planter (fam)", "fin" and "fin (adj)" stay separate. An
archived card counts only if its front is identical; it then gets the date and
stays archived.

**When it runs:** on opening the app (at most hourly per browser,
`src/useCahierSync.js`), on linking, on Check now, and daily at 13:00 UTC by a
Vercel cron (`api/cahier-daily.js`: up to 40 docs, least recently checked
first; it refuses to run without `CRON_SECRET`). Reading a doc is free;
parsing a class costs. A run parses at most 12 classes, and the app repeats it
until none are left. The check on opening is skipped if the doc was checked in
the last 30 seconds. That does not stop two overlapping runs from both paying
for the same class.

**What the student sees:** a notice under the top bar (`data-cahier-notice`)
when a check the app made added cards; cards the daily job adds show only in
the link tab. The notice goes when dismissed or when the first card is
answered (`answer` calls `dismissArrived`): left up, its 42px came off the card
on every card after. A failed link shows the server's reason, because `sync` returns
`{ ok, error }` and the dialog reads that, not the hook's state.

**The link row** (`api/cahier-sync.js`) is created only by linking, which
writes the whole row in one upsert (`linkDoc`). Every later write is a plain
update (`updateLink`). Don't merge them: Postgres checks an upsert's insert
row first, and `doc_id` and `doc_url` are NOT NULL.

**The doc must be shared as "anyone with the link can view"**, because it is
read without signing in to Google.

**What becomes a card** (owner, 2026-09-24; upload and sync alike): only what
can be answered by typing. A conjugation table becomes one drill per form, and
the table card is dropped. A single form becomes a drill. A real word, phrase
or example sentence becomes a `V` card. A rule or pronunciation note makes no
card.

The prompt block is `WHAT_BECOMES_A_CARD` (`api/parse-cahier.js`), in both the
sync's and the upload's prompts. `keepAnswerable` enforces it in code on every
path: a `G` card that isn't a drill is dropped if it reads as a rule, a sound
(`isGrammarCard`) or a whole conjugation table, and becomes `V` otherwise. A
drill counts only if `parseDrill` (`src/lib/cardInstruction.js`) recognises
it; one it can't read is dropped.

No two cards may leave `dedupeWithPolysemy` with the same front: the deck
holds one card per front, and a save holding two is refused whole.

---

## Card types: grammar / vocab / phrase

`classifyCard` (`src/lib/cardTypes.js`) sorts cards into three types for the
Cards view filter, By type in Stats and the tags in Hardest Cards. These are
not the four stored category codes (`V`/`E`/`G`/`P`: vocab, expr, gram,
pron).

- **grammar**: a card about French, judged by its shape (`isGrammarCard`),
  not its category: `→` in the front, a grammar term, a formula (`+`, `=`,
  `vs`), a `{respelling}`, or a back that explains rather than translates.
- **vocab**: one word or concept (`le chemin de fer`): no clause, and at most
  three words besides articles and linking words such as `de`. A gender pair
  counts as one word.
- **phrase**: any `expr` card, anything with a subject pronoun or clause word
  (`que`, `ne`…), or more than three words.

`classifyCard` caches its answer per card object, so replace a card rather
than change it in place.

The type filter exists at the owner's request (2026-09-06). It defaults to
All, because studying one type at a time is blocked practice.

**A grammar card is a drill, or it isn't a card** (owner, 2026-09-24): every
card must be answerable by typing, so there are no rule or pronunciation
cards. New `G` cards are only parser drills, tutor arrow cards and lesson
cards. `scripts/sort-grammar-cards.mjs` sorts older decks.

**Every grammar card says what to type**, in one short italic line above the
prompt (owner, 2026-09-26), in English (owner, 2026-09-24). The line comes
from `cardInstructionFor` (`src/data/lessons/index.js`,
`data-card-instruction`). A drill's line is built from its shape
(`src/lib/cardInstruction.js`): tense and pronoun, as in "Present tense, with
je"; no tense means the present. Other lesson cards use their section's line
(`LESSON.instructions`). Word and phrase cards get none, nor does a tutor
grammar card that isn't a drill. It goes by stored category (`gram` or
`pron`), so the adverb lesson's false friends, stored `G`, get "Translate into
English".

---

## Card-quality machinery

A bad card is worse than no card: FSRS records a recall that never happened.

### 1. English gloss on the French side

A parsed front can keep its English gloss and give the answer away: `je suis
allé (I went (passé)`. `cleanFrenchPrompt` (`src/lib/cardText.js`) removes a
bracket from the French when it repeats a word of the English; grammar tags
such as `(adj)` stay. It runs at display time wherever the French is the
question, so stored rows need no migration. The parser stores clean fronts
with its own copy, `cleanFrenchFront` in `api/parse-cahier.js`; change both
together.

Also at display time, in `cardText.js`:

- `cleanEnglishPrompt`: English shown as the question loses a past-participle
  note with a colon (`to re-elect (past participle: réélu)`). Other notes
  stay.
- `dropFinalPeriod`: no full stop at the end of either face. Done at display
  time because changing a lesson card's front changes its identity.

In the answer matcher (`matchAnswer`, `src/FlashcardApp.jsx`), brackets come
off the answer **before** it is split into alternatives. Otherwise `seul
(only; sole)` splits inside its gloss and `seul` is marked wrong.

### 2. One card teaching two different words

`les frais` (costs) and `frais` (fresh) can end up as one card, `the costs;
the expenses; fresh`, with no single right answer. The fix is a terminal
script, `scripts/fix-multi-sense.mjs` (dry run unless `--apply`); the app has
no screen for it.

1. **Scan:** `src/lib/multiSense.js` shortlists suspects with string rules
   that cost nothing.
2. **Check:** Claude decides split or keep and writes each sense's front: a
   noun keeps its article (`les frais`), an adjective is tagged (`frais
   (adj)`), a verb is the infinitive. It keeps when unsure. The prompt, tool
   and model are imported from `api/split-senses.js`.
3. **Apply:** the original row becomes the first sense and keeps its history;
   the other senses are new cards. Malformed splits are refused.

The script does its own writes, not through `api/apply-splits.js`. It skips
archived and lesson cards, never overwrites a card (a sense whose front the
deck already has isn't added, and new senses are plain inserts), gives new
senses the original's class dates, and backs up the rows it rewrites. Nothing
in the app calls `api/split-senses.js` or `api/apply-splits.js` any more.

The sync's prompt (rule 8c in `parse-cahier.js`) and the tutor's forbid such
cards; the upload dialog's (`cahier-parse.js`) does not.

---

## Serverless functions (`api/`)

There are twelve routes, one per file: the most Vercel's Hobby plan deploys.
A 13th fails the whole deployment, so a new route means retiring or merging
one. `api/_lib/` is shared code, not a route.

| File | What it does |
|---|---|
| `parse-cahier.js` | Upload: splits a notebook into dated classes, then saves the cards |
| `cahier-parse.js` | Upload: turns the classes into cards |
| `cahier-sync.js` | Linked cahier: turns the doc's unread classes into cards. A body with `notesChecks` is instead the owner's test of how Claude reads a class (`api/_lib/notesChecks.js`) |
| `cahier-daily.js` | Daily cron at 13:00 UTC: syncs up to 40 linked docs. A second schedule, 14:00 UTC, runs the status check on every student instead (`api/_lib/statusDaily.js`); 15:00 and 16:00 UTC run the tests of Claude's marking and of its reading of class notes, each only when due (`api/_lib/evalRuns.js`). Vercel's `x-vercel-cron-schedule` header says which |
| `chat.js` | The tutor. Gives hints, not the answer, until the card's answer is shown. Never writes cards |
| `review-answer.js` | "My answer should be accepted". Saves an accepted answer for that student only; "Accept anyway" skips Claude. A body with `feedback` is instead Claude's review of a piece of feedback and the owner's Apply and Dismiss (`api/_lib/feedbackReview.js`), here because of the 12-route limit. Every verdict is saved to `answer_reviews` (migration_015); a body with `answerChecks` is the owner's list of them and the test made from them (`api/_lib/answerChecks.js`) |
| `fsrs-fit.js` | Once a day per student: fits their own FSRS settings when due, and recomputes memory estimates when the settings change |
| `admin-update-card.js` | Saves a card edit, for any student's own cards despite the name. Uses the service role: edits from the browser under RLS silently did nothing |
| `admin-users.js` | Admin only: every account and its activity. `?view=status` is the latest status check on every student; with `&run=1` they are all checked now |
| `parse-corrections.js` | Admin only: logs corrections that `cahier-parse` learns from |
| `split-senses.js`, `apply-splits.js` | Propose, then write, splits of cards that teach two words. Nothing in the app calls them now |

- Every route checks the caller's Supabase session, except `cahier-daily`,
  which checks `CRON_SECRET`. The service role key bypasses RLS, so a route
  that uses it must check ownership itself.
- What counts as a card, and the code that enforces it, live in
  `parse-cahier.js`. `cahier-parse.js` and `cahier-sync.js` import them rather
  than copy them.
- "Replace my existing deck" deletes only the never-answered cards the upload
  doesn't have. It archives answered ones and leaves lesson cards alone
  (`src/lib/replaceDeck.js`).

### Which model each route runs

| File | Model |
|---|---|
| `chat.js` | `claude-sonnet-5`, effort `low` |
| `review-answer.js`, `split-senses.js` | `claude-opus-5` |
| `review-answer.js`, reviewing feedback | `claude-opus-5-5`, effort `medium`, with Anthropic's fallback model if it declines |
| `parse-cahier.js`, `cahier-parse.js`, `cahier-sync.js`, `cahier-daily.js` | `claude-haiku-4-5` |

No other route calls a model. The tutor's effort is set explicitly: left
unset, the model thought at high effort and the tutor was slow.

### Environment variables

- Server, set in Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ADMIN_EMAIL` (the real admin check; if it is empty, the server uses
  `VITE_ADMIN_EMAIL`), `ANTHROPIC_API_KEY` (the owner's key; the linked cahier
  won't run without it) and `CRON_SECRET` (without it, `cahier-daily` refuses
  every caller, the cron included).
- Browser: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ADMIN_EMAIL`.
  These are public, so they can't be a security boundary: `VITE_ADMIN_EMAIL`
  only decides whether the admin menu items are drawn.
- `.env.example` lists them all.

---

## Who pays for Claude

- Each caller pays with their own Anthropic key, sent in an `x-anthropic-key`
  header. Without one, the route answers 402 and the tutor panel offers
  "Connect Claude account".
- The admin (`ADMIN_EMAIL`) is the exception: with no key sent, the server's
  `ANTHROPIC_API_KEY` pays.
- The linked cahier always uses the server's key: the owner pays for it, not
  the students (owner, 2026-09-24).
- So does Claude's review of feedback, since the reviews are for the owner
  (owner, 2026-10-04). A student's browser can ask for one review per piece of
  feedback it sent in the last 10 minutes, and nothing more.
- The key is kept only in the student's browser (`src/lib/anthropicKey.js`),
  entered at profile menu → "Connect Claude account" (`src/ApiKeyModal.jsx`).
  It is never stored on the server, so the app holds nobody's credentials.
- `api/_lib/auth.js` verifies the Supabase token (`auth.getUser`) rather than
  decoding it, because a decoded token can be forged.
- Always `await` `requireUser` and `requireAdmin`. An un-awaited promise
  counts as true and lets everyone in.
- `tests/suites/auth.mjs` checks that a caller with no session causes no
  request to Anthropic. It counts requests at a stand-in server, because the
  SDK doesn't use `globalThis.fetch`.

---

## Maintenance scripts (`scripts/`)

They are run by hand on the owner's Mac. All but `release-lesson-cards.mjs`
work on the live database: each reads `.env.local` itself and talks to
Supabase and Anthropic directly, importing any prompt it shares with a route.
Nothing is written to the database without `--apply`. The scripts that
rewrite cards back the rows up to `backups/` first (git ignores it, because it
holds other students' cards).

| Script | What it does |
|---|---|
| `status-check.mjs` | Runs the nine status checks on a student's live record, and only reads. It checks the admin unless `--email` names someone else; `--from YYYY-MM-DD` judges from an earlier day, `--tz` sets the time zone for answers saved without one, `--all` shows every detail. Claude runs it on the owner's Mac under the rule in `.claude/settings.local.json`; without that rule auto mode blocks it from reading production. The owner's `.env.local` leaves both admin addresses blank, so pass `--email` |
| `resolve-feedback.mjs` | Lists open feedback; `<ids> --note "…" --apply` marks entries resolved. Never deletes |
| `resolve-disputes.mjs` | Settles old disputed marks in `feedback_submissions`, leaving `uncertain` ones alone: a machine that can't decide shouldn't close a complaint about its own marking |
| `fix-multi-sense.mjs` | Splits cards that teach two words. Never run on the live deck. Leaves archived and lesson cards alone, never overwrites a card (a sense the deck already has isn't added), gives new senses the original's class dates, and backs up before writing |
| `sort-grammar-cards.mjs` | Sorted every live deck's rule and pronunciation cards on 2026-09-24, following the owner's hand sort (`scripts/data/grammar-sort-decisions.json`). `--apply <proposal>` applies exactly what the dry run wrote |
| `merge-duplicates.mjs` | `<verdicts.json> <email> [--apply]`: merges cards already judged, one by one, to be the same card ("la poste" and "le poste" are not). Keeps the answered one and archives the rest. Used on the owner's deck on 2026-09-25/26 |
| `reset-fsrs-seed.mjs` | Put the cards still holding `migration_007`'s guessed state back to not yet seen, in every deck, on 2026-09-14. A dry run since finds none |
| `release-lesson-cards.mjs` | Records new lesson cards in `tests/released-lesson-cards.json`. Run it after adding lesson cards, or the `logic` suite fails |

`package.json` also has `npm run dev` (Vite on port 5173, without the `api/`
routes), `npm run build`, `npm run preview`, `npm test` (see *Testing*), and
`npm run simulate` and `npm run simulate:compare` (see *The status check and
the simulations*). Run `simulate` before changing scheduling.

---

## Migrations

- The owner runs them in the Supabase SQL editor, in number order, after
  `supabase/schema.sql` on a new project. The live database has all of them:
  012 was run on 2026-09-27, 013 on 2026-09-28, 014 on 2026-10-04 and 015 on
  2026-10-06.
- `schema.sql`, 002, 003 and 009 write the admin's email into policies.
  Change it for another project.
- Any of them can be run again except 004, which would blank `card_id` on
  every logged correction, and 007, which would overwrite every answered
  card's French-side schedule with a guess and make them all due at once.

The files:

- `002_parse_corrections`: upload batches, the corrections log, and
  `user_cards.batch_id`.
- `003_user_cards_rls`: owner and admin policies on `user_cards`. Without an
  UPDATE policy, an update "succeeds" and changes nothing.
- `004_parse_corrections_card_id_bigint`: the log's `card_id` becomes a
  bigint, like `user_cards.id`.
- `005_spaced_repetition`: the Leitner `box` (no longer used), and
  `next_due_at` and `lapses`, which FSRS still uses. `next_due_at` can't be
  null.
- `006_fsrs`: the French-side FSRS columns.
- `007_fsrs_reseed`: filled them in on 2026-09-05. `dates` are the classes a
  word appeared in, not reviews; an early 006 took them for reviews.
- `008_card_alternates_per_user`: gives each accepted answer an owner, and
  deleted the old rows, because one student's accepted answer had loosened
  everyone's marking.
- `009_beta_feedback_resolved`: feedback can be marked resolved.
- `010_two_directions`: the English → French schedule (the `en_` columns),
  and `card_reviews`, one row per answer, with no delete policy.
- `011_cahier_link`: `cahier_links`, each student's linked doc and the
  classes already read.
- `012_fsrs_settings`: `fsrs_settings`, each student's own FSRS weights and
  target, and `apply_memory_estimates()`, which only the server may call.
- `013_answer_settings_and_sets`: the settings each answer was scheduled
  with, on `card_reviews`, and `dealt_sets`, one row per set of cards dealt.
- `014_feedback_review`: Claude's review of each piece of feedback, on
  `beta_feedback`.
- `015_checks`: `answer_reviews`, every verdict on a disputed answer (the
  accepted answers kept before then copied in as `kept`); `eval_runs`, each
  run of a test of Claude's work; and `status_reports`, the morning status
  check, one row a student.

---

## UI layout notes

Styles are inline objects: `S` at the end of `src/FlashcardApp.jsx`, colours
and fonts in `T` (`src/theme.js`). `src/styles.css` holds fonts, base styles,
`.chip-row`, keyframes and the two things inline styles can't do (the short-card
rules and `.study-column`, below), and repeats some colours as CSS variables
(keep the two in step).

There is no mobile version: the app is for a computer's browser, and has no
phone layout (owner, 2026-09-29).

Each rule below stops a bug that really happened. The card's size, the space
above and below it, and the panel animation work as one system: change one and
the others move, so read the first two groups together before touching any of
them. Measure layout changes in a real browser, at several window sizes, and
frame by frame if they animate (the `layout`, `reflow`, `motion`, `panels` and
`sidebar` suites do this). Several of these were "fixed" against an assumption
and shipped broken.

### The card and the space around it

- **The desktop page is one window tall** (`shell`: `height: 100vh`,
  `overflow: hidden`), and the card gets the height that is left, so the card
  and its buttons are always on screen together. The Stats and Lessons pages
  scroll inside `main` (`mainInnerScroll`). `minHeight: 0` on `main` and
  `mainInner` is what lets them shrink; without it the buttons are pushed off
  the bottom.
- **The study view has a smallest size, and scrolls below it.** `cardArea`
  stops at 300px (`minHeight: 300`: the card's 170 floor, its 20px margin, the
  110 well); the view is then 460px tall with the class notice up. At 0 the
  answer box ran off the bottom of a short window with nothing to scroll to,
  because `cardArea`'s container type turns overflow into paint no scroller
  reaches. In a window 460px tall or less, `mainInner` scrolls (`.study-column`
  in `styles.css`; sideways hidden). Only then: a scrolling column clips the
  blur shapes behind the card at its edges, which would show on wide windows.
- **The card is sized by its height, with a floor and a cap:** `height: 100%`,
  `minHeight: 170`, `maxHeight: min(375px, 62.5cqw)`, `aspectRatio: 1.6 / 1`,
  so 600×375 at most. Without the floor it collapsed when a panel opened.
- **The cap follows the width** (62.5 is 100/1.6), so the card stays 1.6:1 when
  the column is the tight side; it went nearly square in an 800px window. The
  measuring container is `cardArea` (`container-type: inline-size`, never
  `size`), since `cardWrap` can't measure itself.
- **`cardWrap`'s flex basis is fixed and equal to the card's cap**
  (`flex: 0 1 min(375px, 62.5cqw)`, same `maxHeight`). A wrapper that could
  grow, or stand taller than the card, used up its spare room first, so opening
  a panel slid the card and then shrank it, with a jolt in between. An `auto`
  basis collapses the card to 170px.
- **`cardTopSpacer` puts the card's own middle on the window's middle.** Its
  46px is what sits under the card (the 110px well, `cardWrap`'s 20px margin,
  `mainInner`'s 16px bottom padding) less the ~100px of bars above `cardArea`;
  without it the card sat 118px too high. `cardArea` has no bottom padding;
  don't add one. The spacer shrinks at factor 2 (`flex: 0 2 46px`), fast
  enough to give up its space before the card does and slow enough not to hit 0
  mid-animation, which at 4 or 8 made the card change speed mid-move. Factor 2
  was measured when the spacer was 106; at 46 its share of a squeeze is
  smaller, so it bottoms out later, and `reflow` and `motion` still pass.
- **`safe center`, not `center`,** on `cardArea`, `cardWrap` and the card's
  front face. When there isn't room, plain centring spills upward over the
  counter and Previous card, or cuts off the top of a long prompt; `safe` falls
  back to the top.
- **Everything under the card sits in `belowCard`, at least 110px tall.**
  `cardArea` centres its contents, so controls that change height move the card
  (it jumped 45px on grading). 110 is a minimum: anything taller grows the well
  and moves the card. It was 170 until 2026-09-30, sized for a graded answer
  stacked three rows deep, and on a short window those 170px came off the card.
  The tallest common states now are the answer box plus Show answer (~82px) and
  a graded answer whose links wrap to two lines (~107). Flip mode keeps one
  button row: Show answer, then Again / Got It in the same place. `layout`
  checks the card stays put.
- **Type mode's graded state is one 420px column** (`S.typeFeedback`, the width
  of Again and Got It), laid out as a grid: the result banner and Continue side
  by side on the first row, Continue at its own size; then one centred row of
  12px links across both columns, 32px apart ("My answer should be accepted",
  "Mark for review", "Ask the tutor", each only where it applies). About 80px,
  inside the well. The dispute result that replaces the links (a reason plus
  "Accept anyway") hasn't been measured; a long reason grows the well and moves
  the card. Correct answers get a green banner.
- **Card text sizes to the card, not the window.** The two faces are the
  measuring containers (`container-type: size`), and the prompt
  (`clamp(19px, 10.7cqh, 40px)`), answer and instruction line scale with them.
  Full containment stays off the turning card (`S.card`) and anything that
  contains it, since it can flatten the 3D flip. That is a precaution: the flip
  measured fine either way (2026-09-06), whatever the comment on `S.card` says.
- **A short card makes room instead of overlapping.** The fonts stop at their
  floors and the lesson label and tap hint are pinned to the card's edges, so a
  lesson card at 170px (label, two-line instruction, prompt, speaker) needed
  ~140px of content in 114px: the label sat on the instruction and the speaker
  on the hint. Container queries in `styles.css` ask each face its height
  (content box, the card less 56px of padding): below a 270px card the label
  moves into the top padding (`.card-badge`), the instruction's gap tightens
  and the speaker drops from 52px to 36px (`.card-audio`); below 206px the tap
  hint goes (`.card-hint`; clicking still turns the card). `!important`,
  because the rest of each element's style is inline. Nothing outside the card
  moves, and a panel reflow never crosses these heights.
- **The corner controls are matching 30px circles, 14px in:** the pencil
  top-right on the answer side; the turn-back arrow top-left once the answer
  has been seen (never before, or it would be a way to peek); the flag
  bottom-right, moved left (`right: 50`) to sit beside the ⓘ on the question
  side in flip mode, and hidden while the feedback panel is open. Each stops its
  own click, so it never flips, continues or grades the card.

### The side panels and the page

- **Three panels, one at a time.** Opening the tutor, the lesson notes or the
  feedback panel closes the other two (`openChat`, `toggleChat`,
  `openFeedback`, `toggleLessonPanel`).
- **The tutor and the notes make room with `padding-right` on `main`**, never on
  the shell, which squeezed the sidebar too. Both are 460px (`CHAT_PANEL_WIDTH`,
  `LESSON_PANEL_WIDTH`, exported so page and panel agree) and move the page the
  same way, though `reflow`'s frame-by-frame checks drive only the tutor. `main`
  has no `padding-bottom`.
- **They sit beside the card only if 680px of column is left**
  (`MIN_REFLOW_CONTENT`: the 600px card plus padding). `roomToReflow` uses the
  sidebar's current width, so they need a window of at least 1,396px with the
  full sidebar, or 1,204px with the rail. In a narrower window they cover the
  app with a scrim. Resizing across that line must switch cleanly: room
  kept and no scrim, or scrim and no room (`reflow` checks this).
- **A panel keeps its mode, beside or covering, until it has finished
  closing** (`reflowRef`); otherwise the scrim flashes over the app during the
  exit.
- **One duration and one curve for everything that moves the page:** 420ms and
  `cubic-bezier(0.22, 0.61, 0.24, 1)` (`PANEL_ANIM_MS`, `PANEL_EASING` in
  `src/lib/motion.js`), for the panels, `main`'s padding and the sidebar's
  width. Three timings at once was what "jerky" turned out to be.
- **Panels animate out as well as in** (`mounted` / `entered`). The tutor and
  the notes start moving two animation frames after they mount, or they just
  appear.
- **The tutor and the notes are rendered into `<body>`** (`createPortal`), so
  the shell's `overflow: hidden` can't clip them if anything containing them
  ever gains a transform or filter. Their full-window wrapper is
  `pointer-events: none`, so the app beside them stays clickable.
- **The tutor and the notes never close on an outside click or on Escape.**
  Clicking the card, or pressing Escape to clear the answer box, used to close
  them mid-read. The tutor closes from its ✕ and the Tutor nav item, the notes
  from their ✕ and the "Lesson notes" chip.
- **Leaving the lesson page closes the notes** (any change of `mode` or
  `lessonFilter`). Otherwise they vanish while `main` keeps its 460px: an empty
  strip with no way to clear it (`regressions`).
- **The study keys work beside a panel, never through one.** Anything covering
  the card is in `overlayOpen`, which blocks Space, Enter and the arrows; a
  panel beside the card doesn't count. The tutor takes the keys only while
  focus is in it or the last click was in it (`pointerInTutorRef`, set on
  `click` as well as `pointerdown`, because a keyboard or scripted click has no
  pointer event): by focus alone, a click on a blank part of the tutor let
  Enter grade the card. The notes take a key only on one of their buttons
  reached with Tab (`notesHaveKeyboard`), because Chrome leaves focus on a
  clicked tab.

### The feedback panel

- **It lives in the sidebar and moves nothing**, because nothing may cover the
  card; the bottom sheet it replaced cost the card ~140px. It is an inset card,
  16px in from each edge (~223px wide), at the bottom of `data-feedback-dock`,
  the stretch between the nav and the account block. The dock's 24px top
  padding keeps it clear of Tutor; while it is open the dock keeps 244px, and a
  short window scrolls the sidebar. Its test marker is still
  `data-feedback-sheet`.
- **It fades and rises over 200ms**, started by a `useLayoutEffect` that forces
  layout, not the tutor's two animation frames, which left it open but
  invisible wherever frames are throttled (headless or background tabs).
- **Three rows on two shared edges** (~278px tall): a 13.5px serif title with
  the ✕; the message box; a 30px row with an "Attach card" checkbox on the left
  and the paperclip and Send on the right. Title, box and checkbox share the
  left edge; box, Send and the ✕'s glyph share the right (the ✕ is pulled 4px
  right for that); `panels` checks both. "Attach current card" didn't fit.
  Paste and drop work anywhere on the panel.
- **The message box starts at 180px**, as the owner asked after a clean-up cut
  it to 112px (`panels` fails below 175), and grows to a 240px text area before
  scrolling. A screenshot sits inside the box, bottom-left; the text's minimum
  drops from 160 to 120px to make room, so nothing below moves.
- **Anything can be sent**, one word or only a screenshot. An empty send
  outlines the box in red rather than adding an error line, which made the
  panel taller; that line is only for a failed send.
- **Closing never loses the draft; only sending clears it.** ✕, Escape, an
  outside click, the "Send feedback" link (a toggle) and opening another panel
  all keep it, and a dot on the link shows it is waiting. A sent message closes
  the panel and shows a toast in its place (`data-feedback-toast`, 5 seconds,
  paused on hover). A failed send keeps the panel open with an error or, if it
  was closed meanwhile, shows a toast that stays until dismissed.
- **The flag on the card opens it about that card**, with "Attach card" ticked
  even if the draft had it unticked. The attached card now carries its row id,
  so Claude's review finds it even after it has been edited.

### View feedback and Claude's review

Asked for by the owner on 2026-10-04: Claude reviews all feedback and serves it
up in a review pane, the owner's own feedback apart from other students'.
Nothing changes until the owner presses a button.

- **Claude reviews each piece of feedback when it is sent.** The sender's
  browser asks once the note is saved, and View feedback asks for any open
  entry still without a review when it opens, three at a time. Claude reads the
  note, the card as it is in the sender's deck now, and any screenshot, and
  saves one of four verdicts on the row (migration_014): a corrected card,
  remove the card, an app problem with a brief for a coding session, or no
  change needed. Each comes with a sentence or three saying whether the
  sender is right and why. A review made before Claude could suggest removing
  a card is asked for afresh when View feedback opens
  (`src/lib/feedbackReviewVersion.js`).
- **View feedback has two sections**, "Your feedback" and "Other students".
  Entries keep the numbers `resolve-feedback.mjs` uses, newest first across the
  whole list, so the two sections' numbers interleave.
- **Apply** writes the corrected card over the card in place, in the sender's
  deck only, so it keeps its schedule, answers and place in any set. It is
  refused if the card has changed since Claude looked ("Review again"), or if
  the deck already has a card with the new front. Applying a fix to the
  owner's own card reloads the deck on screen.
- **"Remove card"** archives the card (`source` gets `archived:`), so it leaves
  study and keeps its answers. It is never deleted. Claude suggests it for a
  card that shouldn't be in the deck, such as "estar", which is Spanish.
- **Revert**, shown after Apply or Remove card while the pane is open, puts the
  card back as it was and reopens the entry. It is refused if the card has been
  edited since.
- **"Copy for Claude"** on an app problem copies the note, the card, Claude's
  review and brief, and the command that resolves the entry, to paste into a
  coding session. That session fixes it and resolves the entry.
- **Dismiss** resolves any entry, keeping Claude's reasoning in the note.
- A database without migration_014 shows the list as before, with a line
  saying to run it.

### The sidebar

- **It minimizes to a 64px rail** (`data-sidebar-toggle`, remembered in
  `localStorage["sidebar:minimized"]`). On the rail the toggle is the first
  item, styled as a nav item so it lines up with the icons. The rail shows
  icons titled with their page, no lesson sub-items, and the avatar with the
  feedback icon beneath it.
- **Opening feedback widens a minimized sidebar** until the panel closes,
  without changing the saved choice.
- **The rail doesn't scroll** (`overflowY: visible`): the full sidebar's
  `overflowY: auto` also clips sideways, which would cut off the 200px profile
  menu. The `sidebar` suite covers all of this.
- **Exactly one nav item is marked**; inside a lesson, the lesson, not Cards
  (`navActive`).
- **The lessons drop down from Lessons** (`lessonsOpen`): listed under it on
  the Lessons page and inside a lesson, folded away on Cards and Stats, with an
  arrow on Lessons pointing down or up to say which. Clicking Lessons opens the
  Lessons page and the list together (owner, 2026-09-30).
- **Every nav item style declares all four border sides, as longhands**, never
  the `borderRight` shorthand. React updates style properties one at a time,
  so a shorthand plus an override left a stale marker (`layout` checks this).

### The toolbar and chip rows

- **The top bar and the sub-toolbar are single rows that scroll sideways and
  never wrap** (`.chip-row` in `src/styles.css`). Wrapping adds a whole line at
  once; a panel opening narrowed the column through that point and the card
  area dropped 39px in one frame. `MIN_REFLOW_CONTENT` can't prevent it, as it
  guards only the column's final width. The scrollbar is hidden because it too
  changes the height. Anything added to these rows must not wrap on its own
  (`nowrap`).
- **"Previous card" keeps its shape when unavailable** (`backBtnOff`), so the
  row never shifts.
- **Inside a lesson its name is a plain title, not a pill**: a pill with an ×
  beside "Lesson notes" read as a second switch. Cards is the way out.
- **Everything and My cahier come first on Cards** (`data-scope`), styled like
  the direction setting because it is a choice of one or the other. Hidden
  inside a lesson, where it means nothing; unlike the type filter it is not
  cleared on entering one, so Cards comes back as the student left it.

### The first-visit tour

Asked for by the owner on 2026-10-06, designed in a clickable mockup first
(`.claude/mockups/walkthrough.html`, on the owner's Mac only, not in the repo).
It walks a new student through the app one part at a time: everything is
dimmed but that part, and a caption beside it says what to do there.

- **It comes up once per account, on the first sign-in** (owner): for a student
  with nothing answered either way round, once the deck has come from the
  server and the lesson sync has put Lesson 1's cards in it. A brand-new
  student lands on Cards with "You're all caught up", since lessons start
  switched off, so the tour starts there. Existing students, who have answers,
  never see it: the first time the app finds one, it notes them as having
  seen it, so "Reset all progress" later doesn't make them look new. An
  account made before the tour that has never answered a card gets it once.
- **That it was shown is kept on the account** (`user_metadata.tour_seen`,
  saved the way the lesson switches are, and read from the server on opening)
  **and on the browser** (`localStorage["tour-seen:<user id>"]`), so another
  computer or a failed save doesn't bring it back. It counts as shown as soon
  as it appears, "Not now" and "Skip tour" included. "Take the tour again" in
  the profile menu, between "How much to remember" and Sign out, opens it any
  time.
- **The steps** are in `src/lib/tourSteps.js`, in order: welcome; Lessons;
  Study on Lesson 1; answering a card; the result and Continue; Show answer;
  how cards come back; Lesson notes; the notes open; Settings; the lesson's
  "In my daily cards" switch on the Lessons page; Cards ("Come back every
  day"); Stats; the Tutor; uploading class notes from the menu under the user
  icon; Send feedback; "You're ready", which puts the student back in Lesson 1.
  Each caption says one thing plainly, with the card or button named (owner's
  wording, approved in the mockup).
- **Some steps ask the student to do something** (`until`): click Lessons,
  press Study, answer, press Continue, press Show answer, open Lesson notes.
  The thing to press gets a pulsing outline and the tour moves on by itself
  once the app's state says it was done. Next still skips such a step. Back
  onto one that is already done stays put rather than moving on again. A step
  that doesn't apply once the page has settled (the result of a card nobody
  answered; a card when the lesson has none to deal) is passed over in the
  direction the student was going. The result step keeps the answer it is
  about, so its caption doesn't change when Continue brings the next card.
- **Highlights appear in place, never slide** (owner, 2026-10-06: "highlights
  shouldn't fly in"). Between steps everything stays dimmed with nothing lit;
  then the highlight and caption appear together where they belong. A step
  whose page is still moving waits for it (`settle`: the notes sliding in, or
  sliding out before Settings). Once shown, the highlight follows its part
  every frame, so a panel reflowing the page or a resize doesn't leave it
  behind.
- **The dimmed part takes no clicks:** a click there only shakes the caption,
  and nothing outside the tour hears it, so a menu a step has opened stays
  open. On a step that asks the student to do something, the lit part works
  as usual. On one that explains, it is only to look at (a click there shakes
  the caption too), so the tutor or the upload window can't open under the
  dimming; the settings, the notes and the lesson switch stay usable
  (`touch`).
- **Show answer is shown only on a card never answered that way round**, so a
  student taking the tour again isn't led to record a miss on a card they
  know. Back past an answered card goes to the lesson, not to a caption asking
  for an answer already given.
- **Keys:** only on the steps where the student works the card (answering,
  the result, Show answer) do keys reach the app. On every other step the tour
  has them (Enter or → for Next, ← for Back, Escape to close) and the app gets
  none, so a key pressed to move the tour on can't turn or grade the card
  behind the dimming (a flip-mode student's Enter is Got It). A key on one of
  the caption's own buttons presses that button.
- **In a window too narrow for the notes to sit beside the card** (see *The
  side panels and the page*), they cover it, so the two notes captions say so
  instead of "beside your cards".
- **The caption** goes beside the lit part on the first side with room (each
  step says which sides it prefers), with an arrow to it; with no room on any
  side it overlaps on the roomiest side, without an arrow. It sits above every
  panel and modal (`zIndex` 20000), rendered into `<body>` (`src/Tour.jsx`).
- **What it points at** is found by `data-tour` markers (`nav-cards`,
  `card`, `well`, `answer-row`, `continue`, `notes`, `avatar`, `upload`…),
  `data-tour-lesson` / `data-tour-study` / `data-tour-include` on the Lessons
  page, and the existing `data-lesson-toggle`, `data-settings-toggle`,
  `data-settings-menu`, `data-feedback-toggle`. Changing one of those elements
  means keeping its marker.

---

## Testing

`npm test` runs every suite in `tests/suites`; `npm test -- layout` runs only
those whose name contains "layout". `tests/README.md` describes each suite and
lists the `data-` markers the suites find elements by. `npm run simulate` and
`npm run simulate:compare` are separate (see *The status check and the
simulations*). For running the suites on the owner's Mac, see *Working
protocol*.

- `tests/run.mjs` runs each suite as its own process, the browserless ones
  first. Its `NEEDS_BROWSER` list decides which is which, so add a new
  browserless suite to it.
- For browser suites it writes a throwaway `.env.local`, starts the mock
  Supabase (port 5999) and Vite (5173), and cleans up afterwards. It refuses to
  overwrite a real `.env.local`.
- `tests/mock-supabase.mjs` serves a fixed 15-card deck and stores nothing.
  Every write gets an empty success, except a PATCH that sets a NOT NULL column
  to null, which it refuses as the live table does. Suites that need writes to
  stick serve their own store through `page.route`. It also answers
  `/auth/v1/user` with the test user, keeping what the app saves in
  `user_metadata`: a bare `{}` there would replace the signed-in user.
- A deck of nothing but unstarted lesson cards shows no card on Cards, so
  `openApp()` would wait in vain: such a suite serves `/auth/v1/user` with
  the lesson switched on (`lessons`, `lesson-sync`).
- `tests/harness.mjs` opens the real app in headless Chromium, signed in with a
  fake token. `openApp()` starts in flip mode unless given `studyMode` (`null`
  means a new student, who gets typing). `APP_URL`, `MOCK_URL` and
  `CHROME_PATH` override its defaults.
- Browser suites assert on measured values (geometry, computed styles, what was
  written), not on what the code intends.

### The suites

Sixteen need no browser:

- `logic`: the pure rules, from card types and prompt cleaning to
  `reconcileLessons` and the released-lesson-cards list.
- `apply-splits`: `api/apply-splits.js`: ownership, and which row keeps its
  schedule; and the corrections log saving a correction.
- `auth`: no endpoint that spends money reaches Anthropic without a verified
  session.
- `dates`: the student's 4am-to-4am day, and FSRS counting days the same way,
  in a pinned time zone.
- `adaptive`: a student's own FSRS settings and `api/fsrs-fit.js`, on a
  simulated student.
- `serving`: which cards make a set of 50, and in what order.
- `cahier-sync`: the linked cahier, with a stand-in database, doc and Claude.
- `progress`: the seen / about N remembered / not yet seen calculation.
- `instructions`: the line saying what to type, and lesson cards never
  replacing a student's own.
- `grammar-sort`: `scripts/sort-grammar-cards.mjs`, with stand-ins.
- `status`: the status check on a simulated student: a clean record passes,
  and each fault planted in it fails its check.
- `status-script`: `scripts/status-check.mjs` against a stand-in Supabase,
  sending only GETs.
- `feedback-review`: Claude's review of feedback and Apply and Dismiss, with a
  stand-in store and Claude: who may ask, Apply changing only the card's text,
  and refusing a card that changed after the review.
- `status-daily`: the status check on every student, against a stand-in
  Supabase with three accounts, each judged on their own record.
- `answer-checks`: Claude's marking of disputed answers, with a stand-in for
  Anthropic: what Claude should have said, taken from what the owner did;
  when the test is due; and when the red dot lights.
- `notes-checks`: Claude's reading of class notes, tested against the owner's
  corrections, with a stand-in store, notebook and reading.

Eighteen drive the app in a browser. `openApp` opens every one as a student
who has seen the first-visit tour, unless it passes `tour: true`; `ready`
says what to wait for when a page has no "Previous card".

- `layout`: the card fits the window; the tutor moves the content column, not
  the sidebar.
- `panels`: the tutor and feedback panels: one at a time, what closes each,
  and the feedback draft.
- `sidebar`: the sidebar minimized to a 64px rail.
- `motion`: the page holds still while the feedback panel opens and closes, and
  the tutor keeps pace with the page.
- `reflow`: nothing jumps while a panel opens or closes, sampled every frame.
  Start here when a panel looks wrong.
- `lesson-sync`: new and existing decks get every lesson and keep their own
  cards, against a working in-memory `user_cards`.
- `lessons`: L'impératif's notes panel, its set starting at card 1, and the
  top-bar figure.
- `regressions`: bugs found by driving the app, each with the check that would
  have caught it.
- `answering`: answers off the happy path (accepted answers, Previous card,
  failed saves, the way round, Reset, Mark for review), judged by what is
  written.
- `cards`: the prompt hides its English gloss, and the banner shows what you
  typed.
- `session`: a set worked to its checkpoint, Continue, the keyboard, and one
  FSRS answer per card per day.
- `set-size`: a new "Cards in a set" changing the set on screen, against a
  routed deck of 160 cards, since the stand-in deck is too small for a set of
  30.
- `stats`: the Stats page, every figure counted from the suite's own fixture.
- `types`: the Grammar / Vocab / Phrases filter, and no By type on Stats.
- `statusline`: the admin's Status line, on a second Vite (port 5176) with the
  test account as admin.
- `settings`: "How much to remember", including before `migration_012`.
- `tutor`: the answer streaming in, the deck context sent, and editing a
  proposed card.
- `tour`: the first-visit tour, as a brand-new student whose empty deck the
  lesson sync fills: it comes up by itself and is saved as shown; every step
  lights and outlines the right part; the steps the student does move on when
  done; highlights appear in place (sampled every frame); clicks on the dimmed
  part do nothing; Enter on a step that explains leaves the card alone;
  Finish lands in Lesson 1; never again after a reload, on another computer,
  or for a student with answers; "Take the tour again".

### Rules for writing checks

From `tests/README.md`, each learned from a check that misled:

- Write the check from the requirement, not from the code you just wrote.
- Don't hard-code a number about the fixture; read it back (`servedDeck()`). A
  word is asked both ways, so for a first set use `firstBlockItems()`.
- Don't assume a figure on screen counts the way you would; compare its own
  text before and after the action.
- Judge a movement against the move it belongs to, not a fixed number, and
  judge the typical frame rather than the worst of noisy samples.

From this project's history:

- Judge an answer by what was written, and check the columns: a French-side
  answer writes only the plain columns, an English-side one only the `en_`
  ones.
- A stand-in database must refuse what the live one refuses
  (`USER_CARDS_NOT_NULL` in the harness, `REQUIRED` in `cahier-sync`). Twice a
  lenient stand-in passed a write that then failed on the live app.
- Find elements by a `data-` marker the component owns, never by their text or
  their place in the page.
- Leave the app in a known state between sections. A panel left open turns the
  next click into a dismissal.
- A reload brings back the set on screen. For a fresh set, clear `study-place:`
  from localStorage after the last save (400ms after the last change).
- Measure after `settled(page)`, which waits for `getAnimations()` to finish.
- If you change layout, measure it in a browser.

---

## Lessons

A lesson is a fixed set of cards made from a teacher's materials, the same for
every student. Lessons are in `src/data/lessons/`; `LESSONS` in `index.js` is
the catalogue. There are seven: L'impératif (108 cards, from Laura Caufour's
LFL METHOD sheets), Adjectif ou adverbe ? (81 cards, written for the app), and
her beginner Leçons 1 to 5, titled in English in the app (owner, 2026-10-06):
Lesson 1 · Être (57), Lesson 2 · Aller (63), Lesson 3 · Avoir (62), Lesson 4 ·
-er verbs (78) and Lesson 5 · Vouloir and pouvoir (58).

- **The Lessons page, the sidebar and Stats show `LESSON_GROUPS`**, not
  `LESSONS`: Lessons 1 to 5 come first, under the heading "Basic Lessons", in
  number order (owner, 2026-10-06), though Lesson 1 was added after Lessons 2
  to 5. The other lessons follow, under "More lessons" on the Lessons page
  and with no heading in the sidebar, where the indent sets them apart.
  `LESSONS` keeps the order lessons were added in, because a lesson's place
  there is part of every one of its cards' rank. "Basic Lessons" has its own
  arrow, in the sidebar and on the Lessons page, and folds its five away; the
  sidebar never folds it over the lesson open.

- A card is `[front, back, category, section, previousFront?]`. The front is
  always the French, because the app reads it aloud and cleans it as French.
- A lesson also has `notes`, `teachingOrder` (its sections in the order they
  are met) and `instructions` (one line per section saying what to type).
- Every lesson is in every deck. On each page load `reconcileLessons`
  (`src/lib/lessonSync.js`) compares the lessons with the deck as fetched from
  the server, never the browser's saved copy, and writes only the difference.
- The lesson is the authority: missing cards are added, and cards it no longer
  has are taken out.
- A lesson card's row has `source = "lesson:<id>#<key>"`. The key hashes the
  card's first front (`lessonCardKey` in `src/lib/lessonSource.js`) and is its
  identity.
- Rows from before keys existed are matched by front and given a key. An
  unkeyed row that matches nothing is left alone, since it may be one the
  student edited.
- A dropped card is deleted only if it was never answered either way, which the
  delete re-checks in the database. An answered one is archived with its
  answers, and comes back with its history if the lesson brings it back with
  the same front (owner, 2026-09-25). A card that Reset all progress put back
  to new counts as never answered; see *Open items*.
- A lesson card whose front the student already has as their own card is not
  added (`taken`). The upsert on `(user_id, front)` would overwrite theirs.
- A changed answer alone is not written to existing rows, but marking also
  accepts the lesson's current answer (`lessonBackFor`).
- `tests/released-lesson-cards.json` lists every card ever released. The
  `logic` suite fails if a listed card no longer matches its lesson (unless
  moved to `retired` by hand), or if a lesson card is missing from the list.
  After adding cards, run `node scripts/release-lesson-cards.mjs`.
- Inside a lesson, `lessonFilter` narrows the cards a set is dealt from, as the
  type filter does, so FSRS still schedules them. New cards come in teaching
  order.
- In normal study, a lesson's cards come up only if the student has switched
  it on (below). Then they come back when due, and unseen ones come after all
  of the student's own notes.
- Students enter a lesson from the Lessons page or from the list that drops
  down under Lessons in the sidebar, and leave it with Cards. The lesson's name in the top bar is a label, not a control.
- The notes (`LESSON.notes`, shown by `LessonPanel.jsx`) are for glancing at
  mid-card: tables, two-column contrasts, and the common mistakes called out.
  How to write them is in the lesson-building skill
  (`.claude/skills/building-lessons/SKILL.md`).
- The only line inside the notes is the one under a table's column names; a
  subheading is set off by space alone (owner, 2026-10-04: there were too
  many lines). The `lessons` suite checks this.
- Under the title the panel credits whose materials the lesson is from. A
  lesson written for the app sets `creditInNotes: false` and shows no line
  there (owner, 2026-10-04); the Lessons page still shows its `source`.
- Only the notes panel's ✕ and the Lesson notes button close it, because it
  stays open while you answer. It also closes when you leave the lesson, and
  reopens on its first tab.

### Which lessons come up on Cards

Not every class has reached every lesson, so each lesson has a switch, "In my
daily cards", on the Lessons page (`data-lesson-include`), and Cards can be
narrowed to My cahier (owner, 2026-10-04; `src/lib/lessonChoice.js`).

- **Off, a lesson's cards are not dealt on Cards.** Nothing is deleted: they
  keep their schedules and answers, Study still opens the lesson, and
  switching it back on picks up where the student was. The line beside the
  switch says how many of its cards are due while it is off.
- **Without a choice, a lesson is on if the student has answered any of its
  cards either way round** (`startedLessons`), so nobody's reviews went
  missing with the update. One they haven't started is off, as is any lesson
  added later.
- **Except the basic lessons, Leçons 1 to 5, which are on without a choice**
  for every student, old and new (`ON_BY_DEFAULT`; owner, 2026-10-06). No
  account had a choice for any of them when this landed, so all were switched
  on with nothing written to an account. A student who switches one off keeps
  it off. L'impératif and the adverbs still start off.
- **The first answer inside a lesson switches it on**, by then the class has
  reached it. Only the first, so a student who switches it off again isn't
  overruled by studying it.
- **Reset all progress** makes every lesson unstarted again, so a lesson that
  was on only because it had been started goes off. One switched on by hand,
  or by a first answer inside it, stays on.
- **My cahier** deals every card that isn't a lesson's: classes from the
  linked doc, uploads, and words added from the tutor (owner, 2026-10-04). It
  keeps a set of its own.
- **Switching a lesson changes the set on screen like a fresh deck does**:
  what has been shown, answered or lined up for a retry stays, and the cards
  not yet reached are dealt again (`switchSig`, `dealtSwitchRef`). A set under
  way is read back from `poolFrom`, which ignores the switches, so a card
  already shown can't drop out and move the student's place.
- **The choices are kept on the student's account**, in Supabase's
  `user_metadata.lessons_in_cards` (`{ lessonId: true | false }`), so they
  are the same on every computer, with no migration. They are read from the
  session and once from the server on opening (`getUser`). A failed save puts
  the switch back and says so.
- **A student who has studied everything switched on** sees "You're all
  caught up" on Cards, with a line saying lessons come up once switched on
  (`data-lessons-off-note`) while any lesson is off.

### Card-design rules the impératif module established

- Every card asks for something to produce, never a rule to recite.
- Every card answered in French has an arrow (→) in its front. `classifyCard()`
  and `answerLang()` rely on it, and on lesson cards and drills it turns on
  exact marking (accents are still ignored).
- A drill names the mood in its front: `finir (impératif) → tu`. Students
  missed the lesson badge on the card, and *finis* is also the présent.
- To reword a card, keep its old front as the fifth element, or everyone's
  copy is taken out of study and the new wording dealt as unseen. The sync then
  rewrites rows still showing the old wording, and leaves edited ones alone.
- Sample exercises; don't transcribe them. Each card must teach something no
  other card does.
- Every lesson grammar card has a line saying what to type: a drill's comes
  from its front (`drillInstruction`), any other from its section's line.
  Phrase cards are translations and get none.
- The line never gives the answer away. Two sections using one cue for
  different answers get the same line: `cher → Ces chaussures coûtent ___` is
  *cher*, `cher → Une victoire ___ acquise` is *chèrement*.
- Two answers deliberately differ from Laura's sheet: *Donnez-lui* (the sheet
  has *Donne-lui*), and *Ne prends pas de douche*.

### Adjectif ou adverbe ?

`adverbes.js` covers adverbs from adjectives and the pairs English speakers mix
up: bon or bien, coûter cher but chèrement acquis, -amment or -emment, the
-ment false friends, enfin or finalement. It was checked by independent reviews
(native teacher, dictionaries, marking, curriculum), cut from 124 drafts to 81,
and approved card by card by the owner (2026-09-24). Every card is a grammar
card, shown in French.

- The false friends have no arrow: French shown, English typed, one way only.
  Asked the other way, they marked correct French wrong, because several French
  words fit one English meaning.
- There are only three -ément cards: accents are ignored everywhere, and here
  the accent is the point.
- A gap card never puts its cue in parentheses. `cleanFrenchPrompt` strips a
  parenthetical that repeats a word of the answer, and the cue is often the
  answer.
- The notes leave out the spelling asides (gai → gaiement, the circumflex in
  assidûment, fou / mou / nouveau), at the owner's request (2026-09-25).
- The notes were rebuilt on the impératif's model and reviewed by the owner
  line by line (2026-10-04): four tabs, Use · Forms · Expressions · False
  friends, each opening with its rule in one sentence. The vowel rule is put
  as "drop the -e after a vowel", so fou → follement no longer contradicts it.

### Leçons 1 to 5

`lecon1.js` to `lecon5.js` are the first lessons of Laura's beginner course,
from her Google Drive folder Français → Leçons 1 à 20 (lesson, exercises,
answer key; Leçon 4's key only exists in her Spanish-speaker version, with
the same French answers). Leçons 2 to 5 were built 2026-10-04, their notes
reviewed by the owner tab by tab and released 2026-10-05; Leçon 1 was built
and released 2026-10-06. Leçon 1's silent-letters section has no cards and no
tab: no typed card can check pronunciation.

- Her answers stand where her key gives one; each header comment lists every
  departure. Her vocabulary lists became word cards. Dictation, oral answers
  and the true/false and story questions were left out: none can be a typed
  card.
- The notes follow the building-lessons skill. No word lists: the cards are
  how the words are learned (owner, 2026-10-05). Leçon 4 has no Use tab: her
  section on verb groups was dropped, and regular or irregular is said in two
  lines under Forms (owner, 2026-10-05).
- A phrase card's typo tolerance lets "Je suis bien" pass for "Je vais bien",
  the être / aller mistake Leçon 2 warns about. Cards marked exactly carry
  that contrast instead; a real fix is a marking change, not proposed yet.

---

## Progress and the Stats page

Progress is shown as seen, about N remembered and not yet seen. One
calculation, `src/lib/progress.js`, serves the checkpoint, the lesson top bar
and the Stats page, so they always agree.

- Seen: cards answered at least once, either way round.
- Remembered: the sum of each card's chance of being right now (FSRS's
  retrievability). It rises with study and falls without it.
- A word or phrase counts as remembered only both ways, from French and from
  English (owner, 2026-09-14). Its chance is the product of the two, which errs
  low, the safer side. A grammar card counts its one way.
- A word met only one way counts for nothing yet. Its other way waits for a
  later day.
- A way round whose last recorded answer was wrong counts for nothing until a
  later recorded answer is right (owner, 2026-09-25). A same-day retry is not
  a recorded answer.
- Time since the last answer is measured exactly (`scheduler.forgetting_curve`
  with fractional days). `get_retrievability` rounds down to whole days, and
  made every card answered in the last 24 hours read 100%.
- The wording is "about N remembered" (on the Stats page "~N remembered",
  owner, 2026-10-06), never a bare number, and never "mastered", "known" or
  "learning" (owner, 2026-09-12).
- Students never see the two ways round apart, on any screen or message
  (owner, 2026-09-14).
- The figure is worked out when a set is dealt and at its checkpoint, not after
  each answer. It is allowed to fall.
- The checkpoint lists what each area gained (see *The checkpoint*). Inside a
  lesson, the top bar reads "N/M remembered".

### The Stats page

The Stats page is the `mode === "stats"` branch of `src/FlashcardApp.jsx`; the
chart, the calendar and Progress by Lesson are in `src/StatsSections.jsx`. The
owner agreed it from a clickable mockup on 2026-10-06. Every number on it names
what it counts, and figures side by side add up.

- Today: "64 cards", then "21 new · 29 reviews · 14 retries". A review is a
  card back from an earlier day; a retry is a card missed earlier in the same
  set (not counted by FSRS). Read from `card_reviews`, plus answers on this
  page still being saved. Until the record is read, each card's last answer
  stands in, with no split.
- Right first time today: "37 of 50 cards (21 new + 29 reviews)". Retries
  aren't first tries.
- Streak: consecutive study days in `user_review_dates`.
- ~N remembered, day by day: a line chart, "Last 7 days" or since the first
  answer on record, with "In the last 7 days: ~70 more remembered, 121 new
  cards met." Hollow dots are days not studied. Hovering a day gives its
  figure and its cards in three.
- All your cards: one bar in three bands (remembered, seen but not remembered
  now, not yet seen), and "At your current pace, all seen by May 2029": the
  pace is new cards met over the last 14 days, shown after a week of answers.
- Days you studied: "19 of 23 days since you started on 14 September" ("since
  14 September" when the streak's days go back further), and a calendar of the
  last six weeks shaded by cards studied (under 50, 50 to 69, 70 or more), with
  its legend.
- Progress by Lesson: folds. Basic Lessons is one row, its lessons added
  together, folding open to each lesson; then every other lesson; then "Last
  two weeks of class" and "Older classes" with their dates. Each row ends with
  its change, "+12 remembered in 7 days". All navy, like the rest of the page.
- Reset all progress: every card back to new both ways, in one update
  (`resetColumns()`; `next_due_at` can't be null, so it is set to now). It also
  clears the kept sets, `card_progress` and the streak (owner, 2026-09-14).
- Reset reports a streak delete that row security refuses, and keeps
  `card_reviews`.
- `card_progress` is a legacy tally, still written on every answer. Only the
  admin users table reads it.

Everything over time comes from `src/lib/progressHistory.js`. ~N remembered on
an earlier day is the same sum as now, read at the end of that day: each
counted answer's record keeps the strength it left (`stability_after`), and the
chance falls from there with time. A card's history starts again the last time
it was answered as new, and a card not yet seen now counts for nothing on any
day, so a reset student's chart starts again. Today's point is the live figure.
The record is read whole when the page opens, 1,000 rows a request. On the
owner's 808 answers (2026-10-06) it takes 6 ms, and the reconstructed today
matched the live ~69.

The `stats`, `progress`, `answering` and `types` suites guard all this.

### What the owner took off the page (2026-10-06)

- **By type** (Grammar / Vocab / Phrase): its big figure was "right last time",
  which matched nothing under it.
- **Hardest cards.**
- **A "cards that came back" figure** (share of reviews right, against the
  "How much to remember" setting). Considered and dropped: the app brings
  cards back when it expects about that share right, so the figure sits near
  the setting whatever the student does, and a student can't act on it. The
  setting is a setting, never a "goal". The figure belongs in the status check.

### Why there is no "Coming up" forecast

The page used to chart the cards due on each of the next seven days. The owner
removed it on 2026-09-30. Its numbers counted each way round as a card, so "30
due tomorrow" could be 15 words. And a student can't act on it: a session deals
due cards before new ones by itself. The `stats` suite fails if it comes back.

### Why there is no "mastered" figure

"Mastered" came from the old box system and survived as a 60-day stability
threshold. FSRS has no such state, and the threshold said nothing about what a
student remembers now. The owner decided on 2026-09-12 to drop it for students
in favour of seen and about N remembered; the `stats` suite fails if the word
appears. The threshold went with the spot checks on 2026-09-26. The only
"Mastered" left is an admin-only column in the users table
(`api/admin-users.js`, legacy `card_progress.score >= 3`).

---

## The status check and the simulations

The status check answers the owner's three questions (2026-09-27): are cards
shown the way FSRS says, the way the app's rules say, and in the best way
(the most remembered for the time spent)? The record answers the first two.
For the third it can only compare FSRS's predictions with the results; the
rest needs the simulations. The checks are one pure file,
`src/lib/statusChecks.js`, shared by the app, the terminal script and the
simulations. They judge answers from `CHECKS_START` (2026-09-27) on, each day
running 4am to 4am in the student's time zone; earlier answers followed older
rules and are read only as history.

**In the app.** "Status" in the profile menu is for the admin only
(`VITE_ADMIN_EMAIL`). A red dot on the avatar and a red "!" on the Status line
mean a check failed or couldn't run. The dialog marks each check passed,
failed or waiting and names the cards behind a failure; "Copy details" copies
the report to paste to Claude. It runs on the admin's own record when the deck
loads, when the dialog opens, and on returning to the tab after an hour, and
only reads (`src/useStatusCheck.js`, `src/StatusModal.jsx`).

**In the terminal.** `node scripts/status-check.mjs` runs the same checks on a
live record, read-only, with the service key in `.env.local`. It checks the
admin's record (`ADMIN_EMAIL`, or `VITE_ADMIN_EMAIL` when that is empty)
unless given `--email`; `--from YYYY-MM-DD` starts from an earlier day, `--tz`
sets the time zone for answers saved without one, and `--all` lists every
detail. Claude Code's auto mode blocks Claude from running it because it reads
production, unless `.claude/settings.local.json` allows
`Bash(node scripts/status-check.mjs *)`. The owner's Mac has had that rule
since 2026-09-28 (owner, 2026-09-28); the file is local and not committed.
The owner's `.env.local` leaves `ADMIN_EMAIL` and `VITE_ADMIN_EMAIL` blank, so
there the script needs `--email` with the owner's address.

**What the app records for it.** `migration_013` (run by the owner on
2026-09-28) added two records. Each counted answer in `card_reviews` also
saves the settings it was scheduled with (`target`, `weights`, `time_zone`,
`reps_before`, `lapses_before`), so it can be worked out again exactly, even
on a day the settings changed. `dealt_sets` keeps every set the app deals,
for every student: each card, its way round, why it was dealt and what the
app believed about it (`recordDeal`, `src/lib/dealLog.js`). Neither record
can hold up or lose an answer.

### The nine checks

Following FSRS:

1. Every answer was scheduled the way FSRS says: worked out again with
   ts-fsrs, the estimates to four figures, the gap within its random spread.
   Answers saved before `migration_013` count only if the settings haven't
   changed since.
2. FSRS counted one answer per card, each way, each day: the day's first.
3. Every card's schedule is its last answer's result. Its memory estimates
   may instead be what `api/fsrs-fit.js` recalculated after a settings change.
   Most of the deck back to new at once is Reset all progress, not a failure.

Following the app's rules:

4. Nothing was asked, or dealt as due, before it was due.
5. Due cards came before new ones: missed cards first, then the most overdue.
6. New cards came in the agreed order (see *How a session is built*). The
   rules are written out again here, not borrowed from `orderNewCards`.
7. A new word was met one way at a time.
8. Every card asked came from a set, and none came straight back.

How well it's working:

9. FSRS's predictions match your results, over 30 days. A band of
   predictions fails at 10 points off once it has 100 answers, the whole at 5
   points off once it has 300; under 300 it waits.

Checks 5, 6 and 8 need the set records, so they start the day after the
first recorded set: 2026-09-29 at the earliest.

Two things the set checks leave alone (2026-10-04, after three false alarms
on the owner's record). A set replaced before anything in it was answered,
meaning the next set was dealt in the same place with no answer in between,
isn't judged by checks 4 to 7. That happens when the up-to-date cards or a
class's notes arrive seconds after a set was dealt, and nothing in the first
set was asked. Check 6 also counts a class date only once the app could have
known it. A date after the set's day never counts. A date counts once its
notes had arrived, which is when the first card carrying that date was made
on or after that day, since only a notes upload makes one. Any other date is
uncertain, and an order that depends on it isn't judged.

### Since 2026-10-06: every student, Claude's marking, and tests on GitHub

The owner asked for the checks to meet the standards of a guide to evals
(2026-10-06). Three things came of it, all in the Status window, which has a
tab for each:

- **All students.** The nine checks run on the server every morning (the
  second `cahier-daily` schedule) on every student who has answered a card,
  and the reports are kept in `status_reports` (migration_015). "Check
  everyone now" runs them on demand. A student's failed check lights the
  avatar's alert as the admin's own does. The first run on live data, read
  only, found three accounts with answers and every check passing.
- **Claude's marking.** Every verdict on "My answer should have been
  accepted" is saved, accept or not, in `answer_reviews`, with both sides of
  the card, what was typed, Claude's reason and whether the student pressed
  "Accept anyway". The accepted answers kept before then are copied in as
  `kept`. What Claude should have said comes from what the owner already did
  (`ownerCall`): on their own disputes, "Accept anyway" means accept, asking
  means accept when Claude accepted, moving on means refuse. Another
  student's dispute counts only if the owner marks it; nothing waits on it.
  The server asks Claude about every answer with a call again, three times
  each, with the app's own question and model, and saves the run in
  `eval_runs`. The question carries a version (a hash of its wording and the
  model), so runs before and after a change can be compared.
- **Notes to cards.** Every card the owner fixes or deletes is logged to
  `parse_corrections`, and each one is a case: its class is found in the
  linked notebook (by the card's own dates, or by the class before the
  correction whose text holds it), read again three times the way the
  morning sync reads it (`extractCardsFromBlock`, then `cardsFromExtracted`,
  now shared with `syncUser`), and judged on whether the mistake came back.
  Reached through `cahier-sync` with a `notesChecks` body (the list only). On
  2026-10-06 the 48 corrections made 46 cases (two edits changed nothing)
  from 36 classes, all found. Runs are kept in `eval_runs` as kind `notes`.
  Its version hashes the whole of `api/parse-cahier.js` (the question, the
  model and every step that tidies Claude's reply into cards;
  `cardsFromExtracted` moved there for it) and the two app files it uses.
- **Both run by themselves** (owner, 2026-10-06: "make both run
  automatically", after being asked to mark and press buttons for decisions
  they had already made). Two daily schedules on `cahier-daily` (15:00 and
  16:00 UTC) run a test only when it is due (`api/_lib/evalRuns.js`): never
  run, the version changed, or a week since the last run (less half a day).
  There is no button. Each case is asked three times and comes out pass,
  mixed, fail (wrong more often than right) or untried (no usable answer;
  counts for nothing). The red dot lights only for a case that passed in the
  run before a change of version and fails in the run after it, against the
  same right answer (`api/_lib/evalStatus.js`, through
  `admin-users?view=status`), named in the tab. Between two runs of the same
  version nothing lights it: Claude answers differently by chance, and a
  review found a few borderline cases would otherwise light it most weeks.
  Cases Claude gets wrong are listed in the tab either way. The same answer
  disputed more than once is one case, judged by the strongest call.
- **Tests on GitHub.** `.github/workflows/tests.yml` builds the app, runs the
  simulated students and every test suite on each push to `main`. A failure
  marks the commit and emails whoever pushed. A browser suite that fails gets
  one second try and is named in the summary.

Known about the question Claude is asked, and left as it is so the first
test measures it unchanged: for an English-side card it says "The card showed
the English side" followed by the French text.

Found while building the notes test, 2026-10-06, and not changed: the full
notebook upload of 2026-09-04 made again some cards the owner had deleted or
corrected in April and May. Three are in the deck now ("Naza", "les registres
de langues : familier, courant, …", "Je parle jamais de Pierre." with its
full stop); five more came back and were archived since.

### The simulations (`tests/simulate/`)

`student.mjs` is a simulated student studying with the app's own code, so its
records are shaped like the real tables and the status check runs on them.
Its memory is deliberately not FSRS, so FSRS isn't graded against its own
assumptions.

- `npm run simulate`: weak and typical students, 180 days, every check, in
  seconds. Run it before any change to scheduling or to which cards a set
  takes. The predictions check can't fail it, since the students' memory is
  invented.
- Messy students (`messy` in `simulate`, since 2026-10-06), run alongside
  the tidy ones: on a share of study days the app deals from the browser's
  old copy on opening and deals again seconds later, a class's notes arrive
  partway through a set (cards gain today's date, two are made) and the rest
  is dealt again, the page is reloaded mid-set, or the student detours into a
  lesson's set and comes back. These are what the owner's record showed on
  2026-09-30 and 10-01, and the checks as they were before 2026-10-04 fail
  every messy run with the same three false alarms. With `messy` at 0 a run is
  exactly what it was before.
- What the first messy run found (2026-10-06, known, not fixed): back from a
  detour into a lesson, the set left comes back as it was, so a card just
  answered in the lesson can be asked again, uncounted, sometimes straight
  away. `detourRepeats` tells it apart from anything new, and the runs report
  it without failing.
- `npm run simulate:compare`: the four "How much to remember" choices, in
  about a minute. On 2026-09-27, 95% was never best and cost typical and
  strong students 17–26% more time per card remembered; among the other three
  the winner depended on the student. Nothing was changed, and Automatic stays
  the default.
- The 2026-09-25 browser test (the real app in headless Chrome, with
  stand-ins for Supabase and Claude) is kept here, but isn't one command yet;
  see Open items.

Suites: `status` (each fault the checks exist for fails its check),
`status-script` (the script against a stand-in Supabase), `status-daily` (the
morning check on every student), `answer-checks` and `notes-checks` (the tests
of Claude's work), and `statusline` (browser: the Status line and dialog).

---

## History

This section records why things are the way they are: one entry per working
session, oldest first. The reference sections above describe the app as it is
now, and where the two disagree, the reference sections are right.

### Up to PR #31 — FSRS, the tutor panel, and the first round of UI work

Merged by 6 September: the switch from Leitner boxes to FSRS, the tutor chat
panel, a browser-speech fallback, the Grammar / Vocab / Phrases filter and the
grammar classifier, French gloss stripping, the multi-sense cleanup tool and
the first test suite. PR #31 gave every panel that moves the page one duration
and one curve, and kept the card in one place through a flip and a grade (see
*UI layout notes*).

### 2026-09-08 — Bugs found by using the app and by code review

Ten were found by using the app, six by reviewing the tutor branch. Among
them: a flip-mode session never ended, so each click wrote another FSRS review
(45 on one card in a minute); keyboard shortcuts graded a hidden card behind a
dialog or the lesson panel; and correcting a lesson card deleted its schedule
(see *Lessons*). Rule since: refreshing a user's data in the background must
never clear `loaded`, which blanks the app and its panels (`loadedForUser`).

### 2026-09-08 — The tutor made faster and more specific

The tutor was slow because `api/chat.js` set no thinking or effort, so Opus 5
thought at high effort about every two-word lookup. It now runs Sonnet 5 at
effort `low`, streams, and is sent the cards related to the question, recent
misses and the card on screen. There is no model router on purpose: adaptive
thinking already spends more on a hard question. Proposed cards can be edited
before they are added, which is what makes the cheaper model acceptable.

### 2026-09-08 — The impératif notes rebuilt from Laura's PDF

The old summary had lost Laura's examples and their captions; the notes now
have one tab per section, with every example labelled. Three errors in her
source were corrected rather than copied (`Donnez-lui` for the vous form, a
missing "!", and `Dis-le-moi`, which is not an exception). The panel closes
only with its ✕ or toggle. Inside a lesson the type filter was hidden, as most
lesson cards are grammar, and the Cards nav item became the way out.

### 2026-09-09 — The reflow measured frame by frame

"The reflow is jerky" had been fixed by eye several times. Sampling the layout
on every frame of a panel opening and closing, at nine window sizes, found
four separate faults, all fixed and described in *UI layout notes*. The method
became the `reflow` suite: judge the card's edges against the page's movement,
vary the window's width as well as its height, and run a new check against the
old code to see it fail before trusting it.

### 2026-09-09 — A real test for the lesson sync

Checking that L'impératif reaches a new account found no bug, but showed that
no test could have caught one: the `lessons` suite serves the lesson's own
cards as the deck, and the shared mock accepts every write while serving the
same deck. The new `lesson-sync` suite keeps a real in-memory card table and
checks what the student ends up with (see *Lessons*).

### 2026-09-10 — The tutor panel's layout and streaming

The panel read as a prototype. The input became one growing row level with
its button, the conversation sits just above it, the intro paragraph went, and
the card in view is a chip under the title. The pause before an answer is the
model thinking, now shown as three dots. The jolting came from text arriving
in uneven network chunks; it is now held in a buffer and revealed a little on
every frame.

### 2026-09-11 — The tutor stays open; two maintenance scripts

The tutor no longer closes on an outside click or on Escape, like the lesson
notes. The multi-sense cleanup and the dispute backlog had working code but no
way to run it; two scripts now run them (see *Maintenance scripts*). Laura's
line that the nous imperative is little used was dropped from the notes, as
`Allons-y !` is in her own by-heart list; `On y va` and `On en parle` are
shown instead.

### 2026-09-12 — This document checked against the code

Every figure and mechanism in the reference sections was checked against the
code, and the document was split into reference, History and Open items. In
the code, `classifyCard` now remembers its answer per card, which is safe only
because a card is never edited in place. The answer-dispute admin view had
never worked: it asked for columns the table lacks and showed the error as an
empty list. It is fixed, but nothing in the app opens it (see *Open items*).

### 2026-09-12 — How cards are served, agreed and built

Agreed with the owner and built that day, apart from finish estimates (see
*How a session is built* and *Progress and the Stats page*): blocks of 50 with a checkpoint, due
cards before new ones, recent classes first, and no Study button, as logging
in is studying. Rejected: a daily limit, forecast or time setting for new
cards, hand-made topic categories and fixed sets of 100, since the class dates
already give the structure (owner, 2026-09-12).

### 2026-09-12 — The feedback backlog worked through; archiving added

All twelve feedback entries were worked through, each checked for a pattern,
and cards were corrected in place so they kept their history. Archiving was
added (a `source` starting `archived:`). Feedback is resolved by the Claude
session that fixes it, the log in the app is read-only, and open entries are
numbered 1, 2, 3, newest first, which is how the owner refers to them (owner,
2026-09-12). The numbers shift, so resolve by id after checking the message.

### 2026-09-12 — The feedback panel moved into the sidebar

Clicking away after sending asked "Discard your feedback?" though nothing was
lost, and the page jumped as the sheet grew. Closing now never loses a draft,
and the panel sits in the sidebar. A mockup quietly shrank the message box the
owner had asked for; undoing an owner's request must be pointed out. Owner's
rules: nothing may cover the card; do what is asked, and ask when it is
unclear whether a plan or a build is wanted (owner, 2026-09-12).

### 2026-09-12 — The tutor reviewed and fixed

Asked to list everything worth fixing in the tutor, then to fix it all (19
fixes). The ones that mattered: the header showed the answer on English-side
cards; the tutor could give the answer to a card not yet answered, after which
FSRS recorded a recall that never happened; and Add silently overwrote a card
with the same front (it now offers Replace, which changes only the back).
Tested against a mock, not the real model (see *Open items*).

### 2026-09-13 — The graded typed answer as one column

The graded state of a typed answer was mocked at real size and adjusted twice
with the owner: one column, a green banner when right, Continue centred, the
links in one row beneath (see *UI layout notes*). "Ask the tutor" stayed, as
it opens the tutor already holding the card, the answer and the verdict. This
also fixed the `layout` failure long blamed on the Mac: the wrong-answer state
had been taller than the space kept for it.

### 2026-09-14 — The sidebar can be minimized

A button at the top of the sidebar shrinks it to a rail of icons, as mocked up
with the owner. Send feedback, which opens inside the sidebar, widens it again
while the panel is open. See *UI layout notes*.

### 2026-09-14 — Retries inside the block; the FSRS switch's backlog reset

Studying on the live app, the owner hit "Retry 1 of 21": a miss came back 20
cards later, so every miss after card 30 ran past the end of the block. A
block is now 50 answers, retries included (see *How a session is built*). The
owner also had 708 cards due, most with a schedule guessed by the switch to
FSRS; with the owner's go-ahead those went back to not yet seen on every deck.
Stats now counts today's due cards apart from older ones still waiting.

### 2026-09-14 — Flipping and typing, and unusual paths through a session

Switching between flipping and typing reset the card, so an answer already
seen could be given again the other way. That and every other fault found by
trying unusual paths through a session (an unturned card graded in flip mode,
an accepted dispute saved as a miss) was fixed with the owner's go-ahead; see
*Flipping and typing*. Typing became the default, and the checkpoint's
"review phase" message was removed (owner, 2026-09-14).

### 2026-09-14 — Each way round gets its own schedule; every answer kept

Both ways of asking a word shared one FSRS schedule, though recognising and
producing a word are different skills. Each way now has its own schedule and
every answer is kept (`card_reviews`, `migration_010`). Neither way waits for
the other, students never see the directions, a word counts as remembered
only both ways, and Reset clears both ways and the streak (owner, 2026-09-14).
The first live Reset hit a database rule the mock lacked (see *Testing*).

### 2026-09-24 — The linked cahier

Laura adds each class to the student's Google Doc, but the app read a cahier
once, so the owner's deck had fallen twelve classes behind. Now a linked doc's
new classes become ordinary new cards at once, each class is read only once,
edits to old classes change nothing, and the owner pays for the parsing
(owner, 2026-09-24); see *The linked cahier*. A file-sync tool had damaged
`node_modules`; keep that folder out of iCloud or Drive syncing.

### 2026-09-24 — The adverb lesson, and only cards that can be typed

Asked for: a lesson on adjectives and adverbs, every grammar card saying what
to type, and no card that can't be answered by typing (owner, 2026-09-24).
Built: Adjectif ou adverbe ?, approved card by card; the instruction line;
exact marking for French-answered drills, whose typo tolerance had accepted
the very mistakes they test ("je vend"); and, with the owner's go-ahead, rule
and pronunciation cards taken out of every deck, most becoming ordinary cards.

### 2026-09-25 — Linked cahier syncs fixed

Every sync after linking failed. Each status update used the same database
write that creates the link, sending only the changed fields, and the database
refused it because required columns were missing. The test stand-in accepted
any such write, so the tests never showed it. Linking now writes the whole
row, every later update is a plain update, and the dialog shows the server's
reason for a failure (see *The linked cahier* and *Testing*).

### 2026-09-25 — Answer tracking audited; blocks dealt from an old deck

The owner saw "Card 2 of 50" after moving from a lesson to All, and asked
whether answers were recorded. They were, and every schedule was right; a new
set had been dealt. But the block of 2026-09-23 came from a five-day-old copy
of the deck saved in the browser. That was fixed the same day (`f99a92a`); see
*The deck a block is dealt from*. The owner kept lesson blocks shuffled and
set the rule that no update may cost a student progress (owner, 2026-09-25).

### 2026-09-26 — Replacing a deck and reloading no longer lose progress

"Replace my existing deck" deleted every card and its answers without asking;
now answered cards are archived instead (`3bab226`). The set on screen
survives a reload (`375fd1f`); a new day starts a new set, and each browser
keeps its own place (owner, 2026-09-26). Another session meanwhile made the
day run 4am to 4am, dropped spot checks (`104c6fd`), and added each student's
own FSRS settings, "How much to remember" (`191a721`).

### 2026-09-26 — The instruction line in italics, on one line

Of five options, the owner chose to keep the instruction above the prompt, in
italics, cut to one short line (owner, 2026-09-26). Under the prompt was
rejected because the student reads the prompt first and starts answering;
along the top of the card is further from the word and crowded by the lesson
badge; a large verb alone would make drills look unlike every
other card. See *Card types*.

### 2026-09-27 — The Status check and the simulated students

Asked for: a Status line in the profile menu, with an alert, saying whether
cards are shown as FSRS and the app's rules say (see *The status check and the
simulations*). It runs in the app for the admin; a terminal version followed
the next day.
Over 180 simulated days, a 95% target was never best, costing typical and
strong students 17–26% more study per card remembered; the best of Automatic,
85% and 90% depends on the student, so the default stays Automatic.

### 2026-09-27 — Accepted answers, Previous card and retries

Asked how an answer is recorded when "My answer should be accepted" overturns
a wrong mark, or when a card is redone or gone back to. Most was right; six
faults were fixed (`2263aae`), among them a late result landing on whichever
card was on screen, Stats "Today" leaving out retries, and a banner still red
after an acceptance. Moving on before the check returns keeps the answer wrong
(owner, 2026-09-27). Not yet tried on the live app.

### 2026-09-28 — The status check in the terminal; this document rewritten

The owner ran `migration_013`, so counted answers now save their settings and
every dealt set is recorded. `scripts/status-check.mjs` runs the nine checks
on a live record from the terminal, read-only (`f476e48`). This document was
checked against the code section by section and rewritten shorter and plainer
at the owner's request; History became this log, and the problems the check
turned up are in Open items.

First run on the owner's live record (2026-09-28): 38 counted answers since
2026-09-27, all scheduled as FSRS says, one a day, each card's schedule its
last answer's, none asked early. The set checks wait for the first recorded
set; the predictions check needs 300 reviews (24 so far: 80% expected, 79%
right).

### 2026-09-29 — No mobile version; four fixes from the document check

There is no mobile version (owner, 2026-09-29), so the phone layout went: the
bottom bar under 768px, the zoom lock in `index.html` and the phone tests. The
problems the document check found were fixed: corrections to parsed cards are
logged again (broken since 2026-09-08); `fix-multi-sense.mjs` no longer
overwrites cards or touches archived and lesson cards, and backs up first; the
link tab says the doc is read once a day and no longer shows the Replace box;
and `README.md` no longer calls migration 007 safe to re-run.

### 2026-09-30 — The lessons drop down from Lessons

The lessons were always listed under Lessons in the sidebar. At the owner's
request they now drop down from it: shown on the Lessons page and inside a
lesson, folded away everywhere else. The suites that pick a lesson in the
sidebar (`lesson-sync`, `lessons`, `regressions`) open Lessons first, and wait
for the notes panel to appear instead of checking at a fixed moment. `lessons`
had never really clicked Lessons: it looked for an element with no children
reading "Lessons", and the button holds its icon too.

### 2026-09-30 — Short windows: the card makes room, and the page scrolls

The owner's screenshot, a window about 520px tall with the class notice up,
showed the adverb card at its 170px floor with the lesson label over the
instruction and the speaker over the tap hint. Three fixes, agreed from a
mockup: a short card moves the label up, shrinks the speaker and, on the
shortest cards, drops the hint; the result and Continue share a row, so the
well under the card went from 170px to 110 and the card from 170px to 255 in
that window; and the class notice goes once a card is answered. A second
screenshot, a window shorter still, had the answer box cut off with no way to
scroll: the card area now stops at 300px and the column scrolls in windows
460px tall or less. `layout`, `reflow`, `motion` and `answering` pass.

### 2026-10-04 — Claude reviews feedback; the owner applies or dismisses

The owner asked for an automated way to fix their feedback and review other
students'. Agreed: Claude reviews every piece of feedback and nothing changes
until the owner acts, in a review pane that keeps the owner's own feedback
apart from other students'. For app problems the owner chose to paste a brief
into a session themselves rather than have a session start by itself each day.
See *View feedback and Claude's review*. Tested with stand-ins for the
database and for Claude (`feedback-review`, `auth`, `panels`), and the pane in
the browser against sample feedback. No real call to Claude was made, as this
Mac has no Anthropic key: the request was checked against the installed
library only.

The same day the owner asked for a Revert button, and pointed out that Claude
had called "estar, a Spanish word, remove it" an app problem: it could only
suggest rewording a card. Claude can now suggest removing one, which archives
it, and Revert undoes either.

### 2026-10-04 — Lessons switched on by the student; My cahier

Some students' classes hadn't reached the impératif, yet Cards dealt its cards
once their own new cards ran out. The owner agreed a switch per lesson and a
My cahier choice on Cards, with a started lesson on by default and the first
answer inside a lesson switching it on; words from the tutor count as cahier.
See *Which lessons come up on Cards*. Kept on the account rather than in a
table so no migration was needed. The status check reads the new set records,
so a set that left out a switched-off lesson's due cards isn't reported. Tested
against the mock with a deck of own cards, a started and an unstarted lesson.

### 2026-10-04 — Sample students, and the used sign-in link

The owner asked whether a tester can just be sent the link, and then for the
sign-up to be tested with sample accounts that never appear among their
students. Four sample students were run on a private copy of the app on the
owner's Mac: a throwaway local database built from `supabase/schema.sql` and
the migrations, the real PostgREST, a stand-in for Supabase's sign-in that kept
the emails in a local inbox, and the `api/` functions with Claude cut off.
Signing up, studying, reloading, a second computer, feedback, the tutor's
request for a key, signing out, and one student being refused every read and
write of another's data all passed. That ran on the code from before the
lesson switches. The one fault was a used or older sign-in link silently
landing back on the sign-in page, so the page now says what happened. The
owner confirmed Supabase's free email sender reaches students outside the
project, since students already use it.

### 2026-10-06 — The first-visit tour, and the name Déjà Review

The owner asked for a walkthrough for new students that lights one part of the
app at a time with a caption saying what to do. It was built first as a
clickable mockup and refined with the owner: it starts from a brand-new
student's first sign-in; highlights appear in place rather than sliding;
captions name the button ("your user icon at the bottom left"); two steps were
added, on how cards come back and on which lessons go into Cards; and it comes
up only on the first sign-in. The app was renamed Déjà Review, and the sign-in
page lost its tagline. See *The first-visit tour*. The new `tour` suite walks
through it; the harness keeps it out of every other suite.

### 2026-10-06 — Stats shows change over time

The owner agreed a new Stats page from a clickable mockup, to show change
rather than a snapshot: today's cards in three figures that add up, ~N
remembered day by day, a pace for seeing every card, a calendar of the days
studied, and Progress by Lesson folding, with Basic Lessons as one row. By
type and Hardest cards went. The history behind the chart is rebuilt from
`card_reviews` (`src/lib/progressHistory.js`). See *The Stats page*.

### 2026-10-06 — Tests on GitHub; the status check on every student; Claude's work tested

The owner asked whether the checks met the standards of a guide to evals, and
then for all of it to be done. Every push to `main` now runs the build, the
simulated students and every suite on GitHub. The status check runs each
morning on every student. Claude's verdicts on disputed answers are kept and
tested, and so is its reading of class notes, against the owner's
corrections. Messy simulated students reproduce the three false alarms of
2026-10-04. At first the owner was asked to mark Claude's verdicts and press a
button to run each test; they objected to confirming decisions already made,
so the right answers now come from what the owner did, and both tests run by
themselves when due. An adversarial review found that a few borderline cases
would light the red dot most weeks by chance, so it lights only for a case
that passed before a change of version and fails after it. See *Since
2026-10-06*.

### 2026-10-06 — A new set size changes the set on screen

Choosing 20, 30, 50 or 100 under "Cards in a set" used to wait for the next
set, so the counter went on saying "Card 1 of 50" after 20 was chosen. Now the
set on screen is dealt again to the new length, keeping the card on screen,
every answer and the retries lined up. See *How a session is built*; the new
`set-size` suite guards it.

### 2026-10-06 — Documentation for readers of the repository

The owner asked for the documentation to be brought up to date and organised
for people looking at the repository, with the evaluation harness to the
fore. `README.md` became a short front page: what the app is, screenshots, the
highlights, how it's built, and that it is built with Claude Code. It links to
five pages in `docs/`: the evaluation harness, how cards are scheduled, how
class notes become cards, where Claude is used, and running your own copy. The
old README's setup steps and scheduling detail moved there. The screenshots in
`docs/screenshots/` were taken against the mock database with the test suites'
sample data, so no student's cards appear. This document and `tests/README.md`
stay where they are. GitHub's one-line description of the repository, which
called the notes handwritten, was corrected at the same time. The page on Claude is `docs/where-claude-is-used.md`, not
`docs/claude.md`: on the Mac's case-insensitive disk, Claude Code reads a file
of that name as a `CLAUDE.md` of instructions.

---

## Open items

In order: the owner's to-dos, bugs, things not yet checked on the live app,
and ideas. One item, the lesson bar by section, is agreed but not built.

### The owner's to-dos

- **Check that `CRON_SECRET` is set in Vercel.** Without it the daily cahier
  check (`api/cahier-daily.js`) refuses to run. Linked docs are still read
  when a student opens the app, so the only sign is classes arriving late.
- **Ask Laura to check the impératif lesson's answers** before other students
  use it. Claude wrote them, because her exercise sheet has no answer key.
- **Decide on the multi-sense cleanup.** `scripts/fix-multi-sense.mjs` has
  never been run on the live deck, so cards mixing two words, like `les frais`
  ("the costs; the expenses; fresh"), remain. It needs the owner's Anthropic
  key, a dry run read through, and a go-ahead.
- **Keep `node_modules` out of iCloud.** The project is on the Desktop, which
  iCloud syncs, and on 2026-09-24 a file sync damaged `node_modules`. Moving
  the project off the Desktop, or excluding `node_modules`, prevents a repeat.

### Bugs and loose ends

- **The upload's prompt is behind the sync's.** `api/cahier-parse.js` lacks the
  sync prompt's rules 8b, 8c and 10b–10e (among them: no card teaching two
  words), so an upload can still make cards the sync wouldn't. Moving those
  rules into the shared `WHAT_BECOMES_A_CARD` block would fix both.
- **Deleting a card deletes its answers.** `card_reviews.card_id` cascades, so
  "Delete card" in the edit modal takes the card's history with it. An
  "Archive" button beside it would be safer; today a card is archived only by
  a script or in the SQL editor (`source` set to `archived:<source>`).
- **The lesson sync can delete answered cards.** When a lesson drops a card
  that Reset all progress put back to new, the sync deletes it, and its
  answers from before the reset with it. `reconcileLessons`
  (`src/lib/lessonSync.js`) looks only at `fsrs_state`; it should check
  `card_reviews` first, as the upload's replace does.
- **An upload without "Replace" overwrites answers and class dates.** It
  upserts on the card's front, so a hand-edited answer is lost on re-upload.
  Schedules are untouched, and the linked cahier only adds class dates.
- **Other decks still have near-duplicate cards.** Only the owner's deck was
  merged (2026-09-25/26); `scripts/merge-duplicates.mjs` applies a list judged
  card by card. The linked cahier no longer adds copies; an upload still can,
  because it matches only the exact front.
- **A few rules in the owner's deck are filed as words or phrases**, such as
  "voie passive" and "double pronoms (COD + COI)", so they are asked both ways.
  The grammar sort only read cards filed `G` or `P`. These few need re-filing
  by hand; most of the 19 word and phrase cards `isGrammarCard` flags are fine.
- **"un article" reads as grammar.** `GRAMMAR_TERM` (`src/lib/cardTypes.js`)
  matches `articles?`, so plain word cards like it show under Grammar in the
  filter and in By type. The term should match only the grammar sense, as
  `accords? (?:du|des|avec)` does. The parser's `keepAnswerable` uses the same
  test, so such a word filed `G` is dropped rather than re-filed.
- **The accent in -ément isn't checked** (précisément vs précisement), because
  accents are ignored for everyone, so English keyboards aren't marked down.
  The adverb lesson keeps only three such cards for that reason.
- **Conjugation tables ignore mood** (`expandConjugations` in
  `api/parse-cahier.js`). Forms go to six fixed persons in order, and a table
  can't be marked `impératif`, so a three-form imperative table would become
  "être → je" = "sois", with an instruction line asking for the present tense.
- **"Flips look jumpy and glitchy" is reported but not reproduced.** The
  reflow part was four bugs, now fixed and guarded by the `reflow` suite; the
  flip animation itself hasn't been measured on its own. Judge it by the
  card's edges, not its height.
- **`reflow` fails on and off on the owner's Mac**, so a failure there proves
  nothing (see *Working protocol*). It measures movement frame by frame, and
  the Mac's headless Chrome delivers too few frames; reading the running
  animation, as `motion` does, would likely fix it.
- **`FeedbackAdminView` is never shown.** It holds the answer-dispute review,
  which has no other screen; "View feedback" opens `FeedbackReviewModal`
  instead. Wire it up or remove it.
- **The Anthropic SDK never updates itself.** Below 1.0 a caret pins the minor
  version, so `^0.124.0` stays 0.124.x through every reinstall. Update it
  deliberately.

### Not yet checked on the live app

Each was tested against the mock or a stand-in only; worth checking signed in.

- **The first-visit tour** (2026-10-06). Sign up with a new address and the
  tour should come up once the app opens; sign out and in again, or open it on
  another computer, and it shouldn't. Saving `tour_seen` to the account has
  only been tested against the mock.

- **The used sign-in link message** (2026-10-04). Ask for a link, open it,
  sign out, and open the same link again: the sign-in page should say it has
  expired or was already used. Checked against the mock and a stand-in for
  Supabase's sign-in only.

- **The lesson switches and My cahier** (2026-10-04). Switch a lesson off on
  one computer and open the app on another: it should be off there too.
  Switch it off mid-set: the count and the card on screen stay. Saving to the
  account has only been tested against the mock.

- **The tests of Claude's work on the real Claude** (2026-10-06). Both have
  run only against stand-ins, since this Mac has no Anthropic key. The first
  real runs are the 15:00 and 16:00 UTC schedules after 4f6c1d0: the next day,
  the Status window's "Claude's marking" and "Notes to cards" tabs should each
  show a run.

- **The class notice closing on the first answer** (2026-09-30). The mock has
  no linked cahier, so the notice never appeared in a test. After the next
  class, answer one card and check it goes.

- **Accepting an answer, Previous card and Stats "Today"** (2263aae,
  2026-09-27). An accepted answer stays right after a reload; moving on before
  the check returns keeps it wrong; a miss changed to right with Previous card
  loses its retry; Stats "Today" matches the end-of-set screen.
- **The set on screen and "Replace"** (2026-09-25/26). Reload mid-set and land
  on the same card; go from a lesson to All and back; answer in another
  browser, then return to this tab; replace the deck and keep answered cards.
- **Two-way study.** In Mixed, words come up both ways; under EN→FR, grammar
  cards are still asked as written.
- **"Due today" shown apart from "older still waiting"** on the checkpoint and
  Stats (2026-09-14).
- **The FSRS fit on Vercel.** The optimizer package (a native Linux binary)
  loads only when a student's fit is due, from about 1,000 counted answers.
  Its first run on Vercel hasn't been seen; if it fails, the student keeps
  their weights.
- **The linked cahier's "last checked" time.** The link has added cards on the
  live app (525 on 2026-09-25), but nobody has confirmed since that day's fix
  that it records when it last checked.
- **A feedback note with a screenshot and no text.** It arrives with an empty
  `message`, which View feedback uses as the entry's headline.
- **The tutor on the real Claude.** The 2026-09-12 fixes were tested against a
  mock: withholding an unanswered card's answer, grammar cards as arrow
  drills, the conversation cache hitting (`usage.cache_read_input_tokens`
  above zero from the second question), and Replace through
  `/api/admin-update-card`. Ask on an unanswered card without answering it, so
  no review is written. The switch to Sonnet 5 (`api/chat.js`) is untested on
  French nuance; 30–40 checked questions on both models would settle it.

### Ideas and unbuilt work

- **The lesson bar by section: agreed but not built** (2026-09-10). This is a
  design, not the app. The lesson's top bar gets chips built on the lesson's
  own sections, so a student can practise one part at a time; the default
  stays All, mixed, because blocked practice tests worse. Cards don't store
  their section and don't need to: `lessonRank` and `cardInstructionFor`
  (`src/data/lessons/index.js`) already look it up by the card's key, and the
  lesson's `teachingOrder` lists the sections in order. The impératif's 14
  sections group by the rule each drills, which the names don't show (`ex8`
  counts as phrases, `ex1` and `ex2` as forms):

  | Group | Sections | Cards |
  |---|---|---|
  | Forms | `forms` 9, `irregular` 12, `ex1` 5, `ex2` 4 | 30 |
  | Pronouns | `ind2imp` 8, `negative` 8, `ex3` 6, `ex4` 5, `ex6` 7, `ex7` 12 | 46 |
  | Reflexive | `pronominal` 10, `ex5` 5 | 15 |
  | Phrases | `phrase` 9, `ex8` 8 | 17 |

  Forms, Pronouns and Reflexive are also tabs in the lesson notes, so a chip
  could open the notes there; the notes' fourth tab is Use, and Phrases has
  none. Agreed with it: a section drill must not write FSRS reviews, since it
  would ask cards whether or not they are due.
- **The end-of-set screen still says "64 answers, 37 right first time".**
  Stats now says "64 cards: 21 new · 29 reviews · 14 retries"; asked whether
  the end-of-set screen should match, not answered yet (2026-10-06). The
  checkpoint also still says "about N", where Stats says "~N".
- **The browser simulation as one command.** Its files in `tests/simulate/`
  point at an old session's temporary folder and the owner's `~/Downloads`,
  and its stand-in database lacks `fsrs_settings` and `migration_013`. It
  needs paths from the environment, a notebook made from `cards.js`, the new
  tables, the status check at the end, and a schema check against a real
  Postgres built from `supabase/schema.sql` and the migrations (Postgres 16 is
  on the Mac).
- **Tune the simulated students to the owner's memory**, from the owner's live
  `card_reviews`. Claude's auto mode blocks reads of production, so the owner
  runs the read or allows it.
- **Private cahiers.** A linked doc is read without signing in to Google, so it
  must be shared as "anyone with the link can view", which some families will
  object to. A private doc needs an OAuth flow and Google's app verification.
- **Speech is browser-only.** The Azure endpoints were deleted rather than
  secured. Bringing them back means putting them behind `requireUser` and, if
  the owner shouldn't pay, a per-user credential like the Anthropic one.
- **A lesson generator.** Turning Laura's lesson PDFs into cards was scoped,
  not built. Leçons 2 to 5 were built from her sheets by hand (2026-10-04);
  her template is the same in all four (dialogue, grammar, numbers, then
  exercises with an answer key), so they are the examples to design from.
- **Two routes nothing calls.** `api/split-senses.js` and `api/apply-splits.js`
  have no caller in the app but count toward Vercel's 12-route limit. Retiring
  them frees two slots; the multi-sense script imports its prompt from
  `split-senses.js`, so that would move into the script. (`split-senses.js`
  also still runs Opus 5 where Sonnet would do.)
- **Stale comments.** Two comments still say adding a lesson copies its cards,
  though there is no add step: the one above the Lessons page in
  `src/FlashcardApp.jsx` and the header of `src/data/lessons/index.js`. Several
  others no longer match the code: in `src/FlashcardApp.jsx`, the one above `answer()`
  (`card_progress` no longer drives Stats) and those on `cardTopSpacer`,
  `cardWrap`, `S.card`, `typeLinksRow` and `cardBadge`; in
  `src/LessonPanel.jsx`, where the feedback panel renders.
