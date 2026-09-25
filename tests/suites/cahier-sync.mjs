// The cahier that keeps itself up to date: which classes get parsed, what is
// written, and what is left alone. No browser — syncUser is called directly
// with a stand-in database, a stand-in Google Doc and a stand-in Claude.
//
// The rules under test are the owner's (2026-09-24): a class is parsed once
// and never again; classes the deck already has are not parsed at all; a word
// taught again keeps the card it has; nothing is ever deleted. The checks are
// written from those, and the money one — how many Claude calls a run makes —
// is counted at the wire, because that is what a student's teacher pays for.

import { createServer } from "node:http";
import { checker } from "../check.mjs";

const ck = checker();

process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

// Claude, counted. Every parsed class is one call and returns one card named
// after the class it came from, so a card can be traced back to its class.
let claudeCalls = 0;
let claudeFails = false;
// When set, the stand-in answers with exactly these cards instead — for
// replaying what the real model does with a class's grammar section.
let claudeReply = null;
const claude = createServer((req, res) => {
  claudeCalls++;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (claudeFails) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":"nope"}'); }
    // The shape the real model is asked for: a bare JSON array of cards.
    // The block text arrives inside a JSON string, so stop at the first thing
    // that isn't a letter rather than at whitespace.
    const word = /MOT ([A-Za-zéèêàç]+)/.exec(body)?.[1] || "mot";
    const cards = claudeReply || [{ front: word, back: `word ${word}`, category: "V" }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: JSON.stringify(cards) }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise((r) => claude.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;

// The Google Doc. Only docs.google.com is intercepted; everything else (the
// Anthropic SDK's own requests) goes to the real fetch.
const doc = { text: "", status: 200 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("docs.google.com")) {
    return new Response(doc.text, { status: doc.status, headers: { "content-type": "text/plain" } });
  }
  return realFetch(url, init);
};

// A cahier, newest class first, as Laura writes it: one word per class. The
// body is padded because a block of twenty characters or fewer is treated as
// an empty class and dropped, exactly as in a real cahier.
const classText = (day, month, word) =>
  `Le ${day} ${month} 2026\n\nVocabulaire\nMOT ${word}\nExpressions\nune phrase du cours\nGrammaire\nune règle du cours\n\nPour la prochaine fois : rien\n`;
const cahier = (classes) => classes.map(([d, m, w]) => classText(d, m, w)).join("\n\n");

// ── A stand-in for the Supabase service client ─────────────────────────
// Only the calls the sync makes, over plain arrays. Reading it back is how
// the checks below know what was written.
// What the live tables declare NOT NULL. A write that would insert a row
// without them is refused here as Postgres refuses it — the stand-in used to
// wave them through, and a partial upsert that could never work in production
// passed every check (2026-09-25).
const REQUIRED = {
  cahier_links: ["user_id", "doc_id", "doc_url"],
  user_cards: ["user_id", "front", "back"],
};

function fakeAdmin(tables) {
  const match = (row, filters) => filters.every(([col, val, op]) =>
    op === "in" ? val.includes(row[col]) : row[col] === val);
  return {
    tables,
    from(name) {
      const rows = () => (tables[name] ||= []);
      const q = { filters: [], _range: null };
      const run = async () => {
        let out = rows().filter((r) => match(r, q.filters));
        if (q._range) out = out.slice(q._range[0], q._range[1] + 1);
        return { data: out, error: null };
      };
      q.select = () => q;
      q.eq = (col, val) => { q.filters.push([col, val]); return q; };
      q.in = (col, val) => { q.filters.push([col, val, "in"]); return q; };
      q.order = () => q;
      q.range = (a, b) => { q._range = [a, b]; return q; };
      q.maybeSingle = async () => { const { data } = await run(); return { data: data[0] || null, error: null }; };
      q.then = (resolve, reject) => run().then(resolve, reject);
      q.update = (patch) => ({
        eq: async (col, val) => {
          const hit = rows().filter((r) => r[col] === val);
          for (const r of hit) Object.assign(r, patch);
          return { error: null, count: hit.length };
        },
      });
      q.upsert = (payload, opts = {}) => {
        const list = Array.isArray(payload) ? payload : [payload];
        const keys = (opts.onConflict || "id").split(",");
        const written = [];
        const missing = [];
        for (const row of list) {
          // An upsert is an INSERT that resolves a conflict, and Postgres
          // builds and checks that row before it looks for one to conflict
          // with. So a payload missing a NOT NULL column fails even when the
          // row it would have updated is sitting right there — which is
          // exactly how the sync broke in production.
          const absent = (REQUIRED[name] || []).find((k) => row[k] === undefined || row[k] === null);
          if (absent) { missing.push(`null value in column "${absent}" of relation "${name}" violates not-null constraint`); continue; }
          const found = rows().find((r) => keys.every((k) => r[k] === row[k]));
          if (found) { Object.assign(found, row); written.push(found); continue; }
          rows().push({ id: rows().length + 1000, ...row });
          written.push(rows()[rows().length - 1]);
        }
        const result = missing.length
          ? { data: null, error: { message: missing[0], code: "23502" }, count: null }
          : { data: written, error: null, count: written.length };
        const builder = {
          select: () => ({ maybeSingle: async () => ({ data: written[0], error: null }), then: (res) => Promise.resolve(result).then(res) }),
          then: (res, rej) => Promise.resolve(result).then(res, rej),
        };
        return builder;
      };
      return q;
    },
  };
}

const { syncUser } = await import("../../api/cahier-sync.js");
const USER = "student-1";
const URL_1 = "https://docs.google.com/document/d/DOC1/edit?tab=t.0";
// The endpoint catches whatever syncUser throws and answers 500, so a check
// here reads a thrown error as the failure it is rather than ending the run.
const run = (admin, opts = {}) =>
  syncUser({ admin, apiKey: "sk-test", userId: USER, force: true, ...opts })
    .catch((e) => ({ ok: false, error: e.message, threw: true }));
const deck = (admin) => admin.tables.user_cards || [];
const link = (admin) => (admin.tables.cahier_links || [])[0];

console.log("\n  linking a doc parses only the classes the deck hasn't got");
{
  // The deck already holds the 5 September class; the doc has three more.
  const admin = fakeAdmin({
    user_cards: [{ id: 1, user_id: USER, front: "déjà", back: "already", category: "V", dates: ["2026-09-05"], source: "cahier-upload" }],
    cahier_links: [],
  });
  doc.text = cahier([[8, "septembre", "alpha"], [5, "septembre", "vieux"], [4, "septembre", "ancien"]]);
  claudeCalls = 0;
  const r = await run(admin, { url: URL_1 });
  ck("it says which classes were new", r.ok && JSON.stringify(r.newClasses) === '["2026-09-04","2026-09-08"]', JSON.stringify(r));
  ck("the class already in the deck is not parsed", claudeCalls === 2, `${claudeCalls} Claude calls`);
  ck("one call per class parsed, and no more", claudeCalls === r.newClasses.length, `${claudeCalls} for ${r.newClasses.length}`);
  ck("the run that linked it also records when it looked", !!link(admin).last_checked_at && !!link(admin).last_synced_at,
     `${link(admin).last_checked_at} / ${link(admin).last_synced_at}`);
  ck("its cards are in the deck", deck(admin).some((c) => c.front === "alpha") && deck(admin).some((c) => c.front === "ancien"), JSON.stringify(deck(admin).map((c) => c.front)));
  ck("the card the deck already had is untouched", deck(admin)[0].back === "already" && deck(admin)[0].dates.length === 1);
  ck("and the classes it read are remembered", Object.keys(link(admin).classes).sort().join(",").includes("2026-09-08"), JSON.stringify(link(admin).classes));
}

console.log("\n  a class is parsed once and never again");
{
  const admin = fakeAdmin({ user_cards: [], cahier_links: [] });
  doc.text = cahier([[10, "septembre", "alpha"], [9, "septembre", "beta"]]);
  await run(admin, { url: URL_1 });
  const cardsAfterFirst = deck(admin).length;
  claudeCalls = 0;
  const again = await run(admin);
  ck("a second check with nothing new parses nothing", claudeCalls === 0 && again.cardsAdded === 0 && again.remaining === 0, JSON.stringify(again));
  // Every run records when it ran, whether or not it found anything: the app
  // shows it as "last checked", and a run that can't record it is a run that
  // failed. This is what the sync did in production on 2026-09-25 — the row
  // was linked and never checked.
  ck("and records that it looked", !!link(admin).last_checked_at, JSON.stringify(link(admin).last_checked_at));
  ck("and adds no cards", deck(admin).length === cardsAfterFirst, `${deck(admin).length} vs ${cardsAfterFirst}`);

  // Laura edits the 9 September class and deletes a line from it.
  doc.text = cahier([[10, "septembre", "alpha"], [9, "septembre", "gamma"]]);
  claudeCalls = 0;
  const edited = await run(admin);
  ck("editing an old class changes nothing: it is not parsed", claudeCalls === 0 && edited.cardsAdded === 0, JSON.stringify(edited));
  ck("and no card is rewritten or removed",
     deck(admin).length === cardsAfterFirst && deck(admin).some((c) => c.front === "beta") && !deck(admin).some((c) => c.front === "gamma"),
     JSON.stringify(deck(admin).map((c) => c.front)));

  // A new class on top.
  doc.text = cahier([[11, "septembre", "delta"], [10, "septembre", "alpha"], [9, "septembre", "gamma"]]);
  claudeCalls = 0;
  const fresh = await run(admin);
  ck("a class added since is parsed, and only it", claudeCalls === 1 && JSON.stringify(fresh.newClasses) === '["2026-09-11"]', JSON.stringify(fresh));
  ck("its cards arrive", deck(admin).some((c) => c.front === "delta"));
}

console.log("\n  a word taught again keeps the card the student has");
{
  const admin = fakeAdmin({
    user_cards: [{ id: 1, user_id: USER, front: "alpha", back: "an answer the student edited", category: "V", dates: ["2026-01-10"], source: "cahier-upload" }],
    cahier_links: [{ user_id: USER, doc_id: "DOC1", doc_url: URL_1, classes: {} }],
  });
  doc.text = cahier([[12, "septembre", "alpha"]]);
  const r = await run(admin);
  const card = deck(admin).find((c) => c.front === "alpha");
  ck("no second card for the same word", deck(admin).filter((c) => c.front === "alpha").length === 1, `${deck(admin).length} cards`);
  ck("its answer is left exactly as it was", card.back === "an answer the student edited", card.back);
  ck("but the new class is added to the classes it came up in",
     JSON.stringify(card.dates) === '["2026-01-10","2026-09-12"]', JSON.stringify(card.dates));
  ck("and it is reported as seen again, not as new", r.cardsAdded === 0 && r.cardsSeenAgain === 1, JSON.stringify(r));
}

console.log("\n  a class's grammar rules and sound notes never reach the deck");
{
  // The owner's rule (2026-09-24): a card must be answerable by typing. So a
  // rule or a pronunciation note is not a card, a word that sat under the
  // grammar heading is an ordinary one, and a conjugation table becomes its
  // drills and nothing else. This replays a model that ignored the prompt and
  // tagged the whole grammar section G, as it did for as long as it was told
  // to tag by position — the sync runs unattended, so nothing else catches it.
  const admin = fakeAdmin({ user_cards: [], cahier_links: [] });
  doc.text = cahier([[13, "septembre", "grammaire"]]);
  claudeReply = [
    { front: "une colline", back: "a hill", category: "V" },
    { front: "Pronoms toniques", back: "moi, toi, lui/elle…", category: "G" },
    { front: "qui = sujet / que = COD", back: "qui = subject / que = direct object", category: "G" },
    { front: "du riz {ri}", back: "riz: silent z", category: "G" },
    { front: "mon copain", back: "my boyfriend", category: "G" },
    { front: "devoir → participe passé", back: "dû", category: "G" },
    {
      front: "vivre : je vis, tu vis, il vit, nous vivons, vous vivez, ils vivent",
      back: "to live (present tense)", category: "G",
      conjugation: true, infinitive: "vivre", tense: "présent",
      forms: ["je vis", "tu vis", "il vit", "nous vivons", "vous vivez", "ils vivent"],
    },
  ];
  claudeCalls = 0;
  const r = await run(admin, { url: URL_1 });
  claudeReply = null;
  const fronts = deck(admin).map((c) => c.front);
  const card = (front) => deck(admin).find((c) => c.front === front);
  ck("the class is read, once", r.ok && claudeCalls === 1, JSON.stringify(r));
  ck("no grammar-rule card is written",
     !fronts.includes("Pronoms toniques") && !fronts.includes("qui = sujet / que = COD"), JSON.stringify(fronts));
  ck("no pronunciation card is written", !fronts.some((f) => f.includes("{")), JSON.stringify(fronts));
  ck("a plain word from the grammar section is an ordinary card", card("mon copain")?.category === "V", JSON.stringify(card("mon copain")));
  ck("a drill stays a grammar card", card("devoir → participe passé")?.category === "G", JSON.stringify(card("devoir → participe passé")));
  ck("a conjugation table becomes one drill per form",
     ["je", "tu", "il/elle", "nous", "vous", "ils/elles"].every((p) => card(`vivre (présent) → ${p}`)?.category === "G"),
     JSON.stringify(fronts));
  ck("and the table itself, which answers itself, is not written",
     !fronts.some((f) => f.startsWith("vivre :")), JSON.stringify(fronts));
  ck("vocabulary is untouched", card("une colline")?.category === "V");
  // une colline, mon copain, the dû drill, and vivre's six.
  ck("and what was added is what it reports", r.cardsAdded === deck(admin).length && deck(admin).length === 3 + 6,
     `${r.cardsAdded} reported, ${deck(admin).length} in the deck`);
}

console.log("\n  a long backlog is worked through in runs, newest class first");
{
  const admin = fakeAdmin({ user_cards: [], cahier_links: [] });
  doc.text = cahier([[20, "septembre", "a"], [19, "septembre", "b"], [18, "septembre", "c"], [17, "septembre", "d"], [16, "septembre", "e"]]);
  claudeCalls = 0;
  const first = await run(admin, { url: URL_1, limit: 2 });
  ck("a run parses at most what it was asked for", claudeCalls === 2 && first.cardsAdded === 2, `${claudeCalls} calls`);
  ck("the newest classes come first", JSON.stringify(first.newClasses) === '["2026-09-19","2026-09-20"]', JSON.stringify(first.newClasses));
  ck("and it says how many classes are left", first.remaining === 3, `${first.remaining}`);
  const second = await run(admin, { limit: 2 });
  ck("the next run carries on where it stopped", JSON.stringify(second.newClasses) === '["2026-09-17","2026-09-18"]', JSON.stringify(second.newClasses));
  const third = await run(admin, { limit: 2 });
  ck("and the last run finishes it", third.remaining === 0 && deck(admin).length === 5, `${deck(admin).length} cards, ${third.remaining} left`);
}

console.log("\n  when the doc can't be read, it says so");
{
  const admin = fakeAdmin({ user_cards: [], cahier_links: [] });
  doc.text = cahier([[21, "septembre", "a"]]);
  await run(admin, { url: URL_1 });
  doc.status = 403;
  claudeCalls = 0;
  const r = await run(admin);
  ck("sharing turned off is reported, not swallowed", !r.ok && /publicly viewable/i.test(r.error), JSON.stringify(r));
  ck("the reason is kept for the app to show", /publicly viewable/i.test(link(admin).last_error || ""), link(admin).last_error);
  ck("nothing was parsed or written", claudeCalls === 0 && deck(admin).length === 1);
  doc.status = 200;

  doc.text = "a document with no class dates at all, just prose\n".repeat(10);
  const noDates = await run(admin);
  ck("a doc without class dates explains what is expected", !noDates.ok && /Le 24 septembre/.test(noDates.error), noDates.error);

  // Claude itself failing leaves the class unread, to be tried again.
  doc.text = cahier([[22, "septembre", "zeta"], [21, "septembre", "a"]]);
  claudeFails = true;
  const failed = await run(admin);
  claudeFails = false;
  ck("a class Claude can't read is reported", !failed.ok, JSON.stringify(failed).slice(0, 120));
  ck("and is left for the next run rather than lost",
     !(("2026-09-22") in (link(admin).classes || {})), JSON.stringify(Object.keys(link(admin).classes || {})));
  const retry = await run(admin);
  ck("which picks it up", retry.ok && JSON.stringify(retry.newClasses) === '["2026-09-22"]', JSON.stringify(retry.newClasses));
}

console.log("\n  two checks at once don't pay twice");
{
  const admin = fakeAdmin({ user_cards: [], cahier_links: [] });
  doc.text = cahier([[23, "septembre", "a"]]);
  await run(admin, { url: URL_1 });
  doc.text = cahier([[24, "septembre", "b"], [23, "septembre", "a"]]);
  claudeCalls = 0;
  const soon = await syncUser({ admin, apiKey: "sk-test", userId: USER }).catch((e) => ({ error: e.message }));
  ck("a check seconds after the last one is skipped", claudeCalls === 0 && soon.skipped, JSON.stringify(soon));
  const forced = await run(admin);
  ck("asking for it anyway still works", forced.ok && forced.cardsAdded === 1, JSON.stringify(forced));
}

console.log("\n  a student with no linked doc is a no-op");
{
  const admin = fakeAdmin({ user_cards: [], cahier_links: [] });
  claudeCalls = 0;
  const r = await syncUser({ admin, apiKey: "sk-test", userId: USER }).catch((e) => ({ error: e.message }));
  ck("nothing happens, and nothing is spent", r.ok && r.linked === false && claudeCalls === 0, JSON.stringify(r));
  const bad = await run(admin, { url: "https://example.com/not-a-doc" });
  ck("a link that isn't a Google Doc is refused", !bad.ok && /Google Doc link/.test(bad.error), bad.error);
}

console.log("\n  the daily check runs for Vercel's cron and nobody else");
{
  // It spends the deploy owner's credit on every linked cahier, so a URL
  // anyone could call would be a way to spend it.
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const { default: daily } = await import("../../api/cahier-daily.js");
  const fakeRes = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  claudeCalls = 0;

  delete process.env.CRON_SECRET;
  const unset = fakeRes();
  await daily({ method: "GET", headers: {} }, unset);
  ck("with no cron secret set it refuses to run at all", unset.code === 500 && /CRON_SECRET/.test(unset.body?.error || ""), JSON.stringify(unset.body));

  process.env.CRON_SECRET = "the-secret";
  const anon = fakeRes();
  await daily({ method: "GET", headers: {} }, anon);
  ck("a caller without the secret is refused", anon.code === 401, `HTTP ${anon.code}`);

  const wrong = fakeRes();
  await daily({ method: "GET", headers: { authorization: "Bearer not-the-secret" } }, wrong);
  ck("so is a caller with the wrong one", wrong.code === 401, `HTTP ${wrong.code}`);
  ck("and neither spent anything", claudeCalls === 0, `${claudeCalls} Claude calls`);
}

claude.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
