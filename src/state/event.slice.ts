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

export interface ScheduleItem {
  /** Wall-clock, as typed by the user (e.g. "20:30") -- stored and
   * rendered as-is, no timezone conversion. See obs-sources/schedule.tsx
   * and dashboard.tsx's ScheduleDayEditor. */
  time?: string;
  event?: string;
  description?: string;
  /** "This is happening right now" -- at most one true per day's list.
   * Mutual exclusivity is enforced by the editor's own radio-column UI
   * (dashboard.tsx's ScheduleDayEditor), not by this type; nothing
   * technically stops two items both saying true, the editor just never
   * produces that. Renders as a soft green highlight on the overlay. */
  current?: boolean;
  /** "This already happened" -- independent per row, unlike `current`
   * (any number of earlier items can be true at once as the event
   * progresses). Renders as a soft gray-out on the overlay. */
  completed?: boolean;
  /** Hex color (e.g. "#7ed9b5"), picked per row in dashboard.tsx's
   * ScheduleDayEditor -- tints that row's border and its time pill's
   * border on the overlay. Absent renders both with their plain neutral
   * default, same "no color means the default" idea as everything else
   * optional on this type. */
  color?: string;
}

export type ScheduleDay = "fri" | "sat" | "sun";

/** The schedule overlay's train-station-style status badge -- operator
 * set (dashboard.tsx's ScheduleSettingsSection radios + minutes box),
 * not computed from row times vs. the clock: a live event's actual
 * "are we ahead/behind" call is a judgment the person running it makes,
 * not something derivable purely from whichever row happens to be
 * marked current. */
export type ScheduleStatusState = "ahead" | "onTime" | "delayed";

/** Fallback for a day with no status set yet -- a stable module-level
 * reference (not a fresh object literal inline at each selector call),
 * same reasoning as EMPTY_SCHEDULE in obs-sources/schedule.tsx: a new
 * object every render reads as "changed" to react-redux's reference
 * check even when the underlying value didn't actually change. */
export const DEFAULT_SCHEDULE_STATUS: {
  state: ScheduleStatusState;
  minutes: number;
} = { state: "onTime", minutes: 0 };

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
  /** Per-day event schedule shown by the schedule OBS overlay
   * (obs-sources/schedule.tsx), room-synced like everything else here --
   * edited from dashboard.tsx's Schedule tab. Absent days (or an absent
   * key entirely) just render no rows, same as an empty array. */
  schedules: Partial<Record<ScheduleDay, ScheduleItem[]>>;
  /** Which day the schedule OBS overlay currently shows -- one stable
   * overlay URL (routableSchedulePath), switched live from the dashboard
   * the same room-synced "pick it here, not a new OBS URL" pattern as
   * selectedPool/selectedBracketPhase, rather than one separate URL per
   * day. */
  selectedScheduleDay: ScheduleDay | null;
  /** Bumped (to Date.now()) every time ANY day's schedule is submitted --
   * see setDaySchedule's own prepare(). The overlay keys its entrance
   * animation on this alongside selectedScheduleDay, so submitting an
   * edit replays the animation the same way switching days already did,
   * not just on the overlay's first page load. Global rather than
   * per-day: if an edit lands for a day that isn't currently displayed,
   * a harmless extra replay on the visible (unrelated) day is a fair
   * trade for not needing a whole Record<ScheduleDay, number> just to
   * avoid it. */
  scheduleUpdatedAt: number;
  /** A free-text caption shown on the schedule overlay under its
   * "Schedule" title -- global to the whole overlay, not per-day (e.g.
   * an event/venue name), unlike everything else in `schedules`. Empty
   * string renders nothing, same "absent means don't show it" idea as
   * an empty day's item list. */
  scheduleSubtitle: string;
  /** A small logo/icon shown to the left of the schedule overlay's
   * title, picked from the operator's own computer (dashboard.tsx's
   * ScheduleSettingsSection) -- stored as a data URL directly in
   * room-synced state, same as scheduleSubtitle, rather than a file
   * path, since there's no server-side upload/asset host for this app
   * to save an actual file to. null renders nothing, same "absent means
   * don't show it" idea as scheduleSubtitle's empty string. */
  scheduleIcon: string | null;
  /** Per-day header badge state + the number shown alongside it (e.g.
   * "Delayed 15" -- minutes, though nothing here enforces that unit;
   * it's just whatever number the operator typed). Per-day, not global,
   * like `schedules` -- Friday running behind doesn't mean Saturday
   * (a fresh day, probably starting back on schedule) should show
   * "Delayed" too the moment its tab is opened. Absent day means
   * DEFAULT_SCHEDULE_STATUS, same "absent means the default" idea as
   * everything else here. See ScheduleStatusState above. */
  scheduleStatus: Partial<
    Record<ScheduleDay, { state: ScheduleStatusState; minutes: number }>
  >;
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
  schedules: {},
  selectedScheduleDay: null,
  scheduleUpdatedAt: 0,
  scheduleSubtitle: "",
  scheduleIcon: null,
  scheduleStatus: {},
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
    // Replaces a whole day's item list -- the editor (dashboard.tsx's
    // ScheduleDayEditor) buffers edits locally and only dispatches this
    // on explicit "Submit," same deliberate-refresh pattern as
    // signalPoolsRefresh/signalBracketRefresh above, so the live overlay
    // doesn't flicker on every keystroke. Embeds its own updatedAt
    // (rather than a separate signal action) so scheduleUpdatedAt bumps
    // atomically with the content it's describing, in the same action.
    setDaySchedule: {
      prepare(payload: { day: ScheduleDay; items: ScheduleItem[] }) {
        return { payload: { ...payload, updatedAt: Date.now() } };
      },
      reducer(
        state,
        action: PayloadAction<{
          day: ScheduleDay;
          items: ScheduleItem[];
          updatedAt: number;
        }>,
      ) {
        state.schedules[action.payload.day] = action.payload.items;
        state.scheduleUpdatedAt = action.payload.updatedAt;
      },
    },
    setSelectedScheduleDay(state, action: PayloadAction<ScheduleDay | null>) {
      state.selectedScheduleDay = action.payload;
    },
    // Same buffer-locally-then-submit pattern as setDaySchedule, and
    // also bumps scheduleUpdatedAt for the same reason -- a custom
    // caption shown right on the overlay is still "the overlay's
    // content changed," same as its schedule rows.
    setScheduleSubtitle: {
      prepare(subtitle: string) {
        return { payload: { subtitle, updatedAt: Date.now() } };
      },
      reducer(
        state,
        action: PayloadAction<{ subtitle: string; updatedAt: number }>,
      ) {
        state.scheduleSubtitle = action.payload.subtitle;
        state.scheduleUpdatedAt = action.payload.updatedAt;
      },
    },
    // Same pattern as setScheduleSubtitle -- null (rather than an empty
    // string, since there's no meaningful "empty" data URL) clears it.
    setScheduleIcon: {
      prepare(icon: string | null) {
        return { payload: { icon, updatedAt: Date.now() } };
      },
      reducer(
        state,
        action: PayloadAction<{ icon: string | null; updatedAt: number }>,
      ) {
        state.scheduleIcon = action.payload.icon;
        state.scheduleUpdatedAt = action.payload.updatedAt;
      },
    },
    // Per-day (see scheduleStatus's own doc) -- staged alongside that
    // day's own rows in dashboard.tsx's ScheduleDayEditor and sent by
    // the same Submit click, not dispatched live the instant the
    // operator touches the radio.
    setScheduleStatus: {
      prepare(status: {
        day: ScheduleDay;
        state: ScheduleStatusState;
        minutes: number;
      }) {
        return { payload: { ...status, updatedAt: Date.now() } };
      },
      reducer(
        state,
        action: PayloadAction<{
          day: ScheduleDay;
          state: ScheduleStatusState;
          minutes: number;
          updatedAt: number;
        }>,
      ) {
        state.scheduleStatus[action.payload.day] = {
          state: action.payload.state,
          minutes: action.payload.minutes,
        };
        state.scheduleUpdatedAt = action.payload.updatedAt;
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
  if (!state.schedules) {
    state.schedules = {};
  }
  if (state.selectedScheduleDay === undefined) {
    state.selectedScheduleDay = null;
  }
  if (state.scheduleUpdatedAt === undefined) {
    state.scheduleUpdatedAt = 0;
  }
  if (state.scheduleSubtitle === undefined) {
    state.scheduleSubtitle = "";
  }
  if (state.scheduleIcon === undefined) {
    state.scheduleIcon = null;
  }
  // Was a single global {state,minutes} object before scheduleStatus
  // went per-day -- an old room's persisted value here wouldn't match
  // the new Partial<Record<ScheduleDay, ...>> shape at all, so it's
  // discarded (reset to {}) rather than migrated into some arbitrary
  // day.
  if (
    !state.scheduleStatus ||
    typeof (state.scheduleStatus as { state?: unknown }).state === "string"
  ) {
    state.scheduleStatus = {};
  }
}
