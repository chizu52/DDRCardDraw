import { useParams } from "react-router-dom";
import { ChartList, SpecialPicksList, ChartFromContext } from "../drawn-set";
import { useAppState } from "../state/store";
import { DrawingProvider } from "../drawing-context";
import { PlainDrawnSetGroup, useOrderedSpecialPicks } from "../drawn-set-group";

export function CabCards() {
  const params = useParams<"roomName" | "cabId">();
  const drawingId = useAppState((s) => s.event.cabs[params.cabId!].activeMatch);
  if (!drawingId) {
    return null;
  }
  if (typeof drawingId === "string") {
    return <PlainDrawnSetGroup drawingId={drawingId} />;
  }
  return (
    <DrawingProvider drawingId={drawingId}>
      <ChartList />
    </DrawingProvider>
  );
}

export function CabSpecialPicks() {
  const params = useParams<"roomName" | "cabId">();
  const drawingId = useAppState((s) => s.event.cabs[params.cabId!].activeMatch);
  if (!drawingId) {
    return null;
  }
  if (typeof drawingId === "string") {
    return <CabSpecialPicksGroup drawingId={drawingId} />;
  }
  return (
    <DrawingProvider drawingId={drawingId}>
      <SpecialPicksList />
    </DrawingProvider>
  );
}

function CabSpecialPicksGroup({ drawingId }: { drawingId: string }) {
  const items = useOrderedSpecialPicks(drawingId);
  return (
    <div
      className="special-picks-source"
      style={{ display: "flex", flexDirection: "row", flexWrap: "nowrap", width: "100%" }}
    >
      {items.map(({ chartId, compoundId }) => (
        <DrawingProvider key={chartId} drawingId={compoundId}>
          <ChartFromContext chartId={chartId} />
        </DrawingProvider>
      ))}
    </div>
  );
}
