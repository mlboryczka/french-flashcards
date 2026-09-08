// The lesson itself, beside the cards.
//
// Same slide-over mechanics as ChatPanel — mounted/entered so it animates out
// as well as in, a two-frame delay before the transform so the browser has a
// start position to animate from, reflow on wide screens and an overlay with a
// scrim on narrow ones. Those were worked out once for the tutor; this follows
// them rather than inventing a third set of timings.
//
// What it holds is deliberately not the lesson document. You open this because
// a card in front of you doesn't make sense, so it has to answer that in a
// glance: paradigms as tables, contrasts as two columns, and the two rules
// people actually get wrong called out on their own. The prose that a teaching
// handout needs is exactly what gets in the way here.

import { useEffect, useRef, useState } from "react";
import { T } from "./theme";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";

export const LESSON_PANEL_WIDTH = 460;

export default function LessonPanel({ open, onClose, lesson, reflow = false }) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef(null);

  // Freeze the layout mode while the panel is on screen: `reflow` flips false
  // the instant you close, which would drop a scrim over the app for the
  // length of the exit animation.
  const reflowRef = useRef(reflow);
  if (open) reflowRef.current = reflow;
  const activeReflow = mounted ? reflowRef.current : reflow;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setEntered(false);
    const t = setTimeout(() => setMounted(false), PANEL_ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);

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

  // In reflow mode there is no scrim to catch an outside click, so this is the
  // only thing that closes it. The toggle opts out via data-lesson-toggle:
  // otherwise this would close on mousedown and the button's own click would
  // reopen it immediately.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (e.target.closest?.("[data-lesson-toggle]")) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!mounted || !lesson) return null;
  const sections = lesson.notes || [];

  return (
    <div style={S.wrap} data-lesson-panel>
      {!activeReflow && (
        <div style={{ ...S.scrim, opacity: entered ? 1 : 0 }} onClick={onClose} />
      )}
      <div
        ref={panelRef}
        style={{ ...S.panel, transform: entered ? "translateX(0)" : "translateX(100%)" }}
      >
        <div style={S.head}>
          <div>
            <div style={S.title}>{lesson.title}</div>
            <div style={S.sub}>{lesson.source}</div>
          </div>
          <button style={S.close} onClick={onClose} title="Close">✕</button>
        </div>

        <div style={S.body}>
          {sections.map((sec, i) => (
            <section key={i} style={S.section}>
              <h3 style={S.h}>{sec.h}</h3>
              {sec.note && <p style={S.note}>{sec.note}</p>}

              {sec.table && (
                <table style={S.table}>
                  <thead>
                    <tr>
                      {sec.table.cols.map((c, j) => (
                        <th key={j} style={{ ...S.th, textAlign: j === 0 ? "left" : "left" }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sec.table.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} style={c === 0 ? S.tdKey : S.td}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {sec.pairs && (
                <table style={S.table}>
                  <tbody>
                    {sec.pairs.map(([a, b], r) => (
                      <tr key={r}>
                        <td style={S.tdKey}>{a}</td>
                        <td style={S.td}>{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {sec.lines && (
                <ul style={S.list}>
                  {sec.lines.map((l, r) => <li key={r} style={S.li}>{l}</li>)}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const S = {
  wrap: { position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" },
  scrim: { position: "absolute", inset: 0, background: "rgba(3,22,50,0.28)", pointerEvents: "auto", transition: `opacity ${PANEL_ANIM_MS}ms ${PANEL_EASING}` },
  panel: {
    position: "absolute", top: 0, right: 0, bottom: 0,
    width: `min(${LESSON_PANEL_WIDTH}px, 100vw)`, pointerEvents: "auto",
    background: T.color.surface, boxShadow: "-8px 0 32px rgba(3,22,50,0.16)",
    transition: `transform ${PANEL_ANIM_MS}ms ${PANEL_EASING}`, willChange: "transform",
    display: "flex", flexDirection: "column", fontFamily: T.font.sans,
  },
  head: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "20px 20px 14px", borderBottom: "1px solid rgba(3,22,50,0.06)", flexShrink: 0 },
  title: { fontFamily: T.font.serif, fontSize: 18, fontWeight: 600, color: T.color.onSurface },
  sub: { fontSize: 11, color: T.color.onSurfaceVariant, marginTop: 3 },
  close: { background: "transparent", border: "none", fontSize: 14, cursor: "pointer", color: T.color.onSurfaceVariant, padding: 4, lineHeight: 1 },
  body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 20px 32px" },
  section: { marginTop: 22 },
  h: { fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.color.secondary, margin: "0 0 8px" },
  note: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurfaceVariant, margin: "0 0 10px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.color.onSurfaceVariant, padding: "0 10px 6px 0", borderBottom: "1px solid rgba(3,22,50,0.08)" },
  // The French is the thing you came to look at, so it carries the weight.
  tdKey: { padding: "6px 10px 6px 0", color: T.color.onSurface, fontWeight: 600, whiteSpace: "nowrap", verticalAlign: "top" },
  td: { padding: "6px 10px 6px 0", color: T.color.onSurfaceVariant, verticalAlign: "top" },
  list: { margin: 0, paddingLeft: 16 },
  li: { fontSize: 12.5, lineHeight: 1.55, color: T.color.onSurface, marginBottom: 7 },
};
