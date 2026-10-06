import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";

// "Claude's marking", in the Status window: every verdict Claude has given on
// "My answer should have been accepted", for the owner to mark what it should
// have said, and the test made from those marks (api/_lib/answerChecks.js,
// through /api/review-answer). The admin's only.

// The server tests at most this many answers per request (TEST_BATCH there).
const BATCH = 8;

async function call(body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch("/api/review-answer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ answerChecks: body }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `The server answered ${res.status}.`);
  return data;
}

const agrees = (says, verdict) => (says === "accept") === (verdict === "accept");
const VERDICT = { accept: "Accepted", reject: "Refused", uncertain: "Unsure, so not accepted" };
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function StatusAnswers() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [show, setShow] = useState("tomark");
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

  const reviews = data?.reviews || [];
  const marked = reviews.filter((r) => r.owner_says);
  const asked = reviews.filter((r) => r.source !== "kept");
  const askedMarked = asked.filter((r) => r.owner_says);
  const agreed = askedMarked.filter((r) => agrees(r.owner_says, r.verdict)).length;
  const shown = show === "tomark" ? reviews.filter((r) => !r.owner_says) : reviews;
  const byId = useMemo(() => new Map(reviews.map((r) => [r.id, r])), [reviews]);

  const mark = async (r, says) => {
    const next = r.owner_says === says ? null : says;
    setData((d) => ({ ...d, reviews: d.reviews.map((x) => (x.id === r.id ? { ...x, owner_says: next } : x)) }));
    try {
      await call({ action: "mark", id: r.id, says: next });
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  const runTest = async () => {
    const ids = marked.map((r) => r.id);
    const cases = [];
    setTest({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const { results } = await call({ action: "test", ids: ids.slice(i, i + BATCH) });
        cases.push(...results);
        setTest({ done: Math.min(i + BATCH, ids.length), total: ids.length });
      }
      const { summary } = await call({ action: "save-run", cases });
      setTest({ done: ids.length, total: ids.length, cases, summary });
      load();
    } catch (e) {
      setTest({ done: cases.length, total: ids.length, error: e.message });
    }
  };

  if (error && !data) return <div style={S.note}>Couldn't load Claude's verdicts: {error}</div>;
  if (!data) return <div style={S.note}>Loading…</div>;

  const misses = (test?.cases || []).filter((c) => !c.got.every((v) => v === "error" || agrees(c.says, v)));

  return (
    <div data-status-answers>
      <p style={S.body}>
        Each time someone presses “My answer should have been accepted”, Claude decides. Mark what it
        should have said. The answers you mark become a test: Claude is asked about each one again,
        three times, the way the app asks it.
      </p>
      {data.waiting && <div style={S.note}>{data.waiting} Until it's run, Claude's verdicts aren't kept.</div>}
      {error && <div style={S.note}>{error}</div>}

      {!data.waiting && (
        <p style={S.figures}>
          Claude has judged {asked.length} answer{asked.length === 1 ? "" : "s"} since verdicts were kept
          {askedMarked.length > 0 ? `, and agreed with you on ${agreed} of the ${askedMarked.length} you've marked` : ""}.
          {reviews.length > asked.length && ` ${reviews.length - asked.length} accepted answers are from before then.`}
        </p>
      )}

      <div style={S.testBox} data-answers-test>
        {!test && (
          <button style={S.primary} onClick={runTest} disabled={!marked.length}>
            {marked.length ? `Test Claude on the ${marked.length} answer${marked.length === 1 ? "" : "s"} you've marked` : "Mark some answers to test Claude on them"}
          </button>
        )}
        {test && !test.summary && !test.error && <div style={S.figures}>Asking Claude… {test.done} of {test.total}</div>}
        {test?.error && <div style={S.note}>The test stopped: {test.error}</div>}
        {test?.summary && (
          <div data-answers-result>
            <div style={S.result}>
              Claude agreed with you every time on {test.summary.every} of {test.summary.cases}.
              {test.summary.sometimes > 0 && ` Only some of the time on ${test.summary.sometimes}.`}
              {test.summary.never > 0 && ` Never on ${test.summary.never}.`}
            </div>
            {misses.map((c) => {
              const r = byId.get(c.id);
              if (!r) return null;
              const yes = c.got.filter((v) => v !== "error" && agrees(c.says, v)).length;
              const asked = c.got.filter((v) => v !== "error").length;
              return (
                <div key={c.id} style={S.miss}>
                  “{r.typed}” for “{r.expected}”: you say {c.says === "accept" ? "accept" : "refuse"}; Claude agreed {yes} of {asked} times.
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
                {date(run.ran_at)}: agreed every time on {run.passed} of {run.cases}
                {run.version !== data.version ? ` (an earlier version of the question, ${run.version})` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={S.tabs}>
        <button style={show === "tomark" ? S.tabOn : S.tab} onClick={() => setShow("tomark")}>
          To mark ({reviews.length - marked.length})
        </button>
        <button style={show === "all" ? S.tabOn : S.tab} onClick={() => setShow("all")}>
          All ({reviews.length})
        </button>
      </div>

      {shown.length === 0 && <div style={S.note}>{show === "tomark" ? "Nothing waiting to be marked." : "No verdicts yet."}</div>}
      {shown.slice(0, 200).map((r) => (
        <div key={r.id} style={S.row} data-answer-review={r.id}>
          <div style={S.line}>
            {r.direction === "en" ? "Asked for the French of " : "Asked for the English of "}
            <b>{r.direction === "en" ? r.back : r.front}</b>
          </div>
          <div style={S.line}>The card says <b>{r.expected}</b>. Typed: <b>{r.typed}</b></div>
          <div style={S.claude}>
            {r.source === "kept"
              ? "Accepted before verdicts were kept: by Claude, or by the student pressing “Accept anyway”."
              : `Claude: ${VERDICT[r.verdict] || r.verdict}.${r.reasoning ? ` ${r.reasoning}` : ""}`}
            {r.overridden && " The student then pressed “Accept anyway”."}
          </div>
          <div style={S.foot}>
            <span style={S.who}>{r.user_email || "a student"} · {date(r.created_at)}</span>
            <span style={S.marks}>
              <button style={r.owner_says === "accept" ? S.markOn : S.mark} onClick={() => mark(r, "accept")} data-says="accept">
                Should accept
              </button>
              <button style={r.owner_says === "reject" ? S.markOn : S.mark} onClick={() => mark(r, "reject")} data-says="reject">
                Should refuse
              </button>
            </span>
          </div>
        </div>
      ))}
      {shown.length > 200 && <div style={S.note}>And {shown.length - 200} more.</div>}
    </div>
  );
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
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 10,
  },
  testBox: {
    background: T.color.surfaceLow, borderRadius: T.radius.md, padding: "12px", marginBottom: 14,
  },
  result: { fontSize: 13.5, fontWeight: 600, color: T.color.onSurface, marginBottom: 6 },
  miss: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurface, marginTop: 4, overflowWrap: "anywhere" },
  runs: { marginTop: 10, borderTop: "1px solid rgba(3,22,50,0.08)", paddingTop: 8 },
  run: { fontSize: 12, lineHeight: 1.6, color: T.color.onSurfaceVariant },
  primary: { ...button, padding: "9px 14px", background: T.gradient.ink, color: T.color.onPrimary, border: "none" },
  secondary: { ...button, padding: "7px 12px", background: "transparent", color: T.color.onSurface, border: "1px solid rgba(3,22,50,0.15)" },
  tabs: { display: "flex", gap: 6, marginBottom: 8 },
  tab: { ...button, padding: "6px 12px", background: "transparent", color: T.color.onSurfaceVariant, border: "1px solid rgba(3,22,50,0.12)" },
  tabOn: { ...button, padding: "6px 12px", background: T.color.primary, color: T.color.onPrimary, border: `1px solid ${T.color.primary}` },
  row: {
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "10px 12px", marginBottom: 6,
  },
  line: { fontSize: 13, lineHeight: 1.55, color: T.color.onSurface, overflowWrap: "anywhere" },
  claude: { fontSize: 12.5, lineHeight: 1.55, color: T.color.onSurfaceVariant, marginTop: 4, overflowWrap: "anywhere" },
  foot: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 8 },
  who: { fontSize: 11.5, color: T.color.onSurfaceVariant },
  marks: { display: "flex", gap: 6 },
  mark: { ...button, padding: "5px 10px", background: "transparent", color: T.color.onSurface, border: "1px solid rgba(3,22,50,0.15)" },
  markOn: { ...button, padding: "5px 10px", background: T.color.primary, color: T.color.onPrimary, border: `1px solid ${T.color.primary}` },
};
