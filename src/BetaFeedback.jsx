import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";
import { cleanFrenchPrompt } from "./lib/cardText";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";

// "Send feedback" trigger + bottom sheet. Posts to beta_feedback table.
//
// Design notes:
//   • Renders as a bottom sheet (not a centered modal) so the card
//     behind stays visible. No backdrop — clicks pass through to the
//     app so you can flip, navigate, or screenshot while composing.
//   • Minimize button collapses the sheet to a thin bar at the bottom
//     while preserving all form state (message, screenshot, toggles).
//   • "Attach current card" toggle captures a structured snapshot of
//     the card into beta_feedback.card_context (jsonb). Admin view
//     renders this as a card preview — no screenshots needed for
//     card-specific feedback.
//
// Requires migration_003_feedback_card_context.sql to add the
// card_context column. Screenshot upload still works as before
// (requires the `screenshot` column from the earlier migration).
//
// Usage:
//   <BetaFeedback user={user} currentPage={mode} currentCard={card} />

export function BetaFeedback({
  user,
  currentPage,
  currentCard,
  // Controlled by FlashcardApp so this and the tutor panel can never be open
  // together, and so the page can make room for whichever is up.
  open,
  onOpen,
  onClose,
  onHeightChange,
  // Left edge of the content column. The sheet centres itself over the page's
  // main area rather than the whole window, so it doesn't straddle the nav.
  offsetLeft = 0,
  // FlashcardApp puts a close-request function here so it can ask the sheet to
  // close (and honour the discard prompt) before opening the tutor.
  requestCloseRef,
}) {
  const [minimized, setMinimized] = useState(false);
  const panelRef = useRef(null);

  // `mounted` keeps the sheet in the DOM until the exit slide finishes;
  // `entered` drives the transform. Without this the sheet vanished in one
  // frame while the page took 420ms to close the gap behind it — the single
  // worst jerk of the lot. Same pattern the tutor panel uses.
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    setEntered(false);
    const t = setTimeout(() => setMounted(false), PANEL_ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);
  // Two frames: one to paint the sheet off-screen, one to move it. Keying off
  // `open` alone would set the end state before the start state ever painted,
  // and the slide would never run.
  useEffect(() => {
    if (!mounted || !open) return;
    const a = requestAnimationFrame(() => {
      const b = requestAnimationFrame(() => setEntered(true));
      cleanup.current = () => cancelAnimationFrame(b);
    });
    return () => { cancelAnimationFrame(a); cleanup.current?.(); };
  }, [mounted, open]);
  const cleanup = useRef(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | sent | error
  const [error, setError] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotName, setScreenshotName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  // Attach-card toggle: default ON when a card is provided, OFF otherwise.
  // We reconcile whenever a card appears/disappears so navigating during
  // composition doesn't silently flip your choice.
  const [attachCard, setAttachCard] = useState(!!currentCard);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  // One line at rest, growing with the content up to five. A fixed 90px box
  // was most of the panel's height and almost always mostly empty.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }, [message, open, minimized]);

  // If the user navigates to a page with no card (stats, etc.) while the
  // sheet is open, turn attachment off. When a card reappears, default
  // back to on — but only if the user hasn't explicitly unchecked it.
  const userTouchedAttach = useRef(false);
  useEffect(() => {
    if (!userTouchedAttach.current) setAttachCard(!!currentCard);
  }, [currentCard]);

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

  // Bound to the sheet, so a paste lands wherever the cursor happens to be.
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

  const resetAndClose = useCallback(() => {
    onClose?.();
    setMinimized(false);
    setMessage("");
    setScreenshot(null);
    setScreenshotName("");
    setStatus("idle");
    setError("");
    userTouchedAttach.current = false;
  }, [onClose]);

  // Measure rather than assume: the sheet grows with a screenshot attached and
  // shrinks to a bar when minimized, and the page has to match whichever it is.
  //
  // useLayoutEffect, not useEffect: the height has to reach the page in the
  // same commit the sheet mounts in, so the page's padding transition and the
  // sheet's slide start on the same frame. Reporting it after paint let the
  // sheet get a head start and opened a visible gap behind it.
  useLayoutEffect(() => {
    const el = panelRef.current;
    // The page makes room exactly while the sheet is in its entered position —
    // both driven by `entered`, so both state changes land in one React commit
    // and the two transitions start on the same frame. Reporting at mount
    // instead let the page set off two frames before the sheet did.
    if (!open || !entered || !el) {
      onHeightChange?.(0);
      return;
    }
    const report = () => onHeightChange?.(Math.round(el.getBoundingClientRect().height));
    report();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(report) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      onHeightChange?.(0);
    };
  }, [open, entered, minimized, onHeightChange]);

  // Click anywhere outside to close. Routed through handleCloseClick so an
  // unsent draft still asks before it is thrown away.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (e.target.closest?.("[data-feedback-toggle]")) return;
      if (e.target.closest?.("[data-tutor-toggle]")) return;
      handleCloseClick();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  // Returns true if the sheet closed, false if the user backed out of
  // discarding a draft — callers use that to decide whether to continue.
  const handleCloseClick = () => {
    if (status === "submitting") return false;
    const hasDraft = message.trim().length > 0 || screenshot;
    if (hasDraft && !window.confirm("Discard your feedback?")) return false;
    resetAndClose();
    return true;
  };

  // Publish the close request upward. Kept current on every render so it
  // always sees the live draft state.
  if (requestCloseRef) {
    requestCloseRef.current = () => (open ? handleCloseClick() : true);
  }

  async function handleSubmit() {
    if (!message.trim() || message.trim().length < 5) {
      setError("Please write a few words about what you want us to know.");
      return;
    }
    setStatus("submitting");
    setError("");

    const base = {
      user_id: user?.id || null,
      user_email: user?.email || null,
      message: message.trim(),
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
    let { error: err } = await supabase.from("beta_feedback").insert(full);

    if (err && /card_context|screenshot|column/i.test(err.message)) {
      // Retry without optional columns
      const fallback = { ...base };
      if (screenshot && !/card_context/i.test(err.message)) {
        fallback.screenshot = screenshot;
      }
      const retry = await supabase.from("beta_feedback").insert(fallback);
      err = retry.error;
    }

    if (err) {
      setError(err.message || "Failed to submit");
      setStatus("error");
      return;
    }

    setStatus("sent");
    setTimeout(() => { resetAndClose(); }, 1500);
  }

  const draftSummary = message.trim()
    ? (message.trim().length > 40 ? message.trim().slice(0, 40) + "…" : message.trim())
    : "Feedback draft";

  return (
    <>
      <button
        data-feedback-toggle
        style={BF.trigger}
        onClick={() => { setMinimized(false); onOpen?.(); }}
      >
        Send feedback
      </button>

      {mounted && createPortal(
        minimized ? (
          // ── Minimized bar ─────────────────────────────────────────
          <div style={{...BF.minimizedBar, left: offsetLeft, transform: entered ? "translateY(0)" : "translateY(100%)"}} ref={panelRef} data-feedback-sheet>
            <button
              style={BF.minBarMain}
              onClick={() => setMinimized(false)}
              aria-label="Expand feedback"
            >
              <span style={BF.minBarIcon}>▲</span>
              <span style={BF.minBarLabel}>{draftSummary}</span>
            </button>
            <button
              style={BF.minBarClose}
              onClick={handleCloseClick}
              aria-label="Close feedback"
            >
              ×
            </button>
          </div>
        ) : (
          // ── Expanded bottom sheet ─────────────────────────────────
          // The WHOLE sheet is the drop target and the paste target. It used
          // to carry a full-width dashed dropzone plus a full-width attach row
          // plus a subtitle plus a footer, which is most of why it was 300px
          // tall for what is really one text field.
          <div
            style={{
              ...BF.sheet,
              ...(isDragging ? BF.sheetDrag : null),
              left: offsetLeft,
              transform: entered ? "translateY(0)" : "translateY(100%)",
            }}
            ref={panelRef}
            data-feedback-sheet
            onPaste={handlePaste}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => {
              // Only when the pointer actually leaves the sheet, not on every
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
              <div style={BF.headerBtns}>
                {status !== "submitting" && (
                  <>
                    <button style={BF.iconBtn} onClick={() => setMinimized(true)} aria-label="Minimize" title="Minimize">
                      <span style={{ fontSize: 15, lineHeight: 1 }}>▼</span>
                    </button>
                    <button style={BF.iconBtn} onClick={handleCloseClick} aria-label="Close" title="Close">
                      <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            <textarea
              ref={textareaRef}
              style={BF.textarea}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={isDragging ? "Drop the image anywhere here" : "What's on your mind?"}
              disabled={status === "submitting" || status === "sent"}
              rows={1}
              autoFocus
            />

            {screenshot && (
              <div style={BF.imgPreview}>
                <img src={screenshot} alt="Attached" style={BF.imgThumb} />
                <span style={BF.imgName}>{screenshotName}</span>
                <button style={BF.imgRemove} onClick={() => { setScreenshot(null); setScreenshotName(""); }} aria-label="Remove image">
                  ✕
                </button>
              </div>
            )}

            {error && <div style={BF.error}>{error}</div>}
            {status === "sent" && <div style={BF.success}>Thanks! Feedback received.</div>}

            <div style={BF.actions}>
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
                  <span style={BF.chipLabel}>{cleanFrenchPrompt(currentCard.f, currentCard.b)}</span>
                </button>
              )}
              <button
                type="button"
                style={screenshot ? { ...BF.chip, ...BF.chipOn } : BF.chip}
                onClick={() => fileInputRef.current?.click()}
                title="Attach a screenshot — or just drop one on this panel, or paste it"
              >
                <ImageIcon />
                Screenshot
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleImage(e.target.files?.[0])}
                style={{ display: "none" }}
              />
              <button
                style={BF.submitBtn}
                onClick={handleSubmit}
                disabled={status === "submitting" || status === "sent"}
              >
                {status === "submitting" ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        ),
        document.body
      )}
    </>
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

// Breakpoint for narrow screens (matches sidebar-bottom behavior in app)
const NARROW = "@media (max-width: 720px)";

const BF = {
  trigger: {
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

  // ── Expanded bottom sheet ────────────────────────────────────────
  sheet: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    margin: "0 auto",
    maxWidth: 920,
    width: "100%",
    // No fixed height any more — the sheet is as tall as its content, which is
    // a title row, one growing field and a row of chips. The cap is a backstop
    // for a long error plus a screenshot preview, not the usual case.
    maxHeight: "min(300px, 38vh)",
    overflowY: "auto",
    background: T.color.surfaceLowest,
    borderRadius: `${T.radius.xl}px ${T.radius.xl}px 0 0`,
    boxShadow: "0 -12px 48px rgba(3,22,50,0.18), 0 -1px 0 rgba(3,22,50,0.06)",
    padding: "12px 18px 12px",
    gap: 9,
    fontFamily: T.font.sans,
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    transition: `transform ${PANEL_ANIM_MS}ms ${PANEL_EASING}`,
    willChange: "transform",
  },
  sheetDrag: {
    boxShadow: `0 -12px 48px rgba(3,22,50,0.18), inset 0 0 0 2px ${T.color.secondary}`,
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
  headerBtns: {
    display: "flex",
    gap: 4,
  },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: T.color.onSurfaceVariant,
    padding: "4px 10px",
    borderRadius: T.radius.md,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  textarea: {
    width: "100%",
    minHeight: 38,
    maxHeight: 110,
    padding: "9px 12px",
    fontSize: 13.5,
    border: "none",
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    resize: "none",
    boxSizing: "border-box",
    fontFamily: T.font.sans,
    color: T.color.onSurface,
    lineHeight: 1.5,
    outline: "none",
  },

  // ── Attach card toggle ───────────────────────────────────────────

  // ── Screenshot dropzone ──────────────────────────────────────────
  actions: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" },
  chip: {
    display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 260,
    borderWidth: 1, borderStyle: "solid", borderColor: "rgba(3,22,50,0.1)",
    background: "transparent", borderRadius: T.radius.full, padding: "5px 11px",
    fontSize: 11.5, fontWeight: 600, color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans, cursor: "pointer", whiteSpace: "nowrap",
  },
  chipOn: { background: T.color.primary, borderColor: T.color.primary, color: T.color.onPrimary },
  chipLabel: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 170 },
  imgPreview: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: 8,
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    marginBottom: 10,
  },
  imgThumb: {
    width: 44,
    height: 33,
    objectFit: "cover",
    borderRadius: T.radius.md,
  },
  imgName: {
    flex: 1,
    fontSize: 11.5,
    color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  imgRemove: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    color: T.color.onSurfaceVariant,
    padding: "4px 8px",
    fontWeight: 600,
  },

  // ── Messages ─────────────────────────────────────────────────────
  error: {
    padding: "8px 10px",
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    borderRadius: T.radius.lg,
    fontSize: 12.5,
    flexShrink: 0,
  },
  success: {
    padding: "8px 10px",
    background: T.color.tertiaryFixed,
    color: T.color.onSecondaryContainer,
    borderRadius: T.radius.lg,
    fontSize: 12.5,
    fontWeight: 500,
    flexShrink: 0,
  },

  // ── Footer ───────────────────────────────────────────────────────
  submitBtn: {
    marginLeft: "auto",
    padding: "8px 18px",
    background: T.gradient.ink,
    color: T.color.onPrimary,
    border: "none",
    borderRadius: T.radius.md,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: T.font.sans,
    boxShadow: T.shadow.button,
    letterSpacing: "0.01em",
  },

  // ── Minimized bar ───────────────────────────────────────────────
  minimizedBar: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    margin: "0 auto",
    maxWidth: 920,
    width: "100%",
    background: T.color.surfaceLowest,
    borderRadius: `${T.radius.lg}px ${T.radius.lg}px 0 0`,
    boxShadow: "0 -6px 24px rgba(3,22,50,0.12), 0 -1px 0 rgba(3,22,50,0.06)",
    display: "flex",
    alignItems: "center",
    fontFamily: T.font.sans,
    zIndex: 1000,
    height: 44,
    boxSizing: "border-box",
    transition: `transform ${PANEL_ANIM_MS}ms ${PANEL_EASING}`,
    willChange: "transform",
  },
  minBarMain: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 16px",
    height: "100%",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    overflow: "hidden",
  },
  minBarIcon: {
    fontSize: 10,
    color: T.color.onSurfaceVariant,
    flexShrink: 0,
  },
  minBarLabel: {
    fontSize: 13,
    color: T.color.primary,
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  minBarClose: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: T.color.onSurfaceVariant,
    padding: "0 16px",
    height: "100%",
    fontSize: 20,
    lineHeight: 1,
  },
};
