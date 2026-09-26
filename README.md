# French Flashcards

A spaced-repetition flashcard app for learning French. Upload a class notebook
(or link the Google Doc it is kept in), Claude parses it into cards, and FSRS
decides what you see and when.

Live at [french-flashcards-nine.vercel.app](https://french-flashcards-nine.vercel.app).

## What's in it

- **Notebook parsing.** `api/parse-cahier.js` turns raw notebook text (pasted,
  a `.txt`, `.pdf` or `.docx`, or a Google Doc link) into cards: section
  slicing, homework stripping, slash-pair splitting, conjugation expansion,
  polysemy-aware dedupe.
- **The linked cahier.** Link the Google Doc the notebook is kept in and each
  new class becomes cards on its own (`api/cahier-sync.js`). The app checks
  when it opens, at most once an hour per browser, and a daily cron
  (`api/cahier-daily.js`) reads the linked docs whether or not anyone opens
  the app. Only classes it hasn't read are parsed. Editing an old class
  changes nothing, and a word taught again keeps its card and gains the date.
- **FSRS scheduling.** Per-card memory strength rather than a fixed ladder, so
  intervals keep growing and a miss shortens the gap instead of wiping it. A
  word can be asked either way round (FR→EN, EN→FR or Mixed), and each way has
  its own schedule. Each student's FSRS settings are fitted to their own
  answers once there are enough (`api/fsrs-fit.js`), and "How much to
  remember" in the profile menu sets their target.
- **Session building.** `src/lib/sessionQueue.js` deals blocks of 50: cards
  missed last time, then reviews due today (most overdue first), then new
  cards — but only once the due cards run out. Then it shuffles. Blocked practice feels easier during a
  session and tests worse afterwards.
- **Card quality.** Three mechanisms for three ways a card goes bad: an English
  gloss leaking onto the French side; one card teaching two unrelated words
  that happen to share a spelling; and a card with no single answer to type —
  a grammar rule or a pronunciation note — which the parser no longer makes
  (`keepAnswerable`). A bad card is worse than no card, because FSRS records a
  recall that never happened.
- **Marking.** A typed answer is forgiven small typos, but not a wrong gender
  on a French article. A grammar drill answered in French — "vivre → je",
  "relatif → adverbe" — is marked exactly (case, accents and punctuation
  aside), because the typo tolerance accepted the very mistakes being drilled.
  Grammar drills and the lessons' grammar cards carry a line above the prompt
  saying exactly what to type (`src/lib/cardInstruction.js`).
- **Lessons.** Fixed card sets, the same for everyone, synced into every deck
  on load and scheduled through FSRS like anything else. There are two:
  *L'impératif* and *Adjectif ou adverbe ?*, each with its own notes in tabs.
- **Tutor chat.** A side panel that proposes new cards; the client performs the
  insert under row-level security, so the model never writes to the database.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 18 — no router, no CSS framework |
| Scheduling | [`ts-fsrs`](https://www.npmjs.com/package/ts-fsrs) 5.4 |
| Auth + data | Supabase — Postgres, magic-link email, row-level security |
| AI | Anthropic SDK, called only from serverless functions and the maintenance scripts |
| Hosting | Vercel — `api/*.js` are serverless functions, plus one daily cron (`vercel.json`); auto-deploys on push to `main` |
| Tests | `playwright-core` driving headless Chromium against a mock Supabase |

## Layout

```
api/           13 serverless functions: notebook parsing and the linked
               cahier's sync, tutor chat, sense splitting, answer
               adjudication, fitting a student's FSRS settings, admin and
               upload plumbing. cahier-daily.js is the daily cron. api/_lib is import-only — the underscore
               hides it from Vercel's function discovery
src/           React app
src/lib/       scheduling, session building, card classification, text
               cleanup; cardInstruction.js writes the line above a grammar
               card saying what to type
src/data/      lessons/ (index.js is the catalogue, then one file per
               lesson: imperatif.js, adverbes.js) and cards.js, the demo
               deck behind the admin's "Seed demo deck" button
migrations/    run in order in the Supabase SQL editor, after schema.sql
supabase/      schema.sql for a fresh deploy
scripts/       maintenance runners against the live database: dry-run by
               default, --apply to write. sort-grammar-cards.mjs and
               reset-fsrs-seed.mjs back rows up to backups/ (kept out of
               git) before writing
scripts/data/  grammar-sort-decisions.json, the owner's card-by-card sort
               of the original deck's grammar cards, read by
               sort-grammar-cards.mjs
tests/         25 suites: 15 drive the real app in a browser, 10 need none
french flashcards context.md
               the project's working notes: how it is, why, and what's open
```

## Tests

```bash
npm test              every suite
npm test -- layout    only suites whose name contains "layout"
```

The nine suites that need no browser run first. For the browser suites,
`npm test` writes a throwaway `.env.local` pointing the app at a mock Supabase,
and it refuses to start while a real `.env.local` is there — move yours aside
first.

Suites assert on **measured** values — geometry, computed styles, request
payloads — rather than on intent. [`tests/README.md`](tests/README.md) lists what
each suite covers and the rules the suite exists to enforce.

## Deploy from scratch (~30 minutes the first time)

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up (GitHub login is fastest).
2. Click **New project**. Name it whatever, set a database password (save it
   somewhere — you won't need it often), pick the closest region.
3. Wait ~2 minutes for provisioning.

### 2. Set up the database

1. In your Supabase project dashboard, go to **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this repo and replace every
   `YOUR_EMAIL_HERE@example.com` with the email you will log in with. Copy the
   entire contents, paste into the editor, and click **Run**.
3. You should see "Success. No rows returned." This creates the tables — the
   deck, progress, feedback, accepted answers — with row-level security, so
   each user can only see their own data.
4. Then run each file in `migrations/` the same way, in number order.
   `migration_002` and `migration_009` have the same email placeholder to
   replace; `migration_003` has the original owner's address where the
   placeholder would be, so replace that with yours too.

### 3. Configure auth URLs

This is the step people forget and then spend an hour debugging. Magic-link
emails need to redirect to your app's URL, not Supabase's.

1. In Supabase, go to **Authentication** → **URL Configuration**.
2. Set **Site URL** to your production URL (you'll have this after step 6; for
   now use `http://localhost:5173` and come back to update it).
3. Under **Redirect URLs**, add both `http://localhost:5173` and your production
   URL. Click **Save**.

### 4. Get your API credentials

1. In Supabase, go to **Project Settings** → **API**.
2. Copy the **Project URL** (looks like `https://xxxxx.supabase.co`).
3. Copy the **anon public** key (a long JWT string). This is safe to expose in
   frontend code — row-level security protects the data.

### 5. Run it locally

```bash
# Install deps
npm install

# Copy the env template and fill it in
cp .env.example .env.local
# Then edit .env.local and paste the values from step 4

# Start the dev server
npm run dev
```

Open http://localhost:5173. You should see the login screen. Enter your email,
click the link in your inbox, and you should land on the flashcard app.

Vite serves the app but not the `api/` functions, so anything that calls one —
uploading a notebook, the tutor, disputing a mark — needs the deployed site.

### 6. Deploy to Vercel

The easiest path: push to GitHub and connect the repo.

```bash
git init
git add .
git commit -m "Initial commit"
# Create a new repo on github.com, then:
git remote add origin https://github.com/your-username/french-flashcards.git
git push -u origin main
```

Then:

1. Go to [vercel.com](https://vercel.com), sign in with GitHub.
2. Click **Add New Project** → **Import** your repo.
3. Vercel auto-detects Vite. Before deploying, expand **Environment Variables**
   and add the variables in `.env.example`, plus `CRON_SECRET`:
   - `VITE_SUPABASE_URL` → your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` → your anon key
   - `VITE_ADMIN_EMAIL` → your email. It only decides whether the admin menu
     items are drawn — anything `VITE_`-prefixed is compiled into the public
     bundle, so it is never a security boundary. `ADMIN_EMAIL` is.
   - `SUPABASE_URL` → same as `VITE_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` → Supabase → Project Settings → API →
     **service_role** → **Reveal**. ⚠️ This key bypasses row-level security
     entirely. Never commit it, never paste it into frontend code, never share
     it. The serverless functions use it to verify who is calling.
   - `ADMIN_EMAIL` → your email. **This is the real admin check.** It is read
     only on the server, and the token it is compared against is verified with
     Supabase rather than merely decoded.
   - `ANTHROPIC_API_KEY` → a key from
     [console.anthropic.com](https://console.anthropic.com). It pays for
     reading every student's linked cahier, and for your own requests (see
     *Who pays for Claude* below).
   - `CRON_SECRET` → any long random string. Vercel sends it with the daily
     cahier check; without it that route refuses to run.

   None but the three `VITE_` ones reach the browser.
4. Click **Deploy**. After ~1 minute you'll have a `your-app.vercel.app` URL.

### 7. Update Supabase with the production URL

Go back to Supabase → **Authentication** → **URL Configuration** and update:

- **Site URL**: your `your-app.vercel.app` URL
- **Redirect URLs**: add your Vercel URL

Without this step, magic-link emails will redirect to localhost and confuse
anyone who isn't you.

### 8. Share the URL

Send the Vercel URL to your teacher and test users. They enter their email,
click the link, and they're in. Each user's progress is isolated.

## How cards are scheduled (FSRS)

Scheduling is handled by [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)
via the [`ts-fsrs`](https://www.npmjs.com/package/ts-fsrs) package, replacing the
fixed Leitner box ladder that came before it.

The old ladder had three problems: intervals stopped growing at 21 days, so a
word known cold for a year still came back every three weeks; a correct answer
earned the same credit whether it was on time or a month late; and a single
miss reset a card to day one. FSRS tracks per-card memory strength instead, so
intervals keep growing (4d, 15d, 49d, 136d, ...), a late-but-correct answer
earns a longer gap than an on-time one, and a miss cuts the interval
proportionally rather than wiping it.

**Each way round has its own schedule.** A word or phrase can be asked either
way — "la pomme → ?" or "apple → ?" — and each direction has its own FSRS state
(`migrations/migration_010_two_directions.sql`), because recognising a word and
producing it are different skills. Grammar cards are asked one way only.

**FSRS gets one answer per card, per direction, per day: the first.** A retry
later in the block, or the same card in a second block that day, is not
counted again. Every answer is still kept, in `card_reviews`.

**A day runs from 4am to 4am, in the student's own time**
(`src/lib/studyDay.js`), as Anki's does: a session that runs past midnight is
one day's work. FSRS counts the days between answers the same way. ts-fsrs on
its own counts them by UTC date, which turns at 8pm in New York, so a word
answered at 9pm and again the next morning was "0 days apart" and the right
answer earned nothing; the app hands it times whose UTC date is the student's
day (`toFsrsTime` in `src/lib/spacedRepetition.js`).

**Right or wrong, and nothing else.** Answers are graded binary — you typed it
right or you didn't (or, flipping cards instead of typing, you pressed Got It
or Again) — and mapped onto FSRS's `Again` and `Good`. Nothing is guessed from
typing speed or typos. FSRS was built for four buttons, so two things are
adjusted for two:

- **The gap after either answer comes from the card's own estimate** — the
  day its chance of being remembered falls to the target. ts-fsrs keeps four
  buttons' gaps in order (Good at least a day past Hard, Hard past Again), so
  every right answer used to wait at least three days, however shaky.
- **The starting settings were measured on right/wrong answers**
  (`STARTING_WEIGHTS` in `src/lib/fsrsSettings.js`): per-user fits of the FSRS
  team's open review data with Hard and Easy counted as right. ts-fsrs's own
  defaults were measured on people pressing four buttons.

**Each student's own settings** (`migrations/migration_012_fsrs_settings.sql`,
`api/fsrs-fit.js`, `src/useFsrsSettings.js`). Once a day the app asks the
server whether there is anything to do:

- Once a student has given about 1,000 answers, their FSRS settings are fitted
  from them with the official optimizer (`@open-spaced-repetition/binding`),
  and again each month once there are 500 more. A fit is used only if it
  predicts the student's newest answers — which it wasn't fitted on — better
  than the settings in use. On the FSRS team's open data a personal fit beat
  the starting settings for 78% of users at 1,000 answers; at 250 it was a
  coin flip.
- Whenever the settings in use change, every card's memory estimate is worked
  out again from its own answers. Due dates don't move, nothing else is
  written, and a card answered meanwhile is left alone.

**The target** — how sure to be of remembering a card when it comes back — is
the student's choice, under **How much to remember** in the profile menu:
Automatic (the default: 90%, easing two points at a time towards 85% while
due cards are left undone on most of a week's study days, and back up once
they're keeping up), Lighter load (85%), Standard (90%) or Remember more
(95%). It trades daily review count against how much you remember.

There are no spot-checks. Two well-known cards used to ride along in every
block whatever their date; in a six-month simulation they were right 97% of
the time and cost about 3% of study time.

**Setup.** Run these two in the Supabase SQL Editor, in order:

1. `migrations/migration_006_fsrs.sql` — adds the FSRS columns.
2. `migrations/migration_007_fsrs_reseed.sql` — fills them in from your existing
   review history.

The split matters. Seeding lives entirely in 007 and is driven by the three
signals that actually record a review (`card_progress.seen`, the old Leitner
`box`, and `lapses`), so 007 is safe to re-run and re-running 006 can never
undo it. Cards you've never answered stay in the New state and come in through
the normal new-card order, once the due cards run out; cards with real history
carry that history over rather than restarting. The old `box` column is left
in place, so the change can be reversed.

> Note for anyone reading old commits: the `dates` column holds the **lesson
> dates a word appeared on in the cahier**, not review history. Every parsed
> card has them. Treating them as reviews is what an earlier version of this
> migration got wrong, and it's the same assumption that made the new-card cap
> silently never apply in the pre-FSRS scheduler.

Run `migrations/migration_012_fsrs_settings.sql` for students' own settings.
Without it the app uses the starting settings and a 90% target, and the menu
says so.

## Updating the cards

Each learner's deck is their own rows in the `user_cards` table; nothing about
it is compiled into the app. Cards arrive four ways:

- **Upload document** (profile menu): paste the notebook's text, or drop a
  `.txt`, `.pdf` or `.docx`. It is parsed once.
- **A linked Google Doc**, from the same dialog's Google Doc link tab. The doc
  must be shared as "Anyone with the link can view". From then on each new
  class becomes cards by itself (see *What's in it*).
- **The tutor**, whose proposed cards are added from the chat.
- **Lessons**, synced into every deck on load.

A card can be edited in the app. Its schedule lives on its own row, so a new
front keeps its history — but accepted answers (`card_alternates`) are keyed by
the lowercased front text and don't follow the edit.

To change a lesson, edit its file in `src/data/lessons/` and push; Vercel
auto-deploys on push to main. On the next load every deck gains the lesson's
new cards and loses the ones it dropped. To reword a card's front, keep the old
front as the entry's fifth element: that is the card's identity, so the rename
neither retires the row nor resets its schedule. A lesson card whose front a
deck already has as its own card is skipped for that deck.

`src/data/cards.js` is only the demo deck behind the admin's **Seed demo deck**
button.

## When the marking is wrong (LLM-reviewed)

When a user types an answer that the matcher rejects but they think should
have been accepted (e.g., they typed "salesperson" for "le vendeur"), they
click **My answer should be accepted** under the card. `/api/review-answer`
asks Claude whether the answer is equivalent — `accept`, `reject` or
`uncertain`, with a one-sentence reason — and the verdict appears on the card
straight away.

- **Accept**: the answer counts as right, and it is saved to `card_alternates`
  as an accepted answer for that user from then on. No approval step, no
  redeploy.
- **Reject or uncertain**: the reason is shown, with an **Accept anyway**
  button that saves the answer without asking Claude, so it costs nothing.

Accepted answers belong to the person who earned them
(`migrations/migration_008_card_alternates_per_user.sql`). The table used to be
shared, so one learner's loose synonym became accepted for everyone holding the
card.

Anything else — a bad card, a bug, a suggestion — goes through **Send
feedback** in the sidebar: a message, optionally with a screenshot and the card
on screen. It lands in `beta_feedback`, the admin reads it under **profile menu
→ View feedback**, and `scripts/resolve-feedback.mjs` marks entries resolved
once they are dealt with (`migration_009`).

### Security model

- Every function a user calls verifies their session with Supabase rather than
  decoding it. The admin-only ones also check `ADMIN_EMAIL`.
- An accepted answer is written for the verified caller only, under their own
  `user_id`. Each user can read and change only their own `card_alternates`
  rows (RLS).
- Feedback: anyone signed in can send it and read their own; only the admin
  email can read everyone's (RLS, in `schema.sql`).
- The daily cahier check runs only when the request carries `CRON_SECRET`.
- The server's `ANTHROPIC_API_KEY` never reaches the browser. A user's own key
  stays in their browser (see below).

## Who pays for Claude

**Your own requests use your own key.** The tutor (`api/chat.js`, Sonnet 5),
the answer reviewer (`api/review-answer.js`, Opus 5), the notebook upload
(`api/parse-cahier.js` and `api/cahier-parse.js`, Haiku 4.5) and the sense
auditor (`api/split-senses.js`, Opus 5) bill the caller's Anthropic account
per request.

Each user supplies their own key through **profile menu → Connect Claude
account**. It is kept in that browser's `localStorage` and sent as an
`x-anthropic-key` header on their own requests only. It is never written to
the database or to a log, so this app is not a custodian of anyone's
credentials.

Without a key the server answers `402` and the client offers the dialog. The
one exception is `ADMIN_EMAIL`, whose requests fall back to
`ANTHROPIC_API_KEY`.

**The linked cahier uses the deploy owner's key.** `api/cahier-sync.js` and the
daily `api/cahier-daily.js` read new classes with `ANTHROPIC_API_KEY` (Haiku
4.5) for every student: a class is a few hundred words, and the daily check
runs with no student there to pay. Without that key the sync says so plainly
and does nothing.

Bringing your own key closed a real hole: `/api/chat` and `/api/split-senses`
previously accepted any signed-in caller and `/api/review-answer` accepted
*anyone*, all of them spending the deploy owner's Anthropic credit.

## Not built yet

- **Stats for the teacher**: the admin's **View users** lists each user's deck
  size and last activity, but there is no page for the teacher herself.
- **Mobile app**: the current app works fine in mobile browsers; wrapping it in
  Capacitor or PWA-enabling it would make it installable.

## Audio: French text-to-speech

Speech is the browser's own `speechSynthesis`. No account, no key, no setup,
no cost — click 🔊 on a card and the platform's French voice reads it.

It needs a French voice installed. macOS, iOS and Windows all ship one;
some Linux browsers do not, and `audio.js` logs a warning and stays silent
rather than reading French with an English mouth.

**This used to be Azure.** `api/tts.js` and `api/pronounce.js` proxied Azure
Speech Services for higher-quality voices and pronunciation scoring. Both
endpoints took **no authentication at all**, so anyone who found the URLs
could bill the deploy owner's Azure subscription indefinitely. They have been
removed rather than patched.

To bring Azure back, restore those two files behind `requireUser` from
`api/_lib/auth.js` — and if the deploy owner should not be the one paying,
give it a per-user credential the way `api/_lib/anthropicKey.js` does for
Anthropic. `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are no longer read
by anything and can be deleted from the Vercel project.

The pronunciation-scoring UI is still in `FlashcardApp.jsx` behind
`PRONUNCIATION_ENABLED`, which is `false`.

## Cost

Supabase free tier: unlimited API requests, 500 MB database, 50k monthly
active users. You'll never come close.

Vercel free tier: 100 GB bandwidth, unlimited deploys. Fine for hundreds of
testers.

Claude is the only bill. Rough estimates:

- **The linked cahier** (the deploy owner's key): a cent or two per new class —
  one Haiku 4.5 call, a few thousand tokens in and out.
- **A disputed answer** (the user's own key): under 3¢ — one Opus 5 call with a
  short prompt and a reply capped at 1,000 tokens.

Hosting costs nothing.
