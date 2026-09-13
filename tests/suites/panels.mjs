// The tutor and feedback panels: mutually exclusive, and what does and does
// not dismiss each. The feedback panel goes on an outside click; the tutor
// reflows the page sideways, and the feedback panel — which lives in the
// sidebar — moves nothing. Closing the feedback panel keeps its draft; only
// sending clears it.
import { openApp, finish, checker, layoutProbe, cardBox } from "../harness.mjs";

const ck = checker();
const { browser, page } = await openApp();

// Empty page, well away from the sidebar (where the panel now is), the card
// and every control. The old suite clicked at (80, 700), which is inside the
// panel now.
const OUTSIDE = [1300, 860];

// Where the panel is allowed to be: inside the sidebar, below Tutor, above the
// account block, and nowhere near the card.
function sidebarGeometry(pg) {
  return pg.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const aside = document.querySelector("aside");
    const tutor = [...aside.querySelectorAll("nav button")].find((b) => /tutor/i.test(b.innerText));
    const account = [...aside.querySelectorAll("*")].find((n) => n.children.length === 0 && /@example\.com/.test(n.textContent || ""));
    const card = [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).transformStyle === "preserve-3d");
    return {
      aside: rect(aside),
      tutorBottom: rect(tutor).bottom,
      accountTop: rect(account)?.top ?? null,
      panel: rect(document.querySelector("[data-feedback-sheet]")),
      toast: rect(document.querySelector("[data-feedback-toast]")),
      card: rect(card),
    };
  });
}
const overlaps = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

console.log("\n  clicking outside closes the feedback panel");
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(700);
ck("open", !!(await layoutProbe(page)).sheet);
await page.mouse.click(...OUTSIDE);
await page.waitForTimeout(600);
const after = await layoutProbe(page);
ck("closed", !after.sheet);
ck("and the page never made room for it", after.padBottom === 0, `padding ${after.padBottom}`);

console.log("\n  the panel lives in the sidebar, and covers nothing");
const cardShut = await cardBox(page);
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(700);
const g = await sidebarGeometry(page);
console.log(`  panel ${g.panel.right - g.panel.left}x${g.panel.bottom - g.panel.top} at ${g.panel.left},${g.panel.top}; Tutor ends ${g.tutorBottom}, account at ${g.accountTop}`);
ck(
  "inside the sidebar, inset from both its edges",
  g.panel.left >= g.aside.left + 8 && g.panel.right <= g.aside.right - 8,
  `panel ${g.panel.left}–${g.panel.right}, sidebar ${g.aside.left}–${g.aside.right}`
);
ck("its top stays well below Tutor", g.panel.top >= g.tutorBottom + 16, `top ${g.panel.top}, Tutor ends ${g.tutorBottom}`);
ck("and it ends above the account block", g.accountTop !== null && g.panel.bottom <= g.accountTop, `bottom ${g.panel.bottom}, account ${g.accountTop}`);
ck("it never overlaps the card", !overlaps(g.panel, g.card), `panel ${JSON.stringify(g.panel)}, card ${JSON.stringify(g.card)}`);
const cardOpen = await cardBox(page);
ck(
  "and the card didn't move or change size when it opened",
  cardOpen.top === cardShut.top && cardOpen.height === cardShut.height && cardOpen.width === cardShut.width,
  `${cardShut.width}x${cardShut.height}@${cardShut.top} → ${cardOpen.width}x${cardOpen.height}@${cardOpen.top}`
);
ck(
  "the subtitle is gone",
  !(await page.evaluate(() => /Bug, idea, or wrong translation/.test(document.body.innerText)))
);
// Three lines — the old sheet's box was 90px and mostly empty, and one line of
// a sidebar-width field holds about four words.
const fieldH = await page.evaluate(() => {
  const t = document.querySelector("[data-feedback-sheet] textarea");
  return t ? Math.round(t.getBoundingClientRect().height) : 999;
});
ck("the message field starts small — under the old 90px box", fieldH < 90, `${fieldH}px`);
// By its marker, not by guessing at whatever French happens to be on the card.
const attachWidth = await page.evaluate(() => {
  const b = document.querySelector("[data-attach-card]");
  return b ? Math.round(b.getBoundingClientRect().width) : null;
});
ck("attach-card is a chip that fits the panel", attachWidth !== null && attachWidth <= g.panel.right - g.panel.left, `${attachWidth}px`);
// The dedicated dropzone is gone, so the panel itself has to accept the file.
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }));
  window.__dt = dt;
  document.querySelector("[data-feedback-sheet]")
    .dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
// React has to re-render before the highlight is on the element.
await page.waitForTimeout(200);
const lit = await page.evaluate(() =>
  /inset/.test(getComputedStyle(document.querySelector("[data-feedback-sheet]")).boxShadow)
);
ck("dragging over the panel lights the whole panel up", lit === true, `${lit}`);
await page.evaluate(() => {
  document.querySelector("[data-feedback-sheet]")
    .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
});
await page.waitForTimeout(500);
ck(
  "and dropping it there attaches the image",
  await page.evaluate(() => !!document.querySelector('img[alt="Attached"]'))
);
await page.mouse.click(...OUTSIDE);
await page.waitForTimeout(600);

console.log("\n  only one panel at a time");
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(500);
ck("feedback open", !!(await layoutProbe(page)).sheet);

await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);
const tutor = await layoutProbe(page);
ck("opening the tutor closed the feedback panel", !tutor.sheet);
ck("the tutor is open", tutor.tutorOpen);
ck(
  "the page reflowed sideways instead",
  tutor.padRight > 0 && tutor.padBottom === 0,
  `right ${tutor.padRight}, bottom ${tutor.padBottom}`
);

// The requirement the tutor exists for: you ask it about the card in front of
// you, so clicking back onto that card must NOT take the answer away. It used
// to close on any outside click, and on Escape.
await page.click("body", { position: { x: 400, y: 450 } });
await page.waitForTimeout(500);
ck(
  "clicking the card behind it leaves the tutor open",
  (await layoutProbe(page)).tutorOpen
);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
ck("Escape leaves the tutor open", (await layoutProbe(page)).tutorOpen);

// Closing it deliberately still works, both ways in.
await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);
ck("the nav toggle closes it", !(await layoutProbe(page)).tutorOpen);

await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);
await page.click('[data-tutor-panel] button[aria-label="Close"]');
await page.waitForTimeout(800);
ck("the ✕ closes it", !(await layoutProbe(page)).tutorOpen);

// Reopen for the mutual-exclusion check below.
await page.click("[data-tutor-toggle]");
await page.waitForTimeout(800);

// Opening another panel is a deliberate act, not an ambient dismissal, so it
// still puts the tutor away.
await page.click('button:has-text("Send feedback")');
await page.waitForTimeout(800);
const back = await layoutProbe(page);
ck("opening feedback closed the tutor", !back.tutorOpen);
ck("feedback is open", !!back.sheet);
ck(
  "and the page gave the tutor's room back without taking any for feedback",
  back.padBottom === 0 && back.padRight === 0,
  `right ${back.padRight}, bottom ${back.padBottom}`
);

await browser.close();

// ── A draft is never thrown away, and nothing ever asks ─────────────────
//
// Written from what the user reported: send feedback, click outside, get asked
// whether to discard it, and afterwards be unable to tell whether anything was
// deleted. The sheet held the sent text in its field for 1.5s after sending,
// so an outside click read it as a draft. The requirement is that closing
// never costs you anything and sending is announced where you can see it.
{
  const { browser: b2, page: p } = await openApp();
  let dialogs = 0;
  p.on("dialog", () => { dialogs++; });
  const posts = [];
  let schedulerWrites = 0;
  p.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/rest/v1/beta_feedback")) {
      const body = r.postDataJSON();
      posts.push(Array.isArray(body) ? body[0] : body);
    }
    if (r.method() === "PATCH" && r.url().includes("/rest/v1/user_cards")) schedulerWrites++;
  });
  const sheetOpen = () => p.evaluate(() => !!document.querySelector("[data-feedback-sheet]"));
  const field = () => p.evaluate(() => document.querySelector("[data-feedback-sheet] textarea")?.value ?? null);
  const openSheet = async () => {
    await p.click('button:has-text("Send feedback")');
    await p.waitForTimeout(700);
  };
  const DRAFT = "The gender on this card is wrong";

  console.log("\n  closing keeps the draft, however you close it");
  await openSheet();
  await p.keyboard.type(DRAFT);
  await p.mouse.click(...OUTSIDE);
  await p.waitForTimeout(600);
  ck("an outside click closes it without asking", !(await sheetOpen()) && dialogs === 0, `dialogs ${dialogs}`);
  ck("the trigger shows a draft is waiting", await p.evaluate(() => !!document.querySelector("[data-feedback-draft]")));
  await openSheet();
  ck("reopening brings the draft back", (await field()) === DRAFT, JSON.stringify(await field()));

  // The link that opens it is a toggle. It used to only ever open.
  await p.click('button:has-text("Send feedback")');
  await p.waitForTimeout(600);
  ck("clicking Send feedback again closes it, without asking", !(await sheetOpen()) && dialogs === 0, `dialogs ${dialogs}`);
  await openSheet();
  ck("and the draft is still there", (await field()) === DRAFT, JSON.stringify(await field()));

  await p.keyboard.press("Escape");
  await p.waitForTimeout(600);
  ck("Escape closes it, without asking", !(await sheetOpen()) && dialogs === 0, `dialogs ${dialogs}`);
  ck(
    "and hands focus back to the trigger",
    await p.evaluate(() => !!document.activeElement?.closest?.("[data-feedback-toggle]"))
  );

  await openSheet();
  await p.click("[data-tutor-toggle]");
  await p.waitForTimeout(800);
  const t = await layoutProbe(p);
  ck("opening the tutor over a draft doesn't ask either", t.tutorOpen && !t.sheet && dialogs === 0, `dialogs ${dialogs}`);
  await p.click("[data-tutor-toggle]");
  await p.waitForTimeout(800);
  await openSheet();
  ck("and the draft survived it", (await field()) === DRAFT, JSON.stringify(await field()));

  console.log("\n  what you do inside the panel doesn't move the page");
  const before = await sidebarGeometry(p);
  const cardBefore = await cardBox(p);
  await p.keyboard.type("\nline two\nline three\nline four\nline five");
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }));
    document.querySelector("[data-feedback-sheet]")
      .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await p.waitForTimeout(700);
  const grown = await sidebarGeometry(p);
  const cardAfter = await cardBox(p);
  // Guard the guard: if the panel didn't grow, the next checks prove nothing.
  ck("the panel grew with five lines and a screenshot", grown.panel.bottom - grown.panel.top > before.panel.bottom - before.panel.top,
    `${before.panel.bottom - before.panel.top} → ${grown.panel.bottom - grown.panel.top}`);
  ck("the card held still", cardAfter.top === cardBefore.top && cardAfter.height === cardBefore.height,
    `${cardBefore.height}@${cardBefore.top} → ${cardAfter.height}@${cardAfter.top}`);
  ck("the panel still stops below Tutor", grown.panel.top >= grown.tutorBottom + 16, `top ${grown.panel.top}, Tutor ${grown.tutorBottom}`);
  ck(
    "the screenshot sits in its chip, not a row of its own",
    await p.evaluate(() => {
      const img = document.querySelector('[data-feedback-sheet] img[alt="Attached"]');
      const chip = img?.parentElement?.parentElement;
      return !!chip && chip.getBoundingClientRect().height <= 30;
    })
  );

  console.log("\n  sending clears the draft and says so");
  await p.click('[data-feedback-sheet] button:text-is("Send")');
  // The exact click that used to ask "Discard your feedback?" about feedback
  // that had already been sent.
  await p.mouse.click(...OUTSIDE);
  await p.waitForTimeout(900);
  ck("clicking away straight after sending asks nothing", dialogs === 0, `dialogs ${dialogs}`);
  ck("the panel is closed", !(await sheetOpen()));
  const sent = await sidebarGeometry(p);
  ck("a toast says it was sent", await p.evaluate(() => !!document.querySelector('[data-feedback-toast="sent"]')));
  ck(
    "in the sidebar, where the panel was, covering nothing",
    !!sent.toast && sent.toast.left >= sent.aside.left && sent.toast.right <= sent.aside.right && !overlaps(sent.toast, sent.card),
    JSON.stringify(sent.toast)
  );
  ck("exactly one row was written", posts.length === 1, `${posts.length}`);
  ck("carrying what was typed", posts[0]?.message?.startsWith(DRAFT), JSON.stringify(posts[0]?.message));
  ck("no draft is flagged any more", !(await p.evaluate(() => !!document.querySelector("[data-feedback-draft]"))));
  const gone = await p
    .waitForFunction(() => !document.querySelector("[data-feedback-toast]"), null, { timeout: 8000 })
    .then(() => true, () => false);
  ck("and the toast goes away on its own", gone);
  await openSheet();
  ck(
    "reopening shows an empty panel",
    (await field()) === "" && !(await p.evaluate(() => !!document.querySelector('[data-feedback-sheet] img[alt="Attached"]')))
  );

  console.log("\n  too short, or a failed send, keeps you where you are");
  await p.keyboard.type("ok");
  await p.keyboard.press("Control+Enter");
  await p.waitForTimeout(400);
  ck("a two-letter note isn't sent", posts.length === 1 && (await sheetOpen()), `${posts.length} rows`);
  ck("and the panel says why", await p.evaluate(() => !!document.querySelector('[data-feedback-sheet] [role="alert"]')));

  await p.route("**/rest/v1/beta_feedback**", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) })
  );
  await p.keyboard.type(" — the audio is missing");
  await p.click('[data-feedback-sheet] button:text-is("Send")');
  await p.waitForTimeout(900);
  ck("a failed send leaves the panel open", await sheetOpen());
  ck("with the draft intact", (await field()) === "ok — the audio is missing", JSON.stringify(await field()));
  ck("and an error in it", await p.evaluate(() => !!document.querySelector('[data-feedback-sheet] [role="alert"]')));
  ck("and no success toast", !(await p.evaluate(() => !!document.querySelector('[data-feedback-toast="sent"]'))));
  await p.unroute("**/rest/v1/beta_feedback**");

  // ── The flag on the card ──────────────────────────────────────────────
  console.log("\n  the flag on the card opens feedback about that card");
  // Switch attaching OFF on the current draft, then put the panel away: the
  // flag has to switch it back on, because the flag means "this card".
  await p.click("[data-attach-card]");
  ck("(attach switched off for the draft)", (await p.getAttribute("[data-attach-card]", "aria-pressed")) === "false");
  await p.mouse.click(...OUTSIDE);
  await p.waitForTimeout(600);
  ck("the flag is on the card while the panel is shut", (await p.locator("[data-report-card]").count()) > 0);

  const flipBefore = await p.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).transformStyle === "preserve-3d");
    return getComputedStyle(el).transform;
  });
  const cardFlagBefore = await cardBox(p);
  const writesBefore = schedulerWrites;
  await p.locator("[data-report-card]").first().click();
  await p.waitForTimeout(800);
  ck("clicking it opens the panel", await sheetOpen());
  ck("with the card attached", (await p.getAttribute("[data-attach-card]", "aria-pressed")) === "true");
  ck("keeping the draft that was there", (await field()) === "ok — the audio is missing", JSON.stringify(await field()));
  const flipAfter = await p.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).transformStyle === "preserve-3d");
    return getComputedStyle(el).transform;
  });
  const cardFlagAfter = await cardBox(p);
  ck("the card didn't flip", flipAfter === flipBefore, `${flipBefore} → ${flipAfter}`);
  ck("or move on to another card", cardFlagAfter.front === cardFlagBefore.front, `${cardFlagBefore.front} → ${cardFlagAfter.front}`);
  ck("and nothing was graded", schedulerWrites === writesBefore, `${schedulerWrites - writesBefore} scheduler writes`);
  ck("the flag hides while the panel is open", (await p.locator("[data-report-card]").count()) === 0);

  await finish(b2, ck);
}
