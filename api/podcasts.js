// Vercel serverless function: POST /api/podcasts
//
// The Podcasts module (2026-10-09): RFI's learner podcasts, with passage
// questions Claude writes once per episode and marks per answer. One route
// for every action, because Vercel's Hobby plan deploys at most 12 routes and
// this is the eleventh; never add another file to api/ for Podcasts.
//
// Request body: { action, ... }
//   follow    { link } (a Spotify episode or show link) or { slug }
//             -> { podcast, episodeId? }
//   refresh   {} -> { ok, count }
//   episode   { episodeId } -> { episode }, or 202 { status: "preparing" }
//             while another request writes its questions
//   mark      { episodeId, key, typed, timeZone } -> { answer, saved }
//   add-card  { episodeId, front, back } -> { added, have, removed, waiting }
// Errors: { error, code } with a plain sentence the page shows as it is.
//
// Owner only until the owner has tested it (2026-10-09): a verified session,
// then 403 "Admin only" for anyone else. The client hides the module from
// students too, but its admin check reads a public address and only hides.
//
// The key that pays is worked out only inside the actions that call Claude
// (writing an episode's questions, marking, and the same-card question when
// adding a card), by the same rule requireAnthropicKey uses
// (api/_lib/anthropicKey.js): the caller's own key, or for the owner the
// server's. Following a podcast or opening an episode whose questions exist
// needs no key and spends nothing.
//
// Everything else is in api/_lib/podcasts.js, which the tests run without a
// database (tests/suites/podcast-marking.mjs).

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { requireUser, isAdmin } from "./_lib/auth.js";
import { resolveAnthropicKey } from "./_lib/anthropicKey.js";
import { handlePodcastRequest, supabasePodcastStore, claudeError } from "./_lib/podcasts.js";

// Writing an episode's questions can take a couple of minutes (its own limit
// is 150 s, api/_lib/podcastQuestions.js), after reading RFI's page.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireUser(req, res);
  if (!user) return;
  if (!isAdmin(user)) return res.status(403).json({ error: "Admin only" });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { status, json } = await handlePodcastRequest({
      body: req.body || {},
      user,
      isAdmin: true,
      store: supabasePodcastStore(db),
      // Resolved only when an action is about to call Claude.
      apiKey: () => resolveAnthropicKey(req, user),
    });
    return res.status(status).json(json);
  } catch (err) {
    // The raw message is for the log, never for the page.
    console.error("[podcasts] failed:", err);
    if (err instanceof Anthropic.APIError) {
      const { status, json } = claudeError(err, "answer");
      return res.status(status).json(json);
    }
    return res.status(500).json({ error: "Podcasts couldn’t do that just now. Try again.", code: "server_error" });
  }
}
