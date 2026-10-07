# Tests

```
npm test              every suite
npm test -- layout    only suites whose name contains "layout"
npm run simulate      simulated students, tidy and messy, through the status check (seconds)
npm run simulate:compare   the "How much to remember" choices compared (a minute)
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
(`chromium-1208` at present).

GitHub runs all of this on every push to `main` (`.github/workflows/tests.yml`:
the build, `npm run simulate`, then `npm test`, on Linux with Playwright's
Chromium). A failure marks the commit with a red cross and emails whoever
pushed. A browser suite that fails gets one second try, and the summary names
any suite that needed it, so one that fails now and then is still seen.

`reflow`'s timing checks used to fail on and off on unchanged code: just after
the page loads, the app can be busy for ~1.5s before the tutor's slide starts,
and the checks stopped watching at 0.7s. They now watch the first opening for
2s and wait for the page to stop moving after a resize (2026-10-06).

| Suite | Covers | Browser |
|---|---|---|
| `logic` | `classifyCard`, `looksMultiSense`, `cleanFrenchPrompt`, the tutor's deck-context picker, what `/api/chat` sends the model and which of its proposed cards it keeps, `reconcileLessons`, archiving, and the cahier parser's `keepAnswerable` / `expandConjugations`: no rule or sound-note card (grammar terms caught even where they start or end with an accented letter), a conjugation table becoming its drills and only its drills; "Replace my existing deck" by class, never deleting, bringing back only what a Replace took out; one card per thing to learn inside one reading, with Claude's "same" merging and "different" labelling, and no answer making the card wait | no |
| `apply-splits` | the write endpoint: ownership, malformed splits, which row keeps its scheduling history; and the corrections log (`api/parse-corrections.js`) saving a correction as the signed-in admin | no |
| `auth` | the guard on every endpoint that spends money: no verified session, no Anthropic request | no |
| `dates` | which day a review counts towards — the student's day runs 4am to 4am, the night the clocks go back included — whether a card has already had today's review, and FSRS counting the days between answers the same way (a 9pm answer and the next morning's are a day apart), run under a pinned timezone so the bug isn't invisible from the one it was written in | no |
| `adaptive` | a student's own FSRS settings: the automatic target's rules (two points down after a week mostly behind, never below 85%, back up when keeping up), when a fit is tried, the answer histories the fitting reads (only FSRS's counted answers, starting again after Reset all progress), a card's estimate replayed from its answers matching what the app scheduled, and `api/fsrs-fit.js` against a stand-in database with the real optimizer on a simulated student: waiting under 1,000 answers, a fit used only when it predicts the latest answers better, estimates worked out again with no due date moved and a card answered meanwhile left alone | no |
| `serving` | which cards make a block of 50 — a word asked each way round on its own schedule, the direction setting (grammar in every setting), no way waiting for the other, a word's two first meetings kept apart, and an answer written only to the way it was shown: due today first, new cards only once those run out, the order new cards arrive in — lessons by teaching order, notes by recent classes then most-repeated words — where a missed card's retry goes, always inside the block, and a miss changed to right taking its retry back out with the pushed-out card returned, kept through a reload; no card that isn't due, however well known; and the gap after an answer taken from the card's own estimate — a shaky card answered right can come back within two days | no |
| `cahier-sync` | the linked cahier as it works before `migration_016` (classes known by date): only classes the deck hasn't got are parsed, a class is parsed once and never again, every run records when it looked, an edited old class changes nothing, a word taught again keeps its card and gains the date, a look-alike the deck has adds no card while one that differs (planter (fam), la poste, fin (adj)) is put to Claude and kept, a card out of study is still the card and gains the date, a class's grammar rules and sound notes never reach the deck, a backlog is worked through newest first, an unreadable doc says why, a second check moments later is skipped, and the daily check refuses any caller but Vercel's cron. Its stand-in database refuses an upsert missing a NOT NULL column, as Postgres does — it once waved through a partial upsert that broke every sync after linking | no |
| `repeats` | no card made twice from the same notes (2026-10-06), against `tests/fake-supabase.mjs` (migration_016's two functions written out, and Postgres's refusals) and a stand-in Claude that reads "French = English" lines, respells a line read twice, and answers the same-or-different question from a hand-written list. The plan's headline test: a used deck (answers, a French and an English edited, a card removed, a repeat put away, a lesson and a tutor card) gets the notebook back with a line added, a typo fixed, a date retyped and two new classes writing old words every way seen to slip through, by upload, Replace, the sync, upload then link, unlink and relink, a copy of the doc, an upload with a sync in the middle, two syncs at once, a turn that runs out, an upload whose turn the daily check took and gave back meanwhile (it saves nothing), a save that fails, a reply lost after the save, a refused card (left out inside the one save step) and a question Claude can't answer. Every time: exactly the 5 new cards, no unchanged class read, no two cards in study one card by the rule or by the hand list, every old card's id, text, category, schedule, answers and place in or out of study kept with its new dates, the removed and put-away cards still out, and the same notes again asking Claude nothing. Also: the rule on every verified spelling and the "!" exception, the keep-apart pairs, Replace by class, a removed card kept, the lesson sync (a card written another way, a removed card, a card a lesson dropped), View feedback's Remove card saying why, the question in calls of 50 side by side with a failed call's cards waiting and a time limit, the first run after the fix, and all of it before `migration_016` | no |
| `progress` | seen, about N remembered and not yet seen, the one calculation every screen reads (`src/lib/progress.js`): a card's chance of recall now and how it falls with time, within the first day too; a card whose last answer was wrong counting for nothing until it is answered right; a word counting as the chance of both ways round, and nothing while it has been met one way only; a grammar card counting its one way; which area a card counts towards (its lesson, the last two weeks of classes, or older classes); and what a set changed | no |
| `instructions` | the line above a grammar card saying what to type: a drill's tense and person by name, either pronoun accepted on il/elle, a subjunctive with or without its que; every lesson grammar card has a line and no other card does; reworded impératif cards keep their place in the order; only conjugation drills left under grammar in the demo deck; and a lesson card whose front the student already has is not written over but reported as taken | no |
| `grammar-sort` | `scripts/sort-grammar-cards.mjs` against a stand-in database and a stand-in Claude, with nothing leaving the machine: the owner's 117 hand-sorted cards get exactly the owner's sort without asking Claude, conjugation drills stay, lesson and archived cards are left alone, Claude's answers are checked rather than trusted, a dry run writes nothing, `--apply` backs up first, skips a card changed since the proposal and never adds a front the deck already has in any spelling, and a second `--apply` writes nothing | no |
| `status` | the status check (`src/lib/statusChecks.js`) on a simulated student's record (`tests/simulate/student.mjs`, the app's own rules dealing and scheduling): every check passes, and each fault it exists for, put in by hand, fails its check — an answer off FSRS, a second answer counted in a day, a schedule that isn't its last answer's, a card asked before it was due, the stale set of 2026-09-23, a full set skipping a missed card, new cards out of order, both first meetings of a word at once, a card asked twice running or never dealt, predictions far from results; Reset all progress and a fit's recalculated estimates are not failures; before `migration_013` the set checks wait. A messy student (an old copy dealing on opening, class notes arriving mid-set, reloads, detours into a lesson) passes every check too, but for the one known repeat after a detour (`detourRepeats`). And the records the app writes: an answer's settings, and each set dealt | no |
| `status-daily` | the status check on every student (`api/_lib/statusDaily.js`) against a stand-in Supabase with three accounts: each judged on their own record, a planted fault reported against the right student only, an account with no answers left out, the reports kept one row a student and the latest read back, nothing but the reports written, and before `migration_015` the reports still returned but not kept | no |
| `answer-checks` | Claude's marking of disputed answers (`api/_lib/answerChecks.js`, `evalRuns.js`, `evalStatus.js`) with a stand-in for Anthropic: every verdict saved with both sides of the card, what was typed and Claude's reason; what Claude should have said taken from what the owner already did, for every combination, and another student's only from a mark; only the admin may list or mark; no test to start by hand; the test the server runs, asking only about answers with a call, three times each, with the app's own question and model; a refused key skipping the run; when a test is due; the red dot only for a case that passed last time and fails now, named; before `migration_015`, waiting rather than failing | no |
| `notes-checks` | Claude reading class notes, tested against the owner's corrections (`api/_lib/notesChecks.js`), with a stand-in store, notebook and reading: what each correction is a case of (an edit that changed nothing isn't one), finding its class (the card's own dates, else the class before the correction whose text holds it), judging a reading (the same stray letter or gloss again, a note back on the back, a deleted card or rule made again in other wording), only the admin seeing the list, no test to start by hand, and the test the server runs: each class read three times once for all its cases, counted and kept, and nothing read past the time limit | no |
| `status-script` | `scripts/status-check.mjs` against a stand-in Supabase holding a simulated student's record: it finds the admin's account without being named, reads every page of answers, runs all nine checks and exits 1 only when one fails, names another account with `--email`, says plainly when `migration_013` hasn't been run, lists every detail with `--all`, and sends nothing but GETs | no |
| `feedback-review` | Claude's review of feedback and what the owner does with it (`api/_lib/feedbackReview.js`), against an in-memory store and a stand-in for Anthropic that counts calls: a student's newest feedback reviewed in one call, with their own card and any screenshot, the reply in a fixed shape, and nothing reviewed twice; only the owner may apply, revert or remove, and a refused request spends nothing; Apply rewriting the card in place with its schedule untouched, never the owner's card with the same front, and refusing a card edited since the review or a fix that would duplicate another card; Remove card archiving the card with its answers and schedule; Revert putting the card back and reopening the entry, but never undoing a later edit; an app problem keeping its brief and suggesting no card | no |
| `layout` | card fits the window at 7 heights; the tutor moves the content column and **not** the sidebar; the feedback panel moves nothing, on Cards and on Stats | yes |
| `panels` | tutor/feedback mutual exclusion, outside-click dismissal, the tutor's reflow axis; the feedback panel sitting in the sidebar and never over the card, its draft surviving every close, sending clearing it with a toast, and the flag on the card opening it about that card | yes |
| `sidebar` | the sidebar minimizes to a 64px rail: icons with titles, one marker, the feedback icon under the avatar, the account menu not clipped, the choice surviving a reload, feedback widening it and closing putting it back | yes |
| `lesson-sync` | a new account ends up with every lesson in its deck and nothing else, L'impératif checked card by card: correctly keyed, studiable, notes readable — a second visit writes nothing, and an existing deck gains L'impératif with the student's own cards and their scheduling untouched, including a card whose front a lesson also ships; a lesson card the student removed stays out of study while one a lesson dropped and has again comes back (2026-10-06), and before `migration_016`, whose `archived_reason` the deck load asks for, the refused request is made again without it and the deck loads | yes |
| `lessons` | L'impératif's notes panel: its tabs and the rules its layout keeps, all read back from the lesson data; the lesson's block starting at card 1, and its progress in the top bar | yes |
| `motion` | the page holding still on every frame of the feedback panel's open and close, the panel fading rather than popping, and the tutor on the same clock as the page it moves | yes |
| `regressions` | bugs found by driving the app, each with the check that would have caught it | yes |
| `reflow` | what the reflow drags with it: the chrome above the card holding still, the card animating rather than popping, the feedback sheet staying inside the window, and panel/page agreeing across the reflow floor | yes |
| `answering` | an answer reaching FSRS off the happy path: accepted disputes (shown green, kept through a reload; moving on while the check runs keeps the first mark and leaves every other card alone), correcting a grade with Previous card, Escape and tapping with an answer typed, failed saves shown and retried, each answer saved to the way round it was shown and kept as a record, a correction and a failed save with a word in the block both ways, direction changes re-dealing the rest of the block, Reset all progress resetting both ways and clearing the streak (and saying so when the database won't), typing as the remembered default | yes |
| `cards` | gloss stripped from the French prompt, banner shows your answer, tapping the card continues, giving up still shows the answer | yes |
| `stats` | the Stats page, counted from its own fixture of cards and answer records: today's cards in three (new, reviews, retries) adding up, right first time out of the new cards and reviews, the chart's last 7 days and new cards met, the days studied and the calendar's legend, seen / ~N remembered / not yet seen for the deck and each area with its 7-day change, no By type, Hardest cards, "Coming up" or "mastered" | yes |
| `types` | the Grammar/Vocab/Phrases filter, and no By type panel on Stats | yes |
| `session` | working a block to its checkpoint, Continue dealing the next block without repeating a card, what the keyboard is allowed to touch, and FSRS getting one answer per card per day | yes |
| `set-size` | "Cards in a set" (20, 30, 50, 100) changing the set on screen, not only the next one: the counter at once; the card on screen, every answer and the retries lined up kept; only the cards not yet reached added or taken away, and the added ones recorded for the status check; a size below the card on screen ending the set on it; at the end of a set the new size waiting for the next; the size kept through a reload. It routes in a deck of its own (30 due cards and 130 new), since the stand-in deck is too small for a set of 30 | yes |
| `statusline` | the records the status check reads, as the app writes them: before `migration_013` an answer refused for its settings is saved without them and the set record tried once; after it, every counted answer carries its settings and every set is recorded, one entry per card. And no Status line in the profile menu or alert on the avatar, for the admin or a student, even on a record a check would fail (the checks run each morning outside the app) — started on its own dev server with the test account as admin | yes |
| `settings` | "How much to remember": the study day recorded once a day and the server asked once, with the student's time zone; four choices with Automatic for a new student; each choice saving what it says; and before migration_012, nothing written and the dialog saying the standard settings are in use | yes |
| `tutor` | the answer rendering as it streams, the deck context the endpoint is sent, editing a proposed card before it is written | yes |
| `tour` | the first-visit tour, as a brand-new student whose empty deck the lesson sync fills: it comes up by itself and is saved to the account; each step lights and outlines the right part; the steps the student does move on once done; highlights appear in place, sampled every frame; a click on the dimmed part does nothing, and Enter on a step that explains leaves the card alone; never again after a reload, on another computer, or for a student with answers; "Take the tour again" | yes |

**Markers:** `data-checkpoint` (the screen after a block), `data-stats-today` / `data-stats-first-time` / `data-stats-trend` / `data-stats-chart` / `data-stats-all` / `data-stats-finish` / `data-stats-days` / `data-stats-areas` (Stats sections; each row in Progress by Lesson is a `data-stats-area`), `data-lesson-progress` (the lesson's figure in the top bar), `data-lesson-toggle` / `data-lesson-panel` (the notes button and the notes), `data-card-instruction` (the line above a grammar card's prompt saying what to type — `cardBox` in the harness reads the prompt, not this line), `data-tutor-panel` (the panel), `data-tutor-context` (the card chip in its header), `data-proposed-card` (a card the tutor offers), `data-feedback-sheet`, `data-attach-card`, `data-feedback-draft` (the dot on the trigger while a draft waits), `data-feedback-toast` (the outcome of a send; its value is `sent` or `failed`), `data-feedback-dock` (the sidebar slot the feedback panel renders into), `data-sidebar` / `data-sidebar-toggle` (the sidebar, `data-minimized` while it is a rail, and its minimize button), `data-feedback-toggle` (the feedback trigger), `data-report-card` (the flag on the card), `data-add-screenshot` (the paperclip), `data-feedback-field` (the message box, which holds an attached screenshot), `data-fsrs-settings-toggle` / `data-fsrs-settings` (the profile menu's "How much to remember" and its dialog, whose choices carry `data-choice`), `data-status-toggle` / `data-status` (the admin's Status line and its dialog; each check is a `data-status-check` with `data-status-result` pass, fail or wait; `data-status-copy` the copy button), `data-status-alert` (`avatar` or `menu`, present only while something needs checking), `data-tour-root` / `data-tour-box` / `data-tour-hole` / `data-tour-pulse` (the tour, its caption, the lit part and the outline on what to press; the caption's buttons are `data-tour-next`, `data-tour-back`, `data-tour-skip`), `data-tour-again` (the profile menu's "Take the tour again"), and the `data-tour="…"` markers the tour points at (`nav-cards`, `card`, `well`, `answer-row`, `continue`, `notes`, `avatar`, `profile-menu`, `upload`…, with `data-tour-lesson` / `data-tour-study` / `data-tour-include` on the Lessons page). `openApp` opens as a student who has seen the tour unless given `tour: true`. Find things by these, never by their copy — `layoutProbe` once matched a line of the tutor's intro paragraph, and deleting that paragraph made every "is the tutor open" check answer no.

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

Not tests. Jobs run by hand, all but `release-lesson-cards` against the live
database: dry-run by default, `--apply` to write. They read `.env.local` and
need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; the ones that ask Claude
also need `ANTHROPIC_API_KEY`. The scripts that rewrite cards back up every row
they change to `backups/` before writing.

| Script | Does |
|---|---|
| `fix-multi-sense.mjs` | Scans the whole deck for cards teaching two headwords (`les frais` = costs AND fresh), asks Claude split-or-keep, rewrites the original as the first sense keeping its FSRS history and inserts the rest as new cards. Shares the prompt and schema with `api/split-senses.js` rather than forking them. |
| `resolve-disputes.mjs` | Works the unresolved backlog in `feedback_submissions`: adjudicates each, adds accepted answers to `card_alternates`, marks the row. Anything it calls "uncertain" is left alone. Detects whether the table marks completion with `reviewed`/`action` or `status`, because the app and `schema.sql` disagree. |
| `sort-grammar-cards.mjs` | Sorts every deck's grammar and pronunciation cards: conjugation drills stay, a rule card with real French under it becomes an ordinary card, the rest are archived. The owner's hand-made sort (`scripts/data/grammar-sort-decisions.json`) decides the cards it covers; Claude is asked only about the rest, and an answer that fails its checks is left undecided. A dry run writes a proposal file; `--apply <proposal>` writes exactly that file. Lesson and archived cards are skipped. Covered by the `grammar-sort` suite. |
| `reset-fsrs-seed.mjs` | Puts cards still due at the instant the FSRS switch stamped them (never answered since) back to not yet seen. |
| `resolve-feedback.mjs` | Lists open feedback, numbered as in the app, and resolves entries by id with a `--note`, taking them off the admin list. Deletes nothing. |
| `status-check.mjs` | Runs the nine status checks on a student's live record and only reads. `--email` names the student, `--all` lists every detail. Covered by the `status-script` suite. |
| `merge-duplicates.mjs` | Merges cards already judged, one by one, to be the same card (`<verdicts.json> <email> [--apply]`): keeps the answered one and archives the rest. |
| `release-lesson-cards.mjs` | Records new lesson cards in `tests/released-lesson-cards.json`; run it after adding lesson cards, or the `logic` suite fails. Touches no database. |
