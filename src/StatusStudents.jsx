import { useState } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";

// "All students", in the Status window: the latest status check on every
// student who has answered a card, run each morning on the server and kept
// (api/_lib/statusDaily.js), or now with "Check everyone now". The admin's
// only. `students` comes from useStatusCheck, which also lights the avatar's
// alert when any of them failed.

export async function fetchStudentReports({ run = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`/api/admin-users?view=status${run ? "&run=1" : ""}`, {
    headers: { Authorization: `Bearer ${session?.access_token}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(data?.error || `The server answered ${res.status}.`);
  return data;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });

export default function StatusStudents({ students, onChecked }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const checkNow = async () => {
    setRunning(true);
    setError(null);
    try {
      onChecked(await fetchStudentReports({ run: true }));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const reports = [...(students?.reports || [])].sort((a, b) =>
    Number(a.ok) - Number(b.ok) || String(a.user_email).localeCompare(String(b.user_email)));
  const latest = reports.map((r) => r.checked_at).filter(Boolean).sort().pop();

  return (
    <div data-status-students>
      <p style={S.body}>
        The same checks as Your cards, on every student who has answered a card. They run each morning
        on the server, whether or not anyone opens the app.
        {latest ? ` Last checked ${when(latest)}.` : ""}
      </p>
      {students?.waiting && (
        <div style={S.note}>
          Waiting for the database update (migration_015): until it's run, the morning checks aren't kept.
          “Check everyone now” still works.
        </div>
      )}
      {(error || students?.error) && <div style={S.note}>The check couldn't run: {error || students.error}</div>}
      {!students && !error && <div style={S.note}>Loading…</div>}
      {students && !reports.length && !students.waiting && <div style={S.note}>No reports yet.</div>}

      {reports.map((r) => {
        const fails = (r.report?.results || []).filter((x) => x.status === "fail");
        const expanded = open === r.user_id;
        return (
          <div key={r.user_id} style={S.row} data-student-report={r.user_email} data-student-ok={r.ok ? "yes" : "no"}>
            <span style={{ ...S.mark, ...(r.ok ? S.markPass : S.markFail) }} aria-hidden="true">{r.ok ? "✓" : "!"}</span>
            <span style={S.rowText}>
              <span style={S.rowTitle}>{r.user_email || "a student"}</span>
              <span style={S.rowSummary}>
                {r.error
                  ? `The check couldn't run: ${r.error}`
                  : r.ok
                    ? `Every check passed, on ${r.answers} answer${r.answers === 1 ? "" : "s"}.`
                    : `${fails.length} check${fails.length === 1 ? "" : "s"} failed, on ${r.answers} answers.`}
              </span>
              {fails.length > 0 && (
                <button style={S.more} onClick={() => setOpen(expanded ? null : r.user_id)}>
                  {expanded ? "Hide details" : "Show details"}
                </button>
              )}
              {expanded && fails.map((f) => (
                <span key={f.id} style={S.fail}>
                  <b>{f.title}.</b> {f.summary}
                  {(f.details || []).slice(0, 3).map((d, i) => <span key={i} style={S.detail}>{d}</span>)}
                </span>
              ))}
            </span>
          </div>
        );
      })}

      <div style={S.actions}>
        <button style={S.secondary} onClick={checkNow} disabled={running}>
          {running ? "Checking everyone…" : "Check everyone now"}
        </button>
      </div>
    </div>
  );
}

const S = {
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "0 0 12px" },
  note: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 10,
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
  markPass: { color: T.color.primary, borderColor: "rgba(3,22,50,0.25)" },
  markFail: { color: T.color.onError, background: T.color.error, borderColor: T.color.error },
  rowText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  rowTitle: { fontSize: 13, fontWeight: 600, color: T.color.onSurface, overflowWrap: "anywhere" },
  rowSummary: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurfaceVariant },
  more: {
    alignSelf: "flex-start", padding: 0, marginTop: 2, background: "none", border: "none",
    fontFamily: T.font.sans, fontSize: 12, fontWeight: 600, color: T.color.primary, cursor: "pointer", textDecoration: "underline",
  },
  fail: { display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurface, marginTop: 6 },
  detail: { fontSize: 12, lineHeight: 1.5, color: T.color.onSurface, overflowWrap: "anywhere" },
  actions: { display: "flex", justifyContent: "flex-start", marginTop: 10 },
  secondary: {
    padding: "8px 13px", background: "transparent", color: T.color.onSurface,
    border: "1px solid rgba(3,22,50,0.15)", borderRadius: T.radius.md, fontSize: 12.5, fontWeight: 600,
    fontFamily: T.font.sans, cursor: "pointer",
  },
};
