// The Stats page's sections that change as you click or point at them: the
// ~N remembered chart, the days you studied, and progress by lesson. Each
// keeps its own state (the chart's range, what's folded, the hover box), so
// pointing at a day doesn't redraw the whole page. The figures come in
// worked out (lib/progress.js, lib/progressHistory.js); these only draw them.
import { useState } from "react";
import { T } from "./theme";

const NAVY = T.color.primary;
const dayLong = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const dayShort = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// A day's cards in three: what the hover boxes and the Today figure say.
export const splitText = (d) => `${d.fresh} new · ${plural(d.reviews, "review", "reviews")} · ${plural(d.retries, "retry", "retries")}`;

// The hover box, kept on screen.
function Tip({ tip }) {
  if (!tip) return null;
  const left = Math.min(tip.x + 14, window.innerWidth - 260);
  return (
    <div style={{ ...S.tip, left, top: Math.max(8, tip.y - 12 - 16 * tip.lines.length) }} role="tooltip">
      {tip.lines.map((l, i) => <div key={i} style={i === 0 ? { fontWeight: 700 } : null}>{l}</div>)}
    </div>
  );
}

const dayLines = (d, isToday) => [
  isToday ? "Today" : dayLong(d.start),
  ...(d.cards > 0 ? [plural(d.cards, "card", "cards"), splitText(d)] : ["Didn't study"]),
];

// One bar in three bands: remembered (solid), seen but not remembered now
// (light), not yet seen (the empty track).
export function Bands({ summary, height, color = NAVY }) {
  const total = Math.max(summary.total, 1);
  const rem = Math.min(summary.remembered, summary.seen);
  return (
    <div style={{ ...S.track, height }}>
      <div style={{ width: `${(rem / total) * 100}%`, background: color }} />
      <div style={{ width: `${((summary.seen - rem) / total) * 100}%`, background: color, opacity: 0.3 }} />
    </div>
  );
}

// Round numbers for the chart's gridlines: 1, 2 or 5 times a power of ten.
function niceStep(range) {
  const raw = Math.max(range, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

const remWord = (gain) =>
  gain > 0 ? `~${gain.toLocaleString()} more remembered` : gain < 0 ? `~${(-gain).toLocaleString()} fewer remembered` : "no change in remembered";

// ~N remembered, day by day. points: one per day, oldest first, today last.
export function RememberedChart({ points, now, week, all, allLabel }) {
  const [range, setRange] = useState("7");
  const [hover, setHover] = useState(null);
  const shown = range === "7" ? points.slice(-8) : points;
  const sentence = range === "7"
    ? <>In the last 7 days: <b style={S.strong}>{remWord(week.gain)}</b>, {plural(week.met, "new card", "new cards")} met.</>
    : <>{allLabel}: <b style={S.strong}>~{all.remembered.toLocaleString()} remembered</b>, {plural(all.met, "new card", "new cards")} met.</>;

  const W = 700, H = 210, L = 40, R = 10, Tp = 10, B = 26;
  let chart = null;
  if (shown.length >= 2) {
    const vals = shown.map((p) => p.remembered);
    const step = niceStep(Math.max(...vals) - Math.min(...vals));
    const minY = Math.floor(Math.min(...vals) / step) * step;
    const maxY = Math.max(minY + step, Math.ceil(Math.max(...vals) / step) * step);
    const x = (k) => L + (k / (shown.length - 1)) * (W - L - R);
    const y = (v) => Tp + (1 - (v - minY) / (maxY - minY)) * (H - Tp - B);
    const pts = shown.map((p, k) => [x(k), y(p.remembered)]);
    const path = pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const every = Math.max(1, Math.ceil(shown.length / 8));
    const grid = [];
    for (let g = minY; g <= maxY + 1e-9; g += step) grid.push(g);
    const onMove = (e) => {
      const r = e.currentTarget.ownerSVGElement.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const k = Math.max(0, Math.min(shown.length - 1, Math.round(((px - L) / (W - L - R)) * (shown.length - 1))));
      const p = shown[k];
      const prev = points[points.indexOf(p) - 1];
      const change = Math.round(p.remembered) - Math.round(prev ? prev.remembered : 0);
      const isToday = k === shown.length - 1;
      const lines = dayLines(p, isToday);
      lines.splice(1, 0, `~${Math.round(p.remembered).toLocaleString()} remembered (${change >= 0 ? "+" : "−"}${Math.abs(change)})`);
      setHover({ k, x: e.clientX, y: e.clientY, lines });
    };
    chart = (
      <svg viewBox={`0 0 ${W} ${H}`} style={S.svg} data-stats-chart>
        {grid.map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="rgba(3,22,50,0.07)" />
            <text x={L - 8} y={y(g) + 4} textAnchor="end" fontSize="10.5" fill={T.color.onSurfaceVariant} opacity=".7" fontFamily={T.font.sans}>{Math.round(g).toLocaleString()}</text>
          </g>
        ))}
        <path d={`${path} L${pts.at(-1)[0]} ${y(minY)} L${pts[0][0]} ${y(minY)} Z`} fill="rgba(3,22,50,0.06)" />
        <path d={path} fill="none" stroke={NAVY} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        {shown.map((p, k) => (
          <g key={p.start}>
            <circle cx={pts[k][0]} cy={pts[k][1]} r={shown.length > 15 ? 3 : 4} fill={p.cards > 0 ? NAVY : T.color.background} stroke={NAVY} strokeWidth="1.6" />
            {(shown.length - 1 - k) % every === 0 && (
              <text x={pts[k][0]} y={H - 6} textAnchor="middle" fontSize="10.5" fill={T.color.onSurfaceVariant} opacity=".75" fontFamily={T.font.sans}>
                {k === shown.length - 1 ? "Today" : dayShort(p.start)}
              </text>
            )}
          </g>
        ))}
        {hover && hover.k < pts.length && (
          <line x1={pts[hover.k][0]} x2={pts[hover.k][0]} y1={Tp} y2={H - B} stroke={T.color.secondary} strokeDasharray="3 3" />
        )}
        <rect x={L} y={Tp} width={W - L - R} height={H - Tp - B} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
    );
  }

  return (
    <div style={S.card} data-stats-trend>
      <div style={S.trendHead}>
        <div>
          <div style={S.trendBig}>~{Math.round(points.at(-1)?.remembered ?? all.remembered).toLocaleString()} remembered</div>
          <div style={S.trendLine}>{sentence}</div>
        </div>
        <div style={S.seg} role="radiogroup" aria-label="Chart range">
          {[["7", "Last 7 days"], ["all", allLabel]].map(([k, label]) => (
            <button key={k} role="radio" aria-checked={range === k} data-range={k}
              style={range === k ? { ...S.segBtn, ...S.segBtnOn } : S.segBtn}
              onClick={() => { setRange(k); setHover(null); }}>{label}</button>
          ))}
        </div>
      </div>
      {chart && <div style={{ marginTop: 18 }}>{chart}</div>}
      <Tip tip={hover} />
    </div>
  );
}

// Every day since the first answer, as a calendar of the last six weeks,
// shaded by how many cards were studied.
const LEVELS = [
  { min: 70, label: "70 cards or more", bg: NAVY },
  { min: 50, label: "50 to 69 cards", bg: "rgba(3,22,50,0.6)" },
  { min: 1, label: "Under 50 cards", bg: "rgba(3,22,50,0.28)" },
];
const levelOf = (n) => LEVELS.find((l) => n >= l.min);

export function StudyCalendar({ days, since }) {
  const [hover, setHover] = useState(null);
  const studied = days.filter((d) => d.cards > 0).length;
  const shown = days.slice(-42);
  const lead = shown.length ? (new Date(shown[0].start).getDay() + 6) % 7 : 0;
  const cells = [...Array(lead).fill(null), ...shown];
  while (cells.length % 7) cells.push("future");
  return (
    <div style={S.card} data-stats-days>
      <div style={S.cardTitle}>Days you studied</div>
      <div style={S.split}>
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <div style={S.bigVal}>{studied} of {plural(days.length, "day", "days")}</div>
          <div style={S.sub}>{since}</div>
          <div style={S.key}>
            {[{ label: "Didn't study", bg: T.color.surfaceMid }, ...[...LEVELS].reverse()].map((l) => (
              <div key={l.label} style={S.keyItem}><span style={{ ...S.keySq, background: l.bg }} />{l.label}</div>
            ))}
          </div>
        </div>
        <div style={S.cal}>
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i} style={S.dow}>{d}</div>)}
          {cells.map((d, i) => {
            if (d === null) return <div key={i} />;
            if (d === "future") return <div key={i} style={{ ...S.day, background: "transparent", border: "1px dashed rgba(3,22,50,0.12)" }} />;
            const isToday = d === shown.at(-1);
            const level = d.cards > 0 ? levelOf(d.cards) : null;
            return (
              <div key={i} data-day={d.iso} data-cards={d.cards}
                style={{ ...S.day, background: level ? level.bg : T.color.surfaceMid, ...(isToday ? S.today : null) }}
                onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, lines: dayLines(d, isToday) })}
                onMouseLeave={() => setHover(null)} />
            );
          })}
        </div>
      </div>
      <Tip tip={hover} />
    </div>
  );
}

// Progress by Lesson: folds away; a group of lessons (Basic Lessons) folds
// inside it, showing its lessons added together. Opens with the section open
// and the groups folded.
const Chevron = ({ open, size = 18 }) => (
  <span style={{ display: "flex", opacity: 0.6, transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none" }} aria-hidden="true">
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
  </span>
);

const deltaText = (d) =>
  d > 0 ? `+${d.toLocaleString()} remembered in 7 days` : d < 0 ? `−${(-d).toLocaleString()} remembered in 7 days` : "no change in 7 days";

function AreaRow({ row, name, onClick, open }) {
  const s = row.summary;
  return (
    <div style={onClick ? { ...S.area, cursor: "pointer" } : S.area} onClick={onClick}
      role={onClick ? "button" : undefined} aria-expanded={onClick ? open : undefined}
      data-stats-area={row.key}>
      <div style={S.areaHead}>
        <span style={S.areaName}>{name ?? row.label}</span>
        {row.sub && <span style={S.areaSub}>{row.sub}</span>}
      </div>
      <Bands summary={s} height={10} />
      <div style={S.areaFoot}>
        <span style={S.areaFig}>{s.seen.toLocaleString()} seen · ~{Math.round(s.remembered).toLocaleString()} remembered · {plural(s.total, "card", "cards")}</span>
        {row.delta != null && (
          <span style={row.delta > 0 ? S.deltaUp : row.delta < 0 ? S.deltaDown : S.deltaFlat}>{deltaText(row.delta)}</span>
        )}
      </div>
    </div>
  );
}

export function ProgressByLesson({ groups, rows }) {
  const [open, setOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const toggleGroup = (key) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div style={{ marginTop: 24 }} data-stats-areas>
      <button style={S.foldHead} onClick={() => setOpen((v) => !v)} aria-expanded={open} data-stats-areas-toggle>
        Progress by Lesson<Chevron open={open} />
      </button>
      {open && (
        <div style={S.areaList}>
          {groups.map((g) => {
            const gOpen = openGroups.has(g.key);
            return (
              <div key={g.key} style={S.areaList}>
                <AreaRow row={g} open={gOpen} onClick={() => toggleGroup(g.key)}
                  name={<span style={{ display: "flex", alignItems: "center", gap: 8 }}>{g.label}<Chevron open={gOpen} size={16} /></span>} />
                {gOpen && (
                  <div style={S.nested} data-stats-group={g.key}>
                    {g.lessons.map((r) => <AreaRow key={r.key} row={r} />)}
                  </div>
                )}
              </div>
            );
          })}
          {rows.map((r) => <AreaRow key={r.key} row={r} />)}
        </div>
      )}
    </div>
  );
}

const S = {
  card: { background: T.color.surfaceLowest, border: `0.5px solid ${T.color.outlineGhost}`, borderRadius: T.radius.xl, padding: "22px 24px", marginBottom: 12 },
  cardTitle: { fontSize: 14, fontFamily: T.font.sans, fontWeight: 600, color: NAVY, marginBottom: 8 },
  trendHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 },
  trendBig: { fontFamily: T.font.serif, fontSize: 30, fontWeight: 600, color: NAVY, lineHeight: 1.1 },
  trendLine: { fontSize: 13, fontFamily: T.font.sans, color: T.color.onSurfaceVariant, marginTop: 6 },
  strong: { color: NAVY, fontWeight: 700 },
  seg: { display: "inline-flex", gap: 2, padding: 3, background: T.color.surfaceLow, borderRadius: T.radius.md, flexShrink: 0 },
  segBtn: { padding: "5px 12px", border: "none", borderRadius: T.radius.sm, background: "transparent", cursor: "pointer", fontSize: 11, fontWeight: 500, color: T.color.onSurfaceVariant, whiteSpace: "nowrap", fontFamily: T.font.sans },
  segBtnOn: { background: T.color.surfaceLowest, color: NAVY, fontWeight: 600, boxShadow: T.shadow.focus },
  svg: { display: "block", width: "100%", height: "auto", overflow: "visible" },
  tip: { position: "fixed", pointerEvents: "none", zIndex: 1300, background: NAVY, color: T.color.background, fontSize: 12, lineHeight: 1.45, padding: "7px 10px", borderRadius: T.radius.md, whiteSpace: "nowrap", boxShadow: "0 4px 16px rgba(3,22,50,0.2)", fontFamily: T.font.sans },
  track: { display: "flex", borderRadius: 6, overflow: "hidden", background: T.color.surfaceHigh, marginBottom: 10 },
  split: { display: "flex", gap: 28, alignItems: "center" },
  bigVal: { fontSize: 32, fontFamily: T.font.serif, fontWeight: 600, color: NAVY, lineHeight: 1.1 },
  sub: { fontSize: 12, fontFamily: T.font.sans, color: T.color.onSurfaceVariant, marginTop: 4 },
  key: { display: "flex", flexDirection: "column", gap: 7, marginTop: 18 },
  keyItem: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontFamily: T.font.sans, color: T.color.onSurfaceVariant },
  keySq: { width: 14, height: 14, borderRadius: 3, flexShrink: 0 },
  cal: { flex: "0 0 250px", display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 },
  dow: { fontSize: 10, fontWeight: 600, fontFamily: T.font.sans, color: T.color.onSurfaceVariant, textAlign: "center", opacity: 0.7 },
  day: { aspectRatio: "1", borderRadius: 5, cursor: "default" },
  today: { boxShadow: `0 0 0 2px ${T.color.background}, 0 0 0 3.5px ${T.color.secondary}` },
  foldHead: { display: "flex", alignItems: "center", gap: 10, padding: 0, border: "none", background: "transparent", cursor: "pointer", fontFamily: T.font.serif, fontSize: 18, fontWeight: 600, color: NAVY, textAlign: "left", marginBottom: 14 },
  areaList: { display: "flex", flexDirection: "column", gap: 10 },
  nested: { display: "flex", flexDirection: "column", gap: 8, margin: "-2px 0 2px 18px", paddingLeft: 14, borderLeft: `2px solid ${T.color.surfaceHigh}` },
  area: { background: T.color.surfaceLowest, borderRadius: T.radius.xl, padding: "14px 18px", border: "1px solid rgba(3,22,50,0.06)" },
  areaHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10, flexWrap: "wrap" },
  areaName: { fontSize: 15, fontFamily: T.font.serif, fontWeight: 600, color: NAVY },
  areaSub: { fontSize: 12, fontFamily: T.font.sans, color: T.color.onSurfaceVariant },
  areaFoot: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: -2 },
  areaFig: { fontSize: 12.5, fontFamily: T.font.sans, color: T.color.onSurfaceVariant, fontVariantNumeric: "tabular-nums" },
  deltaUp: { fontSize: 12, fontFamily: T.font.sans, fontWeight: 700, color: NAVY, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  deltaDown: { fontSize: 12, fontFamily: T.font.sans, fontWeight: 600, color: T.color.onSurfaceVariant, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  deltaFlat: { fontSize: 12, fontFamily: T.font.sans, fontWeight: 500, color: T.color.onSurfaceVariant, opacity: 0.7, whiteSpace: "nowrap" },
};
