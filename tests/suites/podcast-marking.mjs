// The Podcasts module's server (api/_lib/podcasts.js, 2026-10-09): Claude
// writes an episode's passage questions once, for everyone; marks each answer
// for the student who wrote it; and "Add to my cards" makes a new card and
// never touches one the student has.
//
// The owner's requirements, in plain words:
//   - the questions are written once per episode: one Claude call, then none,
//     and a second request while the first is writing is told to wait (202),
//     never charged a second call;
//   - Claude's passages are checked, not trusted: one that isn't word for word
//     in the transcript is dropped; each passage's key comes from its own
//     French, so it stays the same if the questions are written again;
//   - the counts and the gist/translate mix the owner approved reach Claude,
//     and never more than MAX_PASSAGES are kept;
//   - a verdict is "Got it" only when every idea was caught; a passage not
//     fully understood comes back RETRY_DAYS later; an answer is saved for the
//     student who wrote it, and nobody else's answer is ever in a reply;
//   - a reply from Claude that can't be read saves nothing;
//   - no key, no call; anyone but the owner gets 403 and no call;
//   - "Add to my cards" inserts one new row (never an upsert over a card,
//     never a schedule), says "In your deck" for a card the student has,
//     leaves a card they removed removed, and adds nothing on a guess when
//     Claude's same-card question can't be answered;
//   - before migration_017 every action says the database needs its update.
//
// Claude is a stand-in on this machine (ANTHROPIC_BASE_URL), counted at the
// wire. RFI and Spotify are A1's synthetic fixtures (tests/fixtures/podcasts)
// served by a stub fetch; any other outgoing request fails the suite. The
// questions' own transcript below is short French written for this test. No
// browser, nothing leaves the machine.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { checker } from "../check.mjs";
import { fakeSupabase } from "../fake-supabase.mjs";

const ck = checker();

// ── Nothing leaves the machine ─────────────────────────────────────────
const outside = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input?.url || input);
  if (/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
  outside.push(url);
  return Promise.reject(new Error(`outgoing request refused in tests: ${url}`));
};

// ── The stand-in for Anthropic ─────────────────────────────────────────
// Every call is recorded. Which reply it gets depends on which of the three
// questions it is (writing questions, marking, same card), told apart by the
// system prompt. A reply is an object (sent as Claude's JSON), { text } (sent
// as it is), or { status, message? } (an API error, in Anthropic's shape,
// with a retry-after short enough that the SDK's one retry costs nothing).
let calls = [];
const replies = { questions: null, mark: null, sameCard: null };
let delayMs = 0;
const anthropic = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    const system = Array.isArray(parsed.system) ? parsed.system.map((b) => b.text).join("") : String(parsed.system || "");
    const kind = system === QUESTIONS_SYSTEM ? "questions" : system === MARK_SYSTEM ? "mark" : "sameCard";
    calls.push({ kind, body: parsed, headers: req.headers });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    let answer = replies[kind];
    if (typeof answer === "function") answer = answer(parsed);
    if (answer?.status) {
      res.writeHead(answer.status, { "content-type": "application/json", "retry-after-ms": "1" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: answer.status === 429 ? "rate_limit_error" : "api_error", message: answer.message || "stand-in failure" },
        request_id: "req_standin0000",
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: answer?.text ?? JSON.stringify(answer ?? {}) }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;

const {
  handlePodcastRequest, supabasePodcastStore, checkQuestions, passageKey, MESSAGES, LEASE_MS, MAX_TYPED, PAGE_RETRY_MS,
} = await import("../../api/_lib/podcasts.js");
const Q = await import("../../api/_lib/podcastQuestions.js");
const { QUESTIONS_SYSTEM, MARK_SYSTEM, QUESTIONS_MODEL, QUESTIONS_VERSION, MARK_MODEL, MARK_VERSION,
  STORY_PASSAGES, SHORT_PASSAGES, MIN_PASSAGES, GIST_SHARE, translateCount, readMark } = Q;
const { RETRY_DAYS, MAX_PASSAGES, PODCASTS, podcastBySlug } = await import("../../src/lib/podcastCatalogue.js");
const { normalizePassage } = await import("../../src/lib/podcastTiming.js");
const source = await import("../../api/_lib/podcastSource.js");
const { SAME_CARD_SYSTEM } = await import("../../api/_lib/sameCardQuestion.js");

// ── RFI and Spotify, from the fixtures ─────────────────────────────────
const fixture = (name) => readFileSync(new URL(`../fixtures/podcasts/${name}`, import.meta.url), "utf8");
const FEEDS = {
  "journal-en-francais-facile": fixture("feed-journal.xml"),
  "les-mots-de-l-info": fixture("feed-mots.xml"),
  "un-mot-une-histoire": fixture("feed-un-mot.xml"),
};
const OEMBED = {
  "4testEpisodeIdAbcdef12": fixture("oembed-episode.json"),
  "7testShowIdAbcdefghij1": fixture("oembed-show.json"),
  "9otherEpisodeIdAbcdef1": fixture("oembed-other.json"),
};
let pageFor = () => fixture("episode-journal.html");
const reads = [];
// The feeds that answer 503 for now: RFI's server, briefly down.
const feedsDown = new Set();
const stubFetch = async (url) => {
  const u = new URL(url);
  reads.push(url);
  if (u.hostname === "francaisfacile.rfi.fr") {
    const feed = PODCASTS.find((p) => p.feed === url);
    if (feed) return feedsDown.has(feed.slug) ? new Response("", { status: 503 }) : new Response(FEEDS[feed.slug], { status: 200 });
    const page = pageFor(url);
    return page?.status ? new Response("", { status: page.status }) : new Response(page, { status: 200 });
  }
  if (u.hostname === "open.spotify.com" && u.pathname === "/oembed") {
    const id = (/\/(?:episode|show)\/([A-Za-z0-9]+)/.exec(u.searchParams.get("url") || "") || [])[1];
    return OEMBED[id] ? new Response(OEMBED[id], { status: 200 }) : new Response("{}", { status: 404 });
  }
  outside.push(url);
  throw new Error(`outgoing request refused in tests: ${url}`);
};
const fetchText = (url) => source.fetchText(url, { fetchImpl: stubFetch });

// ── An episode written for this test ───────────────────────────────────
// Short synthetic French in RFI's shape: headlines, three stories, a sign-off,
// curly apostrophes in two paragraphs.
const PARAGRAPHS = [
  "Bonjour et bienvenue dans ce journal.",
  "Au sommaire : une grève à Rennes, du jazz à Marseille et un record de chaleur.",
  "À Rennes, les chauffeurs de bus sont en grève depuis lundi. Ils demandent de meilleurs salaires et des horaires moins difficiles.",
  "« On travaille tôt le matin et tard le soir, et nos salaires n’augmentent pas », explique un chauffeur.",
  "La mairie propose de reprendre les discussions vendredi.",
  "À Marseille, le festival de jazz a attiré plus de vingt mille spectateurs ce week-end. Les concerts gratuits sur le port ont eu beaucoup de succès.",
  "Une musicienne raconte qu’elle a joué devant la mer pour la première fois de sa vie.",
  "Il a fait trente degrés à Bordeaux hier, un record pour un mois d’octobre. Les météorologues s’inquiètent de ces chaleurs tardives.",
  "Les agriculteurs, eux, attendent la pluie avec impatience.",
  "C’est la fin de ce journal. Merci de votre écoute.",
];
const STORIES = [
  { t: 10, title: "Les titres" },
  { t: 60, title: "Grève des bus à Rennes" },
  { t: 200, title: "Un festival de jazz à Marseille" },
  { t: 330, title: "Record de chaleur en octobre" },
];
const STARTS = [1, 2, 5, 7];
const straight = (s) => s.replace(/’/g, "'");
const sentences = (p) => p.match(/[^.!?]+[.!?]+(?:\s*»[^.!?]*[.!?]+)?/g).map((s) => s.trim());

const passage = (story, kind, fr, extra = {}) => ({
  story, kind, fr,
  answer: `A good answer about: ${fr.slice(0, 30)}`,
  ideas: kind === "gist" ? ["that the first thing happened", "that the second thing happened"] : ["« un » (one)", "« deux » (two)", "« trois » (three)"],
  phrases: [{ fr: "une grève.", en: "a strike.", inText: "grève" }],
  ...extra,
});
// Six good passages (one listed out of order, one copied with straight
// apostrophes where RFI wrote curly ones), one paraphrase, one headline.
const GOOD = [
  passage(1, "gist", PARAGRAPHS[2], { phrases: [{ fr: "être en grève", en: "to be on strike", inText: "sont en grève" }, { fr: "un salaire", en: "a salary", inText: "salaires" }] }),
  passage(1, "translate", straight(PARAGRAPHS[3]), { phrases: [{ fr: "augmenter", en: "to go up", inText: "n'augmentent" }] }),
  passage(3, "gist", PARAGRAPHS[7]),
  passage(2, "gist", PARAGRAPHS[5]),
  passage(2, "translate", PARAGRAPHS[6]),
  passage(3, "translate", PARAGRAPHS[8]),
];
const PARAPHRASE = passage(1, "gist", "Les chauffeurs de bus de Rennes font grève pour gagner plus.");
const HEADLINE = passage(0, "gist", PARAGRAPHS[1]);
const goodReply = () => ({ storyStarts: STARTS, passages: [...GOOD, PARAPHRASE, HEADLINE] });

const OWNER = { id: "00000000-0000-4000-8000-0000000000a1", email: "owner@example.com" };
const OWNER_B = { id: "00000000-0000-4000-8000-0000000000b2", email: "owner2@example.com" };
const STUDENT = { id: "00000000-0000-4000-8000-0000000000c3", email: "student@example.com" };
const KEY = "sk-ant-test-server-key";
const NOW = Date.parse("2026-10-09T10:00:00Z");
const DAY = 86400000;
const clone = (x) => JSON.parse(JSON.stringify(x));

const episodeRow = (extra = {}) => ({
  id: randomUUID(), podcast: "journal-en-francais-facile", guid: randomUUID(), title: "Grève à Rennes / Jazz à Marseille / Chaleur",
  published_at: "2026-10-06T18:38:47.000Z", page_url: "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/20261006-test",
  audio_url: "https://audio.audiomeans.fr/pfx/test/journal_test.mp3", duration_seconds: 600,
  transcript: clone(PARAGRAPHS), stories: clone(STORIES), page_read_at: null, page_error: null,
  questions: null, questions_version: null, questions_model: null, questions_at: null, questions_error: null, questions_lease_until: null,
  ...extra,
});

// The same operations as supabasePodcastStore, on plain arrays, with the
// same rules: a lease only over no questions and no live lease; questions
// saved only over none; a feed read writes only the feed's columns; a card
// insert leaves a front already there as it is.
function memoryStore({ missing = false, answersMissing = false } = {}) {
  const db = { episodes: [], follows: [], answers: [], cards: [] };
  const log = [];
  const gone = () => ({ missing: true });
  return {
    db, log,
    async follows(userId) { log.push(["follows"]); return missing ? gone() : { rows: db.follows.filter((f) => f.user_id === userId).map(clone) }; },
    async follow({ userId, podcast, addedFrom }) {
      log.push(["follow", podcast]);
      if (missing) return gone();
      if (!db.follows.some((f) => f.user_id === userId && f.podcast === podcast)) {
        db.follows.push({ user_id: userId, podcast, added_from: addedFrom, followed_at: new Date(NOW).toISOString() });
      }
      return { ok: true };
    },
    async saveFeed(podcast, rows) {
      log.push(["saveFeed", podcast, clone(rows)]);
      if (missing) return gone();
      const out = [];
      for (const r of rows) {
        let ep = db.episodes.find((e) => e.podcast === r.podcast && e.guid === r.guid);
        if (ep) Object.assign(ep, clone(r));
        else { ep = episodeRow({ transcript: null, stories: [], ...clone(r), id: randomUUID() }); db.episodes.push(ep); }
        out.push({ id: ep.id, podcast: ep.podcast, guid: ep.guid });
      }
      return { rows: out };
    },
    async episode(id) { log.push(["episode", id]); if (missing) return gone(); const e = db.episodes.find((x) => x.id === id); return { row: e ? clone(e) : null }; },
    async savePage(id, patch) { log.push(["savePage", id]); Object.assign(db.episodes.find((e) => e.id === id), clone(patch)); return { ok: true }; },
    async takeLease(id, nowIso, untilIso) {
      log.push(["takeLease", id]);
      if (missing) return gone();
      const e = db.episodes.find((x) => x.id === id);
      if (!e || e.questions != null || (e.questions_lease_until != null && !(e.questions_lease_until < nowIso))) return { taken: false };
      e.questions_lease_until = untilIso;
      return { taken: true };
    },
    async saveQuestions(id, fields) {
      log.push(["saveQuestions", id]);
      const e = db.episodes.find((x) => x.id === id);
      if (e.questions != null) return { written: false };
      Object.assign(e, clone(fields), { questions_error: null, questions_lease_until: null });
      return { written: true };
    },
    async failQuestions(id, { error, at }) {
      log.push(["failQuestions", id]);
      const e = db.episodes.find((x) => x.id === id);
      if (e.questions == null) Object.assign(e, { questions_error: error, questions_lease_until: null, updated_at: at });
      return { ok: true };
    },
    async saveAnswer(row) {
      log.push(["saveAnswer"]);
      if (missing || answersMissing) return gone();
      const saved = { id: randomUUID(), created_at: new Date(NOW).toISOString(), ...clone(row) };
      db.answers.push(saved);
      const { id, passage_key, verdict, feedback, answered_at, due_at } = saved;
      return { row: clone({ id, passage_key, verdict, feedback, answered_at, due_at }) };
    },
    async deck(userId) { log.push(["deck"]); return { rows: db.cards.filter((c) => c.user_id === userId).map(clone), hasReasons: true }; },
    async addCards(rows) {
      log.push(["addCards", clone(rows)]);
      const added = [];
      for (const r of rows) {
        if (db.cards.some((c) => c.user_id === r.user_id && c.front === r.front)) continue;
        const card = { id: db.cards.length + 5000, created_at: new Date(NOW).toISOString(), fsrs_state: 0, en_fsrs_state: 0, archived_reason: null, ...clone(r) };
        db.cards.push(card);
        added.push(clone(card));
      }
      return { rows: added };
    },
  };
}

const run = (store, user, body, extra = {}) =>
  handlePodcastRequest({ body, user, isAdmin: user !== STUDENT, store, apiKey: KEY, now: NOW, fetchText, ...extra });
const withQuestions = async (store, extra = {}) => {
  const ep = episodeRow(extra);
  store.db.episodes.push(ep);
  replies.questions = goodReply();
  const r = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  return { ep: store.db.episodes.find((e) => e.id === ep.id), r };
};

// ── Writing the questions: once per episode ────────────────────────────
console.log("\n  an episode's questions are written once, for everyone");
let shared;
{
  const store = memoryStore();
  const ep = episodeRow();
  store.db.episodes.push(ep);
  calls = [];
  replies.questions = goodReply();
  const first = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  const q = calls.filter((c) => c.kind === "questions");
  ck("the first open makes exactly one call to Claude, to write the questions", first.status === 200 && calls.length === 1 && q.length === 1,
     `HTTP ${first.status}, ${calls.length} call(s) ${JSON.stringify(first.json).slice(0, 120)}`);
  const saved = store.db.episodes[0];
  ck("the set is saved on the episode with the model and the prompt version",
     !!saved.questions && saved.questions_model === QUESTIONS_MODEL && saved.questions_version === QUESTIONS_VERSION && /^[0-9a-f]{7}$/.test(QUESTIONS_VERSION),
     `${saved.questions_model} ${saved.questions_version}`);
  ck("and the lease is given back", saved.questions_lease_until === null, String(saved.questions_lease_until));
  calls = [];
  const second = await run(store, OWNER_B, { action: "episode", episodeId: ep.id });
  ck("a second person opening it makes no call", second.status === 200 && calls.length === 0, `HTTP ${second.status}, ${calls.length} call(s)`);
  ck("  and gets the same set", JSON.stringify(second.json.episode.questions) === JSON.stringify(first.json.episode.questions));
  ck("the page gets what it shows: transcript, stories, audio, length and questions",
     ["id", "podcast", "title", "published_at", "audio_url", "duration_seconds", "transcript", "stories", "questions"].every((k) => k in first.json.episode) &&
     first.json.episode.transcript.length === PARAGRAPHS.length, Object.keys(first.json.episode).join(","));
  shared = { store, ep: saved, set: first.json.episode.questions };

  // The house call: the right model, effort and structured output, with the
  // fallback, and no forced tool choice (a 400 on this model).
  const b = q[0].body;
  ck("the call is the house structured-output call: Opus 5.5, medium effort, a JSON schema, the fallback, no forced tool",
     b.model === QUESTIONS_MODEL && b.model === "claude-opus-5-5" && b.output_config?.effort === "medium" &&
     b.output_config?.format?.type === "json_schema" && b.fallbacks === "default" && !("tool_choice" in b) &&
     String(q[0].headers["anthropic-beta"] || "").includes("server-side-fallback-2026-07-01"),
     JSON.stringify({ model: b.model, effort: b.output_config?.effort, fallbacks: b.fallbacks, beta: q[0].headers["anthropic-beta"] }));
  const prompt = b.messages[0].content;
  ck("Claude reads the podcast, the episode, the stories with their start times and the numbered paragraphs",
     prompt.includes("Journal en français facile") && prompt.includes(ep.title) && prompt.includes("1:00 Grève des bus à Rennes") &&
     PARAGRAPHS.every((p, i) => prompt.includes(`[${i}] ${p}`)), prompt.slice(0, 160));
}

console.log("\n  the counts and the mix the owner approved reach Claude");
{
  // Read from the module's constants, never written out here.
  const sys = QUESTIONS_SYSTEM;
  ck("an episode with stories: the range of passages", sys.includes(`${STORY_PASSAGES.min} to ${STORY_PASSAGES.max} passages`),
     `${STORY_PASSAGES.min}–${STORY_PASSAGES.max}`);
  ck("an episode without stories: exactly the short number", sys.includes(`exactly ${SHORT_PASSAGES} passages`), String(SHORT_PASSAGES));
  ck("never more than the cap", sys.includes(`Never more than ${MAX_PASSAGES} passages`) && STORY_PASSAGES.max <= MAX_PASSAGES, String(MAX_PASSAGES));
  const n = 9;
  ck("about two-thirds gist, one-third translate, with the counts worked out from the share",
     sys.includes(`${n - translateCount(n)} gist, ${translateCount(n)} translate`) &&
     sys.includes(`${SHORT_PASSAGES - translateCount(SHORT_PASSAGES)} gist, ${translateCount(SHORT_PASSAGES)} translate`) &&
     [3, 8, 9, 10].every((k) => Math.abs(translateCount(k) - k * (1 - GIST_SHARE)) <= 0.5),
     `${n}: ${translateCount(n)} translate`);
  // The notes reader's card rule keeps "les" and "des" (api/parse-cahier.js,
  // rule 2), and the deck keeps a singular and a plural on cards of their own
  // (api/_lib/sameCardQuestion.js): "une vacance" (a vacancy) for "les
  // vacances" would be a wrong card, and a second one beside a student's own
  // "les dégâts".
  const phrasesRule = (sys.split("\n").find((l) => l.trim().startsWith('"fr": the card')) || "");
  ck("a word's noun is made singular, except a noun that lives in the plural, which keeps \"les\" (les vacances, les dégâts)",
     /singular/.test(phrasesRule) && ['"les vacances"', '"les dégâts"'].every((w) => phrasesRule.includes(w)) && /only or almost always in the plural/.test(phrasesRule),
     phrasesRule.slice(0, 200));
}

console.log("\n  Claude's passages are checked, not trusted");
{
  const { set } = shared;
  const frs = set.passages.map((p) => p.fr);
  ck("a passage that isn't word for word in the transcript is dropped", !frs.includes(PARAPHRASE.fr), frs.length + " kept");
  ck("a passage from the headlines is dropped", !frs.some((f) => normalizePassage(f) === normalizePassage(HEADLINE.fr)));
  ck("every good passage is kept", set.passages.length === GOOD.length, `${set.passages.length} of ${GOOD.length}`);
  ck("each is stored as RFI wrote it, curly apostrophes and all, though Claude copied straight ones",
     frs.includes(PARAGRAPHS[3]) && !frs.includes(straight(PARAGRAPHS[3])));
  const at = (fr) => PARAGRAPHS.findIndex((p) => p.includes(fr));
  ck("they come in the order of the episode", set.passages.every((p, i, a) => !i || at(a[i - 1].fr) <= at(p.fr)),
     set.passages.map((p) => at(p.fr)).join(" "));
  ck("each has a start and an end inside the episode, in order", set.passages.every((p, i, a) =>
     p.start >= 0 && p.end > p.start && p.end <= shared.ep.duration_seconds && (!i || a[i - 1].start <= p.start)),
     set.passages.map((p) => `${p.start}-${p.end}`).join(" "));
  ck("the stories keep where each begins in the transcript", JSON.stringify(shared.ep.stories.map((s) => s.p)) === JSON.stringify(STARTS),
     JSON.stringify(shared.ep.stories.map((s) => s.p)));
  const first = set.passages[0];
  ck("a word's highlight is found in its passage, and a card's French loses its final full stop",
     first.phrases.every((ph) => ph.inText && first.fr.includes(ph.inText)) && set.passages.every((p) => p.phrases.every((ph) => !/\.$/.test(ph.fr) && !/\.$/.test(ph.en))),
     JSON.stringify(first.phrases));
  const tidy = checkQuestions({ storyStarts: STARTS, passages: [passage(3, "gist", PARAGRAPHS[7], {
    ideas: ["It was thirty degrees in Bordeaux.", "That forecasters are worried"],
    phrases: [{ fr: "s’inquiéter (to worry).", en: "to worry.", inText: "s’inquiètent" }],
  })] }, { paragraphs: PARAGRAPHS, stories: STORIES, duration: 600 }).passages[0];
  ck("a gist idea always reads as a \"that\" clause, with no full stop, for the sentence it is shown in",
     JSON.stringify(tidy?.ideas) === JSON.stringify(["that It was thirty degrees in Bordeaux", "that forecasters are worried"]), JSON.stringify(tidy?.ideas));
  ck("a word's French is kept exactly as Add to my cards will write it: straight apostrophe, no gloss, no full stop",
     tidy?.phrases[0]?.fr === "s'inquiéter" && tidy?.phrases[0]?.en === "to worry" && tidy?.phrases[0]?.inText === "s’inquiètent", JSON.stringify(tidy?.phrases));
  ck("a highlight copied with a straight apostrophe is found as RFI wrote it",
     set.passages.find((p) => p.fr === PARAGRAPHS[3])?.phrases[0]?.inText === "n’augmentent",
     JSON.stringify(set.passages.find((p) => p.fr === PARAGRAPHS[3])?.phrases));
}

console.log("\n  each passage's key comes from its own French");
{
  const { set } = shared;
  ck("a key is the story and eight hex characters", set.passages.every((p) => /^s(\d+|x)-[0-9a-f]{8}$/.test(p.key)),
     set.passages.map((p) => p.key).join(" "));
  ck("and is the passage's own: the same story and French give the same key",
     set.passages.every((p) => p.key === passageKey(p.story, p.fr)));
  ck("whichever apostrophes the French is written with", passageKey(1, PARAGRAPHS[3]) === passageKey(1, straight(PARAGRAPHS[3])));
  ck("no two passages share one", new Set(set.passages.map((p) => p.key)).size === set.passages.length);
  // Written again (a new prompt version, say): the passages that are the same
  // keep their keys, so answers saved against them still match.
  const again = checkQuestions({ storyStarts: STARTS, passages: [...GOOD].reverse() }, { paragraphs: PARAGRAPHS, stories: STORIES, duration: 600 });
  ck("written again, the same passages have the same keys", JSON.stringify(again.passages.map((p) => p.key).sort()) === JSON.stringify(set.passages.map((p) => p.key).sort()));
  const solo = checkQuestions({ storyStarts: [], passages: [passage(null, "gist", PARAGRAPHS[2])] }, { paragraphs: PARAGRAPHS, stories: [], duration: 200 });
  ck("an episode without stories keys its passages with x", /^sx-/.test(solo.passages[0]?.key || ""), solo.passages[0]?.key);
}

console.log("\n  never more than the cap");
{
  // Every sentence and every paragraph of the three stories: more good
  // passages than the cap allows.
  const many = [];
  for (const [s, from, to] of [[1, 2, 5], [2, 5, 7], [3, 7, 9]]) {
    for (let i = from; i < to; i++) {
      const parts = sentences(PARAGRAPHS[i]);
      for (const fr of parts.length > 1 ? [...parts, PARAGRAPHS[i]] : [PARAGRAPHS[i]]) many.push(passage(s, many.length % 3 ? "gist" : "translate", fr));
    }
  }
  const capped = checkQuestions({ storyStarts: STARTS, passages: many }, { paragraphs: PARAGRAPHS, stories: STORIES, duration: 600 });
  ck("(Claude offered more good passages than the cap)", many.length > MAX_PASSAGES, `${many.length} > ${MAX_PASSAGES}`);
  ck("the set is cut to the cap", capped.passages.length === MAX_PASSAGES, String(capped.passages.length));
  ck("  and every story still has a passage", [1, 2, 3].every((s) => capped.passages.some((p) => p.story === s)),
     capped.passages.map((p) => p.story).join(" "));
}

console.log("\n  two people opening a new episode together pay once");
{
  const store = memoryStore();
  const ep = episodeRow();
  store.db.episodes.push(ep);
  calls = [];
  replies.questions = goodReply();
  delayMs = 300;
  const both = await Promise.all([OWNER, OWNER_B].map((u) => run(store, u, { action: "episode", episodeId: ep.id })));
  delayMs = 0;
  const statuses = both.map((r) => r.status).sort().join(",");
  ck("one writes the questions, the other is told they are being prepared (202)", statuses === "200,202" &&
     both.find((r) => r.status === 202)?.json?.status === "preparing", statuses);
  ck("  with one call to Claude between them", calls.length === 1, `${calls.length} call(s)`);
  calls = [];
  const later = await run(store, OWNER_B, { action: "episode", episodeId: ep.id });
  ck("asking again a moment later gets the set, with no call", later.status === 200 && !!later.json.episode.questions && calls.length === 0);

  const held = memoryStore();
  const ep2 = episodeRow({ questions_lease_until: new Date(NOW + 60000).toISOString() });
  held.db.episodes.push(ep2);
  calls = [];
  const wait = await run(held, OWNER, { action: "episode", episodeId: ep2.id });
  ck("while someone else holds the lease: 202, and no call", wait.status === 202 && calls.length === 0, `HTTP ${wait.status}, ${calls.length} call(s)`);
  held.db.episodes[0].questions_lease_until = new Date(NOW - 1000).toISOString();
  replies.questions = goodReply();
  const taken = await run(held, OWNER, { action: "episode", episodeId: ep2.id });
  ck("a lease that ran out (its request died) is taken over", taken.status === 200 && !!taken.json.episode.questions && calls.length === 1,
     `HTTP ${taken.status}, ${calls.length} call(s)`);
  ck("the lease lasts longer than Claude may take", LEASE_MS > Q.QUESTIONS_TIME_MS, `${LEASE_MS} > ${Q.QUESTIONS_TIME_MS}`);
}

console.log("\n  when Claude's questions can't be used, nothing is saved and the next open tries again");
{
  const store = memoryStore();
  const ep = episodeRow();
  store.db.episodes.push(ep);
  calls = [];
  replies.questions = { text: "Here are some questions: 1. What happened in Rennes?" };
  const r = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  const row = store.db.episodes[0];
  ck("a reply that isn't JSON: a plain error, no questions saved, the error kept, the lease given back",
     r.status === 502 && typeof r.json.error === "string" && !/stand-in|JSON|SyntaxError/.test(r.json.error) &&
     row.questions === null && !!row.questions_error && row.questions_lease_until === null, `HTTP ${r.status} ${r.json.error}`);
  replies.questions = { storyStarts: STARTS, passages: [PARAPHRASE, HEADLINE, GOOD[0]] };
  const few = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  ck(`fewer than ${MIN_PASSAGES} passages that check out: nothing saved either`, few.status === 502 && store.db.episodes[0].questions === null,
     `HTTP ${few.status} ${few.json.error}`);
  replies.questions = { status: 500 };
  const down = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  ck("Claude failing: a plain sentence, never the API's own message", down.status >= 500 && !/stand-in failure/.test(down.json.error || "") &&
     store.db.episodes[0].questions === null && store.db.episodes[0].questions_lease_until === null, `HTTP ${down.status} ${down.json.error}`);
  // podcast_episodes is readable by every signed-in student (migration_017),
  // so what is kept on the row about a failure must say nothing of the
  // owner's Anthropic account. The SDK's own message is Anthropic's raw reply.
  const ORG = "org-0000standin";
  replies.questions = { status: 429, message: `This request would exceed the rate limit for your organization (${ORG}) of 50 requests per minute.` };
  const busy = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  const why = store.db.episodes[0].questions_error;
  const leaks = (s) => [ORG, "rate limit", "stand-in failure", "req_standin", "\"type\""].filter((x) => String(s || "").includes(x));
  ck("what the episode keeps about a failure, which students can read, is a short reason, never Anthropic's own message",
     busy.status === 429 && !!why && leaks(why).length === 0 && why.length <= 40, `HTTP ${busy.status}, saved ${JSON.stringify(why)}`);
  ck("  and the page is told plainly too", leaks(busy.json.error).length === 0, busy.json.error);
  replies.questions = { status: 500 };
  await run(store, OWNER, { action: "episode", episodeId: ep.id });
  ck("  the same for any other failure", !!store.db.episodes[0].questions_error && leaks(store.db.episodes[0].questions_error).length === 0,
     JSON.stringify(store.db.episodes[0].questions_error));
  replies.questions = goodReply();
  calls = [];
  const retry = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  ck("the next open asks again and saves the set", retry.status === 200 && calls.length === 1 && !!store.db.episodes[0].questions && store.db.episodes[0].questions_error === null);
}

console.log("\n  the transcript is read once from RFI's page");
{
  const store = memoryStore();
  const ep = episodeRow({ transcript: null, stories: [] });
  store.db.episodes.push(ep);
  const page = source.parseEpisodePage(fixture("episode-journal.html"));
  // Claude copies three passages from the page's own paragraphs, one per story.
  const storyParas = page.paragraphs.map((p, i) => i).filter((i) => i > 5 && i < page.paragraphs.length - 1);
  replies.questions = (body) => ({
    storyStarts: page.stories.map((_, i) => [2, 6, 8, 10][i] ?? 10),
    passages: storyParas.slice(0, 4).map((i) => passage(null, "gist", page.paragraphs[i])),
  });
  reads.length = 0;
  calls = [];
  const r = await run(store, OWNER, { action: "episode", episodeId: ep.id });
  const row = store.db.episodes[0];
  ck("the page is read, its transcript and stories saved", r.status === 200 && JSON.stringify(row.transcript) === JSON.stringify(page.paragraphs) &&
     row.stories.length === page.stories.length && reads.some((u) => u === ep.page_url), `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
  reads.length = 0;
  await run(store, OWNER_B, { action: "episode", episodeId: ep.id });
  ck("  and never read again", reads.length === 0, reads.join(" "));

  const none = memoryStore();
  const ep2 = episodeRow({ transcript: null, stories: [] });
  none.db.episodes.push(ep2);
  pageFor = () => fixture("episode-no-transcript.html");
  calls = [];
  const empty = await run(none, OWNER, { action: "episode", episodeId: ep2.id });
  ck("a page with no transcript: 422 in plain words, and no call to Claude",
     empty.status === 422 && empty.json.code === "no_transcript" && empty.json.error === MESSAGES.noTranscript && calls.length === 0,
     `HTTP ${empty.status} ${empty.json.error}`);
  reads.length = 0;
  const soon = await run(none, OWNER, { action: "episode", episodeId: ep2.id }, { now: NOW + PAGE_RETRY_MS / 2 });
  ck("  RFI isn't asked again straight away", soon.status === 422 && reads.length === 0);
  await run(none, OWNER, { action: "episode", episodeId: ep2.id }, { now: NOW + PAGE_RETRY_MS + 1000 });
  ck("  but is a while later, in case the transcript has come", reads.length === 1, String(reads.length));
  pageFor = () => ({ status: 503 });
  const down = memoryStore();
  const ep3 = episodeRow({ transcript: null, stories: [] });
  down.db.episodes.push(ep3);
  calls = [];
  const r503 = await run(down, OWNER, { action: "episode", episodeId: ep3.id });
  ck("RFI not answering: a plain sentence, nothing saved, no call to Claude",
     r503.status === 502 && /RFI/.test(r503.json.error) && !/fetch|https?:/.test(r503.json.error) && down.db.episodes[0].transcript === null && calls.length === 0,
     `HTTP ${r503.status} ${r503.json.error}`);
  pageFor = () => fixture("episode-journal.html");
}

// ── Marking ────────────────────────────────────────────────────────────
const marked = (verdict, caught, missed, note = "") => ({ verdict, caught, missed, note });
console.log("\n  marking an answer");
{
  const { store, set, ep } = shared;
  const p = set.passages.find((x) => x.kind === "gist" && x.ideas.length >= 2);
  calls = [];
  replies.mark = marked("got", [1, 2], []);
  const got = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "  The bus drivers in Rennes are on strike.  ", timeZone: "Europe/Paris" });
  ck("one call to Claude, the marking one: Opus 5.5 at low effort, a JSON schema, the fallback, no forced tool",
     calls.length === 1 && calls[0].kind === "mark" && calls[0].body.model === MARK_MODEL && calls[0].body.output_config?.effort === "low" &&
     calls[0].body.output_config?.format?.type === "json_schema" && calls[0].body.fallbacks === "default" && !("tool_choice" in calls[0].body),
     JSON.stringify({ n: calls.length, model: calls[0]?.body.model, effort: calls[0]?.body.output_config?.effort }));
  ck("the fixed instructions come first, marked for the cache; the passage and the answer come after",
     Array.isArray(calls[0].body.system) && calls[0].body.system[0].cache_control?.type === "ephemeral" &&
     calls[0].body.messages[0].content.includes(p.fr) && calls[0].body.messages[0].content.includes("<answer>\nThe bus drivers in Rennes are on strike.\n</answer>"));
  ck("every idea caught is \"got\"", got.status === 200 && got.json.answer.verdict === "got", JSON.stringify(got.json).slice(0, 160));
  ck("  and never comes back", got.json.answer.due_at === null);
  const saved = store.db.answers.at(-1);
  ck("the answer is saved, trimmed, for the student who wrote it, with the passage, the model and the prompt version",
     got.json.saved === true && saved.user_id === OWNER.id && saved.episode_id === ep.id && saved.passage_key === p.key && saved.kind === p.kind &&
     saved.fr === p.fr && saved.typed === "The bus drivers in Rennes are on strike." && saved.model === MARK_MODEL && saved.prompt_version === MARK_VERSION &&
     /^[0-9a-f]{7}$/.test(MARK_VERSION) && saved.time_zone === "Europe/Paris" && got.json.answer.id === saved.id,
     JSON.stringify(saved).slice(0, 200));

  replies.mark = marked("partly", [1], [2], "« grève » means “strike”, not “bus”.");
  const partly = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "Something about Rennes." });
  ck("some ideas caught is \"partly\", with what was caught and what was missed, by their words",
     partly.json.answer.verdict === "partly" && JSON.stringify(partly.json.answer.feedback.caught) === JSON.stringify([p.ideas[0]]) &&
     JSON.stringify(partly.json.answer.feedback.missed) === JSON.stringify(p.ideas.slice(1)) && /grève/.test(partly.json.answer.feedback.note),
     JSON.stringify(partly.json.answer.feedback));
  ck(`  and comes back ${RETRY_DAYS} days later`, partly.json.answer.due_at === new Date(NOW + RETRY_DAYS * DAY).toISOString() &&
     store.db.answers.at(-1).due_at === partly.json.answer.due_at, partly.json.answer.due_at);
  replies.mark = marked("missed", [], [1, 2]);
  const missed = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "No idea." });
  ck("no idea caught is \"missed\", and comes back too", missed.json.answer.verdict === "missed" && missed.json.answer.feedback.caught.length === 0 &&
     missed.json.answer.due_at === new Date(NOW + RETRY_DAYS * DAY).toISOString());
}

console.log("\n  Claude's idea numbers are checked");
{
  const ideas = ["that A", "that B", "that C"];
  const r1 = readMark(marked("got", [1, 2, 7, 0, -1], []), ideas);
  ck("a number outside the ideas is ignored, and an idea in neither list is missed: \"got\" with one missing becomes \"partly\"",
     r1.verdict === "partly" && JSON.stringify(r1.caught) === JSON.stringify(["that A", "that B"]) && JSON.stringify(r1.missed) === JSON.stringify(["that C"]),
     JSON.stringify(r1));
  const r2 = readMark(marked("got", [1, 2, 3], [2]), ideas);
  ck("an idea in both lists counts as missed: a wrong meaning is a miss", JSON.stringify(r2.missed) === JSON.stringify(["that B"]) && r2.verdict === "partly",
     JSON.stringify(r2));
  ck("every idea appears exactly once across the two lists",
     [r1, r2].every((r) => [...r.caught, ...r.missed].sort().join("|") === [...ideas].sort().join("|")));
  const r3 = readMark(marked("missed", [1, 2, 3, 3], []), ideas);
  ck("every idea caught is \"got\", whatever Claude's own word", r3.verdict === "got" && r3.caught.length === 3, JSON.stringify(r3));
  ck("a reply without the lists can't be read", readMark({ verdict: "got" }, ideas) === null && readMark("got", ideas) === null);
  const { store, set, ep } = shared;
  const p = set.passages[0];
  replies.mark = marked("partly", [1], [2], p.answer);
  const r = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "Something." });
  ck("a note that only repeats the good answer is left out", r.json.answer.feedback.note === "", r.json.answer.feedback.note);
}

console.log("\n  each student's answers are their own");
{
  const { store, set, ep } = shared;
  const p = set.passages[1];
  replies.mark = marked("partly", [1], [2, 3]);
  const a = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "Owner A's own words about the drivers." });
  const b = await run(store, OWNER_B, { action: "mark", episodeId: ep.id, key: p.key, typed: "B's answer.", user_id: OWNER.id });
  const rowB = store.db.answers.find((x) => x.id === b.json.answer.id);
  ck("an answer is saved under the student who sent it, even when the body names someone else", rowB?.user_id === OWNER_B.id, rowB?.user_id);
  ck("B's reply holds B's answer only: nothing of A's", !JSON.stringify(b.json).includes("Owner A's own words") && b.json.answer.id !== a.json.answer.id);
  ck("A's saved answer is untouched by B's", store.db.answers.find((x) => x.id === a.json.answer.id)?.typed === "Owner A's own words about the drivers.");
}

console.log("\n  what marking refuses, and a reply it can't read");
{
  const { store, set, ep } = shared;
  const p = set.passages[0];
  const before = store.db.answers.length;
  calls = [];
  const empty = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "   " });
  const long = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "x".repeat(MAX_TYPED + 1) });
  const unknown = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: "s9-00000000", typed: "An answer." });
  ck("an empty answer, one too long, and an unknown passage are refused, with no call",
     empty.status === 400 && long.status === 400 && unknown.status === 404 && calls.length === 0,
     `${empty.status} ${long.status} ${unknown.status}, ${calls.length} call(s)`);
  ck(`  ${MAX_TYPED} characters is still allowed`, (await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "y".repeat(MAX_TYPED) }, { apiKey: null })).status === 402);
  replies.mark = { text: "Got it, well done!" };
  const prose = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "An answer." });
  replies.mark = { verdict: "got", note: "" };
  const noLists = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "An answer." });
  ck("a reply that can't be read: a plain error, and nothing saved",
     prose.status === 502 && noLists.status === 502 && store.db.answers.length === before && !/JSON|SyntaxError/.test(prose.json.error),
     `${prose.status} ${noLists.status}: ${prose.json.error}`);

  const noTable = memoryStore({ answersMissing: true });
  noTable.db.episodes.push(clone(ep));
  replies.mark = marked("got", p.ideas.map((_, i) => i + 1), []);
  const unsaved = await run(noTable, OWNER, { action: "mark", episodeId: ep.id, key: p.key, typed: "An answer." });
  ck("an answer that can't be saved still gets its verdict, saying it wasn't saved",
     unsaved.status === 200 && unsaved.json.answer.verdict === "got" && unsaved.json.saved === false, JSON.stringify(unsaved.json).slice(0, 120));
}

console.log("\n  no key, no call");
{
  const { store, set, ep } = shared;
  calls = [];
  const m = await run(store, OWNER, { action: "mark", episodeId: ep.id, key: set.passages[0].key, typed: "An answer." }, { apiKey: null });
  ck("marking with no key: 402 asking for one, and no call", m.status === 402 && m.json.code === "byok_required" && calls.length === 0, `HTTP ${m.status} ${m.json.code}`);
  const fresh = memoryStore();
  const ep2 = episodeRow();
  fresh.db.episodes.push(ep2);
  const e = await run(fresh, OWNER, { action: "episode", episodeId: ep2.id }, { apiKey: null });
  ck("new questions with no key: 402, no call, and no lease held", e.status === 402 && calls.length === 0 && fresh.db.episodes[0].questions_lease_until === null,
     `HTTP ${e.status}, ${calls.length} call(s)`);
  const bad = await run(fresh, OWNER, { action: "episode", episodeId: ep2.id },
    { apiKey: () => ({ error: "That doesn't look like an Anthropic API key.", code: "bad_key", status: 400 }) });
  ck("a key of the wrong shape: refused as the route refuses it, and no call", bad.status === 400 && bad.json.code === "bad_key" && calls.length === 0);
  const opened = await run(store, OWNER, { action: "episode", episodeId: ep.id }, { apiKey: null });
  ck("an episode whose questions exist opens with no key at all", opened.status === 200 && !!opened.json.episode.questions && calls.length === 0);
}

console.log("\n  the owner only");
{
  const store = memoryStore();
  const ep = episodeRow();
  store.db.episodes.push(ep);
  calls = [];
  const bodies = [
    { action: "follow", link: "https://open.spotify.com/episode/4testEpisodeIdAbcdef12" },
    { action: "refresh" },
    { action: "episode", episodeId: ep.id },
    { action: "mark", episodeId: ep.id, key: "s1-00000000", typed: "An answer." },
    { action: "add-card", episodeId: ep.id, front: "une grève", back: "a strike" },
  ];
  const out = [];
  reads.length = 0;
  for (const body of bodies) out.push(await run(store, STUDENT, body));
  ck("every action answers 403 \"Admin only\" to anyone else", out.every((r) => r.status === 403 && r.json.error === "Admin only"),
     out.map((r) => r.status).join(","));
  ck("  with no call to Claude, nothing fetched from RFI or Spotify, and nothing read or written", calls.length === 0 && reads.length === 0 && store.log.length === 0,
     `${calls.length} call(s), ${reads.length} fetch(es), ${store.log.length} store operation(s)`);
  ck("an unknown action is refused", (await run(store, OWNER, { action: "delete-everything" })).status === 400);
}

// ── Following and the feeds ────────────────────────────────────────────
console.log("\n  following a podcast from a Spotify link");
{
  const store = memoryStore();
  calls = [];
  const oembed = JSON.parse(OEMBED["4testEpisodeIdAbcdef12"]);
  const want = Object.entries(FEEDS).flatMap(([slug, xml]) => source.parseFeed(xml).items.map((it) => ({ slug, it })))
    .find(({ it }) => source.normalizeTitle(it.title) === source.normalizeTitle(oembed.title));
  const r = await run(store, OWNER, { action: "follow", link: "https://open.spotify.com/intl-fr/episode/4testEpisodeIdAbcdef12?si=abc123" });
  const ep = store.db.episodes.find((e) => e.id === r.json.episodeId);
  ck("an episode link follows its podcast and names the episode", r.status === 200 && r.json.podcast === want?.slug && ep?.guid === want?.it.guid,
     JSON.stringify(r.json));
  ck("  the follow is saved, with the link as pasted", store.db.follows.some((f) => f.user_id === OWNER.id && f.podcast === want.slug && /4testEpisodeIdAbcdef12/.test(f.added_from)));
  ck("  the podcast's episodes are saved from its feed", store.db.episodes.filter((e) => e.podcast === want.slug).length === source.parseFeed(FEEDS[want.slug]).items.length);
  ck("  and Claude is never asked", calls.length === 0);

  const showTitle = JSON.parse(OEMBED["7testShowIdAbcdefghij1"]).title;
  const showSlug = Object.entries(FEEDS).find(([, xml]) => source.parseFeed(xml).items.some((it) => source.normalizeTitle(it.title) === source.normalizeTitle(showTitle)))?.[0];
  const show = await run(store, OWNER, { action: "follow", link: "spotify:show:7testShowIdAbcdefghij1" });
  ck("a show link follows the podcast whose latest episode Spotify names, with no episode", show.status === 200 && show.json.podcast === showSlug && !("episodeId" in show.json),
     JSON.stringify(show.json));
  const other = await run(store, OWNER, { action: "follow", link: "https://open.spotify.com/episode/9otherEpisodeIdAbcdef1" });
  ck("a podcast that isn't RFI's learner podcasts: 404 in the owner's words", other.status === 404 && other.json.error === MESSAGES.notRfi && other.json.code === "not_rfi",
     `HTTP ${other.status} ${other.json.error}`);
  const lost = await run(store, OWNER, { action: "follow", link: "https://open.spotify.com/episode/0unknownEpisodeIdAbc12" });
  ck("a Spotify link to nothing: 404 in plain words", lost.status === 404 && !/oembed|https?:|fetch/i.test(lost.json.error),
     `HTTP ${lost.status} ${lost.json.error}`);
  const before = store.db.follows.length;
  reads.length = 0;
  const junk = await run(store, OWNER, { action: "follow", link: "https://example.com/podcast/123" });
  ck("a link that isn't Spotify's: 400 \"That doesn’t look like a Spotify link.\", and nothing fetched or followed",
     junk.status === 400 && junk.json.error === MESSAGES.badLink && store.db.follows.length === before && reads.length === 0 && outside.length === 0,
     `HTTP ${junk.status} ${junk.json.error}, ${reads.length} fetch(es)`);
  const bySlug = await run(store, OWNER, { action: "follow", slug: "un-mot-une-histoire" });
  ck("a catalogue podcast can be followed by its name", bySlug.status === 200 && bySlug.json.podcast === "un-mot-une-histoire" && !!podcastBySlug("un-mot-une-histoire"));

  // RFI's feed for the link's own podcast down for a moment: the link is
  // fine, so the owner must not be told it isn't one of RFI's podcasts.
  const link = "https://open.spotify.com/episode/4testEpisodeIdAbcdef12";
  const fresh = memoryStore();
  feedsDown.add(want.slug);
  const down = await run(fresh, OWNER, { action: "follow", link });
  feedsDown.clear();
  ck("its podcast's feed not answering: \"Couldn’t reach RFI just now\", not \"Only RFI’s learner podcasts…\", and nothing followed",
     down.status === 502 && down.json.code === "rfi_unreachable" && down.json.error === MESSAGES.rfiDown && fresh.db.follows.length === 0,
     `HTTP ${down.status} ${down.json.error}`);
  const others = PODCASTS.map((p) => p.slug).filter((s) => s !== want.slug);
  for (const s of others) feedsDown.add(s);
  const up = await run(fresh, OWNER, { action: "follow", link });
  feedsDown.clear();
  ck("  the other podcasts' feeds not answering doesn't stop it: its own feed finds it", up.status === 200 && up.json.podcast === want.slug && !!up.json.episodeId,
     `HTTP ${up.status} ${JSON.stringify(up.json)}`);
  feedsDown.add(others[0]);
  const notRfiYet = await run(fresh, OWNER, { action: "follow", link: "https://open.spotify.com/episode/9otherEpisodeIdAbcdef1" });
  feedsDown.clear();
  ck("  with a feed unread, even a podcast from elsewhere isn't called \"not RFI's\" until every feed has been read",
     notRfiYet.status === 502 && notRfiYet.json.code === "rfi_unreachable", `HTTP ${notRfiYet.status} ${notRfiYet.json.error}`);
}

console.log("\n  reading the feeds again never blanks an episode");
{
  const store = memoryStore();
  const slug = "journal-en-francais-facile";
  store.db.follows.push({ user_id: OWNER.id, podcast: slug });
  const items = source.parseFeed(FEEDS[slug]).items;
  const kept = episodeRow({ podcast: slug, guid: items[0].guid, questions: { passages: [{ key: "s1-12345678" }], storyStarts: [] } });
  store.db.episodes.push(kept);
  const r = await run(store, OWNER, { action: "refresh" });
  const after = store.db.episodes.find((e) => e.id === kept.id);
  ck("refresh reads the followed podcasts' feeds and counts the episodes", r.status === 200 && r.json.ok === true && r.json.count === items.length,
     JSON.stringify(r.json));
  ck("an episode already opened keeps its transcript, stories and questions", JSON.stringify(after.transcript) === JSON.stringify(PARAGRAPHS) &&
     after.stories.length === STORIES.length && after.questions?.passages?.[0]?.key === "s1-12345678");
  const payload = store.log.filter((l) => l[0] === "saveFeed").flatMap((l) => l[2]);
  ck("  the feed writes carry the feed's columns only",
     payload.length > 0 && payload.every((row) => !["transcript", "stories", "questions", "questions_lease_until"].some((k) => k in row)),
     Object.keys(payload[0] || {}).join(","));
}

// ── Add to my cards ────────────────────────────────────────────────────
// Against the real store on the in-memory Supabase stand-in, with every write
// recorded, so "never an upsert over a card" is checked where it is written.
const EP_ID = randomUUID();
function cardsDb(cards = []) {
  const inner = fakeSupabase({
    tables: {
      user_cards: cards.map((c, i) => ({ id: 100 + i, user_id: OWNER.id, category: "V", dates: [], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0, created_at: "2026-09-01T10:00:00Z", archived_reason: null, ...c })),
      podcast_episodes: [{ ...episodeRow({ id: EP_ID }) }],
      podcast_follows: [], podcast_answers: [],
    },
  });
  const writes = [];
  const db = {
    tables: inner.tables,
    rpc: inner.rpc,
    from(name) {
      const b = inner.from(name);
      for (const op of ["insert", "upsert", "update", "delete"]) {
        const real = b[op];
        b[op] = (payload, opts) => { writes.push({ table: name, op, payload: clone(payload ?? null), opts: opts || {} }); return real(payload, opts); };
      }
      return b;
    },
  };
  return { db, writes, store: supabasePodcastStore(db) };
}
const add = (store, front, back, extra = {}) => run(store, OWNER, { action: "add-card", episodeId: EP_ID, front, back }, extra);
const FSRS_COLUMNS = ["fsrs_state", "en_fsrs_state", "next_due_at", "en_next_due_at", "stability", "en_stability", "difficulty", "en_difficulty",
  "reps", "en_reps", "lapses", "en_lapses", "last_review", "en_last_review", "last_answer_correct", "en_last_answer_correct"];

console.log("\n  Add to my cards: a new word");
{
  const { db, writes, store } = cardsDb([{ front: "un vélo", back: "a bike" }]);
  calls = [];
  const r = await add(store, "  les dégâts.  ", "the damage.");
  const cardWrites = writes.filter((w) => w.table === "user_cards");
  ck("exactly one write to the deck", cardWrites.length === 1, JSON.stringify(cardWrites.map((w) => w.op)));
  const w = cardWrites[0];
  ck("  an insert that leaves any card already there as it is (ignoreDuplicates), never a plain upsert or an update",
     w?.op === "upsert" && w.opts.ignoreDuplicates === true && w.opts.onConflict === "user_id,front" && !writes.some((x) => x.op === "update" || x.op === "delete"),
     JSON.stringify(w?.opts));
  const row = w?.payload?.[0] || {};
  ck("  the row: this student, the French without its full stop, the English, an ordinary card, no class dates, from this episode",
     w?.payload?.length === 1 && row.user_id === OWNER.id && row.front === "les dégâts" && row.back === "the damage" && row.category === "V" &&
     Array.isArray(row.dates) && row.dates.length === 0 && row.source === `podcast:${EP_ID}`, JSON.stringify(row));
  ck("  and no schedule column at all: the card starts New", !FSRS_COLUMNS.some((k) => k in row), Object.keys(row).join(","));
  ck("the reply hands back the new row for the deck, and nothing else", r.status === 200 && r.json.added.length === 1 && r.json.added[0].front === "les dégâts" &&
     r.json.added[0].id != null && r.json.have.length === 0 && r.json.removed === false && r.json.waiting === false, JSON.stringify(r.json).slice(0, 200));
  ck("the card already in the deck is untouched", JSON.stringify(db.tables.user_cards.find((c) => c.front === "un vélo")) ===
     JSON.stringify({ id: 100, user_id: OWNER.id, category: "V", dates: [], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0, created_at: "2026-09-01T10:00:00Z", archived_reason: null, front: "un vélo", back: "a bike" }));
  ck("no question for Claude, so no call", calls.length === 0, `${calls.length} call(s)`);
  const curly = await add(store, "s’inquiéter", "to worry");
  ck("curly apostrophes become straight, as the notes cards have them", curly.json.added[0]?.front === "s'inquiéter", curly.json.added[0]?.front);
  const glossed = await add(store, "une mairie (town hall)", "a town hall");
  ck("an English gloss in brackets comes off the French, as the notes reader does it", glossed.json.added[0]?.front === "une mairie", glossed.json.added[0]?.front);
}

console.log("\n  Add to my cards: a word the student has");
{
  const deck = [
    { front: "une grève", back: "a strike", fsrs_state: 2, reps: 4, stability: 12.5, next_due_at: "2026-10-20T00:00:00Z" },
    { front: "un salaire", back: "a salary", source: "archived:cahier-upload", archived_reason: "removed" },
    { front: "un horaire", back: "a timetable", source: "archived:cahier-upload", archived_reason: "replaced" },
  ];
  const { db, writes, store } = cardsDb(deck);
  const before = clone(db.tables.user_cards);
  const have = await add(store, "une grève", "a strike");
  ck("a card in the deck: \"In your deck\", and nothing written", have.json.have.length === 1 && have.json.have[0].inStudy === true &&
     have.json.added.length === 0 && have.json.removed === false && writes.filter((w) => w.table === "user_cards").length === 0, JSON.stringify(have.json));
  const removed = await add(store, "un salaire", "a salary");
  ck("a card the student removed: \"You removed this card earlier\", and it stays removed", removed.json.removed === true && removed.json.added.length === 0 &&
     writes.filter((w) => w.table === "user_cards").length === 0, JSON.stringify(removed.json));
  const out = await add(store, "un horaire", "a timetable");
  ck("a card out of study for another reason is one they have, said so, and not brought back",
     out.json.have[0]?.inStudy === false && out.json.have[0]?.reason === "replaced" && out.json.added.length === 0, JSON.stringify(out.json));
  ck("nothing about any of those cards changed: text, schedule, whether it is in study", JSON.stringify(db.tables.user_cards) === JSON.stringify(before));
}

console.log("\n  Add to my cards: a look-alike, and Claude's same-card question");
{
  // "le cortège" (the procession) beside a new "un cortège" (a protest
  // march): the sure rule can't settle it, so Claude is asked.
  const deck = [{ front: "le cortège", back: "the procession" }];
  const failing = cardsDb(deck);
  calls = [];
  replies.sameCard = { status: 500 };
  const down = await add(failing.store, "un cortège", "a protest march");
  ck("Claude's question failing: nothing is added on a guess, and the page is told to try again",
     down.status === 200 && down.json.waiting === true && down.json.added.length === 0 && failing.writes.filter((w) => w.table === "user_cards").length === 0 &&
     calls.some((c) => c.kind === "sameCard"), JSON.stringify(down.json));
  const injected = await add(failing.store, "un cortège", "a protest march", { ask: async () => { throw new Error("down"); } });
  ck("  the same when the question is passed in and throws", injected.json.waiting === true && failing.writes.filter((w) => w.table === "user_cards").length === 0);
  const unanswered = await add(failing.store, "un cortège", "a protest march", { ask: async (pairs) => pairs.map(() => null) });
  ck("  and when Claude gives no clear answer", unanswered.json.waiting === true);
  calls = [];
  const noKey = await add(failing.store, "un cortège", "a protest march", { apiKey: null });
  ck("  with no key: no call, the card waits, and the reply says a key is needed",
     noKey.json.waiting === true && noKey.json.code === "byok_required" && calls.length === 0, JSON.stringify(noKey.json));

  const same = cardsDb(deck);
  replies.sameCard = { verdicts: [{ pair: 1, verdict: "same" }] };
  calls = [];
  const s = await add(same.store, "un cortège", "a protest march");
  ck("Claude calls it the same card: \"In your deck\", nothing added", s.json.have.length === 1 && s.json.added.length === 0 &&
     same.writes.filter((w) => w.table === "user_cards").length === 0 && calls.filter((c) => c.kind === "sameCard").length === 1, JSON.stringify(s.json));
  ck("  asked with the house same-card question", calls[0]?.body.system === SAME_CARD_SYSTEM);
  const diff = cardsDb(deck);
  replies.sameCard = { verdicts: [{ pair: 1, verdict: "different" }] };
  const d = await add(diff.store, "un cortège", "a protest march");
  ck("Claude calls it different: the new card is added, once", d.json.added.length === 1 && d.json.added[0].front === "un cortège" &&
     diff.writes.filter((w) => w.table === "user_cards").length === 1, JSON.stringify(d.json).slice(0, 160));
}

console.log("\n  Add to my cards: what it refuses");
{
  const { writes, store } = cardsDb();
  const blank = await add(store, "  ", "a strike");
  const noBack = await add(store, "une grève", "");
  const unknown = await run(store, OWNER, { action: "add-card", episodeId: randomUUID(), front: "une grève", back: "a strike" });
  ck("a card with no French or no English, or for an episode that doesn't exist, is refused and nothing written",
     blank.status === 400 && noBack.status === 400 && unknown.status === 404 && writes.filter((w) => w.table === "user_cards").length === 0,
     `${blank.status} ${noBack.status} ${unknown.status}`);
}

// ── Before migration_017 ───────────────────────────────────────────────
console.log("\n  before the database update");
{
  const store = memoryStore({ missing: true });
  calls = [];
  const out = [];
  for (const body of [
    { action: "follow", slug: "journal-en-francais-facile" },
    { action: "refresh" },
    { action: "episode", episodeId: randomUUID() },
    { action: "mark", episodeId: randomUUID(), key: "s1-00000000", typed: "An answer." },
    { action: "add-card", episodeId: randomUUID(), front: "une grève", back: "a strike" },
  ]) out.push(await run(store, OWNER, body));
  ck("every action says the database needs migration_017, in plain words", out.every((r) => r.status === 503 && r.json.code === "not_set_up" && r.json.error === MESSAGES.notSetUp),
     out.map((r) => `${r.status} ${r.json.code}`).join(", "));
  ck("  and nothing reaches Claude", calls.length === 0);

  // The real store, on a database with no podcast tables.
  const gone = { code: "PGRST205", message: "Could not find the table in the schema cache" };
  const inner = fakeSupabase({});
  const noTables = {
    rpc: inner.rpc,
    from(name) {
      if (!name.startsWith("podcast_")) return inner.from(name);
      const b = new Proxy({}, { get: (_, k) => (k === "then" ? (resolve) => resolve({ data: null, error: gone }) : () => b) });
      return b;
    },
  };
  const real = supabasePodcastStore(noTables);
  const r = await run(real, OWNER, { action: "refresh" });
  const e = await run(real, OWNER, { action: "episode", episodeId: randomUUID() });
  ck("the Supabase store reports a missing table as missing, not as a failure", r.status === 503 && e.status === 503 && r.json.code === "not_set_up",
     `${r.status} ${e.status}`);
  ck("  and an answer it can't save is reported, not thrown", (await real.saveAnswer({ user_id: OWNER.id })).missing === true);
}

console.log("\n  the Supabase store's lease");
{
  const ep = episodeRow();
  const db = fakeSupabase({ tables: { podcast_episodes: [ep] } });
  const store = supabasePodcastStore(db);
  const at = new Date(NOW).toISOString();
  const first = await store.takeLease(ep.id, at, new Date(NOW + LEASE_MS).toISOString());
  const second = await store.takeLease(ep.id, at, new Date(NOW + LEASE_MS).toISOString());
  ck("one request takes the lease and the next is refused", first.taken === true && second.taken === false);
  const lapsed = await store.takeLease(ep.id, new Date(NOW + LEASE_MS + 1000).toISOString(), new Date(NOW + 2 * LEASE_MS).toISOString());
  ck("a lease that ran out is taken over", lapsed.taken === true);
  const saved = await store.saveQuestions(ep.id, { questions: { passages: [] }, questions_at: at });
  const late = await store.saveQuestions(ep.id, { questions: { passages: [{ key: "late" }] }, questions_at: at });
  ck("questions are saved once; a late second set doesn't replace them, and the lease is cleared",
     saved.written === true && late.written === false && db.tables.podcast_episodes[0].questions.passages.length === 0 &&
     db.tables.podcast_episodes[0].questions_lease_until === null);
  ck("no lease is taken on an episode that has questions", (await store.takeLease(ep.id, at, at)).taken === false);
}

ck("nothing left the machine: no request to RFI, Spotify, Supabase or Anthropic", outside.length === 0, outside.join(" "));

anthropic.close();
globalThis.fetch = realFetch;
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
