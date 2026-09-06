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
| `logic` | `classifyCard`, `looksMultiSense`, `cleanFrenchPrompt` | no |
| `apply-splits` | the write endpoint: ownership, malformed splits, which row keeps its scheduling history | no |
| `layout` | card fits the window at 7 heights; a panel moves the content column and **not** the sidebar, on Cards and on Stats | yes |
| `panels` | tutor/feedback mutual exclusion, outside-click dismissal, reflow axis | yes |
| `cards` | gloss stripped from the French prompt, banner shows your answer, tapping the card continues | yes |
| `types` | the Grammar/Vocab/Phrases filter and the By type panel | yes |
| `split-senses` | the cleanup tool's client flow, with the audit and write endpoints stubbed | yes |

## Two rules, both learned from checks that lied

**Write the assertion from the requirement, not from the implementation.**
A check derived from the code you just wrote can only confirm that code. This
suite once contained `ck('sidebar stops above the panel', ...)` and it passed
for weeks — the sidebar shrinking *was* the bug. The requirement was "the page
makes room for the panel"; the sidebar was never what the panel covered.

**Never bake in a number that describes fixture data.** Read it back from the
fixture — `servedDeck()` exists for exactly this. A hard-coded deck size went
stale the moment the fixture grew and then reported a failure the app hadn't
caused.

## Adding a card to the fixture

`tests/mock-supabase.mjs` serves the deck. Suites derive their expectations
from it (`servedDeck()`, and `classifyCard` in the `types` suite), so adding a
card doesn't require touching assertions.
