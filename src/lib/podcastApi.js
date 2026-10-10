// The one door to the server for the Podcasts pages: POST /api/podcasts with
// { action, ... }.
//
// One route for everything (following a podcast, refreshing the feeds,
// opening an episode, marking an answer, adding a card) because Vercel's
// Hobby plan deploys at most twelve routes and this is the eleventh
// (owner-approved build spec, 2026-10-09). The server checks the session and,
// while the module is the owner's alone, refuses anyone else with 403.
//
// Shaped like the other small client helpers (src/StatusAnswers.jsx,
// src/ChatPanel.jsx): the Supabase session's token as a Bearer header, the
// student's own Anthropic key (src/lib/anthropicKey.js) on the actions that
// spend Claude credit, a plain sentence on failure, and the server's `code`
// kept on the error, so the page can offer "Connect Claude account" on
// byok_required and "Update your key" on bad_key, exactly as the tutor does.
//
// The Supabase client is passed in rather than imported, so this file has no
// import.meta.env in it and can be loaded by a test in Node.

import { keyHeaders } from "./anthropicKey.js";

export const PODCASTS_ENDPOINT = "/api/podcasts";

// The actions that can call Claude, and so carry the student's key: making an
// episode's questions the first time it is opened, marking an answer, and the
// same-card question behind "Add to my cards". Following and refreshing read
// RFI and Spotify only, so the key isn't sent with them.
export const SPENDING_ACTIONS = new Set(["episode", "mark", "add-card"]);

// An answer the page can act on: `status` (the HTTP status), `code` (the
// server's, or "" when it gave none).
export class PodcastError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "PodcastError";
    this.status = status;
    this.code = code;
  }
}

// Resolves to { status, data } for any 2xx (202 means "being prepared": the
// questions are being written by another request, so ask again shortly).
// Throws PodcastError for anything else, with the server's own sentence when
// it sent one.
export async function podcastCall(body, { supabase, user, fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let token = "";
  try {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token || "";
  } catch {
    /* no session to read: the server says "Sign in first." */
  }
  if (!token) throw new PodcastError("Your session has ended. Sign in again.", { status: 401, code: "no_session" });

  let res;
  try {
    res = await doFetch(PODCASTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(SPENDING_ACTIONS.has(body?.action) ? keyHeaders(user?.id) : {}),
      },
      body: JSON.stringify(body || {}),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new PodcastError("Couldn’t reach the server. Check your connection and try again.", { code: "network" });
  }

  const raw = await res.text().catch(() => "");
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { status: res.status, data: data || {} };

  // A platform error page (the function ran out of time, or crashed before it
  // could answer) isn't JSON: say what happened in plain words.
  const fallback =
    res.status === 504 ? "The server took too long. Try again in a minute."
    : res.status === 403 ? "Podcasts are only open to the owner for now."
    : `The server answered ${res.status}. Try again.`;
  throw new PodcastError((data && typeof data.error === "string" && data.error) || fallback, {
    status: res.status,
    code: (data && typeof data.code === "string" && data.code) || "",
  });
}
