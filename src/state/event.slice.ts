import { PayloadAction, createSelector, createSlice } from "@reduxjs/toolkit";
import { nanoid } from "nanoid";
import { CompoundSetId } from "../models/Drawing";
import { DEFAULT_ROW_COLOR_TIERS, RowColorTiers } from "../sheets/row-colors";
import { mergeDraws } from "./central";

export interface CabInfo {
  /** drawing id if active */
  activeMatch: CompoundSetId | string | null;
  name: string;
  id: string;
}

interface EventState {
  eventName: string;
  cabs: Record<string, CabInfo>;
  obsLabels: Record<string, { label: string; value: string }>;
  obsCss: string;
  /** Which pool the pool-results OBS overlay (obs-sources/pool-results.tsx)
   * currently shows -- room-synced so switching pools on stream is just a
   * button click in the Matches tab, not a new OBS browser source URL. */
  selectedPool: string | null;
  /** Bumped (to Date.now()) whenever the Matches tab wants every connected
   * pool-results overlay to refetch from Sheets immediately, instead of
   * waiting for its own poll interval -- see dashboard.tsx's exportPool. */
  poolsRefreshedAt: number;
  /** Same settings as sheets-creds-manager.tsx's other Sheets config, but
   * room-synced (not device-local) since they affect what the overlay
   * displays for everyone, not just this device -- see
   * tournament-mode/dashboard.tsx's MatchesSettingsPanel. */
  overlayAdvanceCount: number;
  overlayRowColors: boolean;
  /** Which placement tiers get colored when overlayRowColors is on --
   * lets the user pick e.g. gold+silver only (the original behavior) vs.
   * also coloring bronze/4th-and-below. See sheets/row-colors.ts. */
  overlayRowColorTiers: RowColorTiers;
  /** Which start.gg phase the bracket-tree OBS overlay
   * (obs-sources/bracket-tree.tsx) currently shows -- a phase id, same
   * room-synced "pick it from the Matches Settings tab, not a new OBS
   * URL" pattern as selectedPool. */
  selectedBracketPhase: string | null;
  /** Same idea as poolsRefreshedAt -- bumped to force every connected
   * bracket-tree overlay to refetch from start.gg immediately. */
  bracketRefreshedAt: number;
}

const initialState: EventState = {
  eventName: "",
  cabs: {
    default: {
      id: "default",
      name: "Primary Cab",
      activeMatch: null,
    },
  },
  obsLabels: {},
  obsCss: `h1 {
  /* add text styles here */
}`,
  selectedPool: null,
  poolsRefreshedAt: 0,
  overlayAdvanceCount: 1,
  overlayRowColors: true,
  overlayRowColorTiers: DEFAULT_ROW_COLOR_TIERS,
  selectedBracketPhase: null,
  bracketRefreshedAt: 0,
};

export const eventSlice = createSlice({
  name: "event",
  initialState,
  reducers: {
    /** add a cab with its name */
    addCab: {
      // the id must be minted here rather than in the reducer: actions
      // replay on the party server and other clients, and every replica
      // has to produce an identical cab
      prepare(name: string) {
        return { payload: { name, id: nanoid(5) } };
      },
      reducer(state, action: PayloadAction<{ name: string; id: string }>) {
        state.cabs[action.payload.id] = {
          id: action.payload.id,
          name: action.payload.name,
          activeMatch: null,
        };
      },
    },
    removeCab(state, action: PayloadAction<string>) {
      delete state.cabs[action.payload];
    },
    clearCabAssignment(state, action: PayloadAction<string>) {
      const cab = state.cabs[action.payload];
      if (!cab) return;
      cab.activeMatch = null;
    },
    assignMatchToCab(
      state,
      action: PayloadAction<{ cabId: string; matchId: string }>,
    ) {
      const cab = state.cabs[action.payload.cabId];
      if (!cab) return;
      cab.activeMatch = action.payload.matchId;
    },
    assignSetToCab(
      state,
      action: PayloadAction<{ cabId: string; matchId: CompoundSetId }>,
    ) {
      const cab = state.cabs[action.payload.cabId];
      if (!cab) return;
      cab.activeMatch = action.payload.matchId;
    },
    updateLabel(
      state,
      action: PayloadAction<{ id: string; value: string; label: string }>,
    ) {
      state.obsLabels[action.payload.id] = {
        label: action.payload.label,
        value: action.payload.value,
      };
    },
    removeLabel(state, action: PayloadAction<{ id: string }>) {
      delete state.obsLabels[action.payload.id];
    },
    updateObsCss(state, action: PayloadAction<string>) {
      state.obsCss = action.payload;
    },
    setSelectedPool(state, action: PayloadAction<string | null>) {
      state.selectedPool = action.payload;
    },
    // No payload needed -- every connected overlay just refetches its
    // already-selected pool. The timestamp only exists so the action has a
    // unique-ish body (equal-looking repeat actions still need to look like
    // a "change" to the sync layer).
    signalPoolsRefresh: {
      prepare() {
        return { payload: Date.now() };
      },
      reducer(state, action: PayloadAction<number>) {
        state.poolsRefreshedAt = action.payload;
      },
    },
    setOverlayAdvanceCount(state, action: PayloadAction<number>) {
      state.overlayAdvanceCount = action.payload;
    },
    setOverlayRowColors(state, action: PayloadAction<boolean>) {
      state.overlayRowColors = action.payload;
    },
    setOverlayRowColorTier(
      state,
      action: PayloadAction<{ tier: keyof RowColorTiers; enabled: boolean }>,
    ) {
      state.overlayRowColorTiers[action.payload.tier] = action.payload.enabled;
    },
    setSelectedBracketPhase(state, action: PayloadAction<string | null>) {
      state.selectedBracketPhase = action.payload;
    },
    signalBracketRefresh: {
      prepare() {
        return { payload: Date.now() };
      },
      reducer(state, action: PayloadAction<number>) {
        state.bracketRefreshedAt = action.payload;
      },
    },
  },
  extraReducers(builder) {
    builder.addCase(mergeDraws, (state, { payload }) => {
      for (const cab of Object.values(state.cabs)) {
        if (
          Array.isArray(cab.activeMatch) &&
          cab.activeMatch[0] === payload.drawingId
        ) {
          cab.activeMatch[1] = payload.newSubdrawId;
        }
      }
    });
  },
  selectors: {
    allCabs: createSelector([(state: EventState) => state.cabs], (cabs) => {
      return Object.values(cabs);
    }),
  },
});

export function addObsLabels(state: EventState) {
  if (!state.obsLabels) {
    state.obsLabels = {};
  }
}

/** Rooms that existed before the pool-results overlay's room-synced
 * fields were added won't have them in their persisted state --
 * receivePartyState replaces event state wholesale (see root-reducer.ts),
 * so an old room's state would otherwise leave these `undefined` forever
 * instead of falling back to initialState's defaults. */
export function addOverlaySettings(state: EventState) {
  if (state.selectedPool === undefined) {
    state.selectedPool = null;
  }
  if (state.poolsRefreshedAt === undefined) {
    state.poolsRefreshedAt = 0;
  }
  if (state.overlayAdvanceCount === undefined) {
    state.overlayAdvanceCount = 1;
  }
  if (state.overlayRowColors === undefined) {
    state.overlayRowColors = true;
  }
  if (!state.overlayRowColorTiers) {
    state.overlayRowColorTiers = { ...DEFAULT_ROW_COLOR_TIERS };
  }
  if (state.selectedBracketPhase === undefined) {
    state.selectedBracketPhase = null;
  }
  if (state.bracketRefreshedAt === undefined) {
    state.bracketRefreshedAt = 0;
  }
}
