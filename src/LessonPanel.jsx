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
import { createPortal } from "react-dom";
import { T } from "./theme";
import { PANEL_ANIM_MS, PANEL_EASING } from "./lib/motion";

export const LESSON_PANEL_WIDTH = 460;

export default function LessonPanel({ open, onClose, lesson, reflow = false }) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const [tab, setTab] = useState(0);
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

  // NOTHING ELSE CLOSES THIS PANEL. Only the ✕ and the "Lesson notes" toggle.
  //
  // The notes are meant to be up WHILE you work the card — that is the whole
  // point of a panel rather than a modal. Every ambient dismissal fights that:
  // an outside click closed it the moment you clicked into the answer box, and
  // Escape closed it on the reflex of clearing a field mid-answer. Both read as
  // the panel refusing to stay open.
  //
  // The tutor works the same way for the same reason — you ask it about the
  // card in front of you, so clicking back onto that card must not take the
  // answer away. The feedback sheet is the one that still dismisses on an
  // outside click: that one you open, fill in, and send.


  // Which section is on screen. Reset when the panel closes so reopening
  // always lands on the lesson's first section rather than wherever you were
  // three cards ago.
  useEffect(() => { if (!open) setTab(0); }, [open]);

  if (!mounted || !lesson) return null;
  const sections = lesson.notes || [];
  const active = sections[Math.min(tab, Math.max(0, sections.length - 1))];

  // Rendered into <body>, the way the tutor and the feedback sheet already
  // are. This one was rendered where it sits in the tree, which is inside the
  // app shell — and the shell sets `overflow: hidden`.
  //
  // It escaped that clipping only because a fixed-position element ignores an
  // ancestor's overflow, and that stops being true the moment any ancestor
  // gets a transform, filter, perspective, backdrop-filter or will-change.
  // Adding a shadow or a zoom to the shell one day would clip or vanish this
  // panel, and nothing about the change would point here. Three panels, one
  // mechanism, no trap.
  return createPortal(
    <div style={S.wrap} data-lesson-panel>
      {/* Dims the app behind an overlay-mode panel. Not a dismissal: see the
          note above — the ✕ and the toggle are the only ways out. */}
      {!activeReflow && (
        <div style={{ ...S.scrim, opacity: entered ? 1 : 0 }} />
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

        {sections.length > 1 && (
          <div style={S.tabs} role="tablist">
            {sections.map((sec, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === tab}
                style={i === tab ? { ...S.tab, ...S.tabOn } : S.tab}
                onClick={() => setTab(i)}
              >
                {sec.tab || sec.h}
              </button>
            ))}
          </div>
        )}

        <div style={S.body} key={tab}>
          {active && (active.blocks || []).map((b, i) => (
            <Block key={i} b={b} prev={(active.blocks || [])[i - 1]} first={i === 0} />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Text ────────────────────────────────────────────────────────────────
//
// French sets a space before ! ? ; : and inside « ». It has to be a NARROW
// NO-BREAK space (U+202F), not a plain one, or the punctuation wraps to the
// next line on its own at panel width. Applied at display time, so the lesson
// data stays written with ordinary spaces.
const NNBSP = " ";
const frenchSpace = (s) =>
  String(s).replace(/\s+([!?;:»])/g, NNBSP + "$1").replace(/«\s+/g, "«" + NNBSP);

// **bold** and *italic*, so lesson prose can emphasise without the data file
// carrying markup and the panel reaching for dangerouslySetInnerHTML.
function rich(text) {
  return frenchSpace(text)
    .split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((part, i) => {
      if (part.startsWith("**")) return <strong key={i} style={S.strong}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
      return part;
    });
}

// ── Blocks ──────────────────────────────────────────────────────────────
//
// A section is an ordered list of these, because the source material
// interleaves: a rule, its examples, then a caveat about those examples.
//
// Two rules about separators, both from review:
//   - A subheading draws a divider above it, EXCEPT as the first block of a
//     section (nothing to separate from) or straight after a table, which
//     already closes with a hairline. Two rules stacked 20px apart read as a
//     mistake, because they are one.
//   - Every block of French specimens carries a label. An unlabelled specimen
//     reads as a pull-quote and the reader has to guess what they are seeing.
function Block({ b, prev, first }) {
  if (b.t === "lead") return <p style={S.lead}>{rich(b.v)}</p>;

  if (b.t === "note") return <p style={S.note}>{rich(b.v)}</p>;

  if (b.t === "sub") {
    const divide = !first && prev?.t !== "table" && prev?.t !== "pairs";
    return <div style={divide ? { ...S.subH, ...S.subHDivide } : S.subH}>{b.v}</div>;
  }

  if (b.t === "list") {
    return (
      <ul style={S.list}>
        {b.v.map((item, i) => {
          const text = typeof item === "string" ? item : item.v;
          const ex = typeof item === "string" ? null : item.ex;
          return (
            <li key={i} style={S.li}>
              {rich(text)}
              {ex && (
                <span style={S.liEx}>
                  <span style={S.egLabel}>Example</span>({frenchSpace(ex)})
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  if (b.t === "forms") {
    return (
      <>
        {b.label && <div style={S.formsLabel}>{b.label}</div>}
        <p style={S.forms}>
          {b.v.map((f, i) => (
            <span key={i}>
              {i > 0 && <span style={S.formsDot}>·</span>}
              {frenchSpace(f)}
            </span>
          ))}
        </p>
      </>
    );
  }

  if (b.t === "pairs") {
    return (
      <div style={S.tableWrap}>
        <table style={S.table}>
          {b.head && (
            <thead>
              <tr>{b.head.map((h, i) => <th key={i} style={S.th}>{h}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {b.v.map(([a, c], i) => (
              <tr key={i}>
                <td style={S.tdKey}>{frenchSpace(a)}</td>
                <td style={S.td}>{frenchSpace(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (b.t === "table") {
    const bold = b.bold == null ? 0 : b.bold;
    const cell = b.dense ? S.tdDense : null;
    return (
      <div style={S.tableWrap}>
        {b.caption && <div style={S.caption}>{b.caption}</div>}
        <table style={b.dense ? { ...S.table, ...S.tableDense } : S.table}>
          <thead>
            <tr>{b.cols.map((c, i) => <th key={i} style={S.th}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>
                {row.map((c, i) => (
                  <td key={i} style={{ ...(i === bold ? S.tdKey : S.td), ...cell }}>
                    {frenchSpace(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
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

  // One tab per section of the lesson. Section 3 alone is taller than the
  // window, so on a single scroll the pronoun rules — the ones people are
  // actually stuck on — sit below the fold every time the panel opens.
  tabs: { display: "flex", gap: 2, padding: "0 12px", flexShrink: 0, borderBottom: "1px solid rgba(3,22,50,0.06)", overflowX: "auto", scrollbarWidth: "none" },
  tab: { appearance: "none", border: "none", background: "transparent", cursor: "pointer", fontFamily: T.font.sans, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.color.onSurfaceVariant, padding: "11px 9px 9px", whiteSpace: "nowrap", borderBottom: "2px solid transparent", marginBottom: -1 },
  tabOn: { color: T.color.secondary, borderBottom: `2px solid ${T.color.secondary}` },

  body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 20px 34px" },

  // The one sentence saying what this section is for. Louder than a note:
  // several sections were tables with nothing telling you what to do.
  lead: { fontSize: 13.5, lineHeight: 1.5, color: T.color.onSurface, fontWeight: 500, margin: "0 0 16px" },
  note: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurfaceVariant, margin: "0 0 12px" },
  strong: { color: T.color.onSurface, fontWeight: 700 },

  subH: { fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.color.onSurface, margin: "0 0 9px" },
  subHDivide: { marginTop: 24, paddingTop: 14, borderTop: "1px solid rgba(3,22,50,0.08)" },

  list: { margin: "0 0 16px", paddingLeft: 16 },
  li: { fontSize: 12.5, lineHeight: 1.55, color: T.color.onSurface, marginBottom: 7 },
  // An example carried by the bullet it proves, parenthesised so it reads as
  // an aside to the rule rather than as another rule.
  liEx: { display: "block", marginTop: 6, fontSize: 12.5, fontWeight: 400, color: T.color.onSurfaceVariant },
  egLabel: { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.color.onSurfaceVariant, marginRight: 7 },

  formsLabel: { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.color.onSurfaceVariant, margin: "14px 0 6px" },
  forms: { fontSize: 13, lineHeight: 1.7, color: T.color.onSurface, fontWeight: 600, margin: "0 0 16px", paddingLeft: 11, borderLeft: "2px solid rgba(156,66,52,0.34)" },
  formsDot: { color: T.color.onSurfaceVariant, fontWeight: 400, padding: "0 3px" },

  // A table is its own object: space around it and a hairline closing it off,
  // so it does not bleed into the block below. The paradigms are the widest
  // thing in the panel, so they scroll inside this rather than push the panel.
  tableWrap: { overflowX: "auto", margin: "16px 0 18px", paddingBottom: 4, borderBottom: "1px solid rgba(3,22,50,0.08)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  tableDense: { fontSize: 12 },
  // The caption names the table, the headers name its columns. They sit one
  // above the other, so they must not look like the same thing.
  caption: { fontSize: 11, fontWeight: 700, letterSpacing: "0.01em", color: T.color.onSurface, paddingBottom: 8 },
  th: { fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: T.color.onSurfaceVariant, textAlign: "left", padding: "0 10px 6px 0", borderBottom: "1px solid rgba(3,22,50,0.08)", whiteSpace: "nowrap" },
  // The French is the thing you came to look at, so it carries the weight.
  tdKey: { padding: "6px 10px 6px 0", color: T.color.onSurface, fontWeight: 600, whiteSpace: "nowrap", verticalAlign: "top" },
  td: { padding: "6px 10px 6px 0", color: T.color.onSurfaceVariant, verticalAlign: "top" },
  tdDense: { paddingRight: 8 },
};
