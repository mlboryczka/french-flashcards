import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// A sign-in link works once. Opened again (a second click, an older email
// after a newer one, or a work email system that opens links to scan them)
// Supabase sends the browser back here with the reason in the address bar,
// which the page never showed.
const linkFailed = () => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return !!(params.get("error") || params.get("error_code"));
};

export default function Auth() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(() =>
    linkFailed() ? "That sign-in link has expired or was already used. Send yourself a new one." : ""
  );

  // Cleared once read, so a reload or a later sign-out doesn't show it again.
  useEffect(() => {
    if (linkFailed()) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (authError) setError(authError.message);
    else setSent(true);
  };

  // The email carries a code as well as the link. Typing the code signs in
  // this tab; the link can only open a new one, leaving two copies open.
  const handleCode = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { data, error: codeError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    setLoading(false);
    if (codeError?.code === "otp_expired" || codeError?.status === 403 || (!codeError && !data?.session))
      setError("That code is wrong or has expired. Check the newest email, or send yourself a new one.");
    else if (codeError) setError(codeError.message);
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>Déjà Review</h1>
        {sent ? (
          <div style={styles.sent}>
            <div style={styles.sentIcon}>✉</div>
            <p style={styles.sentText}>
              We've emailed a sign-in code to {email}. Type it here to sign in on this page.
            </p>
            <form onSubmit={handleCode} style={styles.form}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="Code from the email"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                required
                disabled={loading}
                style={{ ...styles.input, ...styles.codeInput }}
                autoFocus
              />
              <button type="submit" disabled={loading || code.length < 6} style={styles.btn}>
                {loading ? "Checking…" : "Sign in"}
              </button>
              {error && <div style={styles.error}>{error}</div>}
            </form>
            <p style={styles.sentNote}>
              The link in the email works too, but it opens the app in a new tab.
            </p>
            <button
              style={styles.linkBtn}
              onClick={() => { setSent(false); setCode(""); setError(""); }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleLogin} style={styles.form}>
            <label style={styles.label}>
              Sign in with your email — no password needed.
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              disabled={loading}
              style={styles.input}
              autoFocus
            />
            <button type="submit" disabled={loading || !email} style={styles.btn}>
              {loading ? "Sending…" : "Send login link"}
            </button>
            {error && <div style={styles.error}>{error}</div>}
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    fontFamily: "'Georgia', 'Garamond', serif",
    background: "linear-gradient(135deg, #f7f5f0 0%, #ebe7dd 100%)",
  },
  card: {
    maxWidth: 420,
    width: "100%",
    background: "#fff",
    border: "1.5px solid #e0dcd4",
    borderRadius: 16,
    padding: "36px 32px",
    boxShadow: "0 6px 32px rgba(0,0,0,0.08)",
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    margin: "0 0 28px",
    letterSpacing: "-0.5px",
    color: "#0a0a0a",
    textAlign: "center",
  },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  label: {
    fontSize: 13,
    color: "#555",
    fontFamily: "system-ui, sans-serif",
    marginBottom: 4,
  },
  input: {
    padding: "11px 14px",
    border: "1.5px solid #ddd",
    borderRadius: 10,
    fontSize: 15,
    fontFamily: "'Georgia', serif",
    outline: "none",
    background: "#fafafa",
  },
  btn: {
    padding: "12px",
    border: "none",
    borderRadius: 10,
    background: "#2d6a4f",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "system-ui, sans-serif",
  },
  error: {
    color: "#a63d2f",
    fontSize: 12,
    fontFamily: "system-ui, sans-serif",
    textAlign: "center",
    marginTop: 4,
  },
  sent: { textAlign: "center" },
  codeInput: {
    textAlign: "center",
    fontSize: 20,
    letterSpacing: "4px",
    fontFamily: "system-ui, sans-serif",
  },
  sentNote: {
    fontSize: 12,
    color: "#888",
    fontFamily: "system-ui, sans-serif",
    lineHeight: 1.5,
    margin: "16px 0 8px",
  },
  sentIcon: { fontSize: 40, marginBottom: 12 },
  sentText: {
    fontSize: 14,
    color: "#555",
    fontFamily: "system-ui, sans-serif",
    lineHeight: 1.6,
    marginBottom: 16,
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "#2d6a4f",
    fontSize: 12,
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: "system-ui, sans-serif",
  },
};
