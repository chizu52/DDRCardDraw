/** Shared by the Matches tab and the pool-results OBS overlay so
 * placement-based row highlighting looks identical in both places.
 *
 * Gated on real advancement, not assumed from rank position alone --
 * only a row the sheet's own Final Ranking cell actually marks advancing
 * (parse-pools.ts's finalRankingStatusByName, the SAME sheet-color-driven
 * signal the advancing/eliminated TEXT dimming already reads) ever gets
 * colored at all, since a pool's real advance count varies pool to pool
 * (1, 2, or 3 players) -- "2nd place is always colored" could tint a row
 * that didn't actually advance, or leave uncolored a 3rd/4th place that
 * did. WHICH color an advancing row gets still depends on its own
 * placement (1st/2nd/3rd/4th+), each independently switched on/off via
 * RowColorTiers -- explicit user request to bring the placement-specific
 * colors back after an earlier pass replaced them with one flat color
 * for every advancing row regardless of rank. */
export interface RowColorTiers {
  first: boolean;
  second: boolean;
  third: boolean;
  fourthPlus: boolean;
}

// Matches the pre-existing behavior from before per-tier control existed
// (only 1st/2nd were ever colored), so turning this feature on doesn't
// change anyone's current overlay.
export const DEFAULT_ROW_COLOR_TIERS: RowColorTiers = {
  first: true,
  second: true,
  third: false,
  fourthPlus: false,
};

// 1st/2nd are the exact tint values already in use before tiers existed.
// 3rd (bronze) and 4th+ (light gray) read clearly as a lower tier
// without being confused with the zebra-stripe background rows fall
// back to when no tier applies.
const TIER_COLORS: Record<keyof RowColorTiers, string> = {
  first: "rgba(255, 215, 0, 0.25)",
  second: "rgba(192, 192, 192, 0.25)",
  third: "rgba(205, 127, 50, 0.25)",
  fourthPlus: "rgba(211, 211, 211, 0.15)",
};

/** Returns the row tint for `rank` (1-based placement, from
 * parse-pools.ts's topScoreRanks), or null whenever: `status` isn't
 * "advancing" (the real, sheet-color-driven gate -- see this file's own
 * module doc), `rank` is unranked, or that specific rank's own tier is
 * switched off in `tiers`. Callers fall back to their own zebra striping
 * in any of those null cases. */
export function rowColorForRank(
  rank: number | undefined,
  status: "advancing" | "eliminated" | null,
  tiers: RowColorTiers,
): string | null {
  if (status !== "advancing") return null;
  if (rank === undefined) return null;
  if (rank === 1) return tiers.first ? TIER_COLORS.first : null;
  if (rank === 2) return tiers.second ? TIER_COLORS.second : null;
  if (rank === 3) return tiers.third ? TIER_COLORS.third : null;
  return tiers.fourthPlus ? TIER_COLORS.fourthPlus : null;
}
