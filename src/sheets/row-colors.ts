/** Shared by the Matches tab and the pool-results OBS overlay so
 * placement-based row highlighting looks identical in both places -- see
 * event.slice.ts's overlayRowColorTiers for where the enabled/disabled
 * state itself lives (room-synced). */
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
// 3rd (bronze) and 4th+ (light gray) are new -- picked to read clearly as
// a lower tier without being confused with the zebra-stripe background
// rows fall back to when no tier applies.
const TIER_COLORS: Record<keyof RowColorTiers, string> = {
  first: "rgba(255, 215, 0, 0.25)",
  second: "rgba(192, 192, 192, 0.25)",
  third: "rgba(205, 127, 50, 0.25)",
  fourthPlus: "rgba(211, 211, 211, 0.15)",
};

/** Returns the row tint for `rank` (1-based placement, from
 * parse-pools.ts's topScoreRanks) given which tiers are enabled, or null
 * if `rank` is unranked or its tier is switched off -- callers fall back
 * to their own zebra striping in that case. */
export function rowColorForRank(
  rank: number | undefined,
  tiers: RowColorTiers,
): string | null {
  if (rank === undefined) return null;
  if (rank === 1) return tiers.first ? TIER_COLORS.first : null;
  if (rank === 2) return tiers.second ? TIER_COLORS.second : null;
  if (rank === 3) return tiers.third ? TIER_COLORS.third : null;
  return tiers.fourthPlus ? TIER_COLORS.fourthPlus : null;
}
