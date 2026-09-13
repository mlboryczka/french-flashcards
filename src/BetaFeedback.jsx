import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";
import { cleanFrenchPrompt } from "./lib/cardText";
import { PANEL_EASING } from "./lib/motion";

// "Send feedback" trigger + the panel it opens. Posts to beta_feedback table.
//
// Design notes:
//   • The panel lives INSIDE THE SIDEBAR, in the empty stretch between the
//     Tutor nav item and the account block, as its own inset card. It never
//     covers the card and never moves the page. It used to be a bottom sheet
//     across the content column that pushed the page up to make room, which
//     cost the card ~140px of height while it was open, sat nowhere near the
//     link that opened it, and was the source of every feedback entry in the
//     reflow notes: the sheet hanging off the right edge, the page and sheet
//     drifting apart mid-slide, and the card shrinking as you typed because
//     the page tracked the sheet's height line by line.
//   • Closing never throws anything away. The draft (message, screenshot,
//     attach choice) lives in this component, which stays mounted with its
//     trigger, so ✕, Escape, an outside click, the trigger itself and opening
//     the tutor all just put the panel away, and reopening brings the draft
//     back. The trigger carries a dot while a draft is waiting. This retired
//     the "Discard your feedback?" confirm, the Minimize bar (which existed
//     only to keep a draft safe while you looked at the app), and the
//     close-request handshake FlashcardApp used so the tutor couldn't eat a
//     draft.
//   • Sending is the only thing that clears the draft, and it clears it the
//     moment the row is written. The panel closes at once and the result is
//     announced in the same spot. The old version kept the sheet up for 1.5s
//     with a "Thanks!" banner and the sent text still in the field; an outside
//     click in that window read the sent text as a draft and asked whether to
//     discard it, and both answers closed the sheet — so nobody could tell
//     whether anything had been deleted. Nothing had.
//   • "Attach current card" toggle captures a structured snapshot of
//     the card into beta_feedback.card_context (jsonb). Admin view
//     renders this as a card preview — no screenshots needed for
//     card-specific feedback. The flag on the card itself opens the panel
//     with this switched on (`attachRequest`).
//
// Requires migration_003_feedback_card_context.sql to add the
// card_context column. Screenshot upload still works as before
// (requires the `screenshot` column from the earlier migration).

const MIN_LENGTH = 5;
const TOAST_MS = 5000;
// Short: the panel moves nothing but itself, so it has no page movement to
// keep pace with. The curve is the app's panel curve so it still feels like
// one family.
const DOCK_ANIM_MS = 200;

export function BetaFeedback({
  user,
  currentPage,
  currentCard,
  // Controlled by FlashcardApp so this and the tutor panel can never be open
  // together.
  open,
  onOpen,
  onClose,
  // The sidebar element the panel and its toast render into. FlashcardApp
  // owns where that is; null (narrow layout) means there is nowhere to show it.
  dockEl,
  // Bumped by the flag on the card. Each bump switches "attach this card" on,
  // even if it had been switched off for an earlier draft.
  attachRequest = 0,
}) {
  const panelRef = useRef(null);
  const triggerRef = useRef(null);

  // `mounted` keeps the panel in the DOM until the exit fade finishes;
  // `entered` drives it. Without this it vanished in a single frame.
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    setEntered(false);
    const t = setTimeout(() => setMounted(false), DOCK_ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);
  // Force the start state to be computed, then flip to the end state in the
  // same commit. Keying off `open` alone would set the end state before the
  // start state existed, and the transition would never run. Not the
  // two-requestAnimationFrame dance the tutor uses: where rAF is throttled
  // (a headless or backgrounded page) that left the panel mounted at opacity
  // 0 — open, focused, and invisible.
  useLayoutEffect(() => {
    if (!mounted || !open || !panelRef.current) return;
    panelRef.current.getBoundingClientRect();
    setEntered(true);
  }, [mounted, open, dockEl]);

  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | error
  const [error, setError] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotName, setScreenshotName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  // { kind: "sent" | "failed", id } — the outcome of a send.
  const [toast, setToast] = useState(null);
  // Attach-card toggle: default ON when a card is provided, OFF otherwise.
  // We reconcile whenever a card appears/disappears so navigating during
  // composition doesn't silently flip your choice.
  const [attachCard, setAttachCard] = useState(!!currentCard);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  const submitting = status === "submitting";
  const trimmed = message.trim();
  const hasDraft = trimmed.length > 0 || !!screenshot;

  // A send can outlive the panel (you can close it mid-send), so the result
  // handler reads whether it is still open from here, not from a stale closure.
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  // The toast and the panel share a spot; opening the panel retires the toast
  // rather than parking it to reappear when the panel closes.
  useEffect(() => { if (open) setToast(null); }, [open]);

  // Three lines at rest, growing with the content. The panel is only as wide
  // as the sidebar, so one line held about four words.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 60), 132)}px`;
  }, [message, mounted]);

  // Reopening onto a saved draft puts the caret at the end of it, where you
  // left off, rather than in front of the first word.
  useEffect(() => {
    if (!mounted || !open) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [mounted, open]);

  // If the user navigates to a page with no card (stats, etc.) while the
  // panel is open, turn attachment off. When a card reappears, default
  // back to on — but only if the user hasn't explicitly unchecked it.
  const userTouchedAttach = useRef(false);
  useEffect(() => {
    if (!userTouchedAttach.current) setAttachCard(!!currentCard);
  }, [currentCard]);
  // Opened from the card's own flag: that card is what this is about.
  useEffect(() => {
    if (!attachRequest) return;
    userTouchedAttach.current = false;
    setAttachCard(true);
  }, [attachRequest]);

  const fileToBase64 = useCallback((file) => {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("Not an image file"));
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        reject(new Error("Image too large (max 5MB)"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read image"));
      reader.readAsDataURL(file);
    });
  }, []);

  const handleImage = useCallback(async (file) => {
    if (!file) return;
    try {
      const dataUrl = await fileToBase64(file);
      setScreenshot(dataUrl);
      setScreenshotName(file.name || "screenshot");
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [fileToBase64]);

  // Bound to the panel, so a paste lands wherever the cursor happens to be.
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        handleImage(item.getAsFile());
        return;
      }
    }
  }, [handleImage]);

  // Put the panel away. Never clears anything — see the design notes.
  // `returnFocus` is for the deliberate closes (✕, Escape, a send): focus goes
  // back to the trigger instead of falling to <body>. An outside click has
  // already put focus where the user clicked, and taking it from there would
  // be rude.
  const close = useCallback(({ returnFocus = false } = {}) => {
    const hadFocus = panelRef.current?.contains(document.activeElement);
    onClose?.();
    if (returnFocus && hadFocus) triggerRef.current?.focus();
  }, [onClose]);

  // Click anywhere outside to close, and Escape. Both harmless now that
  // closing keeps the draft. (The tutor and the lesson notes deliberately
  // ignore both — Escape is the reflex for clearing an answer mid-card — but
  // this is the one panel you open, use and put away.)
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      // The trigger toggles on its own click; the flag and the tutor toggle
      // open their own things and close this on the way.
      if (e.target.closest?.("[data-feedback-toggle]")) return;
      if (e.target.closest?.("[data-report-card]")) return;
      if (e.target.closest?.("[data-tutor-toggle]")) return;
      close();
    };
    const onKey = (e) => { if (e.key === "Escape") close({ returnFocus: true }); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  async function handleSubmit() {
    if (submitting) return;
    if (trimmed.length < MIN_LENGTH) {
      setError("Write a few words first.");
      textareaRef.current?.focus();
      return;
    }
    setStatus("submitting");
    setError("");

    const base = {
      user_id: user?.id || null,
      user_email: user?.email || null,
      message: trimmed,
      page: currentPage || null,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    };

    // Build card_context snapshot if toggle is on and card is available
    const cardContext = (attachCard && currentCard) ? {
      card_id: currentCard.id || null,
      front: currentCard.f,
      back: currentCard.b,
      category: currentCard.cat,
      shown_dir: currentCard.shownDir,
    } : null;

    const full = { ...base };
    if (screenshot) full.screenshot = screenshot;
    if (cardContext) full.card_context = cardContext;

    // Try full row; if schema is missing the optional columns, drop them
    // and retry. This matches the original resilience pattern.
    let err = null;
    try {
      ({ error: err } = await supabase.from("beta_feedback").insert(full));
      if (err && /card_context|screenshot|column/i.test(err.message)) {
        // Retry without optional columns
        const fallback = { ...base };
        if (screenshot && !/card_context/i.test(err.message)) {
          fallback.screenshot = screenshot;
        }
        const retry = await supabase.from("beta_feedback").insert(fallback);
        err = retry.error;
      }
    } catch (e) {
      err = e;
    }

    if (err) {
      setError(err.message || "Failed to send");
      setStatus("error");
      // Closed mid-send, the inline error would never be seen. The draft is
      // still here, and the toast says so.
      if (!openRef.current) setToast({ kind: "failed", id: Date.now() });
      return;
    }

    // Sent: there is no draft any more, so there is nothing a later close
    // could ask about. Clear first, then close, then say so.
    setMessage("");
    setScreenshot(null);
    setScreenshotName("");
    setStatus("idle");
    setError("");
    userTouchedAttach.current = false;
    setAttachCard(!!currentCard);
    if (openRef.current) close({ returnFocus: true });
    setToast({ kind: "sent", id: Date.now() });
  }

  return (
    <>
      <button
        ref={triggerRef}
        data-feedback-toggle
        // A waiting draft lifts the trigger out of its usual 0.6 so the dot
        // reads as a signal rather than a smudge.
        style={hasDraft && !open ? { ...BF.trigger, opacity: 0.9 } : BF.trigger}
        // A toggle: the same link that opened the panel puts it away.
        onClick={() => (open ? close({ returnFocus: true }) : onOpen?.())}
        aria-expanded={open}
        title={hasDraft && !open ? "You have an unsent draft" : undefined}
      >
        Send feedback
        {hasDraft && !open && <span data-feedback-draft style={BF.draftDot} aria-label="(draft saved)" />}
      </button>

      {dockEl && mounted && createPortal(
        // The WHOLE panel is the drop target and the paste target.
        <div
          role="dialog"
          aria-label="Send feedback"
          style={{
            ...BF.panel,
            ...(isDragging ? BF.panelDrag : null),
            opacity: entered ? 1 : 0,
            transform: entered ? "translateY(0)" : "translateY(8px)",
          }}
          ref={panelRef}
          data-feedback-sheet
          onPaste={handlePaste}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={(e) => {
            // Only when the pointer actually leaves the panel, not on every
            // crossing between the children inside it.
            if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleImage(e.dataTransfer?.files?.[0]);
          }}
        >
          <div style={BF.header}>
            <h2 style={BF.title}>Send feedback</h2>
            <button
              style={BF.iconBtn}
              onClick={() => close({ returnFocus: true })}
              aria-label="Close"
              title="Close — your draft is kept"
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
            </button>
          </div>

          <textarea
            ref={textareaRef}
            style={BF.textarea}
            value={message}
            onChange={(e) => { setMessage(e.target.value); if (error) setError(""); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
            }}
            placeholder={isDragging ? "Drop the image anywhere here" : "Wrong translation, bad audio, a bug…"}
            aria-label="Your feedback"
            disabled={submitting}
            rows={3}
          />

          {error && <div style={BF.error} role="alert">{error}</div>}

          <div style={BF.chips}>
            {currentCard && (
              <button
                type="button"
                data-attach-card
                style={attachCard ? { ...BF.chip, ...BF.chipOn } : BF.chip}
                onClick={() => { userTouchedAttach.current = true; setAttachCard((v) => !v); }}
                aria-pressed={attachCard}
                title={attachCard ? `Attaching: ${currentCard.f} · ${currentCard.b}` : "Attach the card you're looking at"}
              >
                <CardIcon />
                {/* The prompt as you saw it, not the raw stored front — the
                    chip shouldn't show a gloss the card itself hides. The
                    full row is still sent, and the tooltip has the original. */}
                <span style={BF.chipLabel}>About: {cleanFrenchPrompt(currentCard.f, currentCard.b)}</span>
              </button>
            )}
            {/* An attached image lives IN its chip — thumbnail, name, remove —
                rather than in a preview row of its own. */}
            {screenshot ? (
              <span style={{ ...BF.chip, ...BF.chipOn, padding: "3px 4px", cursor: "default" }}>
                <button
                  type="button"
                  style={BF.chipInner}
                  onClick={() => fileInputRef.current?.click()}
                  title={`${screenshotName} — click to replace`}
                >
                  <img src={screenshot} alt="Attached" style={BF.imgThumb} />
                  <span style={BF.chipLabel}>{screenshotName}</span>
                </button>
                <button
                  type="button"
                  style={{ ...BF.chipInner, padding: "0 6px", fontSize: 13 }}
                  onClick={() => { setScreenshot(null); setScreenshotName(""); }}
                  aria-label="Remove image"
                >
                  ✕
                </button>
              </span>
            ) : (
              <button
                type="button"
                style={BF.chip}
                onClick={() => fileInputRef.current?.click()}
                title="Attach a screenshot — or drop one on this panel, or paste it"
              >
                <ImageIcon />
                Screenshot
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => { handleImage(e.target.files?.[0]); e.target.value = ""; }}
              style={{ display: "none" }}
            />
          </div>

          <div style={BF.footer}>
            <span style={BF.hint}>⌘↵ to send</span>
            <button
              style={{ ...BF.submitBtn, ...(submitting ? BF.submitBusy : null) }}
              onClick={handleSubmit}
              aria-disabled={submitting}
            >
              {submitting ? "Sending…" : "Send"}
            </button>
          </div>
        </div>,
        dockEl
      )}

      {dockEl && toast && !open && createPortal(
        <Toast key={toast.id} kind={toast.kind} onDone={() => setToast(null)} onOpen={onOpen} />,
        dockEl
      )}
    </>
  );
}

// The outcome of a send, shown where the panel just was. In the sidebar, so
// it covers nothing; announced through a live region, so it isn't only visual.
//
// Success waits 5s and pauses while the pointer is on it — the old 1.5s
// banner inside a closing sheet was the thing people missed. A failure never
// times out: an error that fades before it is read is the case NN/g warns
// about, and this one has an action.
function Toast({ kind, onDone, onOpen }) {
  const failed = kind === "failed";
  const [shown, setShown] = useState(false);
  const [hovered, setHovered] = useState(false);
  const leaving = useRef(null);
  const ref = useRef(null);
  const dismiss = useCallback(() => {
    setShown(false);
    clearTimeout(leaving.current);
    leaving.current = setTimeout(onDone, DOCK_ANIM_MS);
  }, [onDone]);
  // Same start-state trick as the panel above.
  useLayoutEffect(() => {
    ref.current?.getBoundingClientRect();
    setShown(true);
    return () => clearTimeout(leaving.current);
  }, []);
  useEffect(() => {
    if (failed || hovered) return;
    const t = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(t);
  }, [failed, hovered, dismiss]);
  return (
    <div
      ref={ref}
      data-feedback-toast={kind}
      role={failed ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...BF.toast,
        ...(failed ? BF.toastFailed : null),
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(8px)",
      }}
    >
      {failed ? (
        <span style={{ flex: 1 }}>
          Didn't send — your draft is saved.{" "}
          <button style={BF.toastAction} onClick={() => { dismiss(); onOpen?.(); }}>Open</button>
        </span>
      ) : (
        <>
          <CheckIcon />
          <span style={{ flex: 1 }}>Feedback sent</span>
        </>
      )}
      <button style={BF.toastClose} onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

const ICON = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { flex: "none" } };

const CardIcon = () => (
  <svg {...ICON}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>
);
const ImageIcon = () => (
  <svg {...ICON}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
);
const CheckIcon = () => (
  <svg {...ICON}><path d="M20 6 9 17l-5-5" /></svg>
);

const BF = {
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 0",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans,
    fontWeight: 500,
    textAlign: "left",
    opacity: 0.6,
  },
  draftDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: T.color.secondary,
    flex: "none",
  },

  // ── Panel ────────────────────────────────────────────────────────
  // A white card on the sidebar's tinted ground: a hairline border to give it
  // an edge, and a soft shadow to lift it off the sidebar rather than a heavy
  // one that would read as a modal. Its width comes from the dock's padding.
  panel: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    // Shrinks to the dock on a short window and scrolls inside, rather than
    // riding up over the nav.
    minHeight: 0,
    overflowY: "auto",
    background: T.color.surfaceLowest,
    border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.lg,
    boxShadow: "0 10px 28px rgba(3,22,50,0.10), 0 1px 3px rgba(3,22,50,0.06)",
    padding: "12px 12px 12px",
    boxSizing: "border-box",
    fontFamily: T.font.sans,
    transition: `opacity ${DOCK_ANIM_MS}ms ${PANEL_EASING}, transform ${DOCK_ANIM_MS}ms ${PANEL_EASING}`,
  },
  panelDrag: {
    boxShadow: `0 10px 28px rgba(3,22,50,0.10), inset 0 0 0 2px ${T.color.secondary}`,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: 15,
    color: T.color.primary,
    fontFamily: T.font.serif,
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: T.color.onSurfaceVariant,
    padding: "2px 6px",
    marginRight: -4,
    borderRadius: T.radius.md,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  textarea: {
    width: "100%",
    minHeight: 60,
    maxHeight: 132,
    padding: "8px 10px",
    fontSize: 13,
    border: "none",
    background: T.color.surfaceLow,
    borderRadius: T.radius.md,
    resize: "none",
    boxSizing: "border-box",
    fontFamily: T.font.sans,
    color: T.color.onSurface,
    lineHeight: 1.45,
    outline: "none",
    flexShrink: 0,
  },

  // ── Chips ────────────────────────────────────────────────────────
  chips: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0, flexWrap: "wrap" },
  chip: {
    display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", boxSizing: "border-box",
    borderWidth: 1, borderStyle: "solid", borderColor: "rgba(3,22,50,0.1)",
    background: "transparent", borderRadius: T.radius.full, padding: "4px 10px",
    fontSize: 11.5, fontWeight: 600, color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans, cursor: "pointer", whiteSpace: "nowrap",
  },
  chipOn: { background: T.color.primary, borderColor: T.color.primary, color: T.color.onPrimary },
  chipLabel: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  chipInner: {
    display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0,
    background: "transparent", border: "none", color: "inherit", font: "inherit",
    cursor: "pointer", padding: 0,
  },
  imgThumb: {
    width: 22,
    height: 16,
    objectFit: "cover",
    borderRadius: 3,
    flex: "none",
  },

  // ── Messages ─────────────────────────────────────────────────────
  error: {
    padding: "6px 9px",
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    borderRadius: T.radius.md,
    fontSize: 12,
    flexShrink: 0,
  },

  footer: { display: "flex", alignItems: "center", flexShrink: 0 },
  hint: { fontSize: 11, color: T.color.onSurfaceVariant, opacity: 0.7 },
  submitBtn: {
    marginLeft: "auto",
    padding: "7px 16px",
    background: T.gradient.ink,
    color: T.color.onPrimary,
    border: "none",
    borderRadius: T.radius.md,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: T.font.sans,
    boxShadow: T.shadow.button,
    letterSpacing: "0.01em",
  },
  submitBusy: { opacity: 0.7, cursor: "progress" },

  // ── Toast ────────────────────────────────────────────────────────
  toast: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 8px 9px 12px",
    background: T.color.primary,
    color: T.color.onPrimary,
    borderRadius: T.radius.lg,
    boxShadow: "0 10px 28px rgba(3,22,50,0.16)",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: T.font.sans,
    transition: `opacity ${DOCK_ANIM_MS}ms ${PANEL_EASING}, transform ${DOCK_ANIM_MS}ms ${PANEL_EASING}`,
  },
  toastFailed: {
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    fontSize: 12.5,
  },
  toastClose: {
    background: "transparent",
    border: "none",
    color: "inherit",
    opacity: 0.7,
    cursor: "pointer",
    fontSize: 17,
    lineHeight: 1,
    padding: "0 4px",
  },
  toastAction: {
    background: "transparent",
    border: "none",
    color: "inherit",
    font: "inherit",
    fontWeight: 700,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
};
