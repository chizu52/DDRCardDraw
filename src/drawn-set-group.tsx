import { useMemo } from "react";
import { DrawingProvider } from "./drawing-context";
import DrawnSet, { ChartList, ChartFromContext } from "./drawn-set";
import { useRotatingGradientStyles } from "./hooks/useRotatingGradient";
import { useAppState } from "./state/store";
import { MatchLabels } from "./tournament-mode/drawing-labels";
import styles from "./drawn-set-group.css";
import { MatchActions } from "./tournament-mode/drawing-actions";
import { CompoundSetId, playerNameById } from "./models/Drawing";

export function useOrderedSpecialPicks(drawingId: string) {
  const drawing = useAppState((s) => s.drawings.entities[drawingId]);
  return useMemo(() => {
    if (!drawing?.subDrawings) return [];
    const pickOrder = drawing.pickOrder || [];
    const chartLocation = new Map<string, CompoundSetId>();
    for (const subDraw of Object.values(drawing.subDrawings)) {
      for (const chart of subDraw.charts) {
        chartLocation.set(chart.id, subDraw.compoundId);
      }
    }
    return pickOrder
      .filter((id) => chartLocation.has(id))
      .map((chartId) => ({
        chartId,
        compoundId: chartLocation.get(chartId)!,
      }));
  }, [drawing]);
}

export interface ExportRow {
  songName: string;
  difficulty: string;
  pickType: "Protect" | "Pocket Pick" | "Tiebreaker";
  player: string;
}

export function useExportRows(drawingId: string): ExportRow[] {
  const drawing = useAppState((s) => s.drawings.entities[drawingId]);
  return useMemo(() => {
    if (!drawing?.subDrawings) return [];
    const pickOrder = drawing.pickOrder || [];
    const chartLookup = new Map<string, { name: string; diffAbbr: string }>();
    for (const subDraw of Object.values(drawing.subDrawings)) {
      for (const chart of subDraw.charts) {
        if ("name" in chart) {
          chartLookup.set(chart.id, { name: chart.name, diffAbbr: chart.diffAbbr });
        }
      }
    }

    const rows: ExportRow[] = [];
    for (const chartId of pickOrder) {
      const chartInfo = chartLookup.get(chartId);
      if (!chartInfo) continue;

      if (drawing.tiebreakers?.[chartId]) {
        rows.push({
          songName: chartInfo.name,
          difficulty: chartInfo.diffAbbr,
          pickType: "Tiebreaker",
          player: "",
        });
        continue;
      }
      const protect = drawing.protects[chartId];
      if (protect) {
        rows.push({
          songName: chartInfo.name,
          difficulty: chartInfo.diffAbbr,
          pickType: "Protect",
          player: playerNameById(drawing.meta, protect.player),
        });
        continue;
      }
      const pocketPick = drawing.pocketPicks[chartId];
      if (pocketPick) {
        rows.push({
          songName: chartInfo.name,
          difficulty: chartInfo.diffAbbr,
          pickType: "Pocket Pick",
          player: playerNameById(drawing.meta, pocketPick.player),
        });
      }
    }
    return rows;
  }, [drawing]);
}

function InlineSpecialPicksRow({ drawingId }: { drawingId: string }) {
  const items = useOrderedSpecialPicks(drawingId);
  return (
    <div id={`special-picks-row-${drawingId}`} className={styles.specialRow}>
      {items.map(({ chartId, compoundId }) => (
        <DrawingProvider key={chartId} drawingId={compoundId}>
          <ChartFromContext chartId={chartId} />
        </DrawingProvider>
      ))}
    </div>
  );
}

export default function DrawnSetGroup({ drawingId }: { drawingId: string }) {
  const gradient = useRotatingGradientStyles();
  const drawing = useAppState((s) => s.drawings.entities[drawingId]);
  if (!drawing) return null;
  return (
    <div style={{ ...gradient }} className={styles.drawnSetGroup}>
      <InlineSpecialPicksRow drawingId={drawingId} />
      {drawing.subDrawings &&
        Object.values(drawing.subDrawings).map((subDraw, idx) => (
          <DrawingProvider
            key={subDraw.compoundId[1]}
            drawingId={subDraw.compoundId}
          >
            {idx === 0 && <MatchLabels />}
            <DrawnSet />
          </DrawingProvider>
        ))}
      <MatchActions drawingId={drawingId} />
    </div>
  );
}

export function PlainDrawnSetGroup({ drawingId }: { drawingId: string }) {
  const drawing = useAppState((s) => s.drawings.entities[drawingId]);
  if (!drawing) return null;
  return (
    <div>
      {drawing.subDrawings &&
        Object.values(drawing.subDrawings).map((subDraw) => (
          <DrawingProvider
            key={subDraw.compoundId[1]}
            drawingId={subDraw.compoundId}
          >
            <ChartList />
          </DrawingProvider>
        ))}
    </div>
  );
}
