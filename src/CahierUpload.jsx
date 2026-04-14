import { useState, useRef } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";

// Modal for uploading a cahier. Three input modes:
//   - paste: user pastes raw text into a textarea
//   - file:  user uploads a .txt file (PDF/DOCX client-side parsing deferred
//            to a follow-up; for now we accept .txt only)
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
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [replace, setReplace] = useState(hasExisting ? false : true);
  const [status, setStatus] = useState("idle"); // idle | uploading | error
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef(null);

  if (!open) return null;

  async function processFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setError(
        "Only .txt files are supported. Copy your Google Doc to plain text and try again, or paste the text directly."
      );
      return;
    }
    const content = await file.text();
    setText(content);
    setFileName(file.name);
    setError("");
  }

  async function handleFileUpload(e) {
    await processFile(e.target.files?.[0]);
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    await processFile(file);
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
              <label style={M.label}>Upload your cahier</label>
              <div
                style={isDragging ? { ...M.dropZone, ...M.dropZoneActive } : M.dropZone}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div style={M.dropZoneIcon}>📄</div>
                {fileName ? (
                  <>
                    <div style={M.dropZoneTextStrong}>{fileName}</div>
                    <div style={M.dropZoneTextSub}>
                      {text.length.toLocaleString()} characters loaded · click to choose a different file
                    </div>
                  </>
                ) : (
                  <>
                    <div style={M.dropZoneTextStrong}>
                      {isDragging ? "Drop your file here" : "Drop a .txt file here"}
                    </div>
                    <div style={M.dropZoneTextSub}>or click to browse</div>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  onChange={handleFileUpload}
                  disabled={status === "uploading"}
                  style={{ display: "none" }}
                />
              </div>
              <div style={M.hint}>
                Only .txt files are supported. If your cahier is in Google Docs,
                use the "Google Doc link" tab or copy-paste the text.
              </div>
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
    maxWidth: 600,
    width: "100%",
    maxHeight: "90vh",
    overflowY: "auto",
    padding: 32,
    boxShadow: T.shadow.modal,
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
    fontSize: 26,
    color: T.color.primary,
    fontFamily: T.font.serif,
    fontWeight: 600,
    letterSpacing: "-0.015em",
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
    margin: "0 0 20px",
    lineHeight: 1.5,
  },
  tabs: {
    display: "flex",
    gap: 6,
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    padding: 4,
    marginBottom: 18,
  },
  tab: {
    flex: 1,
    padding: "9px 14px",
    background: "transparent",
    border: "none",
    borderRadius: T.radius.md,
    cursor: "pointer",
    fontSize: 13,
    color: T.color.onSurfaceVariant,
    fontFamily: T.font.sans,
    fontWeight: 500,
    transition: "all 0.15s",
  },
  tabActive: {
    color: T.color.primary,
    background: T.color.surfaceLowest,
    fontWeight: 600,
    boxShadow: T.shadow.focus,
  },
  tabBody: { marginBottom: 16 },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: T.color.primary,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  textarea: {
    width: "100%",
    minHeight: 200,
    padding: 14,
    fontSize: 13,
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    border: "none",
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    resize: "vertical",
    boxSizing: "border-box",
    color: T.color.onSurface,
    lineHeight: 1.5,
  },
  input: {
    width: "100%",
    padding: 12,
    fontSize: 14,
    border: "none",
    background: T.color.surfaceLow,
    borderRadius: T.radius.lg,
    boxSizing: "border-box",
    fontFamily: T.font.sans,
    color: T.color.onSurface,
  },
  fileInput: {
    fontSize: 14,
    marginBottom: 8,
    fontFamily: T.font.sans,
  },
  dropZone: {
    border: `2px dashed ${T.color.outlineGhost}`,
    borderRadius: T.radius.lg,
    background: T.color.surfaceLow,
    padding: "44px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all 0.15s ease",
    fontFamily: T.font.sans,
  },
  dropZoneActive: {
    borderColor: T.color.secondary,
    background: T.color.tertiaryFixed,
  },
  dropZoneIcon: {
    fontSize: 36,
    marginBottom: 12,
    opacity: 0.7,
  },
  dropZoneTextStrong: {
    fontSize: 15,
    color: T.color.primary,
    fontWeight: 600,
    marginBottom: 6,
  },
  dropZoneTextSub: {
    fontSize: 12,
    color: T.color.onSurfaceVariant,
  },
  filePreview: {
    padding: 12,
    background: T.color.tertiaryFixed,
    color: T.color.onSecondaryContainer,
    borderRadius: T.radius.lg,
    fontSize: 13,
    marginTop: 10,
    fontWeight: 500,
  },
  hint: {
    fontSize: 12,
    color: T.color.onSurfaceVariant,
    marginTop: 8,
    lineHeight: 1.4,
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: T.color.onSurfaceVariant,
    marginBottom: 14,
    cursor: "pointer",
  },
  error: {
    padding: 12,
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    borderRadius: T.radius.lg,
    fontSize: 13,
    marginBottom: 12,
  },
  progress: {
    padding: 12,
    background: T.color.surfaceHigh,
    color: T.color.primary,
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
    padding: "11px 20px",
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
    padding: "12px 26px",
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
