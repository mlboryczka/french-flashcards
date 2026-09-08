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
| AI | Anthropic SDK, model `claude-opus-5`, called only from serverless functions |
| Hosting | Vercel — `api/*.js` are serverless functions, auto-deploys on push to `main` |

**Free-tier gotcha:** Supabase pauses a project after ~7 days idle, and
`getSession()` then never settles. `App.jsx` races it against a 10s timeout and
catches rejections, so this now surfaces as "Couldn't reach the server" with a
Try again button and a note about paused projects, rather than "Loading…"
forever. Resuming the project in the Supabase dashboard is still the fix.

---

## How a session is built

`src/lib/sessionQueue.js` → `buildSession(cards, opts)`.

Selection is by priority, then **order is randomised**. Those are two separate
decisions and it matters:

1. **Lapses** — missed last time, due now
2. **Reviews** — due now, oldest-due first
3. **New** — never answered, capped at `newCap` (20)
4. **Spot-checks** — a random sample of mastered cards (stability ≥ 60d),
   ignoring due date; insurance against FSRS being over-confident

New and spot-check slots are **reserved before** the target is spent on due
work. Without that, a review backlog larger than the target starves new
material completely — with ~1,300 cards due and a target of 75, you would not
meet a new word for weeks.

The queue is then shuffled. Presenting fixed blocks (all lapses, then all
reviews) is *blocked practice*, which feels easier during the session and
tests worse afterwards. Mixing is *interleaved practice* — about g = 0.42 in
Brunmair & Richter's (2019) meta-analysis of 59 studies.

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
| `review-answer.js` | Adjudicates "my answer should have been accepted" |
| `tts.js` / `pronounce.js` | French speech; `src/audio.js` falls back to the browser's own `speechSynthesis` when the backend is unreachable |
| `admin-users.js`, `parse-corrections.js`, `upload-batches.js`, `cahier-parse.js` | Admin and upload plumbing |

`api/_lib/` is skipped by Vercel's function discovery (underscore prefix), so
it is import-only.

**Environment:** `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `VITE_ADMIN_EMAIL`, plus `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` on the client.

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
- **`shellNarrow` clips one axis, `shell` clips both.** The card area's two
  decorative blur circles are positioned outside their container on purpose
  (`left:-60` / `right:-60`); the desktop shell's `overflow:hidden` hid that
  fact for a long time. Below 768px the narrow shell clipped nothing and the
  document came out 20px wider than the window. It takes `overflowX` only:
  the narrow layout scrolls vertically by design — its nav is a fixed bottom
  bar — so clipping both axes would be wrong.

---

## Testing

`npm test` — see `tests/README.md`. Eight suites: two pure-logic, seven driving
the real app in headless Chromium against a mock Supabase, asserting on
**measured** values (geometry, computed styles, request payloads) rather than
on intent.

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
- **Tagged `source = "lesson:<id>"`.** That column already existed — the cahier
  parser writes `cahier-upload`, the tutor writes `tutor-chat` — so lessons
  needed no migration.
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

### Still true, and worth knowing

`@anthropic-ai/sdk` is pinned at **0.27.3** (mid-2024), which predates
`output_config`, adaptive thinking and GA prompt caching. It works because that
SDK passes unknown body keys through verbatim — verified by capturing the
request it builds — not because it supports them. A bump is overdue and would
touch all five API routes.

## Open items

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
  hypotheses tested and falsified; see the history in git. Separately, the card
  DOES resize on ~16 of 25 frames during a panel reflow, because `padding-bottom`
  is a layout property and the card's `cqh` text re-resolves each time. Measured
  under CPU throttling. Animating `transform` instead would fix it, and would
  change what the layout and motion suites assert.
- **Answers in the impératif module were written by Claude, not by Laura.** Her
  exercise sheet ships no answer key, and her lesson PDF has at least one error
  (`Vous lui donnez` paired with `Donne-lui`; the subject is *vous*). Worth a
  pass from her before it goes to students.
