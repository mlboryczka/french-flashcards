# Running your own copy

Setting up a copy takes about half an hour the first time. You need three
accounts: Supabase for the database and sign-in, Vercel for hosting, and
Anthropic for Claude.

## 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com).
2. Click **New project**, name it, set a database password (you'll rarely need
   it), and pick the region closest to you.
3. Wait about two minutes while it is set up.

## 2. Set up the database

1. In the Supabase dashboard, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this repository and replace every
   `YOUR_EMAIL_HERE@example.com` with the email you will sign in with. Paste the
   whole file into the editor and click **Run**. You should see "Success. No
   rows returned." This creates the tables, with row-level security so that
   each user can only see their own data.
3. Run each file in `migrations/` the same way, in number order, from 002 to
   015. Migrations 002 and 009 have the same email placeholder to replace.
   Migration 003 has the original owner's address where the placeholder would
   be, so replace that with yours too.

Any migration can safely be run again except two. Running 004 again would
blank the card numbers in the log of corrections. Running 007 again would
overwrite every answered card's schedule with a guess and make them all due at
once.

## 3. Set the sign-in addresses

Sign-in links are emailed, and they need to point at your app, not at
Supabase. This is the step that's easiest to forget.

1. In Supabase, open **Authentication** → **URL Configuration**.
2. Set **Site URL** to `http://localhost:5173` for now. You'll change it to
   your real address in step 7.
3. Under **Redirect URLs**, add `http://localhost:5173`, and click **Save**.

## 4. Copy your keys

In Supabase, open **Project Settings** → **API**, and copy:

- the **Project URL**, which looks like `https://xxxxx.supabase.co`;
- the **anon public** key. It is safe in the browser, because row-level
  security protects the data;
- the **service_role** key, under **Reveal**. This one can read and write every
  row, so it must never be committed, put in browser code or shared. Only the
  server uses it.

## 5. Run it on your computer

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `.env.local` with the values from step 4 before running the last
command. Then open http://localhost:5173, enter your email, and click the link
in your inbox.

Vite serves the app but not the server functions in `api/`, so anything that
calls one only works on the deployed site: uploading notes, the linked
notebook, the tutor, disputing a mark, and fitting each student's settings.

## 6. Deploy to Vercel

Push the repository to GitHub, then at [vercel.com](https://vercel.com) choose
**Add New Project** and import it. Vercel recognises Vite. Before the first
deploy, add these environment variables:

- `VITE_SUPABASE_URL`: your Supabase URL.
- `VITE_SUPABASE_ANON_KEY`: your anon key.
- `VITE_ADMIN_EMAIL`: your email. It only decides whether the owner's menu
  items are drawn. Anything starting with `VITE_` is built into the public
  page, so it is never a security check.
- `SUPABASE_URL`: the same as `VITE_SUPABASE_URL`.
- `SUPABASE_SERVICE_ROLE_KEY`: the service_role key.
- `ADMIN_EMAIL`: your email. This is the real owner check, made on the server.
- `ANTHROPIC_API_KEY`: a key from
  [console.anthropic.com](https://console.anthropic.com). It pays for reading
  every student's linked notebook, Claude's review of feedback, the weekly
  tests of Claude's work, and your own requests. Students bring their own key
  for theirs (see [Where Claude is used](where-claude-is-used.md#who-pays)).
- `CRON_SECRET`: any long random string. Vercel sends it with each scheduled
  run, and without it the scheduled runs refuse to start.

Only the three `VITE_` settings reach the browser. `.env.example` lists them
all.

Deploying takes about a minute. Every push to `main` deploys again.

Two things to know about Vercel's free Hobby plan:

- It deploys at most 12 server functions, and this app has exactly 12, one per
  file in `api/`. A 13th file fails the whole deployment. Shared code lives in
  `api/_lib/`, which doesn't count.
- `vercel.json` sets four scheduled runs a day, all on `api/cahier-daily`. At
  13:00 UTC it reads the linked notebooks, at 14:00 it runs the status check on
  every student, and at 15:00 and 16:00 it runs the tests of Claude's marking
  and note reading when they are due.

## 7. Give Supabase your real address

Back in Supabase, under **Authentication** → **URL Configuration**, set **Site
URL** to your Vercel address and add it under **Redirect URLs**. Without this,
sign-in links send everyone to localhost.

## 8. Share it

Send the address to your students. They enter their email, click the link,
and each one's progress is kept apart from everyone else's.

A free Supabase project pauses after about a week without use. The app then
says "Couldn't reach the server", and you can resume the project from the
Supabase dashboard.

## Speech

There is nothing to set up. The app reads French aloud with the browser's own
French voice, which macOS and Windows include. If a browser has no French
voice, the app stays silent rather than reading French with an English voice.

## Tests

```bash
npm test
npm test -- layout
npm run simulate
npm run simulate:compare
```

`npm test` runs every suite, and `npm test -- layout` only those whose names
contain "layout". `npm run simulate` runs simulated students through the status
check in a few seconds, and `npm run simulate:compare` compares the "How much
to remember" settings in about a minute.

The browser suites run against a mock database. `npm test` writes a throwaway
`.env.local` for them, so it refuses to start while a real one is present. The
[tests guide](../tests/README.md) says more, and GitHub runs everything on every
push (see [Evaluation harness](evaluation-harness.md)).

## Maintenance scripts

The `scripts/` folder holds jobs run by hand against the live database: for
example, running the status check from the terminal, or closing feedback once
it has been dealt with. They read `.env.local`. Nothing is written without
`--apply`, and the scripts that change cards back up every row they touch
first, to `backups/`, which git ignores because it holds students' cards. The
[tests guide](../tests/README.md#maintenance-runners-scripts) describes each one.
