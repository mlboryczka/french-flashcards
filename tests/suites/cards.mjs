// Card behaviour: the French prompt never gives away its own answer, the
// result banner shows what YOU typed, and tapping the card continues.
import { openApp, finish, checker, cardBox, enableTypeMode } from "../harness.mjs";

const ck = checker();

// A single glossed card, served directly, so the assertion doesn't depend on
// where a shuffled session happens to land.
const GLOSSED = [{
  id: 4, front: "je suis allé (I went (passé)", back: "I went (passé composé)",
  category: "G", dates: ["2025-03-01"], flagged_for_review: false, batch_id: null,
  next_due_at: new Date(Date.now() - 86400000).toISOString(), lapses: 0,
  stability: 5, difficulty: 5, fsrs_state: 2, reps: 2,
  last_review: new Date(Date.now() - 6 * 86400000).toISOString(),
  last_answer_correct: true,
}];

const { browser, page } = await openApp({
  route: (p) =>
    p.route("**/rest/v1/user_cards*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(r.request().method() === "GET" ? GLOSSED : []),
      })
    ),
});

console.log("\n  the French prompt keeps its English gloss off");
const glossed = await cardBox(page);
ck("gloss stripped from the prompt", glossed.front === "je suis allé", JSON.stringify(glossed.front));
ck("the answer side keeps the full translation", /I went/.test(glossed.back), JSON.stringify(glossed.back));

await page.unroute("**/rest/v1/user_cards*");
await page.reload({ waitUntil: "commit" });
await page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
await page.click('button:has-text("FR→EN")');
await page.waitForTimeout(400);
await enableTypeMode(page);

console.log("\n  the banner shows your answer, not a repeat of the right one");
const correct = (await cardBox(page)).back;
await page.click('input[placeholder^="Type"]');
await page.keyboard.type("a mountain");
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const banner = await page.evaluate(() => {
  const n = [...document.querySelectorAll("div")].find(
    (d) => /^[✓✗×]\s|^Answer:/.test(d.textContent.trim()) && d.children.length === 0
  );
  return n ? n.textContent.trim() : null;
});
ck("shows what you typed", /a mountain/.test(banner || ""), banner || "");
ck(
  "does not repeat the answer the card already shows",
  !!banner && !banner.includes(correct),
  `banner ${JSON.stringify(banner)} vs answer ${JSON.stringify(correct)}`
);

console.log("\n  tapping the card continues");
// Compared on the counter's own words, not on index + 1.
//
// The counter is not one running number: past the initial deck size it
// switches to "Retry 1 of 1" and starts again from one. So when the shuffle
// happened to leave the suite on the LAST card, a wrong answer re-queued it,
// tapping advanced correctly onto that retry, and the arithmetic read
// 15 → 1 and called a working app broken. It failed about one run in fifteen,
// which is exactly often enough to be dismissed as a flake.
//
// Read after grading and before the tap, so the tap is the only thing that
// happened in between — reading it before the answer would also pick up the
// "· 1 retry pending" the grade itself adds.
const counterText = () =>
  page.evaluate(() => {
    const m = document.body.innerText.match(/(?:Card|Retry) \d+ of \d+[^\n]*/i);
    return m ? m[0] : null;
  });
const graded = await counterText();
const card = await cardBox(page);
await page.mouse.click(card.centreX, Math.round((card.top + card.bottom) / 2));
await page.waitForTimeout(800);
const advanced = await counterText();
ck("advanced off the card you answered", !!advanced && advanced !== graded, `${graded} → ${advanced}`);
ck(
  "and it is unanswered",
  !(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /Continue/.test(b.textContent))))
);

console.log("\n  giving up still shows the answer");
await page.click('button:has-text("Show answer")');
await page.waitForTimeout(600);
const revealed = await page.evaluate(() => {
  const n = [...document.querySelectorAll("div")].find(
    (d) => /^Answer:/.test(d.textContent.trim()) && d.children.length === 0
  );
  return n ? n.textContent.trim() : null;
});
ck("nothing typed, so it prints the answer", /^Answer: .+/.test(revealed || ""), revealed || "");

await finish(browser, ck);
