import type { StartggPhaseSeed, StartggSet, StartggSetSlot } from "./index";

export interface LayoutMatch {
  set: StartggSet;
  /** 0-based column within its side (winners/losers) -- winners round 1
   * is column 0, round 2 is column 1, etc; losers round -1 is column 0,
   * round -2 is column 1, etc. */
  col: number;
  /** Vertical order within its column, 0-based -- not a pixel value, see
   * layoutBracketPixels for that. */
  row: number;
}

export interface LayoutSide {
  /** Matches grouped by column (winners round 1, 2, 3... or losers
   * round 1, 2, 3...), already in row order within each column. */
  columns: LayoutMatch[][];
}

export interface BracketLayout {
  winners: LayoutSide;
  /** null for single elimination -- there's no losers side. */
  losers: LayoutSide | null;
}

/**
 * Groups a phase's sets into winners/losers columns and orders each
 * column top-to-bottom by tracing prereqId links back to the previous
 * column, so paired matches end up adjacent -- the same "which two
 * matches feed this one" relationship a real bracket draws connector
 * lines for, just used here to order rows instead. Grand finals (and a
 * potential bracket reset) share round numbering with the winners side
 * in start.gg's data (round keeps incrementing past the last real
 * winners round), so they land as the final column(s) of `winners`,
 * which is also visually correct -- GF sits to the right of both trees.
 *
 * Row order for the very first column of each side falls back to
 * whatever order the sets arrived in (sortType: ROUND already asks
 * start.gg for a stable, sensible order -- see startgg-gql/index.ts's
 * PhaseBracketDoc), since there's no earlier column to trace back to.
 */
export function layoutBracket(sets: (StartggSet | null)[]): BracketLayout {
  const real = sets.filter((s): s is StartggSet => s != null);
  // String(s.id) -- despite the StartggSet.id type saying `string`, the
  // live API actually returns Set.id as a JSON number while
  // SetSlot.prereqId (the thing we look this map up by) comes back as a
  // string (confirmed against real data: {"id":106028975,"prereqId":
  // "106028975"}). Same class of wire/type mismatch as winningSlotIndex's
  // String(set.winnerId) below -- without normalizing both sides, every
  // lookup here silently misses.
  const byId = new Map(real.map((s) => [String(s.id), s]));

  const winnersSets = real.filter((s) => (s.round ?? 0) >= 0);
  const losersSets = real.filter((s) => (s.round ?? 0) < 0);

  const winners = layoutSide(winnersSets, byId, (round) => round);
  const losers = losersSets.length
    ? layoutSide(losersSets, byId, (round) => -round - 1)
    : null;

  return { winners, losers };
}

/** True when `set` is a bracket-reset set entirely fed by ANOTHER set in
 * this same side that shares its own round number -- start.gg's own
 * "Grand Final Reset" (confirmed directly against real data: Stage 7's
 * phase 2211217 has both "Grand Final" and "Grand Final Reset" sets at
 * round 4, the reset set's own two slots both "set"-prereq pointing at
 * the Grand Final set's id, one placement 1 ["if the winners finalist
 * wins again"] and one placement 2 ["if the losers finalist forces a
 * reset"]). Detected structurally (both slots share the identical
 * prereqId, and that prereq's own round matches this set's round) --
 * not by name/identifier, since a reset set isn't guaranteed to be
 * literally named "Grand Final Reset" and no other real match can ever
 * have both slots fed by the exact same prereq (a normal match always
 * has two DIFFERENT sources). Returns the fed-from set (its sibling) or
 * null if `set` isn't one. */
function bracketResetSibling(
  set: StartggSet,
  byId: Map<string, StartggSet>,
): StartggSet | null {
  const [s0, s1] = set.slots || [];
  if (
    s0?.prereqType === "set" &&
    s1?.prereqType === "set" &&
    s0.prereqId &&
    s0.prereqId === s1.prereqId
  ) {
    const sibling = byId.get(s0.prereqId);
    if (sibling && sibling.round === set.round) return sibling;
  }
  return null;
}

function layoutSide(
  sideSets: StartggSet[],
  byId: Map<string, StartggSet>,
  colOf: (round: number) => number,
): LayoutSide {
  const columns: StartggSet[][] = [];
  for (const set of sideSets) {
    // A reset set shares its ROUND with the set that feeds it entirely
    // (see bracketResetSibling) -- grouping strictly by round would put
    // both in the same column, and since the reset's only feeder is
    // that one sibling set (referenced from both its own slots),
    // computeSideGeometry's feeder-Y averaging would then place it at
    // EXACTLY the sibling's own Y too -- the two boxes render fully on
    // top of each other (confirmed directly this way against Stage 7's
    // real Grand Final / Grand Final Reset pair). Bumping it one column
    // past its sibling's own gives it a column of its own, same as any
    // other set fed entirely by an earlier column's match.
    const baseCol = colOf(set.round ?? 0);
    const col = bracketResetSibling(set, byId) ? baseCol + 1 : baseCol;
    (columns[col] ??= []).push(set);
  }

  const rowIndexById = new Map<string, number>();
  const orderedColumns: LayoutMatch[][] = [];

  // .filter(...) collapses gaps in the sparse round->column mapping (e.g.
  // a losers side with no real matches yet at round -1/-2, only starting
  // at round -3 because those early rounds were all byes) so a match's
  // own `.col` always equals its actual visual column index. Without
  // this, computeSideGeometry (which positions purely by array index)
  // would draw these visually in column 0, while each match's own `.col`
  // still said 2 -- silently breaking anything that checks `col === 0`
  // to mean "the first visible column" (e.g. bracket-tree.tsx's
  // incoming-promotion-pill check).
  columns
    .filter((c): c is StartggSet[] => c != null)
    .forEach((colSets, col) => {
      let ordered: StartggSet[];
      if (col === 0) {
        // No earlier column to trace back to -- keep the order start.gg
        // itself returned (sortType: ROUND).
        ordered = colSets;
      } else {
        // Order by the average row-position of whichever earlier-column
        // sets feed into this one via prereqId, so paired matches land
        // adjacent (same idea as the mockup's connector-line midpoints,
        // computed here instead of drawn).
        const feederRow = (set: StartggSet): number => {
          const feederRows = (set.slots || [])
            .filter(
              (slot): slot is NonNullable<typeof slot> =>
                slot != null &&
                slot.prereqType === "set" &&
                slot.prereqId != null &&
                byId.has(slot.prereqId),
            )
            .map((slot) => rowIndexById.get(slot.prereqId!))
            .filter((r): r is number => r !== undefined);
          if (!feederRows.length) return Number.MAX_SAFE_INTEGER;
          return feederRows.reduce((a, b) => a + b, 0) / feederRows.length;
        };
        ordered = [...colSets].sort((a, b) => feederRow(a) - feederRow(b));
      }
      ordered.forEach((set, row) => rowIndexById.set(String(set.id), row));
      orderedColumns.push(ordered.map((set, row) => ({ set, col, row })));
    });

  return { columns: orderedColumns };
}

/** Which slot (if any) belongs to the winner of a completed set. */
export function winningSlotIndex(set: StartggSet): number | null {
  if (set.winnerId == null) return null;
  // String(...) both sides -- despite the type saying slot.entrant.id is
  // a string, live data shows it comes back as a raw number too (same as
  // Set.id elsewhere in this file), so the previous String(winnerId)-only
  // comparison never actually matched anything. Confirmed directly: a
  // real completed set's winnerId and its winning slot's entrant.id were
  // the same unquoted JSON number.
  const idx = (set.slots || []).findIndex(
    (slot) => slot?.entrant && String(set.winnerId) === String(slot.entrant.id),
  );
  return idx === -1 ? null : idx;
}

/** True once start.gg itself has marked the set Started (state === 2,
 * "ACTIVE" in their ActivityState enum) -- i.e. play has actually begun,
 * as reported by the TO/bracket runner, not just "both slots are filled
 * with nobody declared winner yet" (that heuristic also matched a set
 * that's merely been Called to a station but not yet started -- see
 * isSetCalled, a distinct state). */
export function isSetLive(set: StartggSet): boolean {
  return set.state === 2;
}

/** True once start.gg has Called the set to a station (state === 6) --
 * players have been notified/assigned a spot to play but haven't started
 * yet. Distinct from, and never simultaneous with, isSetLive: a set's
 * state is a single value, not independent flags. */
export function isSetCalled(set: StartggSet): boolean {
  return set.state === 6;
}

/** True once at least one slot has a real entrant -- used to dim matches
 * that are still several rounds out (both slots still TBD) so a viewer's
 * attention goes to what's actually happening now. */
export function hasAnyEntrant(set: StartggSet): boolean {
  return (set.slots || []).some((s) => s?.entrant);
}

/** A lookup from set id to the set itself, for resolving what an empty
 * slot is actually waiting on (see describeEmptySlot). Build once per
 * phase fetch and pass down -- every set in the phase's own `sets.nodes`
 * is a potential prereq target for another set in that same list. */
export type SetsById = Map<string, StartggSet>;
export function indexSetsById(sets: (StartggSet | null)[]): SetsById {
  // String(s.id) -- see layoutBracket's byId map for why: Set.id comes
  // back from the API as a number, but everything that looks this map up
  // (prereqId) is a string.
  return new Map(
    sets
      .filter((s): s is StartggSet => s != null)
      .map((s) => [String(s.id), s]),
  );
}

/** Describes an empty slot the way start.gg's own bracket page does --
 * "winner of A" / "loser of A" (the prereq set's own identifier letter,
 * lowercase leading word, matching their exact casing) for a same-phase
 * "set"-prereq slot, or the origin phase/group's own placeholderName
 * (e.g. "Stage 4 1: Winners") for a still-empty "seed"-prereq entry
 * slot whose eventual promotion is already determined -- confirmed
 * directly against a real screenshot showing exactly that text as the
 * slot's own inline name, distinct from (and in addition to) the
 * shorter "Stage 4" text on that slot's incoming-promotion pill (see
 * incomingProgressionLabel).
 *
 * `phantomSetsById` (optional -- see PhantomSet's own doc) extends the
 * "set"-prereq branch to a same-phase prereq start.gg's own `sets.nodes`
 * fetch didn't materialize, resolved via resolveThroughByes: either it
 * bye-collapses down to a real seed (handled by the seed branch below,
 * on the COLLAPSED slot) or it's a genuine still-pending phantom match
 * with its own identifier (e.g. "T"), described the same "winner of
 * X"/"loser of X" way as a normal same-phase connector.
 *
 * Falls back to plain "TBD" for a filled slot with no name, or a
 * prereq this phase's own fetch (real or phantom) can't resolve -- a
 * seed prereq with no confirmed progressionSource yet, e.g. a genuinely
 * undetermined future entry, not merely an unfilled one. */
export function describeEmptySlot(
  slot: StartggSetSlot | null,
  setsById: SetsById,
  seedProgressionById?: SeedProgressionById,
  phantomSetsById?: PhantomSetsById,
): string {
  if (slot?.entrant) return slot.entrant.name || "TBD";
  const effective = resolveThroughByes(slot, setsById, phantomSetsById);
  if (effective?.entrant) return effective.entrant.name || "TBD";
  if (effective?.prereqType === "set" && effective.prereqId) {
    const prereqLabel =
      setsById.get(effective.prereqId)?.identifier ??
      phantomSetsById?.get(effective.prereqId)?.identifier;
    if (prereqLabel) {
      if (effective.prereqPlacement === 1) return `winner of ${prereqLabel}`;
      if (effective.prereqPlacement === 2) return `loser of ${prereqLabel}`;
    }
  }
  if (effective?.prereqType === "seed" && effective.prereqId) {
    const placeholderName = seedProgressionById?.get(
      effective.prereqId,
    )?.placeholderName;
    if (placeholderName) return placeholderName;
  }
  return "TBD";
}

/** Every entrant id that appears anywhere in the WINNERS side of this
 * phase's own fetched sets -- used by incomingProgressionLabel to tell
 * "genuinely new to this phase's pool" apart from "already has a home in
 * this phase's winners bracket, just dropped to losers." Build once per
 * phase fetch from layoutBracket's own winners side (not the raw
 * sets list) so the winners/losers split logic lives in exactly one
 * place. */
export type WinnersEntrantIds = Set<string>;
export function indexWinnersEntrantIds(winners: LayoutSide): WinnersEntrantIds {
  const ids = new Set<string>();
  for (const col of winners.columns) {
    for (const match of col) {
      for (const slot of match.set.slots || []) {
        if (slot?.entrant) ids.add(String(slot.entrant.id));
      }
    }
  }
  return ids;
}

/** A phase's seed-id -> progressionSource lookup, built from the
 * top-level Phase.seeds connection (see StartggPhaseSeed's own doc for
 * why this exists as a separate fetch from the nested slot.seed field).
 * Keyed by seed id (string) since that's what a "prereqType: seed"
 * slot's own prereqId is compared against. Build once per phase fetch
 * from phase.seeds.nodes and pass down alongside setsById. */
export interface SeedProgression {
  originPhase: { id: string; name: string | null } | null;
  placeholderName: string | null;
}
export type SeedProgressionById = Map<string, SeedProgression>;
export function indexSeedProgressionById(
  seeds: (StartggPhaseSeed | null)[],
): SeedProgressionById {
  const map: SeedProgressionById = new Map();
  for (const seed of seeds) {
    if (seed?.id && seed.progressionSource) {
      map.set(String(seed.id), {
        originPhase: seed.progressionSource.originPhase,
        placeholderName: seed.progressionSource.placeholderName,
      });
    }
  }
  return map;
}

/** A "set" this phase's own `sets.nodes` fetch didn't include -- start.gg
 * only materializes REAL sets in that connection; a still-unstarted
 * bracket's deeper structural rounds (a losers-side bye-collapse chain,
 * confirmed directly: Stage 5's losers round 1 slots point at a
 * `prereqId` like "preview_3210993_-2_0" that never appears in
 * `phase.sets.nodes` at all, total:8 confirmed via pageInfo, no
 * pagination gap) exist only as synthetic ids, fetchable one at a time
 * via a direct `set(id:)` lookup -- see bracket-tree.tsx's
 * fetchPhantomSets, which does exactly that for whichever ids
 * collectUnresolvedSetPrereqIds below finds. Deliberately a SEPARATE,
 * minimal shape from StartggSet (no round/fullRoundText/etc -- nothing
 * here needs them, and the phantom fetch only asks for these fields). */
export interface PhantomSetSlot {
  prereqType: string | null;
  prereqId: string | null;
  prereqPlacement: number | null;
  entrant: { id: string; name: string | null } | null;
}
export interface PhantomSet {
  id: string;
  identifier: string | null;
  slots: (PhantomSetSlot | null)[] | null;
}
export type PhantomSetsById = Map<string, PhantomSet>;

/** Scans every slot of every given set for a "set"-prereq id that's
 * neither a real fetched set (setsById) nor an already-fetched phantom
 * one (alreadyFetched) -- the next round of ids bracket-tree.tsx's
 * fetch loop needs to ask for. Works on both real sets (StartggSet) and
 * freshly-fetched phantom sets (PhantomSet) so the same loop can walk
 * an arbitrarily deep bye-collapse chain (confirmed one level deep for
 * Stage 5, but not assumed to always be exactly one). */
export function collectUnresolvedSetPrereqIds(
  sets: (StartggSet | PhantomSet | null)[],
  setsById: SetsById,
  alreadyFetched: PhantomSetsById,
): string[] {
  const ids = new Set<string>();
  for (const set of sets) {
    for (const slot of set?.slots || []) {
      if (
        slot?.prereqType === "set" &&
        slot.prereqId &&
        !setsById.has(slot.prereqId) &&
        !alreadyFetched.has(slot.prereqId)
      ) {
        ids.add(slot.prereqId);
      }
    }
  }
  return [...ids];
}

/** Walks through a chain of bye-collapsed phantom sets to find the slot
 * that actually determines what belongs here. A "set"-prereq slot whose
 * target is a phantom set (not in setsById -- see PhantomSet's own doc)
 * with exactly ONE non-bye slot is mechanically equivalent to that one
 * slot directly: "the winner of a match where the only other entrant is
 * a bye" is trivially whoever's in the real slot, no actual match ever
 * happens. Confirmed directly against Stage 5: H's own row-0 slot points
 * at phantom set "T", which has one seed-prereq slot (the real
 * promotion) and one bye slot -- collapsing through it reaches the seed
 * directly, matching exactly what start.gg's own page shows there
 * ("Stage 4 1: Losers"), not "winner of T".
 *
 * Recurses (bounded by a hop-count safety cap, not assumed to always be
 * one level) since a bye-collapse chain can run deeper than a single
 * hop. Returns the slot UNCHANGED whenever there's nothing to collapse:
 * already a filled slot, a direct "seed" prereq, a "set" prereq already
 * resolved in setsById (describeEmptySlot's existing branch handles
 * that), a phantom set with more than one real slot (a genuine
 * still-undetermined match between two real paths -- not a mechanical
 * pass-through, so it keeps its own "winner of {phantom's own
 * identifier}" description instead), or a phantom id not (yet) fetched. */
export function resolveThroughByes(
  slot: StartggSetSlot | PhantomSetSlot | null,
  setsById: SetsById,
  phantomSetsById?: PhantomSetsById,
  depth = 0,
): StartggSetSlot | PhantomSetSlot | null {
  if (depth > 8) return slot;
  if (
    !slot ||
    slot.entrant ||
    slot.prereqType !== "set" ||
    !slot.prereqId ||
    setsById.has(slot.prereqId)
  ) {
    return slot;
  }
  const phantom = phantomSetsById?.get(slot.prereqId);
  if (!phantom) return slot;
  const realSlots = (phantom.slots || []).filter(
    (s): s is PhantomSetSlot => s != null && s.prereqType !== "bye",
  );
  if (realSlots.length !== 1) return slot;
  return resolveThroughByes(realSlots[0], setsById, phantomSetsById, depth + 1);
}

/** The "Stage X" pill start.gg draws on an entry-point slot when that
 * *specific slot's entrant* was actually placed here from an earlier
 * phase (pools feeding into a bracket, gauntlet stages, etc) -- just the
 * origin phase's own short name ("Stage 1"), matching start.gg's own
 * pill text exactly (confirmed directly against two separate real
 * screenshots of it; an earlier version of this used progressionSource's
 * own longer placeholderName, e.g. "Stage 1 1: Losers", which looked
 * plausible but doesn't match what start.gg actually puts on the pill
 * itself -- that fuller text turned out to belong to a different UI
 * element).
 *
 * NOT gated on prereqType === "seed" -- tried that (reasoning a slot fed
 * by prereqType "set", e.g. a losers-round slot filled by whoever lost
 * the corresponding winners-round match, isn't an external promotion
 * even when its seed's progressionSource still resolves to an earlier
 * phase), but a real screenshot of start.gg's own bracket directly
 * contradicted it: Stage 2's own H/I losers-round slots ARE prereqType
 * "set" and DO get a "Stage 1" pill on the real site sometimes. So
 * prereqType alone isn't the signal.
 *
 * What actually distinguishes them, confirmed directly against a real
 * screenshot: a losers-round-1 slot's entrant who ALSO appears somewhere
 * in this phase's winners side already "exists in the pool" via that
 * winners appearance -- they dropped down, they weren't newly promoted
 * into this bracket -- so the pill only belongs on their winners
 * appearance, not the losers one. An entrant who never appears in
 * winners at all (seeded directly into losers from an earlier phase) is
 * a genuine first entry and keeps the pill. `winnersEntrantIds` is that
 * cross-reference -- pass indexWinnersEntrantIds(layout.winners) for a
 * losers-side slot, and undefined (or an empty set) for a winners-side
 * slot, since a winners-round-1 entrant trivially "appearing in winners"
 * (via this exact set) must never suppress its own legitimate pill.
 *
 * Strictly data-driven on progressionSource itself, and ONLY that --
 * null whenever it's null, even for an otherwise-similar-looking
 * entry-point slot (real entrant, filled directly by seed, or a
 * genuinely empty slot in a phase that hasn't started yet). Several
 * earlier versions of this tried to guess a label for the "no confirmed
 * data yet" case -- "whichever phase runs immediately before this one"
 * by phaseOrder, or a phase-level Phase.progressingInData count applied
 * to any still-empty entry slot -- reasoning each time that some
 * plausible-sounding structural signal was probably close enough. Both
 * were wrong in verifiably different ways (confirmed directly against
 * live data each time: the phaseOrder guess mislabeled genuine fresh top
 * seeds as promoted; the progressingInData guess put duplicate pills on
 * both of a losers-round match's equally-undetermined slots with no
 * per-slot basis for either one). The number of promotion pills a real
 * phase has varies per event and isn't predictable from bracket
 * structure alone -- it's exactly however many slots progressionSource
 * actually confirms, no more, no fewer, and never a guess standing in
 * for data that doesn't exist yet. A pill's entire meaning is "this
 * specific player was promoted from the previous pool," so showing it
 * on anything less than a direct confirmation is wrong, not just
 * incomplete.
 *
 * `seedProgressionById` (optional, from indexSeedProgressionById) is
 * NOT a guess/fallback in that rejected sense -- it's the exact same
 * progressionSource field for the exact same seed, just fetched through
 * Phase.seeds instead of the nested slots[].seed path, because the
 * nested path returns null for a still-empty entry slot even when that
 * slot's eventual promotion is already fully determined (confirmed
 * directly: a real start.gg screenshot showed "Stage 4" pills on
 * Stage 5's still-empty entry slots, which the nested path alone
 * couldn't explain -- querying the same seed id via the top-level
 * connection resolved it).
 *
 * `setsById`/`phantomSetsById` (both optional -- pass both or neither)
 * handle the case where the slot doesn't reference a seed DIRECTLY but
 * through a bye-collapse chain of unmaterialized phantom sets (see
 * resolveThroughByes) -- e.g. Stage 5's losers-round-1 slots are
 * "prereqType: set" pointing at a phantom bye set, which is itself fed
 * by the real seed one hop deeper. Nested slot.seed is checked on the
 * ORIGINAL slot only (it's never fetched on a phantom set, so there's
 * nothing to check there) -- seedProgressionById covers the
 * bye-collapsed case uniformly instead. */
export function incomingProgressionLabel(
  slot: StartggSetSlot | null,
  currentPhaseId: string,
  winnersEntrantIds?: WinnersEntrantIds,
  seedProgressionById?: SeedProgressionById,
  setsById?: SetsById,
  phantomSetsById?: PhantomSetsById,
): string | null {
  const nestedOriginPhase = slot?.seed?.progressionSource?.originPhase;
  const effective = setsById
    ? resolveThroughByes(slot, setsById, phantomSetsById)
    : slot;
  const originPhase =
    nestedOriginPhase ??
    (effective?.prereqType === "seed" && effective.prereqId
      ? seedProgressionById?.get(effective.prereqId)?.originPhase
      : undefined);
  if (!originPhase || originPhase.id === currentPhaseId) return null;
  if (slot?.entrant && winnersEntrantIds?.has(String(slot.entrant.id))) {
    return null;
  }
  return originPhase.name;
}

export interface OutgoingProgression {
  winner: string | null;
  loser: string | null;
}

/** The "Stage X" pill start.gg draws where a connector would otherwise
 * go, when a set's winner/loser progresses into a *different phase*
 * instead of another set within this same phase fetch. Determined by
 * checking whether anything else in `setsById` actually consumes that
 * placement (a slot with prereqType "set", prereqId === this set's id,
 * and matching prereqPlacement) -- if nothing does, whatever
 * winner/loserProgressionSeed points at is where it actually goes, and
 * that's worth a pill only when it's not simply "eliminated" (no
 * progression seed at all, e.g. the loser of a losers-bracket set). */
export function outgoingProgression(
  set: StartggSet,
  setsById: SetsById,
): OutgoingProgression {
  const consumedPlacements = new Set<number>();
  const setId = String(set.id);
  for (const other of setsById.values()) {
    for (const slot of other.slots || []) {
      if (
        slot?.prereqType === "set" &&
        // String(...) -- same Set.id-vs-prereqId type mismatch as
        // indexSetsById above.
        slot.prereqId === setId &&
        slot.prereqPlacement != null
      ) {
        consumedPlacements.add(slot.prereqPlacement);
      }
    }
  }
  return {
    winner: consumedPlacements.has(1)
      ? null
      : (set.winnerProgressionSeed?.phase?.name ?? null),
    loser: consumedPlacements.has(2)
      ? null
      : (set.loserProgressionSeed?.phase?.name ?? null),
  };
}

export interface PositionedMatch extends LayoutMatch {
  x: number;
  y: number;
}

export interface SideGeometry {
  matches: PositionedMatch[];
  /** SVG path `d` strings, one per connector -- an elbow from a column's
   * right edge to the next column's left edge, same shape as a standard
   * bracket diagram. */
  connectors: string[];
  width: number;
  height: number;
}

export interface GeometryOptions {
  boxWidth: number;
  boxHeight: number;
  colGap: number;
  /** Vertical gap between column-0 boxes -- later columns space out
   * further automatically (their Y is the average of their feeders'),
   * this is only the base case with no feeders to average. */
  rowGap: number;
}

const DEFAULT_GEOMETRY_OPTIONS: GeometryOptions = {
  boxWidth: 200,
  boxHeight: 56,
  colGap: 48,
  rowGap: 24,
};

/**
 * Turns a LayoutSide's column/row ordering into actual pixel positions --
 * column 0 boxes are spaced evenly, and every later column's box is
 * vertically centered on the average Y of whichever earlier-column boxes
 * feed into it (traced via the same prereqId links layoutBracket used
 * for row order), which is what naturally produces the doubling gap and
 * elbow-connector look of a real bracket the wider you get into the
 * tree. Falls back to even spacing for a box with no traceable feeders
 * (e.g. a bye slot filled straight from a seed rather than a prior set).
 */
export function computeSideGeometry(
  side: LayoutSide,
  options: Partial<GeometryOptions> = {},
): SideGeometry {
  const opts = { ...DEFAULT_GEOMETRY_OPTIONS, ...options };
  const centerYById = new Map<string, number>();
  const matches: PositionedMatch[] = [];
  const connectors: string[] = [];

  side.columns.forEach((colMatches, col) => {
    const x = col * (opts.boxWidth + opts.colGap);
    colMatches.forEach((match) => {
      let centerY: number;
      if (col === 0) {
        centerY =
          match.row * (opts.boxHeight + opts.rowGap) + opts.boxHeight / 2;
      } else {
        const feederYs = (match.set.slots || [])
          .filter(
            (slot): slot is NonNullable<typeof slot> =>
              slot != null &&
              slot.prereqType === "set" &&
              slot.prereqId != null &&
              centerYById.has(slot.prereqId),
          )
          .map((slot) => centerYById.get(slot.prereqId!)!);
        centerY = feederYs.length
          ? feederYs.reduce((a, b) => a + b, 0) / feederYs.length
          : match.row * (opts.boxHeight + opts.rowGap) * Math.pow(2, col) +
            opts.boxHeight / 2;

        for (const feederY of feederYs) {
          const fromX = x - opts.colGap;
          connectors.push(connectorPath(fromX, feederY, x, centerY, opts));
        }
      }
      // String(...) -- same Set.id-is-actually-a-number vs prereqId-is-a-
      // string mismatch as layoutBracket's byId map above.
      centerYById.set(String(match.set.id), centerY);
      matches.push({ ...match, x, y: centerY - opts.boxHeight / 2 });
    });
  });

  const width =
    side.columns.length * opts.boxWidth +
    Math.max(0, side.columns.length - 1) * opts.colGap;
  const height =
    Math.max(0, ...matches.map((m) => m.y + opts.boxHeight)) || opts.boxHeight;

  return { matches, connectors, width, height };
}

/** A single continuous path with rounded corners (an "S-curve" elbow),
 * matching start.gg's own bracket connector style (verified by
 * inspecting a live start.gg bracket page's rendered SVG -- their
 * connectors use quarter-circle curves rather than sharp right angles,
 * this reproduces that shape as one path instead of their 3-piece
 * multi-svg approach). Degenerates to a straight horizontal line when
 * the two ends are already level. */
function connectorPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  opts: GeometryOptions,
): string {
  if (fromY === toY) {
    return `M${fromX},${fromY} H${toX}`;
  }
  const midX = fromX + opts.colGap / 2;
  const r = Math.min(12, Math.abs(toY - fromY) / 2, opts.colGap / 2);
  const sign = toY > fromY ? 1 : -1;
  return [
    `M${fromX},${fromY}`,
    `H${midX - r}`,
    `Q${midX},${fromY} ${midX},${fromY + r * sign}`,
    `V${toY - r * sign}`,
    `Q${midX},${toY} ${midX + r},${toY}`,
    `H${toX}`,
  ].join(" ");
}
