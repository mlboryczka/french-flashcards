// Design tokens for "The Academic Atelier" theme.
//
// A single source of truth imported by every style object in the app.
// Values come from the Stitch-generated DESIGN.md (Midnight & Clay palette).
//
// Usage:
//   import { T } from "./theme";
//   const S = {
//     card: { background: T.color.surface, color: T.color.onSurface, ... }
//   };

export const T = {
  color: {
    // Primary "Midnight" family — for branding, CTAs, authoritative headings
    primary: "#031632",
    primaryContainer: "#1a2b48",
    onPrimary: "#ffffff",

    // Secondary "Terracotta" family — interactive accents, progress, celebration
    secondary: "#9c4234",
    secondaryContainer: "#fe8f7c",
    onSecondary: "#ffffff",
    onSecondaryContainer: "#76261b",

    // Background "Clay" — the paper of the app
    background: "#fdf8f6",
    onBackground: "#1c1b1b",

    // Surface tiers — boundaries via tonal shifts, not lines
    surface: "#fdf8f6",
    surfaceLowest: "#ffffff",           // cards
    surfaceLow: "#f7f3f1",              // section backgrounds
    surfaceMid: "#f1edeb",
    surfaceHigh: "#ebe7e5",             // input backgrounds
    surfaceHighest: "#e5e2e0",
    onSurface: "#1c1b1b",
    onSurfaceVariant: "#44474d",        // secondary text

    // Semantic status
    error: "#ba1a1a",
    errorContainer: "#ffdad6",
    onError: "#ffffff",
    onErrorContainer: "#93000a",

    // Tertiary — used sparingly for contextual blocks
    tertiary: "#25120a",
    tertiaryFixed: "#ffdbcf",

    // Ghost borders at 15% opacity — "felt, not seen"
    outlineGhost: "rgba(3, 22, 50, 0.08)",
  },

  // The "Midnight Gradient" — primary CTA background, never a flat hex
  gradient: {
    ink: "linear-gradient(135deg, #031632 0%, #1a2b48 100%)",
  },

  font: {
    // Noto Serif — display, headlines, card content (the "journal" feel)
    serif: "'Noto Serif', Georgia, serif",
    // Manrope — body, labels, UI chrome (legibility in long study sessions)
    sans: "'Manrope', system-ui, -apple-system, sans-serif",
  },

  // Border radius — slightly sharper than usual for "architectural" feel
  radius: {
    sm: 4,      // 0.25rem
    md: 6,      // 0.375rem — buttons
    lg: 8,      // 0.5rem — cards, inputs
    xl: 12,     // 0.75rem — modals
    full: 9999, // pills/chips
  },

  // Shadows — ink-tinted glows, not drop shadows
  shadow: {
    // Subtle card lift
    card: "0 8px 32px rgba(3, 22, 50, 0.06)",
    // CTA with more presence
    button: "0 8px 24px rgba(3, 22, 50, 0.12)",
    // Modals
    modal: "0 20px 60px rgba(3, 22, 50, 0.15)",
    // Small lift for inputs on focus
    focus: "0 2px 12px rgba(3, 22, 50, 0.08)",
  },

  // Spacing scale — use for gaps, padding, margins
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 48,
  },
};
