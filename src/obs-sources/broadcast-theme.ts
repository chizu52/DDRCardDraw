import { BODY_FONT_FAMILY, TITLE_FONT_FAMILY } from "./local-fonts";
import Banner from "../other-assets/backgrounds/bg.png";

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

// "Winners"/"Losers" section-label treatment -- shared by
// gauntlet-pools.tsx's own pools diagram AND bracket-tree.tsx's bracket
// view (each applies its own color per side: COLORS.mint for Winners,
// COLORS.coral for Losers), so the same label reads identically no
// matter which of the two views the "Now showing" dropdown currently
// has up. Lives here rather than being imported directly from one file
// into the other, same reasoning as POOL_PLAYER_ROW_FONT_SIZE above --
// gauntlet-pools.tsx already imports FROM bracket-tree.tsx
// (BracketTreeWithApiKey), so a reverse import back into it would be
// circular.
export const sectionLabelStyle: React.CSSProperties = {
  fontFamily: TITLE_FONT_FAMILY,
  fontWeight: 700,
  fontSize: "1.3em",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  textShadow: "0 2px 6px rgba(0, 0, 0, 0.85)",
};

// The whole-page "shell" both overlays render into -- outer wrapper +
// banner backdrop + one cohesive card + its padded content layer --
// shared so switching the "Now showing" dropdown between the pools
// diagram and the bracket view never visibly changes the overall page
// composition, only the content inside (the pool grid vs. the bracket
// tree columns -- see each file's own doc for why THAT part stays
// separate: it's genuinely different drawing logic, not the same
// thing styled differently). Explicit user request, after gauntlet-
// pools.tsx and bracket-tree.tsx had independently converged on two
// different "looks about right" shells (a full-bleed edge-to-edge
// canvas vs. a smaller floating rounded card) that read as two
// different overlays rather than the same one showing different data.
// The one deliberate difference: gauntlet-pools.tsx wraps its own
// content in a scrollable, auto-panning camera (see its own
// scrollContainerStyle) that bracket-tree.tsx does NOT get -- explicit
// user request to keep the bracket view static/non-scrolling rather
// than add that as new behavior it never had before.

// `width: 100vw` fills the whole OBS canvas regardless of how wide the
// actual content is -- each caller's own inner content still just
// sizes to itself (cardStyle's own width: max-content below), so a
// narrower view still shows banner on either side, same as a wider one
// would if it could scroll.
export const outerWrapperStyle: React.CSSProperties = {
  width: "100vw",
  overflow: "hidden",
  position: "relative",
};

// The banner art as a soft out-of-focus backdrop. Absolute -- painted
// as a sibling BEHIND whatever content each caller renders after it in
// DOM order. `inset: -20px` gives the blur room to bleed past the
// wrapper's own edges without a hard cutoff at its border. Plain
// `blur(3px)`, no extra brightness darkening -- bracket-tree.tsx used
// to also apply `brightness(0.55)` on top of this that gauntlet-
// pools.tsx never did, one more thing that made the two views read as
// visibly different treatments of the same banner image.
export const bannerBackdropStyle: React.CSSProperties = {
  position: "absolute",
  inset: -20,
  background: `url(${Banner}) center/cover no-repeat`,
  filter: "blur(3px)",
};

// One cohesive card, sitting on top of the banner. `width: max-content`
// -- sizes to its own true content width rather than stretching to
// fill outerWrapperStyle's own 100vw, so a view narrower than the
// canvas (e.g. a small bracket, or a pool sheet with few columns)
// doesn't stretch itself out to the full width; banner just shows on
// either side instead. Deliberately NOT `overflow: hidden` (even
// though borderRadius is 0, so there's nothing to visually clip) --
// gauntlet-pools.tsx's own scroll-camera content relies on `position:
// sticky` inside this card (its title bar, its section labels), and
// any ancestor with a non-`visible` overflow counts as a nearer
// "scrolling ancestor" than the real scroll container two levels up,
// which breaks that sticky positioning. bracket-tree.tsx doesn't use
// sticky at all (nothing to stick against without scrolling), so this
// costs it nothing either way -- one shared value, not two
// independently-tuned ones that could drift.
export const cardStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  fontSize: 28,
  fontSynthesis: "none",
  background: "rgba(17, 20, 24, 0.65)",
  borderRadius: 0,
  position: "relative",
  display: "inline-block",
  width: "max-content",
  color: BROADCAST_COLORS.text,
};

// The padded content layer, on top of the card's own translucent
// background.
export const cardContentStyle: React.CSSProperties = {
  position: "relative",
  padding: 40,
};
