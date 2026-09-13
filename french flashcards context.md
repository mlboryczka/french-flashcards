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
| AI | `@anthropic-ai/sdk` ^0.124.0, called only from serverless functions. Model is per route — see the table under Serverless functions. **Each user brings their own API key** (see Who pays for Claude) |
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

`npm test` before every push. It is 18 suites, and closer to twenty minutes
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

**On the Mac, 15 of 18 pass, and that is the baseline.** `layout` (type mode:
the card moves 5px when graded), `motion` (the panel travels 0px) and `reflow`
(the tutor reflow ran 0px) fail the same way on `9b95052`, which passed all of
them in the container. So it is this machine's headless Chrome, not the code —
see the open item. A new failure in any other suite is real.

---

## How a session is built

`src/lib/sessionQueue.js` → `buildSession(cards, opts)` deals one **block** of
up to 50 cards. FSRS decides when a seen card comes back; which new card comes
next, and when, is decided here. The rules were agreed with the owner on
2026-09-12 — see that History entry for the reasoning and what was rejected.

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
  date within 14 days), newest class first; then earlier notes, most classes
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

### The checkpoint

After the last card of a block, `data-checkpoint` replaces the card (it
replaced "Session complete!" and the New Session button). It says how the
block went ("50 cards, 43 right first time" — first answers of the day, either
mode), what each area moved (`progressChanges`: lesson, recent classes,
earlier notes), and then one of:

- **Continue**, which deals the next block;
- **"You're in a review phase"**, when the next block would have no new cards
  but new cards exist;
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

`applyAnswer(card, got)` maps the binary typed result onto two of FSRS's four
ratings — `Again` for a miss, `Good` for a hit. `Hard`/`Easy` exist for apps
where the user self-rates; here the typing check *is* the grade, and inventing
a confidence signal the user never gave would only feed FSRS noise.

**FSRS gets one answer per card per day: the first.** `answer()` skips the
scheduler write when `reviewedToday(card.last_review)` (`src/lib/studyDay.js`)
says the card already had its review on the student's own day. The card is
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

### FSRS configuration (`src/lib/spacedRepetition.js`)

```
request_retention: 0.9      maximum_interval: 3650
enable_short_term: false    enable_fuzz: true
```

`enable_short_term: false` means FSRS never enters the Relearning state, so a
miss is recorded on the row as `last_answer_correct` instead. `sessionQueue`
reads that to find lapses.

---

## Card types: grammar / vocab / phrase

`src/lib/cardTypes.js` → `classifyCard(card)`.

Storage keeps four cahier category codes (`V`/`E`/`G`/`P` → vocab/expr/gram/
pron) because that is what the notebook sections are. Those are **not** the
distinction you study by, so the UI collapses them into three:

- **grammar** — `gram` or `pron` category, or a conjugation drill (front
  contains `→`, e.g. `aller (subjonctif) → ils/elles`)
- **vocab** — one word *or one concept*. `la patate douce` is a sweet potato,
  `le chemin de fer` is a railway: one thing to learn, however many words
  French spells it with. Determiners and compound-noun glue (`de`, `à`) don't
  count toward the size; gender pairs (`un vendeur / une vendeuse`,
  `gros, grosse`) are one headword
- **phrase** — an `expr` card of any length, or anything with a clause: a
  subject pronoun, or more than three real ideas strung together

Used for the **All / Grammar / Vocab / Phrases** filter in the Cards view, the
**By type** panel in Stats, and the tag on each card in Hardest Cards.

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
| `parse-cahier.js` | Notebook text → cards. The big one: section slicing, homework stripping, slash-pair splitting, conjugation expansion, polysemy-aware dedupe |
| `chat.js` | Tutor chat. Streams (SSE), Sonnet 5 at effort `low`, sent a slice of the deck as context. Proposes cards via a `propose_flashcards` tool; **never writes** — the client does the RLS-protected insert |
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
| `parse-cahier.js`, `cahier-parse.js` | `claude-haiku-4-5` | Structured extraction from a regular format. Correct as-is |

`api/_lib/` is skipped by Vercel's function discovery (underscore prefix), so
it is import-only.

**Environment:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`,
optionally `ANTHROPIC_API_KEY` (owner only), plus `VITE_SUPABASE_URL`,
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
`ADMIN_EMAIL` falls back to the server's `ANTHROPIC_API_KEY`.

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

Deck maintenance that is real work but is nobody's *feature*. Both run from a
terminal against production, read `.env.local` themselves, and **default to
writing nothing** — `--apply` is what makes them write.

| Script | Does |
|---|---|
| `fix-multi-sense.mjs` | The multi-sense cleanup end to end: scan, audit, apply. `DECK_USER_ID` narrows it to one deck; omit it for every user |
| `resolve-disputes.mjs` | Works the backlog of "my answer should have been accepted" claims left in `feedback_submissions` |

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
  what either panel covers.
- **The feedback sheet is offset by `SIDEBAR_WIDTH`** so it centres over the
  content column instead of straddling the nav.
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
  answer stacks a result banner, the dispute link and the Continue row). The
  card area centres its contents, so without the well, swapping the typed-answer
  input for the graded state re-centred the whole column and the card jumped
  45px up the page mid-answer. The card now holds one position in every state.
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
  behind it, the worst jerk of the lot.
- **The page's padding is driven by `entered`, not by mount**, and reported
  from a `useLayoutEffect`. Both state changes then land in one React commit and
  the two transitions start on the same frame. Reporting the height at mount
  let the page set off two frames before the sheet did, which measured as 32px
  of drift; tying them together makes it 0.
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
  `min(300px, 38vh)` as a backstop, not the usual case.
- **The whole sheet is the drop and paste target**, which is what let the
  dedicated dropzone go. Dragging over it outlines the entire panel; the
  Screenshot chip is the click-to-browse affordance.
- **The sheet carries `data-feedback-sheet`.** Tests identify it by that marker:
  matching on a line of copy broke when the subtitle went, and matching on "a
  fixed panel containing a textarea" also matched the tutor.
- **Tutor and feedback are mutually exclusive.** Opening one closes the other,
  routed through the feedback sheet's own close request so an unsent draft
  still prompts — and declining the prompt cancels opening the tutor rather
  than silently eating what you typed.
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
  `maxWidth: 920` still caps it. The minimized bar had the identical bug.
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

---

## Testing

`npm test` — see `tests/README.md`. Eighteen suites: six needing no browser,
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
  failure the app hadn't caused.
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
catalogue. The first is **L'impératif** (108 cards), built from Laura Caufour's
LFL METHOD lesson and exercise PDFs.

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
  upsert, delete) and asserts on what the student ends up with: 108 cards, each
  keyed, studiable, with all four note sections rendering; a second visit
  writing nothing at all; and an existing deck keeping its own cards and their
  FSRS state.
- **Synced on load, once per mount.** A student finds L'impératif in their deck
  without pressing anything. The lesson is the authority, so the sync also
  *retires* cards it no longer contains: that is how the eight abandoned "state
  the rule" cards were removed from decks that had already added them. Only
  writes when the deck and the lesson actually differ.
- **`lessonFilter` narrows the candidate pool** exactly as `typeFilter` does, so
  a lesson still schedules through FSRS rather than becoming a separate mode.
- **Notes live on the lesson** (`LESSON.notes`) and render in `LessonPanel`, a
  slide-over reusing the tutor's mount/enter mechanics. Distilled for glancing
  at mid-card, not for reading: tables for paradigms, two columns for
  contrasts, and the rules people get wrong called out on their own.

### Card-design rules the impératif module established

- **Every card is a thing to produce, never a rule to recite.** An early version
  had `impératif : -er et aller devant en / y` answered by `prennent un -s`.
  That is a statement, not a question, and there is nothing to type. Each rule
  is now carried by examples that make you apply it.
- **Every French-answered card carries an arrow in its front.** Load bearing:
  `classifyCard()` treats it as a conjugation drill, and `answerLang()` reads it
  to know the typed answer should be French rather than English.
- **The card wears its lesson as a badge**, so fronts do not spend their opening
  words on `(impératif)`. The badge is also what keeps a shortened front
  unambiguous once the cards mix into the wider deck.
- **Exercises are sampled, not transcribed.** Laura's ~150 items became 49
  cards. A worksheet's twenty pronominal verbs work because they are twenty in
  one sitting; as cards they would be twenty review streams for one rule. The
  test is whether an item teaches something no other card teaches.

---

## Progress, and the "mastered" relic

**Status: built on 2026-09-12**, as part of the serving strategy (see that
day's History entry). What was built differs from the design below in four
ways, and where they disagree, this paragraph wins:

- **The completion screen is a checkpoint after every block of 50**, not one
  end-of-session screen. See *The checkpoint* under *How a session is built*.
- **The lesson top bar reads "about 43 of 108 remembered"**, with the "about"
  the wording rules below insist on.
- **The Stats page** (`data-stats-all`, `data-stats-areas`,
  `data-stats-coming-up`) has: Today and Right first time today, counted off
  each card's `last_review` — exact, because FSRS gets one answer per card per
  day; the streak; one three-band bar for the whole deck; *Your progress*, a
  row per lesson, recent classes and earlier notes; *Coming up*, cards due on
  each of the next seven days; *By type* with seen / about remembered in place
  of "mastered"; Hardest cards and Reset unchanged. Guarded by the `stats`
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
`stats.got / stats.seen`; across sessions it needs the review log the app does
not keep.

Retrievability inherits the direction problem: one number per card covering
both FR→EN and EN→FR.

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

---

## Open items

- **The new serving strategy has not been checked on the live app, signed
  in.** Everything from 2026-09-12 was tested against the mock and confirmed
  in the deployed bundle, never on a real account with a real deck. Worth
  looking at: the first block is 50 or fewer, due cards before new ones; the
  checkpoint appears after 50 and Continue deals different cards; L'impératif
  starts at card 1 with "about N of 108 remembered" in its bar; the Stats
  figures are believable for an 8,700-card deck. Answering cards on the
  owner's account writes real reviews, so either look without answering or
  use a throwaway account.
- **Three browser suites fail on the owner's Mac and pass in the container.**
  `layout`, `motion` and `reflow` — see *Working protocol*. They measure
  movement frame by frame and this machine's headless Chrome reports it
  differently. Until they're adjusted, layout and animation changes made on
  the Mac have no working check, so measure those by hand in a browser.

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
  made, and there is no review log. The honest fix is a `first_seen_at` column
  on `user_cards`, set by the first recorded answer — a migration, where the
  rest of the strategy needed none. Needs the owner's say-so.
- **One FSRS state covers both directions of a card.** `shownDir` is assigned
  per session, but stability and difficulty live on the row — so recognising
  *une colline* and producing it from "a hill" feed one number. They are
  different skills with different difficulty. This is why a card can read as
  well-known and still ambush you, and it is a modelling gap rather than a
  display one: fixing it properly means two FSRS states per card.
- **No review log.** Only the current FSRS state is kept, not the history that
  produced it. So there is no true-retention figure across sessions, no
  progress-over-time graph, and no way to re-optimise FSRS parameters against
  this learner's own answers — which is the feature that makes FSRS better
  than its defaults. It is also why the Stats page has no finish estimates.
- **The feedback sheet has no Escape handler.** Written when the tutor and the
  lesson notes both closed on Escape and the sheet was the odd one out; since
  2026-09-11 neither of them does, so the *inconsistency* is gone and the case
  now rests on the sheet itself. It still holds: the sheet is the one panel you
  open, use and put away, and it already dismisses on an outside click, so
  Escape is the keyboard spelling of a gesture it accepts anyway — while for
  the other two Escape was actively wrong, being the reflex for clearing a
  field mid-answer. It is not a one-liner: closing has to go through
  `handleCloseClick` so an unsent draft still prompts, which is why it was left
  rather than bolted on.
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
  not built. Every card carries a section (`forms`, `irregular`, `ind2imp`,
  `negative`, `pronominal`, `ex1`…`ex8`, `phrase`) and nothing reads it. The
  one place that unpacks a lesson card is `reconcileLessons`
  (`src/lib/lessonSync.js`), which destructures `([f, b, c])` and drops the
  fourth element on the floor. The section still never reaches a stored row,
  but it no longer has to: since 2026-09-12 `lessonRank`
  (`src/data/lessons/index.js`) looks each lesson card up in the lesson's own
  data by its key, and `teachingOrder` on the lesson already lists the
  sections in the order they're taught. A per-section bar can read the
  section the same way, with no change to the row.

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
- **A second lesson has not been attempted.** The generator idea — parsing
  Laura's PDFs into cards automatically — was scoped but not built, and
  designing it from one example would be a mistake. Her materials look
  templated (numbered sections, *Détail* callouts, a "phrases à apprendre par
  cœur" list); worth confirming across two or three more lessons first.
- **`expandConjugations` is mood-blind.** `SUBJECT_PRONOUNS` is a fixed
  six-person list indexed positionally and the tense enum has no `impératif`,
  so a three-form table imports as `être → je = "sois"`. It did not bite the
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
  visibly worse.
- **The tutor's cache breakpoint may be a no-op.** The system prompt plus tool
  schema is roughly 900 tokens and the minimum cacheable prefix is
  model-dependent; below it, `cache_control` silently does nothing. One
  `count_tokens` call against the real prompt would settle it.
- **`split-senses.js` still runs Opus 5** for what is batch classification
  against written-out rules — see the table under Serverless functions. It is
  offline, so it could also go through the Batch API at half price.
- **Answers in the impératif module were written by Claude, not by Laura.** Her
  exercise sheet ships no answer key. Worth a pass from her before it goes to
  students.
