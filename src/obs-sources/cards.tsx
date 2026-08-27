import { useParams } from "react-router-dom";
import { ChartList, SpecialPicksList, ChartFromContext } from "../drawn-set";
import { useAppState } from "../state/store";
import { DrawingProvider } from "../drawing-context";
import { PlainDrawnSetGroup, useOrderedSpecialPicks } from "../drawn-set-group";
import styles from "../drawn-set.css";

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

// Same className pattern as SpecialPicksList (../drawn-set) -- both
// styles.specialPicksSource (this file's own CSS module class, the
// wrap/padding/overflow rules shared with .chartList's "Cards" source)
// and the plain global "special-picks-source" class (song-card.css's
// own SongCard-level selector). Used to carry its own inline
// `flexWrap: "nowrap", width: "100%"` here instead, silently
// duplicating (and, worse, overriding via inline-style specificity)
// what the CSS module already declares -- explicit user request to
// make this OBS source's cards size the same way "Cards" does, which
// this inline override was actively fighting.
function CabSpecialPicksGroup({ drawingId }: { drawingId: string }) {
  const items = useOrderedSpecialPicks(drawingId);
  return (
    <div className={`${styles.specialPicksSource} special-picks-source`}>
      {items.map(({ chartId, compoundId }) => (
        <DrawingProvider key={chartId} drawingId={compoundId}>
          <ChartFromContext chartId={chartId} />
        </DrawingProvider>
      ))}
    </div>
  );
}
