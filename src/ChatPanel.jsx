import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";
import { CAT_UI_TO_DB } from "./lib/cardCategories";
import { keyHeaders, BYOK_REQUIRED, BAD_KEY } from "./lib/anthropicKey";
import { cleanFrenchPrompt } from "./lib/cardText";
import { buildTutorContext, cardPrompt, cardAnswer } from "./lib/deckContext";
import { readThread, writeThread } from "./lib/tutorThreads";

// "Ask the tutor" slide-over. Look a word or phrase up, get an explanation,
// and add the cards Claude proposes straight into the deck.
//
// Design notes:
//   • Right-hand slide-over rather than a centered modal — the card behind
//     stays visible, so you can look something up mid-session without
//     losing your place. Only the ✕ and the TUTOR nav item close it; see the
//     note on that below.
//   • The answer STREAMS. It used to arrive as one blocking JSON response,
//     which meant staring at "Thinking…" for the whole generation.
//   • Proposed cards are never auto-added, and they are EDITABLE before you
//     add them. Claude suggests, you correct, you click. A wrong card in a
//     spaced-repetition deck costs you months of reviews; making the front a
//     text input turns that from a bad review stream into a keystroke.
//   • Adds go straight to Supabase from the client, not through /api/chat.
//     user_cards is RLS-protected (migration_003), so the insert runs as
//     the signed-in user and can only touch their own rows.
//   • A proposal whose front is already in the deck says so, and offers to
//     replace that card's English rather than adding. Add used to upsert on
//     (user_id, front), which quietly overwrote the card you had — its gloss,
//     its category and its source — and then said "Added".
//
// Usage:
//   <ChatPanel open={showChat} onClose={...} user={user} cards={userCards}
//              currentCard={...} thread={{ id, rowId }}
//              onCardAdded={addDeckCard} onCardUpdated={patchDeckCard} />

// Panel width. Exported because FlashcardApp reflows the app by exactly this
// much when the panel is open on a wide screen, so the two must agree.
export const CHAT_PANEL_WIDTH = 460;

// Slide duration and curve come from lib/motion, and FlashcardApp animates the
// page's reflow from the SAME pair — so the panel and the page it displaces
// move as one thing rather than two. A panel appearing instantly against a
// sliding page was what made this feel abrupt.
//
// This file used to re-export them as CHAT_ANIM_MS / CHAT_EASING, and the page
// drove its own reflow through that alias, which made a shared clock look like
// the chat's private business. One clock, one name: PANEL_ANIM_MS and
// PANEL_EASING, imported from lib/motion wherever they are needed.

const CATEGORY_LABEL = {
  vocab: "Vocabulary",
  expr: "Expression",
  gram: "Grammar",
  pron: "Pronunciation",
};

// How far the composer may grow before it scrolls instead.
const COMPOSER_MAX_HEIGHT = 132;

// Smoothing the stream out.
//
// Deltas arrive in uneven lumps — sometimes a fragment, sometimes half a
// sentence — and rendering each one as it lands makes the text jump rather
// than flow. So arrival and display are decoupled: deltas go into a buffer,
// and a rAF loop drains it at a steady rate.
//
// The rate is proportional to how far behind the display is, so a burst is
// caught up on rather than queued, while a trickle still advances every frame.
const REVEAL_MIN_CHARS = 2;   // per frame, so it never visibly stalls
const REVEAL_CATCHUP = 10;    // take a tenth of the backlog each frame

const SUGGESTIONS = [
  "What's the difference between amener and apporter?",
  "How do I say \"I'm looking forward to it\"?",
  "When do I use the subjunctive after bien que?",
];

// Opened on a card, the useful first questions are about THAT card, and which
// ones depends on where the student is with it. None of these is sent on its
// own: every question costs the student's own credit.
function suggestionsFor(card) {
  if (!card?.f) return SUGGESTIONS;
  if (!card.answered) {
    return ["Give me a hint without the answer", "What kind of word am I looking for?"];
  }
  if (card.result === "wrong" || card.result === "wrongArticle" || card.result === "revealed") {
    return [
      card.result === "revealed" ? "Help me remember this one" : "Why was my answer wrong?",
      "Use it in a sentence",
      "What's it easy to confuse with?",
    ];
  }
  return ["Use it in a sentence", "Any related words worth knowing?", "When would I use this?"];
}

// Bold and italics, rendered. The prompt asks for plain prose, but a model
// that slips in **word** anyway should read as emphasis rather than as
// asterisks. Headings lose their hashes. Nothing else is interpreted, and it
// never touches HTML — every piece is a React text node.
const EMPHASIS = /\*\*([^*\n]+?)\*\*|\*([^*\s](?:[^*\n]*?[^*\s])?)\*/g;
const stripHeadings = (text) => String(text || "").replace(/^#{1,6}[ \t]+/gm, "");

function renderInline(text) {
  const src = stripHeadings(text);
  const parts = [];
  const re = new RegExp(EMPHASIS.source, "g");
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    parts.push(m[1] != null
      ? <strong key={m.index}>{m[1]}</strong>
      : <em key={m.index}>{m[2]}</em>);
    last = re.lastIndex;
  }
  if (last < src.length) parts.push(src.slice(last));
  return parts;
}

// The same text with the markup simply removed — for the screen-reader
// announcement, which would otherwise read the asterisks out.
const plainText = (text) => stripHeadings(text).replace(EMPHASIS, (_, b, i) => b ?? i);

const frontKey = (front) => String(front || "").toLowerCase().trim();

// One proposed card. Its own component so each chip owns its edit state —
// hoisting that into ChatPanel would mean a keystroke in one chip re-rendering
// the whole thread.
function ProposedCard({ card, added, deckByFront, onAdd, onReplace }) {
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
  const done = added.get(frontKey(front));
  const isAdded = !!done;
  // Checked against the deck in the browser, not left to the model: it only
  // sees the handful of cards that share a word with the question.
  const existing = isAdded ? null : deckByFront.get(frontKey(front)) || null;
  const sameBack = existing && existing.b.trim() === back.trim();

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
        {existing && (
          <div style={S.chipExisting} data-already-in-deck>
            {sameBack
              ? "Already in your deck"
              : <>Already in your deck as “{existing.b}”</>}
          </div>
        )}
      </div>
      <div style={S.chipActions}>
        {existing ? (
          <button
            style={sameBack ? S.chipAdded : S.chipReplace}
            onClick={() => onReplace(existing, back.trim())}
            disabled={sameBack || !back.trim()}
            title={sameBack ? undefined : `Replace “${existing.b}” with “${back.trim()}” on your card`}
          >
            {sameBack ? "In deck" : "Replace"}
          </button>
        ) : (
          <button
            style={isAdded ? S.chipAdded : S.chipAdd}
            onClick={() => onAdd({ ...card, front: front.trim(), back: back.trim() })}
            disabled={isAdded || !front.trim() || !back.trim()}
          >
            {done === "replaced" ? "Replaced" : isAdded ? "Added" : "Add"}
          </button>
        )}
        {!isAdded && !sameBack && (
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
  // The card on screen, if any, with the study view's live state on it:
  // `answered` (has the answer been shown), and after a typed answer `typed`
  // and `result`. Whether it has been answered decides what the header may
  // show and what the tutor may say.
  currentCard = null,
  // Bumped when the tutor is opened from a card ("Ask the tutor" after a
  // miss). A thread about a different card is put away for a fresh one.
  thread = null,
  // A card was written. Gets the new row, or null when the write returned
  // none and the deck has to be refetched instead.
  onCardAdded,
  // An existing card's back was replaced: (rowId, fields).
  onCardUpdated,
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
  const threadKey = user?.id || "";
  const [messages, setMessages] = useState(() => readThread(threadKey));
  useEffect(() => { writeThread(threadKey, messages); }, [threadKey, messages]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // "byok_required" when the server refused for want of a key, "bad_key" when
  // the key it was given was rejected. Both are fixed in the same dialog, so
  // both offer it: a rejected key is the case where the user most needs a way
  // to replace it, and it used to be the one that named the problem and left
  // them with nowhere to go.
  const [errorCode, setErrorCode] = useState("");
  // Fronts added or replaced in this thread → "added" | "replaced", so the
  // chip can say which.
  const [added, setAdded] = useState(() => new Map());
  // The finished answer, for screen readers. The bubble itself fills in a few
  // characters a frame, which a live region would read out as noise.
  const [announcement, setAnnouncement] = useState("");
  const deckByFront = useMemo(() => {
    const m = new Map();
    for (const c of cards) if (c?.f) m.set(frontKey(c.f), c);
    return m;
  }, [cards]);
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
    stopDrain();
    const t = setTimeout(() => setMounted(false), PANEL_ANIM_MS);
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

  // NOTHING ELSE CLOSES THIS PANEL. Only the ✕ and the TUTOR nav item.
  //
  // It used to close on any click outside it and on Escape. Both fought the
  // point of a panel: you look something up WHILE working a card, so clicking
  // back onto the card — or hitting Escape to clear the answer box — took the
  // answer away mid-read. An outside click meaning "done" is a modal's
  // convention, and this is not a modal.
  //
  // Removing it also retired a whole apparatus that existed only to serve it:
  // the listener had to swallow the click its own mousedown was about to
  // produce, or the dismissing click landed on the card underneath and flipped
  // it, while exempting real controls so "Send feedback" still worked through
  // the swallow. None of that is needed now.

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

  // Text that has arrived but not yet been shown.
  const bufferRef = useRef("");
  const rafRef = useRef(0);

  const drain = useCallback(() => {
    if (rafRef.current) return; // already running
    const step = () => {
      const buf = bufferRef.current;
      if (!buf) {
        rafRef.current = 0;
        return;
      }
      const take = Math.max(REVEAL_MIN_CHARS, Math.ceil(buf.length / REVEAL_CATCHUP));
      bufferRef.current = buf.slice(take);
      updateLast((m) => ({ ...m, content: m.content + buf.slice(0, take) }));
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [updateLast]);

  // Resolve once everything buffered has actually been shown, so the caret
  // isn't taken away with text still to come.
  const drained = useCallback(
    () =>
      new Promise((resolve) => {
        const check = () =>
          bufferRef.current ? requestAnimationFrame(check) : resolve();
        check();
      }),
    []
  );

  const stopDrain = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    bufferRef.current = "";
  }, []);

  useEffect(() => stopDrain, [stopDrain]);
  // Unmounting mid-answer (a view switch) must not leave the request running.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Which thread a request belongs to. An answer aborted by New chat still
  // runs its catch block, which restores the thread it was sent from — and
  // would bring the old conversation straight back over the new one.
  const threadGenRef = useRef(0);

  // Put the thread away and start clean.
  const newThread = useCallback(() => {
    threadGenRef.current += 1;
    abortRef.current?.abort();
    stopDrain();
    setMessages([]);
    setAdded(new Map());
    setAnnouncement("");
    setError("");
    setErrorCode("");
    inputRef.current?.focus();
  }, [stopDrain]);

  // Opened from a card: a thread that was about some other card is finished
  // with. Asking "why was I wrong?" about card 12 should not arrive as turn
  // nine of a conversation about card 3.
  useEffect(() => {
    if (!thread?.id) return;
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.rowId !== thread.rowId) newThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  const send = useCallback(
    async (text) => {
      const trimmed = (text ?? input).trim();
      if (!trimmed || sending) return;

      setError("");
      setErrorCode("");
      setInput("");
      setAnnouncement("");
      // Sent with the button, focus went to it — and the button disables
      // while the answer streams, which drops focus to the page. The next
      // question belongs in the box.
      inputRef.current?.focus();
      const previousQuestion = [...messages].reverse().find((m) => m.role === "user")?.content;
      const nextMessages = [
        ...messages,
        {
          role: "user",
          content: trimmed,
          // What the card showed when this was asked — its prompt, never its
          // answer. Sent back with every later turn so a follow-up still knows
          // what "why?" was about.
          about: currentCard?.f ? cardPrompt(currentCard) : "",
          rowId: currentCard?.row_id ?? null,
        },
      ];
      // The empty assistant bubble is what fills in as tokens arrive, so it
      // goes in before the request rather than after it.
      setMessages([
        ...nextMessages,
        { role: "assistant", content: "", cards: [], streaming: true },
      ]);
      setSending(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const gen = threadGenRef.current;
      bufferRef.current = "";
      let gotText = false;
      let gotDone = false;
      let full = "";

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
            // The prose, plus what grounded each turn: the card a question was
            // asked about, and the fronts and backs an answer proposed — so
            // "change the second card" can be answered. Notes stay client-side.
            messages: nextMessages.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.about ? { about: m.about } : null),
              ...(m.cards?.length
                ? { cards: m.cards.map((c) => ({ front: c.front, back: c.back })) }
                : null),
            })),
            // Rebuilt from scratch every turn against the question just asked,
            // so it never accumulates in the thread.
            context: buildTutorContext({ question: trimmed, previousQuestion, cards, currentCard }),
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
              full += event.delta;
              bufferRef.current += event.delta;
              drain();
            } else if (event.type === "cards") {
              updateLast((m) => ({ ...m, cards: event.cards || [] }));
            } else if (event.type === "error") {
              streamError = event;
            } else if (event.type === "done") {
              gotDone = true;
            }
          }
        }

        await drained();
        updateLast((m) => ({ ...m, streaming: false }));
        if (streamError) {
          // A key Anthropic rejects can only surface once generation has
          // started, so it arrives here rather than as a status — but it
          // carries the same code, and gets the same offer of a way out.
          const err = new Error(streamError.error || "The tutor failed mid-answer.");
          err.code = streamError.code || "";
          throw err;
        }
        // The server ends every complete answer with "done". A stream that
        // stops without it was cut off — the function ran out of time, or the
        // connection dropped — and used to be shown as if it had finished.
        if (!gotDone) throw new Error("The answer was cut off before it finished. Try asking again.");
        if (!gotText) throw new Error("The tutor returned nothing. Try rephrasing.");
        setAnnouncement(plainText(full));
      } catch (e) {
        // Superseded by New chat: that thread is gone, leave the new one alone.
        if (threadGenRef.current !== gen) return;
        // Closing the panel aborts on purpose. The bubble still has to be
        // closed out: this component is not unmounted, so returning early left
        // a half-answer blinking its caret forever and put an empty assistant
        // turn into the next request's history.
        if (e.name === "AbortError") {
          stopDrain();
          if (gotText) updateLast((m) => ({ ...m, streaming: false }));
          else setMessages(messages);
          return;
        }
        stopDrain();
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
    [input, sending, messages, cards, currentCard, user, updateLast, drain, drained, stopDrain]
  );

  const addCard = useCallback(
    async (card) => {
      if (!user) return;
      const key = frontKey(card.front);
      setError("");
      const row = {
        user_id: user.id,
        front: card.front,
        back: card.back,
        category: CAT_UI_TO_DB[card.category] || "V",
        // `dates` deliberately not written: those are the LESSON dates a
        // word appeared on, and a card invented in a chat appeared on none.
        // The column defaults to '[]'.
        source: "tutor-chat",
      };
      try {
        // An INSERT, not an upsert. The chip has already checked the deck for
        // this front, so a card that exists never gets here — it is offered
        // as Replace instead.
        let { data, error: insErr } = await supabase.from("user_cards").insert(row).select();
        // The one card the deck in memory can't show: an archived one, whose
        // row still holds the (user_id, front) slot. Adding it again is how
        // an archived card comes back (see lib/archive.js), so that conflict
        // alone falls through to the upsert, which clears the archived source.
        if (insErr?.code === "23505") {
          ({ data, error: insErr } = await supabase
            .from("user_cards")
            .upsert(row, { onConflict: "user_id,front" })
            .select());
        }
        if (insErr) throw insErr;
        setAdded((prev) => new Map(prev).set(key, "added"));
        onCardAdded?.(Array.isArray(data) ? data[0] || null : null);
      } catch (e) {
        console.error("Add card failed:", e);
        setError(`Couldn't add "${card.front}": ${e.message || "unknown error"}`);
      }
    },
    [user, onCardAdded]
  );

  // Replace the English on a card the student already has. Only the back
  // changes: the front, category, source and FSRS history are that card's
  // own. Goes through the same endpoint the card editor uses, which checks
  // ownership row by row.
  const replaceBack = useCallback(
    async (existing, back) => {
      if (!user || existing?.row_id == null) return;
      setError("");
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch("/api/admin-update-card", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token || ""}`,
          },
          body: JSON.stringify({ row_id: existing.row_id, front: existing.f, back }),
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
          throw new Error(msg);
        }
        setAdded((prev) => new Map(prev).set(frontKey(existing.f), "replaced"));
        onCardUpdated?.(existing.row_id, { b: back });
      } catch (e) {
        console.error("Replace card failed:", e);
        setError(`Couldn't update "${existing.f}": ${e.message || "unknown error"}`);
      }
    },
    [user, onCardUpdated]
  );

  // The box starts at one line and grows with what you type, to a cap. It was
  // a fixed two rows, which left it a good 20px taller than the Send button
  // beside it — the two read as different controls rather than one row.
  const grow = (el) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  };

  // Sending empties the box, which has to shrink back with it.
  useEffect(() => {
    if (!input && inputRef.current) grow(inputRef.current);
  }, [input]);

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter makes a newline. Not while an input method is
    // composing a character — that Enter belongs to the composition.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div style={S.wrap}>
      {/* Dims the app behind an overlay-mode panel. Not a dismissal: see the
          note above — the ✕ and the nav toggle are the only ways out. */}
      {!activeReflow && (
        <div style={{ ...S.scrim, opacity: entered ? 1 : 0 }} />
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
        data-tutor-panel
      >
        <header style={S.head}>
          <div style={S.headMain}>
            <div style={S.title}>Ask the tutor</div>
            {/* The card in view, named rather than described. This is the
                thing that makes the answers specific, so it gets a chip
                instead of a line of grey micro-copy. */}
            {/* What the card is ASKING, as its face shows it. This used to be
                the French front on every card, so on an English-prompt card the
                header showed the answer — and kept showing each next card's
                answer as the session moved on. The answer joins it only once
                the card has shown it. */}
            {currentCard?.f && (
              <div style={S.contextChip} data-tutor-context>
                {cardPrompt(currentCard)}
                {currentCard.answered ? ` — ${cardAnswer(currentCard)}` : ""}
              </div>
            )}
          </div>
          <div style={S.headActions}>
            {messages.length > 0 && (
              <button style={S.newChat} onClick={newThread} data-tutor-new-chat>
                New chat
              </button>
            )}
            <button style={S.close} onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        <div style={S.scroll} ref={scrollRef}>
          {/* marginTop:auto on the content, rather than justify-content on the
              scroller: the latter makes the overflowing top unreachable in
              some browsers. This pushes a short thread down to meet the
              composer and behaves normally once it is long enough to scroll. */}
          <div style={S.threadFoot}>
          {messages.length === 0 && (
            <div style={S.empty}>
              {suggestionsFor(currentCard).map((s) => (
                <button key={s} style={S.suggestion} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} style={m.role === "user" ? S.userRow : S.botRow}>
              <div style={m.role === "user" ? S.userBubble : S.botBubble}>
                {m.streaming && !m.content ? (
                  <span style={S.thinking} aria-label="Thinking">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="tutor-dot"
                        style={{ ...S.thinkingDot, animationDelay: `${i * 0.16}s` }}
                      />
                    ))}
                  </span>
                ) : (
                  <>
                    {m.role === "user" ? m.content : renderInline(m.content)}
                    {/* A caret while text is still arriving, so an answer
                        mid-generation doesn't read as one that has finished. */}
                    {m.streaming && <span style={S.caret}>▌</span>}
                  </>
                )}
              </div>
              {m.cards?.length > 0 && (
                <div style={S.cardList}>
                  {m.cards.map((c, j) => (
                    <ProposedCard
                      key={j}
                      card={c}
                      added={added}
                      deckByFront={deckByFront}
                      onAdd={addCard}
                      onReplace={replaceBack}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          </div>
        </div>
        <div style={S.srOnly} aria-live="polite">{announcement}</div>

        {error && (
          <div style={S.error}>
            {error}
            {(errorCode === BYOK_REQUIRED || errorCode === BAD_KEY) && onNeedKey && (
              <button style={S.errorAction} onClick={onNeedKey}>
                {errorCode === BAD_KEY ? "Update your key" : "Connect Claude account"}
              </button>
            )}
          </div>
        )}

        <div style={S.composer}>
          <textarea
            ref={inputRef}
            style={S.input}
            value={input}
            onChange={(e) => { setInput(e.target.value); grow(e.target); }}
            onKeyDown={onKeyDown}
            placeholder="Ask about a word or phrase…"
            rows={1}
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
    transition: `opacity ${PANEL_ANIM_MS}ms ${PANEL_EASING}`,
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
    transition: `transform ${PANEL_ANIM_MS}ms ${PANEL_EASING}`,
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
  headMain: { minWidth: 0 },
  headActions: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  newChat: {
    background: "transparent",
    border: "1px solid rgba(3,22,50,0.12)",
    borderRadius: T.radius.md,
    padding: "4px 10px",
    fontSize: 11.5,
    fontWeight: 500,
    fontFamily: T.font.sans,
    color: T.color.onSurfaceVariant,
    cursor: "pointer",
  },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  },
  title: { fontFamily: T.font.serif, fontSize: 18, fontWeight: 600, color: T.color.onSurface },
  // The card in view. Set in the serif the app uses for card content
  // everywhere else, which is what identifies it as a card without a label —
  // and a label was worse: "ON  la moitié" read as an on/off state.
  contextChip: {
    display: "block",
    marginTop: 7,
    padding: "3px 11px 4px",
    background: T.color.surfaceHigh,
    borderRadius: T.radius.full,
    fontFamily: T.font.serif,
    fontSize: 13,
    color: T.color.onSurface,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  close: {
    background: "transparent",
    border: "none",
    fontSize: 16,
    cursor: "pointer",
    color: T.color.onSurfaceVariant,
    padding: 4,
    lineHeight: 1,
  },
  scroll: { flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column" },
  // Everything in the thread, pushed to the bottom of the scroller so a short
  // conversation sits just above the composer instead of stranded at the top
  // of a 1000px panel with the answer and the input box a mile apart.
  threadFoot: { marginTop: "auto", display: "flex", flexDirection: "column", gap: 14 },
  empty: { display: "flex", flexDirection: "column", gap: 8 },
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
  // Your own question, set quietly. It used to be a dark ink pill — the app's
  // CTA treatment — which made the thing you already know shout louder than
  // the answer you came for.
  userBubble: {
    maxWidth: "85%",
    padding: "8px 13px",
    background: T.color.surfaceHigh,
    color: T.color.onSurfaceVariant,
    borderRadius: T.radius.md,
    fontSize: 13,
    lineHeight: 1.5,
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
  thinking: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 0" },
  thinkingDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: T.color.onSurfaceVariant,
    display: "inline-block",
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
    // Same box as the Add button above it, so the two stack as a pair rather
    // than a button with a caption drifting beneath it.
    padding: "4px 0",
    width: "100%",
    textAlign: "center",
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
  chipExisting: { fontSize: 11, color: T.color.onSurface, marginTop: 3, lineHeight: 1.4, fontStyle: "italic" },
  // Secondary, not the ink CTA: replacing a card you own is the less common
  // and more consequential of the two.
  chipReplace: {
    flexShrink: 0,
    padding: "7px 14px",
    background: T.color.surfaceLowest,
    color: T.color.onSurface,
    border: "1px solid rgba(3,22,50,0.2)",
    borderRadius: T.radius.md,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: T.font.sans,
    cursor: "pointer",
  },
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
    // stretch, not flex-end: the button takes the textarea's height rather
    // than sitting short beside it, so the two read as one control.
    alignItems: "stretch",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: COMPOSER_MAX_HEIGHT,
    padding: "10px 12px",
    lineHeight: 1.4,
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
    display: "flex",
    alignItems: "center",
    padding: "0 18px",
    flexShrink: 0,
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
    display: "flex",
    alignItems: "center",
    padding: "0 18px",
    flexShrink: 0,
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
