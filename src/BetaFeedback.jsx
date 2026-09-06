import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";

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
  useEffect(() => {
    const el = panelRef.current;
    if (!open || !el) {
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
  }, [open, minimized, onHeightChange]);

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

      {open && createPortal(
        minimized ? (
          // ── Minimized bar ─────────────────────────────────────────
          <div style={{...BF.minimizedBar, left: offsetLeft}} ref={panelRef}>
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
          <div style={{...BF.sheet, left: offsetLeft}} ref={panelRef}>
            <div style={BF.header}>
              <h2 style={BF.title}>Send feedback</h2>
              <div style={BF.headerBtns}>
                {status !== "submitting" && (
                  <>
                    <button
                      style={BF.iconBtn}
                      onClick={() => setMinimized(true)}
                      aria-label="Minimize"
                      title="Minimize"
                    >
                      <span style={{ fontSize: 18, lineHeight: 1 }}>▼</span>
                    </button>
                    <button
                      style={BF.iconBtn}
                      onClick={handleCloseClick}
                      aria-label="Close"
                      title="Close"
                    >
                      <span style={{ fontSize: 22, lineHeight: 1 }}>×</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            <p style={BF.desc}>
              Bug, idea, or wrong translation — we want to hear it.
            </p>

            <div style={BF.body}>
              <textarea
                style={BF.textarea}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onPaste={handlePaste}
                placeholder="What's on your mind?"
                disabled={status === "submitting" || status === "sent"}
                autoFocus
              />

              {currentCard && (
                <label style={BF.attachRow}>
                  <input
                    type="checkbox"
                    checked={attachCard}
                    onChange={(e) => {
                      userTouchedAttach.current = true;
                      setAttachCard(e.target.checked);
                    }}
                    style={BF.attachCheckbox}
                  />
                  <div style={BF.attachText}>
                    <div style={BF.attachLabel}>Attach current card</div>
                    <div style={BF.attachPreview}>
                      <span style={BF.attachPreviewFront}>{currentCard.f}</span>
                      <span style={BF.attachPreviewSep}>·</span>
                      <span style={BF.attachPreviewBack}>{currentCard.b}</span>
                    </div>
                  </div>
                </label>
              )}

              {screenshot ? (
                <div style={BF.imgPreview}>
                  <img src={screenshot} alt="Attached" style={BF.imgThumb} />
                  <div style={BF.imgInfo}>
                    <span style={BF.imgName}>{screenshotName}</span>
                    <button
                      style={BF.imgRemove}
                      onClick={() => { setScreenshot(null); setScreenshotName(""); }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  style={isDragging ? { ...BF.dropZone, ...BF.dropZoneActive } : BF.dropZone}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragging(false);
                    handleImage(e.dataTransfer?.files?.[0]);
                  }}
                >
                  <div style={BF.dropZoneText}>
                    {isDragging ? "Drop your image here" : "📎 Drop a screenshot or click to browse"}
                  </div>
                  <div style={BF.dropZoneSub}>or paste from clipboard</div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleImage(e.target.files?.[0])}
                    style={{ display: "none" }}
                  />
                </div>
              )}

              {error && <div style={BF.error}>{error}</div>}
              {status === "sent" && (
                <div style={BF.success}>Thanks! Feedback received.</div>
              )}
            </div>

            <div style={BF.footer}>
              <button
                style={BF.cancelBtn}
                onClick={handleCloseClick}
                disabled={status === "submitting"}
              >
                Cancel
              </button>
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
    // Also capped against the viewport: a flat 340 is nearly half the page on
    // a laptop at zoom, and the study card pays for every pixel of it.
    maxHeight: "min(340px, 40vh)",
    overflowY: "auto",
    background: T.color.surfaceLowest,
    borderRadius: `${T.radius.xl}px ${T.radius.xl}px 0 0`,
    boxShadow: "0 -12px 48px rgba(3,22,50,0.18), 0 -1px 0 rgba(3,22,50,0.06)",
    padding: "20px 28px 16px",
    fontFamily: T.font.sans,
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    // subtle slide-up animation
    animation: "bf-slideup 180ms ease-out",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: 22,
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
  desc: {
    fontSize: 13,
    color: T.color.onSurfaceVariant,
    margin: "0 0 12px",
    lineHeight: 1.4,
    flexShrink: 0,
  },
  body: {
    overflowY: "auto",
    flex: 1,
    minHeight: 0,
    paddingRight: 4,
  },
  textarea: {
    width: "100%",
    minHeight: 90,
    padding: 12,
    fontSize: 14,
    border: "none",
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    resize: "vertical",
    boxSizing: "border-box",
    marginBottom: 10,
    fontFamily: T.font.sans,
    color: T.color.onSurface,
    lineHeight: 1.5,
    outline: "none",
  },

  // ── Attach card toggle ───────────────────────────────────────────
  attachRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    marginBottom: 10,
    cursor: "pointer",
  },
  attachCheckbox: {
    marginTop: 3,
    accentColor: T.color.primary,
    cursor: "pointer",
  },
  attachText: {
    flex: 1,
    minWidth: 0,
  },
  attachLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: T.color.primary,
    marginBottom: 2,
    fontFamily: T.font.sans,
  },
  attachPreview: {
    fontSize: 12,
    color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans,
    display: "flex",
    gap: 6,
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  attachPreviewFront: {
    fontWeight: 500,
    color: T.color.onSurface,
  },
  attachPreviewSep: {
    opacity: 0.4,
  },
  attachPreviewBack: {
    opacity: 0.8,
  },

  // ── Screenshot dropzone ──────────────────────────────────────────
  dropZone: {
    border: "2px dashed rgba(3,22,50,0.12)",
    borderRadius: T.radius.lg,
    background: T.color.surfaceLow,
    padding: "14px 12px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all 0.2s ease",
    marginBottom: 10,
    fontFamily: T.font.sans,
  },
  dropZoneActive: {
    borderColor: T.color.secondary,
    background: T.color.tertiaryFixed,
  },
  dropZoneText: {
    fontSize: 12,
    fontWeight: 600,
    color: T.color.primary,
    marginBottom: 2,
  },
  dropZoneSub: {
    fontSize: 11,
    color: T.color.onSurfaceVariant,
    opacity: 0.6,
  },
  imgPreview: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: 10,
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    marginBottom: 10,
  },
  imgThumb: {
    width: 56,
    height: 42,
    objectFit: "cover",
    borderRadius: T.radius.md,
  },
  imgInfo: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  imgName: {
    flex: 1,
    fontSize: 12,
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
    padding: 10,
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    borderRadius: T.radius.lg,
    fontSize: 13,
    marginBottom: 10,
  },
  success: {
    padding: 10,
    background: T.color.tertiaryFixed,
    color: T.color.onSecondaryContainer,
    borderRadius: T.radius.lg,
    fontSize: 13,
    marginBottom: 10,
    fontWeight: 500,
  },

  // ── Footer ───────────────────────────────────────────────────────
  footer: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    paddingTop: 10,
    flexShrink: 0,
    borderTop: `1px solid rgba(3,22,50,0.06)`,
    marginTop: 4,
  },
  cancelBtn: {
    padding: "9px 18px",
    background: "transparent",
    border: "none",
    borderRadius: T.radius.md,
    cursor: "pointer",
    fontSize: 14,
    color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans,
    fontWeight: 500,
  },
  submitBtn: {
    padding: "10px 22px",
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

// Inject slide-up keyframes once (idempotent)
if (typeof document !== "undefined" && !document.getElementById("bf-keyframes")) {
  const style = document.createElement("style");
  style.id = "bf-keyframes";
  style.textContent = `@keyframes bf-slideup { from { transform: translateY(100%); } to { transform: translateY(0); } }`;
  document.head.appendChild(style);
}
