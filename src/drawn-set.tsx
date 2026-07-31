import { memo } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { SongCard } from "./song-card";
import styles from "./drawn-set.css";
import { useDrawing } from "./drawing-context";
import { DrawingActions } from "./tournament-mode/drawing-actions";
import { ErrorFallback } from "./utils/error-fallback";

export function ChartList() {
  const charts = useDrawing((d) => d.charts);
  if (!charts) return null;
  return (
    <div className={`${styles.chartList} chart-list-original`}>
      {charts.map((c) => (
        <ChartFromContext key={c.id} chartId={c.id} />
      ))}
    </div>
  );
}

export function SpecialPicksList() {
  const charts = useDrawing((d) => d.charts);
  const pickOrder = useDrawing((d) => d.pickOrder);
  if (!charts) return null;

  const chartById = new Map(charts.map((c) => [c.id, c]));
  const specialCharts = (pickOrder || [])
    .filter((id) => chartById.has(id))
    .map((id) => chartById.get(id)!);

  return (
    <div className={`${styles.specialPicksSource} special-picks-source`}>
      {specialCharts.map((c) => (
        <ChartFromContext key={c.id} chartId={c.id} />
      ))}
    </div>
  );
}

export function ChartFromContext({ chartId }: { chartId: string }) {
  const chart = useDrawing((d) => d.charts.find((c) => c.id === chartId));
  const veto = useDrawing((d) => d.bans[chartId]);
  const protect = useDrawing((d) => d.protects[chartId]);
  const pocketPick = useDrawing((d) => d.pocketPicks[chartId]);
  const winner = useDrawing((d) => d.winners[chartId]);
  const isTiebreaker = useDrawing((d) => !!d.tiebreakers?.[chartId]);
  if (!chart) {
    return null;
  }
  return (
    <SongCard
      vetoedBy={veto?.player}
      protectedBy={protect?.player}
      replacedBy={pocketPick?.player}
      replacedWith={pocketPick?.pick}
      winner={winner}
      isTiebreaker={isTiebreaker}
      chart={chart}
      actionsEnabled
    />
  );
}

function TournamentModeSpacer() {
  return <div style={{ height: "15px" }} />;
}

const DrawnSet = memo(function DrawnSet() {
  const [, drawingId] = useDrawing((d) => d.compoundId);
  return (
    <ErrorBoundary
      fallback={
        <div
          className={styles.drawing}
          style={{
            padding: "2em",
            minHeight: "15em",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <ErrorFallback />
        </div>
      }
    >
      <div
        key={drawingId}
        id={`drawing:${drawingId}`}
        className={styles.drawing}
      >
        <TournamentModeSpacer />
        <div id={`drawing-${drawingId}`}>
          <ChartList />
        </div>
        <DrawingActions />
      </div>
    </ErrorBoundary>
  );
});
export default DrawnSet;
