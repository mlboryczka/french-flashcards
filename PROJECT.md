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
| `chat.js` | Tutor chat. Proposes cards via a `propose_flashcards` tool; **never writes** — the client does the RLS-protected insert |
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

`npm test` — see `tests/README.md`. Nine suites: two pure-logic, seven driving
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

## Recent work (branch `claude/app-testing-bugs-ncyhde`)

A pass driving the app by hand rather than by test, looking for what the suite
wasn't asking about. Five bugs, four of them only reachable by working the app
the way a person does:

- **A flip-mode session had no end.** The completion notice was gated on
  `stats.seen > 0`, and `stats.seen` counts *typed* answers only — so in the
  default flip mode you reached the last card and it simply sat there, "Got It"
  still live under your cursor. Clicking it wrote another FSRS review each
  time; a stuck session put 45 reviews on one card in under a minute. The end
  of the queue now replaces the card with a completion panel and `answer()`
  refuses to grade past it. The same notice also used to appear one card
  early, because `idx` sits on the last card both before and after you answer
  it — hence the explicit `sessionDone` flag rather than a comparison against
  `deck.length`.
- **Study shortcuts reached the card through overlays.** The keydown handler
  checked only whether the event target was an `INPUT` or `TEXTAREA`, and most
  of a panel is neither: pressing Enter to submit in the upload dialog, or
  after clicking anywhere inert in the tutor, graded the card behind it as
  "Got It" — a real scheduling write, for a card whose answer was never on
  screen, invisible in the UI and not undoable. Both handlers now bail on
  `overlayOpen`.
- **The profile menu couldn't be put away** — no outside click, no Escape.
  Dismissal is on `mousedown` and decided by containment, so the menu's own
  items still fire.
- **20px of horizontal scroll on a phone.** The two decorative blur circles in
  the card area sit deliberately outside their container (`left:-60` /
  `right:-60`); `S.shell` clips them, but the narrow layout uses
  `S.shellNarrow`, which clipped nothing. `overflowX: hidden` there — the
  narrow layout is meant to scroll vertically, so only the one axis.
- **The "Loading…" hang and the missing tables**, both long-standing open
  items below, closed. See those entries.

Also fixed a real flake in the `cards` suite that had nothing to do with the
app: see the third rule in `tests/README.md`.

New `session` suite covers the queue ending, the keyboard isolation and the
menu dismissal; the `layout` suite gained a horizontal-overflow sweep across
the 768px breakpoint.

---

## Open items

- ~~**The silent "Loading…" hang.**~~ Fixed. `getSession()` races a 10s
  timeout and carries a `.catch()`; either way you get an explanation and a
  Try again button instead of "Loading…" forever. `onAuthStateChange` clears
  the error if the backend comes back on its own. The message names the likely
  cause, since on the free tier it is almost always a paused project.
- ~~**`create table user_cards` is missing from the setup SQL.**~~ Fixed —
  along with `user_review_dates` and `beta_feedback`, which were missing too.
  All three are now in `supabase/schema.sql` with their RLS policies. The
  scheduling columns deliberately stay in the migrations rather than being
  inlined, so a project set up today and one running since the Leitner era end
  up with the same table: run `schema.sql`, then 002 → 007 in order.
- **Mobile / PWA.** Discussed, never started. The layout is responsive below
  720px but there is no install manifest or offline support.
- **The cleanup tool's Claude step has never run against the live deck.** The
  scan, review UI, apply path and write logic are all tested; what Claude
  actually proposes for real cards is unseen. Review before applying.
- **"Flips look jumpy and glitchy" is reported but unreproduced.** Four
  hypotheses were tested and all four falsified: `container-type: size`
  flattening `preserve-3d` (it still rotates — measured mid-flip width 66px
  against a 600px resting width); the responsive font jittering (one font size
  for the whole flip); the card growing and rising during rotation (real, but
  byte-identical on the commit *before* the card-fit change — it is pre-existing
  perspective); and the removed `await` in `answer()` leaving `skipFlipAnim`
  set so flips snap (they animate, including on the card after advancing).
  Headless Chromium at 1x may simply not show it. Worth asking what it looks
  like specifically — stutter mid-rotation, both faces briefly visible, a white
  flash — and in which mode.
