// One duration and one curve for every panel that moves the page.
//
// The feedback sheet used to slide in over 180ms with `ease-out` while the
// page made room over 420ms with this curve, and the card area gave up its
// padding over 200ms with `ease` — three timings on screen at once, which is
// what "jerky" was. Anything that animates as part of a panel opening or
// closing uses these.
export const PANEL_ANIM_MS = 420;
export const PANEL_EASING = "cubic-bezier(0.22, 0.61, 0.24, 1)";
