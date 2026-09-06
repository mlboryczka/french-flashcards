// The multi-sense cleanup tool, end to end. The audit and write endpoints are
// stubbed here — what is under test is the client flow: scan the whole deck
// locally, send only the shortlist, show what would change, let it be
// unticked, and send exactly what was approved.
import { openApp, finish, checker, servedDeck } from "../harness.mjs";

const ck = checker();
let auditReqs = [], applyReq = null;

const { browser, page } = await openApp({
  route: async (p) => {
    await p.route("**/api/split-senses", async (route) => {
      const body = JSON.parse(route.request().postData());
      auditReqs.push(body);
      const results = body.cards.map((c) =>
        c.front === "les frais"
          ? {
              row_id: c.row_id, action: "split",
              reason: '"les frais" is a plural noun; "frais" is a separate adjective.',
              cards: [
                { front: "les frais", back: "the costs / the expenses", category: "vocab" },
                { front: "frais (adj)", back: "fresh", category: "vocab" },
              ],
            }
          : { row_id: c.row_id, action: "keep", reason: "one word", cards: [] }
      );
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          results: results.map((r) => ({ ...r, original: body.cards.find((c) => c.row_id === r.row_id) })),
        }),
      });
    });
    await p.route("**/api/apply-splits", async (route) => {
      applyReq = JSON.parse(route.request().postData());
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, updated: 1, inserted: 1, skipped: [] }),
      });
    });
  },
});

console.log('\n  opening the tool');
await page.click('aside button:has(div:text-is("T"))');
await page.waitForSelector('button:has-text("Fix multi-sense cards")', { timeout: 8000 });
await page.click('button:has-text("Fix multi-sense cards")');
await page.waitForTimeout(400);
const scanned = await page.evaluate(()=>document.body.innerText.match(/(\d+)\s+cards? looks? suspicious out of (\d+)/));
console.log(`  ${scanned ? scanned[0] : '(no scan line)'}`);
// Compare against the deck the mock actually served, not a number baked in
// here — a hard-coded count silently goes stale the moment the deck changes.
const served = (await servedDeck()).length;
ck('scanned the whole deck locally', !!scanned && +scanned[2] === served, `scanned ${scanned?.[2]} of ${served} served`);
ck('shortlisted only the multi-sense card', !!scanned && +scanned[1] === 1, scanned?scanned[1]:'');

console.log('\n  checking');
await page.click('button:has-text("Check these")');
await page.waitForTimeout(900);
ck('sent one batch', auditReqs.length === 1, `${auditReqs.length}`);
ck('sent only the candidate, not the deck', auditReqs[0]?.cards?.length === 1, `${auditReqs[0]?.cards?.length}`);

const review = await page.evaluate(()=>document.body.innerText);
ck('shows the card being replaced', /les frais/.test(review));
ck('shows both new cards', /frais \(adj\)/.test(review) && /fresh/.test(review));
ck('shows the reason', /separate adjective/.test(review));
ck('offers to apply one split', /Apply 1 split\b/.test(review), (review.match(/Apply [^\n]*/)||[''])[0]);

console.log('\n  unticking holds it back');
await page.click('input[type=checkbox]');
await page.waitForTimeout(250);
const off = await page.evaluate(()=>document.body.innerText);
ck('apply button drops to zero', /Apply 0 splits/.test(off), (off.match(/Apply [^\n]*/)||[''])[0]);
await page.click('input[type=checkbox]');
await page.waitForTimeout(250);

console.log('\n  applying');
await page.click('button:has-text("Apply 1 split")');
await page.waitForTimeout(700);
ck('sent the approved split', applyReq?.splits?.length === 1);
ck('sent the two replacement cards', applyReq?.splits?.[0]?.cards?.length === 2,
   JSON.stringify(applyReq?.splits?.[0]?.cards?.map(c=>c.front)));
ck('kept the original row id', String(applyReq?.splits?.[0]?.row_id) === '6', String(applyReq?.splits?.[0]?.row_id));
const doneText = await page.evaluate(()=>document.body.innerText);
ck('reports what happened', /1 — 1 newly added|2\n/.test(doneText) || /newly added/.test(doneText));

await finish(browser, ck);
