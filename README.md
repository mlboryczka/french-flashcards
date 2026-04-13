# French Flashcards

A spaced-repetition flashcard app built from a year of daily French lesson logs.
Features 919 cards across vocabulary, expressions, grammar, and pronunciation,
with fuzzy typing mode, gender-aware matching, fill-in-the-blank exercises, and
per-user progress synced via Supabase.

## Stack

- **Frontend**: Vite + React (no framework besides React itself)
- **Auth + database**: Supabase (Postgres + magic-link email auth, both free tier)
- **Hosting**: Vercel, Cloudflare Pages, or Netlify — all work identically

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

## Things you might want to add later

- **Multiple decks**: right now every user shares the same 919 cards. If you
  want each teacher to have their own deck, you'd add a `decks` table and let
  users pick one on login.
- **Stats for the teacher**: a page where your teacher can see aggregate
  progress across all students. Would need a new admin-only RLS policy.
- **Import from Google Doc**: parse your lesson log automatically instead of
  hand-editing `cards.js`. Not trivial because of the table formatting.
- **Mobile app**: the current app works fine in mobile browsers; wrapping it in
  Capacitor or PWA-enabling it would make it installable.

## Local development notes

- The fuzzy matcher lives in `src/FlashcardApp.jsx` (look for `matchAnswer`).
  It handles accents, articles, typos via Damerau-Levenshtein, and strict
  French gender matching. If you hit a false positive or false negative, the
  logic is in that function.
- Progress is stored in Supabase but updated optimistically — the UI advances
  immediately on rating a card, and the upsert happens in the background.
- The deck is rebuilt only when filters/mode change, not on every answer, so
  you don't get the back-and-forth between the same two cards bug.

## Cost

Supabase free tier: unlimited API requests, 500 MB database, 50k monthly
active users. You'll never come close.

Vercel free tier: 100 GB bandwidth, unlimited deploys. Fine for hundreds of
testers.

Total cost to run: $0.
