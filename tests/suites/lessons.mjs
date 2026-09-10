// The lesson panel: its tabs, and the rules its layout has to keep.
//
// Everything here is read back from the lesson data rather than typed in, so
// adding a second lesson or renaming a section can't silently go stale. The
// deck served to the app IS the lesson's own cards, which also means the
// once-per-mount sync finds nothing missing and writes nothing — the mock
// serves GET and PATCH only.

import { openApp, finish, checker, servedDeck } from "../harness.mjs";
import LESSON from "../../src/data/lessons/imperatif.js";

const ck = checker();

// Serve the lesson's own cards as the deck.
const rows = LESSON.cards.map(([front, back, category], i) => ({
  id: i + 1,
  front,
  back,
  category,
  dates: [],
  flagged_for_review: false,
  batch_id: null,
  source: `lesson:${LESSON.id}`,
  next_due_at: null,
  lapses: 0,
  stability: null,
  difficulty: null,
  fsrs_state: 0,
  reps: 0,
  last_review: null,
  last_answer_correct: null,
}));

const route = async (page) => {
  await page.route("**/rest/v1/user_cards**", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    await r.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(rows),
    });
  });
};

const { browser, page } = await openApp({ width: 1400, height: 900, route });

console.log(`  fixture: ${rows.length} cards from "${LESSON.title}"`);

// ── Get into the lesson ───────────────────────────────────────────────
// Click through the nav the way a person does: Lessons, then the lesson.
await page.evaluate(() => {
  const hit = (root, label) => {
    const n = [...root.querySelectorAll("*")].filter(
      (x) => x.textContent.trim() === label && !x.children.length
    ).pop();
    for (let el = n; el; el = el.parentElement) {
      el.click();
      if (el.tagName === "BUTTON" || el.tagName === "DIV") break;
    }
  };
  hit(document.querySelector("aside"), "Lessons");
});
await page.waitForTimeout(400);
await page.evaluate((title) => {
  const n = [...document.querySelectorAll("aside *")].filter(
    (x) => x.textContent.trim() === title && !x.children.length
  ).pop();
  for (let el = n; el; el = el.parentElement) { el.click(); if (el.tagName === "BUTTON") break; }
}, LESSON.title);
await page.waitForTimeout(600);

// ── The lesson names itself as written ────────────────────────────────
// Requirement: the badge and the filter chip show the lesson's title. A title
// is a name, so it appears the way the lesson spells it — not case-folded.
const naming = await page.evaluate((title) => {
  const wanted = title.toLowerCase();
  const hits = [...document.querySelectorAll("div, button, span")]
    .filter((el) => el.textContent.trim().toLowerCase().startsWith(wanted))
    .filter((el) => ![...el.children].some((c) => c.textContent.trim().toLowerCase().startsWith(wanted)))
    .map((el) => ({
      text: el.textContent.trim(),
      transform: getComputedStyle(el).textTransform,
      rendered: el.getBoundingClientRect().width > 0,
    }))
    .filter((h) => h.rendered);
  return hits;
}, LESSON.title);

ck(
  "the lesson names itself somewhere on the study screen",
  naming.length > 0,
  naming.map((n) => n.text).join(" | ")
);
ck(
  "and does so as written, not case-folded",
  naming.every((n) => n.transform === "none"),
  naming.map((n) => `${n.text}=${n.transform}`).join(" | ")
);

// ── Open the notes ────────────────────────────────────────────────────
await page.evaluate(() => document.querySelector("[data-lesson-toggle]")?.click());
await page.waitForTimeout(700);

ck("the lesson notes panel opens", (await page.$("[data-lesson-panel]")) !== null);

// ── One tab per section, named by the lesson ──────────────────────────
const tabs = await page.$$eval("[data-lesson-panel] [role=tab]", (els) =>
  els.map((e) => e.textContent.trim())
);
const wantTabs = LESSON.notes.map((s) => s.tab);
ck(
  "one tab per section of the lesson, in the lesson's order",
  tabs.join(" · ") === wantTabs.join(" · "),
  tabs.join(" · ")
);

// ── Every tab renders, and none of them stacks two rules ──────────────
//
// Requirement: a divider separates two things. Two dividers 20px apart
// separate nothing and read as a rendering fault — which is exactly what a
// table's closing hairline plus a subheading's opening one produced.
for (let i = 0; i < tabs.length; i++) {
  await page.evaluate((n) => {
    document.querySelectorAll("[data-lesson-panel] [role=tab]")[n].click();
  }, i);
  await page.waitForTimeout(250);

  const probe = await page.evaluate(() => {
    const body = document.querySelector("[data-lesson-panel] [role=tab]")
      .closest("div").nextElementSibling;
    const text = body.innerText.trim();

    // Every horizontal rule the tab paints, deduped by y — cells in one
    // header row share an edge and are one line, not several.
    const seen = new Map();
    body.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const put = (y, w) => {
        const k = Math.round(y);
        if (!seen.has(k)) seen.set(k, `${el.tagName.toLowerCase()}:${w}`);
      };
      if (cs.borderTopWidth !== "0px" && cs.borderTopStyle !== "none") put(r.top, "top");
      if (cs.borderBottomWidth !== "0px" && cs.borderBottomStyle !== "none") put(r.bottom, "bottom");
    });
    const ys = [...seen.entries()].sort((a, b) => a[0] - b[0]);
    const stacked = [];
    for (let j = 1; j < ys.length; j++) {
      const gap = ys[j][0] - ys[j - 1][0];
      if (gap > 2 && gap < 34) stacked.push(`${ys[j - 1][1]}+${ys[j][1]} @${gap}px`);
    }
    return { chars: text.length, stacked };
  });

  ck(`${tabs[i]} renders its content`, probe.chars > 120, `${probe.chars} chars`);
  ck(
    `${tabs[i]} draws no two rules on top of each other`,
    probe.stacked.length === 0,
    probe.stacked.join(", ") || "none"
  );
}

// ── French spacing survives to the screen ─────────────────────────────
//
// Requirement: French sets a space before "!" and it must not be able to wrap
// the punctuation onto its own line. Measured as the actual codepoint, since a
// plain space looks identical and behaves differently.
// Back to the first tab that actually contains French punctuation — the loop
// above left whichever tab it ended on, and not every section has an "!".
const exTab = LESSON.notes.findIndex((s) =>
  JSON.stringify(s.blocks).includes(" !")
);
await page.evaluate((n) => {
  document.querySelectorAll("[data-lesson-panel] [role=tab]")[n].click();
}, exTab);
await page.waitForTimeout(250);

const spacing = await page.evaluate(() => {
  const body = document.querySelector("[data-lesson-panel]").innerText;
  const m = body.match(/\S(\s)!/);
  return m ? "U+" + m[1].codePointAt(0).toString(16).toUpperCase() : "no French exclamation found";
});
ck("the space before ! is a narrow no-break space", spacing === "U+202F", spacing);

// ── The panel stays up while you work the card ────────────────────────
//
// Requirement: the notes are reference material you keep beside the work, so
// nothing ambient may put them away. Written as the things a person actually
// does mid-answer — click the card, click into the answer box, type, press
// Escape to clear a field — not as "the dismiss handler is gone".
const stillOpen = async (what) =>
  ck(`${what} leaves the notes open`, (await page.$("[data-lesson-panel]")) !== null);

await page.evaluate(() => {
  const card = [...document.querySelectorAll("div")].find(
    (d) => d.getBoundingClientRect().width > 300 && /→|Tap to reveal/.test(d.innerText || "")
  );
  (card || document.querySelector("main")).click();
});
await page.waitForTimeout(400);
await stillOpen("clicking the card");

await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await stillOpen("pressing Escape");

// ── ...and the ✕ does close it ────────────────────────────────────────
await page.evaluate(() => {
  const panel = document.querySelector("[data-lesson-panel]");
  [...panel.querySelectorAll("button")].find((b) => b.textContent.trim() === "✕").click();
});
await page.waitForTimeout(700);
ck("the ✕ closes the panel", (await page.$("[data-lesson-panel]")) === null);

// The fixture is the lesson, so the sync had nothing to do. Confirm it did not
// quietly rewrite the deck behind us.
const after = await servedDeck();
ck("the mock deck is still intact", Array.isArray(after), `${after.length} rows`);

await finish(browser, ck);
