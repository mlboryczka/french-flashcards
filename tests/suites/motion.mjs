// "Smooth" is measurable: sample the moving edges every frame through an open
// and a close, and check they travel continuously — no frame where something
// leaps a large fraction of the total distance, and no element left behind by
// the others.
//
// This exists because "the reflow is jerky" was reported repeatedly and fixed
// by eye. Six timings were on screen at once: the sheet slid in over 180ms
// with one curve, the page made room over 420ms with another, the card area
// gave up its padding over 200ms with a third, and the sheet had no exit
// animation at all — it vanished in a single frame while the page took 420ms
// to close the gap behind it.
import { openApp, finish, checker, settled } from "../harness.mjs";

const ck = checker();
const { browser, page } = await openApp();

// Sample the panel's top edge and the content's bottom edge together — they
// have to move as one, or you see the gap open and close.
async function record(action, ms = 700) {
  await page.evaluate(() => {
    window.__frames = [];
    const tick = () => {
      const sheet = document.querySelector("[data-feedback-sheet]");
      const main = document.querySelector("main");
      const cs = getComputedStyle(main);
      const pad = parseFloat(cs.paddingBottom) || 0;
      window.__frames.push({
        t: performance.now(),
        sheetTop: sheet ? sheet.getBoundingClientRect().top : window.innerHeight,
        contentBottom: main.getBoundingClientRect().bottom - pad,
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

function analyse(frames, label) {
  const first = frames[0], last = frames[frames.length - 1];
  const travel = Math.abs(last.sheetTop - first.sheetTop);
  let biggestStep = 0, biggestGapDrift = 0;
  const drifts = [];
  for (let i = 1; i < frames.length; i++) {
    biggestStep = Math.max(biggestStep, Math.abs(frames[i].sheetTop - frames[i - 1].sheetTop));
    // The content edge should stay level with the panel edge the whole way.
    const drift = Math.abs(
      (frames[i].contentBottom - frames[i].sheetTop) - (first.contentBottom - first.sheetTop)
    );
    biggestGapDrift = Math.max(biggestGapDrift, drift);
    drifts.push(drift);
  }
  // Drift is judged on the TYPICAL frame, not the worst one.
  //
  // The bug this guards against — the page setting off two frames before the
  // sheet — separates the two edges for the whole move, so it shows up in
  // every frame. A max, by contrast, fails on one unlucky sample: catch the
  // instant after one element's style is applied and before the other's and
  // you read a whole frame of lag, about 16px, that nobody could see. On the
  // close animation that pushed the max to 32px on roughly half of runs while
  // the median sat at 16, which is how this check came to fail at random on
  // an app that was fine.
  const sorted = [...drifts].sort((a, b) => a - b);
  const typicalDrift = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const pct = travel ? Math.round((biggestStep / travel) * 100) : 0;
  console.log(`  ${label}: ${frames.length} frames, travelled ${Math.round(travel)}px, biggest single step ${Math.round(biggestStep)}px (${pct}% of the move), panel/content drift ${Math.round(typicalDrift)}px typical / ${Math.round(biggestGapDrift)}px worst frame`);
  return { travel, biggestStep, pct, biggestGapDrift, typicalDrift };
}

console.log("\n  opening");
const open = analyse(await record(async () => {
  await page.click('button:has-text("Send feedback")');
}), "open");
ck("the panel actually travels", open.travel > 60, `${Math.round(open.travel)}px`);
ck("no frame jumps a large part of the distance", open.pct <= 25, `${open.pct}% in one frame`);
ck("the page keeps pace with the panel", open.typicalDrift <= 24, `${Math.round(open.typicalDrift)}px on the typical frame`);
ck("and never falls badly behind it", open.biggestGapDrift <= 48, `${Math.round(open.biggestGapDrift)}px worst frame`);

console.log("\n  closing");
const close = analyse(await record(async () => {
  await page.mouse.click(80, 60);
}), "close");
// The sheet used to be unmounted in one frame here, so the whole distance was
// covered by a single step — the pop this test exists to catch.
ck("the panel slides out rather than vanishing", close.travel > 60, `${Math.round(close.travel)}px`);
ck("no frame jumps a large part of the distance", close.pct <= 25, `${close.pct}% in one frame`);
ck("the page keeps pace with the panel", close.typicalDrift <= 24, `${Math.round(close.typicalDrift)}px on the typical frame`);
ck("and never falls badly behind it", close.biggestGapDrift <= 48, `${Math.round(close.biggestGapDrift)}px worst frame`);

console.log("\n  one duration and one curve everywhere");
// Measured on the two things that actually MOVE: the sheet's own transform and
// the padding the page makes room with.
//
// This check used to find "the element under `main` whose transition mentions
// padding-bottom", which was `cardArea` — whose padding-bottom had been a
// constant 0 ever since `cardTopSpacer` took that job over. So it confirmed a
// DECLARATION rather than a movement: it would have passed just as happily
// with the property deleted, and it did pass for as long as the dead
// declaration sat there. The declaration is now gone and this asks the
// question it was meant to ask.
await page.click('button:has-text("Send feedback")');
await page.waitForSelector("[data-feedback-sheet]");
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
    main: pick(document.querySelector("main"), "padding-bottom"),
    sheet: pick(document.querySelector("[data-feedback-sheet]"), "transform"),
  };
});
console.log(`  main ${JSON.stringify(timings.main)}`);
console.log(`  sheet ${JSON.stringify(timings.sheet)}`);
ck(
  "the page animates the padding it makes room with",
  !!timings.main?.found,
  `main transitions ${timings.main?.found ? timings.main.prop : "not padding-bottom"}`
);
ck(
  "the panel animates the transform it moves on",
  !!timings.sheet?.found,
  `sheet transitions ${timings.sheet?.found ? timings.sheet.prop : "not transform"}`
);
ck(
  "the panel moves on the same clock as the page",
  !!timings.sheet && timings.sheet.dur === timings.main.dur && timings.sheet.fn === timings.main.fn,
  `sheet ${timings.sheet?.dur} ${timings.sheet?.fn} vs main ${timings.main?.dur} ${timings.main?.fn}`
);
ck("the page's own transitions agree with each other", timings.main.allSame, JSON.stringify(timings.main));

await finish(browser, ck);
