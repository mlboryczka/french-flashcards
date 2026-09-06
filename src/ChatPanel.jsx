import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";
import { CAT_UI_TO_DB } from "./lib/cardCategories";

// "Ask the tutor" slide-over. Look a word or phrase up, get an explanation,
// and add the cards Claude proposes straight into the deck.
//
// Design notes:
//   • Right-hand slide-over rather than a centered modal — the card behind
//     stays visible, so you can look something up mid-session without
//     losing your place.
//   • Proposed cards are never auto-added. Claude suggests, you click. A
//     wrong card in a spaced-repetition deck costs you months of reviews,
//     so the confirmation step earns itself.
//   • Adds go straight to Supabase from the client, not through /api/chat.
//     user_cards is RLS-protected (migration_003), so the insert runs as
//     the signed-in user and can only touch their own rows.
//   • Upsert on (user_id, front) means re-adding an existing card updates
//     it rather than erroring — which is also why the endpoint is told
//     which fronts already exist, so it can say "you have that" instead.
//
// Usage:
//   <ChatPanel open={showChat} onClose={...} user={user}
//              deckFronts={userCards.map(c => c.f)} onCardsAdded={reloadDeck} />

// Panel width. Exported because FlashcardApp reflows the app by exactly this
// much when the panel is open on a wide screen, so the two must agree.
export const CHAT_PANEL_WIDTH = 460;

const CATEGORY_LABEL = {
  vocab: "Vocabulary",
  expr: "Expression",
  gram: "Grammar",
  pron: "Pronunciation",
};

const SUGGESTIONS = [
  "What's the difference between amener and apporter?",
  "How do I say \"I'm looking forward to it\"?",
  "When do I use the subjunctive after bien que?",
];

export default function ChatPanel({
  open,
  onClose,
  user,
  deckFronts = [],
  onCardsAdded,
  // Wide screens push the app aside to make room for the panel rather than
  // covering it, so you can read the card you're asking about while you type.
  // Narrow screens have no room to reflow, so the panel stays an overlay with
  // a scrim.
  reflow = false,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // Fronts added this session, so the chip can flip to "Added" without a
  // full deck refetch on every click.
  const [added, setAdded] = useState(() => new Set());
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes — matches the rest of the app's overlays.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const send = useCallback(
    async (text) => {
      const trimmed = (text ?? input).trim();
      if (!trimmed || sending) return;

      setError("");
      setInput("");
      const nextMessages = [...messages, { role: "user", content: trimmed }];
      setMessages(nextMessages);
      setSending(true);

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error("Session expired — sign in again.");

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            // Only the prose goes back to the model — card proposals are
            // rendered client-side and would just be noise in the history.
            messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
            recentFronts: deckFronts.slice(0, 60),
          }),
        });

        // The API returns JSON on every path, but a platform-level failure
        // (504, cold-start crash) returns an HTML error page — read as text
        // first so JSON.parse doesn't throw over the real error.
        const raw = await res.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(
            res.status === 504
              ? "The tutor timed out. Try a shorter question."
              : `Server error (${res.status}).`
          );
        }
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.reply || "", cards: data.cards || [] },
        ]);
      } catch (e) {
        setError(e.message || "Something went wrong.");
        // Put the question back so it isn't lost to a network blip.
        setInput(trimmed);
        setMessages(messages);
      } finally {
        setSending(false);
      }
    },
    [input, sending, messages, deckFronts]
  );

  const addCard = useCallback(
    async (card) => {
      if (!user) return;
      const key = card.front.toLowerCase().trim();
      setError("");
      try {
        const { error: insErr } = await supabase.from("user_cards").upsert(
          {
            user_id: user.id,
            front: card.front,
            back: card.back,
            category: CAT_UI_TO_DB[card.category] || "V",
            // Today's date, matching the shape useUserDeck expects (an array
            // of ISO dates) so frequency sorting keeps working.
            dates: [new Date().toISOString().slice(0, 10)],
            source: "tutor-chat",
          },
          { onConflict: "user_id,front" }
        );
        if (insErr) throw insErr;
        setAdded((prev) => new Set(prev).add(key));
        onCardsAdded?.();
      } catch (e) {
        console.error("Add card failed:", e);
        setError(`Couldn't add "${card.front}": ${e.message || "unknown error"}`);
      }
    },
    [user, onCardsAdded]
  );

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter makes a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!open) return null;

  return createPortal(
    <div style={S.wrap}>
      {!reflow && <div style={S.scrim} onClick={onClose} />}
      <aside
        style={reflow ? { ...S.panel, width: CHAT_PANEL_WIDTH } : S.panel}
        role="dialog"
        aria-label="Ask the tutor"
      >
        <header style={S.head}>
          <div>
            <div style={S.title}>Ask the tutor</div>
            <div style={S.sub}>Look something up, then add it to your deck.</div>
          </div>
          <button style={S.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div style={S.scroll} ref={scrollRef}>
          {messages.length === 0 && (
            <div style={S.empty}>
              <p style={S.emptyText}>
                Ask about a word, a phrase, or a grammar point. If there's something
                worth drilling, you'll get cards you can add in one click.
              </p>
              {SUGGESTIONS.map((s) => (
                <button key={s} style={S.suggestion} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} style={m.role === "user" ? S.userRow : S.botRow}>
              <div style={m.role === "user" ? S.userBubble : S.botBubble}>
                {m.content}
              </div>
              {m.cards?.length > 0 && (
                <div style={S.cardList}>
                  {m.cards.map((c, j) => {
                    const isAdded = added.has(c.front.toLowerCase().trim());
                    return (
                      <div key={j} style={S.cardChip}>
                        <div style={S.chipMain}>
                          <div style={S.chipFront}>{c.front}</div>
                          <div style={S.chipBack}>{c.back}</div>
                          <div style={S.chipMeta}>
                            {CATEGORY_LABEL[c.category] || "Vocabulary"}
                            {c.note ? ` · ${c.note}` : ""}
                          </div>
                        </div>
                        <button
                          style={isAdded ? S.chipAdded : S.chipAdd}
                          onClick={() => addCard(c)}
                          disabled={isAdded}
                        >
                          {isAdded ? "Added" : "Add"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div style={S.botRow}>
              <div style={{ ...S.botBubble, color: T.color.onSurfaceVariant }}>Thinking…</div>
            </div>
          )}
        </div>

        {error && <div style={S.error}>{error}</div>}

        <div style={S.composer}>
          <textarea
            ref={inputRef}
            style={S.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about a word or phrase…"
            rows={2}
            disabled={sending}
          />
          <button
            style={sending || !input.trim() ? S.sendDisabled : S.send}
            onClick={() => send()}
            disabled={sending || !input.trim()}
          >
            Send
          </button>
        </div>
      </aside>
    </div>,
    document.body
  );
}

const S = {
  // pointerEvents none so that in reflow mode the app beside the panel stays
  // clickable; the scrim and panel opt themselves back in.
  wrap: { position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" },
  scrim: { position: "absolute", inset: 0, background: "rgba(3,22,50,0.28)", pointerEvents: "auto" },
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "min(460px, 100vw)",
    pointerEvents: "auto",
    background: T.color.surface,
    boxShadow: "-8px 0 32px rgba(3,22,50,0.16)",
    display: "flex",
    flexDirection: "column",
    fontFamily: T.font.sans,
  },
  head: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    padding: "20px 20px 14px",
    borderBottom: "1px solid rgba(3,22,50,0.06)",
  },
  title: { fontFamily: T.font.serif, fontSize: 18, fontWeight: 600, color: T.color.onSurface },
  sub: { fontSize: 12, color: T.color.onSurfaceVariant, marginTop: 3 },
  close: {
    background: "transparent",
    border: "none",
    fontSize: 16,
    cursor: "pointer",
    color: T.color.onSurfaceVariant,
    padding: 4,
    lineHeight: 1,
  },
  scroll: { flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 },
  empty: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 },
  emptyText: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "0 0 6px" },
  suggestion: {
    textAlign: "left",
    padding: "10px 12px",
    background: T.color.surfaceLowest,
    border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md,
    fontSize: 12.5,
    fontFamily: T.font.sans,
    color: T.color.onSurface,
    cursor: "pointer",
  },
  userRow: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  botRow: { display: "flex", flexDirection: "column", alignItems: "flex-start" },
  userBubble: {
    maxWidth: "85%",
    padding: "10px 14px",
    background: T.gradient.ink,
    color: T.color.onPrimary,
    borderRadius: T.radius.md,
    fontSize: 13.5,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
  },
  botBubble: {
    maxWidth: "92%",
    padding: "10px 14px",
    background: T.color.surfaceLowest,
    color: T.color.onSurface,
    borderRadius: T.radius.md,
    fontSize: 13.5,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    boxShadow: T.shadow.card,
  },
  cardList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10, width: "92%" },
  cardChip: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: T.color.surfaceLow,
    border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md,
  },
  chipMain: { flex: 1, minWidth: 0 },
  chipFront: { fontFamily: T.font.serif, fontSize: 14, fontWeight: 600, color: T.color.onSurface },
  chipBack: { fontSize: 12.5, color: T.color.onSurface, marginTop: 2 },
  chipMeta: { fontSize: 11, color: T.color.onSurfaceVariant, marginTop: 4, lineHeight: 1.4 },
  chipAdd: {
    flexShrink: 0,
    padding: "7px 14px",
    background: T.gradient.ink,
    color: T.color.onPrimary,
    border: "none",
    borderRadius: T.radius.md,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: T.font.sans,
    cursor: "pointer",
  },
  chipAdded: {
    flexShrink: 0,
    padding: "7px 14px",
    background: "transparent",
    color: T.color.onSurfaceVariant,
    border: "1px solid rgba(3,22,50,0.12)",
    borderRadius: T.radius.md,
    fontSize: 12,
    fontWeight: 500,
    fontFamily: T.font.sans,
    cursor: "default",
  },
  error: {
    margin: "0 20px 8px",
    padding: "8px 12px",
    background: T.color.errorContainer,
    color: T.color.onErrorContainer,
    borderRadius: T.radius.md,
    fontSize: 12,
  },
  composer: {
    display: "flex",
    gap: 8,
    padding: "12px 20px 20px",
    borderTop: "1px solid rgba(3,22,50,0.06)",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    padding: "10px 12px",
    background: T.color.surfaceHigh,
    border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md,
    fontSize: 13.5,
    fontFamily: T.font.sans,
    color: T.color.onSurface,
    resize: "none",
    outline: "none",
  },
  send: {
    padding: "11px 18px",
    background: T.gradient.ink,
    color: T.color.onPrimary,
    border: "none",
    borderRadius: T.radius.md,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: T.font.sans,
    cursor: "pointer",
  },
  sendDisabled: {
    padding: "11px 18px",
    background: T.color.surfaceHighest,
    color: T.color.onSurfaceVariant,
    border: "none",
    borderRadius: T.radius.md,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: T.font.sans,
    cursor: "default",
  },
};
