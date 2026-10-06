# Where Claude is used

Claude is only ever called from the server, never from the browser. It does
four jobs in the app, and is called again each week to test two of them:

| Job | Model | Paid for by |
|---|---|---|
| Reading class notes into cards | Haiku 4.5 | the owner for the linked notebook; the student for an upload |
| Judging a disputed mark | Opus 5 | the student |
| Reviewing feedback | Opus 5.5 | the owner |
| The tutor | Sonnet 5 | the student |
| Testing its own marking and note reading | the same as the app | the owner |

"The owner" is the person who runs the app, and also studies with it. Three
maintenance scripts use Claude as well: one splits cards that teach two
words, one sorted the original deck's grammar cards, and one works through old
disputed marks that were never settled.

## Reading class notes

A class is a few hundred words, and the job is to pull out the words, phrases
and conjugations worth a card, so the fastest model does it. The rules for what
becomes a card, and how the linked notebook is read, are in
[How class notes become cards](cards-from-notes.md).

## Judging a disputed mark

When the app marks a typed answer wrong, the student can press "My answer
should be accepted". Claude is shown the card and what was typed, and answers
accept, reject or uncertain, with a one-sentence reason that appears on the
card straight away.

- **Accepted:** the answer counts as right, and from then on it is accepted
  for that student, with no approval step and no redeploy.
- **Rejected or uncertain:** the reason is shown, with an "Accept anyway"
  button, which accepts the answer without asking Claude, so it costs nothing.

An accepted answer belongs to the student who earned it. Accepted answers used
to be shared, and one student's loose synonym became accepted for everyone who
had the card.

Every verdict is saved, and the app tests Claude's marking against the owner's
decisions every week ([details](evaluation-harness.md#marking-disputed-answers)).

## Reviewing feedback

"Send feedback" in the sidebar takes a message, with a screenshot and the card
on screen if the student wants. Claude reviews each piece of feedback as it
arrives. It reads the message, the card as it is now and any screenshot, and
decides on one of four outcomes, with a few sentences saying whether the sender
is right and why:

- a corrected card,
- removing the card (for example "estar", which is Spanish),
- a problem with the app, with a brief to paste into a coding session,
- no change needed.

Nothing changes until the owner presses a button in "View feedback". Apply
corrects the card where it is, so it keeps its schedule and its answers. Apply
is refused if the card has changed since Claude looked at it. Remove card takes
the card out of study and keeps its answers. Revert puts a card back as it was,
and Dismiss closes the entry.

## The tutor

The tutor is a side panel for asking about the card on screen. Until the
card's answer has been shown, it gives hints rather than the answer. It can
suggest new cards, but it never writes to the database itself. A suggested card
is shown to the student, who can edit it before adding it, and the student's
own browser saves it under their own permissions.

## Who pays

Students pay for their own requests with their own Anthropic API key, entered
under "Connect Claude account" in the profile menu. The key stays in their
browser and is sent with each of their own requests. It is never stored on the
server or in the database, so the app holds nobody's credentials. Without a
key, the server refuses the request and the app asks for one.

The owner's key, set on the server, pays for the owner's own requests, and for
work no student asks for: reading every linked notebook (the daily job runs
with no student there to pay), reviewing feedback (the reviews are for the
owner), and the weekly tests of Claude's work.

Before students brought their own keys, three routes accepted callers they
shouldn't have, one of them anyone at all, signed in or not, and all three
spent the owner's credit.

## Security

- Every route checks the caller's sign-in with Supabase rather than just
  decoding their token, because a decoded token can be forged. Routes for the
  owner only also check the owner's address, on the server.
- Settings whose names start with `VITE_` are built into the public page, so
  the owner's address there only decides whether the owner's menu items are
  drawn. It is never the real check.
- The service key, which can read and write any row, is used only on the
  server, and every route that uses it checks ownership itself.
- An accepted answer is written for the verified caller only. Each student can
  read and change only their own rows.
- The scheduled jobs run only when the request carries a secret that Vercel
  sends.
- A test suite checks that a caller without a verified sign-in can't cause a
  single request to Claude.
- Speech uses the browser's own French voice. An earlier version sent text to a
  paid speech service through two routes that had no sign-in check at all.
  They were removed rather than patched.

## Cost

Hosting runs on the free tiers of Supabase and Vercel. Claude is the only bill.
As rough estimates, reading a new class costs a cent or two (one Haiku 4.5
call), and judging a disputed mark under 3 cents (one Opus 5 call, with the
reply capped at 1,000 tokens).

## In the code

- `api/parse-cahier.js`, `api/cahier-parse.js`, `api/cahier-sync.js` and
  `api/cahier-daily.js`: reading class notes
- `api/review-answer.js`: judging a disputed mark, and (through
  `api/_lib/feedbackReview.js`) reviewing feedback
- `api/chat.js`: the tutor
- `api/_lib/auth.js` and `api/_lib/anthropicKey.js`: who may call, and whose
  key pays
