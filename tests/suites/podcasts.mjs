// The Podcasts module, in the owner's build (2026-10-09).
//
// What the owner asked for, in their words and the approved mockup's
// (.claude/mockups/podcasts.html, "i like it build it"):
//   • a switch at the top of the sidebar, Flashcards | Podcasts, for the owner
//     only until they have tried it. Going over to Podcasts and back leaves the
//     cards exactly where they were: the same card, the same counter, and not
//     one write to a card's schedule (owner rule: updates never reset
//     progress). The rail round trip that broke on 2026-10-06 (11275a0) is
//     walked both ways: nothing hides under the minimise button.
//   • Episodes: the episodes of the podcasts you follow, the podcast's name
//     above each title, and "To try again" at the top when a passage is due
//     back.
//   • An episode: the Journal headed by its long date, the others by their
//     title; RFI's own recording in a play bar; Questions, Transcript and
//     Words to learn.
//   • A question is a French passage on screen. Listen plays RFI's recording
//     from 3 s before the passage. You answer in English, Claude marks it, and
//     the page shows the verdict, what you caught and missed, a good answer,
//     and the key phrases, each with "Add to my cards".
//   • Add to my cards goes through the server's same-card rule: one request,
//     no card written from the browser, no deck refetch (which would re-deal
//     the set). A phrase already in the deck says so; a card the student
//     removed stays removed.
//   • The first open of an episode waits while Claude writes its questions.
//   • Before the owner runs migration_017 the pages say so plainly.
//
// Runs its own Vite with the test account as admin (as statusline.mjs does),
// on PODCASTS_APP_PORT (default 5191), against the usual mock Supabase. The
// podcast tables and /api/podcasts are stood in here; nothing reaches RFI,
// Spotify, Supabase or Anthropic. Recordings are never fetched: every .mp3 is
// answered empty, and HTMLMediaElement.play is a spy that notes where it was
// asked to start and plays nothing.
//
// Expected values come from this file's fixtures and the module's constants,
// never from the page's own code: the counts are counted here, the deck card
// comes from servedDeck(), the Listen lead from LISTEN_LEAD_S.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openApp, finish, checker, servedDeck, sessionCounter, cardBox, settled, APP } from "../harness.mjs";
import { LISTEN_LEAD_S, LISTEN_TAIL_S, listenWindow, passageState, episodeStatus, episodeProgress, latestAnswers, transcriptSections } from "../../src/lib/podcastProgress.js";
import { PODCASTS, podcastBySlug, RETRY_DAYS } from "../../src/lib/podcastCatalogue.js";

const ck = checker();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PODCASTS_APP_PORT || 5191);
const ADMIN_APP = `http://localhost:${PORT}`;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
const DAY = 86400000;
// How long the stand-in server says an episode's questions are still being
// written (it answers 202 meanwhile).
const PREPARING_MS = 2500;
const UID = "00000000-0000-0000-0000-000000000001";

// ── The rules the pages count by, checked without a browser ────────────────
console.log("\n  the rules, without a browser");
{
  const w = listenWindow({ start: 40, end: 52 }, 600);
  ck("Listen starts LISTEN_LEAD_S before the passage and stops LISTEN_TAIL_S after it", w.from === 40 - LISTEN_LEAD_S && w.to === 52 + LISTEN_TAIL_S, JSON.stringify(w));
  const edge = listenWindow({ start: 1, end: 598 }, 599);
  ck("and never before the start of the recording or past its end", edge.from === 0 && edge.to === 599, JSON.stringify(edge));
  const now = Date.now();
  ck("a missed passage is due once its come-back time has passed", passageState({ verdict: "missed", due_at: new Date(now - 1000).toISOString() }, now) === "due");
  ck("and waits before then", passageState({ verdict: "partly", due_at: new Date(now + DAY).toISOString() }, now) === "waiting");
  ck("a passage got never comes back", passageState({ verdict: "got", due_at: null }, now + 1000 * DAY) === "got");
  const one = episodeStatus({ total: 3, answered: 1, understood: 0, due: 1 });
  const two = episodeStatus({ total: 3, answered: 0, understood: 0, due: 2 });
  ck("one passage due says “1 passage to try again”", one.text === "1 passage to try again", one.text);
  ck("two say “2 passages to try again”", two.text === "2 passages to try again", two.text);

  // The Transcript tab before the stories' first paragraphs are known: the
  // server saves each story with p: null when it reads RFI's page, and keeps
  // null when Claude's story starts don't check out. The transcript is then
  // one untitled section, not all of it under the headlines' heading.
  const paras = ["Bonsoir, voici les titres.", "Premier sujet.", "La suite du premier sujet.", "Deuxième sujet.", "Au revoir."];
  const unplaced = [{ t: 8, title: "Les titres", p: null }, { t: 70, title: "Premier sujet", p: null }, { t: 210, title: "Deuxième sujet", p: null }];
  for (const [label, starts] of [["no questions yet", undefined], ["story starts that didn't check out", []]]) {
    const secs = transcriptSections(paras, unplaced, starts);
    ck(`Transcript, stories not placed (${label}): one section with no heading or time, every paragraph in it, nothing filed under “${unplaced[0].title}”`,
       secs.length === 1 && secs[0].title === "" && secs[0].t === null && secs[0].paragraphs.length === paras.length,
       JSON.stringify(secs.map((s) => [s.title, s.t, s.paragraphs.length])));
  }
  const placedAt = [0, 1, 3];
  const placed = transcriptSections(paras, unplaced, placedAt);
  ck("Transcript, stories placed: each story is a section under its own title and time, every paragraph in one",
     placed.length === unplaced.length && placed.every((s, i) => s.title === unplaced[i].title && s.t === unplaced[i].t) &&
     placed.reduce((n, s) => n + s.paragraphs.length, 0) === paras.length && placed[1].paragraphs[0].index === placedAt[1],
     JSON.stringify(placed.map((s) => [s.title, s.t, s.paragraphs.length])));
}

// ── The episodes the stand-in database holds ───────────────────────────────
// Short, synthetic French written for these tests (RFI's text is copyrighted
// and this repository is public), in the shape the server stores (build spec
// §4-§5). The Journal episode has stories with start times; the other is one
// topic, with its questions not written yet.
const JEFF = "journal-en-francais-facile";
const MOTS = "les-mots-de-l-info";
const UMUH = "un-mot-une-histoire";

const deck = await servedDeck();
// A phrase the student already has: a card from the deck the mock serves.
const haveRow = deck.find((r) => r.category === "E") || deck.find((r) => r.category === "V");
const haveFr = haveRow.front.charAt(0).toUpperCase() + haveRow.front.slice(1);
// A card the student removed: served here as an archived row (migration_016).
const REMOVED = { front: "la grève", back: "the strike" };

const EP1 = {
  id: "e1",
  podcast: JEFF,
  guid: "jff-2026-10-06",
  title: "France: la colère des lycéens / Québec: une surprise...",
  published_at: "2026-10-06T16:00:00Z",
  page_url: "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/20261006-test",
  audio_url: "https://audio.example.test/jff/journal-2026-10-06.mp3?guid=test",
  duration_seconds: 600,
  stories: [
    { t: 8, title: "Les titres", p: 0 },
    { t: 70, title: "Lycées : la colère continue", p: 1 },
    { t: 210, title: "Québec : une surprise", p: 3 },
  ],
  transcript: [
    "Bonsoir, voici les titres du journal.",
    "Les lycéens ont manifesté dans plusieurs villes. Ils demandent plus de professeurs.",
    `${haveFr}, le cortège a traversé la ville sans incident, mais la grève continue.`,
    "Au Québec, le parti indépendantiste a gagné les élections. Personne ne s’y attendait.",
    "C’est la fin du journal. Au revoir.",
  ],
};
EP1.questions = {
  storyStarts: [0, 1, 3],
  passages: [
    {
      key: "s1-aaaa1111", story: 1, kind: "gist",
      fr: EP1.transcript[1], start: 72, end: 84,
      answer: "High-school pupils marched in several towns. They want more teachers.",
      ideas: ["that pupils marched in several towns", "that they want more teachers"],
      phrases: [
        { fr: "manifester", en: "to protest", inText: "manifesté" },
        { fr: "un lycéen, une lycéenne", en: "a high-school pupil", inText: "lycéens" },
      ],
    },
    {
      key: "s1-bbbb2222", story: 1, kind: "translate",
      fr: EP1.transcript[2], start: 86, end: 96,
      answer: `${haveRow.back.charAt(0).toUpperCase() + haveRow.back.slice(1)}, the march crossed the town without incident, but the strike goes on.`,
      ideas: ["« le cortège » (the march)", "« sans incident » (without incident)", "« la grève » (the strike)"],
      phrases: [
        { fr: haveRow.front, en: haveRow.back, inText: haveFr },
        { fr: "un cortège", en: "a march, a procession", inText: "cortège" },
        { fr: REMOVED.front, en: REMOVED.back, inText: "la grève" },
      ],
    },
    {
      key: "s2-cccc3333", story: 2, kind: "gist",
      fr: EP1.transcript[3], start: 214, end: 228,
      answer: "In Quebec, the separatist party won the election. Nobody expected it.",
      ideas: ["that the separatist party won in Quebec", "that nobody expected it"],
      phrases: [{ fr: "s’attendre à", en: "to expect", inText: "s’y attendait" }],
    },
  ],
};

const EP2 = {
  id: "e2",
  podcast: MOTS,
  guid: "mots-2026-10-05",
  title: "Un mot à la mode : abuse-t-on de « l’escalade » ?",
  published_at: "2026-10-05T08:00:00Z",
  page_url: "https://francaisfacile.rfi.fr/fr/podcasts/les-mots-de-l-info/20261005-test",
  audio_url: "https://audio.example.test/mots/mots-2026-10-05.mp3",
  duration_seconds: 210,
  stories: [],
  transcript: [
    "Au sens propre, l’escalade est un sport : on grimpe.",
    "Au sens figuré, une escalade, c’est quand une situation s’aggrave.",
    "Les journalistes emploient-ils ce mot trop souvent ?",
  ],
  questions: null,
};
const EP2_QUESTIONS = {
  storyStarts: [],
  passages: EP2.transcript.map((fr, i) => ({
    key: `sx-0000000${i}`, story: null, kind: i === 1 ? "translate" : "gist",
    fr, start: 10 + i * 60, end: 40 + i * 60,
    answer: ["Literally, climbing is a sport.", "Figuratively, an escalation is when things get worse.", "Do journalists use this word too often?"][i],
    ideas: ["that it is a sport"],
    phrases: [{ fr: "grimper", en: "to climb", inText: "grimpe" }],
  })).slice(0, 3),
};

// The student's record: one passage of the Journal missed four days ago, so
// back for another try now (RETRY_DAYS after the answer, as the server sets).
const now = Date.now();
const ANSWERS = [
  {
    id: "a-old", user_id: UID, episode_id: "e1", passage_key: "s2-cccc3333", kind: "gist",
    fr: EP1.questions.passages[2].fr, typed: "Something about Quebec", verdict: "missed",
    feedback: { caught: [], missed: EP1.questions.passages[2].ideas, note: "" },
    answered_at: new Date(now - (RETRY_DAYS + 1) * DAY).toISOString(),
    due_at: new Date(now - DAY).toISOString(),
  },
];
// Months of earlier answers, all got, to an episode no longer listed: more
// rows than Supabase returns in one request (SUPABASE_MAX_ROWS), all older
// than the answer above. Read oldest first in one request, they would push
// that answer, the newest, off the end, and the Journal's passage due back
// would show as never answered.
const SUPABASE_MAX_ROWS = 1000;
const EARLIER = Array.from({ length: SUPABASE_MAX_ROWS + 200 }, (_, i) => ({
  id: `a-earlier-${String(i).padStart(4, "0")}`, user_id: UID, episode_id: "e0", passage_key: `s${i % 8}-${String(i).padStart(8, "0")}`,
  kind: "gist", fr: "Une phrase plus ancienne.", typed: "An older answer", verdict: "got",
  feedback: { caught: ["that it is older"], missed: [], note: "" },
  answered_at: new Date(now - 200 * DAY + i * 60000).toISOString(),
  due_at: null,
}));
// What Claude says to each answer, by passage.
const VERDICTS = { "s1-aaaa1111": "partly", "s1-bbbb2222": "got", "s2-cccc3333": "missed" };

// PostgREST as Supabase runs it: rows in the order asked for, from `offset`,
// at most `limit` of them, and never more than SUPABASE_MAX_ROWS in one
// response whatever the limit says.
function served(rows, url) {
  const order = (url.searchParams.get("order") || "").split(",").filter(Boolean).map((o) => {
    const [col, dir] = o.split(".");
    return { col, desc: dir === "desc" };
  });
  const sorted = [...rows].sort((a, b) => {
    for (const { col, desc } of order) {
      const x = a[col] ?? "";
      const y = b[col] ?? "";
      if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
  const offset = Number(url.searchParams.get("offset") || 0);
  const limit = Math.min(Number(url.searchParams.get("limit") || Infinity), SUPABASE_MAX_ROWS);
  return sorted.slice(offset, offset + limit);
}

const listRow = (e) => {
  const { transcript, ...rest } = e;
  return rest;
};

// ── The admin build ────────────────────────────────────────────────────────
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT, detached: true, stdio: "ignore",
  env: {
    ...process.env,
    VITE_ADMIN_EMAIL: "test@example.com",
    VITE_SUPABASE_URL: process.env.MOCK_URL || "http://127.0.0.1:5999",
    VITE_SUPABASE_ANON_KEY: "test.key",
  },
});
const stop = () => { try { process.kill(-vite.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let i = 0; i < 150; i++) {
  try { await fetch(ADMIN_APP); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
// Answering is not the same as ready: the first page load makes a cold Vite
// work out the app's dependencies and transform every module, and while the
// student's Vite (APP) is doing the same on this machine that took longer
// than the browser's 30 s for a page load (it failed a first try,
// 2026-10-09). Asking for the entry modules waits for that work here, where
// there is time for it.
for (const path of ["/src/main.jsx", "/src/App.jsx", "/src/FlashcardApp.jsx", "/src/PodcastsPage.jsx"]) {
  try { await fetch(ADMIN_APP + path, { signal: AbortSignal.timeout(90000) }); } catch { /* the page load says what's wrong */ }
}

// Everything one browser sees, and a log of what it sent.
function standIns({ migrated = true } = {}) {
  const follows = [
    { user_id: UID, podcast: JEFF, followed_at: new Date(now - 30 * DAY).toISOString() },
    { user_id: UID, podcast: MOTS, followed_at: new Date(now - 20 * DAY).toISOString() },
  ];
  const log = {
    api: [],              // every POST /api/podcasts body
    otherApi: [],         // any other /api request (not stood in here)
    chat: [],             // every /api/chat body
    cardWrites: [],       // POST/PATCH/DELETE to user_cards, from the browser
    deckGets: 0,
    podcastWrites: [],    // any write to a podcast_* table from the browser
    listColumns: [],      // the columns each read of an episode list asked for
    mp3: 0,
  };
  const state = { e2Opens: 0, e2FirstAt: 0, failNextMark: false, answers: [...EARLIER, ...ANSWERS] };
  const json = (r, status, body) => r.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });

  const route = async (p) => {
    // The recording: noted, never played.
    await p.addInitScript(() => {
      window.__plays = [];
      window.__pauses = [];
      HTMLMediaElement.prototype.play = function play() {
        window.__plays.push({ src: this.getAttribute("src") || "", t: this.currentTime });
        return Promise.resolve();
      };
      const pause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function pauseSpy() {
        window.__pauses.push({ src: this.getAttribute("src") || "", connected: this.isConnected });
        return pause.call(this);
      };
    });
    await p.route("**/*.mp3*", (r) => { log.mp3++; return r.fulfill({ status: 200, contentType: "audio/mpeg", body: "" }); });
    // Registered first, so every route below wins over it.
    await p.route("**/api/**", (r) => { log.otherApi.push(new URL(r.request().url()).pathname); return r.continue(); });
    await p.route("**/api/chat", async (r) => {
      log.chat.push(JSON.parse(r.request().postData() || "{}"));
      await r.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify({ type: "text", delta: "« Manifester » means to protest." })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
      });
    });
    await p.route("**/api/podcasts", async (r) => {
      const req = r.request();
      const body = JSON.parse(req.postData() || "{}");
      log.api.push({ ...body, _auth: req.headers().authorization || "" });
      if (body.action === "refresh") return json(r, 200, { ok: true, count: 0 });
      if (body.action === "episode") {
        if (body.episodeId === EP1.id) return json(r, 200, { episode: EP1 });
        if (body.episodeId === EP2.id) {
          state.e2Opens++;
          // Someone else is writing its questions for the first few seconds.
          // Seconds, not "the first ask": React's development mode mounts the
          // page twice and asks twice at once.
          if (!state.e2FirstAt) state.e2FirstAt = Date.now();
          if (Date.now() - state.e2FirstAt < PREPARING_MS) return json(r, 202, { status: "preparing" });
          return json(r, 200, { episode: { ...EP2, questions: EP2_QUESTIONS } });
        }
        return json(r, 404, { error: "That episode isn’t in RFI’s feed any more.", code: "not_found" });
      }
      if (body.action === "mark") {
        if (state.failNextMark) {
          state.failNextMark = false;
          return json(r, 502, { error: "Claude is busy. Try again in a minute.", code: "overloaded" });
        }
        const passage = [...EP1.questions.passages, ...EP2_QUESTIONS.passages].find((x) => x.key === body.key);
        const verdict = VERDICTS[body.key] || "got";
        const half = Math.ceil(passage.ideas.length / 2);
        const feedback = verdict === "got" ? { caught: passage.ideas, missed: [], note: "" }
          : verdict === "partly" ? { caught: passage.ideas.slice(0, half), missed: passage.ideas.slice(half), note: "" }
          : { caught: [], missed: passage.ideas, note: "" };
        const answer = {
          id: `a-${log.api.length}`, passage_key: body.key, verdict, feedback,
          answered_at: new Date().toISOString(),
          due_at: verdict === "got" ? null : new Date(Date.now() + RETRY_DAYS * DAY).toISOString(),
        };
        return json(r, 200, { answer, saved: true });
      }
      if (body.action === "add-card") {
        return json(r, 200, {
          added: [{
            id: 990000 + log.api.length, user_id: UID, front: body.front, back: body.back, category: "V", dates: [],
            source: `podcast:${body.episodeId}`, created_at: new Date().toISOString(),
            fsrs_state: 0, reps: 0, lapses: 0, en_fsrs_state: 0, en_reps: 0, en_lapses: 0, next_due_at: new Date().toISOString(),
          }],
          have: [], removed: false, waiting: false,
        });
      }
      if (body.action === "follow") {
        if (!/^https:\/\/open\.spotify\.com\//.test(String(body.link || ""))) {
          return json(r, 400, { code: "bad_link", error: "That doesn’t look like a Spotify link." });
        }
        if (!follows.some((f) => f.podcast === UMUH)) follows.push({ user_id: UID, podcast: UMUH, followed_at: new Date().toISOString() });
        return json(r, 200, { podcast: UMUH });
      }
      return json(r, 400, { error: "Unknown action" });
    });
    await p.route("**/rest/v1/podcast_*", async (r) => {
      const req = r.request();
      const url = new URL(req.url());
      const table = url.pathname.split("/").pop();
      if (!migrated) {
        return json(r, 404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
      }
      if (req.method() !== "GET") {
        log.podcastWrites.push({ table, method: req.method() });
        return json(r, 403, { code: "42501", message: "permission denied" });
      }
      if (table === "podcast_follows") return json(r, 200, follows.map(({ podcast, followed_at }) => ({ podcast, followed_at })));
      if (table === "podcast_answers") return json(r, 200, served(state.answers, url));
      if (table === "podcast_episodes") {
        const id = url.searchParams.get("id");
        if (id) {
          const e = [EP1, EP2].find((x) => `eq.${x.id}` === id);
          return json(r, 200, e ? [{ transcript: e.transcript, stories: e.stories }] : []);
        }
        log.listColumns.push((url.searchParams.get("select") || "").split(",").map((c) => c.trim()));
        const slug = (url.searchParams.get("podcast") || "").replace(/^eq\./, "");
        return json(r, 200, [EP1, EP2].filter((e) => e.podcast === slug).map(listRow));
      }
      return json(r, 200, []);
    });
    await p.route("**/rest/v1/user_cards*", async (r) => {
      const req = r.request();
      if (req.method() !== "GET") {
        log.cardWrites.push({ method: req.method(), url: req.url() });
        return r.continue();
      }
      log.deckGets++;
      const res = await r.fetch();
      const rows = await res.json().catch(() => []);
      // The student's removed card, out of study, as migration_016 keeps it.
      rows.push({
        id: 880001, front: REMOVED.front, back: REMOVED.back, category: "V", dates: [], flagged_for_review: false,
        source: "archived:cahier-upload", archived_reason: "removed", next_due_at: new Date().toISOString(),
        fsrs_state: 2, reps: 3, lapses: 0, en_fsrs_state: 0, en_reps: 0, en_lapses: 0,
      });
      return r.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(rows) });
    });
  };
  return { route, log, state };
}

const marked = (page) => page.evaluate(() =>
  [...document.querySelectorAll("[data-sidebar] [aria-current='page']")].map((b) => b.dataset.podNav || b.dataset.podFollow || b.textContent.trim())
);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText.trim() ?? null, sel);
const toPodcasts = async (page) => {
  await page.click("[data-module='podcasts']");
  await page.waitForSelector("[data-podcasts-page]", { timeout: 8000 });
};
const toFlashcards = async (page) => {
  await page.click("[data-module='flashcards']");
  await page.waitForSelector('button:has-text("Previous card")', { timeout: 8000 });
  await page.waitForTimeout(300);
};

// ═══ The student's build ═══════════════════════════════════════════════════
console.log("\n  a student's app");
{
  const { browser, page } = await openApp({ app: APP });
  const sw = await page.$("[data-module-switch]");
  ck("a student has no Flashcards | Podcasts switch", !sw);
  await browser.close();
}

// ═══ The owner's build ═════════════════════════════════════════════════════
const S = standIns();
const { browser, page } = await openApp({ app: ADMIN_APP, route: S.route });
const isAdminBuild = !!(await page.$("[data-module-switch]"));
ck("the owner's app shows the switch (the admin build loaded)", isAdminBuild);
if (!isAdminBuild) {
  console.log("  (no switch: the Podcasts checks can't run)");
  await finish(browser, ck);
}

// The lesson sync writes its own cards when the app opens. Only what happens
// from here is this suite's doing.
await page.waitForTimeout(1500);
S.log.cardWrites.length = 0;
const before = { card: (await cardBox(page))?.front, counter: await sessionCounter(page) };

// ── The rail, both ways round ──────────────────────────────────────────────
console.log("\n  the switch on the rail and back (the 11275a0 round trip)");
const rail = () => page.evaluate(() => {
  const aside = document.querySelector("[data-sidebar]");
  const toggle = document.querySelector("[data-sidebar-toggle]");
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const t = toggle ? box(toggle) : null;
  const items = [...aside.querySelectorAll("nav button")].filter((b) => b !== toggle);
  const halves = [...document.querySelectorAll("[data-module-switch] [data-module]")];
  return {
    width: Math.round(aside.getBoundingClientRect().width),
    pressed: halves.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.module),
    titles: halves.map((b) => b.getAttribute("title") || b.textContent.trim()),
    covered: t ? items.filter((b) => overlap(box(b), t) > 1).map((b) => b.getAttribute("title") || b.textContent.trim()) : [],
  };
});
const step = async (label, want) => {
  await settled(page);
  const r = await rail();
  ck(`${label}: ${want.width}px wide`, r.width === want.width, `${r.width}px`);
  ck(`${label}: exactly one half of the switch is on, ${want.on}`, r.pressed.length === 1 && r.pressed[0] === want.on, r.pressed.join(", ") || "none");
  ck(`${label}: nothing sits under the minimise button`, r.covered.length === 0, r.covered.join(", "));
  return r;
};
await step("full width, on Flashcards", { width: 256, on: "flashcards" });
await page.click("[data-sidebar-toggle]");
const r1 = await step("minimised", { width: 64, on: "flashcards" });
ck("on the rail the two halves are named Flashcards and Podcasts", r1.titles.includes("Flashcards") && r1.titles.includes("Podcasts"), r1.titles.join(", "));
await toPodcasts(page);
await step("minimised, on Podcasts", { width: 64, on: "podcasts" });
await page.click("[data-sidebar-toggle]");
await step("expanded, on Podcasts", { width: 256, on: "podcasts" });
await toFlashcards(page);
await step("expanded, back on Flashcards", { width: 256, on: "flashcards" });
await page.click("[data-sidebar-toggle]");
await step("minimised again", { width: 64, on: "flashcards" });
await page.click("[data-sidebar-toggle]");
await step("expanded again", { width: 256, on: "flashcards" });

// ── Episodes ───────────────────────────────────────────────────────────────
console.log("\n  Episodes");
await toPodcasts(page);
await page.waitForSelector("[data-episode='e1']", { timeout: 8000 });
{
  const m = await marked(page);
  ck("Episodes is the page marked in the sidebar, and only it", m.length === 1 && m[0] === "episodes", m.join(", "));
  const followed = await page.$$eval("[data-pod-follow]", (els) => els.map((e) => e.dataset.podFollow));
  ck("the podcasts followed are listed under My podcasts", followed.includes(JEFF) && followed.includes(MOTS), followed.join(", "));
  const due = latestAnswers(ANSWERS);
  const expect1 = episodeStatus(episodeProgress(EP1, due, Date.now())).text;
  const group = await page.$$eval("[data-try-again] [data-episode]", (els) => els.map((e) => e.dataset.episode));
  ck("(the student has more answers than Supabase returns in one request, the one due back the newest)",
     S.state.answers.length > SUPABASE_MAX_ROWS && S.state.answers.every((a) => a.answered_at <= ANSWERS[0].answered_at),
     `${S.state.answers.length} answers, ${SUPABASE_MAX_ROWS} a request`);
  ck("an episode with a passage due back is listed under “To try again”", group.length === 1 && group[0] === "e1", group.join(", "));
  const cols = S.log.listColumns;
  const extra = [...new Set(cols.flat().filter((c) => ["transcript", "questions_error", "questions_lease_until"].includes(c)))];
  ck("the lists never ask for the transcript or the server's notes on writing the questions (why it last failed, its lease)",
     cols.length > 0 && extra.length === 0, extra.join(", ") || `${cols.length} list read(s)`);
  // textContent: the heading is set in capitals by its style, not its words.
  const heading = await page.$eval("[data-try-again] h2", (e) => e.textContent.trim());
  ck("“To try again” heads the group", heading === "To try again", heading);
  const s1 = await text(page, "[data-episode='e1'] [data-episode-status]");
  const dueCount = ANSWERS.filter((a) => a.episode_id === "e1" && a.verdict !== "got" && Date.parse(a.due_at) <= Date.now()).length;
  ck("its line says how many passages are back to try again", s1 === `${dueCount} ${dueCount === 1 ? "passage" : "passages"} to try again` && s1 === expect1, s1);
  const s2 = await text(page, "[data-episode='e2'] [data-episode-status]");
  ck("an episode never opened says “Not started”", s2 === "Not started", s2);
  const pods = await page.$$eval("[data-episode] [data-episode-podcast]", (els) => els.map((e) => e.textContent.trim()));
  ck("each row names its podcast above the title", pods.includes(podcastBySlug(JEFF).name) && pods.includes(podcastBySlug(MOTS).name), pods.join(" | "));
}

// ── One episode ────────────────────────────────────────────────────────────
console.log("\n  the Journal of 6 October");
await page.click("[data-episode='e1']");
await page.waitForSelector("[data-episode-page='e1'] [data-passage]", { timeout: 8000 });
{
  ck("the Journal is headed by its long date", (await text(page, "[data-episode-page] h1")) === "Tuesday 6 October", await text(page, "[data-episode-page] h1"));
  const m = await marked(page);
  ck("the Journal is the podcast marked in the sidebar", m.length === 1 && m[0] === JEFF, m.join(", "));
  ck("the back button says where it goes: Episodes", (await text(page, "[data-back]")) === "Episodes");
  const src = await page.$eval("[data-podcast-audio]", (a) => a.getAttribute("src"));
  ck("the play bar plays the episode's own recording", src === EP1.audio_url, src);
  const tabs = await page.$$eval("[data-podcast-tab]", (els) => els.map((e) => e.textContent.trim()));
  ck("the tabs are Questions, Transcript and Words to learn", tabs.join("|") === "Questions|Transcript|Words to learn", tabs.join(", "));
  const total = EP1.questions.passages.length;
  const answered = EP1.questions.passages.filter((p) => ["got", "waiting"].includes(passageState(latestAnswers(ANSWERS).get(`e1:${p.key}`), Date.now()))).length;
  ck("the count says how many passages are answered", (await text(page, "[data-podcast-count]")) === `${answered} of ${total} passages answered`, await text(page, "[data-podcast-count]"));
  const again = await page.$$eval("[data-passage-again]", (els) => els.map((e) => e.closest("[data-passage]").dataset.passage));
  ck("the passage due back shows again, with “Back for another try”", again.length === 1 && again[0] === "s2-cccc3333", again.join(", "));
  ck("and with an empty answer box", !!(await page.$("[data-passage='s2-cccc3333'] [data-passage-answer]")));
  const instr = await page.$$eval("[data-passage] [data-passage-instruction]", (els) => els.map((e) => e.innerText.trim()));
  ck("each passage says what to do", instr.every((t) => /^(What’s being said here\? Give the idea in English\.|Translate into English\.)$/.test(t)), instr.join(" / "));
  const fr = await page.$eval("[data-passage='s1-aaaa1111'] [data-passage-fr]", (e) => e.innerText.trim());
  ck("the French passage is on screen", fr === EP1.questions.passages[0].fr, fr);
  ck("Check waits for an answer", await page.$eval("[data-passage='s1-aaaa1111'] [data-passage-check]", (b) => b.disabled));
}

console.log("\n  Listen");
{
  const p = EP1.questions.passages[0];
  await page.click(`[data-passage='${p.key}'] [data-passage-listen]`);
  await page.waitForTimeout(200);
  const plays = await page.evaluate(() => window.__plays);
  const last = plays[plays.length - 1] || {};
  ck("Listen plays RFI's recording", last.src === EP1.audio_url, last.src);
  ck(`from ${LISTEN_LEAD_S} s before the passage starts`, Math.abs(last.t - (p.start - LISTEN_LEAD_S)) < 0.01, `${last.t} s for a passage at ${p.start} s`);
  const on = await page.$eval(`[data-passage='${p.key}'] [data-passage-listen]`, (b) => [b.dataset.passageListen, b.innerText.trim()]);
  ck("and the button turns to Stop", on[0] === "on" && on[1] === "Stop", on.join(" "));
  await page.click(`[data-passage='${p.key}'] [data-passage-listen]`);
  const off = await page.$eval(`[data-passage='${p.key}'] [data-passage-listen]`, (b) => [b.dataset.passageListen, b.innerText.trim()]);
  ck("pressed again, it stops and says Listen", off[0] === "off" && off[1] === "Listen", off.join(" "));
}

// ── Over to Flashcards and back, mid-episode ───────────────────────────────
console.log("\n  over to Flashcards and back, mid-episode");
{
  const DRAFT = "Nobody saw it coming";
  await page.fill("[data-passage='s2-cccc3333'] [data-passage-answer]", DRAFT);
  await page.click("[data-audio-play]");
  const pausesBefore = (await page.evaluate(() => window.__pauses)).length;
  await toFlashcards(page);
  const pauses = (await page.evaluate(() => window.__pauses)).slice(pausesBefore);
  ck("leaving the episode stops its recording", pauses.some((x) => x.src === EP1.audio_url), JSON.stringify(pauses));
  const card = (await cardBox(page))?.front;
  const counter = await sessionCounter(page);
  ck("the same card is on screen", card === before.card, `${before.card} → ${card}`);
  ck("at the same place in the set", JSON.stringify(counter) === JSON.stringify(before.counter), `${JSON.stringify(before.counter)} → ${JSON.stringify(counter)}`);
  await toPodcasts(page);
  await page.waitForSelector("[data-episode-page='e1'] [data-passage]", { timeout: 8000 });
  ck("Podcasts opens on the episode left", true);
  const kept = await page.$eval("[data-passage='s2-cccc3333'] [data-passage-answer]", (t) => t.value);
  ck("an answer typed and not sent is still in its box", kept === DRAFT, JSON.stringify(kept));
}

// ── Answering ──────────────────────────────────────────────────────────────
console.log("\n  answering");
{
  const p = EP1.questions.passages[0];
  const TYPED = "Pupils protested in lots of towns";
  await page.fill(`[data-passage='${p.key}'] [data-passage-answer]`, TYPED);
  await page.click(`[data-passage='${p.key}'] [data-passage-check]`);
  await page.waitForSelector(`[data-passage='${p.key}'] [data-passage-verdict]`, { timeout: 8000 });
  const sent = S.log.api.filter((b) => b.action === "mark").pop() || {};
  ck("the answer goes to the server to be marked", sent.episodeId === "e1" && sent.key === p.key && sent.typed === TYPED, JSON.stringify({ episodeId: sent.episodeId, key: sent.key, typed: sent.typed }));
  ck("with the session's token", /^Bearer \S+/.test(sent._auth || ""));
  ck("and the student's time zone", typeof sent.timeZone === "string" && sent.timeZone.length > 0, sent.timeZone);
  const v = await page.$eval(`[data-passage='${p.key}'] [data-passage-verdict]`, (e) => [e.dataset.passageVerdict, e.innerText.trim()]);
  ck("the verdict is shown: Partly", v[0] === VERDICTS[p.key] && v[1] === "Partly", v.join(" "));
  const fb = await text(page, `[data-passage='${p.key}'] [data-passage-feedback]`);
  const half = Math.ceil(p.ideas.length / 2);
  ck("it says what was caught and what was missed", fb.includes(`You caught ${p.ideas.slice(0, half).join(", ")}.`) && fb.includes(`You missed ${p.ideas.slice(half).join(", ")}.`), fb);
  ck("the answer typed is shown back", (await text(page, `[data-passage='${p.key}'] [data-passage-typed]`)) === TYPED);
  const model = await text(page, `[data-passage='${p.key}'] [data-passage-model]`);
  ck("followed by “A good answer: …”", model === `A good answer: ${p.answer}`, model);
  const lit = await page.$$eval(`[data-passage='${p.key}'] [data-phrase-highlight]`, (els) => els.map((e) => e.textContent));
  ck("the key phrases are highlighted in the passage", lit.length === p.phrases.length && p.phrases.every((ph) => lit.includes(ph.inText)), lit.join(", "));
  const kps = await page.$$eval(`[data-passage='${p.key}'] [data-key-phrase]`, (els) => els.map((e) => e.dataset.keyPhrase));
  ck("each phrase is listed with its own button", kps.length === p.phrases.length, kps.join(", "));
  const count = await text(page, "[data-podcast-count]");
  ck("the count moves on by one", count === `1 of ${EP1.questions.passages.length} passages answered`, count);
}

// ── Add to my cards ────────────────────────────────────────────────────────
console.log("\n  Add to my cards");
{
  const p1 = EP1.questions.passages[0];
  const ph = p1.phrases[0];
  const getsBefore = S.log.deckGets;
  const writesBefore = S.log.cardWrites.length;
  const addsBefore = S.log.api.filter((b) => b.action === "add-card").length;
  ck("a phrase not in the deck offers “Add to my cards”", (await text(page, `[data-key-phrase='${ph.fr}'] [data-add-to-cards]`)) === "Add to my cards");
  await page.click(`[data-passage='${p1.key}'] [data-key-phrase='${ph.fr}'] [data-add-to-cards]`);
  await page.waitForSelector(`[data-passage='${p1.key}'] [data-key-phrase='${ph.fr}'] [data-add-to-cards='added']`, { timeout: 8000 });
  await page.waitForTimeout(800);
  const adds = S.log.api.filter((b) => b.action === "add-card");
  ck("exactly one request adds it, through the server", adds.length - addsBefore === 1, `${adds.length - addsBefore}`);
  const sent = adds[adds.length - 1] || {};
  ck("with the phrase and its English", sent.front === ph.fr && sent.back === ph.en && sent.episodeId === "e1", JSON.stringify({ front: sent.front, back: sent.back }));
  ck("nothing is written to the cards from the browser", S.log.cardWrites.length === writesBefore, JSON.stringify(S.log.cardWrites.slice(writesBefore)));
  ck("and the deck is not fetched again", S.log.deckGets === getsBefore, `${S.log.deckGets - getsBefore} refetch(es)`);
  ck("the button says “Added ✓”", (await text(page, `[data-passage='${p1.key}'] [data-key-phrase='${ph.fr}'] [data-add-to-cards]`)) === "Added ✓");
}

// The second passage: by Ctrl+Enter, and its phrases include one already in
// the deck and one the student removed.
{
  const p = EP1.questions.passages[1];
  await page.fill(`[data-passage='${p.key}'] [data-passage-answer]`, "In the beginning the march went through town calmly, but the strike goes on");
  const marks = S.log.api.filter((b) => b.action === "mark").length;
  await page.focus(`[data-passage='${p.key}'] [data-passage-answer]`);
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(`[data-passage='${p.key}'] [data-passage-verdict]`, { timeout: 8000 });
  ck("Ctrl+Enter checks an answer too", S.log.api.filter((b) => b.action === "mark").length === marks + 1);
  const fb = await text(page, `[data-passage='${p.key}'] [data-passage-feedback]`);
  ck("a translation got says which words were got", fb.startsWith("Got it") && p.ideas.every((i) => fb.includes(i)), fb);
  const have = await text(page, `[data-passage='${p.key}'] [data-key-phrase='${haveRow.front}'] [data-add-to-cards]`);
  ck(`a phrase already in the deck (“${haveRow.front}”) says “In your deck”`, have === "In your deck", have);
  const gone = await text(page, `[data-passage='${p.key}'] [data-key-phrase='${REMOVED.front}'] [data-add-to-cards]`);
  ck("a card the student removed says so, and isn't offered again", gone === "You removed this card earlier", gone);
  const disabled = await page.$$eval(`[data-passage='${p.key}'] [data-add-to-cards='have'], [data-passage='${p.key}'] [data-add-to-cards='removed']`, (els) => els.every((b) => b.disabled));
  ck("neither can be pressed", disabled);
}

// The third: a failed marking keeps what was typed; then it goes through and
// the episode is finished.
{
  const p = EP1.questions.passages[2];
  const typed = await page.$eval(`[data-passage='${p.key}'] [data-passage-answer]`, (t) => t.value);
  S.state.failNextMark = true;
  await page.click(`[data-passage='${p.key}'] [data-passage-check]`);
  await page.waitForSelector(`[data-passage='${p.key}'] [data-passage-error]`, { timeout: 8000 });
  ck("a failed marking says why, in the server's words", (await text(page, `[data-passage='${p.key}'] [data-passage-error]`)) === "Claude is busy. Try again in a minute.");
  ck("and the answer stays in its box", (await page.$eval(`[data-passage='${p.key}'] [data-passage-answer]`, (t) => t.value)) === typed);
  await page.click(`[data-passage='${p.key}'] [data-passage-check]`);
  await page.waitForSelector(`[data-passage='${p.key}'] [data-passage-verdict]`, { timeout: 8000 });
  const fb = await text(page, `[data-passage='${p.key}'] [data-passage-feedback]`);
  ck("a gist missed says what the passage says", fb.startsWith("Missed") && fb.includes(`The passage says ${p.ideas.join(" and ")}.`), fb);

  await page.waitForSelector("[data-podcast-result]", { timeout: 8000 });
  const verdicts = EP1.questions.passages.map((x) => VERDICTS[x.key]);
  const got = verdicts.filter((x) => x === "got").length;
  const back = verdicts.length - got;
  const result = await text(page, "[data-podcast-result]");
  ck("once every passage is answered, the result says how many were understood", result.startsWith(`${got} of ${verdicts.length} passages understood`), result);
  const day = new Date(Date.now() + RETRY_DAYS * DAY).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const line = await text(page, "[data-come-back]");
  ck(`and when the ones not fully got come back (${RETRY_DAYS} days on)`, line === `The ${back} passages you didn’t fully get come back on ${day}.`, line);
  ck("the count above says the same", (await text(page, "[data-podcast-count]")) === `${got} of ${verdicts.length} passages understood`);
}

// ── The other tabs ─────────────────────────────────────────────────────────
console.log("\n  Words to learn and Transcript");
{
  await page.click("[data-podcast-tab='words']");
  await page.waitForSelector("[data-word]", { timeout: 5000 });
  const words = await page.$$eval("[data-word]", (els) => els.map((e) => e.dataset.word));
  const unique = [...new Set(EP1.questions.passages.flatMap((p) => p.phrases.map((x) => x.fr)))];
  ck("Words to learn lists every key phrase of the episode once", words.length === unique.length && unique.every((w) => words.includes(w)), words.join(", "));
  const added = await text(page, `[data-word='${EP1.questions.passages[0].phrases[0].fr}'] [data-add-to-cards]`);
  ck("a phrase added from Questions still says “Added ✓” here", added === "Added ✓", added);

  await page.click("[data-podcast-tab='transcript']");
  await page.waitForSelector("[data-transcript-section]", { timeout: 5000 });
  const secs = await page.$$eval("[data-transcript-section]", (els) => els.map((e) => e.querySelectorAll("p").length));
  ck("the transcript is cut into the episode's stories", secs.length === EP1.questions.storyStarts.length, `${secs.length} sections`);
  ck("with every paragraph in it", secs.reduce((a, b) => a + b, 0) === EP1.transcript.length, `${secs.reduce((a, b) => a + b, 0)} of ${EP1.transcript.length}`);
  const times = await page.$$eval("[data-transcript-section] [data-story-time]", (els) => els.map((e) => Number(e.dataset.storyTime)));
  ck("each story starts with its time", times.join(",") === EP1.stories.map((s) => s.t).join(","), times.join(", "));
  await page.click("[data-podcast-tab='questions']");
  await page.waitForSelector("[data-passage]", { timeout: 5000 });
}

// ── The tutor ──────────────────────────────────────────────────────────────
console.log("\n  the tutor, about a passage");
{
  // Opened from the sidebar, it knows the episode on screen.
  await page.click("aside [data-tutor-toggle]");
  await page.waitForSelector("[data-tutor-panel] [data-tutor-podcast]", { timeout: 8000 });
  const onEpisode = await page.$eval("[data-tutor-podcast]", (e) => e.dataset.tutorPodcast);
  ck("the tutor opened from the sidebar knows the episode on screen", onEpisode.startsWith("pod:e1:"), onEpisode);
  await page.click("aside [data-tutor-toggle]");
  await page.waitForFunction(() => !document.querySelector("[data-tutor-panel]"), null, { timeout: 8000 });

  const p = EP1.questions.passages[0];
  await page.click(`[data-passage='${p.key}'] [data-passage-ask]`);
  await page.waitForSelector("[data-tutor-panel]", { timeout: 8000 });
  const chip = await page.$eval("[data-tutor-podcast]", (e) => e.dataset.tutorPodcast).catch(() => null);
  ck("“Ask the tutor” opens the tutor about that passage", chip === `pod:e1:${p.key}`, String(chip));
  await page.fill("textarea[placeholder*='Ask about']", "Que veut dire manifester ?");
  await page.click("button:text-is('Send')");
  await page.waitForFunction(() => /means to protest/.test(document.body.innerText), null, { timeout: 8000 });
  const ctx = S.log.chat[S.log.chat.length - 1]?.context?.podcast || {};
  ck("the tutor is told the passage", ctx.passage?.fr === p.fr, JSON.stringify(ctx.passage || null).slice(0, 120));
  ck("and the episode", ctx.show === podcastBySlug(JEFF).name && ctx.date === "Tuesday 6 October", JSON.stringify({ show: ctx.show, date: ctx.date }));
  ck("and its transcript", typeof ctx.transcript === "string" && ctx.transcript.includes(EP1.transcript[3]), `${(ctx.transcript || "").length} characters`);
  await page.click("aside [data-tutor-toggle]");
  await page.waitForTimeout(600);
}

// ── Back to the list ───────────────────────────────────────────────────────
console.log("\n  back to Episodes");
{
  await page.click("[data-back]");
  await page.waitForSelector("[data-episode='e1']", { timeout: 8000 });
  const got = EP1.questions.passages.filter((x) => VERDICTS[x.key] === "got").length;
  const s1 = await text(page, "[data-episode='e1'] [data-episode-status]");
  ck("the Journal's row now says how many passages were understood", s1 === `${got} of ${EP1.questions.passages.length} passages understood`, s1);
  ck("and “To try again” has gone, nothing being due", !(await page.$("[data-try-again]")));
}

// ── An episode whose questions are still being written ─────────────────────
console.log("\n  the first open of an episode");
{
  await page.click("[data-episode='e2']");
  await page.waitForSelector("[data-podcasts-preparing]", { timeout: 8000 });
  ck("while Claude writes the questions, the page says so", (await text(page, "[data-podcasts-preparing]")) === "Writing the questions for this episode…");
  await page.waitForSelector("[data-episode-page='e2'] [data-passage]", { timeout: 15000 });
  const n = await page.$$eval("[data-passage]", (els) => els.length);
  ck("then they appear without a reload", n === EP2_QUESTIONS.passages.length, `${n} passages`);
  ck("the page asked again rather than giving up", S.state.e2Opens >= 2 && Date.now() - S.state.e2FirstAt >= PREPARING_MS, `${S.state.e2Opens} asks`);
  const h1 = await page.$eval("[data-episode-page] h1", (e) => [e.innerText.trim(), parseFloat(getComputedStyle(e).fontSize)]);
  ck("a podcast that isn't the Journal is headed by the episode's title", h1[0] === EP2.title, h1[0]);
  ck("in the smaller heading (24px)", h1[1] === 24, `${h1[1]}px`);
  const byline = await page.$eval("[data-episode-page] h1 + div", (e) => e.innerText.trim());
  ck("its byline is the podcast and the long date", byline === `${podcastBySlug(MOTS).name} · Monday 5 October`, byline);
}

// ── My podcasts and the Spotify box ────────────────────────────────────────
console.log("\n  My podcasts");
{
  await page.click("[data-pod-nav='mine']");
  await page.waitForSelector("[data-podcast-card]", { timeout: 8000 });
  const cards = await page.$$eval("[data-podcast-card]", (els) => els.map((e) => [e.dataset.podcastCard, e.querySelector("[data-podcast-done]")?.innerText.trim()]));
  const jeff = cards.find(([s]) => s === JEFF);
  const jeffEpisodes = [EP1, EP2].filter((e) => e.podcast === JEFF).length;
  ck("each podcast followed has a card saying how many episodes are done", cards.length === 2 && jeff && jeff[1] === `${jeffEpisodes} of ${jeffEpisodes} episodes done`, JSON.stringify(cards));
  await page.fill("[data-spotify-link]", "https://example.com/not-spotify");
  await page.click("[data-spotify-add]");
  await page.waitForSelector("[data-follow-error]", { timeout: 8000 });
  ck("a link that isn't Spotify is refused in plain words", (await text(page, "[data-follow-error]")) === "That doesn’t look like a Spotify link.");
  ck("and adds nothing", !(await page.$(`[data-pod-follow='${UMUH}']`)));
  await page.fill("[data-spotify-link]", "https://open.spotify.com/show/abc123?si=x");
  await page.click("[data-spotify-add]");
  await page.waitForSelector(`[data-pod-follow='${UMUH}']`, { timeout: 8000 });
  ck("a Spotify link to an RFI podcast adds it under My podcasts", true);
  await page.waitForFunction((slug) => document.querySelector("[data-podcasts-page]")?.dataset.podcastsPage === "podcast" && document.querySelector(`[data-podcast-episodes='${slug}']`), UMUH, { timeout: 8000 });
  ck("and opens its page", (await text(page, "[data-podcasts-page] h1")) === podcastBySlug(UMUH).name);
  const m = await marked(page);
  ck("which the sidebar marks", m.length === 1 && m[0] === UMUH, m.join(", "));
}

// ── And back to the cards ──────────────────────────────────────────────────
console.log("\n  back to Flashcards at the end");
{
  await toFlashcards(page);
  const card = (await cardBox(page))?.front;
  const counter = await sessionCounter(page);
  ck("the same card is still on screen after all of that", card === before.card, `${before.card} → ${card}`);
  ck("at the same place in the set", JSON.stringify(counter) === JSON.stringify(before.counter), `${JSON.stringify(before.counter)} → ${JSON.stringify(counter)}`);
  const patches = S.log.cardWrites.filter((w) => w.method === "PATCH");
  ck("no card's schedule was written while in Podcasts", patches.length === 0, `${patches.length} PATCH user_cards`);
  ck("nor any card written from the browser at all", S.log.cardWrites.length === 0, JSON.stringify(S.log.cardWrites).slice(0, 160));
  ck("the browser never writes a podcast table itself", S.log.podcastWrites.length === 0, JSON.stringify(S.log.podcastWrites));
  ck("no recording was downloaded by the tests", S.log.mp3 === 0, `${S.log.mp3}`);
  const stray = S.log.otherApi.filter((pth) => /podcast/i.test(pth));
  ck("every podcasts request was answered by the stand-in", stray.length === 0, stray.join(", "));
}
await browser.close();

// ═══ Before migration_017 ══════════════════════════════════════════════════
console.log("\n  before the owner runs migration_017");
{
  const W = standIns({ migrated: false });
  const { browser: b2, page: p2 } = await openApp({ app: ADMIN_APP, route: W.route });
  const card = (await cardBox(p2))?.front;
  await p2.click("[data-module='podcasts']");
  await p2.waitForSelector("[data-podcasts-missing]", { timeout: 8000 });
  const msg = await p2.$eval("[data-podcasts-missing]", (e) => e.innerText.trim());
  ck("Podcasts says plainly that a database update is waiting", msg === "Podcasts need a database update first: run migrations/migration_017_podcasts.sql in Supabase.", msg);
  await p2.click("[data-module='flashcards']");
  await p2.waitForSelector('button:has-text("Previous card")', { timeout: 8000 });
  ck("and Flashcards carries on as before", (await cardBox(p2))?.front === card);
  await b2.close();
}

ck("every podcast in the catalogue has a name and a byline", PODCASTS.every((p) => p.name && p.by));
await finish(null, ck);
