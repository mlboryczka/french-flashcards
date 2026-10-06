// "Cards in a set" (20, 30, 50, 100) changes the set on screen, not only the
// next one. It used to wait for the next set, and the counter went on saying
// "Card 1 of 50" after 20 was chosen (2026-10-06). Changing it keeps the card
// on screen, every answer and the retries lined up; only the cards not yet
// reached are added or taken away.
//
// The stand-in deck has 27 cards, too few for a set of 30, so this one routes
// in a deck of its own: 30 due cards and 130 new ones.
import { openApp, finish, checker, sessionCounter, cardBox, setting } from "../harness.mjs";

const ck = checker();
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
const DAY = 86400000;
const now = Date.now();
const rows = [];
for (let i = 1; i <= 160; i++) {
  const due = i <= 30;
  rows.push({
    id: i, front: `mot ${i}`, back: `word ${i}`, category: "V", dates: ["2026-09-30"], flagged_for_review: false, batch_id: null,
    next_due_at: due ? new Date(now - DAY).toISOString() : null, lapses: 0, stability: due ? 6 : null, difficulty: due ? 5 : null,
    fsrs_state: due ? 2 : 0, reps: due ? 2 : 0, last_review: due ? new Date(now - 7 * DAY).toISOString() : null, last_answer_correct: due ? true : null,
    en_stability: null, en_difficulty: null, en_fsrs_state: 0, en_reps: 0, en_lapses: 0, en_next_due_at: null, en_last_review: null, en_last_answer_correct: null,
  });
}
const deals = [];
const { browser, page } = await openApp({
  route: async (p) => {
    await p.route("**/rest/v1/user_cards*", (r) => r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(rows) })
      : r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));
    await p.route("**/rest/v1/dealt_sets*", (r) => {
      if (r.request().method() === "POST") deals.push(JSON.parse(r.request().postData() || "{}"));
      return r.fulfill({ status: 201, headers: CORS, body: "" });
    });
  },
});

const counter = () => sessionCounter(page);
const retries = () => page.evaluate(() => Number((document.body.innerText.match(/(\d+) (?:retry|retries) to come/i) || [])[1] || 0));
const front = async () => (await cardBox(page))?.front;
const tapCard = () => page.evaluate(() => {
  [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).transformStyle === "preserve-3d")?.click();
});
// Flip mode: Got It and Again are offered once the card is turned.
async function answer(label) {
  if (!(await page.$(`button:has-text("${label}")`))) { await tapCard(); await page.waitForTimeout(150); }
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(250);
}
const choose = async (n) => { await setting(page, `[data-set-size="${n}"]`); await page.waitForTimeout(400); };
const is = (c, index, total) => c?.index === index && c?.total === total;

console.log("\n  a set is 50 cards until another size is chosen");
ck("Card 1 of 50", is(await counter(), 1, 50), JSON.stringify(await counter()));

console.log("\n  choosing 20 on the first card");
const first = await front();
await choose(20);
ck("the counter says of 20 at once", is(await counter(), 1, 20), JSON.stringify(await counter()));
ck("the card on screen stays", (await front()) === first, `${first} → ${await front()}`);

console.log("\n  three answered, one of them missed");
await answer("Got It"); await answer("Again"); await answer("Got It");
ck("Card 4 of 20", is(await counter(), 4, 20), JSON.stringify(await counter()));
ck("the missed card is lined up to come back", (await retries()) === 1);

console.log("\n  a longer set, then a shorter one, in the middle of it");
const fourth = await front();
const dealtBefore = deals.length;
await choose(100);
ck("Card 4 of 100", is(await counter(), 4, 100), JSON.stringify(await counter()));
ck("the card on screen stays", (await front()) === fourth);
ck("the retry is still to come", (await retries()) === 1);
const added = deals.slice(dealtBefore).find((d) => d.kind === "rest");
ck("the cards added are recorded for the status check, 95 of them (100 less 4 shown and 1 retry)",
   added?.slots === 95 && added?.items?.length === 95, JSON.stringify(added && { slots: added.slots, items: added.items?.length }));
await choose(30);
ck("Card 4 of 30", is(await counter(), 4, 30), JSON.stringify(await counter()));
ck("the card on screen stays", (await front()) === fourth);
ck("the retry is still to come", (await retries()) === 1);

console.log("\n  a reload keeps the size, the card and the retry");
await page.waitForTimeout(800);
await page.reload({ waitUntil: "commit" });
await page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
await page.waitForTimeout(800);
ck("Card 4 of 30", is(await counter(), 4, 30), JSON.stringify(await counter()));
ck("the same card", (await front()) === fourth, `${fourth} → ${await front()}`);
ck("the retry is still to come", (await retries()) === 1);

console.log("\n  shrinking keeps the retry inside the set");
await choose(20);
ck("Card 4 of 20", is(await counter(), 4, 20), JSON.stringify(await counter()));
ck("the retry is still to come", (await retries()) === 1);

console.log("\n  a size smaller than the card on screen ends the set on it");
await choose(30);
for (let i = 0; i < 21; i++) await answer("Got It");
ck("Card 25 of 30 first", is(await counter(), 25, 30), JSON.stringify(await counter()));
const at25 = await front();
await choose(20);
ck("Card 25 of 25", is(await counter(), 25, 25), JSON.stringify(await counter()));
ck("the card on screen stays", (await front()) === at25);
await answer("Got It");
ck("answering it brings up the end of the set", !!(await page.$("[data-checkpoint]")));
const summary = await page.evaluate(() => document.querySelector("[data-checkpoint]")?.innerText.split("\n")[0] || "");
ck("which counts all 25 answers", /^25 answers/.test(summary), summary);

console.log("\n  at the end of a set, a new size is for the next one");
await choose(30);
ck("the end of the set stays on screen", !!(await page.$("[data-checkpoint]")));
await page.click('[data-checkpoint] button:has-text("Continue")');
await page.waitForTimeout(800);
ck("the next set is Card 1 of 30", is(await counter(), 1, 30), JSON.stringify(await counter()));

console.log("\n  after going back with Previous card, answered cards stay in a shorter set");
for (let i = 0; i < 4; i++) await answer("Got It");
await page.click('button:has-text("Previous card")'); await page.waitForTimeout(300);
await page.click('button:has-text("Previous card")'); await page.waitForTimeout(300);
await choose(20);
ck("Card 3 of 20", is(await counter(), 3, 20), JSON.stringify(await counter()));
await page.waitForTimeout(800);
const kept = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith("study-place:"));
  return Object.values(JSON.parse(localStorage.getItem(key)).sets).find((s) => !s.done);
});
ck("the set kept in the browser is 20 long, dealt at 20", kept?.size === 20 && kept?.entries.length === 20, `${kept?.size} ${kept?.entries.length}`);

await finish(browser, ck);
