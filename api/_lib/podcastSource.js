// Reading RFI and Spotify for the Podcasts module (2026-10-09). The owner
// approved the module that day ("i like it build it"): RFI's learner podcasts
// only for now, added by pasting a Spotify link, with questions on passages of
// RFI's own transcript and Listen playing RFI's own recording.
//
// Everything the server learns from outside comes through here, as text, and
// nothing here writes anywhere:
//
//   fetchText(url)        one page, feed or Spotify reply. Only two sites can
//                         be read, francaisfacile.rfi.fr and open.spotify.com,
//                         and only over https, with a 10 s limit and a 2 MB
//                         cap; anything else is refused before a request
//                         leaves. The server takes links from students, so a
//                         link must never become a way to make it fetch
//                         something else (a redirect is checked the same way).
//                         Every failure is a plain Error whose message is a
//                         sentence the student can be shown ("RFI’s site
//                         didn’t answer properly (error 500). Try again in a
//                         few minutes."), with `code` saying which failure and
//                         `status` the site's HTTP status when it answered.
//   parseFeed(xml)        an RSS feed: its episodes, newest first.
//   parseEpisodePage(html)  an episode's page: the transcript as paragraphs,
//                         and the stories with their start times.
//   parseSpotifyLink(text), spotifyTitle(link), matchTitle(title, feeds),
//   normalizeTitle(s)     which catalogue podcast (and episode) a pasted
//                         Spotify link is.
//
// There is no HTML or XML parser in the project, and adding a dependency
// needs the owner's go-ahead, so the parsing is done with plain string and
// regex work, written against the real pages saved on 2026-10-09 and kept
// tolerant: a page or feed that isn't what's expected gives empty results,
// never an exception.
//
// What RFI's pages look like (2026-10-09):
//   - The feed is RSS 2.0. Each <item> has <title>, <link> (the episode's page,
//     with a tracking query string such as "?GJlXzGgqHj", dropped here),
//     <enclosure url="…mp3?guid=…&amp;source=…">, <itunes:duration>
//     ("00:10:00"), <guid> and <pubDate>. Descriptions are CDATA.
//   - An episode page of Journal en français facile lists its stories as
//     <li class="a-chapter"> items, each with the start as "mm:ss" text
//     (and a v-bind:init-time in seconds) and the story's title in
//     .a-chapter__label. The first is "Les titres", the headlines, at a few
//     seconds in; it is kept, because the questions number the stories from
//     it and the timing needs where it ends (src/lib/podcastTiming.js).
//     The list comes BEFORE .t-content__transcription; only items before it
//     are read, so a list of chapters elsewhere on the page can't join.
//   - The transcript is the <p> paragraphs inside .m-transcription__content,
//     indented and with double spaces, apostrophes as &#039;. The block also
//     holds the "Voir plus" / "Voir moins" button that unfolds it, which is
//     not part of the text.
//   - Les mots de l'info and Un mot, une histoire pages have the same
//     transcript block and no chapters.
//   - A page without a transcript (RFI sometimes publishes one late) gives
//     paragraphs: [], and the server says "RFI hasn’t published a transcript
//     for this episode."
//
// Spotify (verified 2026-10-09): the oEmbed reply for an episode link has the
// episode's title; for a SHOW link it has the show's LATEST EPISODE's title,
// not the show's name. Either way the title is looked for among every
// catalogue feed's episode titles, which is how a show link finds its podcast
// too. Spotify may cut a long title, so a title that is the start of an
// episode's title (at least TITLE_PREFIX_MIN characters of it) also matches.
//
// RFI's text is copyrighted and this repository is public, so the tests run
// on short synthetic pages in the same markup (tests/fixtures/podcasts), never
// on RFI's own.

export const ALLOWED_HOSTS = ['francaisfacile.rfi.fr', 'open.spotify.com'];
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = 'Mozilla/5.0 (compatible; DejaReview/1.0; +https://french-flashcards-nine.vercel.app)';
const MAX_REDIRECTS = 3;

// Spotify cuts long titles; a cut title still matches when at least this many
// characters of it are the start of an episode's title. Shorter than this, a
// start like "France : " would match half of RFI's news.
export const TITLE_PREFIX_MIN = 40;

// ── Errors the student can read ─────────────────────────────────────────────

function plainError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const siteName = (host) =>
  host === 'open.spotify.com' ? 'Spotify' : host === 'francaisfacile.rfi.fr' ? 'RFI’s site' : 'That site';

// The address, if it may be read: https, one of the two sites, no user name
// or password, the standard port. `from` names the site that redirected here.
function checkUrl(url, from = null) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw plainError('bad_url', 'That isn’t a web address.');
  }
  const host = u.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.includes(host) && !u.username && !u.password && (u.port === '' || u.port === '443');
  if (u.protocol !== 'https:') {
    throw plainError('not_https', from
      ? `${from} sent the request to an address that isn’t secure, so it wasn’t followed.`
      : 'Only secure (https) addresses can be read.');
  }
  if (!allowed) {
    throw plainError('bad_host', from
      ? `${from} sent the request to another site, so it wasn’t followed.`
      : 'Only RFI’s site and Spotify can be read.');
  }
  return u;
}

async function cancelBody(res) {
  try { await res.body?.cancel(); } catch { /* nothing to free */ }
}

// The body as text, stopping as soon as it passes `maxBytes`. RFI and Spotify
// both send UTF-8.
async function readCapped(res, maxBytes, site, signal) {
  const tooBig = () => plainError('too_big', `${site} sent much more than expected, so it wasn’t read.`);
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(res);
    throw tooBig();
  }
  try {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const text = await res.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooBig();
      return text;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw tooBig();
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } catch (err) {
    if (err?.code === 'too_big') throw err;
    if (signal?.aborted) throw plainError('timeout', `${site} took too long to answer. Try again in a few minutes.`);
    throw plainError('network', `Couldn’t read what ${site} sent. Try again in a few minutes.`);
  }
}

// One page, feed or reply, as text. `fetchImpl` is for tests; the default is
// the global fetch, looked up when called.
export async function fetchText(url, { fetchImpl, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let u = checkUrl(url);
  const doFetch = fetchImpl || globalThis.fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; ; hop++) {
    const site = siteName(u.hostname.toLowerCase());
    let res;
    try {
      res = await doFetch(u.href, {
        method: 'GET',
        // Redirects are followed by hand, so each one is checked like the
        // first address.
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html, application/rss+xml, application/xml;q=0.9, application/json;q=0.9, */*;q=0.5',
        },
      });
    } catch (err) {
      if (signal.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw plainError('timeout', `${site} took too long to answer. Try again in a few minutes.`);
      }
      throw plainError('network', `Couldn’t reach ${site}. Try again in a few minutes.`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
    if (location) {
      await cancelBody(res);
      if (hop >= MAX_REDIRECTS) throw plainError('redirects', `${site} kept sending the request elsewhere, so it wasn’t followed.`);
      u = checkUrl(new URL(location, u).href, site);
      continue;
    }
    if (!res.ok) {
      await cancelBody(res);
      throw plainError('http_status', `${site} didn’t answer properly (error ${res.status}). Try again in a few minutes.`, { status: res.status });
    }
    return readCapped(res, maxBytes, site, signal);
  }
}

// ── Text out of markup ──────────────────────────────────────────────────────

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', shy: '',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', ndash: '–', mdash: '—', middot: '·', deg: '°', euro: '€', copy: '©', reg: '®',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', oelig: 'œ', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yuml: 'ÿ', ntilde: 'ñ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecirc: 'Ê', Euml: 'Ë', Icirc: 'Î', Iuml: 'Ï', Ocirc: 'Ô', Ouml: 'Ö', OElig: 'Œ', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Ntilde: 'Ñ',
};

// &#039; &#x2019; &amp; &eacute; … to the characters they stand for, once
// (so "&amp;#039;" stays "&#039;", as a browser shows it). Unknown names are
// left as written.
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return Object.hasOwn(NAMED, e) ? NAMED[e] : whole;
  });
}

// An XML element's text: CDATA sections as written, the rest with entities
// decoded.
function xmlText(raw) {
  if (raw == null) return '';
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = re.lastIndex;
  }
  return out + decodeEntities(raw.slice(last));
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// The inside of the first <name …>…</name> in `xml`, or null. A prefixed
// element (<itunes:title>) is a different name and never matches <title>.
function element(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(xml);
  return m ? m[1] : null;
}

// An attribute's value from one tag's text, entities decoded.
function attribute(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2]) : null;
}

// "00:10:00", "10:00" or "600" as seconds.
function durationSeconds(raw) {
  const s = oneLine(xmlText(raw));
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// ── The feed ────────────────────────────────────────────────────────────────

// { title, items: [{ guid, title, published_at, page_url, audio_url,
// duration_seconds }] }, newest first, one item per guid. These are the only
// columns the server writes from a feed (podcast_episodes, migration_017): a
// feed read never touches an episode's transcript, stories or questions.
export function parseFeed(xml) {
  const src = String(xml ?? '');
  const head = src.split(/<item[\s>]/i)[0].replace(/<image(?:\s[^>]*)?>[\s\S]*?<\/image\s*>/gi, '');
  const title = oneLine(xmlText(element(head, 'title')));

  const items = [];
  const seen = new Set();
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
  let m;
  while ((m = itemRe.exec(src))) {
    const body = m[1];
    const enclosureTag = /<enclosure\b[^>]*>/i.exec(body)?.[0] || '';
    const audio = oneLine(attribute(enclosureTag, 'url')) || null;
    const link = oneLine(xmlText(element(body, 'link')));
    const pageUrl = link ? link.split(/[?#]/)[0] : null;
    const guid = oneLine(xmlText(element(body, 'guid'))) || audio || pageUrl;
    const itemTitle = oneLine(xmlText(element(body, 'title')));
    if (!guid || !itemTitle || seen.has(guid)) continue;
    seen.add(guid);
    const when = Date.parse(oneLine(xmlText(element(body, 'pubDate'))));
    items.push({
      guid,
      title: itemTitle,
      published_at: Number.isFinite(when) ? new Date(when).toISOString() : null,
      page_url: pageUrl,
      audio_url: audio,
      duration_seconds: durationSeconds(element(body, 'itunes:duration')),
    });
  }
  // RFI's feeds are already newest first; sorted anyway, undated last.
  items.sort((a, b) => (b.published_at ? Date.parse(b.published_at) : -Infinity) - (a.published_at ? Date.parse(a.published_at) : -Infinity));
  return { title, items };
}

// ── The episode page ────────────────────────────────────────────────────────

// Scripts, styles and comments hold class names too (RFI's inline CSS names
// .t-content__transcription several times), so they go first.
const withoutNoise = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

const classesOf = (tag) => (attribute(tag, 'class') || '').split(/\s+/).filter(Boolean);

// The first tag at or after `from` whose class list has `cls`:
// { index, end, name }, or null.
function findClassTag(src, cls, from = 0) {
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(src))) {
    if (m[0].includes(cls) && classesOf(m[0]).includes(cls)) {
      return { index: m.index, end: re.lastIndex, name: m[1].toLowerCase() };
    }
  }
  return null;
}

// Where the element opened by `open` closes (the index of its closing tag),
// counting nested elements of the same name; null when it never does.
function closingIndex(src, open) {
  const re = new RegExp(`<(/?)${open.name}\\b[^>]*>`, 'gi');
  re.lastIndex = open.end;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) depth--;
    else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0) return m.index;
  }
  return null;
}

// Markup as lines of text: block tags and <br> end a line, other tags go,
// entities are decoded, each line's whitespace becomes single spaces, and
// accents are composed one way (NFC), so a passage's place in its paragraph
// is the same before and after normalizePassage (src/lib/podcastTiming.js).
function textLines(html) {
  const marked = html
    .replace(/<button\b[\s\S]*?<\/button\s*>/gi, '\u0000')
    .replace(/<br\s*\/?>/gi, '\u0000')
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|section|article|header|footer|figure|figcaption|table|tr|td|th)\b[^>]*>/gi, '\u0000')
    // An inline tag (<em>, <span>) sits inside a word as often as between
    // two, so it leaves nothing behind.
    .replace(/<[^>]*>/g, '');
  return decodeEntities(marked).normalize('NFC').split('\u0000').map(oneLine).filter(Boolean);
}

const TIME = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;
const toSeconds = (m) => Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);

// One chapter <li>: its start in seconds and its title, or null.
function chapterOf(li, strict) {
  const lines = textLines(li);
  const timeLine = lines.findIndex((l) => TIME.test(l));
  let t = timeLine >= 0 ? toSeconds(TIME.exec(lines[timeLine])) : null;
  if (t === null) {
    const init = /init-time\s*=\s*["']?(\d+)/i.exec(li);
    t = init ? Number(init[1]) : null;
  }
  // The non-strict reading (no a-chapter class anywhere) only believes an
  // item that starts with its time, as RFI's do.
  if (t === null || (!strict && timeLine !== 0)) return null;
  const label = findClassTag(li, 'a-chapter__label');
  let title = '';
  if (label) {
    const close = closingIndex(li, label);
    title = textLines(li.slice(label.end, close ?? li.length)).join(' ');
  }
  if (!title) title = lines.filter((_, i) => i !== timeLine).join(' ');
  title = oneLine(title);
  return title ? { t, title } : null;
}

function parseChapters(region) {
  const lis = [];
  const re = /<li\b([^>]*)>([\s\S]*?)<\/li\s*>/gi;
  let m;
  while ((m = re.exec(region))) lis.push({ tag: `<li${m[1]}>`, body: m[2] });
  const marked = lis.filter((li) => classesOf(li.tag).includes('a-chapter'));
  const found = (marked.length ? marked : lis)
    .map((li) => chapterOf(li.body, marked.length > 0))
    .filter(Boolean);
  const seen = new Set();
  return found
    .filter((c) => {
      const key = `${c.t}|${c.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.t - b.t);
}

function parseTranscript(src) {
  const open = findClassTag(src, 'm-transcription__content');
  if (!open) return [];
  let end = closingIndex(src, open);
  if (end === null) {
    // Unbalanced markup: stop at what follows the transcript on RFI's pages.
    const after = [src.indexOf('t-content__authors', open.end), src.search(/<\/article\b/i)].filter((i) => i > open.end);
    end = after.length ? Math.min(...after) : src.length;
  }
  return textLines(src.slice(open.end, end)).filter((line) => !/^voir (plus|moins)$/i.test(line));
}

// { paragraphs: [string], stories: [{ t, title }] }. paragraphs is [] when the
// page has no transcript; stories is [] for a podcast without chapters.
export function parseEpisodePage(html) {
  const src = withoutNoise(String(html ?? ''));
  const transcription = findClassTag(src, 't-content__transcription');
  let region;
  if (transcription) region = src.slice(0, transcription.index);
  else {
    // No transcript block: only the page's own chapter list, if it has one.
    const list = findClassTag(src, 'm-chapters');
    const close = list ? closingIndex(src, list) : null;
    region = list ? src.slice(list.index, close ?? src.length) : '';
  }
  return { paragraphs: parseTranscript(src), stories: parseChapters(region) };
}

// ── Spotify ─────────────────────────────────────────────────────────────────

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// What a student pastes: https://open.spotify.com/episode/<id> or /show/<id>,
// with or without a country part (/intl-fr/episode/<id>) and a query string
// (?si=…), or spotify:episode:<id> / spotify:show:<id>. Anything else, null:
// "That doesn’t look like a Spotify link."
export function parseSpotifyLink(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 500) return null;
  const uri = /^spotify:(episode|show):([A-Za-z0-9]{22})$/i.exec(s);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'open.spotify.com' || u.username || u.password || u.port) return null;
  const path = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?(episode|show)\/([A-Za-z0-9]{22})\/?$/i.exec(u.pathname);
  return path ? { type: path[1].toLowerCase(), id: path[2] } : null;
}

// The title Spotify gives the link (oEmbed). For a show link that is its
// latest episode's title. Rejects with a plain Error (code 'bad_link',
// 'not_found', 'bad_reply', or fetchText's own).
export async function spotifyTitle(link, { fetchText: read = fetchText } = {}) {
  const ref = typeof link === 'string' ? parseSpotifyLink(link) : link;
  if (!ref || !['episode', 'show'].includes(ref.type) || !SPOTIFY_ID.test(String(ref.id))) {
    throw plainError('bad_link', 'That doesn’t look like a Spotify link.');
  }
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${ref.type}/${ref.id}`)}`;
  let body;
  try {
    body = await read(url);
  } catch (err) {
    if (err?.status === 404 || err?.status === 400) {
      throw plainError('not_found', 'Spotify couldn’t find that episode or show.', { status: err.status });
    }
    throw err;
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  const title = typeof data?.title === 'string' ? oneLine(data.title) : '';
  if (!title) throw plainError('bad_reply', 'Spotify’s answer couldn’t be read. Try again in a few minutes.');
  return title;
}

// Titles compared the way they are written, give or take what Spotify and
// RFI write differently: curly or straight apostrophes and quotes, "…" or
// "...", spacing, capitals.
export function normalizeTitle(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[’‘ʼ′´`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const withoutEllipsis = (s) => s.replace(/\s*\.{3}$/, '').trim();

// The catalogue podcast and episode a title belongs to: { slug, item }, or
// null. `feedsBySlug` is { slug: parseFeed(…) } (or { slug: items }). An exact
// title wins; failing that, a title that is the start of an episode's title,
// or whose start is the episode's title, at least TITLE_PREFIX_MIN characters
// long; the longest such match wins, and the newest of equal ones.
export function matchTitle(title, feedsBySlug) {
  const want = normalizeTitle(title);
  if (!want) return null;
  const feeds = Object.entries(feedsBySlug || {}).map(([slug, f]) => [slug, Array.isArray(f) ? f : f?.items || []]);
  for (const [slug, items] of feeds) {
    for (const item of items) if (normalizeTitle(item?.title) === want) return { slug, item };
  }
  const a = withoutEllipsis(want);
  let best = null;
  for (const [slug, items] of feeds) {
    for (const item of items) {
      const b = withoutEllipsis(normalizeTitle(item?.title));
      const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
      if (shorter.length >= TITLE_PREFIX_MIN && longer.startsWith(shorter) && (!best || shorter.length > best.n)) {
        best = { slug, item, n: shorter.length };
      }
    }
  }
  return best ? { slug: best.slug, item: best.item } : null;
}
