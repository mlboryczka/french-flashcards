// How an answer reaches FSRS on the paths that aren't the happy one. Each check
// is judged by what was written to user_cards, not by what the screen says,
// because every one of these bugs looked right on screen.
//
// Found on 2026-09-14 by driving every exception path in a study session.
import { openApp, finish, checker, sessionCounter, cardBox, servedDeck, gotoStats, nullViolation } from "../harness.mjs";
import { SIDE_FIELDS } from "../../src/lib/directions.js";

const ck = checker();
const DAY = 86400000;
const CORS = { "access-control-allow-origin": "*" };

// `rows`: serve this deck instead of the mock's, and apply each successful
// write to it, so a reload sees what was saved.
// `apiDelay`: how long "My answer should be accepted" takes to answer.
async function open({ patchStatus, api, apiDelay = 0, studyMode, rows } = {}) {
  const writes = [];
  const reviews = [];
  const state = { patchStatus: patchStatus ?? 200 };
  const { browser, page } = await openApp({
    studyMode,
    route: async (p) => {
      await p.route("**/rest/v1/user_cards*", async (r) => {
        const method = r.request().method();
        if (method === "PATCH") {
          const body = JSON.parse(r.request().postData() || "{}");
          writes.push({ at: Date.now(), status: state.patchStatus, url: r.request().url(), body });
          if (state.patchStatus !== 200) {
            return r.fulfill({ status: state.patchStatus, contentType: "application/json", headers: CORS, body: '{"message":"unavailable"}' });
          }
          const bad = nullViolation(body);
          if (bad) {
            writes[writes.length - 1].status = 400;
            return r.fulfill({ status: 400, contentType: "application/json", headers: CORS, body: JSON.stringify({ code: "23502", message: `null value in column "${bad}" violates not-null constraint` }) });
          }
          if (rows) {
            const q = new URL(r.request().url()).searchParams;
            const id = q.get("id")?.replace(/^eq\./, "");
            for (const row of rows) if (id === undefined || String(row.id) === id) Object.assign(row, body);
            return r.fulfill({ status: 204, headers: CORS, body: "" });
          }
        }
        if (rows && method === "GET") {
          return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(rows) });
        }
        return r.continue();
      });
      await p.route("**/rest/v1/card_reviews*", async (r) => {
        // Read back as the database would: the records saved so far.
        if (r.request().method() === "GET") {
          const byId = new Map();
          for (const x of reviews) if (x.body?.id) byId.set(x.body.id, x.body);
          return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify([...byId.values()]) });
        }
        reviews.push({ method: r.request().method(), url: r.request().url(), body: JSON.parse(r.request().postData() || "{}") });
        return r.fulfill({ status: 201, headers: CORS, body: "" });
      });
      if (api) await p.route("**/api/review-answer", async (r) => {
        await new Promise((res) => setTimeout(res, apiDelay));
        await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api) }).catch(() => {});
      });
    },
  });
  const click = (t) => page.evaluate((x) => {
    const b = [...document.querySelectorAll("button")].find((n) => n.innerText.trim() === x);
    b?.click();
    return !!b;
  }, t);
  const has = (re) => page.evaluate(([s, f]) => new RegExp(s, f).test(document.body.innerText), [re.source, re.flags]);
  const typing = () => page.evaluate(() => !!document.querySelector("input[placeholder^='Type ']"));
  const wait = (ms = 400) => page.waitForTimeout(ms);
  const grades = () => writes.filter((w) => w.status === 200).map((w) => w.body.last_answer_correct ?? w.body.en_last_answer_correct);
  // Wait for a write rather than for a length of time. Reset sends one write
  // for the whole deck, and on a slow run it left after the check had already
  // read an empty list — which reads as "the reset wrote nothing", the one
  // thing that check exists to catch.
  const waitForWrite = async (match, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = writes.find(match);
      if (hit) return hit;
      await page.waitForTimeout(100);
    }
    return null;
  };
  // Type an answer and check it, for suites opened in typing mode.
  const typeCheck = async (text) => {
    await page.waitForSelector("input[placeholder^='Type ']", { timeout: 8000 });
    await page.fill("input[placeholder^='Type ']", text);
    await click("Check");
    await page.waitForFunction(() => /Continue →/.test(document.body.innerText), null, { timeout: 5000 });
    await wait(150);
  };
  const result = () => page.evaluate(() => (document.body.innerText.match(/^(✓|✗|Answer:).*$/m) || [""])[0]);
  const counter = () => page.evaluate(() => (document.body.innerText.match(/CARD \d+ OF \d+[^\n]*/i) || [""])[0]);
  return { browser, page, writes, reviews, state, click, has, typing, wait, grades, waitForWrite, typeCheck, result, counter };
}

// Which way round a write went: every key a French-side column, or every key
// an English-side one. Anything else is a write that touched both, or neither.
const EN_FIELDS = SIDE_FIELDS.map((f) => `en_${f}`);
const sideOfWrite = (body) => {
  const keys = Object.keys(body);
  if (keys.length && keys.every((k) => SIDE_FIELDS.includes(k))) return "fr";
  if (keys.length && keys.every((k) => EN_FIELDS.includes(k))) return "en";
  return `mixed(${keys.join(",")})`;
};
// A word due both ways round, with different histories each way so a write
// computed from the wrong side shows; and a grammar rule, due as written.
const twoWayDeck = () => [
  { id: 101, front: "une colline", back: "a hill", category: "V", dates: ["2026-01-10"], flagged_for_review: false, batch_id: null, source: "cahier-upload",
    fsrs_state: 2, stability: 5, difficulty: 5, reps: 4, lapses: 0, next_due_at: new Date(Date.now() - DAY).toISOString(),
    last_review: new Date(Date.now() - 6 * DAY).toISOString(), last_answer_correct: true,
    en_fsrs_state: 2, en_stability: 2, en_difficulty: 8, en_reps: 9, en_lapses: 3, en_next_due_at: new Date(Date.now() - DAY).toISOString(),
    en_last_review: new Date(Date.now() - 3 * DAY).toISOString(), en_last_answer_correct: false },
  { id: 102, front: "vivre → nous", back: "nous vivons", category: "G", dates: ["2026-01-10"], flagged_for_review: false, batch_id: null, source: "cahier-upload",
    fsrs_state: 2, stability: 4, difficulty: 5, reps: 2, lapses: 0, next_due_at: new Date(Date.now() - DAY).toISOString(),
    last_review: new Date(Date.now() - 5 * DAY).toISOString(), last_answer_correct: true },
];
// Words due French side up today, their English side answered two days ago
// and not due: every card is asked the same way round, so each prompt's
// answer is known.
const frenchSideDeck = (n = 6) => [
  ["une colline", "a hill"], ["la fenêtre", "the window"], ["lentement", "slowly"], ["le bruit", "the noise"],
  ["ouvrir", "to open"], ["chercher", "to look for"], ["le chemin", "the path"], ["la moitié", "half"],
].slice(0, n).map(([front, back], i) => ({
  id: 201 + i, front, back, category: "V", dates: ["2026-06-01"], flagged_for_review: false, batch_id: null, source: "cahier-upload",
  fsrs_state: 2, stability: 5, difficulty: 5, reps: 3, lapses: 0, next_due_at: new Date(Date.now() - DAY).toISOString(),
  last_review: new Date(Date.now() - 6 * DAY).toISOString(), last_answer_correct: true,
  en_fsrs_state: 2, en_stability: 30, en_difficulty: 5, en_reps: 3, en_lapses: 0, en_next_due_at: new Date(Date.now() + 25 * DAY).toISOString(),
  en_last_review: new Date(Date.now() - 2 * DAY).toISOString(), en_last_answer_correct: true,
}));
const rowOnScreen = async (page, deck) => { const front = (await cardBox(page))?.front; return deck.find((r) => r.front === front); };
const writesFor = (t, id) => t.writes.filter((w) => w.status === 200 && w.url.includes(`id=eq.${id}`)).map((w) => w.body.last_answer_correct);
const recordsFor = (t, id) => t.reviews.map((r) => r.body).filter((b) => b.card_id === id);

// The way round the card on screen is asked, read off its prompt.
const shownWay = async (page, deck) => {
  const front = (await cardBox(page))?.front;
  const row = deck.find((r) => r.front === front || r.back === front);
  return row ? { row, dir: row.front === front ? "fr" : "en" } : { row: null, dir: null, front };
};

console.log("\n  an accepted dispute is recorded as right");
{
  const t = await open({ api: { verdict: "accept", reasoning: "A fair synonym." } });
  await t.click("Type answer"); await t.wait();
  await t.page.fill("input[placeholder^='Type ']", "zzzz");
  await t.click("Check"); await t.wait(500);
  ck("the typed answer is marked wrong first", await t.has(/You wrote: zzzz/));
  await t.click("My answer should be accepted"); await t.wait(800);
  ck("the dispute is accepted", await t.has(/Accepted/));
  await t.click("Continue →"); await t.wait(600);
  ck("and Continue records the card as right, not as the miss the matcher called",
     JSON.stringify(t.grades()) === "[true]", JSON.stringify(t.grades()));
  await t.browser.close();
}

console.log("\n  a mistaken grade can be corrected with Previous card");
{
  const t = await open();
  // Each step waits for what it needs on screen rather than a fixed time: this
  // is the first browser suite, often run against a dev server still warming
  // up, and a click on a button not yet rendered misses silently.
  const button = (label) => t.page.waitForSelector(`button:text-is("${label}")`, { timeout: 8000 }).catch(() => null);
  await t.page.keyboard.press(" "); await button("Got It");
  await t.click("Got It");
  await t.page.waitForFunction(() => /Card 2 of/i.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  await t.wait(300);
  // The first card may be asked either way round; read whichever side it wrote.
  const field = (w, f) => w?.body[f] ?? w?.body[`en_${f}`];
  const firstDue = field(t.writes[0], "next_due_at");
  await t.click("Previous card");
  await t.page.waitForFunction(() => /Card 1 of/i.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  await t.page.keyboard.press(" "); await button("Again");
  await t.click("Again");
  await t.page.waitForFunction(() => /Card 2 of/i.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  await t.wait(300);
  ck("the correction is recorded", JSON.stringify(t.grades()) === "[true,false]", JSON.stringify(t.grades()));
  ck("recomputed from the card as it was, so the miss brings it back sooner",
     !!firstDue && new Date(field(t.writes[1], "next_due_at")) < new Date(firstDue),
     `${firstDue} → ${field(t.writes[1], "next_due_at")}`);
  ck("and reps counts one review for the day, not two",
     field(t.writes[1], "reps") === field(t.writes[0], "reps"), `${field(t.writes[0], "reps")} → ${field(t.writes[1], "reps")}`);
  const c = await sessionCounter(t.page);
  ck("the correction did not add an answer to the block", c?.index === 2, JSON.stringify(c));
  await t.browser.close();
}

console.log("\n  a typed answer is never thrown away");
{
  const t = await open();
  await t.click("Type answer"); await t.wait();
  await t.page.fill("input[placeholder^='Type ']", "half typed");
  await t.page.keyboard.press("Escape"); await t.wait(400);
  ck("Escape clears the box", (await t.page.inputValue("input[placeholder^='Type ']")) === "");
  ck("and gives nothing up: no answer shown, nothing recorded",
     !(await t.has(/Answer:/)) && t.writes.length === 0 && await t.typing());
  await t.page.fill("input[placeholder^='Type ']", "zzzz");
  const box = await cardBox(t.page);
  await t.page.mouse.click(box.centreX, Math.round((box.top + box.bottom) / 2));
  await t.wait(600);
  ck("tapping the card with an answer typed checks that answer", await t.has(/You wrote: zzzz/));
  await t.browser.close();
}

console.log("\n  a save that fails is shown, and retried");
{
  const t = await open({ patchStatus: 503 });
  await t.page.keyboard.press(" "); await t.wait(500);
  await t.click("Got It"); await t.wait(1000);
  ck("the student is told the answer isn't saved", await t.has(/1 answer not saved yet/));
  t.state.patchStatus = 200;
  await t.page.waitForFunction(() => !document.querySelector("[data-unsaved]"), null, { timeout: 15000 }).catch(() => {});
  ck("once the server is back, it is retried and the notice goes",
     !(await t.page.$("[data-unsaved]")) && t.grades().length === 1,
     `${t.writes.length} attempts, ${t.grades().length} saved`);
  await t.browser.close();
}

console.log("\n  each answer is saved to the way round it was shown");
{
  const deck = twoWayDeck();
  const t = await open({ rows: deck });
  const shown = [];
  for (let i = 0; i < 3; i++) {
    shown.push(await shownWay(t.page, deck));
    await t.page.keyboard.press(" "); await t.wait(400);
    await t.click("Got It"); await t.wait(500);
  }
  ck("the block asks the word both ways and the rule as written",
     shown.map((x) => `${x.row?.id}:${x.dir}`).sort().join(" ") === "101:en 101:fr 102:fr",
     JSON.stringify(shown.map((x) => [x.row?.id, x.dir, x.front])));
  const saved = t.writes.filter((w) => w.status === 200);
  ck("one write per answer", saved.length === 3, `${saved.length}`);
  ck("each write touches only the columns of the way round that was on screen",
     saved.every((w, i) => sideOfWrite(w.body) === shown[i].dir),
     JSON.stringify(saved.map((w, i) => [shown[i].dir, sideOfWrite(w.body)])));
  const enWrite = saved.find((w) => sideOfWrite(w.body) === "en")?.body;
  const frWrite = saved.find((w, i) => shown[i].row?.id === 101 && shown[i].dir === "fr")?.body;
  ck("and is computed from that way's own history: English reps 9 → 10, French 4 → 5",
     enWrite?.en_reps === 10 && frWrite?.reps === 5, `en ${enWrite?.en_reps}, fr ${frWrite?.reps}`);
  const rec = t.reviews.map((r) => r.body);
  ck("every answer is kept as a record, with its way round",
     rec.length === 3 && rec.every((b, i) => b.card_id === shown[i].row.id && b.direction === shown[i].dir && b.counted === true && b.correct === true),
     JSON.stringify(rec.map((b) => [b.card_id, b.direction, b.counted, b.correct])));
  ck("each record its own", new Set(rec.map((b) => b.id)).size === 3);
  await t.browser.close();
}

console.log("\n  correcting a grade keeps the two ways apart");
{
  const deck = twoWayDeck().slice(0, 1);
  const t = await open({ rows: deck });
  const first = await shownWay(t.page, deck);
  await t.page.keyboard.press(" "); await t.wait(400); await t.click("Got It"); await t.wait(500);
  const second = await shownWay(t.page, deck);
  await t.page.keyboard.press(" "); await t.wait(400); await t.click("Got It"); await t.wait(500);
  ck("the word came up both ways", [first.dir, second.dir].sort().join("+") === "en+fr", `${first.dir}, ${second.dir}`);
  await t.click("Previous card"); await t.wait(500);
  const fixing = await shownWay(t.page, deck);
  const earlierAnswer = fixing.dir === first.dir ? 0 : 1;
  await t.page.keyboard.press(" "); await t.wait(400); await t.click("Again"); await t.wait(600);
  const saved = t.writes.filter((w) => w.status === 200);
  const fix = saved[2]?.body || {};
  ck("the correction is written to the way it was asked, and only that way",
     saved.length === 3 && !!fixing.dir && sideOfWrite(fix) === fixing.dir &&
       fix[fixing.dir === "en" ? "en_last_answer_correct" : "last_answer_correct"] === false,
     `correcting ${fixing.dir}: ${JSON.stringify(saved.map((w) => sideOfWrite(w.body)))}`);
  const rec = t.reviews.map((r) => r.body);
  ck("and rewrites that answer's record rather than adding one",
     rec.length === 3 && rec[2].id === rec[earlierAnswer].id && rec[2].direction === fixing.dir && rec[2].correct === false && rec[0].id !== rec[1].id,
     JSON.stringify(rec.map((b) => [b.id.slice(0, 6), b.direction, b.correct])));
  await t.browser.close();
}

console.log("\n  an unsaved answer is not lost to an answer the other way round");
{
  const deck = twoWayDeck().slice(0, 1);
  const t = await open({ rows: deck, patchStatus: 503 });
  for (let i = 0; i < 2; i++) {
    await t.page.keyboard.press(" "); await t.wait(400); await t.click("Got It"); await t.wait(700);
  }
  ck("both answers are waiting", await t.has(/2 answers not saved yet/));
  t.state.patchStatus = 200;
  await t.page.waitForFunction(() => !document.querySelector("[data-unsaved]"), null, { timeout: 20000 }).catch(() => {});
  const saved = t.writes.filter((w) => w.status === 200).map((w) => sideOfWrite(w.body));
  ck("once the server is back, both are saved, one each way",
     !(await t.page.$("[data-unsaved]")) && saved.includes("fr") && saved.includes("en"), JSON.stringify(saved));
  await t.browser.close();
}

console.log("\n  changing direction re-deals the rest of the block, without a new block");
{
  const deck = await servedDeck();
  const wordFronts = new Set(deck.filter((r) => r.category === "V" || r.category === "E").map((r) => r.front));
  const t = await open();
  for (let i = 0; i < 3; i++) {
    await t.page.keyboard.press(" "); await t.wait(400);
    await t.click("Got It"); await t.wait(400);
  }
  const before = await sessionCounter(t.page);
  await t.click("English → French"); await t.wait(600);
  const after = await sessionCounter(t.page);
  ck("the block carries on where it was, no longer than it was",
     after?.index === before?.index && after?.total <= before?.total,
     `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  const prompts = [];
  for (let guard = 0; guard < 60 && !(await t.page.$("[data-checkpoint]")); guard++) {
    prompts.push((await cardBox(t.page))?.front);
    await t.page.keyboard.press(" "); await t.wait(300);
    await t.click("Got It"); await t.wait(350);
  }
  const frenchWords = prompts.filter((p) => wordFronts.has(p));
  ck("every word or phrase left in the block is asked in English", prompts.length > 0 && frenchWords.length === 0,
     `${prompts.length} cards; asked in French: ${frenchWords.join(", ")}`);
  ck("grammar is still asked, as written", prompts.some((p) => deck.some((r) => r.category === "G" && p && r.front.startsWith(p))),
     prompts.join(" | "));
  await t.browser.close();
}

console.log("\n  Reset all progress resets both ways round, on every card, and the streak");
{
  const deck = twoWayDeck();
  // Three days studied, today among them, so the streak reads 3.
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  let days = [0, 1, 2].map((n) => ({ review_date: day(n) }));
  const streakDeletes = [];
  const dialogs = [];
  const t = await open({ rows: deck });
  t.page.on("dialog", (d) => dialogs.push(d.message()));
  await t.page.route("**/rest/v1/user_review_dates*", async (r) => {
    const m = r.request().method();
    if (m === "GET") return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(days) });
    if (m === "DELETE") {
      streakDeletes.push(r.request().url());
      const gone = days; days = [];
      return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(gone) });
    }
    return r.continue();
  });
  await t.page.reload({ waitUntil: "commit" });
  await t.page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await t.wait(1500);
  await gotoStats(t.page);
  const streakNow = () => t.page.evaluate(() => Number(/(\d+)\s*day streak/i.exec(document.body.innerText)?.[1]));
  ck("before: a three-day streak", (await streakNow()) === 3, `${await streakNow()}`);
  await t.click("Reset all progress");
  const reset = await t.waitForWrite((w) => /user_id=eq\./.test(w.url));
  await t.wait(800);
  const expected = [...SIDE_FIELDS, ...EN_FIELDS];
  ck("one write, for every card of this student, and the database accepts it",
     !!reset && reset.status === 200, JSON.stringify(t.writes.map((w) => [w.status, w.url.split("?")[1]])));
  // Every schedule column is written. Counts go to 0 and the rest to empty —
  // except the French side's due date, which the table won't hold empty; for a
  // never-answered card it is never read.
  const zeroes = ["fsrs_state", "reps", "lapses", "en_fsrs_state", "en_reps", "en_lapses"];
  ck("clearing every schedule column, both ways",
     !!reset && expected.every((k) => k in reset.body) &&
       expected.every((k) => zeroes.includes(k) ? reset.body[k] === 0
         : k === "next_due_at" ? !Number.isNaN(Date.parse(reset.body[k]))
         : reset.body[k] === null),
     JSON.stringify(reset?.body));
  ck("no error shown", !(await t.has(/couldn't be reset/)));
  await gotoStats(t.page);
  const all = await t.page.evaluate(() => document.querySelector("[data-stats-all]")?.innerText.replace(/\s+/g, " ") || "");
  ck("and afterwards every card reads not yet seen", all.includes(`${deck.length} not yet seen`), all);
  ck("no answer record was removed", !t.reviews.some((r) => r.method === "DELETE"));
  ck("the streak is cleared: this student's days are deleted", streakDeletes.length === 1 && /user_id=eq\./.test(streakDeletes[0]),
     JSON.stringify(streakDeletes));
  ck("and reads 0", (await streakNow()) === 0, `${await streakNow()}`);
  ck("the warning never mentions which way round a card is asked",
     dialogs.length > 0 && dialogs.every((m) => !/both ways|round|French|English/i.test(m)), JSON.stringify(dialogs));
  await t.browser.close();
}

console.log("\n  a streak the database silently refuses to clear is reported, not hidden");
{
  // Row security that forbids the delete answers success with nothing deleted.
  const day0 = new Date();
  const iso = `${day0.getFullYear()}-${String(day0.getMonth() + 1).padStart(2, "0")}-${String(day0.getDate()).padStart(2, "0")}`;
  const dialogs = [];
  const t = await open({ rows: twoWayDeck() });
  t.page.on("dialog", (d) => dialogs.push(d.message()));
  await t.page.route("**/rest/v1/user_review_dates*", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify([{ review_date: iso }]) })
      : r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));
  await t.page.reload({ waitUntil: "commit" });
  await t.page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await t.wait(1500);
  await gotoStats(t.page);
  await t.click("Reset all progress"); await t.wait(1500);
  ck("the student is told the streak wasn't cleared", dialogs.some((m) => /streak couldn't be cleared/.test(m)), JSON.stringify(dialogs));
  await t.browser.close();
}

console.log("\n  moving on while the check runs: the answer stays wrong, and no other card is touched");
{
  // The owner's rule (2026-09-27): moving on before the check finishes means
  // the first mark stands. The result used to land on the next card, where a
  // wrong answer then showed "Accepted" and was saved as right.
  const deck = frenchSideDeck();
  const t = await open({ rows: deck, studyMode: "type", api: { ok: true, verdict: "accept", reasoning: "Fair." }, apiDelay: 2500 });
  const first = await rowOnScreen(t.page, deck);
  await t.typeCheck("zzzz");
  await t.click("My answer should be accepted"); await t.wait(200);
  ck("the check is still running", await t.has(/Reviewing your answer/));
  await t.page.keyboard.press("Enter"); await t.wait(500);
  const second = await rowOnScreen(t.page, deck);
  await t.wait(2800); // the check comes back, accepting
  await t.typeCheck("qqqq");
  ck("the next card's wrong answer shows as wrong, with nothing about the last one", /✗ You wrote: qqqq/.test(await t.result()) && !(await t.has(/Accepted/)),
     `"${await t.result()}"`);
  await t.click("Continue →"); await t.wait(500);
  ck("the card moved on from is saved as wrong", JSON.stringify(writesFor(t, first.id)) === "[false]" && recordsFor(t, first.id).every((b) => b.correct === false),
     JSON.stringify(writesFor(t, first.id)));
  ck("and so is the next card's wrong answer", JSON.stringify(writesFor(t, second?.id)) === "[false]", JSON.stringify(writesFor(t, second?.id)));
  await t.browser.close();
}

console.log("\n  Previous card while the check runs: the card gone back to is left alone");
{
  const deck = frenchSideDeck();
  const t = await open({ rows: deck, studyMode: "type", api: { ok: true, verdict: "accept", reasoning: "Fair." }, apiDelay: 2500 });
  const first = await rowOnScreen(t.page, deck);
  await t.typeCheck("zzzz"); await t.click("Continue →"); await t.wait(500);
  await t.typeCheck("yyyy");
  await t.click("My answer should be accepted"); await t.wait(200);
  await t.click("Previous card"); await t.wait(2800);
  await t.typeCheck("xxxx");
  ck("the wrong answer there shows as wrong", /✗ You wrote: xxxx/.test(await t.result()) && !(await t.has(/Accepted/)), `"${await t.result()}"`);
  await t.click("Continue →"); await t.wait(500);
  ck("and stays saved as wrong", JSON.stringify(writesFor(t, first.id)) === "[false]", JSON.stringify(writesFor(t, first.id)));
  await t.browser.close();
}

console.log("\n  an accepted answer shows as accepted, and stays accepted through a reload");
{
  const deck = frenchSideDeck();
  const t = await open({ rows: deck, studyMode: "type", api: { ok: true, verdict: "accept", reasoning: "Fair." } });
  const row = await rowOnScreen(t.page, deck);
  await t.typeCheck("zzzz");
  await t.click("My answer should be accepted");
  await t.page.waitForFunction(() => /Accepted/.test(document.body.innerText), null, { timeout: 5000 });
  ck("the red ✗ turns into a green ✓ Accepted", /^✓ Accepted — you wrote: zzzz/.test(await t.result()), `"${await t.result()}"`);
  await t.wait(800); // the set on screen is kept a moment after each change
  await t.page.reload({ waitUntil: "commit" });
  await t.page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await t.wait(1500);
  ck("after a reload, the same card still shows it was accepted",
     (await rowOnScreen(t.page, deck))?.id === row.id && /^✓ Accepted/.test(await t.result()) && !(await t.has(/My answer should be accepted/)),
     `"${await t.result()}"`);
  await t.click("Continue →"); await t.wait(500);
  ck("and Continue saves it as right", JSON.stringify(writesFor(t, row.id)) === "[true]", JSON.stringify(writesFor(t, row.id)));
  await t.browser.close();
}

console.log("\n  a miss changed to right with Previous card takes its retry back out");
{
  const deck = frenchSideDeck();
  const t = await open({ rows: deck, studyMode: "type" });
  const row = await rowOnScreen(t.page, deck);
  await t.typeCheck("zzzz"); await t.click("Continue →"); await t.wait(500);
  ck("the miss lines up a retry", /1 retry to come/i.test(await t.counter()), await t.counter());
  await t.click("Previous card"); await t.wait(500);
  await t.typeCheck(row.back); await t.click("Continue →"); await t.wait(500);
  ck("changed to right, the retry is gone", !/retr(y|ies) to come/i.test(await t.counter()), await t.counter());
  const asked = [row.front];
  for (let guard = 0; guard < 12 && !(await t.page.$("[data-checkpoint]")); guard++) {
    const r = await rowOnScreen(t.page, deck);
    asked.push(`${r?.front}${(await t.page.$("[data-retry]")) ? " (retry)" : ""}`);
    await t.typeCheck(r.back); await t.click("Continue →"); await t.wait(400);
  }
  ck("the card doesn't come back, and the one its retry pushed out is asked instead: all 6, once each",
     asked.length === 6 && new Set(asked).size === 6 && asked.every((a) => !a.endsWith("(retry)")), asked.join(" | "));
  await t.browser.close();
}

console.log("\n  the counter and Stats follow what was actually answered");
{
  // 8 cards: two misses whose retries each push a card out of the set, so
  // 6 cards and 2 retries are answered.
  const deck = frenchSideDeck(8);
  const t = await open({ rows: deck, studyMode: "type" });
  const counters = [];
  let r = await rowOnScreen(t.page, deck); counters.push(await t.counter());
  await t.typeCheck(r.back); await t.click("Continue →"); await t.wait(400);
  for (let i = 0; i < 2; i++) { counters.push(await t.counter()); await t.typeCheck("zzzz"); await t.click("Continue →"); await t.wait(400); }
  counters.push(await t.counter());
  let answers = 3;
  for (let guard = 0; guard < 12 && !(await t.page.$("[data-checkpoint]")); guard++) {
    r = await rowOnScreen(t.page, deck);
    await t.typeCheck(r.back); await t.click("Continue →"); await t.wait(400); answers++;
  }
  ck("the counter's make-up drops as retries push cards out: 8 review, then 6",
     /8 review/i.test(counters[0]) && /6 review · 2 retries to come/i.test(counters[3]), `${counters[0]} … ${counters[3]}`);
  const summary = await t.page.evaluate(() => document.querySelector("[data-checkpoint]")?.innerText.split("\n")[0] || "");
  ck("8 answers in the set, and the end-of-set screen says so", answers === 8 && /^8 answers/.test(summary), `${answers} given; "${summary}"`);
  await gotoStats(t.page); await t.wait(800);
  const today = () => t.page.evaluate(() => /Today (\d+) cards?/i.exec(document.body.innerText.replace(/\s+/g, " "))?.[1]);
  ck("Stats counts every card today, retries included: 8, not 6", (await today()) === "8", `${await today()}`);
  ck("and says which were retries: 2", await t.has(/· 2 retries/), "");
  ck("right first time is still out of the 6 cards", await t.has(/4 of 6 cards/), "");
  await t.page.reload({ waitUntil: "commit" });
  await t.page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await t.wait(1200);
  await gotoStats(t.page); await t.wait(800);
  ck("and still 8 after a reload, from the saved records", (await today()) === "8", `${await today()}`);
  await t.browser.close();
}

console.log("\n  Mark for review: a right answer saved as a miss, and the student told so");
{
  const deck = frenchSideDeck();
  const t = await open({ rows: deck, studyMode: "type" });
  const notice = () => t.page.evaluate(() => document.querySelector("[data-review-mark]")?.innerText || "");
  const first = await rowOnScreen(t.page, deck);
  await t.typeCheck(first.back);
  ck("the right answer is accepted, and Mark for review is offered", /^✓/.test(await t.result()) && await t.has(/Mark for review/), `"${await t.result()}"`);
  await t.click("Mark for review"); await t.wait(600);
  ck("it is saved as a miss", JSON.stringify(writesFor(t, first.id)) === "[false]" && recordsFor(t, first.id).length === 1 && recordsFor(t, first.id).every((b) => b.correct === false),
     JSON.stringify(writesFor(t, first.id)));
  ck("the next card is on screen", (await rowOnScreen(t.page, deck))?.id !== first.id);
  ck("the student is told it comes back later in this set", (await notice()) === "Marked for review: counted as wrong, back later in this set", `"${await notice()}"`);
  ck("and it does: a retry is lined up", /1 retry to come/i.test(await t.counter()), `"${await t.counter()}"`);
  await t.wait(5000);
  ck("the message goes after a few seconds", (await notice()) === "", `"${await notice()}"`);
  // Cards 2 to 4 right; card 5 is one of the last two, where a miss gets no retry.
  for (let i = 0; i < 3; i++) {
    const row = await rowOnScreen(t.page, deck);
    await t.typeCheck(row.back);
    await t.click("Continue →"); await t.wait(400);
  }
  const fifth = await rowOnScreen(t.page, deck);
  await t.typeCheck(fifth.back);
  await t.click("Mark for review"); await t.wait(600);
  ck("near the end of the set it is still saved as a miss", JSON.stringify(writesFor(t, fifth.id)) === "[false]", JSON.stringify(writesFor(t, fifth.id)));
  ck("and the student is told it comes back tomorrow", (await notice()) === "Marked for review: counted as wrong, back tomorrow", `"${await notice()}"`);
  const row = await rowOnScreen(t.page, deck);
  await t.typeCheck(row.back);
  await t.click("Continue →"); await t.wait(400);
  ck("the next answer clears the message", (await notice()) === "", `"${await notice()}"`);
  await t.browser.close();
}

console.log("\n  typing is the default, and the last choice is remembered");
{
  const t = await open({ studyMode: null });
  ck("a new student opens in typing mode", await t.typing());
  await t.click("Type answer"); await t.wait();
  ck("switching to flipping works", !(await t.typing()));
  await t.page.reload({ waitUntil: "commit" });
  await t.page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await t.wait(600);
  ck("and flipping is still chosen after a reload", !(await t.typing()));
  await t.browser.close();
}

await finish(null, ck);
