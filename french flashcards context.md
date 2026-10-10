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
Repo: `mlboryczka/french-flashcards`. The owner's test app, deployed from the
`testing` branch, is at
`french-flashcards-git-testing-mlboryczkas-projects.vercel.app` (see *Working
protocol*).

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
  there are 11 (`api/_lib/` doesn't count).
  A 13th fails the whole deployment, as `api/fsrs-fit.js` did on 2026-09-26.

`npm run dev` doesn't serve `api/`, so uploading, the tutor, disputing a mark,
the daily FSRS check and Podcasts work only on the deployed site.

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
  first reply and use `main`, unless the work is for `testing` (below). Work
  pushed elsewhere is invisible to the owner; whole sessions were lost that
  way (2026-09-08, 2026-09-09).

**Except work the owner is trying out first, which goes to `testing`**
(owner, 2026-10-09: "segment the updates i am now making between the
application i use (and will be testing) and the app given to others").
Podcasts is the first such work.

- `main` is the students' app. `testing` is the owner's test app, deployed by
  Vercel at `french-flashcards-git-testing-mlboryczkas-projects.vercel.app`.
  On the owner's Mac it is checked out in the worktree
  `.claude/worktrees/testing`.
- Nothing on `testing` reaches students until the owner says so. Merging it
  into `main` is that release.
- Both apps use the same Supabase database. A sign-in on the test app is the
  owner's real account, with their real cards and progress.
- So every migration made on `testing` must be additive until the release:
  new tables or columns that `main`'s app never reads, nothing changed or
  removed that it does read.
- GitHub runs the tests on every push to either branch (78a4946).

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

**`npm test` before every push.** It runs the 39 suites in `tests/suites` (20
without a browser, 19 in headless Chromium) in about twenty minutes, so start
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
cards, lesson by lesson in `MEETING_ORDER` (`src/data/lessons/index.js`):
L'impératif, the adverbs, then Leçons 1 to 5 in number order, though Leçon 1
was added last (owner, 2026-10-06). A card the student added themselves, from
the tutor or (since 2026-10-09) with "Add to my cards" in Podcasts, is dated
by its `created_at` (`addedByStudent`, `src/lib/sessionQueue.js`). Ties come
in random order.

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
class, each starting with a date line such as "Le 24 septembre 2026". A class
held over two days is one class, dated its first day: "Le 28 et 29 septembre
2026", "Les 28 et 29 septembre 2026" and "Le 28 & 29 septembre 2026" all date
it 28 September (2026-10-07). The owner's notes have one, and until then its
lines were taken as the end of the class above and cut off with its homework,
so no card was ever made from them. A
student links their doc once, in the upload dialog's third tab, "Google Doc
link" (owner, 2026-09-25; `src/CahierUpload.jsx`). Each new class then becomes
cards on its own. There is no tick box: linking is what keeps the deck up to
date. Unlinking removes only the link.

**The owner's rules (2026-09-24, and the plan approved on 2026-10-06: "there
should be NO duplicates from reuploading an updated cahier"):**

- New classes become cards at once, with no review step.
- A line of the notes is read once. A line added to an old class, or a
  corrected one, is read once on its own (since 2026-10-06; before, the whole
  class was left alone). Deleting a line changes nothing.
- A word taught again keeps its card and gains only the class date. Neither
  the sync nor an upload rewrites a card's French, English, category,
  schedule, answers or place in or out of study (the upload did until
  2026-10-06).
- Nothing is ever deleted.
- The deploy owner pays for the parsing (the server's `ANTHROPIC_API_KEY`),
  not the student.

**What has been read** (since 2026-10-06). One record per student,
`notes_read` (migration_016), keeps a short fingerprint of every line already
read, grouped by class date (`src/lib/notesLines.js`). The upload (paste or
file, add or Replace), the linked doc, the daily check, Check now, relinking
and a copy of the doc all share it, and Unlink doesn't touch it. A run reads
only classes with a line not read before, sends the whole class so Claude has
the context, and tells Claude to make cards from the new lines only
(`NEW_LINES_NOTE`, `api/parse-cahier.js`). So an unchanged re-upload asks
Claude nothing and adds nothing. A line is compared with spacing, quotes,
dashes, capitals, a list bullet and a final full stop set aside. A file that
breaks the notes into lines differently (a .pdf can) has those lines read
again, and the matching rule below keeps their cards to one each; this is
reasoned from the code, not tested on a real file. A class whose date line was
retyped is known by its lines and makes no card: at least 80% of them (and at
least 2) are left over under one date, recorded under it and in no class that
still has that date. That covers a class moved onto a date another class
already has, and one of two classes sharing a date being corrected (the
owner's linked notes have "Le 27 octobre 2025" twice, the first almost
certainly meant for the 28th); until 2026-10-06 only a date gone from the
notes counted, and the corrected class was read again from scratch. Where the record has no lines for a class, it counts as read if
its date is on any card, archived ones too, or the link read it; that is how
the record fills itself the first time, without reading anything. One
exception (2026-10-07): the link keeps a fingerprint of each class as it read
it, and where that no longer matches the class's text, only the class's lines
that are on a card the student has count as read, and the rest are read once
(`seedingFrom` in `api/_lib/notesReading.js`, `lineMatcher` in
`src/lib/notesLines.js`). The owner's 2 October class was read when it had 4
lines; it has 16, and the other 12 ("se moucher", "j'ai le nez bouché",
"corriger une erreur", "à partir de lundi" among them) would otherwise never
have become cards. The fingerprint is of the class as the Google Doc's export
gives it, so only the sync and an upload of the doc's link compare it. Pasted
text or a file never matches it byte for byte (a .docx has a blank line after
every paragraph), and on the owner's notes every one of the 50 fingerprinted
classes looked changed, so 21 lines read before would have been read again.
Such an upload counts the class as read and records none of its lines, and
the next sync, on the doc's own text, reads the lines on no card (2026-10-07).
On a read-only copy of the owner's deck and notes, their first run after the
migration, or the first sync after an upload of any kind, reads exactly those
12 lines and the 6 of the 28/29 September class, and nothing else. A line added to a class with no
fingerprint (linking writes "already in your deck" for the classes already on
cards) before its first run still can't be told apart. Before
migration_016 a class is known by its date only, in `cahier_links.classes`
(migration_011), as before. A class Claude fails on is retried on the next
run.

**One run at a time per student.** A run takes the student's turn
(`claim_notes_reading`) and gives it back when it saves. Another run meanwhile
says "your notes are being read already" and reads nothing; an upload is told
to try again in a few minutes, and linking says the new classes come on the
next check. A turn not given back runs out (six minutes for the sync, twenty
for an upload, which spans several requests). An upload renews only its own
turn: if it ran out and another reading took it, even one that has finished
since, the upload saves nothing and says to upload again, because the record
may have changed under it.

**Saving is one step** (`save_notes_reading`, migration_016): the new cards,
the dates added to cards the student has, Replace's changes, Claude's
verdicts and the record of lines read are saved together or not at all. They
used to be separate writes, and a failure between them left cards saved and
the class unread, so the next run added Claude's new spellings beside them. A
card the database refuses (a French side too long for its index) is left out
inside that same step and named in the reply, and the rest is saved; its line
counts as read, so the message says to change the line.

**A word written another way** gets the date on the card the student has,
by one rule shared by every path that writes a card from notes
(`src/lib/sameCard.js`, `src/lib/cardMatch.js`):

1. The sure rule: the same French apart from capitals, spacing, a final full
   stop, "?" or "…", hyphens, an article of the same gender, (e)/(s)
   markers, the labels (adj), (adv), (subj), (imparfait), (m), (f), (pl),
   braces like {fiss}, œ for oe, "..." for "…", a bracket repeating the
   card's own English when the other card's English has one of its words
   too, and in drills "il" for "il/elle" and "que je" for "je"; and English
   that shares a word of substance or is word for word the same ("so", "to
   go"). Filler like "quite", "was", "not" or "how" is no word of substance.
   A final "!" counts only when the English has the same words: "Je pense !"
   (I think so!) is not "je pense" (I think). The bracket and filler rules
   are from 2026-10-06: demarajackson's "pas mal" (not bad; quite good) and
   "pas mal (quite a lot;)" (quite a lot; a good deal) were joined through
   the shared "quite", and her "ça allait" (it was okay) and "ça allait ?"
   (how was it going?) through "was". Both are now near look-alikes.
   A card that is one item of another card's list is that card (the owner,
   2026-10-07: "à l'heure" beside "à temps / à l'heure" is one card twice).
   The sure rule joins them when the item is the card's French by the rule
   above and every word of the list card's English is in the card's English
   (`isListPart`): "épais" and "épais, épaisse", "des yeux" and "un œil, des
   yeux", "Allons-y !" and "On y va / Allons-y". That English test keeps
   apart what a list only seems to hold: a word inside a sentence with a
   comma ("en fait" and "En fait, ça veut dire que"), different words
   grouped on one card ("amener" and "se lever, acheter, amener"), another
   meaning of the same spelling ("fin" (the end) and "fin, fine" (thin;
   fine)). An item whose English is worded differently ("après" (after) and
   "ensuite / après" (then / afterwards)) is a near look-alike, and Claude's
   question now says an item of a list is the same card and names those
   three kinds as different. Inside one reading the list card is the one
   kept, and it takes in every item of it read before it. On the read-only
   snapshot the rule now names 6 such pairs in the owner's deck, 9 in
   demarajackson's, 5 in foisydm's and 1 in nguyen's.
   A new card joins a card the student has in one direction only
   (2026-10-07): a new item joins their list card, but a new list card is
   never joined to one of its items. The item they have gains the class
   date, and each other word of the list becomes a card, unless it is a card
   they have too, or only the feminine, plural or number of the item they
   have (`formsOfOneWord`: "bon, bonne" beside "bon" only adds a date). The
   owner's "taper" (to hit, to strike) was made on 15 April, and "frapper,
   taper" on 4 September only added a date to it, so their one "frapper"
   was lost. Of the 31 pairs in the live decks where the list card came
   after its item, 25 are forms of one word, which still only add a date; 2
   are a list card the student already had; and 4 lost a word, which would
   now become a card: the owner's "frapper" and "une connasse", and
   demarajackson's "célèbre" and "un(e) colocataire". The same when Claude
   calls a new list card the same as one of its items: "après" gains the
   date and "ensuite" becomes a card.
2. Near look-alikes (accents, "ne", articles or brackets set aside; half of a
   list card; the same words or list parts in another order, such as foisydm's
   "amener / apporter" and "apporter, amener (ici)"; "il/elle" for "il", as in
   nguyen's "ils/elles veulent" and "ils veulent"; one word more or fewer; a
   number in digits; a typo of one or two letters) are put to Claude as one
   question per run, "the same card to
   learn, or different" (`api/_lib/sameCardQuestion.js`, `claude-opus-5-5`,
   versioned like the answer checks). It is told what stays apart: ou/où, la
   poste/le poste, fin/fin (adj), un état/l'État, a (fam) meaning, masculine
   and feminine on their own, singular and plural. The pairs go 50 to a
   call, four calls at a time, and no call runs past a time limit (three
   minutes into an upload's save, four into a sync), so the run can still
   save within the function's five minutes: a first upload of the owner's
   whole notebook would ask about 890 pairs. If the question fails or runs
   out of time, those cards wait and their classes stay unread; nothing is
   added on a guess. A card gets a label in brackets only when Claude says it differs
   from one with the same French ("voler (to fly)").

The same rule and question judge the deck itself every morning: "No card is
in your deck twice" (see *The status check and the simulations*).

A new card is compared with every card the student has: in study, archived,
removed and lesson cards. A match only adds the class date, and never brings
an archived or removed card back. Inside one reading the same rule merges a
word taught in two classes. On the owner's 63 groups of repeated cards the two
steps reached all 63, and the sure rule joined no pair outside them.

**When it runs:** on opening the app (at most hourly per browser,
`src/useCahierSync.js`), on linking, on Check now, and daily at 13:00 UTC by a
Vercel cron (`api/cahier-daily.js`: up to 40 docs, least recently checked
first; it refuses to run without `CRON_SECRET`). Reading a doc is free;
parsing a class costs. A run parses at most 12 classes, and the app repeats it
until none are left. The check on opening is skipped if the doc was checked in
the last 30 seconds. Since migration_016 two overlapping runs can't both read
a class: the second is told the notes are being read. A daily check that finds
every class in the record doesn't read the deck at all. The daily job starts
no student's sync after 200 seconds and stops their questions at 265, so it
ends within its five minutes; students it didn't reach come first the next
day.

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

No two new cards may have the same front: the deck holds one card per front,
and a save holding two is refused whole. The matcher gives a card whose French
is taken by a different card a label from its English.

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
   and model are imported from `api/_lib/splitSenses.js`.
3. **Apply:** the original row becomes the first sense and keeps its history;
   the other senses are new cards. Malformed splits are refused.

The script does its own writes, not through `api/_lib/applySplits.js`. It
skips archived and lesson cards, never overwrites a card (a sense whose front
the deck already has isn't added, and new senses are plain inserts), gives new
senses the original's class dates, and backs up the rows it rewrites. Both
files were routes (`/api/split-senses`, `/api/apply-splits`) until nothing in
the app called them; they moved to `api/_lib/` on 2026-10-06 to free two of
the twelve route slots.

The sync's prompt (rule 8c in `parse-cahier.js`) and the tutor's forbid such
cards; the upload dialog's (`cahier-parse.js`) does not.

---

## Serverless functions (`api/`)

There are eleven routes, one per file. Vercel's Hobby plan deploys at most
twelve, and a 13th fails the whole deployment, so one more fits before a new
route means retiring or merging one. `api/_lib/` is shared code, not a route.

| File | What it does |
|---|---|
| `parse-cahier.js` | Upload: splits a notebook into dated classes (`slice`), says which lines are new and takes the student's turn (`plan`), then compares the new cards with the deck and saves them with the lines read (`commit`). The dialog's steps are `src/lib/uploadRun.js` |
| `cahier-parse.js` | Upload: reads the classes with new lines, exactly as the sync does (`extractCardsFromBlock`) |
| `cahier-sync.js` | Linked cahier: turns the doc's unread classes into cards. A body with `notesChecks` is instead the owner's test of how Claude reads a class (`api/_lib/notesChecks.js`) |
| `cahier-daily.js` | Daily cron at 13:00 UTC: syncs up to 40 linked docs. A second schedule, 14:00 UTC, runs the status check on every student instead (`api/_lib/statusDaily.js`), first asking Claude about look-alike cards in study it hasn't judged, up to 200 a student a day; 15:00 and 16:00 UTC run the tests of Claude's marking and of its reading of class notes, each only when due (`api/_lib/evalRuns.js`), and either one, when its own isn't due, the test of Claude's same-or-different question (`api/_lib/repeatsChecks.js`). Vercel's `x-vercel-cron-schedule` header says which |
| `chat.js` | The tutor. Gives hints, not the answer, until the card's answer is shown. Never writes cards |
| `review-answer.js` | "My answer should be accepted". Saves an accepted answer for that student only; "Accept anyway" skips Claude. A body with `feedback` is instead Claude's review of a piece of feedback and the owner's Apply and Dismiss (`api/_lib/feedbackReview.js`), here because of the 12-route limit. Every verdict is saved to `answer_reviews` (migration_015); a body with `answerChecks` is the owner's list of them and the test made from them (`api/_lib/answerChecks.js`) |
| `fsrs-fit.js` | Once a day per student: fits their own FSRS settings when due, and recomputes memory estimates when the settings change |
| `admin-update-card.js` | Saves a card edit, for any student's own cards despite the name. Uses the service role: edits from the browser under RLS silently did nothing. A body with `action: "remove"` is a student removing a card: archived with the reason "removed", answers kept (`api/_lib/removeCard.js`) |
| `admin-users.js` | Admin only: every account and its activity. `?view=status` is the latest status check on every student; with `&run=1` they are all checked now |
| `parse-corrections.js` | Admin only: logs corrections that `cahier-parse` learns from |
| `podcasts.js` | Podcasts, the owner's only for now: every action in one route, named by `action` in the body, because of the 12-route limit. `follow` (a Spotify link, or a podcast's slug), `refresh` (the followed podcasts' feeds), `episode` (RFI's transcript, and the questions, written once), `mark` (Claude marks one answer) and `add-card` (a word from a passage to the caller's cards). Anyone but the owner gets 403 "Admin only". The work is in `api/_lib/podcasts.js` (see *Podcasts*) |

- Every route checks the caller's Supabase session, except `cahier-daily`,
  which checks `CRON_SECRET`. The service role key bypasses RLS, so a route
  that uses it must check ownership itself.
- What counts as a card, and the code that enforces it, live in
  `parse-cahier.js`. `cahier-parse.js` and `cahier-sync.js` import them rather
  than copy them.
- "Replace my existing deck" works by class and deletes nothing
  (`src/lib/replaceDeck.js`, since 2026-10-06): a card with none of its
  classes in the upload leaves study, marked "replaced"; a later Replace with
  its class brings it back, unless the same card is in study by then (a
  lesson's copy, say), which gains its class dates instead; lesson cards and
  cards the student added (from the tutor or a podcast passage) are left
  alone; a card the database refuses no longer turns it into
  an add. A card the student has answered, either way round, never leaves
  study, whatever the classes say (2026-10-07), and the message says how many
  stayed and why; `save_notes_reading` refuses it too. A Replace with the
  owner's real notes would otherwise have taken out "pas grand chose à dire",
  answered five times, because its class's date line wasn't read. Before
  migration_016 Replace takes nothing out and the upload says so: a card taken
  out then could never say a Replace took it, so it would never come back.

### Which model each route runs

| File | Model |
|---|---|
| `chat.js` | `claude-sonnet-5`, effort `low` |
| `review-answer.js`, `_lib/splitSenses.js` (the multi-sense script) | `claude-opus-5` |
| `review-answer.js`, reviewing feedback | `claude-opus-5-5`, effort `medium`, with Anthropic's fallback model if it declines |
| `parse-cahier.js`, `cahier-parse.js`, `cahier-sync.js`, `cahier-daily.js` | `claude-haiku-4-5` |
| `parse-cahier.js` (commit), `cahier-sync.js`, `cahier-daily.js` (the status run, and the test of the question), `podcasts.js` (`add-card`): same card or different | `claude-opus-5-5`, effort `medium`, with Anthropic's fallback model if it declines |
| `podcasts.js` (`episode`, `_lib/podcastQuestions.js`): writing an episode's questions, once | `claude-opus-5-5`, effort `medium`, with the fallback; 150 s, reply at most 16,000 tokens |
| `podcasts.js` (`mark`, `_lib/podcastQuestions.js`): marking one answer | `claude-opus-5-5`, effort `low`, with the fallback; 45 s, reply at most 2,000 tokens |

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
  only decides whether the admin menu items, and for now the Flashcards /
  Podcasts switch, are drawn.
- Podcasts needs nothing new: RFI's feeds and pages and Spotify's oEmbed are
  read without a key.
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
- Podcasts is the owner's only for now (owner, 2026-10-09), so the owner pays
  for all of it, by the usual rule: their own key if the browser sends one,
  otherwise the server's `ANTHROPIC_API_KEY`. Three things there call Claude:
  writing an episode's questions (the first time anyone opens it), marking an
  answer, and the same-card question when a word is added. Following a
  podcast, or opening an episode whose questions exist, calls nothing.
- Before students get Podcasts, two things must be decided. Who pays for an
  episode's questions, which are written once and shared by every student:
  the owner, as for the linked cahier, or whoever opens the episode first.
  And the follow check: the server doesn't yet check that the caller follows
  an episode's podcast before writing its questions, marking or adding a card
  (see *Open items*). As built, every call there uses the caller's key, as
  every route does, so the first student to open an episode would pay for
  its questions.
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
| `status-check.mjs` | Runs the eleven status checks on a student's live record, and only reads. It checks the admin unless `--email` names someone else; `--from YYYY-MM-DD` judges from an earlier day, `--tz` sets the time zone for answers saved without one, `--all` shows every detail. `--everyone` is the morning check: every student who has answered, what the server's daily run last asked Claude about look-alike cards, and the three tests of Claude's work with any slip named. Each problem is told apart as new or raised before, from a list kept on the Mac outside the repo (`~/.claude/scheduled-tasks/morning-check/raised.json`), which `--everyone --record` saves; a daily run that couldn't ask Claude is a problem too, kept under one line whatever its error says, with the error printed beneath it (the error's count of pairs and an API error's request id change every morning, and a problem whose line changes is raised as new each day). The last line is "All clear.", "Nothing new: …" or "Something new needs looking at.", and only the last exits 1. It never asks Claude anything. Claude runs it on the owner's Mac under the rule in `.claude/settings.local.json`; without that rule auto mode blocks it from reading production. The owner's `.env.local` leaves both admin addresses blank, so pass `--email` |
| `record-cleanup-reasons.mjs` | One-off. Writes onto the 85 cards the 2026-10-06 clean-up put away why it did: `archived_reason` 'duplicate' with `merged_into` the card each repeats (for a list card whose words each kept a card, the one the card-writers' rule finds closest), or 'removed' for "Naza" and the registers card, and `archived_at` the time it ran. From the clean-up's plan (`--plan`, its `cleanup-plan.json`) and backup (`--backup`). Needs migration_016; touches only those three columns, only on rows still out of study with no reason, backs them up first, and a second run writes nothing. Not run yet |
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
  `supabase/schema.sql` on a new project. The live database has all of them
  up to 016: 012 was run on 2026-09-27, 013 on 2026-09-28, 014 on 2026-10-04,
  015 on 2026-10-06, 016 on 2026-10-07 and 017 on 2026-10-09.
- The test app on `testing` shares the live database, so a migration made
  there must leave `main`'s app working: additive only, until `testing` is
  released into `main` (see *Working protocol*).
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
- `016_notes_read_once`: `notes_read`, each student's record of the lines of
  their notes already read and whose turn it is to read them;
  `claim_notes_reading` and `save_notes_reading`, which only the server may
  call; on `user_cards`, `archived_reason` ('removed', 'replaced',
  'duplicate'), `archived_at` and `merged_into`, the first two cleared by a
  trigger when a card comes back into study; `card_pairs`, every
  same-or-different verdict of Claude's on two look-alike cards, with the
  question's version, from an upload, the sync or the morning check
  (`source` 'check'); and `eval_runs.kind` may be 'repeats', the test of that
  question. Additive and re-runnable; the app works before it, knowing
  classes by date only, and the two checks of the deck wait for it.
- `017_podcasts`: the three tables of Podcasts (see *Podcasts*).
  `podcast_episodes` is shared: written only by the server, and the first
  table any signed-in user may read. `podcast_follows` is each student's own
  to read, add and remove. `podcast_answers` is a record like `card_reviews`:
  the server writes it, each student reads their own, and no policy lets
  anyone change or delete a row. An answer's episode can't be deleted (no
  cascade). No policy names an email. Three new, empty tables and nothing
  else, re-runnable; Flashcards works the same before and after it, and
  until it is run the Podcasts pages say "Podcasts need a database update
  first". Made on `testing`; `main`'s app never reads these tables.

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
- **Podcasts' pages sit inside `main` like every page**, so the tutor makes
  room for them the same way. The episode's play bar is sticky inside the
  page's own scroll, never fixed to the window, where it would end up under
  the tutor. Podcasts adds no key handler on the window: Cmd/Ctrl+Enter
  checks an answer from its own box, and the study keys stay off because
  they work only while `mode` is "study".

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
- **The owner's sidebar starts with a switch, Flashcards or Podcasts** (owner,
  2026-10-09; `data-module-switch`). Two halves at the top of the nav, below
  the rail's expand button; the one showing is white. On the rail they stack
  as two icons, cards and headphones, titled "Flashcards" and "Podcasts". It
  is drawn only for the owner (`isAdmin`), so a student's sidebar is exactly
  what it was.
- **The switch is never a marked item.** Its halves say which is showing
  with `aria-pressed`, and their borders are transparent, so nothing that
  reads the nav's marker counts one.
- **Flashcards shows Lessons, Cards, Stats and Tutor; Podcasts shows
  Episodes, My podcasts and Tutor**, with each podcast followed listed under
  My podcasts (`data-pod-nav`, `data-pod-follow`). The rail leaves those out,
  as it does the lessons.
- **Exactly one item is marked in either module.** On a podcast's page, or
  one of its episodes, the podcast under My podcasts is marked. On the rail,
  or while that podcast isn't listed yet, My podcasts stands in for it.
- **The switch's styles follow the longhand rule too**: every variant (rail
  or full width, showing or not) declares the same keys, as longhands, since a
  key one variant lacks is left behind on the way back (the 24b55b7 bug). The
  `podcasts` suite toggles it both ways: rail to Podcasts, expand, back to
  Flashcards, minimise, expand, with nothing under the minimise button.
- **Switching module never touches the cards.** Back on Flashcards the same
  page opens (Lessons or Stats if that is where you were), with the same card,
  counter, typed answer and retries; nothing is written. Which module and
  which Podcasts page were showing are kept for the owner in
  `localStorage["podcasts-place:<user id>"]`, dropped on sign-out. "Take the
  tour again" switches to Flashcards first.

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

- **It comes up once for every student, new or not** (owner, 2026-10-06): the
  next time they open the app, once the deck has come from the server and the
  lesson sync has put Lesson 1's cards in it. Students who have answered cards
  get it too. The tour's first version only showed it to students with
  nothing answered, and marked the rest with `tour_seen` without showing it,
  so that marker is no longer read.
- **That it was shown is kept on the account** (`user_metadata.tour_shown`,
  saved the way the lesson switches are, and read from the server on opening)
  **and on the browser** (`localStorage["tour-shown:<user id>"]`), so another
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

Twenty need no browser:

- `logic`: the pure rules, from card types and prompt cleaning to
  `reconcileLessons` and the released-lesson-cards list.
- `apply-splits`: `api/_lib/applySplits.js`: ownership, and which row keeps its
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
  and each fault planted in it fails its check, a card in the deck twice and a
  deleted or corrected card back among them.
- `status-script`: `scripts/status-check.mjs` against a stand-in Supabase,
  sending only GETs: what it reads for each check, and the morning check
  (`--everyone`).
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
- `repeats`: no card made twice from the same notes, with the stand-in
  database `tests/fake-supabase.mjs` (it runs migration_016's two functions
  and refuses what Postgres refuses) and a stand-in Claude. A used deck gets
  an updated notebook by upload, Replace, the sync, upload then link, unlink
  and relink, a copy of the doc, two runs at once, an upload that loses its
  turn to the daily check, a failed or lost save, a refused card and a failed
  question; every time exactly the new words arrive, no unchanged class is
  read, every old card keeps its id, text, schedule and answers and gains its
  dates, and the same notes again ask Claude nothing. Its stand-in Claude adds
  "(fam)" to a line of a class it reads a second time, which the rule can't
  join, so any reading of a line already read shows up as an extra card; and
  every path checks that a class with a line added went to Claude with that
  line only. Also the keep-apart pairs ("pas mal" and "pas mal (quite a lot)"
  among them), the same words in another order put to Claude, Replace by
  class and beside a lesson's copy, a class Claude couldn't read (on the
  upload and the sync: none of its words added, none of its lines recorded,
  read alone next time) and every class failing, a class moved onto a date
  another class has, the first run after the fix, the question's calls side
  by side and its time limit, the lesson sync leaving removed cards out and
  keeping a dropped lesson card a class landed on, Remove card through its
  route, View feedback's Remove card, the message an upload shows, and before
  migration_016 (Replace taking nothing out). Since 2026-10-07 also a new list
  card beside one of its items (the other words made cards, forms of the item
  joined), a list card read after two of its items, an upload of pasted text
  or a .docx against the link's fingerprints, and migration_016's own refusal
  of a Replace of an answered card: its SQL read as written, and, where the
  machine has Postgres (Homebrew's postgresql@16 on the owner's Mac; not
  GitHub's runner), run on a throwaway database built from the schema and
  every migration (`tests/local-postgres.mjs`).
- `repeat-checks`: the harness for repeated cards: the morning check asking
  Claude about look-alikes (the cap, newest first, verdicts kept and judged
  with, a failed call's pairs left for tomorrow, nothing asked before
  migration_016 or by the read-only check), the test of the same-or-different
  question and the schedule that runs it, the red dot's rule for it, drills of
  different verbs not being look-alikes, the same words in another order
  being look-alikes, "pas mal" and "pas mal (quite a lot;)" not called one
  card, and `scripts/record-cleanup-reasons.mjs`.
- `podcast-feed`: Podcasts' reading of RFI and Spotify
  (`api/_lib/podcastSource.js`) and Listen's times
  (`src/lib/podcastTiming.js`), on short synthetic French in RFI's own
  markup (`tests/fixtures/podcasts`): a feed's episodes, an episode page's
  transcript and stories, every Spotify link a student copies, a title
  (even cut short) finding its podcast and episode, only the two sites read;
  and `migration_017` run twice after every migration where the machine has
  Postgres.
- `podcast-marking`: the Podcasts server (`api/_lib/podcasts.js`,
  `podcastQuestions.js`) with a stand-in Claude counted at the wire: the
  questions written once and checked against the transcript, "Got it" only
  with every idea caught, a passage back `RETRY_DAYS` later, a failure kept
  as a short code, anyone but the owner refused, Add to my cards inserting
  one new card and touching no other, and every action before
  `migration_017`.

Nineteen drive the app in a browser. `openApp` opens every one as a student
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
- `cards`: among other things, Remove card posting `{ action: "remove" }`,
  never deleting the row, and asking a student only a plain yes or no.
- `lesson-sync`: new and existing decks get every lesson and keep their own
  cards, against a working in-memory `user_cards`; a lesson card the student
  removed stays out while one a lesson dropped comes back; a dropped lesson
  card a class of the notes landed on stays as the student's own; and before
  migration_016, whose column the deck load asks for, the deck still loads.
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
- `podcasts`: the Podcasts pages, on their own Vite (port 5191) with the test
  account as admin, the podcast tables and `/api/podcasts` stood in: the
  switch for the owner only and none for a student, the round trip both ways
  with the same card and no card written, Episodes and "To try again", an
  episode's tabs, Listen starting `LISTEN_LEAD_S` early, answering, Add to my
  cards as one request with no card written from the browser, the tutor told
  about the episode, and the message before `migration_017`.

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
- A lesson card the student already has as their own card is not added
  (`taken`). The upsert on `(user_id, front)` would overwrite theirs. Since
  2026-10-06 "already has" is the matching rule (`src/lib/sameCard.js`), not
  only the exact front. Since 2026-10-07 it counts every card of their own,
  in study or out of it, whatever took it out and whether or not the row says
  why: before migration_016 no row says, and Leçon 2's "après" was written
  over the owner's 16650 "après", which the clean-up had put away as a repeat
  of "ensuite / après" (new English, class dates cleared, back in study).
- A lesson card the student removed, or one put away as a repeat, is not put
  back (`away`, 2026-10-06). Removing archives the row, and the lesson's
  upsert would land on it and bring it back. Which rows those are comes from
  `archived_reason` (migration_016), which the deck load asks for while the
  database has it; before the migration no row says, and a removed lesson
  card comes back, as a deleted one always did.
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
  linked doc, uploads, and words added from the tutor (owner, 2026-10-04) or,
  since 2026-10-09, from a podcast passage. It keeps a set of its own.
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

## Podcasts

A second part of the app beside Flashcards: listening practice with RFI's
podcasts for learners, such as Journal en français facile. The owner agreed
it from a clickable mockup (`.claude/mockups/podcasts.html`, on the owner's
Mac only, not in the repo) and said "i like it build it" (owner,
2026-10-09). The mockup holds every approved label.

It is the owner's alone until they have tried it (owner, 2026-10-09: "this
module should only be for me right now"). It is on the `testing` branch, the
owner's test app, and reaches `main` only when the owner says so (see
*Working protocol*).

**Who can see it**

- **Only the owner has the switch.** The sidebar's Flashcards / Podcasts
  switch is drawn only when the signed-in account is `VITE_ADMIN_EMAIL`
  (`isAdmin`), which only hides it (see *The sidebar*).
- **The server is the real check.** `api/podcasts.js` verifies the session,
  then answers 403 "Admin only" to anyone but `ADMIN_EMAIL`, before any
  action runs.
- **A student's app is unchanged**: no switch, no Podcasts pages, nothing new
  read or kept in their browser. The `podcasts` suite checks that a student
  build has no switch.

**The pages** (`src/PodcastsPage.jsx`; the shell in `src/FlashcardApp.jsx`
keeps which page is showing)

- **Episodes**: every episode of the podcasts followed, newest first, each
  row with its podcast's name above the title and a status: "Not started",
  "3 of 9 passages answered", or "7 of 9 passages understood" once all are
  answered. "To try again" comes first when a passage is due back, and such
  a row says "2 passages to try again". With nothing followed: "Add a podcast
  under My podcasts to see its episodes here."
- **My podcasts**: a box for a Spotify link ("Paste a Spotify link", Add),
  and a card for each podcast followed, saying "4 of 12 episodes done".
  There is no way to stop following one yet.
- **A podcast's page**: its episodes, headed with its name and "RFI".
- **An episode's page**: a play bar for RFI's recording (speeds 1, 0.75 and
  1.25) and three tabs, Questions, Transcript and Words to learn. Journal en
  français facile's episodes are headed with the long date ("Tuesday 6
  October"); the others with the episode's title, and the podcast and date
  beneath. The back pill says "Episodes" or the podcast's name, whichever you
  came from.
- **Words to learn** lists every key phrase of the episode's passages once,
  each with "Add to my cards". **Transcript** shows RFI's text story by
  story, each with its start time to jump to.

**Only RFI's learner podcasts, for now** (owner, 2026-10-09)

- Journal en français facile, Les mots de l'info, and Un mot, une histoire,
  listed in code (`src/lib/podcastCatalogue.js`). The database keeps only a
  podcast's slug, so a slug must never change.
- Anything else gets "Only RFI's learner podcasts can be added for now, such
  as Journal en français facile."

**Reading RFI** (`api/_lib/podcastSource.js`)

- **The feed.** Each podcast's RSS feed gives the episodes: title, date,
  page, MP3 and length. The page link's tracking query string is dropped. The
  server reads the feed when a podcast is followed, and again at most every
  10 minutes while Podcasts is open. A feed read writes only the feed's
  columns, so it never blanks a transcript or questions saved later.
- **The episode's page**, read the first time anyone opens the episode. The
  transcript is the paragraphs inside `.m-transcription__content`, without
  its "Voir plus" / "Voir moins" button. The stories are the chapter items
  (`li.a-chapter`) that come before `.t-content__transcription`, each with
  its start time ("01:18 Mouvement lycéen : 450 000 manifestants…"); the
  first is "Les titres", the headlines. Les mots de l'info and Un mot, une
  histoire have no stories.
- **No transcript yet**: the page says "RFI hasn't published a transcript for
  this episode." RFI sometimes publishes one late, so an open 15 minutes or
  more later reads the page again.
- **No HTML parser**: the project has none, so this is plain string work,
  written against pages saved on 2026-10-09. A page that isn't what's
  expected gives nothing rather than an error.
- **Only two sites can be read**, `francaisfacile.rfi.fr` and
  `open.spotify.com`, over https, with a 10-second limit and a 2 MB cap, and
  a redirect to anywhere else isn't followed. Students paste the links, so a
  link must never make the server fetch something else.
- **No key is needed** for RFI or Spotify, so Podcasts adds no environment
  variable.

**A Spotify link finds its podcast by title**

- The server asks Spotify's oEmbed for the link's title, then looks for it
  among the episode titles of every podcast in the catalogue.
- A title matches exactly (apostrophes, spacing and capitals aside), or as
  the start of an episode's title, at least 40 characters long, because
  Spotify cuts long titles.
- **A show link's oEmbed title is the show's latest episode, not the show's
  name** (checked 2026-10-09). So a show link is matched the same way, and
  every feed is read for it.
- An episode link also opens that episode.
- A link that matches nothing while a feed couldn't be read says RFI
  couldn't be reached, not that it isn't RFI's. A Journal link while the
  Journal's feed was down was told it wasn't one of RFI's (found
  2026-10-09).

**The questions: written once per episode, shared by everyone**
(`api/_lib/podcastQuestions.js`)

- **No multiple choice** (owner, 2026-10-09). Each question shows a French
  passage of RFI's transcript with a Listen button and asks "What's being
  said here? Give the idea in English." (about two-thirds) or "Translate into
  English."
- **How many.** A Journal episode gets one passage per story, and a second
  for the longest or hardest, 8 to 10 in all; the headlines and the sign-off
  get none. A short episode on one topic gets 3, spread through it. Never more
  than 10 (`MAX_PASSAGES`). Episodes over 12 minutes are out of scope for
  now: they still get at most 10.
- **Written the first time anyone opens the episode**, by Claude, and saved
  on `podcast_episodes.questions` for every student. A lease
  (`questions_lease_until`, three minutes) means two people opening a new
  episode at once pay once. The second sees "Writing the questions for this
  episode…" and the page asks again every 4 seconds, for up to 2 minutes.
- **Checked, not trusted.** A passage is kept only if it is word for word in
  one paragraph of the transcript (spacing and apostrophes aside). The server
  gives each passage its key, from its own French (`s1-3fa2c1d0`), so
  questions written again can never pin an old answer on a different
  passage. Fewer than 3 good passages and nothing is saved: the next open
  tries again.
- **A failure is kept on the episode as a short code** ("busy:429"), never
  Claude's own message, because every signed-in student can read the row.
- **The words to learn** follow the notes reader's card rules: dictionary
  form, the article on a noun. A noun that lives in the plural keeps it,
  with "les" ("les vacances", "les dégâts"). A singular "dégât" would have
  been added beside the owner's own "les dégâts" as a second card (found
  2026-10-09).

**Listen plays RFI's own recording**, not the browser's voice (owner,
2026-10-09)

- RFI publishes no time for each sentence, only each story's start. So the
  passage's start and end are estimated from where it sits in its story's
  text: the share of the story's characters before it, times the story's
  length, from the story's start (`src/lib/podcastTiming.js`). A podcast with
  no stories is one story.
- **Listen starts 3 seconds before the estimate and stops 2 seconds after
  it** (owner, 2026-10-09; `LISTEN_LEAD`, `LISTEN_TAIL`). The button reads
  "Stop" while it plays.
- RFI reads at a steady 15 to 16 characters a second (seven Journal
  episodes, 1 to 9 October 2026), so the estimate should be good to a few
  seconds. A clip of someone interviewed, faster or slower, can move it.
- One recording per episode page, shared by the play bar and every Listen,
  so two never play at once. It stops when the page goes.

**Claude marks each answer**

- The verdict is "Got it", "Partly" or "Missed". Claude says which of the
  passage's ideas the answer holds, by meaning, not wording, and the server
  works the verdict out from those, so the pill and the sentence under it
  always agree.
- Under the answer: what was caught and what was missed ("You caught that
  450,000 people protested. You missed that parents joined the marches.";
  for a translation, the French words), Claude's note if it has one useful
  sentence, "A good answer: …", and the passage's key phrases highlighted,
  each with "Add to my cards".
- The answer is saved for that student only (`podcast_answers`), with the
  model and prompt version. A failed save still shows the verdict.
- **A passage not fully understood comes back three days later** (owner,
  2026-10-09; `RETRY_DAYS`): unanswered again, in its episode, with "Back for
  another try" above it, and the episode listed under "To try again". The
  result box says when: "The 2 passages you didn't fully get come back on
  Monday 12 October." A passage's state is its latest answer
  (`src/lib/podcastProgress.js`).

**"Add to my cards" makes an ordinary card and touches nothing else**
(owner's rule: updates never reset progress)

- It goes through the server (`add-card`), never straight from the browser,
  and uses the deck's same-card rule (`src/lib/cardMatch.js`).
- A card the student already has, in study or not, adds nothing: "In your
  deck".
- A card they removed stays removed: "You removed this card earlier".
  Whether an Add should bring it back isn't decided (see *Open items*).
- A near look-alike is put to Claude. If that can't be answered, nothing is
  added on a guess: "Couldn't check this one. Try again."
- A new card is inserted, never written over another row, as a word (`V`),
  with no class dates, no schedule (it starts new both ways round) and the
  source `podcast:<episode id>`.
- Like a tutor card it is the student's own (`addedByStudent`,
  `src/lib/sessionQueue.js`): dated by the day it was added, dealt on My
  cahier, left alone by "Replace my existing deck", and given no uncertain
  class dates by the morning check's new-card order. All four ask the same
  test, so a third way of adding a card can't be missed in one of them.

**The tutor on Podcasts**

- It is told the episode's name, RFI's transcript (clipped to 12,000
  characters) and the passage on screen, with whether it has been answered
  (`api/chat.js`, "A podcast episode").
- Like an unanswered card, an unanswered passage isn't translated or
  summarised, even when asked; the tutor helps with a word or the grammar
  instead. Once it is answered, the tutor may explain it in full.
- The hidden flashcard is never sent from Podcasts. A question about another
  passage starts a fresh thread (its key, `pod:<episode id>:<passage key>`,
  works as a card's row id does).
- Feedback sent from Podcasts names the page it came from (`podcasts/episode`).

**The three tables** (`migration_017`, run by the owner on 2026-10-09)

- `podcast_episodes`: every episode of a podcast anyone follows, kept once
  for everyone: the feed's columns, RFI's transcript and stories, and the
  questions with which prompt and model wrote them. Only the server writes
  it; any signed-in user can read it.
- `podcast_follows`: which podcasts each student follows, and the link each
  was added from. Each student reads, adds and removes their own.
- `podcast_answers`: every answer to a passage, one row each, like
  `card_reviews`: the passage's key and French, what was typed, the verdict
  and feedback, and `due_at` for a passage coming back. The server writes
  them; each student reads their own; nobody changes or deletes one.
- **Podcast answers never go into `card_reviews` or `dealt_sets`**, which the
  status check, the FSRS fit and Stats read.
- **Until `migration_017` is run**, the Podcasts pages say "Podcasts need a
  database update first: run migrations/migration_017_podcasts.sql in
  Supabase." Flashcards is unchanged either way.

**Tests.** `podcast-feed` and `podcast-marking` need no browser; `podcasts`
drives the pages (see *The suites*). They run on short synthetic French in
RFI's markup (`tests/fixtures/podcasts`): RFI's text is copyrighted and the
repo is public, so no real transcript is committed. No suite reads RFI or
Spotify, or calls Claude.

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

### The eleven checks

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

The deck itself (since 2026-10-06, after the owner's "there should be NO
duplicates from reuploading an updated cahier" and "make sure the evaluation
harness is catching this properly"):

10. No card is in your deck twice. Fails on two cards in study, lesson cards
    included, that are one card by the sure rule every card-writer uses
    (`src/lib/sameCard.js`), or that Claude judged the same card
    (`card_pairs`). A verdict counts only while both cards read as they did
    when Claude judged them, and the latest on a pair wins. Look-alikes
    Claude hasn't judged yet (the near search, as a new card meets it) make it
    wait, saying how many; so do the ones it can't read before migration_016.
    A pair the rule joins still fails before it.
11. Nothing you deleted or corrected came back. Fails on a card in study that
    is a card the student removed (`archived_reason` 'removed') or the owner
    deleted (`parse_corrections`), by the sure rule, made after it was taken
    out; or the form a card had before the owner corrected it: the exact
    French when the rule can't tell the two apart ("Je parle jamais de
    Pierre." and its full stop), the rule otherwise ("une propositiond"), and
    corrected English back on the card. A card made before the removal or the
    correction isn't back (the card a duplicate was deleted beside, or the
    corrected card itself), and a form a later correction put back isn't
    watched. Each student is judged on their own removals and corrections.
    Before migration_016 the removals can't be known: with nothing else back
    it waits.

Both run the card-writers' code, imported, so "the same card" means the same
to the check as to the upload and the sync. Run on the copy of the live tables
taken before the 2026-10-06 clean-up, the second named exactly the three cards
that clean-up put right ("Naza", the registers card and "Je parle jamais de
Pierre."), and the first reached all three decks' repeat groups: the owner's
63 (10 by the rule, 52 through the near search, the last only through its
neighbours, "15 → en lettres" and "quinze"), and the others' 8.

Checks 5, 6 and 8 need the set records, so they start the day after the
first recorded set: 2026-09-29 at the earliest. Checks 10 and 11 read Claude's
verdicts (`card_pairs`) and the owner's corrections (`parse_corrections`)
besides the cards, everywhere the checks run.

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

A third, since 2026-10-06: check 6 doesn't judge an order that hangs on a
card whose class dates may have changed after the set was dealt, because a
repeat was put away into it later. The clean-up of 2026-10-06 moved each
put-away card's dates onto the card kept, and four of the owner's sets were
then faulted over "lourd (adj)", which had gained a class from "lourd, lourde
(adj)" that evening. The repeat is the card named by `merged_into`; before
migration_016 (and `scripts/record-cleanup-reasons.mjs`), a card out of study
with no reason that looks like the card (the sure rule or the near search) and
shares the date stands in, and its last change (`updated_at`) is when it was
put away.

### Since 2026-10-06: every student, Claude's marking, and tests on GitHub

The owner asked for the checks to meet the standards of a guide to evals
(2026-10-06). Three things came of it, all in the Status window, which has a
tab for each:

- **All students.** The checks (nine then, eleven since the two of the deck)
  run on the server every morning (the
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
- **Repeated cards** (2026-10-06, the owner: "make sure the evaluation
  harness is catching this properly"). Checks 10 and 11 above, and two more
  things. The server's morning run (14:00 UTC) first puts to Claude the
  look-alike pairs of cards in study it hasn't judged, every student's in one
  pooled question (`judgeLookalikes`, `api/_lib/statusDaily.js`; the
  question every card-writer asks, `api/_lib/sameCardQuestion.js`), at most
  200 a student a day, newest cards first, keeps the verdicts in `card_pairs`
  (source 'check'), then checks. A call that fails or runs late leaves its
  pairs for the next morning, and the kept report says how many
  (`report.judging`). Nothing starts after 150 seconds and no call runs past
  210. The owner's deck had 875 such pairs on 2026-10-06, about five mornings'
  worth; after that, a day's new cards raise a handful. The morning check on
  the Mac and Check everyone now only read. And the question itself is
  tested, as kind `repeats` (`api/_lib/repeatsChecks.js`): each card put away
  as a repeat with the card it repeats (`archived_reason` 'duplicate' and
  `merged_into`) should be "same", and so should each card that is one item
  of another card's list (`LIST_ITEMS` in `api/_lib/keepApart.js`, real
  pairs such as "après" and "ensuite / après", 2026-10-07); the pairs in
  `KEEP_APART` (the plan's eight keep-apart pairs, seven more, and seven a
  list only seems to hold, such as "amener" and "se lever, acheter, amener")
  should be "different". Each is asked three times in rounds of the app's
  own calls. Its version is the
  question's. It has no schedule of its own: the 15:00 and 16:00 runs each
  take it when their own test isn't due. Until
  `scripts/record-cleanup-reasons.mjs` records the clean-up's 82 repeats it
  has only the fixed pairs to ask.
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
  simulated students and every test suite on each push to `main` or
  `testing` (`testing` since 2026-10-09, 78a4946). A failure
  marks the commit and emails whoever pushed. A browser suite that fails gets
  one second try and is named in the summary.

Known about the question Claude is asked, and left as it is so the first
test measures it unchanged: for an English-side card it says "The card showed
the English side" followed by the French text.

Found while building the notes test, 2026-10-06: the full notebook upload of
2026-09-04 made again some cards the owner had deleted or corrected in April
and May ("Naza", "les registres de langues : familier, courant, …", "Je parle
jamais de Pierre." with its full stop). The clean-up that evening put them and
85 repeated cards in three decks away, and the code fix of the same day
(*The linked cahier*: what has been read, and a word written another way)
stops an upload or the sync making them again.

**What migration_016 keeps for the checks of repeated cards**: `card_pairs`,
every same-or-different verdict of Claude's with both cards' text and ids and
the question's version (`SAME_CARD_VERSION`, `api/_lib/sameCardQuestion.js`);
on `user_cards`, `archived_reason` and `merged_into`, so a card put away as a
repeat names the card it repeats; and `eval_runs.kind` 'repeats'. Checks 10
and 11, the morning judging and the test of the question are built on them
(see *Repeated cards* above).

### The simulations (`tests/simulate/`)

`student.mjs` is a simulated student studying with the app's own code, so its
records are shaped like the real tables and the status check runs on them.
Its memory is deliberately not FSRS, so FSRS isn't graded against its own
assumptions.

- `npm run simulate`: weak and typical students, 180 days, every check, in
  seconds. Run it before any change to scheduling or to which cards a set
  takes. The predictions check can't fail it, since the students' memory is
  invented. The simulated deck holds each card once, as the app makes it
  (since 2026-10-06: "une marque" and "la marque" in the demo notebook are one
  card, and a lesson card the notes already have isn't added), and a stand-in
  for Claude calls every look-alike pair different, so "No card is in your
  deck twice" passes; nothing is deleted or corrected, so check 11 waits.
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
of Claude's work), `repeat-checks` (the morning judging of look-alikes and the
test of the same-or-different question), and `statusline` (browser: no Status
line in the app).

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

### 2026-10-06 — No card made twice from the same notes

The owner: "there should be NO duplicates from reuploading an updated cahier"
and "Yes, build it", on a plan that found three causes: every upload read
every class again, and Claude writes a line a little differently each time;
the upload knew a card only by its exact French, and wrote over the English,
category, dates and source of any card it matched; and nothing remembered a
card the student had deleted. The fix, Part 1 of that plan: a per-student
record of the lines read (`notes_read`), shared by the upload and the sync and
kept by Unlink; one matching rule for every card-writer, with near look-alikes
put to Claude; saving the cards and the lines read in one step, one run at a
time; Delete became Remove, which archives with the reason; Replace works by
class and never deletes; the upload reads with the sync's instructions; and
the lesson sync's "already has this card" uses the rule, and it leaves a
lesson card the student removed out of study. Needs migration_016; the app
works without it, by class date as before. The `repeats` suite runs the plan's
headline test in every way the notes come in. Two existing checks changed with
it: `cahier-sync`'s "a card taken out of study is not what a new one joins"
now expects the archived card to gain the date and no new card beside it, and
`logic`'s Replace and one-card-per-front checks follow the new rules.

Finishing it (the first builder was paused partway): a card the database
refuses is now left out inside the one save step rather than in a separate
write; an upload renews only its own turn; the question to Claude goes in
parallel calls with a time limit, after a copy of the owner's notes read from
nothing raised 890 pairs, too many to ask one call at a time within five
minutes; the daily job stops starting syncs in time to finish; Remove card in
View feedback records the reason too; linking while the notes are being read
says so; and `lesson-sync` checks, in the browser, that a removed lesson card
stays out and that the deck loads before migration_016.

A review of the build found eleven more gaps, all fixed the same evening. A
class moved onto a date another class still has, or one of two classes
sharing a date corrected, was read again from scratch; a moved class is now
known by the lines left over under its old date. The near search missed the
same words in another order ("une vendeuse / un vendeur") and "ils/elles" for
"ils", and so did the morning check, which uses it. The sure rule called
"pas mal" (not bad) and "pas mal (quite a lot;)" one card. Replace could bring
a card back beside a lesson's copy of it. A word that landed on a lesson card
was lost when the lesson dropped the card; that card now becomes the
student's own. A Replace before migration_016 took cards out for good, so it
now takes nothing out until then. The message after an upload said
"everything is already in your deck" when a class couldn't be read or waited,
and now names those classes (`src/lib/uploadText.js`). Remove card asked
every student for one of the admin's correction codes; only the admin is
asked now. And the tests gained what would have caught each of these: a
class Claude can't read, the sync's new lines, Remove card at its route and
in the browser, a dropped lesson card in the browser, and a stand-in Claude
whose second reading of a line makes an extra card. Each fix was checked by
putting its bug back in a scratch copy and seeing a suite fail. Run on the
read-only copy of the live tables taken after the clean-up, the owner's
look-alike pairs for Claude went from 875 to 836 (a drill ending "→ il/elle"
or "→ ils/elles" is no longer paired with the card "elle" or "elles", and
filler words no longer count as English that agrees), and demarajackson's repeats by the rule from 19 to 16.

### 2026-10-06 — The harness catches repeated cards

The owner asked to "make sure the evaluation harness is catching this
properly". Two checks were added to the status check, both running the
card-writers' own rule: no card in study twice (by the rule, or by Claude's
verdict on two look-alikes), and nothing the student deleted or corrected back
(see *The eleven checks*). The server's morning run now first asks Claude
about look-alike cards in study it hasn't judged, up to 200 a student a day,
and keeps the verdicts; the morning check on the Mac reads them, the removal
reasons and the corrections for every student, and says what the daily run
asked and what is left. Claude's same-or-different question is tested like
its marking and its note reading, as kind `repeats`, on the cards the clean-up
put away and fixed keep-apart pairs, run in the 15:00 or 16:00 slot when that
slot's own test isn't due, so no cron was added. `scripts/record-cleanup-reasons.mjs`
writes why the clean-up put each card away, once migration_016 is in.

Run read-only on the live tables that evening: the owner's deck has no card
twice by the rule and 875 look-alike pairs for Claude (958 before drills of
different verbs stopped counting as look-alikes, a change to the near search
made with this); nothing the owner deleted or corrected is back. On the copy
taken before the clean-up, check 11 named exactly the three cards the
clean-up put right. Two students with answers would fail check 10 at once:
demarajackson 19 repeats and laura.caufour 3, made inside one reading (see
*Bugs and loose ends*). The same run showed check 6 failing four of the
owner's sets over "lourd (adj)", a false alarm the clean-up's date moves made;
check 6 now leaves such an order alone (see *The eleven checks*). The dry run of the reasons script found one of the 85
cards back in study: Leçon 2's lesson sync had taken over "après" (16650) at
23:33 UTC.

### 2026-10-07 — No doubles: list items, two-day classes, Replace and the lesson sync

From the read-only run of the fix on the owner's real notes and every live
deck, and the owner's decisions that day ("there must be NO doubles"):

- A card that is one item of another card's list is the same card: "à
  l'heure" beside "à temps / à l'heure". The sure rule joins an item whose
  English agrees word for word with the list's, Claude's question says the
  rest are the same card, and what a list only seems to hold is kept apart
  (see *The linked cahier*). The upload, the sync, the merge inside one
  reading and the morning check all use it; inside one reading the list card
  is kept. Removing or deleting a list card doesn't make its items unwanted:
  the owner deleted "pas mal = beaucoup" in April, and "pas mal" from their
  notes isn't that card back.
- A class headed "Le 28 et 29 septembre 2026" is one class, dated the 28th.
  Its lines used to be cut off with the class above's homework.
- "Replace my existing deck" never takes out a card the student has
  answered, either way round, and says how many stayed.
- The first run after migration_016 no longer counts as read the lines of a
  class the linked notebook read when it was shorter: only lines on a card
  do. On the owner's notes that is exactly the 12 unread lines of 2 October
  and the 6 of 28/29 September.
- The lesson sync never takes over a card of the student's own out of study,
  whatever took it out.
- The upload's message says one as one ("your card from another class stays
  as it is", "1 card couldn't be saved").

The status suite's messy simulated student moved from seed 7 to seed 5:
the deck now holds "une infirmière" inside "un infirmier, une infirmière",
one card fewer, which changes every later card's luck, and on that seed
"FSRS's predictions match your results" found its lowest band more than 10
points off. That band fails on most seeds before and after the change,
because the simulated student's memory is deliberately not FSRS.

### 2026-10-07 — The no-doubles fix reviewed: list cards after their items, uploads that aren't the doc

A review of the day's fix, each finding checked on the read-only snapshot
and fixed with a test that fails without it:

- **A new list card no longer joins one of its items.** "frapper, taper"
  only added a date to the owner's "taper", and "frapper" never became a
  card. Now the list's other words become cards, and a word that is only
  the feminine, plural or number of the item stays that card (see *The
  linked cahier*). Claude's "same" for a new list card and one of its items
  works the same way. The question's wording is unchanged.
- **Inside one reading a list card takes in every item read before it.**
  "à l'heure", "à temps", then "à temps / à l'heure" used to keep "à l'heure"
  beside the list card, and the card-writer then joined the two, losing
  "à temps". An item read again after its list card lands on the list card,
  class date and all; a test now covers that chain.
- **An upload of pasted text or a file doesn't compare the link's
  fingerprints.** Only the sync and an upload of the doc's link see the
  export the fingerprints came from. Before, a .docx or a paste as the first
  run after migration_016 read 39 lines instead of 18.
- **The morning check keys a failed daily run on fixed text.** The error goes
  on the line beneath, so the same failure the next morning, with another
  count or request id, isn't raised as new.
- **The status suite no longer depends on the seed's luck.** Neither
  simulated student is judged on "FSRS's predictions match your results",
  which fails on 5 of seeds 1 to 10 for the tidy student and 8 for the messy
  one; every other check passes on all ten. The messy student is back on
  seed 7.
- **migration_016's refusal of a Replace of an answered card is tested in
  the SQL itself**, as written and, where the machine has Postgres, run.
- **The lines already on a card are tested in all four ways**: a card's
  French, a list card's part, a drill's answer, and two words with " // ".
- **The second clean-up of repeated cards waits for the fix to be live**
  for every group whose card to put away has a lesson card's exact French,
  whatever its own source (nguyen's "une infirmière" came from her notes),
  and for the restore of 16650 "après". The live lesson sync would land on
  such a card and bring it back into study. migration_016 being run no
  longer counts as the fix being live; the owner passes `--fix-live` after
  the deploy.

### 2026-10-09 — Podcasts on the testing branch

The owner asked for listening practice with RFI's podcasts for learners. A
clickable mockup was agreed first (`.claude/mockups/podcasts.html`, on the
owner's Mac only), and the owner said "i like it build it". Two more
decisions came with it. "this module should only be for me right now": so
only the owner has the switch, and the server refuses everyone else. And
"segment the updates i am now making between the application i use (and will
be testing) and the app given to others": so Podcasts was built on a new
branch, `testing`, which Vercel deploys as the owner's test app at
https://french-flashcards-git-testing-mlboryczkas-projects.vercel.app, while
`main` stays the students' app. GitHub runs the tests on pushes to both
(78a4946). The test app uses the same database as the live one, so until
`testing` is released into `main` its migrations must be additive:
`migration_017` adds three new tables and changes nothing else. A card the
owner adds from a podcast is an ordinary card in their real deck. See
*Podcasts*, and *Working protocol* for the branch.

Three things went wrong during the build and were fixed, each with a check:
a Journal link while the Journal's feed was down was told it wasn't one of
RFI's; a noun that lives in the plural ("les dégâts") was made singular, so
it would have sat beside the owner's own card as a second one; and a stored
story with no first paragraph read as paragraph 0, which put the whole
transcript under the headlines. Cards added from a podcast are dated like
tutor cards, through one test (`addedByStudent`) used by the new-card order,
Replace and the morning check alike. Tested against stand-ins only
(`podcast-feed`, `podcast-marking` and `podcasts`, and new cases in `logic`,
`serving`, `progress`, `repeats`, `status` and `auth`): no call was made to
the real Claude, RFI or Spotify, and nothing was written to the live
database.

---

## Open items

In order: the owner's to-dos, bugs, things not yet checked on the live app,
and ideas. One item, the lesson bar by section, is agreed but not built.
Podcasts is built and on the test app; the owner ran `migration_017` on
2026-10-09 and is trying it.

### The owner's to-dos

- **Record why the 2026-10-06 clean-up put cards away**:
  `node scripts/record-cleanup-reasons.mjs --plan <cleanup-plan.json>`, read
  the list, then again with `--apply`. It writes 82 repeats and the 2
  removed cards (a write to live cards: three columns, backed up first), so
  they stay out whatever a lesson does and become the "same" cases of the
  test of Claude's question. The clean-up's `cleanup-plan.json` was written
  to a Claude session's temporary folder; keep a copy beside its backup in
  `backups/` (the script looks for `backups/cleanup-plan-2026-10-06.json`).
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

- **Cards archived before migration_016 say no reason.** `archived_reason` is
  empty on them, so the clean-up of 2026-10-06 left its 85 repeats without
  "duplicate" or `merged_into` until `scripts/record-cleanup-reasons.mjs` is
  run (see *The owner's to-dos*). Only cards with the reason "replaced" ever
  come back through an upload, so none of these does.
- **"après" (16650) is still in study on the live deck**, beside "ensuite /
  après". The lesson sync took it over on 2026-10-06, before that was fixed
  (2026-10-07), and nothing puts it back. Claude's question now calls it the
  same card as "ensuite / après", so once the morning run asks about it, the
  owner's "No card is in your deck twice" names it.
- **The lesson sync can delete answered cards.** When a lesson drops a card
  that Reset all progress put back to new, the sync deletes it, and its
  answers from before the reset with it. `reconcileLessons`
  (`src/lib/lessonSync.js`) looks only at `fsrs_state`; it should check
  `card_reviews` first, as the upload's replace does.
- **Repeats made inside one reading are still in some decks**, and the
  morning check now fails on them. The clean-up of 2026-10-06 put away only
  repeats from reading notes again; the owner decided on 2026-10-07 that
  these go the same way, which needs a write to the live cards and hasn't
  been done. Its groups that put away a card with a lesson card's exact
  French (the owner's "une infirmière" and "Allons-y !", nguyen's "une
  infirmière"), and the one that puts 16650 "après" back out of study, wait
  until the no-doubles fix is deployed: the live lesson sync would bring
  those cards back. By the rule, on the read-only snapshot taken after the clean-up
  and counting a card that is one item of another card's list (2026-10-07):
  the owner 6 (all list items, such as "à l'heure" beside "à temps /
  à l'heure"), demarajackson 25 (9 of them list items) and laura.caufour 3,
  all with answers, so check 10 fails for them every morning until they are
  put away; foisydm 23, nguyen.t12090 2 and sammy 1, who have no answers and
  aren't checked. demarajackson had 19 before the rule was corrected on
  2026-10-06: three were pairs the old reading labelled as two meanings
  ("pas mal" / "pas mal (quite a lot;)", "ça allait" / "ça allait ?", and two
  "venir chercher" cards), which are now look-alikes for Claude. The owner's
  deck also has drill-and-word pairs; those are look-alikes, which the
  morning run puts to Claude.
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
- **Podcasts doesn't check that the caller follows the podcast** (2026-10-09).
  Opening an episode (which writes its questions the first time), marking an
  answer and adding a card all take any episode's id, and any signed-in
  account can read every episode. Only the owner can call them now, so it
  costs nothing. Before students get Podcasts, the owner decides on this
  check together with who pays for an episode's questions (see *Who pays for
  Claude*).
- **Whether "Add to my cards" should bring back a card the student removed
  isn't decided** (2026-10-09). For now it doesn't: the button says "You
  removed this card earlier" and nothing is written, as the lesson sync
  leaves a removed card out. An Add is the student asking for that word
  again, so the owner may want it back in study instead.

### Not yet checked on the live app

Each was tested against the mock or a stand-in only; worth checking signed in.

- **Podcasts** (2026-10-09), on the test app (`migration_017` run 2026-10-09).
  Every part was tested against stand-ins only.
  - Claude, for real: no real call has written an episode's questions or
    marked an answer. Which passages it picks, the ideas it lists, the words
    it offers and how lenient its marking is are unseen on a real episode.
    Open a Journal en français facile episode and answer a few passages, one
    deliberately half right.
  - Listen's timing with RFI's real audio: the start and stop are checked
    against the estimate, not heard. Press Listen on passages early, in the
    middle and at the end of an episode, and on one with someone
    interviewed; each should start just before the passage and stop just
    after it.
  - RFI and Spotify from Vercel's servers: the feeds, the episode pages and
    Spotify's oEmbed were read from the Mac while building the parsing,
    never from Vercel, which either site could treat differently. Add a
    podcast by pasting a Spotify episode link and a show link, and open an
    episode.

- **The checks of repeated cards** (2026-10-06). Only stand-ins have
  answered the look-alike question in the morning run and in its test. After
  migration_016, the next 14:00 UTC run should put up to 200 of the owner's
  875 look-alike pairs to Claude and keep them in `card_pairs`, and the
  morning check should print the line; the 15:00 or 16:00 run should keep a
  `repeats` run in `eval_runs`.
- **No card made twice** (2026-10-06). After migration_016, upload the same
  notes twice: the second should say no new cards and every class already
  read. Then the first sync (Check now) should read only the lines of
  2 October and 28/29 September that are on no card: an upload of pasted
  text or a file leaves those classes to it. Claude's same-or-different question has only met a stand-in; the
  plan's third test (the owner's real doc against a private copy of the deck,
  and the 63 groups and 30 "different" pairs through the real question, a few
  cents) was offered, not run. `migration_016` was run on a local Postgres 16
  built from `supabase/schema.sql` and every migration, twice, with its two
  functions exercised (a refused card, two cards with one French, a turn
  renewed and a turn lost); not yet on Supabase. Before it is run, the deck
  load asks for `archived_reason`, is refused and asks again without it: one
  extra request per page load, checked against a stand-in, not the live
  PostgREST.

- **The first-visit tour** (2026-10-06). Sign up with a new address and the
  tour should come up once the app opens; sign out and in again, or open it on
  another computer, and it shouldn't. An existing student should get it once
  too. Saving `tour_shown` to the account has only been tested against the
  mock.

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
- **`splitSenses.js` still runs Opus 5** where Sonnet would do.
- **Claude's work in Podcasts isn't tested against the owner's decisions**
  (2026-10-09), unlike its marking of disputed answers, its reading of notes
  and its same-card question. Nothing yet records what the owner thinks of a
  podcast verdict or a passage Claude picked, so there are no right answers
  to test against yet.
- **Stale comments.** Two comments still say adding a lesson copies its cards,
  though there is no add step: the one above the Lessons page in
  `src/FlashcardApp.jsx` and the header of `src/data/lessons/index.js`. Several
  others no longer match the code: in `src/FlashcardApp.jsx`, the one above `answer()`
  (`card_progress` no longer drives Stats) and those on `cardTopSpacer`,
  `cardWrap`, `S.card`, `typeLinksRow` and `cardBadge`; in
  `src/LessonPanel.jsx`, where the feedback panel renders.
