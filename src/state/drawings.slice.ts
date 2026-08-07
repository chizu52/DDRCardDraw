// oxlint-disable typescript/unbound-method
import {
  PayloadAction,
  Slice,
  createEntityAdapter,
  createSelector,
  createSlice,
} from "@reduxjs/toolkit";
import {
  CompoundSetId,
  Drawing,
  DrawnChart,
  EligibleChart,
  isGauntletMeta,
  MergedDrawing,
  newPlayer,
  Player,
  PlayerActionOnChart,
  SubDrawing,
  PlayerPickPlaceholder,
} from "../models/Drawing";
import { mergeDraws } from "./central";

export const drawingsAdapter = createEntityAdapter<Drawing>({});

/** payload is the drawing id */
type ActionOnSingleDrawing = PayloadAction<string>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ActionOnSingleChart<extra extends object = {}> = PayloadAction<{ drawingId: CompoundSetId; chartId: string } & extra>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type PlayerActionOnChartPayload<extra extends object = {}> = PayloadAction<{ drawingId: CompoundSetId; chartId: string; player: string; reorder: boolean } & extra>;

export const drawingsSlice = createSlice({
  name: "drawings",
  initialState: drawingsAdapter.getInitialState(),
  reducers: {
    addDrawing: drawingsAdapter.addOne,
    updateOne: drawingsAdapter.updateOne,
    removeOne(state, action: PayloadAction<CompoundSetId>) {
      const [mainId, subId] = action.payload;
      if (!subId) {
        return drawingsAdapter.removeOne(state, mainId);
      }
      const drawing = state.entities[mainId];
      if (drawing.subDrawings) {
        const target = drawing.subDrawings[subId];
        delete drawing.subDrawings[subId];
        for (const chart of target.charts) {
          delete drawing.winners[chart.id];
          delete drawing.pocketPicks[chart.id];
          delete drawing.bans[chart.id];
          delete drawing.protects[chart.id];
          delete drawing.tiebreakers[chart.id];
        }
      }
    },
    clearDrawings: drawingsAdapter.removeAll,
    addOneChart(
      state,
      action: PayloadAction<{ drawingId: CompoundSetId; chart: DrawnChart | PlayerPickPlaceholder }>,
    ) {
      const [, target] = getDrawingFromCompoundId(
        state,
        action.payload.drawingId,
      );
      target.charts.push(action.payload.chart);
    },
    updateOneChart(
      state,
      action: PayloadAction<{ drawingId: CompoundSetId; chartId: string; changes: Partial<DrawnChart> }>,
    ) {
      const [, target] = getDrawingFromCompoundId(
        state,
        action.payload.drawingId,
      );
      const chart = target.charts.find((c) => c.id === action.payload.chartId);
      if (!chart) {
        return;
      }
      Object.assign(chart, action.payload.changes);
    },
    updatePlayers(
      state,
      action: PayloadAction<{ id: string; title: string; players: Player[] }>,
    ) {
      const { id, title, players } = action.payload;
      const drawing = state.entities[id];
      if (!drawing) {
        return;
      }

      const remainingIds = new Set(players.map((p) => p.id));

      for (const [chartId, winner] of Object.entries(drawing.winners)) {
        if (winner !== null && !remainingIds.has(winner)) {
          delete drawing.winners[chartId];
        }
      }

      for (const record of [
        drawing.bans,
        drawing.protects,
        drawing.pocketPicks,
      ]) {
        for (const [chartId, entry] of Object.entries(record)) {
          if (entry && !remainingIds.has(entry.player)) {
            delete record[chartId];
          }
        }
      }

      if (drawing.priorityPlayer && !remainingIds.has(drawing.priorityPlayer)) {
        drawing.priorityPlayer = undefined;
      }

      drawing.meta.title = title;
      drawing.meta.players = players;
    },
    swapPlayerPositions(state, action: ActionOnSingleDrawing) {
      const mainId = action.payload;
      const drawing = state.entities[mainId];
      if (!drawing) {
        return;
      }
      drawing.meta.players.reverse();
    },
    incrementPriorityPlayer(state, action: ActionOnSingleDrawing) {
      const mainId = action.payload;
      const drawing = state.entities[mainId];
      if (!drawing) {
        return;
      }
      const players = drawing.meta.players;
      const currentIndex = drawing.priorityPlayer
        ? players.findIndex((p) => p.id === drawing.priorityPlayer)
        : -1;
      const next = players[currentIndex + 1];
      drawing.priorityPlayer = next?.id;
    },
    resetChart(state, action: ActionOnSingleChart) {
      const { chartId, drawingId } = action.payload;
      const [drawing] = getDrawingFromCompoundId(state, drawingId);
      if (!drawing) return;
      delete drawing.bans[chartId];
      delete drawing.protects[chartId];
      delete drawing.pocketPicks[chartId];
      delete drawing.tiebreakers[chartId];
      delete drawing.actionTimestamps[chartId];
      drawing.pickOrder = (drawing.pickOrder || []).filter((id) => id !== chartId);
    },
    banProtectReplace(
      state,
      action: PlayerActionOnChartPayload<{ type: "ban" | "protect" } | { type: "pocket"; pick: EligibleChart }>,
    ) {
      const { chartId, drawingId, player, reorder } = action.payload;
      const [drawing, target] = getDrawingFromCompoundId(state, drawingId);
      if (!drawing) {
        return;
      }
      const playerAction: PlayerActionOnChart = { chartId, player };
      if (action.payload.type === "ban") {
        if (reorder) {
          target.charts = moveChartInArray(drawing, target.charts, chartId, "end");
        }
        drawing.bans[chartId] = playerAction;
        if (!drawing.actionTimestamps) drawing.actionTimestamps = {};
        drawing.actionTimestamps[chartId] = Date.now();
      } else if (action.payload.type === "protect") {
        if (reorder) {
          target.charts = moveChartInArray(drawing, target.charts, chartId, "start");
        }
        drawing.protects[chartId] = playerAction;
        if (!drawing.pickOrder) drawing.pickOrder = [];
        if (!drawing.pickOrder.includes(chartId)) drawing.pickOrder.push(chartId);
        if (!drawing.actionTimestamps) drawing.actionTimestamps = {};
        drawing.actionTimestamps[chartId] = Date.now();
      } else if (action.payload.type === "pocket") {
        if (reorder) {
          target.charts = moveChartInArray(drawing, target.charts, chartId, "start");
        }
        drawing.pocketPicks[chartId] = { chartId, player, pick: action.payload.pick };
        if (!drawing.pickOrder) drawing.pickOrder = [];
        if (!drawing.pickOrder.includes(chartId)) drawing.pickOrder.push(chartId);
        if (!drawing.actionTimestamps) drawing.actionTimestamps = {};
        drawing.actionTimestamps[chartId] = Date.now();
      }
    },
    setTiebreaker(state, action: ActionOnSingleChart<{ value: boolean }>) {
      const { chartId, drawingId, value } = action.payload;
      const [drawing] = getDrawingFromCompoundId(state, drawingId);
      if (!drawing) return;
      if (!drawing.tiebreakers) drawing.tiebreakers = {};
      if (value) {
        drawing.tiebreakers[chartId] = true;
        if (!drawing.pickOrder) drawing.pickOrder = [];
        if (!drawing.pickOrder.includes(chartId)) drawing.pickOrder.push(chartId);
        if (!drawing.actionTimestamps) drawing.actionTimestamps = {};
        drawing.actionTimestamps[chartId] = Date.now();
      } else {
        delete drawing.tiebreakers[chartId];
        drawing.pickOrder = (drawing.pickOrder || []).filter((id) => id !== chartId);
      }
    },
    setWinner(state, action: ActionOnSingleChart<{ player: string | null }>) {
      const [drawing] = getDrawingFromCompoundId(
        state,
        action.payload.drawingId,
      );
      const winners = drawing.winners;
      if (action.payload.player === null) {
        delete winners[action.payload.chartId];
      } else {
        winners[action.payload.chartId] = action.payload.player;
      }
    },
    addPlayerScore(
      state,
      action: PayloadAction<{ drawingId: CompoundSetId; chartId: string; playerId: string; score: number }>,
    ) {
      const { drawingId, playerId, chartId, score } = action.payload;
      const [mainId] = drawingId;
      const drawing = state.entities[mainId];
      if (!drawing) {
        return;
      }
      if (!isGauntletMeta(drawing.meta)) {
        return;
      }
      if (!drawing.meta.scoresByEntrant) {
        drawing.meta.scoresByEntrant = {};
        for (const entrant of drawing.meta.players) {
          drawing.meta.scoresByEntrant[entrant.id] = {};
        }
      }
      drawing.meta.scoresByEntrant[playerId][chartId] = score;
    },
    addSubdraw(
      state,
      action: PayloadAction<{ newSubdraw: SubDrawing; existingDrawId: string }>,
    ) {
      const { existingDrawId, newSubdraw } = action.payload;
      const existingDraw = state.entities[existingDrawId];
      if (!existingDraw.subDrawings) {
        existingDraw.subDrawings = {};
      }
      existingDraw.subDrawings[newSubdraw.compoundId[1]] = newSubdraw;
    },
    updateCharts(
      state,
      action: PayloadAction<{ drawId: CompoundSetId; newCharts: SubDrawing["charts"] }>,
    ) {
      const { newCharts, drawId } = action.payload;
      const [parent, target] = getDrawingFromCompoundId(state, drawId);
      for (const chart of target.charts) {
        if (!newCharts.some((c) => c.id === chart.id)) {
          delete parent.winners[chart.id];
          delete parent.bans[chart.id];
          delete parent.pocketPicks[chart.id];
          delete parent.protects[chart.id];
          delete parent.tiebreakers[chart.id];
          delete parent.actionTimestamps[chart.id];
        }
      }
      target.charts = newCharts;
    },
  },
  extraReducers(builder) {
    builder.addCase(
      mergeDraws,
      (state, { payload: { drawingId, newSubdrawId } }) => {
        const draw = state.entities[drawingId];
        if (!draw) return;
        const oldDraws = draw.subDrawings;
        draw.subDrawings = {
          [newSubdrawId]: {
            compoundId: [drawingId, newSubdrawId],
            configId: draw.configId,
            charts: Object.values(oldDraws).flatMap(
              (subDraw) => subDraw.charts,
            ),
          },
        };
      },
    );
  },
  selectors: {
    haveDrawings(state) {
      return !!state.ids.length;
    },
    byCompoundOrPlainId(state, id: CompoundSetId | string) {
      if (typeof id === "string") return [state.entities[id]];
      return getDrawingFromCompoundId(state, id);
    },
    selectMergedByCompoundId(state, compoundId: CompoundSetId) {
      return selectMergedByCompoundId(state, compoundId);
    },
  },
});

export const drawingSelectors = drawingsAdapter.getSelectors(
  drawingsSlice.selectSlice,
);

type StateOfSlice<S> = S extends Slice<infer State> ? State : never;

export function migrateToSubdraws(state: StateOfSlice<typeof drawingsSlice>) {
  for (const id of state.ids) {
    const parent = state.entities[id];
    if (parent.subDrawings) {
      for (const [subId, subDraw] of Object.entries(parent.subDrawings)) {
        // @ts-expect-error this field no longer exists
        delete subDraw.id;
        if (!subDraw.compoundId) {
          subDraw.compoundId = [parent.id, subId];
        }
      }
    } else {
      parent.subDrawings = {};
    }
    if (parent.charts) {
      parent.subDrawings[parent.id] = {
        compoundId: [parent.id, parent.id],
        configId: parent.configId,
        charts: parent.charts,
      };
      delete parent.charts;
    }
  }
}

export function migratePlayersToIds(state: StateOfSlice<typeof drawingsSlice>) {
  for (const id of state.ids) {
    const drawing = state.entities[id];
    if (!drawing) {
      continue;
    }
    const legacyDrawing = drawing as unknown as { playerDisplayOrder?: Array<number | string>; priorityPlayer?: number | string };
    const legacyOrder = legacyDrawing.playerDisplayOrder;
    if (!legacyOrder) {
      continue;
    }

    const legacyMeta = drawing.meta as unknown as { players?: Array<string | Player>; entrants?: Player[] };
    const rawPlayers = legacyMeta.players ?? legacyMeta.entrants ?? [];

    const players: Player[] = rawPlayers.map((p) =>
      typeof p === "string" ? newPlayer(p) : p,
    );

    const idFor = (ref: number | string): string | undefined =>
      typeof ref === "number" ? players[ref]?.id : ref;

    const byId = new Map(players.map((p) => [p.id, p]));
    const ordered: Player[] = [];
    for (const ref of legacyOrder) {
      const player = byId.get(idFor(ref)!);
      if (player) {
        ordered.push(player);
        byId.delete(player.id);
      }
    }
    ordered.push(...byId.values());

    drawing.meta.players = ordered;
    delete legacyMeta.entrants;
    delete legacyDrawing.playerDisplayOrder;

    const legacyWinners = drawing.winners as Record<string, number | string | null>;
    for (const [chartId, val] of Object.entries(legacyWinners)) {
      if (val === null) {
        continue;
      }
      const winnerId = idFor(val);
      if (winnerId === undefined) {
        delete drawing.winners[chartId];
      } else {
        drawing.winners[chartId] = winnerId;
      }
    }

    for (const record of [
      drawing.bans,
      drawing.protects,
      drawing.pocketPicks,
    ]) {
      for (const [chartId, entry] of Object.entries(record)) {
        if (!entry) {
          continue;
        }
        const action = entry as { player: number | string };
        const playerId = idFor(action.player);
        if (playerId === undefined) {
          delete record[chartId];
        } else {
          action.player = playerId;
        }
      }
    }

    const priority = legacyDrawing.priorityPlayer;
    if (typeof priority === "number") {
      drawing.priorityPlayer = ordered[priority - 1]?.id;
    }
  }
}

export function getDrawingFromCompoundId(
  state: StateOfSlice<typeof drawingsSlice>,
  id: CompoundSetId,
): [parent: Drawing, target: SubDrawing] {
  const [mainId, subId] = id;
  const drawing = state.entities[mainId];
  return [drawing, drawing.subDrawings[subId]];
}

const selectMergedByCompoundId = createSelector(
  [
    (s: StateOfSlice<typeof drawingsSlice>, drawingId: CompoundSetId) =>
      s.entities[drawingId[0]],
    (s: StateOfSlice<typeof drawingsSlice>, drawingId: CompoundSetId) =>
      s.entities[drawingId[0]]?.subDrawings?.[drawingId[1]],
  ],
  (drawing, subDrawing): MergedDrawing => {
    return { ...drawing, ...subDrawing };
  },
);

function moveChartInArray(
  drawing: Drawing,
  charts: SubDrawing["charts"],
  chartId: string,
  pos: "start" | "end",
) {
  const targetChart = charts.find((c) => c.id === chartId);
  if (!targetChart) {
    return charts;
  }
  const chartsWithoutTarget = charts.filter((c) => c.id !== chartId);
  if (pos === "start") {
    const insertIdx =
      Object.keys(drawing.protects).length +
      Object.keys(drawing.pocketPicks).length;
    chartsWithoutTarget.splice(insertIdx, 0, targetChart);
  } else {
    chartsWithoutTarget.push(targetChart);
  }
  return chartsWithoutTarget;
}
