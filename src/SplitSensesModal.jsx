import { useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabase";
import { T } from "./theme";
import { findMultiSenseCards } from "./lib/multiSense";

// "Fix multi-sense cards".
//
// Some cards in the deck are secretly two cards: "les frais" (the costs) and
// "frais" (fresh) share a spelling, so the parser produced one card backed by
// "the costs; the expenses; fresh". There is no right answer to type, so the
// card can't be studied and FSRS has nothing to schedule on.
//
// Three steps, deliberately: scan the whole deck locally (free), ask Claude
// about the shortlist only (batched), then apply what you approve. Nothing
// touches the deck until you press the last button.

const BATCH = 15;

export function SplitSensesModal({ deck, onClose, onApplied }) {
  const candidates = useMemo(() => findMultiSenseCards(deck), [deck]);

  const [phase, setPhase] = useState("scanned"); // scanned | auditing | review | applying | done
  const [done, setDone] = useState(0);
  const [proposals, setProposals] = useState([]);
  const [rejected, setRejected] = useState(() => new Set());
  const [error, setError] = useState("");
  const [summary, setSummary] = useState(null);

  const audit = useCallback(async () => {
    setPhase("auditing");
    setError("");
    setDone(0);
    const found = [];
    try {
      const { data: { session } } = await supabase.auth.getSession();
      for (let i = 0; i < candidates.length; i += BATCH) {
        const slice = candidates.slice(i, i + BATCH);
        const res = await fetch("/api/split-senses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            cards: slice.map((c) => ({
              row_id: String(c.row_id),
              front: c.f,
              back: c.b,
              category: c.cat,
            })),
          }),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        for (const r of data?.results || []) {
          if (r.action === "split") found.push(r);
        }
        setDone(Math.min(i + BATCH, candidates.length));
        setProposals([...found]);
      }
      setPhase("review");
    } catch (e) {
      setError(e.message || "Something went wrong");
      // Keep whatever came back before the failure — a partial review still
      // beats starting over.
      setPhase(found.length > 0 ? "review" : "scanned");
    }
  }, [candidates]);

  const approved = proposals.filter((p) => !rejected.has(p.row_id));

  const apply = useCallback(async () => {
    setPhase("applying");
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/apply-splits", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          splits: approved.map((p) => ({ row_id: p.row_id, cards: p.cards })),
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSummary(data);
      setPhase("done");
      onApplied?.();
    } catch (e) {
      setError(e.message || "Couldn't apply the changes");
      setPhase("review");
    }
  }, [approved, onApplied]);

  const toggle = (rowId) => {
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  return createPortal(
    <div style={SS.overlay} onClick={onClose}>
      <div style={SS.box} onClick={(e) => e.stopPropagation()}>
        <div style={SS.header}>
          <h2 style={SS.title}>Fix multi-sense cards</h2>
          <button style={SS.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        <p style={SS.lede}>
          Some cards teach two different French words that share a spelling —
          “les frais” (the costs) and “frais” (fresh) end up on one card. Those
          can’t be answered, and can’t be scheduled. This finds them and turns
          each one into separate cards.
        </p>

        {error && <div style={SS.error}>{error}</div>}

        {phase === "scanned" && (
          <>
            <div style={SS.stat}>
              <div style={SS.statVal}>{candidates.length.toLocaleString()}</div>
              <div style={SS.statSub}>
                {candidates.length === 1 ? "card looks suspicious" : "cards look suspicious"}
                {" "}out of {deck.length.toLocaleString()}
              </div>
            </div>
            {candidates.length === 0 ? (
              <p style={SS.note}>Nothing to fix — every card reads as one word.</p>
            ) : (
              <p style={SS.note}>
                Next step reads each of these and decides which are genuinely two
                words. Nothing changes yet.
              </p>
            )}
          </>
        )}

        {phase === "auditing" && (
          <div style={SS.stat}>
            <div style={SS.statVal}>{done} / {candidates.length}</div>
            <div style={SS.statSub}>checked · {proposals.length} to split so far</div>
            <div style={SS.progressWrap}>
              <div style={{...SS.progressBar, width: `${candidates.length ? (done / candidates.length) * 100 : 0}%`}} />
            </div>
          </div>
        )}

        {(phase === "review" || phase === "applying") && (
          <>
            <p style={SS.note}>
              {proposals.length === 0
                ? "Checked them all — none are actually two words. Nothing to do."
                : `${approved.length} of ${proposals.length} will be applied. Untick anything that looks wrong.`}
            </p>
            <div style={SS.list}>
              {proposals.map((p) => {
                const off = rejected.has(p.row_id);
                return (
                  <label key={p.row_id} style={off ? {...SS.item, ...SS.itemOff} : SS.item}>
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() => toggle(p.row_id)}
                      style={SS.check}
                      disabled={phase === "applying"}
                    />
                    <div style={SS.itemBody}>
                      <div style={SS.before}>
                        <span style={SS.beforeFront}>{p.original.front}</span>
                        <span style={SS.beforeBack}>{p.original.back}</span>
                      </div>
                      <div style={SS.arrow}>becomes</div>
                      {p.cards.map((c, i) => (
                        <div key={i} style={SS.after}>
                          <span style={SS.afterFront}>{c.front}</span>
                          <span style={SS.afterBack}>{c.back}</span>
                        </div>
                      ))}
                      {p.reason && <div style={SS.reason}>{p.reason}</div>}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {phase === "done" && summary && (
          <div style={SS.stat}>
            <div style={SS.statVal}>{summary.updated + summary.inserted}</div>
            <div style={SS.statSub}>
              cards now in place of {summary.updated} — {summary.inserted} newly added
            </div>
            {summary.skipped?.length > 0 && (
              <p style={SS.note}>{summary.skipped.length} were skipped and left alone.</p>
            )}
          </div>
        )}

        <div style={SS.footer}>
          {phase === "scanned" && candidates.length > 0 && (
            <button style={SS.primary} onClick={audit}>
              Check these {candidates.length.toLocaleString()} cards
            </button>
          )}
          {phase === "auditing" && <button style={SS.primaryOff} disabled>Checking…</button>}
          {phase === "review" && proposals.length > 0 && (
            <button style={approved.length ? SS.primary : SS.primaryOff} onClick={apply} disabled={!approved.length}>
              Apply {approved.length} split{approved.length === 1 ? "" : "s"}
            </button>
          )}
          {phase === "applying" && <button style={SS.primaryOff} disabled>Applying…</button>}
          <button style={SS.secondary} onClick={onClose}>
            {phase === "done" ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const SS = {
  overlay: { position:"fixed", inset:0, background:"rgba(3,22,50,0.42)", backdropFilter:"blur(3px)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1100, padding:20 },
  box: { background:T.color.surfaceLowest, borderRadius:T.radius.xl, padding:"24px 28px 20px", width:"100%", maxWidth:720, maxHeight:"86vh", display:"flex", flexDirection:"column", fontFamily:T.font.sans, boxShadow:"0 24px 64px rgba(3,22,50,0.28)", boxSizing:"border-box" },
  header: { display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 },
  title: { margin:0, fontSize:24, fontFamily:T.font.serif, fontWeight:700, color:T.color.primary, letterSpacing:"-0.02em" },
  close: { background:"none", border:"none", fontSize:24, cursor:"pointer", color:T.color.onSurfaceVariant, padding:"0 4px", lineHeight:1 },
  lede: { fontSize:13, lineHeight:1.5, color:T.color.onSurfaceVariant, margin:"8px 0 16px", flexShrink:0 },
  note: { fontSize:12.5, color:T.color.onSurfaceVariant, margin:"12px 0 0", flexShrink:0 },
  error: { padding:10, background:T.color.errorContainer, color:T.color.onErrorContainer, borderRadius:T.radius.lg, fontSize:13, marginBottom:12, flexShrink:0 },
  stat: { textAlign:"center", padding:"20px 0 4px", flexShrink:0 },
  statVal: { fontSize:40, fontFamily:T.font.serif, fontWeight:700, color:T.color.primary, letterSpacing:"-0.03em" },
  statSub: { fontSize:12.5, color:T.color.onSurfaceVariant, marginTop:2 },
  progressWrap: { height:4, borderRadius:2, background:"rgba(3,22,50,0.08)", marginTop:14, overflow:"hidden" },
  progressBar: { height:"100%", background:T.color.primary, borderRadius:2, transition:"width 200ms ease" },
  list: { flex:1, minHeight:0, overflowY:"auto", marginTop:12, display:"flex", flexDirection:"column", gap:8, paddingRight:4 },
  item: { display:"flex", gap:12, alignItems:"flex-start", padding:"12px 14px", background:T.color.surfaceLow, borderRadius:T.radius.lg, cursor:"pointer" },
  itemOff: { opacity:0.42 },
  check: { marginTop:3, accentColor:T.color.primary, cursor:"pointer", flexShrink:0 },
  itemBody: { flex:1, minWidth:0 },
  before: { display:"flex", gap:8, alignItems:"baseline", flexWrap:"wrap" },
  beforeFront: { fontFamily:T.font.serif, fontSize:15, fontWeight:600, color:T.color.onSurface, textDecoration:"line-through", textDecorationColor:"rgba(3,22,50,0.3)" },
  beforeBack: { fontSize:12.5, color:T.color.onSurfaceVariant },
  arrow: { fontSize:10.5, letterSpacing:"0.08em", textTransform:"uppercase", color:T.color.onSurfaceVariant, opacity:0.7, margin:"8px 0 4px" },
  after: { display:"flex", gap:8, alignItems:"baseline", flexWrap:"wrap", marginTop:2 },
  afterFront: { fontFamily:T.font.serif, fontSize:15, fontWeight:700, color:T.color.primary },
  afterBack: { fontSize:12.5, color:T.color.onSurfaceVariant },
  reason: { fontSize:11.5, color:T.color.onSurfaceVariant, opacity:0.8, marginTop:8, lineHeight:1.4 },
  footer: { display:"flex", gap:10, justifyContent:"flex-end", alignItems:"center", paddingTop:16, marginTop:4, flexShrink:0, borderTop:"1px solid rgba(3,22,50,0.06)" },
  primary: { padding:"10px 20px", background:T.gradient.ink, color:T.color.onPrimary, border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:14, fontWeight:600, fontFamily:T.font.sans, boxShadow:T.shadow.button },
  primaryOff: { padding:"10px 20px", background:"rgba(3,22,50,0.1)", color:T.color.onSurfaceVariant, border:"none", borderRadius:T.radius.md, cursor:"default", fontSize:14, fontWeight:600, fontFamily:T.font.sans },
  secondary: { padding:"10px 16px", background:"transparent", border:"none", borderRadius:T.radius.md, cursor:"pointer", fontSize:14, color:T.color.onSurfaceVariant, fontFamily:T.font.sans, fontWeight:500 },
};
