import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { T } from "./theme";

// The first-visit tour: everything dimmed but one part of the page, with a
// caption beside it saying what to do there. The steps live in
// lib/tourSteps.js; this file only shows them.
//
// A step either explains something (Next moves on) or asks the student to do
// it (`until`): the thing to press gets a pulsing outline, and the tour moves
// on by itself once the app's state says it was done. Clicks on the dimmed
// part do nothing but shake the caption. On a step that asks, the lit part
// works as usual; on one that explains it is only to look at, unless the
// step says `touch`, so that nothing (the tutor, the upload window) opens
// under the dimming.
//
// Between steps the highlight and caption fade out where they are, the page
// changes under an even dim, and the new ones fade in where they belong.
// Nothing moves across the screen (owner, 2026-10-06: "highlights shouldn't
// fly in"), and nothing snaps (owner, 2026-10-06: Next made the screen
// "flicker and jerk"). A step whose page is still moving (a panel sliding in)
// waits for it with `settle`.

const Z = 20000; // above every panel, scrim, menu and toast in the app
const GAP = 16;
const EDGE = 10;
const SCRIM = "rgba(3,22,50,0.55)";
const RING = "rgba(255,255,255,0.55)";
const FADE_OUT = 160;
const FADE_IN = 220;

// The transition for a part fading in (`on`) or out.
const fade = (on, props = ["opacity"]) =>
  props.map((p) => `${p} ${on ? FADE_IN : FADE_OUT}ms ease`).join(", ");

const val = (x, ...args) => (typeof x === "function" ? x(...args) : x);
const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// The box around every element the selectors find on screen, or null.
function rectOf(selectors) {
  let r = null;
  for (const sel of list(selectors)) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    r = r
      ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) }
      : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }
  if (r) { r.width = r.right - r.left; r.height = r.bottom - r.top; }
  return r;
}

// Where the caption goes: beside the lit part on the first side in `prefer`
// with room for it, or, when none has room, on the side with the most room,
// overlapping and without an arrow.
function placeBox(r, bw, bh, prefer) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const room = { right: vw - r.right - GAP - EDGE, left: r.left - GAP - EDGE, bottom: vh - r.bottom - GAP - EDGE, top: r.top - GAP - EDGE };
  const need = { right: bw, left: bw, bottom: bh, top: bh };
  let side = prefer.find((s) => room[s] >= need[s]);
  const overlap = !side;
  if (!side) side = [...prefer].sort((a, b) => room[b] / need[b] - room[a] / need[a])[0];
  let x, y;
  if (side === "right") x = r.right + GAP;
  if (side === "left") x = r.left - GAP - bw;
  if (side === "bottom") y = r.bottom + GAP;
  if (side === "top") y = r.top - GAP - bh;
  if (side === "right" || side === "left") y = r.top + r.height / 2 - bh / 2;
  else x = r.left + r.width / 2 - bw / 2;
  x = Math.round(Math.max(EDGE, Math.min(x, vw - bw - EDGE)));
  y = Math.round(Math.max(EDGE, Math.min(y, vh - bh - EDGE)));
  let arrow = null;
  if (!overlap) {
    if (side === "right" || side === "left") {
      const at = Math.max(18, Math.min(r.top + r.height / 2 - y, bh - 18));
      arrow = { top: at - 6, left: side === "right" ? -6 : bw - 6 };
    } else {
      const at = Math.max(18, Math.min(r.left + r.width / 2 - x, bw - 18));
      arrow = { left: at - 6, top: side === "bottom" ? -6 : bh - 6 };
    }
  }
  return { x, y, arrow };
}

// "Click **Lessons**." → Click <b>Lessons</b>.
function Rich({ text }) {
  return String(text).split(/\*\*(.+?)\*\*/g).map((part, k) =>
    k % 2 ? <b key={k} style={S.bold}>{part}</b> : <Fragment key={k}>{part}</Fragment>
  );
}

export default function Tour({ steps, app, onClose }) {
  const [i, setI] = useState(0);
  // The step whose page has settled. Kept as the step's number rather than a
  // flag, so that on the render where the step changes nothing of the new
  // step is lit or shown until it has settled too.
  const [readyStep, setReadyStep] = useState(-1);
  const ready = readyStep === i;
  // Fading out on the way to another step.
  const [leaving, setLeaving] = useState(false);
  const [geo, setGeo] = useState(null);
  const [shake, setShake] = useState(0);
  const boxRef = useRef(null);
  const memo = useRef(null);
  const prevStep = useRef(null);
  const travel = useRef(1);
  const advancing = useRef(null);
  const settling = useRef(null);
  const fading = useRef(null);
  const armed = useRef(false);
  // The step whose `enter` has run: its caption may read what enter kept.
  const arrived = useRef(-1);
  const scrolled = useRef(false);
  const geoKey = useRef("");
  const appRef = useRef(app);
  appRef.current = app;
  const iRef = useRef(i);
  iRef.current = i;

  const step = steps[i];
  const middle = steps.filter((s) => !s.center);
  const count = step.center ? "" : `${middle.indexOf(step) + 1} of ${middle.length}`;

  const close = useCallback(() => {
    clearTimeout(advancing.current);
    clearTimeout(settling.current);
    clearTimeout(fading.current);
    prevStep.current?.leave?.();
    prevStep.current = null;
    onClose();
  }, [onClose]);
  // Fade this step out, then move. A second press while it fades is ignored,
  // so a double click can't skip a step.
  const go = useCallback((n) => {
    clearTimeout(advancing.current);
    advancing.current = null;
    if (n < 0 || fading.current) return;
    if (n >= steps.length) { close(); return; }
    setLeaving(true);
    fading.current = setTimeout(() => {
      fading.current = null;
      travel.current = n >= iRef.current ? 1 : -1;
      setLeaving(false);
      setReadyStep(-1);
      setI(n);
    }, FADE_OUT);
  }, [steps.length, close]);
  const next = () => go(i + 1);
  const back = () => (i === 0 ? close() : go(i - 1));

  // Arriving at a step: leave the last one, set the page up for this one and
  // wait for it to settle. Then, if the step doesn't apply to the page as it
  // now is (the result of a card nobody answered; a card when the lesson has
  // none to deal), go on past it the way the student was going; otherwise
  // light it.
  useEffect(() => {
    if (prevStep.current && prevStep.current !== step) prevStep.current.leave?.();
    prevStep.current = step;
    geoKey.current = "";
    scrolled.current = false;
    armed.current = false;
    memo.current = step.enter?.(appRef.current) ?? null;
    arrived.current = i;
    settling.current = setTimeout(() => {
      if (step.skip?.(appRef.current, memo.current)) {
        const n = i + travel.current;
        if (n < 0 || n >= steps.length) close();
        else setI(n);
      } else {
        setReadyStep(i);
      }
    }, step.settle ?? 60);
    return () => clearTimeout(settling.current);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  // A step the student does moves on by itself once it is done, i.e. once
  // its `until` turns true while the step shows. Arriving with it true
  // already counts going forwards (the card was answered before its step came
  // up), not coming back with Back, or the step would send the student
  // straight forwards again.
  useEffect(() => {
    if (!ready || leaving || !step.until || advancing.current) return;
    if (!step.until(app, memo.current)) { armed.current = true; return; }
    if (!armed.current && travel.current < 0) return;
    const at = i;
    advancing.current = setTimeout(() => {
      advancing.current = null;
      if (iRef.current === at) go(at + 1);
    }, step.delay ?? 400);
  });
  useEffect(() => () => { clearTimeout(advancing.current); clearTimeout(settling.current); clearTimeout(fading.current); }, []);

  // Follow the lit part every frame while a step shows, so the highlight
  // stays on it however the page moves (a panel opening beside the card, a
  // window resized, the Lessons page scrolled).
  useLayoutEffect(() => {
    if (!ready) return;
    let raf;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const s = steps[i];
      const a = appRef.current;
      const spot = s.center ? null : val(s.spot, a);
      if (spot && !scrolled.current) {
        scrolled.current = true;
        const first = document.querySelector(list(spot)[0]);
        if (first) {
          const b = first.getBoundingClientRect();
          if (b.top < 0 || b.bottom > window.innerHeight) first.scrollIntoView({ block: "center" });
        }
      }
      document.querySelectorAll("[data-tour-mark]").forEach((n) => { if (!s.mark || !n.matches(s.mark)) n.removeAttribute("data-tour-mark"); });
      if (s.mark) document.querySelector(s.mark)?.setAttribute("data-tour-mark", "");
      const box = boxRef.current;
      if (!box) return;
      const bw = box.offsetWidth, bh = box.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let r = spot ? rectOf(spot) : null;
      let g;
      if (r) {
        const pad = s.pad ?? 6;
        // Whole pixels, so the edge of a hole filled in to fade it matches
        // the dim around it.
        r = { left: Math.round(Math.max(0, r.left - pad)), top: Math.round(Math.max(0, r.top - pad)), right: Math.round(Math.min(vw, r.right + pad)), bottom: Math.round(Math.min(vh, r.bottom + pad)) };
        r.width = r.right - r.left; r.height = r.bottom - r.top;
        g = { hole: r, ...placeBox(r, bw, bh, s.prefer || ["right", "left", "bottom", "top"]) };
      } else {
        g = { hole: null, x: Math.round((vw - bw) / 2), y: Math.round((vh - bh) / 2 - 20), arrow: null };
      }
      const p = s.until && s.pulse ? rectOf(val(s.pulse, a)) : null;
      g.pulse = p ? { left: p.left - 4, top: p.top - 4, width: p.width + 8, height: p.height + 8 } : null;
      g.vw = vw; g.vh = vh; g.step = i;
      const key = JSON.stringify(g);
      if (key !== geoKey.current) { geoKey.current = key; setGeo(g); }
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      document.querySelectorAll("[data-tour-mark]").forEach((n) => n.removeAttribute("data-tour-mark"));
    };
  }, [ready, i, steps]);

  // Keys. A key pressed on one of the caption's buttons is the browser's
  // (Enter or Space presses that button) and the app never hears it. On a
  // step where the student works the card (`keys`), every other key is the
  // app's, for typing, checking and grading. Everywhere else the tour has
  // them (Enter or → for Next, ← for Back, Escape to close) and the app gets
  // none, so a key pressed to move the tour on can't turn or grade the card
  // behind the dimming.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === "Tab") return;
      if (e.target?.closest?.("[data-tour-box]")) {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(); }
        return;
      }
      if (steps[i].keys) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.key === "Escape") close();
      else if (e.key === "Enter" || e.key === "ArrowRight") go(i + 1);
      else if (e.key === "ArrowLeft") (i === 0 ? close() : go(i - 1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [i, steps, go, close]);

  // Nothing outside the tour hears a press on the dimmed part or on the
  // caption, so it can't close the menu a step has opened.
  const swallow = (e) => e.stopPropagation();
  const nudge = (e) => { e.stopPropagation(); setShake((n) => n + 1); };

  const shown = ready && geo && geo.step === i;
  // Fully on, rather than fading out or not yet in.
  const on = shown && !leaving;
  const hole = on && geo.hole;
  // Where the hole is drawn: the last step's place until the new step is
  // lit, filled with the dim meanwhile, so the switch can't be seen.
  const drawn = geo?.hole;
  const vw = geo?.vw ?? window.innerWidth, vh = geo?.vh ?? window.innerHeight;
  const blocks = hole
    ? [
        { left: 0, top: 0, width: vw, height: hole.top },
        { left: 0, top: hole.bottom, width: vw, height: vh - hole.bottom },
        { left: 0, top: hole.top, width: hole.left, height: hole.height },
        { left: hole.right, top: hole.top, width: vw - hole.right, height: hole.height },
      ]
    : [{ left: 0, top: 0, width: vw, height: vh }];
  if (hole && !step.until && !step.touch) blocks.push({ left: hole.left, top: hole.top, width: hole.width, height: hole.height });
  const first = i === 0, last = i === steps.length - 1;
  // Until the step has set itself up the caption stays empty; it isn't shown
  // before then anyway.
  const live = arrived.current === i;
  const title = live ? val(step.title, app, memo.current) : "";
  const body = live ? val(step.body, app, memo.current) : "";

  return createPortal(
    <div data-tour-root data-tour-step={step.id} onMouseDown={swallow} onPointerDown={swallow} onClick={swallow}>
      <div
        data-tour-hole
        style={{
          ...S.hole,
          ...(drawn
            ? { left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height, borderRadius: step.radius ?? 12 }
            : { ...S.holeShut, left: vw / 2, top: vh / 2 }),
          background: on ? "transparent" : SCRIM,
          boxShadow: `0 0 0 2px ${on && drawn ? RING : "rgba(255,255,255,0)"}, 0 0 0 200vmax ${SCRIM}`,
          transition: fade(on, ["background-color", "box-shadow"]),
        }}
      />
      {blocks.map((b, k) => (
        <div key={k} style={{ ...S.block, ...b }} onMouseDown={on ? nudge : swallow} onClick={swallow} />
      ))}
      {shown && geo.pulse && (
        <div className="tour-pulse" data-tour-pulse style={{ ...S.pulse, ...geo.pulse, borderRadius: step.radius === 99 ? 99 : 10, opacity: on ? 1 : 0, transition: fade(on) }} />
      )}
      <div
        ref={boxRef}
        key={shake}
        role="dialog"
        aria-labelledby="tour-title"
        data-tour-box
        className={shake ? "tour-shake" : undefined}
        style={{
          ...S.box,
          ...(step.center ? S.boxCenter : null),
          left: geo ? geo.x : -9999,
          top: geo ? geo.y : 0,
          opacity: on ? 1 : 0,
          // Hidden the moment the step changes, while still empty: a caption
          // left "visible" until a timer ran out could show (to a screen
          // reader) the next step's title before that step had set itself up.
          visibility: shown ? "visible" : "hidden",
          transition: fade(on),
        }}
      >
        {geo?.arrow && <div style={{ ...S.arrow, ...geo.arrow }} />}
        <div style={S.top}>
          <span style={S.count}>{count}</span>
          {!step.center && <button style={S.skip} onClick={close} data-tour-skip>Skip tour</button>}
        </div>
        <div id="tour-title" style={step.center ? { ...S.title, ...S.titleCenter } : S.title}>{title}</div>
        <div style={step.center ? { ...S.body, ...S.bodyCenter } : S.body}><Rich text={body} /></div>
        <div style={S.actions}>
          <button style={S.back} onClick={back} data-tour-back>{first ? "Not now" : "Back"}</button>
          <button
            style={step.until ? { ...S.next, ...S.nextQuiet } : step.center ? { ...S.next, ...S.nextBig } : S.next}
            onClick={next}
            data-tour-next
          >
            {first ? "Start the tour" : last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const S = {
  hole: { position: "fixed", zIndex: Z, pointerEvents: "none", borderRadius: 12 },
  holeShut: { width: 0, height: 0 },
  block: { position: "fixed", zIndex: Z + 1 },
  pulse: { position: "fixed", zIndex: Z + 2, pointerEvents: "none", border: `2px solid ${T.color.secondary}`, boxSizing: "border-box" },
  box: { position: "fixed", zIndex: Z + 3, width: 292, boxSizing: "border-box", background: T.color.surfaceLowest, borderRadius: 14, boxShadow: "0 24px 60px rgba(3,22,50,0.3)", padding: "16px 18px 14px", fontFamily: T.font.sans, textAlign: "left" },
  boxCenter: { width: 380, padding: "28px 30px 22px" },
  arrow: { position: "absolute", width: 12, height: 12, background: T.color.surfaceLowest, transform: "rotate(45deg)", borderRadius: 2 },
  top: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, minHeight: 16 },
  count: { fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: T.color.secondary },
  skip: { border: "none", background: "none", padding: "2px 0", fontSize: 11, fontWeight: 600, color: T.color.onSurfaceVariant, cursor: "pointer", fontFamily: T.font.sans },
  title: { position: "relative", fontFamily: T.font.serif, fontSize: 17, fontWeight: 600, color: T.color.primary, letterSpacing: "-0.01em", marginBottom: 6 },
  titleCenter: { fontSize: 24, marginBottom: 10 },
  body: { position: "relative", fontSize: 13, lineHeight: 1.55, color: T.color.onSurface },
  bodyCenter: { fontSize: 14 },
  bold: { color: T.color.primary, fontWeight: 700 },
  actions: { position: "relative", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 16 },
  back: { padding: "8px 12px", border: "none", background: "transparent", fontSize: 12, fontWeight: 600, color: T.color.onSurfaceVariant, cursor: "pointer", marginRight: "auto", fontFamily: T.font.sans },
  next: { padding: "9px 18px", border: "none", borderRadius: 8, background: T.gradient.ink, color: T.color.onPrimary, fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 6px 18px rgba(3,22,50,0.16)", fontFamily: T.font.sans },
  nextQuiet: { background: "transparent", color: T.color.primary, border: "1px solid rgba(3,22,50,0.16)", boxShadow: "none", fontWeight: 600 },
  nextBig: { padding: "11px 22px", fontSize: 14 },
};
