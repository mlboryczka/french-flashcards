import { useState, useRef, useEffect, useCallback } from "react";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";
import { CAT_UI_TO_DB } from "./lib/cardCategories";
import { keyHeaders, BYOK_REQUIRED } from "./lib/anthropicKey";
import { cleanFrenchPrompt } from "./lib/cardText";
import { buildTutorContext } from "./lib/deckContext";

// "Ask the tutor" slide-over. Look a word or phrase up, get an explanation,
// and add the cards Claude proposes straight into the deck.
//
// Design notes:
//   • Right-hand slide-over rather than a centered modal — the card behind
//     stays visible, so you can look something up mid-session without
//     losing your place.
//   • The answer STREAMS. It used to arrive as one blocking JSON response,
//     which meant staring at "Thinking…" for the whole generation.
//   • Proposed cards are never auto-added, and they are EDITABLE before you
//     add them. Claude suggests, you correct, you click. A wrong card in a
//     spaced-repetition deck costs you months of reviews; making the front a
//     text input turns that from a bad review stream into a keystroke.
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

// Slide duration and curve. FlashcardApp animates the page's reflow with the
// SAME pair, so the panel and the page it displaces move as one thing rather
// than two — the panel appearing instantly against a sliding page was what
// made this feel abrupt.
export const CHAT_ANIM_MS = PANEL_ANIM_MS;
export const CHAT_EASING = PANEL_EASING;

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

// One proposed card. Its own component so each chip owns its edit state —
// hoisting that into ChatPanel would mean a keystroke in one chip re-rendering
// the whole thread.
function ProposedCard({ card, added, onAdd }) {
  // Cleaned the same way the study view cleans it, so the chip shows what the
  // card will actually look like when you meet it.
  const [front, setFront] = useState(() => cleanFrenchPrompt(card.front, card.back));
  const [back, setBack] = useState(card.back);
  const [editing, setEditing] = useState(false);

  const dirty = front !== cleanFrenchPrompt(card.front, card.back) || back !== card.back;
  // Keyed on the front as it stands NOW, not on the proposal. Checking the
  // original meant editing a card before adding it wrote one key and looked up
  // another, so the chip never showed it had been added and the same card
  // could be added over and over.
  const isAdded = added.has(front.toLowerCase().trim());

  return (
    <div style={S.cardChip} data-proposed-card>
      <div style={S.chipMain}>
        {editing ? (
          <>
            <input
              style={S.chipEditFront}
              value={front}
              onChange={(e) => setFront(e.target.value)}
              aria-label="Card front (French)"
            />
            <input
              style={S.chipEditBack}
              value={back}
              onChange={(e) => setBack(e.target.value)}
              aria-label="Card back (English)"
            />
          </>
        ) : (
          <>
            <div style={S.chipFront}>{front}</div>
            <div style={S.chipBack}>{back}</div>
          </>
        )}
        <div style={S.chipMeta}>
          {CATEGORY_LABEL[card.category] || "Vocabulary"}
          {card.note ? ` · ${card.note}` : ""}
          {dirty ? " · edited" : ""}
        </div>
      </div>
      <div style={S.chipActions}>
        <button
          style={isAdded ? S.chipAdded : S.chipAdd}
          onClick={() => onAdd({ ...card, front: front.trim(), back: back.trim() })}
          disabled={isAdded || !front.trim() || !back.trim()}
        >
          {isAdded ? "Added" : "Add"}
        </button>
        {!isAdded && (
          <button
            style={S.chipEditToggle}
            onClick={() => setEditing((v) => !v)}
            aria-label={editing ? "Done editing" : "Edit this card"}
          >
            {editing ? "Done" : "Edit"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({
  open,
  onClose,
  user,
  // The whole shaped deck, not a list of fronts. deckContext reads backs and
  // review history off these rows to tell the tutor what you already have and
  // what you keep missing.
  cards = [],
  // The card on screen, if the tutor was opened from a study session.
  currentCard = null,
  onCardsAdded,
  // Opens the "connect your Claude account" dialog. The tutor spends money
  // per question and the server refuses without a key, so the error needs a
  // way out of itself rather than just an explanation.
  onNeedKey,
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
  // "byok_required" when the server refused for want of a key, so the error
  // can offer the fix instead of only naming the problem.
  const [errorCode, setErrorCode] = useState("");
  // Fronts added this session, so the chip can flip to "Added" without a
  // full deck refetch on every click.
  const [added, setAdded] = useState(() => new Set());
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  // Lets a close abort an answer in flight. Without it, closing the panel
  // mid-request left the request running — spending the caller's own Anthropic
  // credit — and its answer landing in a panel nobody was looking at.
  const abortRef = useRef(null);

  // Two flags rather than one so the panel can animate on the way OUT as well
  // as in: `mounted` keeps it in the DOM until the slide finishes, `entered`
  // drives the transform. Without the delayed unmount, closing would make it
  // vanish instantly while the page was still sliding back.
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);

  // Freeze the layout mode while the panel is on screen. `reflow` is derived
  // from the open flag upstream, so it flips to false the instant you close —
  // which used to mount the scrim over the app for the length of the exit
  // animation, blocking the next click and reading as a flash.
  const reflowRef = useRef(reflow);
  if (open) reflowRef.current = reflow;
  const activeReflow = mounted ? reflowRef.current : reflow;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setEntered(false);
    // Whatever was being generated is no longer wanted.
    abortRef.current?.abort();
    const t = setTimeout(() => setMounted(false), CHAT_ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);

  // Move to the entered position only once the panel has actually been PAINTED
  // off-screen. This has to key off `mounted`, not `open`, and take two frames:
  // on the render where open flips true the panel is not in the DOM yet, and a
  // single rAF can still be flushed before the browser paints — either way the
  // browser has no start position to animate from and the panel just appears.
  useEffect(() => {
    if (!mounted || !open) return;
    let inner;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [mounted, open]);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Click anywhere outside to close. In reflow mode there is no scrim to catch
  // the click, so this listener is the only thing that does it. The tutor
  // toggles opt out via data-tutor-toggle: otherwise this would close the
  // panel on mousedown and the button's own click would immediately reopen it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (e.target.closest?.("[data-tutor-toggle]")) return;
      // Swallow the click this mousedown is about to produce. Without it the
      // dismissing click also lands on whatever sits underneath — flipping the
      // card, revealing an answer, switching view — which is what looked like
      // the screen flashing on exit.
      //
      // Deliberate controls are exempt: clicking "Send feedback" while the
      // tutor is open should close the tutor AND open feedback, not be eaten.
      // Only accidental hits on inert surfaces need swallowing.
      const onControl = !!e.target.closest?.(
        "button, a, input, textarea, select, label, [role='button']"
      );
      if (onControl) { onClose?.(); return; }
      const swallow = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(
        () => document.removeEventListener("click", swallow, { capture: true }),
        400
      );
      onClose?.();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  // Escape closes — matches the rest of the app's overlays.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Rewrite the last message in place. Streaming only touches the tail of the
  // thread, so everything above it keeps its identity and doesn't re-render.
  const updateLast = useCallback((fn) => {
    setMessages((prev) => {
      if (!prev.length) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return copy;
    });
  }, []);

  const send = useCallback(
    async (text) => {
      const trimmed = (text ?? input).trim();
      if (!trimmed || sending) return;

      setError("");
      setErrorCode("");
      setInput("");
      const nextMessages = [...messages, { role: "user", content: trimmed }];
      // The empty assistant bubble is what fills in as tokens arrive, so it
      // goes in before the request rather than after it.
      setMessages([
        ...nextMessages,
        { role: "assistant", content: "", cards: [], streaming: true },
      ]);
      setSending(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let gotText = false;

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
            // The user's own Anthropic key. Absent when they haven't
            // connected one; the server then answers 402.
            ...keyHeaders(user?.id),
          },
          signal: controller.signal,
          body: JSON.stringify({
            // Only the prose goes back to the model — card proposals are
            // rendered client-side and would just be noise in the history.
            messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
            // Rebuilt from scratch every turn against the question just asked,
            // so it never accumulates in the thread.
            context: buildTutorContext({ question: trimmed, cards, currentCard }),
          }),
        });

        // A failure before the stream opens still answers in JSON — the 402
        // with no key, a rejected token, a platform-level HTML error page.
        if (!res.ok || !res.body) {
          const raw = await res.text();
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {
            throw new Error(
              res.status === 504
                ? "The tutor timed out. Try a shorter question."
                : `Server error (${res.status}).`
            );
          }
          const err = new Error(data.error || `Request failed (${res.status})`);
          err.code = data.code || "";
          throw err;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamError = null;

        // SSE frames are separated by a blank line and can be split across
        // network chunks, so hold the tail back until its terminator arrives.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let event;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (event.type === "text") {
              gotText = true;
              updateLast((m) => ({ ...m, content: m.content + event.delta }));
            } else if (event.type === "cards") {
              updateLast((m) => ({ ...m, cards: event.cards || [] }));
            } else if (event.type === "error") {
              streamError = event;
            }
          }
        }

        updateLast((m) => ({ ...m, streaming: false }));
        if (streamError) {
          // A key Anthropic rejects can only surface once generation has
          // started, so it arrives here rather than as a status — but it
          // carries the same code, and gets the same offer of a way out.
          const err = new Error(streamError.error || "The tutor failed mid-answer.");
          err.code = streamError.code || "";
          throw err;
        }
        if (!gotText) throw new Error("The tutor returned nothing. Try rephrasing.");
      } catch (e) {
        // Closing the panel aborts on purpose. The bubble still has to be
        // closed out: this component is not unmounted, so returning early left
        // a half-answer blinking its caret forever and put an empty assistant
        // turn into the next request's history.
        if (e.name === "AbortError") {
          if (gotText) updateLast((m) => ({ ...m, streaming: false }));
          else setMessages(messages);
          return;
        }
        setError(e.message || "Something went wrong.");
        setErrorCode(e.code || "");
        if (gotText) {
          // Part of an answer arrived before it broke. Keep it — usually the
          // useful part — and let the error banner explain the rest.
          updateLast((m) => ({ ...m, streaming: false }));
        } else {
          // Nothing arrived: drop the empty bubble and put the question back
          // in the box so it isn't lost to a network blip.
          setInput(trimmed);
          setMessages(messages);
        }
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [input, sending, messages, cards, currentCard, user, updateLast]
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
            // `dates` deliberately not written: those are the LESSON dates a
            // word appeared on, and a card invented in a chat appeared on
            // none. The column defaults to '[]', and omitting it also leaves
            // an existing card's real dates alone on conflict.
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

  if (!mounted) return null;

  return createPortal(
    <div style={S.wrap}>
      {!activeReflow && (
        <div style={{ ...S.scrim, opacity: entered ? 1 : 0 }} onClick={onClose} />
      )}
      <aside
        ref={panelRef}
        style={{
          ...S.panel,
          ...(activeReflow ? { width: CHAT_PANEL_WIDTH } : null),
          transform: entered ? "translateX(0)" : "translateX(100%)",
        }}
        role="dialog"
        aria-label="Ask the tutor"
      >
        <header style={S.head}>
          <div>
            <div style={S.title}>Ask the tutor</div>
            <div style={S.sub}>
              {currentCard?.f
                ? `Looking at: ${cleanFrenchPrompt(currentCard.f, currentCard.b)}`
                : "Look something up, then add it to your deck."}
            </div>
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
                worth drilling, you'll get cards you can edit and add.
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
                {/* A caret while text is still arriving, so an answer
                    mid-generation doesn't read as one that has finished. */}
                {m.streaming && <span style={S.caret}>▌</span>}
              </div>
              {m.cards?.length > 0 && (
                <div style={S.cardList}>
                  {m.cards.map((c, j) => (
                    <ProposedCard key={j} card={c} added={added} onAdd={addCard} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {error && (
          <div style={S.error}>
            {error}
            {errorCode === BYOK_REQUIRED && onNeedKey && (
              <button style={S.errorAction} onClick={onNeedKey}>
                Connect Claude account
              </button>
            )}
          </div>
        )}

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
  scrim: {
    position: "absolute",
    inset: 0,
    background: "rgba(3,22,50,0.28)",
    pointerEvents: "auto",
    transition: `opacity ${CHAT_ANIM_MS}ms ${CHAT_EASING}`,
  },
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "min(460px, 100vw)",
    pointerEvents: "auto",
    background: T.color.surface,
    boxShadow: "-8px 0 32px rgba(3,22,50,0.16)",
    transition: `transform ${CHAT_ANIM_MS}ms ${CHAT_EASING}`,
    willChange: "transform",
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
    // A bubble that starts empty and fills as the stream arrives still needs
    // to occupy a line, or the caret appears in a zero-height box.
    minHeight: 20,
    padding: "10px 14px",
    background: T.color.surfaceLowest,
    color: T.color.onSurface,
    borderRadius: T.radius.md,
    fontSize: 13.5,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    boxShadow: T.shadow.card,
  },
  caret: { opacity: 0.45, marginLeft: 1 },
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
  // The edit inputs sit at the size and weight of the text they replace, so
  // turning editing on doesn't reflow the chip.
  chipEditFront: {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: T.font.serif,
    fontSize: 14,
    fontWeight: 600,
    color: T.color.onSurface,
    padding: "3px 6px",
    background: T.color.surfaceHigh,
    border: "1px solid rgba(3,22,50,0.14)",
    borderRadius: T.radius.sm,
    outline: "none",
  },
  chipEditBack: {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: T.font.sans,
    fontSize: 12.5,
    color: T.color.onSurface,
    padding: "3px 6px",
    marginTop: 3,
    background: T.color.surfaceHigh,
    border: "1px solid rgba(3,22,50,0.14)",
    borderRadius: T.radius.sm,
    outline: "none",
  },
  chipActions: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    alignItems: "stretch",
  },
  chipEditToggle: {
    padding: "4px 14px",
    background: "transparent",
    color: T.color.onSurfaceVariant,
    border: "none",
    borderRadius: T.radius.md,
    fontSize: 11,
    fontWeight: 500,
    fontFamily: T.font.sans,
    cursor: "pointer",
  },
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
  errorAction: {
    display: "block",
    marginTop: 8,
    padding: "6px 12px",
    background: T.gradient.ink,
    color: T.color.onPrimary,
    border: "none",
    borderRadius: T.radius.md,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: T.font.sans,
    cursor: "pointer",
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
