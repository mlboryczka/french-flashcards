// Reflow: opening a panel narrows or shortens the content column over 420ms,
// and NOTHING in that column is allowed to jump while it happens.
//
// The motion suite already watches the panel edge and the content edge travel
// together. This one watches what those two dragged along behind them — the
// chrome above the card, and the card itself — because every reflow bug this
// app has had was something downstream of the padding moving in one frame
// while the padding moved smoothly over twenty-five.
//
// Three of them, all found by sampling geometry every frame through the whole
// animation rather than measuring before and after:
//
//   • The top bar was a WRAPPING row of chips. Wrapping is a step: 58px tall,
//     then one chip no longer fits and it is 97px tall, nothing in between.
//     A reflow narrows the column continuously, so it crossed that threshold
//     mid-animation and shoved the card area down 39px in a single frame,
//     taking 39px of card height with it. Measured at 1400x700.
//   • The feedback sheet is `position: fixed` with an inline `left` of
//     SIDEBAR_WIDTH, and had `width: 100%` — which on a fixed element resolves
//     against the VIEWPORT, not the span it sits in. Below a 1176px window it
//     hung off the right edge, carrying its own Close button off-screen.
//   • The card gave up its size only after the page's centring slack was
//     spent, so a reflow was two motions: slide, then shrink. On the way back
//     the easing crossed the handover in about two frames and the card
//     recovered most of its size in one of them.
//
// Jumps are judged as a fraction of the move WITH a pixel floor under it, for
// the reason spelled out at `popped` below: on its own, either half of that
// rule reports on moves nobody can see and waves through ones they can.
import { openApp, finish, checker, settled } from "../harness.mjs";

const ck = checker();

// Sample every frame through an animation and report the worst single-frame
// change in each quantity. Anything that animates should cover its distance in
// many small steps; anything that jumps did not animate at all.
const SAMPLER = `
  window.__f = [];
  window.__card = [...document.querySelectorAll("div")].find(
    (d) => getComputedStyle(d).transformStyle === "preserve-3d"
  );
  // The card area is the card's grandparent: card -> cardWrap -> cardArea.
  window.__area = window.__card ? window.__card.parentElement.parentElement : null;
  // Everything above the card area inside main is the chrome that must not
  // change height. Measured as "where the card area starts", which is the only
  // thing about the chrome the card actually cares about.
  const tick = () => {
    const main = document.querySelector("main");
    const cs = getComputedStyle(main);
    const c = window.__card ? window.__card.getBoundingClientRect() : null;
    const a = window.__area ? window.__area.getBoundingClientRect() : null;
    window.__f.push({
      pad: (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.paddingBottom) || 0),
      cardH: c ? c.height : 0,
      cardW: c ? c.width : 0,
      cardTop: c ? c.top : 0,
      areaTop: a ? a.top : 0,
    });
    window.__raf = requestAnimationFrame(tick);
  };
  tick();
`;

async function record(page, action, ms = 700) {
  await page.evaluate(SAMPLER);
  await action();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__f;
  });
}

const worstStep = (frames, key) => {
  let m = 0;
  for (let i = 1; i < frames.length; i++) m = Math.max(m, Math.abs(frames[i][key] - frames[i - 1][key]));
  return m;
};
const travelled = (frames, key) => Math.abs(frames[frames.length - 1][key] - frames[0][key]);
const reflowed = (frames) => travelled(frames, "pad") > 1;

// A frame is a pop if it covers more than a quarter of the whole move — but
// never mind a few pixels either way, whatever the fraction.
//
// Neither half works alone. A pure percentage cries wolf on small moves: the
// card resizes 8px over a reflow at 1400x900, and one 5px frame of that is
// "63% in a single frame" and is invisible. A pure pixel threshold has to be
// set above the largest legitimate frame of the largest legitimate move — the
// card genuinely resizes 92px at 1400x700, ~16px per frame — and by then it is
// far too loose to catch a 12px jump in a 19px move, which is a real pop.
//
// So: a quarter of the move, with an 8px floor beneath it.
const popped = (worst, total) => worst > Math.max(8, total * 0.25);

// ── The chrome above the card holds still ───────────────────────────────
//
// Not "the top bar is one line" — that is the implementation. The requirement
// is that the card area does not move because of something above it, which is
// what the user sees as the card lurching.
//
// 1400x700 is the size this was found at: wide enough that the tutor reflows
// rather than overlaying, short enough that the card area losing height costs
// the card its size rather than coming out of spare room.
{
  const { browser, page } = await openApp({ width: 1400, height: 700 });
  console.log("\n  the chrome above the card holds still through a reflow");

  const open = await record(page, () => page.click('aside button:has-text("Tutor")'));
  ck("the tutor reflow actually ran", reflowed(open), `${Math.round(travelled(open, "pad"))}px of padding`);
  ck(
    "the card area does not lurch while the column narrows",
    worstStep(open, "areaTop") <= 2,
    `worst single frame moved it ${worstStep(open, "areaTop").toFixed(1)}px (was 39px in one frame when the chip row wrapped)`
  );
  ck(
    "and the card does not lose height in one frame with it",
    !popped(worstStep(open, "cardH"), travelled(open, "cardH")),
    `worst single frame ${worstStep(open, "cardH").toFixed(1)}px of ${travelled(open, "cardH").toFixed(0)}px total`
  );
  await settled(page);

  const close = await record(page, () => page.keyboard.press("Escape"));
  ck(
    "and the same on the way back",
    worstStep(close, "areaTop") <= 2 && !popped(worstStep(close, "cardH"), travelled(close, "cardH")),
    `area ${worstStep(close, "areaTop").toFixed(1)}px, card ${worstStep(close, "cardH").toFixed(1)}px`
  );
  await browser.close();
}

// ── The card animates rather than popping ───────────────────────────────
//
// Both axes, and both directions. The vertical reflow is checked at a tall
// window because that is where the card has centring slack to spend first —
// the case that used to split the move into a slide and then a snap.
{
  console.log("\n  the card animates rather than popping, on both axes");
  for (const [W, H] of [[1400, 900], [1400, 800], [1400, 700]]) {
    const { browser, page } = await openApp({ width: W, height: H });

    const open = await record(page, () => page.click('button:has-text("Send feedback")'));
    ck(
      `${W}x${H}: opening the sheet does not pop the card`,
      !popped(worstStep(open, "cardH"), travelled(open, "cardH")) &&
        !popped(worstStep(open, "cardTop"), travelled(open, "cardTop")),
      `worst frame ${worstStep(open, "cardH").toFixed(1)}px of ${travelled(open, "cardH").toFixed(0)}px height, ` +
        `${worstStep(open, "cardTop").toFixed(1)}px of ${travelled(open, "cardTop").toFixed(0)}px position`
    );
    await settled(page);

    // Closing is the direction that used to be worst: the easing is fastest at
    // the start of the close, so a handover sitting near the closed end got
    // crossed in a frame or two.
    const close = await record(page, () =>
      page.click('[data-feedback-sheet] button[aria-label="Close"]')
    );
    ck(
      `${W}x${H}: closing it does not pop the card either`,
      !popped(worstStep(close, "cardH"), travelled(close, "cardH")) &&
        !popped(worstStep(close, "cardTop"), travelled(close, "cardTop")),
      `worst frame ${worstStep(close, "cardH").toFixed(1)}px of ${travelled(close, "cardH").toFixed(0)}px height, ` +
        `${worstStep(close, "cardTop").toFixed(1)}px of ${travelled(close, "cardTop").toFixed(0)}px position`
    );
    await browser.close();
  }
}

// ── The feedback sheet stays inside the window ──────────────────────────
//
// Written from the requirement — "you can always close it" — rather than from
// the CSS. Checking the sheet's width against 920 would have passed the whole
// time: the width was right, and it was the wrong 920px of the screen.
{
  console.log("\n  the feedback sheet stays inside the window at every width");
  for (const W of [1400, 1200, 1100, 1000, 900, 800]) {
    const { browser, page } = await openApp({ width: W, height: 800 });
    await page.click('button:has-text("Send feedback")');
    await settled(page);
    const m = await page.evaluate(() => {
      const sheet = document.querySelector("[data-feedback-sheet]");
      const r = sheet.getBoundingClientRect();
      const close = sheet.querySelector('button[aria-label="Close"]');
      const cr = close ? close.getBoundingClientRect() : null;
      return {
        overhang: Math.round(r.right - window.innerWidth),
        left: Math.round(r.left),
        width: Math.round(r.width),
        closeRight: cr ? Math.round(cr.right) : null,
        vw: window.innerWidth,
      };
    });
    ck(
      `${W}px: the sheet fits the window`,
      m.overhang <= 0,
      `${m.width}px at left ${m.left}, ${m.overhang > 0 ? `${m.overhang}px off the right edge` : "inside"}`
    );
    // The point of the previous check. The sheet's dismiss controls live at its
    // right end, so a sheet that overflows is a sheet you cannot close.
    ck(
      `${W}px: and its Close button can be reached`,
      m.closeRight !== null && m.closeRight <= m.vw,
      m.closeRight === null ? "no Close button rendered" : `Close ends at ${m.closeRight} of ${m.vw}`
    );
    await browser.close();
  }
}

// ── Resizing across the reflow floor keeps panel and page agreeing ──────
//
// The panel reflows the page only while the column left over stays usable.
// Drag the window across that floor with the panel open and the two must not
// disagree: either the page is holding a column open for the panel, or the
// panel is an overlay with a scrim over the page. Reserving the space while
// the panel sits over the content anyway is the failure this guards.
{
  console.log("\n  resizing across the reflow floor keeps the panel and the page agreeing");
  const { browser, page } = await openApp({ width: 1600, height: 900 });
  await page.click('aside button:has-text("Tutor")');
  await settled(page);
  for (const W of [1600, 1100, 900, 1600]) {
    await page.setViewportSize({ width: W, height: 900 });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const main = document.querySelector("main");
      const panel = document.querySelector('aside[aria-label="Ask the tutor"]');
      const wrap = panel ? panel.parentElement : null;
      const scrim = wrap ? [...wrap.children].some((c) => c !== panel) : false;
      const pr = parseFloat(getComputedStyle(main).paddingRight) || 0;
      const r = panel ? panel.getBoundingClientRect() : null;
      return {
        padRight: Math.round(pr),
        contentRight: Math.round(main.getBoundingClientRect().right - pr),
        panelLeft: r ? Math.round(r.left) : null,
        scrim,
      };
    });
    // Reflowing: the content stops where the panel starts, and there is no
    // scrim because the app beside the panel is still live. Overlaying: no
    // space reserved, and a scrim to catch the click that dismisses it.
    const reflowing = m.padRight > 0;
    ck(
      `${W}px: ${reflowing ? "reflowed, content stops at the panel" : "overlaid, no dead space reserved"}`,
      reflowing ? m.contentRight <= m.panelLeft + 1 && !m.scrim : m.scrim,
      `padding ${m.padRight}, content ends ${m.contentRight}, panel at ${m.panelLeft}, scrim ${m.scrim}`
    );
  }
  await browser.close();
}

await finish(null, ck);
