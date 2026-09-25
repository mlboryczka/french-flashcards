import { useState } from "react";
import { T } from "./theme";

// "Your cahier": the Google Doc the student and their teacher write in, which
// the app reads on its own from then on.
//
// This used to live inside the upload dialog as a third tab with a tick box,
// which put a permanent link inside a one-off upload form: the student was
// shown a URL box, two tick boxes, a status panel and an Upload button for a
// doc that was already linked and checking itself (2026-09-25 — "this is super
// complicated"). Linking is not uploading, so it is its own screen now, with
// two states and nothing else in either.
//
// Props: open, onClose, cahier (useCahierSync), onCardsAdded
export function CahierLink({ open, onClose, cahier, onCardsAdded }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  if (!open) return null;

  const link = cahier?.link || null;

  async function linkDoc() {
    const href = url.trim();
    if (!href.includes("docs.google.com/document/")) {
      setError("That should be a Google Doc link, like https://docs.google.com/document/d/…");
      return;
    }
    setError("");
    setBusy(true);
    setProgress("Reading your cahier…");
    const result = await cahier.sync({
      url: href,
      force: true,
      onProgress: (run) =>
        setProgress(run.remaining
          ? `Adding your classes… ${run.addedSoFar} cards so far, ${run.remaining} classes to go`
          : `Adding your classes… ${run.addedSoFar} cards so far`),
    });
    setBusy(false);
    setProgress("");
    if (!result?.ok) { setError(result?.error || "Couldn't read that cahier."); return; }
    setUrl("");
    if (result.cards > 0) onCardsAdded?.(result);
  }

  async function checkNow() {
    setError("");
    setBusy(true);
    setProgress("Checking…");
    const result = await cahier.sync({ force: true, onProgress: (run) => setProgress(`Checking… ${run.addedSoFar} cards so far`) });
    setBusy(false);
    setProgress("");
    if (!result?.ok) { setError(result?.error || "Couldn't read your cahier."); return; }
    if (result.cards > 0) onCardsAdded?.(result);
  }

  return (
    <div style={S.overlay} onClick={busy ? null : onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()} data-cahier-link>
        <div style={S.head}>
          <h2 style={S.title}>Your cahier</h2>
          <button style={S.close} onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>

        {link ? (
          <>
            <p style={S.text}>
              Linked. {link.last_checked_at ? `Last checked ${timeAgo(link.last_checked_at)}.` : "Not checked yet."}
              {link.last_result?.cards
                ? ` Last added ${link.last_result.cards.toLocaleString()} ${link.last_result.cards === 1 ? "card" : "cards"} from ${link.last_result.dates?.length || 0} ${link.last_result.dates?.length === 1 ? "class" : "classes"}.`
                : ""}
            </p>
            <p style={S.quiet}>
              Each class your teacher adds becomes cards on its own — when you open the app, and
              once each night. Nothing you already have is changed.
            </p>
            {link.last_error && <div style={S.error}>{link.last_error}</div>}
            {error && <div style={S.error}>{error}</div>}
            {progress && <div style={S.progress}>{progress}</div>}
            <div style={S.actions}>
              <button style={S.secondary} onClick={checkNow} disabled={busy}>
                {busy ? "Checking…" : "Check now"}
              </button>
              <button style={S.secondary} onClick={() => cahier.unlink()} disabled={busy}>Unlink</button>
            </div>
          </>
        ) : (
          <>
            <p style={S.text}>
              Paste the link to the Google Doc you and your teacher write in.
            </p>
            <p style={S.text}>
              After that, the app reads it when you open it and once each night. Any class it
              hasn't seen before becomes cards. Classes it has already read are never touched,
              so nothing you've studied changes.
            </p>
            <input
              style={S.input}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/document/d/…"
              disabled={busy}
              autoFocus
            />
            <p style={S.quiet}>
              The doc has to be shared so that anyone with the link can view it.
            </p>
            {error && <div style={S.error}>{error}</div>}
            {progress && <div style={S.progress}>{progress}</div>}
            <div style={S.actions}>
              <button style={S.primary} onClick={linkDoc} disabled={busy}>
                {busy ? "Linking…" : "Link"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "just now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "moments ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const S = {
  overlay: { position:"fixed", inset:0, background:"rgba(20,20,20,0.45)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 },
  modal: { background:T.color.surface, borderRadius:16, padding:"28px 32px 24px", width:"min(520px, 100%)", boxShadow:"0 24px 60px rgba(0,0,0,0.25)" },
  head: { display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:16 },
  title: { fontFamily:T.font.serif, fontSize:26, margin:"0 0 14px", color:T.color.onSurface },
  close: { border:"none", background:"transparent", cursor:"pointer", fontSize:16, color:T.color.onSurfaceVariant, padding:4 },
  text: { fontFamily:T.font.sans, fontSize:14, lineHeight:1.7, color:T.color.onSurface, margin:"0 0 16px" },
  quiet: { fontFamily:T.font.sans, fontSize:13, lineHeight:1.7, color:T.color.onSurfaceVariant, margin:"14px 0 0" },
  input: { width:"100%", boxSizing:"border-box", fontFamily:T.font.sans, fontSize:14, padding:"13px 14px", borderRadius:10, marginTop:4,
    border:`1px solid ${T.color.outline}`, background:T.color.surfaceHigh, color:T.color.onSurface },
  error: { marginTop:12, padding:"10px 12px", borderRadius:9, background:"#fdecec", color:"#8a2020", fontFamily:T.font.sans, fontSize:13, lineHeight:1.45 },
  progress: { marginTop:12, fontFamily:T.font.sans, fontSize:13, color:T.color.onSurfaceVariant },
  actions: { display:"flex", gap:10, justifyContent:"flex-end", marginTop:24 },
  primary: { fontFamily:T.font.sans, fontSize:14, fontWeight:600, padding:"10px 22px", borderRadius:10, border:"none",
    background:T.color.primary, color:"#fff", cursor:"pointer" },
  secondary: { fontFamily:T.font.sans, fontSize:13, fontWeight:600, padding:"9px 16px", borderRadius:10,
    border:`1px solid ${T.color.outline}`, background:T.color.surface, color:T.color.onSurface, cursor:"pointer" },
};
