import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { T } from "./theme";
import {
  readKey,
  writeKey,
  clearKey,
  looksLikeAnthropicKey,
  maskKey,
} from "./lib/anthropicKey";

// "Connect your Claude account".
//
// Everything in this app that calls Claude — the tutor, the answer reviewer,
// the cahier parser — bills an Anthropic account per request. It used to be
// the deploy owner's, for any caller. Now each person brings their own.
//
// The key is written to this browser's localStorage and sent as a header on
// the user's own requests. It is never stored on the server, so the app is
// not a custodian of anyone's credentials.
export default function ApiKeyModal({ open, onClose, user }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  // Reload from storage each time it opens: the key may have been set in
  // another tab, or cleared.
  useEffect(() => {
    if (!open) return;
    const existing = readKey(user?.id);
    setSaved(existing);
    setValue("");
    setError("");
  }, [open, user?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = () => {
    const trimmed = value.trim();
    if (!looksLikeAnthropicKey(trimmed)) {
      setError('That doesn’t look right — keys start with "sk-ant-".');
      return;
    }
    if (!writeKey(user?.id, trimmed)) {
      setError(
        "Couldn't save to this browser. Private windows and blocked site data both stop it."
      );
      return;
    }
    setSaved(trimmed);
    setValue("");
    setError("");
    onClose?.();
  };

  const disconnect = () => {
    clearKey(user?.id);
    setSaved("");
    setValue("");
    setError("");
  };

  return createPortal(
    <div style={S.scrim} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect your Claude account">
        <div style={S.title}>Connect your Claude account</div>
        <p style={S.body}>
          The tutor, the &ldquo;my answer should have been accepted&rdquo; review and
          the document parser all call Claude, which costs money per request.
          Add your own Anthropic API key and those requests bill your account.
        </p>

        {saved ? (
          <div style={S.connected}>
            <span>Connected &middot; <code style={S.code}>{maskKey(saved)}</code></span>
            <button style={S.linkBtn} onClick={disconnect}>Disconnect</button>
          </div>
        ) : (
          <div style={S.notConnected}>Not connected &mdash; those features are turned off.</div>
        )}

        <label style={S.label} htmlFor="anthropic-key-input">
          {saved ? "Replace it" : "API key"}
        </label>
        <input
          id="anthropic-key-input"
          style={S.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-..."
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        />
        {error && <div style={S.error}>{error}</div>}

        <p style={S.fine}>
          Create one at{" "}
          <a style={S.link} href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>
          . It is stored in this browser only &mdash; never on the server &mdash; so you
          will need to add it again on another device, and you can revoke it at
          any time from the Anthropic console.
        </p>

        <div style={S.actions}>
          <button style={S.cancel} onClick={onClose}>Close</button>
          <button style={value.trim() ? S.save : S.saveOff} onClick={save} disabled={!value.trim()}>
            Save key
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const S = {
  scrim: {
    position: "fixed", inset: 0, zIndex: 1200,
    background: "rgba(3,22,50,0.34)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
  },
  modal: {
    background: T.color.surface, borderRadius: T.radius.xl,
    padding: "24px 24px 20px", width: "min(460px, 100%)",
    boxShadow: "0 24px 64px rgba(3,22,50,0.24)",
    fontFamily: T.font.sans, boxSizing: "border-box",
    maxHeight: "90vh", overflowY: "auto",
  },
  title: { fontFamily: T.font.serif, fontSize: 19, fontWeight: 600, color: T.color.onSurface },
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "8px 0 14px" },
  connected: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
    fontSize: 12.5, color: T.color.onSurface,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 14,
  },
  notConnected: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 14,
  },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
  linkBtn: {
    background: "transparent", border: "none", padding: 0, cursor: "pointer",
    fontSize: 12, fontFamily: T.font.sans, color: T.color.primary,
    fontWeight: 600, textDecoration: "underline", flexShrink: 0,
  },
  label: { display: "block", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
    textTransform: "uppercase", color: T.color.onSurfaceVariant, marginBottom: 6 },
  input: {
    width: "100%", boxSizing: "border-box", padding: "10px 12px",
    background: T.color.surfaceHigh, border: "1px solid rgba(3,22,50,0.12)",
    borderRadius: T.radius.md, fontSize: 13.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: T.color.onSurface, outline: "none",
  },
  error: {
    marginTop: 8, padding: "7px 10px", borderRadius: T.radius.md,
    background: T.color.errorContainer, color: T.color.onErrorContainer, fontSize: 12,
  },
  fine: { fontSize: 11.5, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "12px 0 0" },
  link: { color: T.color.primary },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 },
  cancel: {
    padding: "9px 16px", background: "transparent", border: "1px solid rgba(3,22,50,0.14)",
    borderRadius: T.radius.md, fontSize: 13, fontFamily: T.font.sans,
    color: T.color.onSurfaceVariant, cursor: "pointer",
  },
  save: {
    padding: "9px 18px", background: T.gradient.ink, color: T.color.onPrimary,
    border: "none", borderRadius: T.radius.md, fontSize: 13, fontWeight: 600,
    fontFamily: T.font.sans, cursor: "pointer",
  },
  saveOff: {
    padding: "9px 18px", background: T.color.surfaceHighest, color: T.color.onSurfaceVariant,
    border: "none", borderRadius: T.radius.md, fontSize: 13, fontWeight: 600,
    fontFamily: T.font.sans, cursor: "default",
  },
};
