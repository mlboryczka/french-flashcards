// How an answer reaches FSRS on the paths that aren't the happy one. Each check
// is judged by what was written to user_cards, not by what the screen says,
// because every one of these bugs looked right on screen.
//
// Found on 2026-09-14 by driving every exception path in a study session.
import { openApp, finish, checker, sessionCounter, cardBox } from "../harness.mjs";

const ck = checker();

async function open({ patchStatus, api, studyMode } = {}) {
  const writes = [];
  const state = { patchStatus: patchStatus ?? 200 };
  const { browser, page } = await openApp({
    studyMode,
    route: async (p) => {
      await p.route("**/rest/v1/user_cards*", async (r) => {
        if (r.request().method() === "PATCH") {
          writes.push({ at: Date.now(), status: state.patchStatus, body: JSON.parse(r.request().postData() || "{}") });
          if (state.patchStatus !== 200) {
            return r.fulfill({ status: state.patchStatus, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"message":"unavailable"}' });
          }
        }
        return r.continue();
      });
      if (api) await p.route("**/api/review-answer", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api) }));
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
  const grades = () => writes.filter((w) => w.status === 200).map((w) => w.body.last_answer_correct);
  return { browser, page, writes, state, click, has, typing, wait, grades };
}

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
  await t.page.keyboard.press(" "); await t.wait(600);
  await t.click("Got It"); await t.wait(500);
  const firstDue = t.writes[0]?.body.next_due_at;
  await t.click("Previous card"); await t.wait(500);
  await t.page.keyboard.press(" "); await t.wait(600);
  await t.click("Again"); await t.wait(500);
  ck("the correction is recorded", JSON.stringify(t.grades()) === "[true,false]", JSON.stringify(t.grades()));
  ck("recomputed from the card as it was, so the miss brings it back sooner",
     !!firstDue && new Date(t.writes[1].body.next_due_at) < new Date(firstDue),
     `${firstDue} → ${t.writes[1]?.body.next_due_at}`);
  ck("and reps counts one review for the day, not two",
     t.writes[1]?.body.reps === t.writes[0]?.body.reps, `${t.writes[0]?.body.reps} → ${t.writes[1]?.body.reps}`);
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

console.log("\n  changing direction applies from the next card, without a new block");
{
  const t = await open();
  for (let i = 0; i < 3; i++) {
    await t.page.keyboard.press(" "); await t.wait(400);
    await t.click("Got It"); await t.wait(400);
  }
  const before = await sessionCounter(t.page);
  await t.click("EN→FR"); await t.wait(600);
  const after = await sessionCounter(t.page);
  ck("the block carries on where it was", after?.index === before?.index && after?.total === before?.total,
     `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
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
