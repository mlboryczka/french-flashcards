import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";

// "Notes to cards", in the Status window: Claude reading class notes, tested
// against every card the owner has fixed or deleted (api/_lib/notesChecks.js,
// through /api/cahier-sync). The admin's only.

// The server reads at most this many classes per request (TEST_CLASSES there),
// and two requests go at once.
const CLASSES_PER_REQUEST = 4;
const AT_ONCE = 2;

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

const classDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function whatYouDid(c) {
  if (c.kind === "delete") return <>you deleted “{c.original_front}”.</>;
  if (c.kind === "back") return <>you changed the English of “{c.corrected_front}” from “{c.original_back}” to “{c.corrected_back}”.</>;
  return <>you changed “{c.original_front}” to “{c.corrected_front}”.</>;
}

export default function StatusNotes() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null); // { done, total, cases, summary, error }

  const load = useCallback(async () => {
    try {
      setData(await call({ action: "list" }));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const cases = data?.cases || [];
  const testable = cases.filter((c) => c.date);
  const classes = [...new Set(testable.map((c) => c.date))];

  const runTest = async () => {
    const groups = [];
    for (let i = 0; i < classes.length; i += CLASSES_PER_REQUEST) {
      const dates = new Set(classes.slice(i, i + CLASSES_PER_REQUEST));
      groups.push({ size: dates.size, ids: testable.filter((c) => dates.has(c.date)).map((c) => c.id) });
    }
    const results = [];
    let done = 0;
    setTest({ done: 0, total: classes.length });
    try {
      for (let i = 0; i < groups.length; i += AT_ONCE) {
        const now = groups.slice(i, i + AT_ONCE);
        const replies = await Promise.all(now.map((g) => call({ action: "test", ids: g.ids })));
        for (const r of replies) results.push(...r.results);
        done += now.reduce((n, g) => n + g.size, 0);
        setTest({ done, total: classes.length });
      }
      let summary;
      try {
        ({ summary } = await call({ action: "save-run", cases: results }));
      } catch (e) {
        summary = null;
        setError(`The run wasn't kept: ${e.message}`);
      }
      setTest({ done, total: classes.length, cases: results, summary: summary || count(results) });
      load();
    } catch (e) {
      setTest({ done, total: classes.length, error: e.message });
    }
  };

  if (error && !data) return <div style={S.note}>Couldn't load the corrections: {error}</div>;
  if (!data) return <div style={S.note}>Finding your corrections and their classes…</div>;

  const byId = new Map(cases.map((c) => [c.id, c]));
  const back = (test?.cases || []).filter((r) => r.repeated.some((v) => v === true));

  return (
    <div data-status-notes>
      <p style={S.body}>
        Every card you fix or delete is a mistake Claude made reading a class. The test reads each of
        those classes from your notebook again, three times, the way it is read each morning, and checks
        whether the mistake comes back. New corrections join the test by themselves.
      </p>
      {data.waiting && <div style={S.note}>{data.waiting} The test runs, but its results aren't kept until then.</div>}
      {(data.problems || []).map((p, i) => <div key={i} style={S.note}>{p}</div>)}
      {error && data && <div style={S.note}>{error}</div>}

      <p style={S.figures}>
        {cases.length} correction{cases.length === 1 ? "" : "s"} to test, from {classes.length} class{classes.length === 1 ? "" : "es"}.
        {cases.length > testable.length && ` ${cases.length - testable.length} couldn't be matched to a class in your notebook.`}
      </p>

      <div style={S.testBox} data-notes-test>
        {!test && (
          <button style={S.primary} onClick={runTest} disabled={!testable.length}>
            {testable.length ? `Test Claude on your ${testable.length} corrections` : "No corrections to test yet"}
          </button>
        )}
        {test && !test.summary && !test.error && <div style={S.figures}>Reading classes… {test.done} of {test.total}</div>}
        {test?.error && <div style={S.note}>The test stopped: {test.error}</div>}
        {test?.summary && (
          <div data-notes-result>
            <div style={S.result}>
              The mistake didn't come back in any reading on {test.summary.every} of {test.summary.cases}.
              {test.summary.sometimes > 0 && ` It came back some of the time on ${test.summary.sometimes}.`}
              {test.summary.never > 0 && ` Every time on ${test.summary.never}.`}
            </div>
            {back.map((r) => {
              const c = byId.get(r.id);
              if (!c) return null;
              const reads = r.repeated.filter((v) => v !== null).length;
              const times = r.repeated.filter((v) => v === true).length;
              return (
                <div key={r.id} style={S.miss}>
                  Class of {classDay(c.date)}: {whatYouDid(c)} It came back in {times} of {reads} readings.
                </div>
              );
            })}
            <button style={{ ...S.secondary, marginTop: 8 }} onClick={() => setTest(null)}>Done</button>
          </div>
        )}
        {(data.runs || []).length > 0 && (
          <div style={S.runs}>
            {data.runs.slice(0, 5).map((run) => (
              <div key={run.id} style={S.run}>
                {date(run.ran_at)}: no repeat in any reading on {run.passed} of {run.cases}
                {run.version !== data.version ? ` (an earlier version of the question, ${run.version})` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      {cases.filter((c) => !c.date).map((c) => (
        <div key={c.id} style={S.note}>No class found for: {whatYouDid(c)}</div>
      ))}
    </div>
  );
}

// The same count as the server's, for when the run couldn't be kept.
function count(results) {
  let every = 0, sometimes = 0, never = 0;
  for (const r of results) {
    const reads = r.repeated.filter((v) => v !== null);
    const clean = reads.filter((v) => v === false).length;
    if (reads.length && clean === reads.length) every++;
    else if (clean > 0) sometimes++;
    else never++;
  }
  return { cases: results.length, every, sometimes, never };
}

const button = {
  fontFamily: T.font.sans, fontSize: 12.5, fontWeight: 600, cursor: "pointer", borderRadius: T.radius.md,
};
const S = {
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "0 0 10px" },
  figures: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurface, margin: "0 0 10px" },
  note: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 8, overflowWrap: "anywhere",
  },
  testBox: { background: T.color.surfaceLow, borderRadius: T.radius.md, padding: "12px", marginBottom: 14 },
  result: { fontSize: 13.5, fontWeight: 600, color: T.color.onSurface, marginBottom: 6 },
  miss: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurface, marginTop: 4, overflowWrap: "anywhere" },
  runs: { marginTop: 10, borderTop: "1px solid rgba(3,22,50,0.08)", paddingTop: 8 },
  run: { fontSize: 12, lineHeight: 1.6, color: T.color.onSurfaceVariant },
  primary: { ...button, padding: "9px 14px", background: T.gradient.ink, color: T.color.onPrimary, border: "none" },
  secondary: { ...button, padding: "7px 12px", background: "transparent", color: T.color.onSurface, border: "1px solid rgba(3,22,50,0.15)" },
};
