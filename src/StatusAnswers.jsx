import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { T } from "./theme";

// "Claude's marking", in the Status window: how well Claude decides "My answer
// should have been accepted" (api/_lib/answerChecks.js, through
// /api/review-answer). Nothing here needs the owner: their own disputes are
// judged by what they already did (asking, and "Accept anyway"), and the
// server re-asks Claude about them on its own each week and whenever the
// question changes. Another student's dispute can be marked, if the owner ever
// wants to; nothing waits on it. The admin's only.

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
// As the server judges a case (api/_lib/evalRuns.js): a failed ask counts for
// nothing, and a case with no usable answer wasn't tried.
const asked = (c) => (c.got || []).filter((v) => v !== "error");
const tried = (c) => asked(c).length > 0;
const passes = (c) => tried(c) && asked(c).every((v) => agrees(c.says, v));
const VERDICT = { accept: "accepted it", reject: "refused it", uncertain: "wasn't sure, so it wasn't accepted" };
const FROM = {
  "accept-anyway": "you pressed “Accept anyway”",
  kept: "it was accepted before Claude's decisions were kept",
  asked: "you asked for it to be accepted",
  left: "you moved on without “Accept anyway”",
  marked: "your mark",
};
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function StatusAnswers({ regressions = [] }) {
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

  const mark = async (r, says) => {
    const next = r.owner_says === says ? null : says;
    setData((d) => ({ ...d, reviews: d.reviews.map((x) => (x.id === r.id ? { ...x, owner_says: next } : x)) }));
    try {
      await call({ action: "mark", id: r.id, says: next });
      load();
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  if (error && !data) return <div style={S.note}>Couldn't load Claude's decisions: {error}</div>;
  if (!data) return <div style={S.note}>Loading…</div>;

  const reviews = data.reviews || [];
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const last = (data.runs || [])[0] || null;
  const wrong = (last?.results || []).filter((c) => tried(c) && !passes(c));
  const checkable = reviews.some((r) => r.call);
  const others = reviews.filter((r) => !r.call || r.call.from === "marked").length;

  return (
    <div data-status-answers>
      <p style={S.body}>
        When an answer is marked wrong and someone presses “My answer should have been accepted”, Claude
        decides. On your own answers, what you did next already says whether it decided right, so you're
        never asked. Each week, and the morning after the way Claude is asked changes, the app asks Claude
        about your answers again, three times each, and checks it still decides the way you did.
      </p>
      {data.waiting && <div style={S.note}>These checks start once the database update has been run.</div>}
      {error && <div style={S.note}>{error}</div>}

      {regressions.length > 0 && (
        <div style={S.alert} data-answers-regressions>
          {regressions.map((t, i) => <div key={i}>{t}</div>)}
        </div>
      )}

      <div style={S.box} data-answers-last>
        {!last && !data.waiting && (
          <div style={S.figures}>
            {checkable
              ? "Not checked yet. The first check runs by itself tomorrow morning."
              : "Nothing to check yet: none of your own disputed answers have been kept so far."}
          </div>
        )}
        {last && (
          <>
            <div style={S.result}>
              Checked {date(last.ran_at)}: Claude decided the way you did, every time, on {last.passed} of {last.cases} answers.
            </div>
            {wrong.map((c) => {
              const r = byId.get(c.id);
              if (!r) return null;
              const yes = asked(c).filter((v) => agrees(c.says, v)).length;
              return (
                <div key={c.id} style={S.miss}>
                  “{r.typed}” for “{r.expected}”: you'd {c.says === "accept" ? "accept it" : "refuse it"}; Claude agreed {yes} of {asked(c).length} times.
                </div>
              );
            })}
            {last.summary?.untried > 0 && (
              <div style={S.miss}>{last.summary.untried} couldn't be asked this time, so they aren't counted.</div>
            )}
            {last.summary?.left_out > 0 && (
              <div style={S.miss}>{last.summary.left_out} older answers weren't asked about, to keep the check short.</div>
            )}
          </>
        )}
        {(data.runs || []).length > 1 && (
          <div style={S.runs}>
            {data.runs.slice(1, 5).map((run) => (
              <div key={run.id} style={S.run}>
                {date(run.ran_at)}: every time on {run.passed} of {run.cases}
                {run.version !== data.version ? " (Claude was asked differently then)" : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={S.heading}>Claude's decisions</div>
      {reviews.length === 0 && <div style={S.note}>None yet.</div>}
      {others > 0 && (
        <p style={S.body}>
          Another student's answer is only checked if you mark it, with the buttons under it. You don't have to.
        </p>
      )}
      {reviews.slice(0, 150).map((r) => (
        <div key={r.id} style={S.row} data-answer-review={r.id}>
          <div style={S.line}>
            {r.direction === "en" ? "Asked for the French of " : "Asked for the English of "}
            <b>{r.direction === "en" ? r.back : r.front}</b>. The card says <b>{r.expected}</b>; typed <b>{r.typed}</b>.
          </div>
          <div style={S.claude}>
            {r.source === "kept" ? "Accepted." : `Claude ${VERDICT[r.verdict] || r.verdict}.${r.reasoning ? ` ${r.reasoning}` : ""}`}
            {r.call ? ` Judged by: ${FROM[r.call.from]}.` : ""}
          </div>
          <div style={S.foot}>
            <span style={S.who}>{r.user_email || "a student"} · {date(r.created_at)}</span>
            {(!r.call || r.call.from === "marked") && (
              <span style={S.marks}>
                <button style={r.owner_says === "accept" ? S.markOn : S.mark} onClick={() => mark(r, "accept")} data-says="accept">
                  Should accept
                </button>
                <button style={r.owner_says === "reject" ? S.markOn : S.mark} onClick={() => mark(r, "reject")} data-says="reject">
                  Should refuse
                </button>
              </span>
            )}
          </div>
        </div>
      ))}
      {reviews.length > 150 && <div style={S.note}>And {reviews.length - 150} older ones.</div>}
    </div>
  );
}

const button = {
  fontFamily: T.font.sans, fontSize: 12.5, fontWeight: 600, cursor: "pointer", borderRadius: T.radius.md,
};
const S = {
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "0 0 10px" },
  heading: { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: T.color.onSurfaceVariant, margin: "4px 0 6px" },
  figures: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurface },
  note: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 10,
  },
  alert: {
    fontSize: 13, lineHeight: 1.55, color: T.color.onErrorContainer, background: T.color.errorContainer,
    borderRadius: T.radius.md, padding: "9px 12px", marginBottom: 10,
  },
  box: { background: T.color.surfaceLow, borderRadius: T.radius.md, padding: "12px", marginBottom: 14 },
  result: { fontSize: 13.5, fontWeight: 600, color: T.color.onSurface, marginBottom: 6 },
  miss: { fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurface, marginTop: 4, overflowWrap: "anywhere" },
  runs: { marginTop: 10, borderTop: "1px solid rgba(3,22,50,0.08)", paddingTop: 8 },
  run: { fontSize: 12, lineHeight: 1.6, color: T.color.onSurfaceVariant },
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
