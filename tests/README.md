# Tests

```
npm test              every suite
npm test -- layout    only suites whose name contains "layout"
```

`tests/run.mjs` writes a throwaway `.env.local` pointing the app at the mock
Supabase, starts that mock and the Vite dev server, runs each suite, and cleans
up. It refuses to run if a real `.env.local` is present rather than clobber it —
unless none of the suites asked for needs a browser, in which case it writes
nothing and starts nothing.

Browser suites drive the actual app in headless Chromium via `playwright-core`.
Set `CHROME_PATH` if your Chromium isn't at the default
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (the Linux container's).
On the owner's Mac it is Playwright's own:
`~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
(`chromium-1208` at present). On that Mac, `reflow`'s first check ("the tutor
reflow actually ran") also fails on and off on unchanged code — a timing flake,
not a regression.

| Suite | Covers | Browser |
|---|---|---|
| `logic` | `classifyCard`, `looksMultiSense`, `cleanFrenchPrompt`, the tutor's deck-context picker, what `/api/chat` sends the model and which of its proposed cards it keeps, `reconcileLessons`, archiving, and the cahier parser's `keepAnswerable` / `expandConjugations`: no rule or sound-note card (grammar terms caught even where they start or end with an accented letter), a conjugation table becoming its drills and only its drills | no |
| `apply-splits` | the write endpoint: ownership, malformed splits, which row keeps its scheduling history | no |
| `auth` | the guard on every endpoint that spends money: no verified session, no Anthropic request | no |
| `dates` | which day a review counts towards, and whether a card has already had today's review, run under a pinned timezone so the bug isn't invisible from the one it was written in | no |
| `serving` | which cards make a block of 50 — a word asked each way round on its own schedule, the direction setting (grammar in every setting), no way waiting for the other, a word's two first meetings kept apart, and an answer written only to the way it was shown: due today first, new cards only once those run out, the order new cards arrive in — lessons by teaching order, notes by recent classes then most-repeated words — and where a missed card's retry goes, always inside the block | no |
| `cahier-sync` | the linked cahier: only classes the deck hasn't got are parsed, a class is parsed once and never again, every run records when it looked, an edited old class changes nothing, a word taught again keeps its card and gains the date, a class's grammar rules and sound notes never reach the deck, a backlog is worked through newest first, an unreadable doc says why, a second check moments later is skipped, and the daily check refuses any caller but Vercel's cron. Its stand-in database refuses an upsert missing a NOT NULL column, as Postgres does — it once waved through a partial upsert that broke every sync after linking | no |
| `progress` | seen, about N you'd understand, about N you could say (each from its own way round) and not yet seen: FSRS's recall estimate, which area a card counts towards, and what a block changed | no |
| `instructions` | the line above a grammar card saying what to type: a drill's tense and person by name, either pronoun accepted on il/elle, a subjunctive with or without its que; every lesson grammar card has a line and no other card does; reworded impératif cards keep their place in the order; only conjugation drills left under grammar in the demo deck; and a lesson card whose front the student already has is not written over but reported as taken | no |
| `grammar-sort` | `scripts/sort-grammar-cards.mjs` against a stand-in database and a stand-in Claude, with nothing leaving the machine: the owner's 117 hand-sorted cards get exactly the owner's sort without asking Claude, conjugation drills stay, lesson and archived cards are left alone, Claude's answers are checked rather than trusted, a dry run writes nothing, `--apply` backs up first, skips a card changed since the proposal and never adds a front the deck already has in any spelling, and a second `--apply` writes nothing | no |
| `layout` | card fits the window at 7 heights; the tutor moves the content column and **not** the sidebar; the feedback panel moves nothing, on Cards and on Stats | yes |
| `panels` | tutor/feedback mutual exclusion, outside-click dismissal, the tutor's reflow axis; the feedback panel sitting in the sidebar and never over the card, its draft surviving every close, sending clearing it with a toast, and the flag on the card opening it about that card | yes |
| `sidebar` | the sidebar minimizes to a 64px rail: icons with titles, one marker, the feedback icon under the avatar, the account menu not clipped, the choice surviving a reload, feedback widening it and closing putting it back; phones untouched | yes |
| `lesson-sync` | a new account ends up with every lesson in its deck and nothing else, L'impératif checked card by card: correctly keyed, studiable, notes readable — a second visit writes nothing, and an existing deck gains L'impératif with the student's own cards and their scheduling untouched, including a card whose front a lesson also ships | yes |
| `lessons` | L'impératif's notes panel: its tabs and the rules its layout keeps, all read back from the lesson data; the lesson's block starting at card 1, and its progress in the top bar | yes |
| `motion` | the page holding still on every frame of the feedback panel's open and close, the panel fading rather than popping, and the tutor on the same clock as the page it moves | yes |
| `regressions` | bugs found by driving the app, each with the check that would have caught it | yes |
| `reflow` | what the reflow drags with it: the chrome above the card holding still, the card animating rather than popping, the feedback sheet staying inside the window, and panel/page agreeing across the reflow floor | yes |
| `answering` | an answer reaching FSRS off the happy path: accepted disputes, correcting a grade with Previous card, Escape and tapping with an answer typed, failed saves shown and retried, each answer saved to the way round it was shown and kept as a record, a correction and a failed save with a word in the block both ways, direction changes re-dealing the rest of the block, Reset all progress resetting both ways and clearing the streak (and saying so when the database won't), typing as the remembered default | yes |
| `cards` | gloss stripped from the French prompt, banner shows your answer, tapping the card continues, giving up still shows the answer | yes |
| `stats` | the Stats page, counted per way round: today's answers, seen / about understood and said / not yet seen for the deck and each area, cards due today counted apart from older ones still waiting, cards coming up, By type's right-last-time read from the FSRS rows, and no "mastered" — every expected figure counted from its own fixture | yes |
| `types` | the Grammar/Vocab/Phrases filter and the By type panel | yes |
| `session` | working a block to its checkpoint, Continue dealing the next block without repeating a card, what the keyboard is allowed to touch, and FSRS getting one answer per card per day | yes |
| `tutor` | the answer rendering as it streams, the deck context the endpoint is sent, editing a proposed card before it is written | yes |

**Markers:** `data-checkpoint` (the screen after a block), `data-stats-all` / `data-stats-areas` / `data-stats-coming-up` (Stats sections), `data-lesson-progress` (the lesson's figure in the top bar), `data-lesson-toggle` / `data-lesson-panel` (the notes button and the notes), `data-card-instruction` (the line above a grammar card's prompt saying what to type — `cardBox` in the harness reads the prompt, not this line), `data-tutor-panel` (the panel), `data-tutor-context` (the card chip in its header), `data-proposed-card` (a card the tutor offers), `data-feedback-sheet`, `data-attach-card`, `data-feedback-draft` (the dot on the trigger while a draft waits), `data-feedback-toast` (the outcome of a send; its value is `sent` or `failed`), `data-feedback-dock` (the sidebar slot the feedback panel renders into), `data-sidebar` / `data-sidebar-toggle` (the sidebar, `data-minimized` while it is a rail, and its minimize button), `data-feedback-toggle` (the feedback trigger), `data-report-card` (the flag on the card), `data-add-screenshot` (the paperclip), `data-feedback-field` (the message box, which holds an attached screenshot). Find things by these, never by their copy — `layoutProbe` once matched a line of the tutor's intro paragraph, and deleting that paragraph made every "is the tutor open" check answer no.

## Five rules, all learned from checks that lied

**Write the assertion from the requirement, not from the implementation.**
A check derived from the code you just wrote can only confirm that code. This
suite once contained `ck('sidebar stops above the panel', ...)` and it passed
for weeks — the sidebar shrinking *was* the bug. The requirement was "the page
makes room for the panel"; the sidebar was never what the panel covered.

**Never bake in a number that describes fixture data.** Read it back from the
fixture — `servedDeck()` exists for exactly this. A hard-coded deck size went
stale the moment the fixture grew and then reported a failure the app hadn't
caused.

**Don't assume a displayed value counts the way you'd count.** The `cards`
suite asserted that tapping a graded card moved the counter to `index + 1`.
The counter wasn't one running number: past the initial deck size it became
"Retry 1 of 1" and started again from one. So on the roughly one run in fifteen
where the shuffle left the suite on the last card, the app advanced correctly
and the arithmetic read `15 → 1` and failed. It now compares the counter's own
text across the tap, and reads it *after* grading — reading before would also
pick up the "· 1 retry to come" the grade itself adds, and pass no matter what
the tap did.

**Judge a jump against the move it belongs to, not against a fixed number.**
The `reflow` suite asks whether anything covered too much ground in one frame.
Neither a percentage nor a pixel count works alone. The card resizes 8px over a
reflow on a tall window, so one 5px frame of that is "63% in a single frame"
and is invisible; the same card genuinely resizes 92px on a short one, at about
16px per frame, so any pixel threshold loose enough to allow that also waves
through a 12px jump in a 19px move, which is a real pop. It took both: a
quarter of the move, with a pixel floor under it. The suite has since gone one
step further and measures the card against the page itself: each frame, how
far the card's edges moved for each pixel the page moved, which a smooth reflow
keeps steady.

**A max over noisy samples is not a measurement.** The `motion` suite asserted
that the panel and the page never drift apart by more than 24px, taking the
worst of ~45 sampled frames. Sample the instant after one element's style is
applied and before the other's and you read a frame of lag — about 16px — that
nobody could see; on the close animation that pushed the worst frame to 32px on
roughly half of runs. The typical frame was drifting 0–1px the whole time. It
was changed to judge the median, with a looser guard on the worst, so the bug
it existed for (the page starting two frames early, which separates the edges
on *every* frame) still failed it. The feedback panel has since moved into the
sidebar and moves nothing, so that check is gone: the suite now asks that the
page hold still on every frame of the panel's open and close.

## Adding a card to the fixture

`tests/mock-supabase.mjs` serves the deck. Suites derive their expectations
from it (`servedDeck()`, and `classifyCard` in the `types` suite), so adding a
card doesn't require touching assertions.

## Maintenance runners (`scripts/`)

Not tests. One-off jobs against a real deck, dry-run by default, `--apply` to
write. They read `.env.local` and need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`; the ones that ask Claude also need
`ANTHROPIC_API_KEY`. `reset-fsrs-seed` and `sort-grammar-cards` back up every
row they change to `backups/` before writing.

| Script | Does |
|---|---|
| `fix-multi-sense.mjs` | Scans the whole deck for cards teaching two headwords (`les frais` = costs AND fresh), asks Claude split-or-keep, rewrites the original as the first sense keeping its FSRS history and inserts the rest as new cards. Shares the prompt and schema with `api/split-senses.js` rather than forking them. |
| `resolve-disputes.mjs` | Works the unresolved backlog in `feedback_submissions`: adjudicates each, adds accepted answers to `card_alternates`, marks the row. Anything it calls "uncertain" is left alone. Detects whether the table marks completion with `reviewed`/`action` or `status`, because the app and `schema.sql` disagree. |
| `sort-grammar-cards.mjs` | Sorts every deck's grammar and pronunciation cards: conjugation drills stay, a rule card with real French under it becomes an ordinary card, the rest are archived. The owner's hand-made sort (`scripts/data/grammar-sort-decisions.json`) decides the cards it covers; Claude is asked only about the rest, and an answer that fails its checks is left undecided. A dry run writes a proposal file; `--apply <proposal>` writes exactly that file. Lesson and archived cards are skipped. Covered by the `grammar-sort` suite. |
| `reset-fsrs-seed.mjs` | Puts cards still due at the instant the FSRS switch stamped them (never answered since) back to not yet seen. |
| `resolve-feedback.mjs` | Lists open feedback, numbered as in the app, and resolves entries by id with a `--note`, taking them off the admin list. Deletes nothing. |
