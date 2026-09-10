# French Flashcards

A spaced-repetition flashcard app for learning French. Upload a class notebook,
Claude parses it into cards, and FSRS decides what you see and when.

Live at [french-flashcards-nine.vercel.app](https://french-flashcards-nine.vercel.app).

## What's in it

- **Notebook parsing.** `api/parse-cahier.js` turns raw notebook text (PDF or
  Word) into cards: section slicing, homework stripping, slash-pair splitting,
  conjugation expansion, polysemy-aware dedupe.
- **FSRS scheduling.** Per-card memory strength rather than a fixed ladder, so
  intervals keep growing and a miss shortens the gap instead of wiping it.
- **Session building.** `src/lib/sessionQueue.js` selects by priority — lapses,
  due reviews, new cards, and a spot-check sample of mastered ones — reserving
  the new and spot-check slots *before* the target is spent on due work, then
  shuffles. Blocked practice feels easier during a session and tests worse
  afterwards.
- **Card quality.** Two mechanisms for the two ways a card goes bad: an English
  gloss leaking onto the French side, and one card teaching two unrelated words
  that happen to share a spelling. A bad card is worse than no card, because
  FSRS records a recall that never happened.
- **Lessons.** Fixed card sets built from a teacher's materials, synced into a
  learner's deck on load and scheduled through FSRS like anything else.
- **Tutor chat.** A side panel that proposes new cards; the client performs the
  insert under row-level security, so the model never writes to the database.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 18 — no router, no CSS framework |
| Scheduling | [`ts-fsrs`](https://www.npmjs.com/package/ts-fsrs) 5.4 |
| Auth + data | Supabase — Postgres, magic-link email, row-level security |
| AI | Anthropic SDK, called only from serverless functions |
| Hosting | Vercel — `api/*.js` are serverless functions, auto-deploys on push to `main` |
| Tests | `playwright-core` driving headless Chromium against a mock Supabase |

## Layout

```
api/           10 serverless functions: notebook parsing, tutor chat, sense
               splitting, answer adjudication, admin and upload plumbing.
               api/_lib is import-only — the underscore hides it from Vercel's
               function discovery
src/           React app
src/lib/       scheduling, session building, card classification, text cleanup
src/data/      the deck, and static lessons
migrations/    run in order in the Supabase SQL editor
supabase/      schema.sql for a fresh deploy
tests/         15 suites, most driving the real app in a browser
```

## Tests

```bash
npm test              every suite
npm test -- layout    only suites whose name contains "layout"
```

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
2. Open `supabase/schema.sql` from this repo, copy the entire contents, paste
   into the editor, and click **Run**.
3. You should see "Success. No rows returned." This creates the `card_progress`
   table and sets up row-level security so each user can only see their own data.

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
   and add:
   - `VITE_SUPABASE_URL` → your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` → your anon key
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
intervals keep growing (3d, 14d, 57d, 196d, ...), a late-but-correct answer
earns a longer gap than an on-time one, and a miss cuts the interval
proportionally rather than wiping it.

**Setup.** Run these two in the Supabase SQL Editor, in order:

1. `migrations/migration_006_fsrs.sql` — adds the FSRS columns.
2. `migrations/migration_007_fsrs_reseed.sql` — fills them in from your existing
   review history.

The split matters. Seeding lives entirely in 007 and is driven by the three
signals that actually record a review (`card_progress.seen`, the old Leitner
`box`, and `lapses`), so 007 is safe to re-run and re-running 006 can never
undo it. Cards you've never answered stay in the New state and get paced in at
the normal 20-per-session rate; cards with real history carry that history over
rather than restarting. The old `box` column is left in place, so the change
can be reversed.

> Note for anyone reading old commits: the `dates` column holds the **lesson
> dates a word appeared on in the cahier**, not review history. Every parsed
> card has them. Treating them as reviews is what an earlier version of this
> migration got wrong, and it's the same assumption that made the new-card cap
> silently never apply in the pre-FSRS scheduler.

**The one dial worth touching** is `requestRetention` in
`src/lib/spacedRepetition.js` — the probability you want of recalling a card at
the moment it comes up. It trades daily review count against how much you
remember:

| Setting | Effect |
| --- | --- |
| `0.95` | Remember more, noticeably more reviews per day |
| `0.90` | Default. The usual recommendation |
| `0.85` | Meaningfully fewer reviews, slightly more forgetting |
| `0.80` | Use if the daily load has become unsustainable |

Answers are graded binary — you typed it right or you didn't — and mapped onto
FSRS's `Again` and `Good` ratings. The `Hard` and `Easy` ratings are for apps
where you rate your own recall; here the typing check is the grade.

## Updating the cards

Your teacher is still adding to the lesson log. To update the deck:

1. Edit `src/data/cards.js` — the format is
   `[frontText, backText, category, [dateArray]]` for `RAW` and
   `[sentenceWithBlank, answer, hint, category, englishTranslation]` for `BLANKS`.
2. Use constants `V`, `E`, `G`, `P` for the categories
   (Vocab / Expression / Grammar / Pronunciation).
3. Commit and push — Vercel auto-deploys on push to main.

Progress is keyed by the lowercased front text. So if you edit a card's front
text, users will lose progress on that specific card (the new text is a new
card from the app's perspective). Adding new cards or editing back text is
safe.

## The user feedback loop (LLM-reviewed)

When a user types an answer that the matcher rejects but the user thinks should
have been accepted (e.g., they typed "salesperson" for "le vendeur"), they can
hit a button to flag it. The submission goes to Supabase, then a serverless
function asks Claude whether the answer is equivalent. You see the verdict in
an admin tab, approve or reject, and approved answers become live alternates
without redeploying.

### Setup (one-time, ~15 min)

The first deploy steps above must be done first. Then:

**1. Run the migration**

In Supabase SQL Editor, open `supabase/migration_001_feedback.sql` from this
repo. Before running, search-and-replace `YOUR_EMAIL_HERE@example.com` with the
email you log in with. Click Run.

This adds two tables (`feedback_submissions`, `card_alternates`) and the
row-level security policies that give you admin access to both.

**2. Set the admin email in your local env**

Add this line to `.env.local`:

```
VITE_ADMIN_EMAIL=your@email.com
```

Same email as in the SQL. This is what tells the React app to show the
"Feedback" tab when you log in.

**3. Get an Anthropic API key**

Go to [console.anthropic.com](https://console.anthropic.com), create a
workspace, generate an API key. You'll get billed per request — for this use
case it'll be cents per month even with heavy use, since each review is one
small Claude call.

**4. Get your Supabase service role key**

Supabase dashboard → Project Settings → API → scroll to **service_role** →
**Reveal** → copy. ⚠️ This key bypasses row-level security entirely. Never
commit it, never paste it into frontend code, never share it. The serverless
function uses it to update feedback rows after the LLM verdict comes back.

**5. Add server-side env vars to Vercel**

Vercel dashboard → your project → Settings → Environment Variables. Add these
(all without the `VITE_` prefix, so they stay server-side only):

- `SUPABASE_URL` → same as `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` → service role key from step 4
- `ADMIN_EMAIL` → your email. **This is the real admin check.** It is read
  only on the server, and the token it is compared against is verified with
  Supabase rather than merely decoded.
- `ANTHROPIC_API_KEY` → optional, your key from step 3. Used **only** for
  requests from `ADMIN_EMAIL`. Every other user brings their own key (see
  *Who pays for Claude* below), so leaving this unset simply means you bring
  yours too.

Also add `VITE_ADMIN_EMAIL` to Vercel (this one DOES use the VITE_ prefix
because it's read in the browser). It only decides whether the admin menu
items are drawn — anything `VITE_`-prefixed is compiled into the public
bundle, so it is never a security boundary. `ADMIN_EMAIL` is.

### Who pays for Claude

Every endpoint that calls Claude — the tutor (`api/chat.js`), the answer
reviewer (`api/review-answer.js`), the cahier parser (`api/parse-cahier.js`,
`api/cahier-parse.js`) and the sense auditor (`api/split-senses.js`) — bills
an Anthropic account per request.

Each user supplies their own key through **profile menu → Connect Claude
account**. It is kept in that browser's `localStorage` and sent as an
`x-anthropic-key` header on their own requests only. It is never written to
the database or to a log, so this app is not a custodian of anyone's
credentials.

Without a key the server answers `402` and the client offers the dialog. The
one exception is `ADMIN_EMAIL`, whose requests fall back to
`ANTHROPIC_API_KEY` above.

This closed a real hole: `/api/chat` and `/api/split-senses` previously
accepted any signed-in caller and `/api/review-answer` accepted *anyone*,
all of them spending the deploy owner's Anthropic credit.

**6. Redeploy**

Vercel → Deployments → click the latest → click **...** → **Redeploy**.
Or just push any git commit and it'll auto-redeploy. The new
`api/review-answer.js` will be picked up as a serverless function automatically.

### How it flows

1. User types a wrong answer → sees "✗ Answer: ..."
2. Clicks "My answer should have been accepted"
3. Row goes into `feedback_submissions` with `status='pending'`
4. Client fires-and-forgets a POST to `/api/review-answer`
5. Serverless function fetches the row, sends it to Claude with the prompt
   "is this equivalent?"
6. Claude returns `accept` / `reject` / `uncertain` + a one-sentence reason
7. The verdict gets written back to the same row
8. You see the row in the **Feedback** tab when you log in
9. You click **Approve** → an entry lands in `card_alternates` and is
   immediately used by the matcher for everyone
10. Or you click **Reject** → row marked reviewed, no change to the deck

### What it costs

- **Claude API**: rough estimate is $0.002 per review (Sonnet 4.5, ~500 tokens
  in/out). 1,000 reviews ≈ $2. Realistically you'll get a few per day.
- **Supabase**: free tier is fine, the new tables are tiny.
- **Vercel**: free tier includes serverless function invocations.

### Security model

- Users can only see/insert their own feedback rows (RLS).
- You (admin email) can read everyone's feedback and approve/reject.
- The serverless function uses the service-role key to update rows after the
  LLM verdict, bypassing RLS — but it only does so for the specific
  `submissionId` passed in, so a malicious caller can't read other users' data.
- The Anthropic API key is never exposed to the browser; it lives only in
  Vercel's environment variables and is used by the serverless function.
- The `card_alternates` table is readable by all signed-in users (so the
  matcher works) but only writable by admin.



- **Multiple decks**: right now every user shares the same 919 cards. If you
  want each teacher to have their own deck, you'd add a `decks` table and let
  users pick one on login.
- **Stats for the teacher**: a page where your teacher can see aggregate
  progress across all students. Would need a new admin-only RLS policy.
- **Import from Google Doc**: parse your lesson log automatically instead of
  hand-editing `cards.js`. Not trivial because of the table formatting.
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

Total cost to run: $0.
