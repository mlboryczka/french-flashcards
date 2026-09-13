# Tests

```
npm test              every suite
npm test -- layout    only suites whose name contains "layout"
```

`tests/run.mjs` writes a throwaway `.env.local` pointing the app at the mock
Supabase, starts that mock and the Vite dev server, runs each suite, and cleans
up. It refuses to run if a real `.env.local` is present rather than clobber it.

Browser suites drive the actual app in headless Chromium via `playwright-core`.
Set `CHROME_PATH` if your Chromium isn't at the default
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

| Suite | Covers | Browser |
|---|---|---|
| `logic` | `classifyCard`, `looksMultiSense`, `cleanFrenchPrompt`, the tutor's deck-context picker | no |
| `apply-splits` | the write endpoint: ownership, malformed splits, which row keeps its scheduling history | no |
| `auth` | the guard on every endpoint that spends money: no verified session, no Anthropic request | no |
| `dates` | which day a review counts towards, and whether a card has already had today's review, run under a pinned timezone so the bug isn't invisible from the one it was written in | no |
| `serving` | which cards make a block of 50: due today first, new cards only once those run out, and the order new cards arrive in — lessons by teaching order, notes by recent classes then most-repeated words | no |
| `progress` | seen, about N remembered and not yet seen: FSRS's recall estimate, which area a card counts towards, and what a block changed | no |
| `layout` | card fits the window at 7 heights; the tutor moves the content column and **not** the sidebar; the feedback panel moves nothing, on Cards and on Stats | yes |
| `panels` | tutor/feedback mutual exclusion, outside-click dismissal, the tutor's reflow axis; the feedback panel sitting in the sidebar and never over the card, its draft surviving every close, sending clearing it with a toast, and the flag on the card opening it about that card | yes |
| `lesson-sync` | a new account ends up with L'impératif in its deck: every card, correctly keyed, studiable, notes readable — and a second visit writes nothing | yes |
| `lessons` | the lesson notes panel: its tabs and the rules its layout keeps, all read back from the lesson data; the lesson's block starting at card 1, and its progress in the top bar | yes |
| `motion` | the page holding still on every frame of the feedback panel's open and close, the panel fading rather than popping, and the tutor on the same clock as the page it moves | yes |
| `regressions` | bugs found by driving the app, each with the check that would have caught it | yes |
| `reflow` | what the reflow drags with it: the chrome above the card holding still, the card animating rather than popping, the feedback sheet staying inside the window, and panel/page agreeing across the reflow floor | yes |
| `cards` | gloss stripped from the French prompt, banner shows your answer, tapping the card continues | yes |
| `stats` | the Stats page: today's answers, seen / about remembered / not yet seen for the deck and each area, cards coming up, and no "mastered" — every expected figure counted from its own fixture | yes |
| `types` | the Grammar/Vocab/Phrases filter and the By type panel | yes |
| `session` | working a block to its checkpoint, Continue dealing the next block without repeating a card, what the keyboard is allowed to touch, and FSRS getting one answer per card per day | yes |
| `tutor` | the answer rendering as it streams, the deck context the endpoint is sent, editing a proposed card before it is written | yes |

**Markers:** `data-checkpoint` (the screen after a block), `data-stats-all` / `data-stats-areas` / `data-stats-coming-up` (Stats sections), `data-lesson-progress` (the lesson's figure in the top bar), `data-tutor-panel` (the panel), `data-tutor-context` (the card chip in its header), `data-proposed-card` (a card the tutor offers), `data-feedback-sheet`, `data-attach-card`, `data-feedback-draft` (the dot on the trigger while a draft waits), `data-feedback-toast` (the outcome of a send; its value is `sent` or `failed`), `data-feedback-dock` (the sidebar slot the feedback panel renders into), `data-report-card` (the flag on the card), `data-add-screenshot` (the paperclip), `data-feedback-field` (the message box, which holds an attached screenshot). Find things by these, never by their copy — `layoutProbe` once matched a line of the tutor's intro paragraph, and deleting that paragraph made every "is the tutor open" check answer no.

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
The counter isn't one running number: past the initial deck size it becomes
"Retry 1 of 1" and starts again from one. So on the roughly one run in fifteen
where the shuffle left the suite on the last card, the app advanced correctly
and the arithmetic read `15 → 1` and failed. It now compares the counter's own
text across the tap, and reads it *after* grading — reading before would also
pick up the "· 1 retry pending" the grade itself adds, and pass no matter what
the tap did.

**Judge a jump against the move it belongs to, not against a fixed number.**
The `reflow` suite asks whether anything covered too much ground in one frame.
Neither a percentage nor a pixel count works alone. The card resizes 8px over a
reflow on a tall window, so one 5px frame of that is "63% in a single frame"
and is invisible; the same card genuinely resizes 92px on a short one, at about
16px per frame, so any pixel threshold loose enough to allow that also waves
through a 12px jump in a 19px move, which is a real pop. It takes both: a
quarter of the move, with a pixel floor under it.

**A max over noisy samples is not a measurement.** The `motion` suite asserted
that the panel and the page never drift apart by more than 24px, taking the
worst of ~45 sampled frames. Sample the instant after one element's style is
applied and before the other's and you read a frame of lag — about 16px — that
nobody could see; on the close animation that pushed the worst frame to 32px on
roughly half of runs. The typical frame was drifting 0–1px the whole time. It
now judges the median and keeps a looser guard on the worst, so the bug it
exists for (the page starting two frames early, which separates the edges on
*every* frame) still fails it.

## Adding a card to the fixture

`tests/mock-supabase.mjs` serves the deck. Suites derive their expectations
from it (`servedDeck()`, and `classifyCard` in the `types` suite), so adding a
card doesn't require touching assertions.

## Maintenance runners (`scripts/`)

Not tests. One-off jobs against a real deck, dry-run by default, `--apply` to
write. They read `.env.local` and need `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY`.

| Script | Does |
|---|---|
| `fix-multi-sense.mjs` | Scans the whole deck for cards teaching two headwords (`les frais` = costs AND fresh), asks Claude split-or-keep, rewrites the original as the first sense keeping its FSRS history and inserts the rest as new cards. Shares the prompt and schema with `api/split-senses.js` rather than forking them. |
| `resolve-disputes.mjs` | Works the unresolved backlog in `feedback_submissions`: adjudicates each, adds accepted answers to `card_alternates`, marks the row. Anything it calls "uncertain" is left alone. Detects whether the table marks completion with `reviewed`/`action` or `status`, because the app and `schema.sql` disagree. |
