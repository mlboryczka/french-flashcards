import { useState } from "react";
import { supabase } from "./supabase";

export default function Auth() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.title}>French Flashcards</h1>
        <p style={styles.tagline}>
          A spaced-repetition deck from a year of daily French lessons.
        </p>
        {sent ? (
          <div style={styles.sent}>
            <div style={styles.sentIcon}>✉</div>
            <p style={styles.sentText}>
              Check your inbox for a login link. It'll sign you in automatically.
            </p>
            <button style={styles.linkBtn} onClick={() => setSent(false)}>
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
    margin: "0 0 8px",
    letterSpacing: "-0.5px",
    color: "#0a0a0a",
    textAlign: "center",
  },
  tagline: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
    margin: "0 0 28px",
    fontFamily: "system-ui, sans-serif",
    lineHeight: 1.5,
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
