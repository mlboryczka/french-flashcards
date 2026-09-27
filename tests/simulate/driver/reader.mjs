// Runs in the page. Reads what the student sees (counter, prompt, answer,
// buttons, checkpoint) and, for the record only, the app's in-memory block
// (React state: the dealt queue with each entry's bucket) so the analysis can
// check serving exactly. Nothing here changes the page.
export const READ_STATE = (opts = {}) => {
  const out = {
    now: Date.now(), local: new Date().toString(),
    checkpoint: null, counter: null, idx: null, blockLen: null, retryMarker: false,
    front: null, back: null, instruction: null, flipped: false,
    gotIt: false, again: false, showAnswerBtn: false, typeInput: false, typeResultText: null,
    unsaved: null, emptyCaughtUp: false, dir: null, typeModeOn: null, pending: null,
    queue: null, userCardsDigest: null,
  };
  const norm = (s) => (s == null ? s : String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim());
  const cp = document.querySelector("[data-checkpoint]");
  if (cp) {
    out.checkpoint = {
      text: cp.innerText,
      hasContinue: [...cp.querySelectorAll("button")].some((b) => b.innerText.trim() === "Continue"),
    };
  }
  const bodyText = document.body.innerText;
  const m = bodyText.match(/CARD (\d+) OF (\d+)([^\n]*)/i);
  if (m && !cp) {
    out.counter = m[0].trim(); out.idx = +m[1] - 1; out.blockLen = +m[2];
  }
  out.retryMarker = !!document.querySelector("[data-retry]");
  out.unsaved = document.querySelector("[data-unsaved]")?.innerText || null;
  out.emptyCaughtUp = /You're all caught up\.\s*Nothing is due, and there are no new cards here/i.test(bodyText) && !cp;
  const cardEl = [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).transformStyle === "preserve-3d");
  if (cardEl) {
    out.flipped = /rotateY\(180deg\)/.test(cardEl.style.transform || "");
    const pick = (face, min, weight) => [...face.querySelectorAll("div")].find((d) => {
      const cs = getComputedStyle(d);
      return d.children.length === 0 && cs.fontWeight === weight && parseFloat(cs.fontSize) >= min;
    });
    const f = cardEl.children[0], b = cardEl.children[1];
    out.front = norm(pick(f, 18, "700")?.innerText);
    out.back = norm(pick(b, 15.5, "600")?.innerText);
    out.instruction = norm(f.querySelector("[data-card-instruction]")?.innerText || null);
  }
  const buttons = [...document.querySelectorAll("button")];
  out.gotIt = buttons.some((x) => x.innerText.trim() === "Got It");
  out.again = buttons.some((x) => x.innerText.trim() === "Again");
  out.showAnswerBtn = buttons.some((x) => x.innerText.trim() === "Show answer");
  out.typeInput = !!document.querySelector('input[placeholder^="Type"]');
  const tr = bodyText.match(/^(✓ Correct!|✓ Close enough[^\n]*|✗ Wrong article[^\n]*|✗ You wrote[^\n]*|✗ Answer:[^\n]*|Answer: [^\n]*)$/m);
  out.typeResultText = tr ? tr[1] : null;
  // The active direction button is the one styled differently from the other two.
  const dirButtons = buttons.filter((x) => ["FR→EN", "EN→FR", "Mixed"].includes(x.innerText.trim()));
  if (dirButtons.length === 3) {
    const bg = dirButtons.map((x) => getComputedStyle(x).backgroundColor);
    const odd = bg.findIndex((c, i) => bg.filter((d) => d === c).length === 1);
    out.dir = odd >= 0 ? ["fr", "en", "mix"][odd] : null;
  }
  out.typeModeOn = out.typeInput || out.typeResultText != null || /Tap to show answer/.test(bodyText);
  out.pending = document.querySelector("[data-pending-switch]")?.innerText || document.querySelector("[data-pending-direction]")?.innerText || null;

  // React state, read-only: the block as dealt, and (optionally) the in-memory deck.
  const anchor = cardEl || cp || document.querySelector("main");
  if (anchor) {
    const fk = Object.keys(anchor).find((k) => k.startsWith("__reactFiber$"));
    let fib = fk ? anchor[fk] : null;
    let deck = null, userCards = null;
    while (fib && !(deck && userCards)) {
      if (typeof fib.type === "function" && fib.memoizedState) {
        let h = fib.memoizedState;
        let guard = 0;
        while (h && guard++ < 400) {
          const v = h.memoizedState;
          if (!deck && Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "shownDir" in v[0] && "_bucket" in v[0]) deck = v;
          if (!userCards && Array.isArray(v) && v.length > 20 && v[0] && typeof v[0] === "object" && "row_id" in v[0] && "fsrs_state" in v[0] && !("shownDir" in v[0])) userCards = v;
          h = h.next;
        }
      }
      fib = fib.return;
    }
    if (deck) out.queue = deck.map((c) => ({ row_id: c.row_id, dir: c.shownDir, bucket: c._bucket, retry: !!c._retry }));
    if (userCards && opts.digest) {
      out.userCardsDigest = userCards.map((c) => [c.row_id, c.fsrs_state, c.next_due_at, c.last_review, c.en_fsrs_state, c.en_next_due_at, c.en_last_review, c.stability, c.en_stability]);
    }
  }
  return out;
};
