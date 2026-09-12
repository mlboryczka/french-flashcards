# French Flashcards — project context

A spaced-repetition flashcard app for learning French, built around one
person's year of handwritten class notebooks ("cahiers"). You upload a
notebook, Claude parses it into cards, and FSRS decides what you see and when.

Live at `french-flashcards-nine.vercel.app`. Repo `mlboryczka/french-flashcards`.

This document is written to bring a fresh session up to speed. It describes
what exists, why the non-obvious parts are the way they are, and what is
still open.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 18, no router, no CSS framework — styles are inline objects in a `S` / `T` theme constant |
| Scheduling | `ts-fsrs` 5.4.2 |
| Auth + data | Supabase (Postgres, magic-link email, RLS), free tier |
| AI | Anthropic SDK, called only from serverless functions. Model is per route — see the table under Serverless functions. **Each user brings their own API key** (see Who pays for Claude) |
| Hosting | Vercel — `api/*.js` are serverless functions, auto-deploys on push to `main` |

**Free-tier gotcha:** Supabase pauses a project after ~7 days idle, and
`getSession()` then never settles. `App.jsx` races it against a 10s timeout and
catches rejections, so this now surfaces as "Couldn't reach the server" with a
Try again button and a note about paused projects, rather than "Loading…"
forever. Resuming the project in the Supabase dashboard is still the fix.

---

## Working protocol

**Commit straight to `main`.** Vercel deploys from `main`, so a change is not
real until it lands there — a feature branch is invisible to the live app and
to anyone looking at it. Work has been going to `main` directly since the
2026-09-07 session and that is the convention.

An agent session may arrive pre-configured with its own feature branch and an
instruction not to push anywhere else. That configuration does not know about
this project. Say so at the START of the session and get it resolved, rather
than working for an hour and pushing somewhere nobody is looking — which is
exactly what happened on 2026-09-08, and cost a whole session's work being
invisible until it was noticed.

`npm test` before every push. It is 12 suites and a few minutes.

---

## How a session is built

`src/lib/sessionQueue.js` → `buildSession(cards, opts)`.

Selection is by priority, then **order is randomised**. Those are two separate
decisions and it matters:

1. **Lapses** — missed last time, due now
2. **Reviews** — due now, oldest-due first
3. **New** — never answered, capped at `newCap` (20)
4. **Spot-checks** — a random sample of well-known cards (stability ≥ 60d),
   ignoring due date; insurance against FSRS being over-confident. That
   threshold is the whole of what "mastered" means — see **Progress, and the
   "mastered" relic**

New and spot-check slots are **reserved before** the target is spent on due
work. Without that, a review backlog larger than the target starves new
material completely — with ~1,300 cards due and a target of 75, you would not
meet a new word for weeks.

The queue is then shuffled. Presenting fixed blocks (all lapses, then all
reviews) is *blocked practice*, which feels easier during the session and
tests worse afterwards. Mixing is *interleaved practice* — about g = 0.42 in
Brunmair & Richter's (2019) meta-analysis of 59 studies.

### `target` is a ceiling, not a length — and there are no modules

`target: 75` is the most a session may contain, not what it fills to. You get
however many cards genuinely qualify, which is a different number every time
and is invisible before you start. The first pass at a fresh lesson is
**exactly `newCap`**: nothing is due yet, and nothing has 60 days of stability
for a spot-check, so the queue is 20 cards and no more. Come back once those
are due and lapses and reviews have something in them, so the same lesson
serves up to 75.

This is correct behaviour that reads as a bug, and it has been reported as
one. Two things cause that:

- **The completion screen says "Session complete!"**, with a *New Session*
  button, whether you are studying the whole deck or one lesson. It means "the
  queue for the current filter is empty". It is read as "you have finished
  L'impératif" — a fair reading of that sentence, and wrong. Nothing is ever
  finished in FSRS; intervals just get longer.
- **Nothing anywhere tracks progress through a lesson.** The lesson bar shows
  the title. The counter (`Card 12 of 20`) is your position in *today's queue*.
  Stats breaks down by card type. So with 108 impératif cards there is no way
  to tell whether you have met 20 of them or 90.

Fixed-length modules would be the wrong fix — they fight the scheduler, whose
whole job is to decide what you see. What is missing is honest reporting: an
end screen that distinguishes "nothing due right now" from "done", and a
per-lesson progress figure. See **Progress, and the "mastered" relic** below.

`applyAnswer(card, got)` maps the binary typed result onto two of FSRS's four
ratings — `Again` for a miss, `Good` for a hit. `Hard`/`Easy` exist for apps
where the user self-rates; here the typing check *is* the grade, and inventing
a confidence signal the user never gave would only feed FSRS noise.

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

Three-step tool, profile menu → **Fix multi-sense cards**:

1. **Scan** — `src/lib/multiSense.js` runs over the whole deck in the browser,
   free. Shortlists on the deck's own separator conventions: a semicolon means
   senses got run together, so divergent parts suffice; a slash is the
   near-synonym marker (`to unload / to discharge`) and a short comma list is
   a gender pair, so those only count when the parts aren't even the same part
   of speech. Keeps the API bill to the real suspects, not all 8,700 cards.
2. **Check** — `POST /api/split-senses`, batches of 15. Claude decides
   split-or-keep and writes the correct front for each sense: the noun keeps
   its article (`les frais`), the adjective doesn't (`frais (adj)`), verbs go
   to the infinitive. Told to keep when unsure. Writes nothing.
3. **Apply** — every proposal is shown beside the card it replaces and can be
   unticked, then `POST /api/apply-splits` writes. The original row is
   rewritten as the first sense and **keeps its scheduling history**; the
   other senses become new cards starting fresh. Ownership is checked row by
   row; malformed splits are refused at both ends.

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

## Migrations

Run in order in the Supabase SQL editor. `migration_006` is **schema only** and
`migration_007` holds all seeding — deliberately separated so re-running 006
can never undo 007.

- `005_spaced_repetition` — Leitner boxes (superseded)
- `006_fsrs` — adds `stability`, `difficulty`, `fsrs_state`, `reps`,
  `last_review`, `last_answer_correct`, plus a check constraint and two indexes
- `007_fsrs_reseed` — idempotent. Resets to New anything with `box <= 1 AND
  lapses = 0 AND NOT EXISTS (card_progress.seen > 0)`; re-seeds the rest from
  the box ladder or the `card_progress.score` ladder

**A cautionary tale worth knowing:** the first version of 006 treated the
`dates` array as review history. It isn't — those are the *lesson* dates a word
appeared on, so every parsed card has them and all 8,703 cards were marked as
reviewed. `isNewCard()` had the same bug, which meant the 20-new-per-session
cap had silently never applied. Production after the repair: 7,361 New /
1,342 Review.

---

## UI layout notes

These look arbitrary and are not:

- **`main` owns the reflow, not the shell.** Both side panels (tutor, feedback)
  push the content column via padding on `<main>`. Padding the shell shrank the
  **sidebar** too, jumping its account block up the page. The sidebar is not
  what either panel covers.
- **The feedback sheet is offset by `SIDEBAR_WIDTH`** so it centres over the
  content column instead of straddling the nav.
- **The card is height-driven, with a floor** — `height: 100%`, `min-height:
  170`, capped at 375, width following the 1.6:1 ratio. It used to be a fixed
  600×375, and once the window was shorter than that, centring overflowed in
  *both* directions and the top of the card rode up over the counter and the
  back button. The card area also uses `justify-content: safe center`, which
  falls back to top-alignment rather than overflowing upward.

  The `min-height` and the sizing below it were the *second* fix: height-driven
  with no floor meant the card absorbed the entire squeeze when a panel opened
  — at a 700px viewport it collapsed to 80×50 with its text still at 40px,
  while 130px of padding sat unused beneath it.
- **The card text sizes to the card**, not to the page. The card sets
  `container-type: size` and the text uses `clamp(19px, 10.7cqh, 40px)` — 40px
  at full size, scaling down with the card so a squeezed card is still legible
  rather than three enormous words.
- **`cardArea`'s 130px bottom padding is breathing room, not structure.** It
  drops to 16 whenever a panel is open, so the space below the card is given up
  before the card gives up anything.
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
- **`ChatPanel` swallows the click that dismisses it** (otherwise it lands on
  the card underneath and flips it), but exempts real controls — that swallow
  was eating clicks on "Send feedback".
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
- **`cardWrap` has a definite flex basis (`0 1 375px`), not `1 1 auto`.** It
  used to grow to swallow every spare pixel of `cardArea`, and that slack split
  a reflow into two separate motions: the slack went first, so the card slid
  upward at full size, and only once it ran out did the card stop sliding and
  start shrinking. One 420ms animation, two behaviours, with a hard switchover
  ~80% through — and on the way back the easing crossed the handover in about
  two frames, so the card recovered 12 of its 19px in a single one. A definite
  basis leaves no slack to spend first. The basis must stay definite: `auto` is
  circular against the card's `height: 100%` and collapses it to its 170px
  floor. This also made the card *larger* on short windows (at 700px tall,
  461x288 -> 491x307) because the old `auto` basis was over-shrinking it.
- **The card caps its height against its WIDTH, via a container query.**
  `aspect-ratio` only holds while one axis is free to follow the other, and the
  card had its height driven by the flex column and its width capped by
  `max-width: 100%` — so once the column was the tight axis both were pinned
  and the ratio lost. At an 800px window the card was 464x375, near enough a
  square; at 900 it was 1.5:1. Long-standing, and invisible to a suite that
  varied only the window height. `cardWrap` is now a `container-type:
  inline-size` container and the card's `maxHeight` is `min(375px, 62.5cqw)` —
  62.5 being 100/1.6 — so whichever cap binds first it stays 1.6:1. It must be
  INLINE-size: size containment on an ancestor of the rotating card is the same
  hazard as putting it on the card, and the flip was re-verified by sampling
  the transform mid-rotation.
- **`cardTopSpacer` shrinks at factor 8, not 1.** Flex shrinks weighted by
  factor x basis, so against cardWrap's 375 the old factor of 1 had the spacer
  absorbing only 106/481 of a squeeze and handing the card the other 78% — when
  the whole point of the spacer is to give its space up *first*. At 8 the card
  gives up about a third as much and the worst frame of a reflow drops from
  12.2px to 4.8px. It only bites under pressure; resting geometry is untouched.
- **The layout suite varies the window's WIDTH as well as its height.** The
  height-only loop it had could only ever catch the card being squeezed
  vertically, and the squarish-card bug above lived through it untouched — then
  a later change made it worse before there was a check to say so.
- **`shellNarrow` clips one axis, `shell` clips both.** The card area's two
  decorative blur circles are positioned outside their container on purpose
  (`left:-60` / `right:-60`); the desktop shell's `overflow:hidden` hid that
  fact for a long time. Below 768px the narrow shell clipped nothing and the
  document came out 20px wider than the window. It takes `overflowX` only:
  the narrow layout scrolls vertically by design — its nav is a fixed bottom
  bar — so clipping both axes would be wrong.

---

## Testing

`npm test` — see `tests/README.md`. Fifteen suites: four needing no browser,
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

## Recent work (branch `claude/french-flashcards-troubleshooting-f1z8yn`)

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

## Recent work (session of 2026-09-07/08, committed straight to `main`)

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

### The rule that keeps coming up

`loaded` gates the entire tree — `if (!loaded) return <div>Loading…</div>`
unmounts everything, including whatever panel you were using. A refetch for the
same person is a BACKGROUND refresh and must never clear it. Both `useUserDeck`
and `useProgress` now hold a `loadedForUser` ref for this. Both also cache to
localStorage so a fresh boot has something to paint; the deck cache opts out
above 2.5MB, since a deck in the thousands does not fit the quota.

---

## Recent work (branch `claude/tutor-functionality-improvements-wa5wa8`)

The tutor, which was slow, generic, and hard to get a good card out of.

### The latency was a default that changed underneath the file

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

### Everything else it needed

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

### Two bugs found by driving it, not by running the suite

- **Editing a card before adding it never showed as added.** `addCard` keyed the
  added-set on the *edited* front while the chip checked the *original*
  proposal, so the two never matched and you could add the same card
  repeatedly. The check now lives inside `ProposedCard`, against its own state.
- Writing the suite: `button:has-text("Send")` also matches **"Send feedback"**,
  which closed the tutor and opened the feedback sheet. `:text-is()` for both
  that and Add, since "Added" contains "Add" too.

### The SDK, since it came up

The tutor's parameters — `output_config`, adaptive thinking, GA prompt caching
— all postdate `@anthropic-ai/sdk` 0.27.3, which this project was pinned to
when the work started. They reached the API anyway, because that SDK forwards
unknown body keys verbatim (verified by capturing the request it builds, not
assumed). Moot now: `main` bumped the SDK to **^0.124.0** in the same window,
so the parameters are supported rather than merely tolerated.

## Recent work: bugs around the tutor branch

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

## Progress, and the "mastered" relic

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

### What to show, when this gets built

1. **Known now** — Σ retrievability over the lesson, out of its card count.
   The headline. Free from data already in the browser.
2. **Met** — how many cards you have been shown at all. Only goes up, and it
   is the "have I worked through the module" question people actually ask.
   Also free.
3. **True retention** — of the cards recently asked, the fraction you got
   right. Measured rather than modelled, and the check on whether FSRS is
   calibrated for you. Exists per session as `stats.got / stats.seen`; across
   sessions it needs a review log the app does not keep.

Retrievability inherits the direction problem: one number per card covering
both FR→EN and EN→FR.

## Open items

- **`^0.x` dependency versions can never update themselves.** The Anthropic
  SDK sat on 0.27.0 (Sept 2024) from the first commit until it was bumped to
  0.124.0, because below 1.0 a caret pins the MINOR — `^0.27.0` means 0.27.x
  forever, through every reinstall. The same trap is live again at `^0.124.0`
  and applies to `ts-fsrs` too. Check these deliberately; nothing will
  surface it.
- **Speech is browser-only now.** The Azure endpoints were deleted rather than
  secured. Restoring them means putting them behind `requireUser` and, if the
  owner should not be paying, a per-user credential like the Anthropic one.
- **Lesson progress, the "mastered" rename and retrievability are agreed but
  not built.** See **Progress, and the "mastered" relic** above for the
  decision and the three figures to show. Also unbuilt: the completion screen
  saying "nothing due right now" rather than "Session complete", and labelling
  the counter as this session's position.
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
  than its defaults.
- **Mobile / PWA.** The layout is responsive and no longer scrolls sideways, but
  there is no install manifest or offline support.
- **The multi-sense cleanup has no UI any more.** `SplitSensesModal` and its
  browser suite are gone — cleaning up cards that teach two words is
  maintenance on the deck, not a task to hand a student. What remains is the
  backend: `api/split-senses.js` (audit, read-only), `api/apply-splits.js`
  (write, service role + manual ownership checks), the scanner in
  `src/lib/multiSense.js`, and the `apply-splits` suite. Nothing invokes them
  now, so running the cleanup needs a deliberate call. The Claude audit step
  has still never run against the live deck.
- **The lesson bar should be built on the lesson's own sections.** Agreed but
  not built. Every card carries a section (`forms`, `irregular`, `ind2imp`,
  `negative`, `pronominal`, `ex1`…`ex8`, `phrase`) that both readers still
  destructure away as `[f, b, c]`. The 14 group into the four the notes panel
  already uses — Forms 30, Pronouns 46, Reflexive 15, Phrases 17 — so the bar
  and the notes would share one vocabulary, and tapping a chip could open the
  notes at the matching tab. Default stays `All` and mixed: your own doc's
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
- **New cards are introduced in random order.** `buildSession` shuffles `fresh`
  before taking the cap, which is right for a mixed deck and wrong for a taught
  module — a student can meet `Donne-les-leur` before `Regarde`. Interleaving on
  review and sequencing on first exposure are not in conflict.
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

---

## Recent work (session of 2026-09-08, lesson notes)

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

### The notes stay up while you work the card

Only the ✕ and the "Lesson notes" toggle close the panel. The outside-click
handler closed it the moment you clicked into the answer box, and Escape closed
it on the reflex of clearing a field mid-answer; the scrim still dims an
overlay-mode panel but no longer dismisses. That is what separates this panel
from the other two sharing the right-hand slot: the tutor and the feedback
sheet you open, use and put away, so an outside click meaning "done" is right
for them. Notes are reference material you keep beside the work.

Nothing was needed for the keyboard — `overlayOpen` already excluded the lesson
panel, so card shortcuts have always reached the card with it open.

### A lesson gets its own top bar

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

### The direction toggle is next

`FR→EN / EN→FR / Mixed` steers 28 of the 108 cards — direction only applies to
`flippable` ones (cat vocab or expr), and 80 are grammar, pinned front-as-
written. Three chips, the widest group in the bar, governing a quarter of the
module, and meaningless on `finir → nous`.
