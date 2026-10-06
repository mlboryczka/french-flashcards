import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";

// "Notes to cards", in the Status window: Claude reading class notes, tested
// against every card the owner has fixed or deleted (api/_lib/notesChecks.js).
// Nothing here needs the owner: their corrections are the right answers, and
// the server reads those classes again on its own each week and whenever the
// way a class becomes cards changes. This shows what the last run found. The
// admin's only.

async function call(body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch("/api/cahier-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ notesChecks: body }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `The server answered ${res.status}.`);
  return data;
}

const passes = (c) => {
  const reads = (c.repeated || []).filter((v) => v !== null);
  return reads.length > 0 && reads.every((v) => v === false);
};
const classDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function whatYouDid(c) {
  if (c.kind === "delete") return <>you deleted “{c.original_front}”</>;
  if (c.kind === "back") return <>you changed the English of “{c.corrected_front}” from “{c.original_back}” to “{c.corrected_back}”</>;
  return <>you changed “{c.original_front}” to “{c.corrected_front}”</>;
}

export default function StatusNotes({ regressions = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await call({ action: "list" }));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <div style={S.note}>Couldn't load the corrections: {error}</div>;
  if (!data) return <div style={S.note}>Finding your corrections and their classes…</div>;

  const cases = data.cases || [];
  const matched = cases.filter((c) => c.date).length;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const last = (data.runs || [])[0] || null;
  const still = (last?.results || []).filter((r) => !passes(r) && r.repeated.some((v) => v === true));

  return (
    <div data-status-notes>
      <p style={S.body}>
        Every card you fix or delete is a mistake Claude made reading a class. Each week, and the morning after
        the way your cahier is read changes, the app reads those classes again, three times each, and checks
        whether Claude makes the same mistakes. Your corrections are the right answers, so you're never asked
        anything, and nothing in your deck changes. New corrections join by themselves.
      </p>
      {data.waiting && <div style={S.note}>These checks start once the database update has been run.</div>}
      {(data.problems || []).map((p, i) => <div key={i} style={S.note}>{p}</div>)}

      {regressions.length > 0 && (
        <div style={S.alert} data-notes-regressions>
          {regressions.map((t, i) => <div key={i}>{t}</div>)}
        </div>
      )}

      <div style={S.box} data-notes-last>
        {!last && !data.waiting && (
          <div style={S.figures}>
            {matched
              ? `Not checked yet: ${matched} correction${matched === 1 ? "" : "s"} waiting. The first check runs by itself tomorrow morning.`
              : "Nothing to check yet: none of your corrections could be matched to a class in your cahier."}
          </div>
        )}
        {last && (
          <>
            <div style={S.result}>
              Checked {date(last.ran_at)}: of {last.cases} corrections, Claude didn't repeat the mistake on {last.passed}.
            </div>
            {still.length > 0 && <div style={S.sub}>It still makes these mistakes:</div>}
            {still.map((r) => {
              const c = byId.get(r.id);
              if (!c) return null;
              const reads = r.repeated.filter((v) => v !== null).length;
              const times = r.repeated.filter((v) => v === true).length;
              return (
                <div key={r.id} style={S.miss}>
                  Class of {classDay(c.date)}: {whatYouDid(c)}, and it did it again in {times} of {reads} readings.
                </div>
              );
            })}
            {last.summary?.untried > 0 && <div style={S.miss}>{last.summary.untried} couldn't be read this time, so they aren't counted.</div>}
          </>
        )}
        {(data.runs || []).length > 1 && (
          <div style={S.runs}>
            {data.runs.slice(1, 5).map((run) => (
              <div key={run.id} style={S.run}>
                {date(run.ran_at)}: no repeat on {run.passed} of {run.cases}
                {run.version !== data.version ? " (your cahier was read differently then)" : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      {cases.filter((c) => !c.date).map((c) => (
        <div key={c.id} style={S.note}>Not in the check, because its class isn't in your cahier: {whatYouDid(c)}.</div>
      ))}
    </div>
  );
}

const S = {
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "0 0 10px" },
  figures: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurface },
  note: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 8, overflowWrap: "anywhere",
  },
  alert: {
    fontSize: 13, lineHeight: 1.55, color: T.color.onErrorContainer, background: T.color.errorContainer,
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 10,
  },
  box: { background: T.color.surfaceLow, borderRadius: T.radius.md, padding: "12px", marginBottom: 14 },
  result: { fontSize: 13.5, fontWeight: 600, color: T.color.onSurface, marginBottom: 6 },
  sub: { fontSize: 12.5, color: T.color.onSurfaceVariant, marginTop: 6 },
  miss: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurface, marginTop: 4, overflowWrap: "anywhere" },
  runs: { marginTop: 10, borderTop: "1px solid rgba(3,22,50,0.08)", paddingTop: 8 },
  run: { fontSize: 12, lineHeight: 1.6, color: T.color.onSurfaceVariant },
};
