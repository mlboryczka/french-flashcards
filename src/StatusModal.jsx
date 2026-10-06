import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { T } from "./theme";
import { statusText } from "./lib/statusChecks";
import StatusAnswers from "./StatusAnswers";
import StatusStudents from "./StatusStudents";

// "Status": whether the student's cards are being shown the way FSRS and the
// app's own rules say (lib/statusChecks.js, run by useStatusCheck). The
// admin's; opened from the profile menu, whose Status line carries an alert
// while anything here has failed.
//
// Since 2026-10-06 it is where every check of the app lives, one tab each:
// your own cards (above), every student's (StatusStudents.jsx), and Claude's
// marking of disputed answers (StatusAnswers.jsx).

const GROUPS = [
  ["Following FSRS", ["fsrs", "one-a-day", "kept"]],
  ["Following the app's rules", ["not-early", "due-first", "new-order", "first-meetings", "dealt"]],
  ["How well it's working", ["predictions"]],
];

const TABS = [
  ["cards", "Your cards"],
  ["students", "All students"],
  ["answers", "Claude's marking"],
];

const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long" });
const time = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });

export default function StatusModal({ open, onClose, status }) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState("cards");
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setTab("cards");
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const { report, error, running, run } = status;
  const byId = new Map((report?.results || []).map((r) => [r.id, r]));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(statusText(report));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return createPortal(
    <div style={S.scrim} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Status" data-status>
        <div style={S.title}>Status</div>
        <div style={S.tabs} role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              data-status-tab={id}
              style={tab === id ? S.tabOn : S.tab}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "students" && <StatusStudents students={status.students} onChecked={status.setStudents} />}
        {tab === "answers" && <StatusAnswers />}

        {tab === "cards" && (<>
        <p style={S.body}>
          Whether your cards are being shown the way FSRS and the app's rules say.
          {report ? ` Checked ${time(report.checkedAt)}, on your answers from ${day(report.from)} on.` : ""}
        </p>

        {error && <div style={S.note}>The check couldn't run: {error}</div>}
        {!report && !error && <div style={S.note}>{running ? "Checking…" : "Not checked yet."}</div>}

        {report && GROUPS.map(([label, ids]) => (
          <div key={label} style={S.group}>
            <div style={S.groupLabel}>{label}</div>
            {ids.map((id) => byId.get(id)).filter(Boolean).map((r) => (
              <div key={r.id} style={S.row} data-status-check={r.id} data-status-result={r.status}>
                <span style={{ ...S.mark, ...MARK[r.status] }} aria-hidden="true">{GLYPH[r.status]}</span>
                <span style={S.rowText}>
                  <span style={S.rowTitle}>{r.title}</span>
                  <span style={S.rowSummary}>{r.summary}</span>
                  {r.status === "fail" && r.details.map((d, i) => <span key={i} style={S.detail}>{d}</span>)}
                  {r.status === "fail" && r.more > 0 && <span style={S.detail}>And {r.more} more.</span>}
                </span>
              </div>
            ))}
          </div>
        ))}

        {report && !report.ok && (
          <p style={S.fine}>
            Copy the details and paste them to Claude in the project, and it will look into what happened.
          </p>
        )}
        </>)}

        <div style={S.actions}>
          {tab === "cards" && report && (
            <button style={S.secondary} onClick={copy} data-status-copy>
              {copied ? "Copied" : "Copy details"}
            </button>
          )}
          {tab === "cards" && (
            <button style={S.secondary} onClick={run} disabled={running}>
              {running ? "Checking…" : "Check again"}
            </button>
          )}
          <button style={S.done} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const GLYPH = { pass: "✓", fail: "!", wait: "–" };
const MARK = {
  pass: { color: T.color.primary, borderColor: "rgba(3,22,50,0.25)" },
  fail: { color: T.color.onError, background: T.color.error, borderColor: T.color.error },
  wait: { color: T.color.onSurfaceVariant, borderColor: "rgba(3,22,50,0.15)" },
};

const S = {
  scrim: {
    position: "fixed", inset: 0, zIndex: 1200,
    background: "rgba(3,22,50,0.34)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
  },
  modal: {
    background: T.color.surface, borderRadius: T.radius.xl,
    padding: "24px 24px 20px", width: "min(600px, 100%)",
    boxShadow: "0 24px 64px rgba(3,22,50,0.24)",
    fontFamily: T.font.sans, boxSizing: "border-box",
    maxHeight: "90vh", overflowY: "auto",
  },
  title: { fontFamily: T.font.serif, fontSize: 19, fontWeight: 600, color: T.color.onSurface },
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "8px 0 14px" },
  tabs: { display: "flex", flexWrap: "wrap", gap: 4, margin: "12px 0 12px", borderBottom: "1px solid rgba(3,22,50,0.08)" },
  tab: {
    padding: "7px 10px", background: "transparent", border: "none", borderBottom: "2px solid transparent",
    fontFamily: T.font.sans, fontSize: 13, fontWeight: 600, color: T.color.onSurfaceVariant, cursor: "pointer", marginBottom: -1,
  },
  tabOn: {
    padding: "7px 10px", background: "transparent", border: "none", borderBottom: `2px solid ${T.color.primary}`,
    fontFamily: T.font.sans, fontSize: 13, fontWeight: 600, color: T.color.onSurface, cursor: "pointer", marginBottom: -1,
  },
  note: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 12,
  },
  group: { marginTop: 12 },
  groupLabel: {
    fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
    color: T.color.onSurfaceVariant, marginBottom: 6,
  },
  row: {
    display: "flex", alignItems: "flex-start", gap: 10,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 6,
  },
  mark: {
    flexShrink: 0, width: 18, height: 18, marginTop: 1, borderRadius: "50%",
    border: "1.5px solid", boxSizing: "border-box",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 11, fontWeight: 700, lineHeight: 1,
  },
  rowText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  rowTitle: { fontSize: 13, fontWeight: 600, color: T.color.onSurface },
  rowSummary: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurfaceVariant },
  detail: { fontSize: 12, lineHeight: 1.5, color: T.color.onSurface, marginTop: 2, overflowWrap: "anywhere" },
  fine: { fontSize: 11.5, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "12px 0 0" },
  actions: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 16 },
  secondary: {
    padding: "9px 14px", background: "transparent", color: T.color.onSurface,
    border: "1px solid rgba(3,22,50,0.15)", borderRadius: T.radius.md, fontSize: 13, fontWeight: 600,
    fontFamily: T.font.sans, cursor: "pointer",
  },
  done: {
    padding: "9px 18px", background: T.gradient.ink, color: T.color.onPrimary,
    border: "none", borderRadius: T.radius.md, fontSize: 13, fontWeight: 600,
    fontFamily: T.font.sans, cursor: "pointer",
  },
};
