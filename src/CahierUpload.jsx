// === src/CahierUpload.jsx START ===
import { useState, useRef } from "react";
import { supabase } from "./supabase";

// Modal for uploading a cahier. Three input modes:
//   - paste: user pastes raw text into a textarea
//   - file:  user uploads a .txt file
//   - link:  user pastes a Google Doc URL (must be "anyone with link can view")
//
// On submit, sends to /api/parse-cahier with the user's auth token.
//
// Props:
//   open          — boolean, whether the modal is shown
//   onClose       — called when user closes without uploading
//   onSuccess     — called with the server response on successful upload
//   hasExisting   — if true, shows a "replace existing deck" checkbox

export function CahierUpload({ open, onClose, onSuccess, hasExisting }) {
  const [tab, setTab] = useState("paste"); // paste | file | link
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [replace, setReplace] = useState(hasExisting ? false : true);
  const [status, setStatus] = useState("idle"); // idle | uploading | error
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef(null);

  if (!open) return null;

  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setError(
        "For now, only .txt files are supported. Copy your Google Doc to plain text and try again, or paste the text directly."
      );
      return;
    }
    const content = await file.text();
    setText(content);
    setTab("paste");
    setError("");
  }

  async function handleSubmit() {
    setError("");
    let mode, content;

    if (tab === "paste" || tab === "file") {
      if (!text.trim() || text.trim().length < 50) {
        setError("Please paste your cahier text (at least 50 characters).");
        return;
      }
      mode = "text";
      content = text;
    } else if (tab === "link") {
      if (!url.trim().includes("docs.google.com/document/")) {
        setError(
          "Please paste a Google Doc URL like https://docs.google.com/document/d/..."
        );
        return;
      }
      mode = "url";
      content = url.trim();
    }

    setStatus("uploading");
    setProgress("Parsing your cahier… this can take 30–90 seconds for a full year of lessons.");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not signed in");
      }

      const res = await fetch("/api/parse-cahier", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ mode, content, replace }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setStatus("idle");
      onSuccess(data);
    } catch (e) {
      setStatus("error");
      setError(e.message || "Upload failed");
    }
  }

  return (
    <div style={M.overlay} onClick={status === "uploading" ? null : onClose}>
      <div style={M.modal} onClick={(e) => e.stopPropagation()}>
        <div style={M.header}>
          <h2 style={M.title}>Upload your cahier</h2>
          {status !== "uploading" && (
            <button style={M.closeBtn} onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>

        <p style={M.desc}>
          Upload the French lesson notes your teacher keeps for you. We'll extract
          every word, expression, grammar rule, and pronunciation note, and build
          your personal flashcard deck.
        </p>

        <div style={M.tabs}>
          {[
            ["paste", "Paste text"],
            ["file", "Upload file"],
            ["link", "Google Doc link"],
          ].map(([k, label]) => (
            <button
              key={k}
              style={tab === k ? { ...M.tab, ...M.tabActive } : M.tab}
              onClick={() => {
                setTab(k);
                setError("");
              }}
              disabled={status === "uploading"}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={M.tabBody}>
          {tab === "paste" && (
            <>
              <label style={M.label}>Paste your cahier contents below:</label>
              <textarea
                style={M.textarea}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Le 10 avril 2026
Vocabulaire Expressions
un poste
fonder / créer une entreprise
...`}
                disabled={status === "uploading"}
              />
              <div style={M.hint}>
                {text.length.toLocaleString()} characters
              </div>
            </>
          )}

          {tab === "file" && (
            <>
              <label style={M.label}>
                Upload a .txt file of your cahier:
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,text/plain"
                onChange={handleFileUpload}
                disabled={status === "uploading"}
                style={M.fileInput}
              />
              <div style={M.hint}>
                Only .txt files are supported for now. If your cahier is in
                Google Docs, use the "Google Doc link" tab or copy-paste the
                text.
              </div>
              {text && (
                <div style={M.filePreview}>
                  Loaded {text.length.toLocaleString()} characters from file.
                  Click Upload below to process.
                </div>
              )}
            </>
          )}

          {tab === "link" && (
            <>
              <label style={M.label}>Google Doc URL:</label>
              <input
                type="url"
                style={M.input}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/document/d/..."
                disabled={status === "uploading"}
              />
              <div style={M.hint}>
                Your doc must be shared as "Anyone with the link can view". In
                Google Docs: File → Share → General access → Anyone with the
                link → Viewer.
              </div>
            </>
          )}
        </div>

        {hasExisting && (
          <label style={M.checkbox}>
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              disabled={status === "uploading"}
            />
            <span>Replace my existing deck (otherwise merge into it)</span>
          </label>
        )}

        {error && <div style={M.error}>{error}</div>}
        {progress && status === "uploading" && (
          <div style={M.progress}>{progress}</div>
        )}

        <div style={M.footer}>
          <button
            style={M.cancelBtn}
            onClick={onClose}
            disabled={status === "uploading"}
          >
            Cancel
          </button>
          <button
            style={M.submitBtn}
            onClick={handleSubmit}
            disabled={status === "uploading"}
          >
            {status === "uploading" ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}

const M = {
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
    maxWidth: 600,
    width: "100%",
    maxHeight: "90vh",
    overflowY: "auto",
    padding: 24,
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: { margin: 0, fontSize: 22, color: "#1d3557" },
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
  tabs: {
    display: "flex",
    gap: 4,
    borderBottom: "1px solid #e0e0e0",
    marginBottom: 16,
  },
  tab: {
    padding: "8px 16px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    fontSize: 14,
    color: "#666",
  },
  tabActive: {
    color: "#1d3557",
    borderBottomColor: "#1d3557",
    fontWeight: 600,
  },
  tabBody: { marginBottom: 16 },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "#444",
    marginBottom: 8,
  },
  textarea: {
    width: "100%",
    minHeight: 200,
    padding: 12,
    fontSize: 13,
    fontFamily: "monospace",
    border: "1px solid #ccc",
    borderRadius: 6,
    resize: "vertical",
    boxSizing: "border-box",
  },
  input: {
    width: "100%",
    padding: 10,
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 6,
    boxSizing: "border-box",
  },
  fileInput: { fontSize: 14, marginBottom: 8 },
  filePreview: {
    padding: 8,
    background: "#e8f4f8",
    borderRadius: 4,
    fontSize: 13,
    color: "#1d3557",
    marginTop: 8,
  },
  hint: { fontSize: 12, color: "#888", marginTop: 6 },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#444",
    marginBottom: 12,
    cursor: "pointer",
  },
  error: {
    padding: 10,
    background: "#fde8e8",
    color: "#c44536",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 12,
  },
  progress: {
    padding: 10,
    background: "#e8f4f8",
    color: "#1d3557",
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
// === src/CahierUpload.jsx END ===
