// The Podcasts module's reading of RFI and Spotify, its timing of passages,
// and its database update (2026-10-09). The owner approved the module that
// day ("i like it build it"): RFI's learner podcasts only, added by pasting a
// Spotify link; questions on passages of RFI's own transcript, each with a
// Listen button that plays RFI's own recording from just before the passage.
//
// What has to hold:
//   - an RFI feed gives every episode, newest first, with its title (CDATA and
//     entities decoded), date, page (without the tracking query string), MP3
//     (with & and not &amp;) and length in seconds;
//   - an episode page gives the transcript, paragraph by paragraph, in order,
//     with no markup, no "Voir plus" / "Voir moins" and plain spacing, and the
//     stories with their start times, headlines first, taken only from the
//     chapter list before the transcript; a page with no transcript says so
//     (no paragraphs) instead of throwing, and so does a page of nonsense;
//   - Listen's times: inside its story, a passage starts as far into the
//     story's time as it is into the story's text, and a podcast without
//     stories is timed over the whole episode;
//   - every form of Spotify link a student copies is accepted and anything else
//     refused; a Spotify title finds its RFI podcast and episode, even cut short
//     (from TITLE_PREFIX_MIN characters), and a title from anywhere else finds
//     nothing ("Only RFI's learner podcasts can be added for now");
//   - the server reads only RFI's site and Spotify, over https: anything else
//     is refused before a request leaves, a redirect elsewhere isn't followed,
//     and a reply of 500 comes back as a plain sentence the student can be
//     shown, never as a crash or RFI's error page;
//   - migration_017 loads on top of every other migration, runs twice, changes
//     nothing that exists, and lets a student read only what is theirs (where
//     this machine has Postgres; elsewhere it says it didn't run).
//
// The pages and feeds are short synthetic French in RFI's own markup
// (tests/fixtures/podcasts): RFI's text is copyrighted and this repository is
// public. No browser. Nothing leaves the machine: the global fetch is
// replaced by one that refuses and counts, and every read goes through a
// stand-in that answers only for francaisfacile.rfi.fr and open.spotify.com.

import { readFileSync } from "node:fs";
import { checker } from "../check.mjs";
import { localPostgres } from "../local-postgres.mjs";
import {
  fetchText, parseFeed, parseEpisodePage, parseSpotifyLink, spotifyTitle, matchTitle, normalizeTitle,
  ALLOWED_HOSTS, MAX_BYTES, USER_AGENT, TITLE_PREFIX_MIN,
} from "../../api/_lib/podcastSource.js";
import {
  estimatePassageTimes, listenWindow, normalizePassage, SPEAKING_RATE, LISTEN_LEAD, LISTEN_TAIL,
} from "../../src/lib/podcastTiming.js";
import { PODCASTS, podcastBySlug } from "../../src/lib/podcastCatalogue.js";

const ck = checker();
const fixture = (name) => readFileSync(new URL(`../fixtures/podcasts/${name}`, import.meta.url), "utf8");

// Nothing may reach the network: the real fetch is replaced, and any call to
// it is counted and refused.
const leaks = [];
globalThis.fetch = async (url) => {
  leaks.push(String(url));
  throw new TypeError("fetch failed: this suite never reaches the network");
};

// A stand-in for the two sites. `routes` answers per host; a request to any
// other host is counted as a stray and refused.
const strays = [];
function stubSites(routes) {
  const log = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    log.push({ url: String(url), host: u.hostname, init });
    const route = routes[u.hostname];
    if (!route) {
      strays.push(String(url));
      throw new TypeError("fetch failed");
    }
    return route(u, init);
  };
  return { impl, log };
}
const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};
// A message the student can be shown: a sentence, no markup, no error class.
const plainSentence = (msg) => typeof msg === "string" && /^[A-Z“"']/.test(msg) && /[.!?]$/.test(msg) && !/[<>{}]|TypeError|Error:|undefined/.test(msg);

// ── The feed ────────────────────────────────────────────────────────────
console.log("\n  The feed");
{
  const xml = fixture("feed-journal.xml");
  const feed = parseFeed(xml);
  const itemCount = (xml.match(/<item>/g) || []).length;
  ck("every episode in the feed comes out", feed.items.length === itemCount, `${feed.items.length} of ${itemCount}`);
  ck("the podcast's title is the channel's, not its logo's", feed.title === "Journal en français facile", JSON.stringify(feed.title));

  const times = feed.items.map((i) => Date.parse(i.published_at));
  ck("episodes come out newest first (the fixture lists them out of order)",
     times.every((t, i) => i === 0 || times[i - 1] >= t) && feed.items.every((i) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(i.published_at)),
     feed.items.map((i) => i.published_at).join(", "));

  ck("each episode's page is RFI's page without the tracking query string",
     feed.items.every((i) => i.page_url.startsWith("https://francaisfacile.rfi.fr/") && !/[?#]/.test(i.page_url)),
     feed.items.map((i) => i.page_url.split("/").pop()).join(", "));
  ck("each episode's recording is its MP3, with & and not &amp;",
     feed.items.every((i) => /^https:\/\/[^ ]+\.mp3\?/.test(i.audio_url) && i.audio_url.includes("&source=") && !i.audio_url.includes("&amp;")),
     feed.items[0]?.audio_url);
  ck("each episode keeps RFI's own id (the guid)",
     feed.items.every((i) => xml.includes(`<guid isPermaLink="false">${i.guid}</guid>`)), feed.items.map((i) => i.guid).join(", "));

  // The length, from the fixture's own "hh:mm:ss" next to each guid.
  const secs = (hms) => hms.split(":").reduce((a, b) => a * 60 + Number(b), 0);
  const durations = feed.items.map((i) => {
    const block = xml.split("<item>").find((b) => b.includes(`>${i.guid}</guid>`)) || "";
    const want = secs(/<itunes:duration>([^<]+)</.exec(block)?.[1] || "0");
    return { got: i.duration_seconds, want };
  });
  ck("each episode's length is in seconds", durations.every((d) => d.got === d.want && d.want > 0), JSON.stringify(durations));

  const cdata = feed.items.find((i) => i.guid.endsWith("0008"));
  const ents = feed.items.find((i) => i.guid.endsWith("0007"));
  ck("a title in CDATA is read as written, & and all",
     cdata?.title === "Questions & réponses : l’école d’après / Météo : grand soleil sur la Bretagne...", JSON.stringify(cdata?.title));
  ck("entities in a title are decoded (&#039; &amp; &#160;)",
     !!ents && ents.title.startsWith("Sport: l'équipe de Lille & ses supporters") && !/&#|&amp;/.test(ents.title) && ents.title.includes("« musée des jouets »"),
     JSON.stringify(ents?.title));

  const twice = parseFeed(`<rss><channel><title>Essai</title>
    <item><title>Un</title><guid>g-1</guid><pubDate>Mon, 05 Oct 2026 10:00:00 +0200</pubDate></item>
    <item><title>Un, encore</title><guid>g-1</guid><pubDate>Mon, 05 Oct 2026 10:00:00 +0200</pubDate></item></channel></rss>`);
  ck("an episode listed twice comes out once (one row per podcast and guid)", twice.items.length === 1, `${twice.items.length}`);

  let threw = null;
  let garbage = null;
  try {
    garbage = [parseFeed("<html><body><h1>Erreur 500</h1></body></html>"), parseFeed(""), parseFeed(undefined)];
  } catch (err) {
    threw = err;
  }
  ck("an error page, or nothing, in place of a feed gives no episodes and doesn't throw",
     !threw && garbage.every((f) => Array.isArray(f.items) && f.items.length === 0), threw ? threw.message : "");
}

// ── The episode page ────────────────────────────────────────────────────
console.log("\n  The episode page");
const journalHtml = fixture("episode-journal.html");
const journalPage = parseEpisodePage(journalHtml);
{
  // What the page holds, read back from the fixture: the chapter items in the
  // chapter list before the transcript, and the <p> paragraphs of the
  // transcript block.
  const before = journalHtml.slice(0, journalHtml.indexOf('<div class="t-content__transcription">'));
  const listed = before.split('<li class="a-chapter">').slice(1).map((li) => {
    const [mm, ss] = /(\d\d):(\d\d)\s*<\/play-media>/.exec(li).slice(1);
    return Number(mm) * 60 + Number(ss);
  });
  const { stories, paragraphs } = journalPage;
  ck("every story in the chapter list comes out, with its start in seconds",
     JSON.stringify(stories.map((s) => s.t)) === JSON.stringify(listed), `${JSON.stringify(stories.map((s) => s.t))} for ${JSON.stringify(listed)}`);
  ck("the first is the headlines, \"Les titres\"", stories[0]?.title === "Les titres", JSON.stringify(stories[0]));
  ck("a chapter after the transcript (another episode's) is not one of this episode's stories",
     !stories.some((s) => /autre épisode/.test(s.title)), stories.map((s) => s.title).join(" | "));
  ck("nor are menu items or a script's text before it", !stories.some((s) => /programme|Pas un chapitre/.test(s.title)));
  ck("story titles are plain text, entities decoded",
     stories.some((s) => s.title === 'Nantes : l\'ouverture d\'un musée de "jouets"') && stories.every((s) => s.title === s.title.trim() && !/[<>]|&#|&amp;|\s\s/.test(s.title)),
     stories.map((s) => JSON.stringify(s.title)).join(" "));

  const block = journalHtml.slice(journalHtml.indexOf('class="m-transcription__content"'), journalHtml.indexOf('class="m-box-expand__button"'));
  const pCount = (block.match(/<p>/g) || []).length;
  ck("every paragraph of the transcript comes out", paragraphs.length === pCount, `${paragraphs.length} of ${pCount}`);
  ck("in order: the first and last are the transcript's first and last",
     paragraphs[0] === "Vous écoutez le Journal en français facile." && paragraphs.at(-1) === "C'est la fin de ce journal. À demain !",
     `${JSON.stringify(paragraphs[0])} … ${JSON.stringify(paragraphs.at(-1))}`);
  ck("no \"Voir plus\" or \"Voir moins\", no markup, no entities left",
     paragraphs.every((p) => !/voir (plus|moins)/i.test(p) && !/[<>]/.test(p) && !/&#|&amp;|&nbsp;/.test(p)),
     paragraphs.filter((p) => /voir|[<>]|&/.test(p)).join(" | "));
  ck("spacing is plain: single spaces, none at either end, no non-breaking ones",
     paragraphs.every((p) => p === p.trim() && !/\s\s|\u00a0|\u202f/.test(p)), JSON.stringify(paragraphs[2]));
  ck("& written as &amp; in the transcript is read as &", paragraphs.some((p) => p.includes("dix-huit ans & les étudiants")));
  const unbuttoned = parseEpisodePage(`<div class="t-content__transcription"><div class="m-transcription__content">
    <p>Bonjour.</p><p>  Voir plus </p><span class="m-box-expand__button__close">Voir moins</span><p>Au revoir.</p></div></div>`);
  ck("the unfolding button's words are dropped even if RFI stops putting them in a <button>",
     JSON.stringify(unbuttoned.paragraphs) === JSON.stringify(["Bonjour.", "Au revoir."]), JSON.stringify(unbuttoned.paragraphs));
  const decomposed = parseEpisodePage(`<div class="m-transcription__content"><p>L’école a fermé.</p></div>`);
  ck("accents written as two characters come out as one, as the passages are compared",
     decomposed.paragraphs[0] === "L’école a fermé." && decomposed.paragraphs[0] === decomposed.paragraphs[0].normalize("NFC"), JSON.stringify(decomposed.paragraphs));
  ck("the PDF link and the authors aren't part of the transcript",
     !paragraphs.some((p) => /Ouvrir le PDF|Transcription|journaliste d'essai|Par :/.test(p)));

  const mots = parseEpisodePage(fixture("episode-mots.html"));
  const motsHtml = fixture("episode-mots.html");
  const motsP = (motsHtml.slice(motsHtml.indexOf('class="m-transcription__content"')).match(/<p>/g) || []).length;
  ck("a Les mots de l'info page: its transcript, and no stories",
     mots.paragraphs.length === motsP && mots.stories.length === 0, `${mots.paragraphs.length} paragraphs of ${motsP}, ${mots.stories.length} stories`);

  let threw = null;
  let none = null;
  let junk = null;
  try {
    none = parseEpisodePage(fixture("episode-no-transcript.html"));
    junk = [parseEpisodePage("<html><body>Service indisponible</body></html>"), parseEpisodePage(""), parseEpisodePage(undefined)];
  } catch (err) {
    threw = err;
  }
  ck("a page RFI hasn't put the transcript on yet gives no paragraphs, and doesn't throw",
     !threw && none?.paragraphs.length === 0, threw ? threw.message : `${none?.paragraphs.length} paragraphs`);
  ck("  its chapter list is still read", none?.stories.length > 0 && none.stories[0].title === "Les titres", JSON.stringify(none?.stories));
  ck("an error page, or nothing, in place of a page gives no paragraphs and no stories, and doesn't throw",
     !threw && junk?.every((p) => p.paragraphs.length === 0 && p.stories.length === 0), threw ? threw.message : "");
}

// ── When each passage is heard ──────────────────────────────────────────
console.log("\n  When each passage is heard");
{
  // The fixture's episode: its stories, and the first paragraph of each,
  // found by the story's opening words (as Claude gives storyStarts).
  const { paragraphs, stories } = journalPage;
  const duration = parseFeed(fixture("feed-journal.xml")).items.find((i) => i.guid.endsWith("0006")).duration_seconds;
  const opening = ["Vous écoutez", "Il a neigé toute la nuit", "Le club de Lille", "Un nouveau musée"];
  const storyStarts = opening.map((w) => paragraphs.findIndex((p) => p.startsWith(w)));
  const times = (story, fr, extra = {}) => estimatePassageTimes({ paragraphs, stories, storyStarts, duration, passage: { story, fr }, ...extra });

  const first = times(1, paragraphs[storyStarts[1]]);
  ck("a passage that opens a story starts at the story's start time",
     Math.abs(first.start - stories[1].t) <= 0.1, `${first.start} s, story at ${stories[1].t} s`);
  ck("  and ends before the next story starts", first.end > first.start && first.end <= stories[2].t, `${first.start}–${first.end} s`);

  const second = times(1, paragraphs[storyStarts[1] + 1]);
  ck("the passage that follows starts where that one ends (within a second)",
     second.start >= first.end && second.start - first.end <= 1, `${first.end} → ${second.start} s`);
  ck("  and the story's last passage ends as the next story starts",
     Math.abs(second.end - stories[2].t) <= 0.1, `${second.end} s, next story at ${stories[2].t} s`);

  const signOff = times(3, paragraphs.at(-1));
  ck("the last story's last passage ends at the end of the episode",
     signOff.end === duration && signOff.start >= stories[3].t, `${signOff.start}–${signOff.end} of ${duration} s`);

  // Two paragraphs of equal length: the second starts halfway through the
  // story's time.
  const half = { paragraphs: ["Intro.", "a".repeat(99), "b".repeat(99), "Fin."], stories: [{ t: 10, title: "Les titres" }, { t: 40, title: "A" }, { t: 100, title: "B" }], storyStarts: [0, 1, 3], duration: 160 };
  const mid = estimatePassageTimes({ ...half, passage: { story: 1, fr: "b".repeat(99) } });
  const midway = (half.stories[1].t + half.stories[2].t) / 2;
  ck("a passage halfway into a story's text starts halfway into the story's time",
     Math.abs(mid.start - midway) <= 0.5, `${mid.start} s, halfway is ${midway} s`);

  const noStories = { paragraphs: ["c".repeat(99), "d".repeat(99)], stories: [], storyStarts: [], duration: 200 };
  const d = estimatePassageTimes({ ...noStories, passage: { story: null, fr: "d".repeat(99) } });
  const c = estimatePassageTimes({ ...noStories, passage: { story: null, fr: "c".repeat(99) } });
  ck("with no stories, the whole transcript is timed over the whole episode",
     c.start === 0 && Math.abs(d.start - noStories.duration / 2) <= 0.5 && d.end === noStories.duration, `${JSON.stringify(c)} ${JSON.stringify(d)}`);

  const motsPage = parseEpisodePage(fixture("episode-mots.html"));
  const motsDuration = parseFeed(fixture("feed-mots.xml")).items[0].duration_seconds;
  const m = motsPage.paragraphs.map((p) => estimatePassageTimes({ paragraphs: motsPage.paragraphs, stories: motsPage.stories, storyStarts: [], duration: motsDuration, passage: { story: null, fr: p } }));
  ck("  a Les mots de l'info episode's paragraphs follow one another to its end",
     m.every((t, i) => t.end >= t.start && (i === 0 || t.start >= m[i - 1].end)) && m[0].start === 0 && m.at(-1).end === motsDuration,
     m.map((t) => `${t.start}-${t.end}`).join(" "));

  const target = paragraphs[storyStarts[1] + 1];
  const loose = target.replace(/'/g, "’").replace(/ /g, "  ");
  const exact = times(1, target);
  const typed = times(1, loose);
  ck("a passage copied with curly apostrophes and double spaces is timed the same",
     JSON.stringify(exact) === JSON.stringify(typed) && normalizePassage(loose) === normalizePassage(target), `${JSON.stringify(exact)} / ${JSON.stringify(typed)}`);

  const misfiled = times(1, paragraphs[storyStarts[2]]);
  ck("a passage given the wrong story number is timed in the story its text is in",
     misfiled.start >= stories[2].t && misfiled.end <= stories[3].t, `${JSON.stringify(misfiled)}, story at ${stories[2].t}–${stories[3].t} s`);

  const missing = times(2, "Cette phrase n'est pas dans la transcription.");
  ck("a passage not in the transcript gets its whole story",
     missing.start === stories[2].t && missing.end === stories[3].t, JSON.stringify(missing));

  const chars = normalizePassage(paragraphs.join(" ")).length;
  const unknown = estimatePassageTimes({ paragraphs, stories: [], storyStarts: [], duration: null, passage: { story: null, fr: paragraphs.at(-1) } });
  ck("with the episode's length unknown, the text is timed at the newsreader's pace (SPEAKING_RATE)",
     Math.abs(unknown.end - chars / SPEAKING_RATE) <= 0.2, `${unknown.end} s for ${chars} characters`);

  const wild = estimatePassageTimes({ paragraphs, stories: stories.map((s) => ({ ...s, t: s.t * 10 })), storyStarts, duration, passage: { story: 3, fr: paragraphs.at(-1) } });
  ck("times never fall outside the episode", wild.start >= 0 && wild.end <= duration && wild.end >= wild.start, JSON.stringify(wild));

  const w = listenWindow(first, duration);
  const edge = listenWindow({ start: 1, end: duration - 1 }, duration);
  ck(`Listen starts ${LISTEN_LEAD} s before the passage and stops ${LISTEN_TAIL} s after it`,
     Math.abs(w.from - (first.start - LISTEN_LEAD)) < 1e-9 && Math.abs(w.to - (first.end + LISTEN_TAIL)) < 1e-9, `${JSON.stringify(first)} → ${JSON.stringify(w)}`);
  ck("  never before the recording's start or after its end", edge.from === 0 && edge.to === duration, JSON.stringify(edge));
}

// ── Spotify links ───────────────────────────────────────────────────────
console.log("\n  Spotify links");
const EP = "4testEpisodeIdAbcdef12";
const SHOW = "7testShowIdAbcdefghij1";
{
  const accepted = [
    [`https://open.spotify.com/episode/${EP}`, "episode", EP],
    [`https://open.spotify.com/episode/${EP}?si=a1b2c3d4e5f6`, "episode", EP],
    [`https://open.spotify.com/intl-fr/episode/${EP}?si=x`, "episode", EP],
    [`https://open.spotify.com/show/${SHOW}`, "show", SHOW],
    [`https://open.spotify.com/show/${SHOW}?si=zz&nd=1`, "show", SHOW],
    [`  https://open.spotify.com/episode/${EP}/  `, "episode", EP],
    [`spotify:episode:${EP}`, "episode", EP],
    [`spotify:show:${SHOW}`, "show", SHOW],
  ];
  const wrong = accepted.filter(([link, type, id]) => {
    const r = parseSpotifyLink(link);
    return !r || r.type !== type || r.id !== id;
  });
  ck("every form of Spotify link a student copies is accepted: episode, show, /intl-xx/, ?si=, spotify:",
     wrong.length === 0, wrong.length ? `refused: ${wrong.map((w) => w[0]).join(", ")}` : `${accepted.length} forms`);

  const refused = [
    `http://open.spotify.com/episode/${EP}`,
    `https://open.spotify.com/playlist/${EP}`,
    `https://open.spotify.com/track/${EP}`,
    `https://open.spotify.com/episode/`,
    `https://open.spotify.com/episode/${EP.slice(0, 10)}`,
    `https://spotify.com/episode/${EP}`,
    `https://open.spotify.com.example.com/episode/${EP}`,
    `https://example.com/open.spotify.com/episode/${EP}`,
    `https://someone@open.spotify.com/episode/${EP}`,
    `https://podcasts.apple.com/fr/podcast/journal-en-fran%C3%A7ais-facile/id123456789`,
    `https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/`,
    `spotify:track:${EP}`,
    `Journal en français facile`,
    ``,
  ];
  const let_through = refused.filter((l) => parseSpotifyLink(l) !== null);
  ck("anything else is refused: other sites, http, playlists and tracks, no id, plain words",
     let_through.length === 0, let_through.length ? `accepted: ${let_through.join(", ")}` : `${refused.length} refused`);
}

// ── Which podcast a title is ────────────────────────────────────────────
console.log("\n  Which podcast a title is");
const FIXTURE_FEED = { "journal-en-francais-facile": "feed-journal.xml", "les-mots-de-l-info": "feed-mots.xml", "un-mot-une-histoire": "feed-un-mot.xml" };
const FEEDS = Object.fromEntries(PODCASTS.map((p) => [p.slug, parseFeed(fixture(FIXTURE_FEED[p.slug]))]));
{
  ck("the fixtures cover every catalogue podcast", PODCASTS.every((p) => FEEDS[p.slug].items.length > 0 && podcastBySlug(p.slug) === p),
     PODCASTS.map((p) => p.slug).join(", "));

  const all = Object.entries(FEEDS).flatMap(([slug, f]) => f.items.map((item) => ({ slug, item })));
  const misses = all.filter(({ slug, item }) => {
    const r = matchTitle(item.title, FEEDS);
    return r?.slug !== slug || r.item.guid !== item.guid;
  });
  ck("each episode's own title finds its podcast and that episode", misses.length === 0,
     misses.length ? misses.map((m) => m.item.title).join(" | ") : `${all.length} titles`);

  const jeff = FEEDS["journal-en-francais-facile"].items.find((i) => i.page_url.includes("/20261006-"));
  const loose = `  ${jeff.title.replace(/'/g, "’").toUpperCase().replace(/ /g, "  ")} `;
  ck("spacing, capitals and curly apostrophes don't matter", matchTitle(loose, FEEDS)?.item.guid === jeff.guid, JSON.stringify(loose));

  const cut = jeff.title.slice(0, TITLE_PREFIX_MIN);
  const tooShort = jeff.title.slice(0, TITLE_PREFIX_MIN - 1);
  ck(`a title Spotify cut to ${TITLE_PREFIX_MIN} characters still finds the episode`,
     cut.trim().length === TITLE_PREFIX_MIN && matchTitle(cut, FEEDS)?.item.guid === jeff.guid, JSON.stringify(cut));
  ck(`  one cut to ${TITLE_PREFIX_MIN - 1} is too short to be sure, and finds nothing`, matchTitle(tooShort, FEEDS) === null, JSON.stringify(tooShort));
  ck("  a cut title ending in … still finds it", matchTitle(`${jeff.title.slice(0, 60)}…`, FEEDS)?.item.guid === jeff.guid);
  const longer = `${jeff.title.replace(/\.\.\.$/, "")} / Météo : il pleut sur Brest`;
  ck("  and a title longer than RFI's cut one finds it too", matchTitle(longer, FEEDS)?.item.guid === jeff.guid, JSON.stringify(longer));

  const other = JSON.parse(fixture("oembed-other.json")).title;
  ck("a title from another podcast finds nothing", matchTitle(other, FEEDS) === null, JSON.stringify(other));
  ck("  nor does a short start shared by many titles, or nothing at all",
     matchTitle("Sport:", FEEDS) === null && matchTitle("", FEEDS) === null && matchTitle(undefined, FEEDS) === null);
  ck("normalizeTitle makes curly and straight apostrophes one", normalizeTitle("L’école  d'après") === normalizeTitle("l'école d’après"));
}

// ── Spotify's title for a link ──────────────────────────────────────────
console.log("\n  Spotify's title for a link");
{
  const oembed = { episode: fixture("oembed-episode.json"), show: fixture("oembed-show.json") };
  const spotify = stubSites({
    "open.spotify.com": (u) => {
      const target = u.searchParams.get("url") || "";
      if (u.pathname !== "/oembed") return reply("not found", 404);
      if (target.endsWith(`/episode/${EP}`)) return reply(oembed.episode, 200, { "content-type": "application/json" });
      if (target.endsWith(`/show/${SHOW}`)) return reply(oembed.show, 200, { "content-type": "application/json" });
      return reply('{"error":"not found"}', 404);
    },
  });
  const read = (url) => fetchText(url, { fetchImpl: spotify.impl });

  const title = await spotifyTitle(`https://open.spotify.com/episode/${EP}?si=abc`, { fetchText: read });
  const asked = spotify.log[0] ? new URL(spotify.log[0].url) : null;
  ck("an episode link's title is Spotify's (oEmbed)", title === JSON.parse(oembed.episode).title, JSON.stringify(title));
  ck("  asked once, of open.spotify.com/oembed, for that episode",
     spotify.log.length === 1 && asked?.hostname === "open.spotify.com" && asked.pathname === "/oembed" && asked.searchParams.get("url") === `https://open.spotify.com/episode/${EP}`,
     spotify.log.map((l) => l.url).join(", "));

  const match = matchTitle(title, FEEDS);
  ck("  and it finds its RFI episode", match?.slug === "journal-en-francais-facile" && match.item.page_url.includes("/20261007-"), JSON.stringify(match?.item?.title));

  const showTitle = await spotifyTitle({ type: "show", id: SHOW }, { fetchText: read });
  ck("a show link (Spotify gives its latest episode's title) finds the show's podcast",
     matchTitle(showTitle, FEEDS)?.slug === "les-mots-de-l-info", JSON.stringify(showTitle));

  const before = spotify.log.length;
  const bad = await rejection(spotifyTitle("https://example.com/episode/123", { fetchText: read }));
  ck("a link that isn't Spotify's is refused with the student's sentence, and nothing is asked",
     bad?.code === "bad_link" && bad.message === "That doesn’t look like a Spotify link." && spotify.log.length === before, bad?.message);

  const unknown = await rejection(spotifyTitle(`spotify:episode:${"Z".repeat(22)}`, { fetchText: read }));
  ck("an episode Spotify doesn't know gives a plain sentence", unknown?.code === "not_found" && plainSentence(unknown.message), unknown?.message);

  const down = stubSites({ "open.spotify.com": () => reply("<html><body>Internal Server Error</body></html>", 500) });
  const t0 = Date.now();
  const err = await rejection(spotifyTitle(`spotify:episode:${EP}`, { fetchText: (u) => fetchText(u, { fetchImpl: down.impl }) }));
  ck("Spotify answering 500 comes back as a plain sentence naming Spotify, not as a crash or its error page",
     err instanceof Error && err.status === 500 && /Spotify/.test(err.message) && plainSentence(err.message) && Date.now() - t0 < 2000,
     err ? `${err.code}: ${err.message}` : "no error");

  const garbled = stubSites({ "open.spotify.com": () => reply("<html>not json</html>") });
  const g = await rejection(spotifyTitle(`spotify:episode:${EP}`, { fetchText: (u) => fetchText(u, { fetchImpl: garbled.impl }) }));
  ck("a reply that isn't Spotify's JSON gives a plain sentence", g?.code === "bad_reply" && plainSentence(g.message), g?.message);
}

// ── Only RFI and Spotify are read ───────────────────────────────────────
console.log("\n  Only RFI and Spotify are read");
{
  const page = fixture("episode-mots.html");
  const rfi = stubSites({ "francaisfacile.rfi.fr": () => reply(page, 200, { "content-type": "text/html; charset=utf-8" }) });
  const url = "https://francaisfacile.rfi.fr/fr/podcasts/les-mots-de-l-info/20261005-avoir-le-cafard";
  const body = await fetchText(url, { fetchImpl: rfi.impl });
  const sent = rfi.log[0]?.init || {};
  const ua = new Headers(sent.headers).get("user-agent");
  ck("an RFI page is read, as sent", body === page && rfi.log.length === 1, `${body.length} characters, ${rfi.log.length} request`);
  ck("  with the app's User-Agent, a time limit, and redirects left to be checked",
     ua === USER_AGENT && !!ua && sent.signal instanceof AbortSignal && sent.redirect === "manual", `${ua}; redirect ${sent.redirect}`);
  ck("the two sites are RFI's learner site and Spotify, and no other",
     JSON.stringify([...ALLOWED_HOSTS].sort()) === JSON.stringify(["francaisfacile.rfi.fr", "open.spotify.com"]), ALLOWED_HOSTS.join(", "));

  const elsewhere = [
    ["http://francaisfacile.rfi.fr/fr/podcasts/", "not_https"],
    ["http://open.spotify.com/oembed?url=x", "not_https"],
    ["https://example.com/feed.xml", "bad_host"],
    ["https://francaisfacile.rfi.fr.example.com/fr/", "bad_host"],
    ["https://www.rfi.fr/fr/", "bad_host"],
    ["https://someone:secret@francaisfacile.rfi.fr/fr/", "bad_host"],
    ["https://francaisfacile.rfi.fr:8443/fr/", "bad_host"],
    ["ftp://open.spotify.com/x", "not_https"],
    ["pas une adresse", "bad_url"],
  ];
  const guard = stubSites({});
  const results = [];
  for (const [u, code] of elsewhere) {
    const e = await rejection(fetchText(u, { fetchImpl: guard.impl }));
    results.push({ u, ok: e?.code === code && plainSentence(e.message), got: e?.code });
  }
  ck("any other site, http, a password or another port is refused before a request leaves",
     results.every((r) => r.ok) && guard.log.length === 0,
     `${guard.log.length} requests; ${results.filter((r) => !r.ok).map((r) => `${r.u} → ${r.got}`).join(", ") || "all refused"}`);

  const hop = stubSites({
    "francaisfacile.rfi.fr": (u) => (u.pathname === "/start"
      ? reply("", 302, { location: "https://evil.example/steal" })
      : reply("never", 200)),
  });
  const away = await rejection(fetchText("https://francaisfacile.rfi.fr/start", { fetchImpl: hop.impl }));
  ck("a redirect to another site isn't followed", away?.code === "bad_host" && hop.log.length === 1 && plainSentence(away.message),
     `${away?.message}; ${hop.log.length} request`);

  const down = stubSites({ "francaisfacile.rfi.fr": (u) => (u.pathname === "/start" ? reply("", 301, { location: "http://francaisfacile.rfi.fr/plain" }) : reply("x")) });
  const insecure = await rejection(fetchText("https://francaisfacile.rfi.fr/start", { fetchImpl: down.impl }));
  ck("  nor one to an http address on RFI's own site", insecure?.code === "not_https" && down.log.length === 1, insecure?.message);

  const moved = stubSites({ "francaisfacile.rfi.fr": (u) => (u.pathname === "/old" ? reply("", 301, { location: "/new" }) : reply(`page at ${u.pathname}`)) });
  const followed = await fetchText("https://francaisfacile.rfi.fr/old", { fetchImpl: moved.impl });
  ck("a redirect within RFI's site is followed", followed === "page at /new" && moved.log.length === 2, followed);

  const broken = stubSites({ "francaisfacile.rfi.fr": () => reply("<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>", 500) });
  const t0 = Date.now();
  const e500 = await rejection(fetchText(url, { fetchImpl: broken.impl }));
  ck("RFI answering 500 comes back as a plain sentence naming RFI's site and the error, not as a crash or its error page",
     e500 instanceof Error && e500.status === 500 && e500.code === "http_status" && /RFI/.test(e500.message) && /500/.test(e500.message) && plainSentence(e500.message) && Date.now() - t0 < 2000,
     e500 ? e500.message : "no error");

  const exact = stubSites({ "francaisfacile.rfi.fr": () => reply("x".repeat(MAX_BYTES)) });
  const big = await fetchText(url, { fetchImpl: exact.impl });
  ck("a reply of exactly the size limit is read", big.length === MAX_BYTES, `${big.length} bytes`);
  const huge = stubSites({ "francaisfacile.rfi.fr": () => reply("x".repeat(MAX_BYTES + 1)) });
  const tooBig = await rejection(fetchText(url, { fetchImpl: huge.impl }));
  const said = stubSites({ "francaisfacile.rfi.fr": () => reply("small", 200, { "content-length": String(MAX_BYTES + 1) }) });
  const saidBig = await rejection(fetchText(url, { fetchImpl: said.impl }));
  ck("one byte over is refused, whether or not the site says its size first",
     tooBig?.code === "too_big" && saidBig?.code === "too_big" && plainSentence(tooBig.message), `${tooBig?.code} / ${saidBig?.code}`);

  const silent = stubSites({
    "francaisfacile.rfi.fr": (_u, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  // Node doesn't wait on the time limit's own timer, and the stand-in holds
  // no connection open, so the suite keeps itself alive meanwhile.
  const alive = setTimeout(() => {}, 5000);
  const slow = await rejection(fetchText(url, { fetchImpl: silent.impl, timeoutMs: 50 }));
  clearTimeout(alive);
  ck("a site that never answers is given up on, with a plain sentence", slow?.code === "timeout" && plainSentence(slow.message), slow?.message);

  const offline = await rejection(fetchText(url, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }));
  ck("no connection at all gives a plain sentence too", offline?.code === "network" && plainSentence(offline.message), offline?.message);

  // Without fetchImpl, the global fetch at the time of the call is used (so a
  // server suite can stand in for it); put back straight after.
  const guardFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u) => { seen = String(u); return reply("from the global fetch"); };
  const viaGlobal = await fetchText(url).finally(() => { globalThis.fetch = guardFetch; });
  ck("with no fetch given, the global fetch is used", viaGlobal === "from the global fetch" && seen === url, seen);
}

// ── The database update ─────────────────────────────────────────────────
console.log("\n  The database update (migration_017)");
{
  const file = readFileSync(new URL("../../migrations/migration_017_podcasts.sql", import.meta.url), "utf8");
  const sql = file.replace(/--[^\n]*/g, "");
  const touches = [...sql.matchAll(/\b(alter|drop|truncate|delete\s+from|update)\s+(?:table\s+|policy\s+if\s+exists\s+"[^"]*"\s+on\s+)?(?:if\s+exists\s+)?(public\.\w+|\w+)/gi)]
    .map((m) => `${m[1]} ${m[2]}`)
    .filter((s) => !/public\.podcast_/.test(s));
  ck("it only adds: nothing it changes or removes is outside the three new tables", touches.length === 0, touches.join(", ") || "only podcast_* tables");
  ck("no email in any policy (admin only is decided in code)", !/@|->>\s*'email'|auth\.email\(\)/.test(sql));
  ck("every policy is dropped before it is made, so it runs twice",
     [...sql.matchAll(/create policy "([^"]+)"/g)].every((m) => sql.includes(`drop policy if exists "${m[1]}"`)));

  const { db: pg, why } = await localPostgres();
  if (!pg) {
    // Postgres is here but this file won't load: that is this file's fault.
    if (/migration_017/.test(why || "")) ck("every migration loads, migration_017 included", false, why);
    else console.log(`  (not run here: the real tables on a local Postgres; ${why})`);
  } else {
    try {
      ck("every migration loads, migration_017 included", true);
      const again = pg.sql(`\\i ${new URL("../../migrations/migration_017_podcasts.sql", import.meta.url).pathname}`);
      ck("it runs a second time without an error", again.ok, again.ok ? "" : again.err.split("\n")[0]);

      const A = "00000000-0000-0000-0000-0000000000a1";
      const B = "00000000-0000-0000-0000-0000000000b2";
      const E = "eeeeeeee-0000-4000-8000-000000000001";
      const setup = pg.sql(`
        grant usage on schema auth to anon, authenticated;
        insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');
        insert into public.podcast_episodes (id, podcast, guid, title, transcript) values ('${E}', 'journal-en-francais-facile', 'g-1', 'Un épisode', '["Il a neigé."]');
        insert into public.podcast_answers (user_id, episode_id, passage_key, kind, fr, typed, verdict, due_at) values
          ('${A}', '${E}', 's1-aaaaaaaa', 'gist', 'Il a neigé.', 'It snowed.', 'got', null),
          ('${B}', '${E}', 's1-aaaaaaaa', 'gist', 'Il a neigé.', 'It rained.', 'missed', now() + interval '3 days');
        insert into public.podcast_follows (user_id, podcast) values ('${B}', 'les-mots-de-l-info');`);
      ck("(the server, with the service role's rights, writes an episode, two answers and a follow)", setup.ok, setup.err.split("\n")[0]);

      // As a signed-in student: Supabase's role and claims, in one transaction.
      const as = (uid, text) => {
        const r = pg.sql(`begin; set local role authenticated;
          select set_config('request.jwt.claim.sub', '${uid}', true), set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
          ${text}; commit;`);
        return { ...r, last: r.out.split("\n").at(-1) };
      };
      const anon = pg.sql(`begin; set local role anon; select set_config('request.jwt.claims', '{"role":"anon"}', true); select count(*) from public.podcast_episodes; commit;`);
      const owner = (text) => pg.sql(text).out.split("\n").at(-1);

      const mine = as(A, "select string_agg(typed, ',') from public.podcast_answers");
      ck("a student reads their own answers and nobody else's", mine.ok && mine.last === "It snowed.", mine.ok ? mine.last : mine.err);
      const shared = as(A, "select count(*) from public.podcast_episodes");
      ck("any signed-in student reads the shared episodes", shared.ok && shared.last === "1", shared.ok ? shared.last : shared.err);
      ck("someone not signed in reads none", !anon.ok || anon.out.split("\n").at(-1) === "0", anon.ok ? anon.out : anon.err.split("\n")[0]);

      const follow = as(A, "insert into public.podcast_follows (user_id, podcast) values (auth.uid(), 'journal-en-francais-facile')");
      const forOther = as(A, `insert into public.podcast_follows (user_id, podcast) values ('${B}', 'journal-en-francais-facile')`);
      const follows = as(A, "select string_agg(podcast, ',') from public.podcast_follows");
      ck("a student follows a podcast for themselves, and can't for anyone else", follow.ok && !forOther.ok, forOther.ok ? "the other student's follow was written" : "");
      ck("  and sees only their own follows", follows.ok && follows.last === "journal-en-francais-facile", follows.last);
      as(A, `delete from public.podcast_follows where user_id = '${B}'`);
      ck("  and can't remove another student's", owner(`select count(*) from public.podcast_follows where user_id = '${B}'`) === "1");
      const unfollow = as(A, "delete from public.podcast_follows where podcast = 'journal-en-francais-facile'");
      ck("  but can remove their own", unfollow.ok && owner(`select count(*) from public.podcast_follows where user_id = '${A}'`) === "0");

      const writeEpisode = as(A, `insert into public.podcast_episodes (podcast, guid, title) values ('journal-en-francais-facile', 'g-2', 'Faux')`);
      as(A, `update public.podcast_episodes set title = 'Changé' where id = '${E}'`);
      ck("a student's browser can't write an episode", !writeEpisode.ok && owner(`select title from public.podcast_episodes where id = '${E}'`) === "Un épisode");
      const writeAnswer = as(A, `insert into public.podcast_answers (user_id, episode_id, passage_key, kind, fr, typed, verdict) values (auth.uid(), '${E}', 's1-bbbbbbbb', 'gist', 'x', 'y', 'got')`);
      as(A, `update public.podcast_answers set verdict = 'got' where user_id = auth.uid()`);
      as(A, `delete from public.podcast_answers where user_id = auth.uid()`);
      ck("nor write, change or delete an answer, even their own (the server writes them)",
         !writeAnswer.ok && owner(`select count(*) from public.podcast_answers where user_id = '${A}'`) === "1");

      const dropEpisode = pg.sql(`delete from public.podcast_episodes where id = '${E}'`);
      ck("an episode with answers can't be deleted, so no answer goes with it", !dropEpisode.ok && owner("select count(*) from public.podcast_answers") === "2");

      const badVerdict = pg.sql(`insert into public.podcast_answers (user_id, episode_id, passage_key, kind, fr, typed, verdict) values ('${A}', '${E}', 'k', 'gist', 'x', 'y', 'part')`);
      const badKind = pg.sql(`insert into public.podcast_answers (user_id, episode_id, passage_key, kind, fr, typed, verdict) values ('${A}', '${E}', 'k', 'quiz', 'x', 'y', 'got')`);
      ck("a verdict other than got, partly or missed, or a kind other than gist or translate, is refused", !badVerdict.ok && !badKind.ok);

      const twice = pg.sql(`insert into public.podcast_episodes (podcast, guid, title) values ('journal-en-francais-facile', 'g-1', 'Encore')`);
      const upsert = pg.sql(`insert into public.podcast_episodes (podcast, guid, title) values ('journal-en-francais-facile', 'g-1', 'Titre lu à nouveau')
        on conflict (podcast, guid) do update set title = excluded.title, updated_at = now()`);
      ck("one row per podcast and guid: a second is refused, and the feed's upsert on (podcast, guid) works",
         !twice.ok && upsert.ok && owner(`select title || '|' || transcript::text from public.podcast_episodes where id = '${E}'`) === 'Titre lu à nouveau|["Il a neigé."]',
         owner(`select title from public.podcast_episodes where id = '${E}'`));
    } finally {
      pg.stop();
    }
  }
}

console.log("\n  Nothing left the machine");
ck("no request reached the network, and none went to a site the stand-ins don't answer for",
   leaks.length === 0 && strays.length === 0, [...leaks, ...strays].join(", ") || "none");

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
