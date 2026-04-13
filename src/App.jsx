import { useState, useEffect } from "react";
import { supabase } from "./supabase";
import Auth from "./Auth";
import FlashcardApp from "./FlashcardApp";

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Grab the existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    // Subscribe to auth state changes (login, logout, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Georgia', serif",
          color: "#888",
        }}
      >
        Loading…
      </div>
    );
  }

  if (!session) return <Auth />;

  return <FlashcardApp user={session.user} onSignOut={handleSignOut} />;
}
