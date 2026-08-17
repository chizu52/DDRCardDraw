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

// The rendered size of a player's name in gauntlet-pools.tsx's own
// PoolBox rows (cardStyle's base fontSize of 28 * poolRowListStyle's own
// "0.9em" -- kept as one literal number here, not re-derived, since
// gauntlet-pools.tsx's own em-relative styling doesn't need to change at
// all for this). Exported specifically so bracket-tree.tsx's own
// MatchBox names can be scaled to match it exactly (see that file's own
// SVG_SCALE) -- the two views were tuned independently before, to two
// "looks about right" sizes that didn't actually match (15px fixed SVG
// text vs this), so switching the "Now showing" dropdown between them
// made every name suddenly jump ~68% larger or smaller. Lives here, not
// imported directly from one file into the other, since gauntlet-pools.tsx
// already imports FROM bracket-tree.tsx (BracketTreeWithApiKey) -- a
// reverse import back into it would be circular.
export const POOL_PLAYER_ROW_FONT_SIZE = 28 * 0.9;

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
