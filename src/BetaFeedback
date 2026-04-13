// === src/BetaFeedback.jsx START ===
import { useState } from "react";
import { supabase } from "./supabase";

// Floating "Send feedback" button + modal. Posts to beta_feedback table.
//
// Usage:
//   <BetaFeedback user={user} currentPage={mode} />
//
// The button sits in the page (not a floating fixed-position thing) so it
// doesn't interfere with the main card UI on mobile.

export function BetaFeedback({ user, currentPage }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | sent | error
  const [error, setError] = useState("");

  async function handleSubmit() {
    if (!message.trim() || message.trim().length < 5) {
      setError("Please write a few words about what you want us to know.");
      return;
    }
    setStatus("submitting");
    setError("");

    const { error: insertErr } = await supabase.from("beta_feedback").insert({
      user_id: user?.id || null,
      user_email: user?.email || null,
      message: message.trim(),
      page: currentPage || null,
      user_agent:
        typeof navigator !== "undefined" ? navigator.userAgent : null,
    });

    if (insertErr) {
      console.error("Feedback submit failed:", insertErr);
      setError(insertErr.message || "Failed to submit");
      setStatus("error");
      return;
    }

    setStatus("sent");
    setMessage("");
    setTimeout(() => {
      setOpen(false);
      setStatus("idle");
    }, 1500);
  }

  return (
    <>
      <button style={BF.trigger} onClick={() => setOpen(true)} title="Send beta feedback">
        💬 Feedback
      </button>

      {open && (
        <div
          style={BF.overlay}
          onClick={status === "submitting" ? null : () => setOpen(false)}
        >
          <div style={BF.modal} onClick={(e) => e.stopPropagation()}>
            <div style={BF.header}>
              <h2 style={BF.title}>Send beta feedback</h2>
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
              Hit a bug? Have an idea? Translation looks wrong?{" "}
              Tell us what's going on.
            </p>

            <textarea
              style={BF.textarea}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What's on your mind?"
              disabled={status === "submitting" || status === "sent"}
              autoFocus
            />

            {error && <div style={BF.error}>{error}</div>}
            {status === "sent" && (
              <div style={BF.success}>✓ Thanks! Feedback received.</div>
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
        </div>
      )}
    </>
  );
}

const BF = {
  trigger: {
    padding: "6px 12px",
    background: "#f0f0f0",
    border: "1px solid #ddd",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
    color: "#444",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16,
  },
  modal: {
    background: "#fff",
    borderRadius: 12,
    maxWidth: 480,
    width: "100%",
    padding: 24,
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: { margin: 0, fontSize: 20, color: "#1d3557" },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 28,
    cursor: "pointer",
    color: "#888",
    padding: "0 8px",
    lineHeight: 1,
  },
  desc: { fontSize: 14, color: "#666", margin: "0 0 16px" },
  textarea: {
    width: "100%",
    minHeight: 120,
    padding: 12,
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 6,
    resize: "vertical",
    boxSizing: "border-box",
    marginBottom: 12,
    fontFamily: "inherit",
  },
  error: {
    padding: 10,
    background: "#fde8e8",
    color: "#c44536",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 12,
  },
  success: {
    padding: 10,
    background: "#d4edda",
    color: "#2d6a4f",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 12,
  },
  footer: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
  },
  cancelBtn: {
    padding: "10px 20px",
    background: "#f0f0f0",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 14,
    color: "#444",
  },
  submitBtn: {
    padding: "10px 24px",
    background: "#1d3557",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
};
// === src/BetaFeedback.jsx END ===
