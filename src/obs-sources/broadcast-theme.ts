import { BODY_FONT_FAMILY } from "./local-fonts";

// Dark broadcast-panel palette shared by gauntlet-pools.tsx,
// pool-results.tsx, and schedule.tsx, so the three overlays read as one
// broadcast package rather than three separately-tuned dark themes.
// Each file adds its own extra colors on top (e.g. a distinct `red`) --
// only genuinely identical values live here.
export const BROADCAST_COLORS = {
  panel: "#1c2127",
  border: "#3a3f49",
  text: "#f6f7f9",
  muted: "#9aa2ac",
  mint: "#22c55e",
  gold: "#efc75e",
  coral: "#f0a868",
};

// Solid, high-contrast status pill -- shared by gauntlet-pools.tsx and
// pool-results.tsx, byte-identical between the two.
export const statusPillStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "5px 16px",
  borderRadius: 999,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.75em",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: BROADCAST_COLORS.panel,
  whiteSpace: "nowrap",
};
