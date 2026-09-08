import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase";
import Auth from "./Auth";
import FlashcardApp from "./FlashcardApp";

// How long to wait for getSession() before giving up on it.
//
// getSession() reads local storage first, so on a healthy project it settles
// in milliseconds. It hangs only when it has to reach Supabase and Supabase
// isn't there — which on the free tier means the project auto-paused after
// ~7 days idle. Without this timeout the promise never settles, `loading`
// stays true, and the app sits on "Loading…" forever with nothing on screen
// to say why. Ten seconds is far longer than the healthy path ever needs and
// short enough that the failure is still obviously a failure.
const SESSION_TIMEOUT_MS = 10000;

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    // `settled` guards against the timeout and the response racing: whichever
    // lands first wins and the other becomes a no-op.
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          setAuthError("timeout");
          setLoading(false);
        }),
      SESSION_TIMEOUT_MS
    );

    // Grab the existing session on mount
    supabase.auth
      .getSession()
      .then(({ data: { session } }) =>
        finish(() => {
          setSession(session);
          setAuthError("");
          setLoading(false);
        })
      )
      .catch((e) =>
        finish(() => {
          console.error("getSession failed:", e);
          setAuthError(e?.message || "unknown error");
          setLoading(false);
        })
      );

    // Subscribe to auth state changes (login, logout, token refresh). If the
    // backend comes back on its own, this clears the error screen without a
    // reload.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Only an actual sign-out clears the session.
      //
      // Coming back to a backgrounded tab makes supabase-js re-check the
      // token, and that can report a null session for a moment before the
      // refreshed one lands. Taking it at face value swapped the app for the
      // sign-in screen and back, and because that UNMOUNTS FlashcardApp it
      // came back with its deck unloaded — which is the "Loading…" flash you
      // get on returning to the tab. The app is already on screen; a token
      // refresh is not a reason to tear it down.
      if (event === "SIGNED_OUT") {
        setSession(null);
        return;
      }
      if (!session) return;
      setSession(session);
      setAuthError("");
    });
    return () => {
      clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [retry]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const tryAgain = useCallback(() => {
    setAuthError("");
    setLoading(true);
    setRetry((n) => n + 1);
  }, []);

  if (loading) {
    return (
      <div style={centred}>
        <span>Loading…</span>
      </div>
    );
  }

  // Reaching Supabase failed. Say so, rather than sitting on "Loading…" —
  // the cause is almost always a paused free-tier project, which is fixable
  // in about ten seconds once you know that's what happened.
  if (authError && !session) {
    return (
      <div style={{ ...centred, flexDirection: "column", gap: 14, padding: 24, textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 17, color: "#444" }}>
          Couldn't reach the server.
        </p>
        <p style={{ margin: 0, fontSize: 14, maxWidth: 420, lineHeight: 1.5 }}>
          {authError === "timeout"
            ? "The database didn't answer. If it has been idle for a week or so it may have been paused — resume the project in the Supabase dashboard, then try again."
            : authError}
        </p>
        <button
          onClick={tryAgain}
          style={{
            marginTop: 6,
            padding: "9px 20px",
            fontSize: 14,
            fontFamily: "inherit",
            color: "#fff",
            background: "#9c4234",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!session) return <Auth />;

  return <FlashcardApp user={session.user} onSignOut={handleSignOut} />;
}

const centred = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "'Georgia', serif",
  color: "#888",
};
