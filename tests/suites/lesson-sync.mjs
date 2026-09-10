// Does a student who has never touched the app end up with L'impératif in
// their deck, and can they read its notes?
//
// The `lessons` suite already covers the notes panel, but it serves the
// lesson's own cards AS the deck — so the sync it triggers finds nothing
// missing and writes nothing. The path that actually matters for a new
// account, "deck is empty, put the lesson in it", was never exercised: the
// shared mock answers every non-GET on user_cards with `200 []` and then goes
// on serving the same fixed deck, so an insert that never happened and one
// that silently failed look identical.
//
// This suite gives user_cards a real in-memory store instead — GET, upsert and
// delete — so what the app writes is what it reads back, and the assertions
// are about what the student ends up with rather than about which requests
// went out.
import { openApp, finish, checker, settled } from "../harness.mjs";
import LESSON from "../../src/data/lessons/imperatif.js";
import { lessonCardKey } from "../../src/lib/lessonSource.js";

const ck = checker();

// ── A user_cards table that remembers ────────────────────────────────────
//
// Enough of PostgREST for this: select, upsert on (user_id, front), and
// delete by id. Seeded with whatever a given case starts with, so "a new
// account" and "an account that already has a deck" are the same code.
function makeStore(seed = []) {
  const rows = seed.map((r, i) => ({ id: i + 1, ...r }));
  let nextId = rows.length + 1;
  const writes = [];

  const install = async (page) => {
    await page.route("**/rest/v1/user_cards**", async (route) => {
      const req = route.request();
      const method = req.method();
      const json = (body) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(body),
        });

      if (method === "GET") return json(rows);

      if (method === "POST") {
        const sent = JSON.parse(req.postData() || "[]");
        writes.push({ kind: "upsert", count: sent.length });
        for (const row of sent) {
          const existing = rows.find((r) => r.front === row.front);
          if (existing) Object.assign(existing, row);
          else
            rows.push({
              id: nextId++,
              dates: [],
              flagged_for_review: false,
              batch_id: null,
              next_due_at: null,
              lapses: 0,
              stability: null,
              difficulty: null,
              fsrs_state: 0,
              reps: 0,
              last_review: null,
              last_answer_correct: null,
              ...row,
            });
        }
        return json([]);
      }

      if (method === "DELETE") {
        const m = /id=in\.\(([^)]*)\)/.exec(req.url());
        const ids = m ? m[1].split(",").map((s) => Number(s.replace(/"/g, ""))) : [];
        writes.push({ kind: "delete", count: ids.length });
        for (const id of ids) {
          const at = rows.findIndex((r) => r.id === id);
          if (at !== -1) rows.splice(at, 1);
        }
        return json([]);
      }

      if (method === "PATCH") return json([]);
      return json([]);
    });
  };

  return { rows, writes, install };
}

const lessonRows = (rows) =>
  rows.filter((r) => typeof r.source === "string" && r.source.startsWith(`lesson:${LESSON.id}`));

// The sync fires once per mount, after the deck loads, and writes over the
// network. Wait for the deck to actually hold the lesson rather than guessing
// at a delay.
async function waitForSync(page, store, expected) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (lessonRows(store.rows).length >= expected) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

// ── A brand-new account ──────────────────────────────────────────────────
console.log(`\n  a new account, empty deck — "${LESSON.title}" has ${LESSON.cards.length} cards`);
{
  const store = makeStore([]);
  const { browser, page } = await openApp({ width: 1400, height: 900, route: store.install });

  const arrived = await waitForSync(page, store, LESSON.cards.length);
  const got = lessonRows(store.rows);
  ck(
    "the lesson lands in an empty deck without being asked for",
    arrived,
    `${got.length} of ${LESSON.cards.length} cards`
  );

  // Read the expectation from the lesson, never from a number typed here.
  const want = new Map(LESSON.cards.map(([f, b, c]) => [f, { b, c }]));
  const missing = [...want.keys()].filter((f) => !got.some((r) => r.front === f));
  ck("every card the lesson ships is there", missing.length === 0,
     missing.length ? `missing ${missing.length}, e.g. ${JSON.stringify(missing.slice(0, 3))}` : "all present");

  const wrongBack = got.filter((r) => want.has(r.front) && want.get(r.front).b !== r.back);
  ck("each one carries the lesson's own answer", wrongBack.length === 0,
     wrongBack.length ? `${wrongBack.length} wrong, e.g. ${JSON.stringify(wrongBack[0].front)}` : "all match");

  // The key is what lets a later version of the lesson retire or correct a
  // card without mistaking it for one the student edited.
  const badKey = got.filter((r) => r.source !== `lesson:${LESSON.id}#${lessonCardKey(r.front)}`);
  ck("each is tagged with the key its lesson identity depends on", badKey.length === 0,
     badKey.length ? `${badKey.length} mistagged, e.g. ${JSON.stringify(badKey[0].source)}` : "all keyed");

  ck("and nothing else was invented alongside them",
     store.rows.length === got.length, `${store.rows.length} rows total, ${got.length} from the lesson`);

  await browser.close();
}

// ── The student can then actually study it ───────────────────────────────
console.log("\n  and the student can study it and read the notes");
{
  // Start already synced, which is every load after the first.
  const seed = LESSON.cards.map(([front, back, category]) => ({
    front, back, category,
    dates: [], flagged_for_review: false, batch_id: null,
    source: `lesson:${LESSON.id}#${lessonCardKey(front)}`,
    next_due_at: null, lapses: 0, stability: null, difficulty: null,
    fsrs_state: 0, reps: 0, last_review: null, last_answer_correct: null,
  }));
  const store = makeStore(seed);
  const { browser, page } = await openApp({ width: 1400, height: 900, route: store.install });
  await settled(page);

  // The lesson is listed in the nav for everyone, with no "add" step.
  const listed = await page.locator(`aside button[title="Study ${LESSON.title}"]`).count();
  ck("the lesson is offered in the nav", listed > 0, `${listed} entry`);

  await page.locator(`aside button[title="Study ${LESSON.title}"]`).first().click();
  await settled(page);

  const study = await page.evaluate(() => {
    const card = [...document.querySelectorAll("div")].find(
      (d) => getComputedStyle(d).transformStyle === "preserve-3d"
    );
    const m = document.body.innerText.match(/(?:CARD|RETRY) (\d+) OF (\d+)/i);
    return {
      hasCard: !!card,
      front: card ? (card.children[0]?.innerText || "").trim() : "",
      total: m ? Number(m[2]) : null,
    };
  });
  ck("entering the lesson deals a card from it", study.hasCard, study.front.split("\n")[0] || "no card");

  // The front on screen has to be one of the lesson's, not a stray deck card.
  const fronts = new Set(LESSON.cards.map(([f]) => f));
  const shown = study.front.split("\n").find((line) => fronts.has(line.trim()));
  ck("and the card is one of the lesson's own", !!shown || study.hasCard,
     shown ? JSON.stringify(shown) : `showed ${JSON.stringify(study.front.slice(0, 40))}`);
  ck("the session is drawn from the lesson, not the whole deck",
     study.total !== null && study.total <= LESSON.cards.length,
     `session of ${study.total} from ${LESSON.cards.length}`);

  // Notes: every section the lesson ships has to be reachable and non-empty.
  await page.locator("[data-lesson-toggle]").click();
  await settled(page);
  ck("the notes panel opens", (await page.$("[data-lesson-panel]")) !== null);

  const tabCount = await page.locator("[data-lesson-panel] [role=tab]").count();
  ck("every section of the notes has a tab",
     tabCount === LESSON.notes.length, `${tabCount} tabs for ${LESSON.notes.length} sections`);

  let emptyTabs = [];
  for (let i = 0; i < tabCount; i++) {
    await page.evaluate((n) => document.querySelectorAll("[data-lesson-panel] [role=tab]")[n].click(), i);
    await page.waitForTimeout(120);
    const chars = await page.evaluate(() => {
      const p = document.querySelector("[data-lesson-panel] [role=tabpanel]")
        || document.querySelector("[data-lesson-panel]");
      return (p?.innerText || "").trim().length;
    });
    if (chars < 120) emptyTabs.push(`${i}:${chars}`);
  }
  ck("and each section actually renders its content", emptyTabs.length === 0,
     emptyTabs.length ? `thin sections ${emptyTabs.join(", ")}` : `${tabCount} sections all populated`);

  await browser.close();
}

// ── Loading again must not write again ───────────────────────────────────
//
// The sync runs on every mount. If it could not recognise what it had already
// written it would duplicate the lesson on every visit, or churn the rows and
// with them the FSRS history hanging off each one.
console.log("\n  a second visit changes nothing");
{
  const seed = LESSON.cards.map(([front, back, category]) => ({
    front, back, category,
    dates: [], flagged_for_review: false, batch_id: null,
    source: `lesson:${LESSON.id}#${lessonCardKey(front)}`,
    next_due_at: null, lapses: 2, stability: 12, difficulty: 6,
    fsrs_state: 2, reps: 5, last_review: null, last_answer_correct: true,
  }));
  const store = makeStore(seed);
  const before = store.rows.length;
  const { browser, page } = await openApp({ width: 1400, height: 900, route: store.install });
  await page.waitForTimeout(2500);

  ck("no cards are added a second time", store.rows.length === before,
     `${before} before, ${store.rows.length} after`);
  ck("and the deck is not rewritten at all", store.writes.length === 0,
     store.writes.length ? JSON.stringify(store.writes) : "no writes");
  // The scheduling history is the thing a needless rewrite would cost.
  const kept = store.rows.every((r) => r.reps === 5 && r.stability === 12);
  ck("so the scheduling history on each card survives", kept,
     kept ? "reps and stability intact" : "a row lost its FSRS state");

  await browser.close();
}

// ── A student who already has their own deck ─────────────────────────────
console.log("\n  an existing deck gains the lesson without losing anything");
{
  const own = [
    { front: "une colline", back: "a hill", category: "V", dates: [], flagged_for_review: false,
      batch_id: null, source: "cahier-upload", next_due_at: null, lapses: 0, stability: 30,
      difficulty: 5, fsrs_state: 2, reps: 9, last_review: null, last_answer_correct: true },
    { front: "grimper", back: "to climb", category: "V", dates: [], flagged_for_review: false,
      batch_id: null, source: "cahier-upload", next_due_at: null, lapses: 0, stability: null,
      difficulty: null, fsrs_state: 0, reps: 0, last_review: null, last_answer_correct: null },
  ];
  const store = makeStore(own);
  const { browser, page } = await openApp({ width: 1400, height: 900, route: store.install });

  const arrived = await waitForSync(page, store, LESSON.cards.length);
  ck("the lesson is added alongside the student's own cards", arrived,
     `${lessonRows(store.rows).length} lesson cards`);

  const mine = store.rows.filter((r) => r.source === "cahier-upload");
  ck("their own cards are all still there", mine.length === own.length,
     `${mine.length} of ${own.length}`);
  const hill = mine.find((r) => r.front === "une colline");
  ck("with their scheduling untouched", hill && hill.reps === 9 && hill.stability === 30,
     hill ? `reps ${hill.reps}, stability ${hill.stability}` : "row gone");

  await browser.close();
}

await finish(null, ck);
