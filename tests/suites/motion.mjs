// "Smooth" is measurable: sample what moves every frame through an open and a
// close, and check it moves continuously — and that what shouldn't move, doesn't.
//
// This exists because "the reflow is jerky" was reported repeatedly and fixed
// by eye. Six timings were on screen at once: the feedback sheet slid in over
// 180ms with one curve, the page made room over 420ms with another, the card
// area gave up its padding over 200ms with a third, and the sheet had no exit
// animation at all — it vanished in a single frame while the page took 420ms
// to close the gap behind it.
//
// The feedback panel has since moved into the sidebar and moves nothing but
// itself, so the questions for it are different: does the PAGE hold perfectly
// still on every frame of its open and close, and does the panel itself fade
// rather than pop. The page-and-panel-on-one-clock question now belongs to the
// tutor, which is the panel that still moves the page.
import { openApp, finish, checker, settled } from "../harness.mjs";

const ck = checker();
const { browser, page } = await openApp();

// Away from the sidebar, the card and every control.
const OUTSIDE = [1300, 860];

async function record(action, ms = 600) {
  await page.evaluate(() => {
    window.__frames = [];
    const card = [...document.querySelectorAll("div")].find(
      (d) => getComputedStyle(d).transformStyle === "preserve-3d"
    );
    const account = [...document.querySelectorAll("aside *")].find(
      (n) => n.children.length === 0 && /@example\.com/.test(n.textContent || "")
    );
    const tick = () => {
      const panel = document.querySelector("[data-feedback-sheet]");
      const main = document.querySelector("main");
      const cs = getComputedStyle(main);
      const c = card.getBoundingClientRect();
      window.__frames.push({
        present: !!panel,
        opacity: panel ? parseFloat(getComputedStyle(panel).opacity) : null,
        contentBottom: main.getBoundingClientRect().bottom - (parseFloat(cs.paddingBottom) || 0),
        padRight: parseFloat(cs.paddingRight) || 0,
        cardTop: c.top,
        cardH: c.height,
        accountTop: account ? account.getBoundingClientRect().top : 0,
      });
      window.__raf = requestAnimationFrame(tick);
    };
    tick();
  });
  await action();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames;
  });
}

// The largest distance any of these ever strays from its first-frame value.
function stray(frames, keys) {
  const first = frames[0];
  let worst = 0, which = "";
  for (const f of frames) for (const k of keys) {
    const d = Math.abs(f[k] - first[k]);
    if (d > worst) { worst = d; which = k; }
  }
  return { worst, which };
}
const PAGE = ["contentBottom", "padRight", "cardTop", "cardH", "accountTop"];

// Whether the panel is mid-fade right now, read from the animation itself
// rather than counted in sampled frames. Headless Chrome on some machines
// delivers five frames in 600ms, and a frame count then says "popped" about a
// fade that ran fine; a running opacity transition is the same fact without
// depending on the frame rate.
const fading = () => page
  .waitForFunction(() => {
    const el = document.querySelector("[data-feedback-sheet]");
    const a = el && el.getAnimations().find((x) => x.transitionProperty === "opacity");
    return !!a && a.playState === "running" && a.effect.getTiming().duration > 0;
  }, null, { polling: 10, timeout: 500 })
  .then(() => true, () => false);

console.log("\n  opening feedback");
let midOpen = null;
const open = await record(async () => {
  await page.click('button:has-text("Send feedback")');
  midOpen = await fading();
});
{
  const s = stray(open, PAGE);
  console.log(`  ${open.length} frames, page strayed ${s.worst.toFixed(1)}px (${s.which || "nothing"}); fading in: ${midOpen}`);
  ck("the page holds perfectly still on every frame", s.worst <= 0.5, `${s.worst.toFixed(1)}px on ${s.which}`);
  ck("the panel fades in rather than popping", midOpen === true, "no running opacity transition on the way in");
}

console.log("\n  closing feedback");
await settled(page);
let midClose = null;
const close = await record(async () => {
  await page.mouse.click(...OUTSIDE);
  midClose = await fading();
});
{
  const s = stray(close, PAGE);
  // The old sheet was unmounted in one frame here — the pop this exists to catch.
  console.log(`  ${close.length} frames, page strayed ${s.worst.toFixed(1)}px (${s.which || "nothing"}); fading out: ${midClose}`);
  ck("the page holds perfectly still on every frame", s.worst <= 0.5, `${s.worst.toFixed(1)}px on ${s.which}`);
  ck("the panel fades out rather than vanishing", midClose === true, "no running opacity transition on the way out");
  ck("and is gone at the end", !close[close.length - 1].present);
}

console.log("\n  one duration and one curve for the panel that moves the page");
// Measured on the two things that actually MOVE: the tutor's own transform
// and the padding the page makes room with.
//
// This check used to find "the element under `main` whose transition mentions
// padding-bottom", which was `cardArea` — whose padding-bottom had been a
// constant 0 ever since `cardTopSpacer` took that job over. So it confirmed a
// DECLARATION rather than a movement: it would have passed just as happily
// with the property deleted, and it did pass for as long as the dead
// declaration sat there. The declaration is now gone and this asks the
// question it was meant to ask.
await settled(page);
await page.click('aside button:has-text("Tutor")');
await page.waitForSelector("[data-tutor-panel]");
await settled(page);
const timings = await page.evaluate(() => {
  const pick = (el, want) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    // Split on commas OUTSIDE the cubic-bezier parentheses.
    const props = cs.transitionProperty.split(",").map((x) => x.trim());
    const fns = cs.transitionTimingFunction.split(/,(?![^(]*\))/).map((x) => x.trim());
    const durs = cs.transitionDuration.split(",").map((x) => x.trim());
    const i = props.indexOf(want);
    return {
      found: i !== -1,
      prop: want,
      dur: durs[i] ?? durs[0],
      fn: fns[i] ?? fns[0],
      allSame: new Set(fns).size === 1 && new Set(durs).size === 1,
    };
  };
  return {
    main: pick(document.querySelector("main"), "padding-right"),
    tutor: pick(document.querySelector("[data-tutor-panel]"), "transform"),
  };
});
console.log(`  main ${JSON.stringify(timings.main)}`);
console.log(`  tutor ${JSON.stringify(timings.tutor)}`);
ck(
  "the page animates the padding it makes room with",
  !!timings.main?.found,
  `main transitions ${timings.main?.found ? timings.main.prop : "not padding-right"}`
);
ck(
  "the tutor animates the transform it moves on",
  !!timings.tutor?.found,
  `tutor transitions ${timings.tutor?.found ? timings.tutor.prop : "not transform"}`
);
ck(
  "the tutor moves on the same clock as the page",
  !!timings.tutor && timings.tutor.dur === timings.main.dur && timings.tutor.fn === timings.main.fn,
  `tutor ${timings.tutor?.dur} ${timings.tutor?.fn} vs main ${timings.main?.dur} ${timings.main?.fn}`
);
ck("the page's own transitions agree with each other", timings.main.allSame, JSON.stringify(timings.main));

await finish(browser, ck);
