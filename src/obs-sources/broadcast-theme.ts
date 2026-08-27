import { BODY_FONT_FAMILY, TITLE_FONT_FAMILY } from "./local-fonts";

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
  mint: "#47d896",
  gold: "#efc75e",
  coral: "#d97f4a",
};

// Pre-blends a color at some alpha against `base` into a single SOLID
// color, instead of leaving it as a translucent rgba() tint -- a
// translucent tint reads as a DIFFERENT effective color depending on
// what actually sits behind it (e.g. schedule.tsx's own row.color tint
// used to look different on the current row, COLORS.currentBg, than on
// every other row, COLORS.panel -- see that file's original use of
// this). Doubly important now that gauntlet-pools.tsx/bracket-
// tree.tsx/schedule.tsx's own outer card backgrounds are transparent
// (explicit user request, so these composite as proper OBS browser
// sources): a translucent tint would blend against whatever's live
// behind them in OBS instead of a fixed, predictable color. `base`
// defaults to BROADCAST_COLORS.panel (the common case -- blending
// against the standard dark panel a piece of content sits on), but
// takes an explicit override for a caller blending against some other
// real background (e.g. a status color).
//
// Accepts either a plain "#rrggbb" hex (pair this with an explicit
// `alpha`) or an already-formed "rgba(r, g, b, a)" string (its own
// baked-in alpha is used, and `alpha` can be omitted) -- pool-
// results.tsx needs the second form for row-colors.ts's own
// TIER_COLORS, which already come back as complete rgba() strings, not
// a bare hex + separate alpha the way schedule.tsx's row.color does.
//
// Originally schedule.tsx-local (blendOverPanel); moved here once
// pool-results.tsx needed the identical technique for its own per-row
// backgrounds.
export function blendOverBase(
  color: string,
  alpha?: number,
  base: string = BROADCAST_COLORS.panel,
): string {
  const rgbaMatch =
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
      color,
    );
  const hexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  const bgMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(base);
  if (!bgMatch || (!rgbaMatch && !hexMatch)) return color;
  const [, br, bgc, bb] = bgMatch;
  const base10 = (hex: string) => parseInt(hex, 16);
  const [fr, fg, fb, resolvedAlpha] = rgbaMatch
    ? [
        Number(rgbaMatch[1]),
        Number(rgbaMatch[2]),
        Number(rgbaMatch[3]),
        rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : (alpha ?? 1),
      ]
    : [
        base10(hexMatch![1]),
        base10(hexMatch![2]),
        base10(hexMatch![3]),
        (alpha ?? 1),
      ];
  const mix = (fg: number, bgHex: string) =>
    Math.round(fg * resolvedAlpha + base10(bgHex) * (1 - resolvedAlpha));
  return `rgb(${mix(fr, br)}, ${mix(fg, bgc)}, ${mix(fb, bb)})`;
}

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
// one cohesive card + its padded content layer -- shared so switching
// the "Now showing" dropdown between the pools diagram and the bracket
// view never visibly changes the overall page composition, only the
// content inside (the pool grid vs. the bracket tree columns -- see
// each file's own doc for why THAT part stays separate: it's genuinely
// different drawing logic, not the same thing styled differently).
// Explicit user request, after gauntlet-pools.tsx and bracket-tree.tsx
// had independently converged on two different "looks about right"
// shells (a full-bleed edge-to-edge canvas vs. a smaller floating
// rounded card) that read as two different overlays rather than the
// same one showing different data. The one deliberate difference:
// gauntlet-pools.tsx wraps its own content in a scrollable, auto-
// panning camera (see its own scrollContainerStyle) that bracket-
// tree.tsx does NOT get -- explicit user request to keep the bracket
// view static/non-scrolling rather than add that as new behavior it
// never had before.
//
// Used to also carry a blurred banner-image backdrop (bg.png) behind a
// translucent card -- explicit user request to drop that idea
// entirely, not just retune it, matching pool-results.tsx's own
// existing plain-solid-panel look (which never had a banner at all).
// cardStyle's own background below is a flat, fully opaque
// BROADCAST_COLORS.panel now instead of a translucent rgba() -- no
// image left behind it to show through.

// `width: 100vw` fills the whole OBS canvas regardless of how wide the
// actual content is -- each caller's own inner content still just
// sizes to itself (cardStyle's own width: max-content below).
export const outerWrapperStyle: React.CSSProperties = {
  width: "100vw",
  overflow: "hidden",
  position: "relative",
};

// One cohesive card. `width: max-content` -- sizes to its own true
// content width rather than stretching to fill outerWrapperStyle's own
// 100vw, so a view narrower than the canvas (e.g. a small bracket, or
// a pool sheet with few columns) doesn't stretch itself out to the
// full width. Deliberately NOT `overflow: hidden` (even though
// borderRadius is 0, so there's nothing to visually clip) -- gauntlet-
// pools.tsx's own scroll-camera content relies on `position: sticky`
// inside this card (its title bar, its section labels), and any
// ancestor with a non-`visible` overflow counts as a nearer "scrolling
// ancestor" than the real scroll container two levels up, which breaks
// that sticky positioning. bracket-tree.tsx doesn't use sticky at all
// (nothing to stick against without scrolling), so this costs it
// nothing either way -- one shared value, not two independently-tuned
// ones that could drift.
// Transparent, not a solid fill -- explicit user request so these
// overlays composite as proper OBS browser sources (whatever's behind
// them in the OBS scene should show through the padding/gaps, not a
// big opaque rectangle). Safe here specifically because every actual
// piece of content inside already paints its own opaque background for
// legibility -- gauntlet-pools.tsx's own boxStyle (each pool box),
// bracket-tree.tsx's own MatchBox (each match's rect fill), and
// BroadcastTitleBar's own panel -- so removing the fill at THIS level
// only affects the empty space around/between them, never the text
// itself.
export const cardStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  fontSize: 28,
  fontSynthesis: "none",
  background: "transparent",
  borderRadius: 0,
  position: "relative",
  display: "inline-block",
  width: "max-content",
  color: BROADCAST_COLORS.text,
};

// The padded content layer, on top of the card's own (now transparent)
// background.
export const cardContentStyle: React.CSSProperties = {
  position: "relative",
  padding: 40,
};
