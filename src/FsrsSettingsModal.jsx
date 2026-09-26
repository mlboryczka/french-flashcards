import { useEffect } from "react";
import { createPortal } from "react-dom";
import { T } from "./theme";
import { FIRST_FIT } from "./lib/fsrsSettings";

// "How much to remember": the one FSRS setting a student chooses. The memory
// settings themselves are fitted to their answers by the server and are never
// set by hand (lib/fsrsSettings.js, api/fsrs-fit.js).
const CHOICES = [
  ["auto", "Automatic", "Recommended. Aims for 90%. If cards pile up for a week, it eases off a little — never below 85% — until you've caught up."],
  ["light", "Lighter load", "85%. Fewer reviews each day, a little more forgetting."],
  ["standard", "Standard", "90%."],
  ["more", "Remember more", "95%. Noticeably more reviews each day."],
];

const pct = (x) => `${Math.round(x * 100)}%`;
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });

export default function FsrsSettingsModal({ open, onClose, settings }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const { setUp, choice, target, fittedAt, answers, setChoice } = settings;

  return createPortal(
    <div style={S.scrim} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How much to remember" data-fsrs-settings>
        <div style={S.title}>How much to remember</div>
        <p style={S.body}>
          When a card comes back, how sure should you be of still knowing it? Higher
          means more reviews each day.
        </p>

        {!setUp ? (
          <div style={S.note}>Not available yet: the app is using its standard settings, aiming for 90%.</div>
        ) : (
          <div style={S.choices} role="radiogroup" aria-label="How much to remember">
            {CHOICES.map(([key, label, text]) => {
              const on = choice === key;
              return (
                <button
                  key={key}
                  role="radio"
                  aria-checked={on}
                  data-choice={key}
                  style={on ? { ...S.choice, ...S.choiceOn } : S.choice}
                  onClick={() => setChoice(key)}
                >
                  <span style={on ? { ...S.dot, ...S.dotOn } : S.dot} />
                  <span>
                    <span style={S.choiceLabel}>{label}</span>
                    <span style={S.choiceText}>
                      {text}
                      {key === "auto" && on && target < 0.9 ? ` Now aiming for ${pct(target)}.` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <p style={S.fine}>
          {fittedAt
            ? `The app has fitted these settings to how you remember, from your own answers (${day(fittedAt)}). It checks again every month.`
            : `Once you've given about ${FIRST_FIT.toLocaleString()} answers${answers ? ` (${answers.toLocaleString()} so far)` : ""}, the app fits these settings to how you remember, and switches only if that predicts your answers better.`}
        </p>

        <div style={S.actions}>
          <button style={S.done} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const S = {
  scrim: {
    position: "fixed", inset: 0, zIndex: 1200,
    background: "rgba(3,22,50,0.34)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
  },
  modal: {
    background: T.color.surface, borderRadius: T.radius.xl,
    padding: "24px 24px 20px", width: "min(460px, 100%)",
    boxShadow: "0 24px 64px rgba(3,22,50,0.24)",
    fontFamily: T.font.sans, boxSizing: "border-box",
    maxHeight: "90vh", overflowY: "auto",
  },
  title: { fontFamily: T.font.serif, fontSize: 19, fontWeight: 600, color: T.color.onSurface },
  body: { fontSize: 13, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "8px 0 14px" },
  note: {
    fontSize: 12.5, color: T.color.onSurfaceVariant,
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.08)",
    borderRadius: T.radius.md, padding: "9px 12px",
  },
  choices: { display: "flex", flexDirection: "column", gap: 8 },
  choice: {
    display: "flex", alignItems: "flex-start", gap: 10, textAlign: "left",
    background: T.color.surfaceLowest, border: "1px solid rgba(3,22,50,0.10)",
    borderRadius: T.radius.md, padding: "10px 12px", cursor: "pointer",
    fontFamily: T.font.sans, color: T.color.onSurface,
  },
  choiceOn: { border: `1px solid ${T.color.primary}`, background: T.color.surfaceHigh },
  dot: {
    flexShrink: 0, width: 14, height: 14, marginTop: 2, borderRadius: "50%",
    border: "1.5px solid rgba(3,22,50,0.35)", boxSizing: "border-box",
  },
  dotOn: { border: `4px solid ${T.color.primary}` },
  choiceLabel: { display: "block", fontSize: 13.5, fontWeight: 600 },
  choiceText: { display: "block", fontSize: 12.5, lineHeight: 1.5, color: T.color.onSurfaceVariant, marginTop: 2 },
  fine: { fontSize: 11.5, lineHeight: 1.6, color: T.color.onSurfaceVariant, margin: "14px 0 0" },
  actions: { display: "flex", justifyContent: "flex-end", marginTop: 16 },
  done: {
    padding: "9px 18px", background: T.gradient.ink, color: T.color.onPrimary,
    border: "none", borderRadius: T.radius.md, fontSize: 13, fontWeight: 600,
    fontFamily: T.font.sans, cursor: "pointer",
  },
};
