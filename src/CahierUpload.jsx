import { useState, useRef, useEffect } from "react";
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

export function CahierUpload({ open, onClose, onSuccess, hasExisting, initialTab }) {
  const [tab, setTab] = useState(initialTab || "paste"); // paste | file | link
  // When the modal is reopened with a different initialTab, switch to it.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab, open]);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [replace, setReplace] = useState(hasExisting ? false : true);
  const [status, setStatus] = useState("idle"); // idle | uploading | error
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef(null);

  if (!open) return null;

  // Detects file type by extension and runs the appropriate extractor.
  // PDF and DOCX libraries are lazy-loaded the first time they're needed
  // so the main app bundle stays small. Both extract to plain text on the
  // client; the server endpoint never sees the original binary.
  async function processFile(file) {
    if (!file) return;
    setError("");
    const name = file.name.toLowerCase();
    const isTxt = name.endsWith(".txt");
    const isPdf = name.endsWith(".pdf");
    const isDocx = name.endsWith(".docx");

    if (!isTxt && !isPdf && !isDocx) {
      setError(
        "Unsupported file type. Drop a .txt, .pdf, or .docx file."
      );
      return;
    }

    // 25MB hard cap before extraction — pdfjs can chew on big PDFs but the
    // result will eventually exceed our 500K-char server limit anyway.
    if (file.size > 25 * 1024 * 1024) {
      setError("File is too large (max 25MB). Try a shorter cahier.");
      return;
    }

    setExtracting(true);
    try {
      let content;
      if (isTxt) {
        content = await file.text();
      } else if (isPdf) {
        content = await extractPdfText(file);
      } else {
        content = await extractDocxText(file);
      }
      content = content.trim();
      if (!content || content.length < 50) {
        setError(
          "Couldn't extract any text from this file. If it's a scanned PDF, you'll need to OCR it first."
        );
        setExtracting(false);
        return;
      }
      setText(content);
      setFileName(file.name);
    } catch (e) {
      console.error("File extraction failed:", e);
      setError(`Couldn't read the file: ${e.message || "unknown error"}`);
    } finally {
      setExtracting(false);
    }
  }

  // ── Lazy extractors ────────────────────────────────────────────────
  // pdfjs-dist is ~500KB gzipped; mammoth is ~200KB. We dynamic-import
  // them on first use so they never load on pages that don't need them.
  async function extractPdfText(file) {
    const pdfjs = await import("pdfjs-dist/build/pdf");
    // pdfjs needs a worker; Vite-friendly URL pattern below resolves to
    // a hashed asset at build time.
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      const workerUrl = (await import(
        "pdfjs-dist/build/pdf.worker.min?url"
      )).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    }
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      // Reconstruct lines: pdfjs gives positioned text items. Group by
      // y-coordinate so we get one logical line per row, then sort rows
      // top-to-bottom. Without this, "Le 10 avril 2026\nVocabulaire" can
      // arrive as a single space-collapsed mush.
      const rows = new Map();
      for (const item of tc.items) {
        const y = Math.round(item.transform[5]); // y-coord
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: item.transform[4], str: item.str });
      }
      const sortedYs = [...rows.keys()].sort((a, b) => b - a); // top-down
      const lines = sortedYs.map((y) =>
        rows.get(y)
          .sort((a, b) => a.x - b.x)
          .map((it) => it.str)
          .join("")
          .replace(/\s+/g, " ")
          .trim()
      ).filter(Boolean);
      pages.push(lines.join("\n"));
    }
    return pages.join("\n\n");
  }

  async function extractDocxText(file) {
    const mammoth = await import("mammoth/mammoth.browser");
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value || "";
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
    setProgress("Slicing your cahier…");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not signed in");
      }

      // ── PHASE 1: SLICE ────────────────────────────────────────────────
      // Server parses the raw text into per-date blocks. Fast (<2s).
      const sliceData = await callApi(session.access_token, {
        action: "slice",
        mode,
        content,
      });
      const blocks = sliceData.blocks || [];
      if (blocks.length === 0) {
        throw new Error("No lessons found in the input.");
      }

      // ── PHASE 2: EXTRACT (CHUNKED) ────────────────────────────────────
      // Slice the blocks into chunks of CHUNK_SIZE and process them one
      // at a time. Each request runs ~CHUNK_SIZE Claude calls in parallel
      // server-side and finishes in ~10-15s — well under the Vercel Hobby
      // 60s function limit.
      //
      // Sequential (not parallel) on the client because:
      //   1. Anthropic per-org rate limits — 60+ Haiku calls in flight all
      //      at once will start hitting 429s
      //   2. Serial gives us clean progress updates
      //   3. If one chunk fails we know exactly which one
      const CHUNK_SIZE = 15;
      const allCards = [];
      const allErrors = [];
      const totalChunks = Math.ceil(blocks.length / CHUNK_SIZE);

      for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
        const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
        setProgress(
          `Extracting cards from your lessons… (chunk ${chunkIndex} of ${totalChunks})`
        );
        const chunk = blocks.slice(i, i + CHUNK_SIZE);
        const extractData = await callApi(session.access_token, {
          action: "extract",
          blocks: chunk,
        });
        if (Array.isArray(extractData.cards)) {
          allCards.push(...extractData.cards);
        }
        if (Array.isArray(extractData.errors)) {
          allErrors.push(...extractData.errors);
        }
      }

      if (allCards.length === 0) {
        throw new Error(
          allErrors.length
            ? `Extraction failed: ${allErrors[0].error || "unknown"}`
            : "No cards extracted from any lesson."
        );
      }

      // ── PHASE 3: COMMIT ───────────────────────────────────────────────
      // Send the full set of cards to the server for cross-chunk dedupe,
      // conjugation expansion, and database insert. Cheap and fast.
      setProgress(
        `Saving ${allCards.length.toLocaleString()} cards to your deck…`
      );
      const commitData = await callApi(session.access_token, {
        action: "commit",
        cards: allCards,
        replace,
      });

      setStatus("idle");
      onSuccess(commitData);
    } catch (e) {
      setStatus("error");
      setError(e.message || "Upload failed");
    }
  }

  // Shared API caller — handles auth, JSON parsing, and surfaces real
  // errors instead of letting JSON.parse crash on HTML error pages.
  async function callApi(accessToken, body) {
    const res = await fetch("/api/parse-cahier", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const responseText = await res.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      if (res.status === 504 || /timeout|gateway/i.test(responseText)) {
        throw new Error(
          "The server timed out on this chunk. Try a shorter cahier, or split it into pieces."
        );
      }
      if (res.status >= 500) {
        throw new Error(
          `Server error (HTTP ${res.status}). The function may have crashed — check Vercel logs.`
        );
      }
      throw new Error(
        `Server returned an unexpected response (HTTP ${res.status}): ${responseText.slice(0, 200)}`
      );
    }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
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
                onClick={() => extracting ? null : fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div style={M.dropZoneIcon}>📄</div>
                {extracting ? (
                  <>
                    <div style={M.dropZoneTextStrong}>Reading file…</div>
                    <div style={M.dropZoneTextSub}>Extracting text from your document</div>
                  </>
                ) : fileName ? (
                  <>
                    <div style={M.dropZoneTextStrong}>{fileName}</div>
                    <div style={M.dropZoneTextSub}>
                      {text.length.toLocaleString()} characters loaded · click to choose a different file
                    </div>
                  </>
                ) : (
                  <>
                    <div style={M.dropZoneTextStrong}>
                      {isDragging ? "Drop your file here" : "Drop a .txt, .pdf, or .docx file"}
                    </div>
                    <div style={M.dropZoneTextSub}>or click to browse</div>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleFileUpload}
                  disabled={status === "uploading" || extracting}
                  style={{ display: "none" }}
                />
              </div>
              <div style={M.hint}>
                Supports .txt, .pdf, and .docx. Scanned PDFs without text won't work — they need to be OCR'd first.
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
    maxWidth: 640,
    width: "100%",
    maxHeight: "90vh",
    overflowY: "auto",
    padding: "40px 44px",
    boxShadow: "0 32px 96px rgba(3,22,50,0.18)",
    fontFamily: T.font.sans,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  title: {
    margin: 0,
    fontSize: 36,
    color: T.color.primary,
    fontFamily: T.font.serif,
    fontWeight: 700,
    letterSpacing: "-0.025em",
    lineHeight: 1.1,
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
    border: `2px dashed rgba(3,22,50,0.12)`,
    borderRadius: T.radius.xl,
    background: T.color.surfaceLow,
    padding: "60px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all 0.2s ease",
    fontFamily: T.font.sans,
  },
  dropZoneActive: {
    borderColor: T.color.secondary,
    background: T.color.tertiaryFixed,
    transform: "scale(1.01)",
  },
  dropZoneIcon: {
    fontSize: 44,
    marginBottom: 14,
    opacity: 0.7,
  },
  dropZoneTextStrong: {
    fontSize: 17,
    color: T.color.primary,
    fontWeight: 700,
    marginBottom: 6,
    fontFamily: T.font.serif,
    letterSpacing: "-0.01em",
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
