import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";

// "Send feedback" trigger + modal. Posts to beta_feedback table.
// Supports optional screenshot attachment (file picker, drag-drop, or
// paste from clipboard). The screenshot is stored as a base64 data URL
// in the `screenshot` column — add it to the beta_feedback table:
//   ALTER TABLE beta_feedback ADD COLUMN screenshot text;
//
// Usage:
//   <BetaFeedback user={user} currentPage={mode} />

export function BetaFeedback({ user, currentPage }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | sent | error
  const [error, setError] = useState("");
  const [screenshot, setScreenshot] = useState(null); // base64 data URL or null
  const [screenshotName, setScreenshotName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

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

  // Paste from clipboard — works when textarea is focused
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

  async function handleSubmit() {
    if (!message.trim() || message.trim().length < 5) {
      setError("Please write a few words about what you want us to know.");
      return;
    }
    setStatus("submitting");
    setError("");

    const row = {
      user_id: user?.id || null,
      user_email: user?.email || null,
      message: message.trim(),
      page: currentPage || null,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    };

    // Try with screenshot; fall back without if column doesn't exist yet
    if (screenshot) {
      const { error: err1 } = await supabase
        .from("beta_feedback")
        .insert({ ...row, screenshot });
      if (err1) {
        if (/screenshot|column/i.test(err1.message)) {
          const { error: err2 } = await supabase
            .from("beta_feedback")
            .insert(row);
          if (err2) {
            setError(err2.message || "Failed to submit");
            setStatus("error");
            return;
          }
        } else {
          setError(err1.message || "Failed to submit");
          setStatus("error");
          return;
        }
      }
    } else {
      const { error: err } = await supabase.from("beta_feedback").insert(row);
      if (err) {
        setError(err.message || "Failed to submit");
        setStatus("error");
        return;
      }
    }

    setStatus("sent");
    setMessage("");
    setScreenshot(null);
    setScreenshotName("");
    setTimeout(() => {
      setOpen(false);
      setStatus("idle");
    }, 1500);
  }

  return (
    <>
      <button style={BF.trigger} onClick={() => setOpen(true)}>
        Send feedback
      </button>

      {open && createPortal(
        <div
          style={BF.overlay}
          onClick={status === "submitting" ? null : () => setOpen(false)}
        >
          <div style={BF.modal} onClick={(e) => e.stopPropagation()}>
            <div style={BF.header}>
              <h2 style={BF.title}>Send feedback</h2>
              {status !== "submitting" && (
                <button
                  style={BF.closeBtn}
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              )}
            </div>

            <p style={BF.desc}>
              Bug, idea, or wrong translation — we want to hear it.
            </p>

            <textarea
              style={BF.textarea}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onPaste={handlePaste}
              placeholder="What's on your mind?"
              disabled={status === "submitting" || status === "sent"}
              autoFocus
            />

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
                style={isDragging ? {...BF.dropZone, ...BF.dropZoneActive} : BF.dropZone}
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
                <div style={BF.dropZoneIcon}>📎</div>
                <div style={BF.dropZoneText}>
                  {isDragging ? "Drop your image here" : "Drop a screenshot here"}
                </div>
                <div style={BF.dropZoneSub}>or click to browse · paste from clipboard</div>
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

            <div style={BF.footer}>
              <button
                style={BF.cancelBtn}
                onClick={() => setOpen(false)}
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
        </div>,
        document.body
      )}
    </>
  );
}

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
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(3, 22, 50, 0.4)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16,
  },
  modal: {
    background: T.color.surfaceLowest,
    borderRadius: T.radius.xl,
    maxWidth: 520,
    width: "100%",
    padding: "36px 40px",
    boxShadow: "0 32px 96px rgba(3,22,50,0.18)",
    fontFamily: T.font.sans,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: {
    margin: 0,
    fontSize: 28,
    color: T.color.primary,
    fontFamily: T.font.serif,
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 28,
    cursor: "pointer",
    color: T.color.onSurfaceVariant,
    padding: "0 8px",
    lineHeight: 1,
  },
  desc: {
    fontSize: 14,
    color: T.color.onSurfaceVariant,
    margin: "0 0 18px",
    lineHeight: 1.5,
  },
  textarea: {
    width: "100%",
    minHeight: 120,
    padding: 14,
    fontSize: 14,
    border: "none",
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    resize: "vertical",
    boxSizing: "border-box",
    marginBottom: 12,
    fontFamily: T.font.sans,
    color: T.color.onSurface,
    lineHeight: 1.5,
  },
  // Screenshot dropzone
  dropZone: {
    border: "2px dashed rgba(3,22,50,0.12)",
    borderRadius: T.radius.lg,
    background: T.color.surfaceLow,
    padding: "28px 20px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all 0.2s ease",
    marginBottom: 12,
    fontFamily: T.font.sans,
  },
  dropZoneActive: {
    borderColor: T.color.secondary,
    background: T.color.tertiaryFixed,
    transform: "scale(1.01)",
  },
  dropZoneIcon: {
    fontSize: 24,
    marginBottom: 8,
    opacity: 0.5,
  },
  dropZoneText: {
    fontSize: 13,
    fontWeight: 600,
    color: T.color.primary,
    marginBottom: 4,
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
    marginBottom: 12,
  },
  imgThumb: {
    width: 64,
    height: 48,
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
  error: {
    padding: 12,
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    borderRadius: T.radius.lg,
    fontSize: 13,
    marginBottom: 12,
  },
  success: {
    padding: 12,
    background: T.color.tertiaryFixed,
    color: T.color.onSecondaryContainer,
    borderRadius: T.radius.lg,
    fontSize: 13,
    marginBottom: 12,
    fontWeight: 500,
  },
  footer: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
  },
  cancelBtn: {
    padding: "10px 20px",
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
    padding: "11px 24px",
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
};
