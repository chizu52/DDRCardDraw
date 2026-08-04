import { Popover } from "@blueprintjs/core";
import classNames from "classnames";
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConfigState } from "../state/hooks";
import { useDrawing } from "../drawing-context";
import {
  CHART_PLACEHOLDER,
  DrawnChart,
  EligibleChart,
  PlayerPickPlaceholder,
} from "../models/Drawing";
import { SongSearch } from "../song-search";
import { CardLabel, LabelType } from "./card-label";
import { FillPlaceholderList, ActionMenu } from "./acton-menu";
import styles from "./song-card.css";
import { useAppDispatch } from "../state/store";
import {
  createPickBanPocket,
  createRedrawChart,
  createPackVeto,
  createTiebreaker,
} from "../state/thunks";
import { getJacketUrl } from "../utils/jackets";
import { drawingsSlice } from "../state/drawings.slice";
import { copyTextToClipboard } from "../utils/share";
import { useChartRandomSelected } from "../tournament-mode/highlight-random";

import { baseChartValues, CardContentsProps } from "./variants";

type PlayerId = string;

interface IconCallbacks {
  onVeto: (p: PlayerId) => void;
  onProtect: (p: PlayerId) => void;
  onReplace: (p: PlayerId, chart: EligibleChart) => void;
  onPackVeto: (p: PlayerId) => void;
  onTiebreaker: () => void;
  onRedraw: () => void;
  onReset: () => void;
  onSetWinner: (p: PlayerId | null) => void;
}

export interface SongCardProps {
  onClick?: () => void;
  chart: DrawnChart | EligibleChart | PlayerPickPlaceholder;
  vetoedBy?: PlayerId;
  protectedBy?: PlayerId;
  replacedBy?: PlayerId;
  winner?: PlayerId | null;
  replacedWith?: EligibleChart;
  isTiebreaker?: boolean;
  actionsEnabled?: boolean;
}

type Props = SongCardProps & CardContentsProps;

export { Props as SongCardBaseProps };

function useIconCallbacksForChart(chartId: string): IconCallbacks {
  const dispatch = useAppDispatch();
  const drawingId = useDrawing((s) => s.compoundId);

  const handleBanPickPocket = useCallback(
    (
      type: "ban" | "protect" | "pocket",
      player: string,
      pick?: EligibleChart,
    ) => dispatch(createPickBanPocket(drawingId, chartId, type, player, pick)),
    [drawingId, chartId, dispatch],
  );

  return useMemo(
    () => ({
      onVeto: handleBanPickPocket.bind(undefined, "ban"),
      onProtect: handleBanPickPocket.bind(undefined, "protect"),
      onReplace: handleBanPickPocket.bind(undefined, "pocket"),
      onTiebreaker: () => {
        dispatch(createTiebreaker(drawingId, chartId));
      },
      onPackVeto: (player: string) => {
        dispatch(createPackVeto(drawingId, chartId, player));
      },
      onRedraw: () => {
        dispatch(createRedrawChart(drawingId, chartId));
      },
      onReset: () =>
        dispatch(drawingsSlice.actions.resetChart({ drawingId, chartId })),
      onSetWinner: (player) =>
        dispatch(
          drawingsSlice.actions.setWinner({ drawingId, chartId, player }),
        ),
    }),
    [handleBanPickPocket, drawingId, chartId, dispatch],
  );
}

function useRecentAction(timestamp: number | undefined, durationMs: number) {
  const [justChanged, setJustChanged] = useState(false);
  // Not the "derive state from props" antipattern this rule normally
  // targets -- justChanged genuinely needs a timer (setTimeout below) to
  // flip itself back off after `remaining` ms, which isn't something a
  // plain render-time calculation can do on its own. timestamp/durationMs
  // are external inputs (a prop from Redux-tracked drawing state, not
  // local state this hook owns), so re-deriving + rescheduling whenever
  // either changes is the effect doing its actual job, not a workaround.
  useEffect(() => {
    if (!timestamp) {
      // eslint-disable-next-line react-hooks-js/set-state-in-effect
      setJustChanged(false);
      return;
    }
    const elapsed = Date.now() - timestamp;
    const remaining = durationMs - elapsed;
    if (remaining <= 0) {
      setJustChanged(false);
      return;
    }
    setJustChanged(true);
    const t = setTimeout(() => setJustChanged(false), remaining);
    return () => clearTimeout(t);
  }, [timestamp, durationMs]);
  return justChanged;
}

export function SongCardBase(props: Props) {
  const {
    chart,
    vetoedBy,
    protectedBy,
    replacedBy,
    replacedWith,
    winner,
    isTiebreaker,
    actionsEnabled,
    CenterContent,
    FooterContent,
  } = props;
  const hideVetos = useConfigState((s) => s.hideVetos);

  const [wasRandomlySelected, clearRandomSelection] =
    useChartRandomSelected(chart);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wasRandomlySelected && rootRef.current) {
      rootRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [wasRandomlySelected]);

  const [showingContextMenu, setContextMenuOpen] = useState(false);
  const showMenu = () => setContextMenuOpen(true);
  const hideMenu = () => setContextMenuOpen(false);

  const [pocketPickPendingForPlayer, setPocketPickPendingForPlayer] =
    useState<PlayerId | null>(null);

  const baseChartIsPlaceholder =
    "type" in chart && chart.type === CHART_PLACEHOLDER;

  const { name, diffAbbr, jacket } = replacedWith || baseChartValues(chart);

  const hasLabel = !!(
    vetoedBy !== undefined ||
    protectedBy !== undefined ||
    replacedBy !== undefined ||
    isTiebreaker
  );
  const hasWinner = typeof winner === "number";

  let jacketBg = {};
  if (jacket) {
    jacketBg = { backgroundImage: `url("${getJacketUrl(jacket)}")` };
  }

  const iconCallbacks = useIconCallbacksForChart((chart as DrawnChart).id);
  const actionTimestamp = useDrawing(
    (d) => d.actionTimestamps?.[(chart as DrawnChart).id],
  );
  const justChanged = useRecentAction(actionTimestamp, 1200);
  const handleCopy = useCallback(async () => {
    if (!diffAbbr) {
      return;
    }
    await copyTextToClipboard(
      `${name} [${diffAbbr.toUpperCase()}]`,
      "Copied name & difficulty",
    );
  }, [name, diffAbbr]);
  const canCopy = !!name && !!diffAbbr;

  let menuContent: undefined | JSX.Element;
  if (actionsEnabled && !hasWinner) {
    if (replacedWith === undefined && baseChartIsPlaceholder) {
      menuContent = (
        <FillPlaceholderList
          onFillPlaceholder={setPocketPickPendingForPlayer}
        />
      );
    } else if (!hasLabel) {
      menuContent = (
        <ActionMenu
          onProtect={iconCallbacks.onProtect}
          onStartPocketPick={setPocketPickPendingForPlayer}
          onVeto={iconCallbacks.onVeto}
          onPackVeto={iconCallbacks.onPackVeto}
          onTiebreaker={iconCallbacks.onTiebreaker}
          onRedraw={iconCallbacks.onRedraw}
          onSetWinner={iconCallbacks.onSetWinner}
          onCopy={handleCopy}
        />
      );
    } else if (vetoedBy === undefined) {
      menuContent = (
        <ActionMenu
          onSetWinner={iconCallbacks.onSetWinner}
          onCopy={handleCopy}
        />
      );
    }
  }

  const rootClassname = classNames(styles.chart, {
    [styles.vetoed]: vetoedBy !== undefined,
    [styles.protected]: protectedBy !== undefined,
    [styles.replaced]: replacedBy !== undefined && !baseChartIsPlaceholder,
    [styles.picked]: replacedBy !== undefined && baseChartIsPlaceholder,
    [styles.tiebreaker]: !!isTiebreaker,
    [styles.justProtected]: justChanged && protectedBy !== undefined,
    [styles.justVetoed]: justChanged && vetoedBy !== undefined,
    [styles.justReplaced]:
      justChanged && replacedBy !== undefined && !baseChartIsPlaceholder,
    [styles.justTiebreaker]: justChanged && !!isTiebreaker,
    [styles.clickable]: !!menuContent || !!props.onClick || canCopy,
    [styles.hideVeto]: hideVetos,
    [styles.randomSelected]: wasRandomlySelected,
  });

  const handleCardClick = menuContent ? showMenu : props.onClick || handleCopy;

  const actionLabels = (
    <>
      {vetoedBy !== undefined && (
        <CardLabel
          playerId={vetoedBy}
          type={LabelType.Ban}
          onRemove={iconCallbacks?.onReset}
        />
      )}
      {protectedBy !== undefined && (
        <CardLabel
          playerId={protectedBy}
          type={LabelType.Protect}
          onRemove={iconCallbacks?.onReset}
        />
      )}
      {replacedBy !== undefined && (
        <CardLabel
          playerId={replacedBy}
          type={baseChartIsPlaceholder ? LabelType.FreePick : LabelType.Pocket}
          onRemove={iconCallbacks?.onReset}
        />
      )}
      {isTiebreaker && (
        <CardLabel
          label="Tiebreaker"
          type={LabelType.Tiebreaker}
          onRemove={iconCallbacks?.onReset}
        />
      )}
      {winner !== undefined && winner !== null && (
        <CardLabel
          playerId={winner}
          type={LabelType.Winner}
          onRemove={() => iconCallbacks?.onSetWinner(null)}
        />
      )}
    </>
  );

  return (
    <Popover
      isOpen={wasRandomlySelected}
      onClose={clearRandomSelection}
      content={<div style={{ padding: "0.5em" }}>This one!</div>}
      targetTagName="div"
      className={styles.popoverWrapper}
    >
      <div
        ref={rootRef}
        className={rootClassname}
        onClick={
          showingContextMenu || pocketPickPendingForPlayer !== null
            ? undefined
            : handleCardClick
        }
        style={jacketBg}
      >
        <SongSearch
          isOpen={pocketPickPendingForPlayer !== null}
          onSongSelect={(song, chart) => {
            if (actionsEnabled && chart) {
              iconCallbacks.onReplace(pocketPickPendingForPlayer!, chart);
            }
            setPocketPickPendingForPlayer(null);
          }}
          onCancel={() => setPocketPickPendingForPlayer(null)}
        />
        <div className={styles.cardCenter}>
          {actionLabels}
          <CenterContent chart={replacedWith || chart} />
        </div>

        <Popover
          content={menuContent}
          isOpen={showingContextMenu}
          onClose={hideMenu}
          placement="top"
          modifiers={{
            offset: { options: { offset: [0, 35] } },
          }}
        >
          <FooterContent chart={replacedWith || chart} />
        </Popover>
      </div>
    </Popover>
  );
}
