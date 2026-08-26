import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Callout } from "@blueprintjs/core";
import {
  parsePoolsFromRows,
  topScoreRanks,
  colIndexToLetter,
  classifyRankingColor,
  finalRankingStatusByName,
  formatSongScore,
  ParsedPool,
  PoolPlayerRow,
  ScoreFormat,
} from "../sheets/parse-pools";
import {
  fetchPublicSheetValues,
  fetchPublicCellColors,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { decodeSheetsConnection } from "../sheets/sheets-connection-param";
import { CellColor, colorToCss } from "../sheets/sheets-export";
import { decodeStartggConnection } from "../startgg-gql/startgg-connection-param";
import { useAppState } from "../state/store";
import {
  BODY_FONT_FAMILY,
  LOCAL_FONT_FACE_CSS,
  TITLE_FONT_FAMILY,
} from "./local-fonts";
import {
  BROADCAST_COLORS,
  statusPillStyle,
  sectionLabelStyle,
  outerWrapperStyle,
  cardStyle,
  cardContentStyle,
} from "./broadcast-theme";
import { BroadcastTitleBar } from "./broadcast-title-bar";
import { BracketTreeWithApiKey } from "./bracket-tree";

const FALLBACK_POLL_INTERVAL_MS = 60_000;

const COLORS = {
  ...BROADCAST_COLORS,
  dim: "#6b7280",
  red: "#ef4444",
};

// Winner's side is every pool NOT matching this ("Pool L1", "Pool L2",
// ...). Matched generically off whatever's actually in the sheet, not a
// fixed list of titles/count.
const LOSER_POOL_TITLE = /^pool\s*l/i;

/** Parses a pool title's own trailing "set number + optional letter"
 * suffix -- e.g. "Pool 2" -> {setNumber: 2, subsetLetter: ""},
 * "Pool L2B" -> {setNumber: 2, subsetLetter: "B"}. null if the title has
 * no trailing number. */
function parsePoolTitleSuffix(
  title: string,
): { setNumber: number; subsetLetter: string } | null {
  const match = title.match(/(\d+)\s*([A-Za-z]?)\s*$/);
  if (!match) return null;
  return {
    setNumber: parseInt(match[1], 10),
    subsetLetter: match[2].toUpperCase(),
  };
}

/** Natural/numeric sort key from a pool title's own trailing set number,
 * plus its optional lettered sub-set (e.g. "Pool 2" -> 200, "Pool L10"
 * -> 1000, "Pool 1A" -> 101, "Pool L2B" -> 202) -- used to order each
 * row's pools by their own numbering rather than by raw sheet scan
 * order (see winnerPools/loserPools below for why that was a real
 * bug). The letter is a SECONDARY sort key nested under the number
 * (multiplying the number by 100 leaves room for A-Z's offset of 1-26
 * without colliding with the next number), so "Pool 1A"/"Pool 1B" both
 * sort right after "Pool 1" and before "Pool 2" -- an unlettered pool
 * (offset 0) sorts before its own lettered variants, same relative
 * order as the numbers themselves. A title with no trailing number
 * sorts after every numbered one. */
function poolSortKey(title: string): number {
  const parsed = parsePoolTitleSuffix(title);
  if (!parsed) return Number.MAX_SAFE_INTEGER;
  const letterOffset = parsed.subsetLetter
    ? parsed.subsetLetter.charCodeAt(0) - "A".charCodeAt(0) + 1
    : 0;
  return parsed.setNumber * 100 + letterOffset;
}

/** Just the trailing letter of a lettered sub-set (e.g. "Pool 2B" ->
 * "B", "Pool 3" -> ""). */
function poolSubsetLetter(title: string): string {
  return parsePoolTitleSuffix(title)?.subsetLetter ?? "";
}

/** Just the trailing set number (e.g. "Pool 2B" -> 2) -- this pool's
 * column position, shared across every letter-row and both sides. */
function poolSetNumber(title: string): number {
  return parsePoolTitleSuffix(title)?.setNumber ?? Number.MAX_SAFE_INTEGER;
}

/** Groups pools into one row per distinct letter, each row's own pools
 * sorted by number. Unlettered pools all share the single "" group, so
 * a sheet with no lettered sub-sets renders exactly one row per side. */
function groupByLetter(
  pools: ParsedPool[],
): { letter: string; pools: ParsedPool[] }[] {
  const groups = new Map<string, ParsedPool[]>();
  for (const pool of pools) {
    const letter = poolSubsetLetter(pool.title);
    const group = groups.get(letter);
    if (group) group.push(pool);
    else groups.set(letter, [pool]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, groupPools]) => ({
      letter,
      pools: [...groupPools].sort(
        (a, b) => poolSetNumber(a.title) - poolSetNumber(b.title),
      ),
    }));
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      pools: ParsedPool[];
      colors: (CellColor | null)[];
      /** Column B's own cell background colors -- purely cosmetic,
       * mirrored onto each pool's header bar. */
      headerColors: (CellColor | null)[];
    };

// Stable references for the "not loaded yet" case, so a fresh `[]`
// isn't a new array reference on every render.
const EMPTY_POOLS: ParsedPool[] = [];
const EMPTY_COLORS: (CellColor | null)[] = [];
const EMPTY_HEADER_COLORS: (CellColor | null)[] = [];

// One stable overlay for the whole pools-then-bracket arc of an event --
// event.gauntletPoolsShowsBracket (room-synced, picked from dashboard.tsx's
// GauntletPoolsSettingsSection's combined dropdown) switches between the
// pools diagram below and the start.gg bracket tree for whichever phase is
// selected (event.selectedBracketPhase), instead of a separate bracket-tree
// OBS source that needed swapping in once pool play wrapped up. Both
// credential sets travel in this one URL (`src` for Sheets, `bracketSrc`
// for start.gg -- two distinctly-named opaque params, not one shared `src`,
// since each decodes a differently-shaped connection) so either view is
// ready the instant the toggle flips live, not fetched fresh from a URL
// that was never actually copied into OBS.
export function GauntletPoolsOverlay() {
  const [params] = useSearchParams();
  // Credentials travel as one opaque `src` param (see
  // sheets-connection-param.ts), falling back to plain `apiKey`/
  // `spreadsheetId` params for an OBS source configured with the old URL.
  const decoded = decodeSheetsConnection(params.get("src"));
  const apiKey = decoded.apiKey ?? params.get("apiKey");
  const spreadsheetId = decoded.spreadsheetId ?? params.get("spreadsheetId");
  const sheetName = decoded.sheet ?? params.get("sheet") ?? "Pools";
  const bracketApiKey = decodeStartggConnection(params.get("bracketSrc"));
  const showsBracket = useAppState((s) => s.event.gauntletPoolsShowsBracket);
  // Shared with the pools view below -- the bracket view no longer has
  // its own separate title/icon fields (see BracketTreeWithApiKey's own
  // doc), both views brand themselves the same way regardless of which
  // is currently showing.
  const title = useAppState((s) => s.event.gauntletPoolsTitle);
  const icon = useAppState((s) => s.event.gauntletPoolsIcon);

  if (showsBracket) {
    if (!bracketApiKey) {
      return (
        <Callout intent="danger" style={{ maxWidth: 480 }}>
          Missing start.gg credentials for this overlay. Use the "Copy
          Bracket overlay URL" button in the Settings tab rather than
          building this URL by hand -- it fills this in automatically from
          your saved start.gg settings (if you've saved one).
        </Callout>
      );
    }
    return (
      <BracketTreeWithApiKey apiKey={bracketApiKey} title={title} icon={icon} />
    );
  }

  return (
    <GauntletPoolsWithCreds
      apiKey={apiKey}
      spreadsheetId={spreadsheetId}
      sheetName={sheetName}
    />
  );
}

/** Everything that only needs resolved credentials, not specifically
 * the URL they came from -- split out so another overlay wanting to
 * embed the pools diagram (e.g. a future combined pools+bracket view)
 * can render this directly with credentials it decoded some other way,
 * without needing a second nested <Router> just to satisfy
 * GauntletPoolsOverlay's own useSearchParams() call (React Router
 * hard-errors on a nested Router -- a real approach tried first here,
 * see git history). Kept the SAME `string | null` types (rather than
 * requiring non-null and hoisting the missing-param Callout up into
 * the thin wrapper above) specifically so this function's own body
 * below -- including its existing missing-param Callout further down
 * -- doesn't need to change at all. */
export function GauntletPoolsWithCreds({
  apiKey,
  spreadsheetId,
  sheetName,
}: {
  apiKey: string | null;
  spreadsheetId: string | null;
  sheetName: string;
}) {
  // Unlike pool-results.tsx, this overlay always shows every pool at
  // once -- selectedPool isn't used to filter which pools render here,
  // only to know WHICH one the operator has actually put on Pool
  // Results right now (dashboard.tsx's "Show on Overlay" button), so
  // that same pool's own status pill can read "Live" here too.
  const poolsRefreshedAt = useAppState((s) => s.event.poolsRefreshedAt);
  const selectedPool = useAppState((s) => s.event.selectedPool);
  const upcomingPools = useAppState((s) => s.event.gauntletPoolsUpcoming);
  const dividers = useAppState((s) => s.event.gauntletPoolsDividers);
  const scoreFormat = useAppState((s) => s.event.overlayScoreFormat);
  const title = useAppState((s) => s.event.gauntletPoolsTitle);
  const icon = useAppState((s) => s.event.gauntletPoolsIcon);

  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Auto-pan camera, tracking whichever pool is selected. Real native
  // horizontal scrolling, not a CSS transform: viewportRef is the
  // scrolling element (its own scrollLeft is what recomputeScroll sets),
  // panRef is the wide card sitting inside it. The title bar and
  // Winners/Losers section labels use plain `position: sticky; left: <n>`
  // (see their own call sites) to stay put while this scrolls.
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  // The title bar's own `position: sticky; left: 40` lands ~70px too far
  // left in this structure (root cause never fully pinned down -- traced
  // to its own border/padding, which the section labels don't have). The
  // offset is constant regardless of scroll position, so it's corrected
  // with a single measured value here rather than tracked continuously.
  const titleBarNudgeRef = useRef<HTMLDivElement>(null);
  const [titleBarNudge, setTitleBarNudge] = useState(0);
  // Safety net: the outer wrapper's CSS auto-height can land a few
  // pixels taller than panRef's real content height, so this measures
  // panRef's true `offsetHeight` and applies it explicitly below.
  const [contentHeight, setContentHeight] = useState<number | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!apiKey || !spreadsheetId) return;
    let cancelled = false;

    async function load() {
      try {
        const rows = await fetchPublicSheetValues(
          apiKey!,
          spreadsheetId!,
          sheetName,
        );
        if (cancelled) return;
        const { pools } = parsePoolsFromRows(rows);
        // Header (column B) and Final Ranking colors in ONE multi-range
        // request (fetchPublicCellColors) -- see its own comment; keeps
        // this overlay's own contribution to Google's per-minute Sheets
        // API read quota down. A sheet with no Final Ranking column
        // (finalRankingCol always null) just omits that range --
        // advancement falls back to "unknown," not a crash. A failure
        // here degrades gracefully (no header tint, advancement unknown).
        const finalRankingCol = pools.find(
          (p) => p.finalRankingCol !== null,
        )?.finalRankingCol;
        const colorRanges = [`${sheetName}!B:B`];
        if (finalRankingCol != null) {
          colorRanges.push(
            `${sheetName}!${colIndexToLetter(finalRankingCol)}:${colIndexToLetter(finalRankingCol)}`,
          );
        }
        const [headerColors, colors] = await fetchPublicCellColors(
          apiKey!,
          spreadsheetId!,
          colorRanges,
        ).catch(() => colorRanges.map(() => [] as (CellColor | null)[]));
        if (cancelled) return;
        setState({
          status: "ok",
          pools,
          colors: colors ?? [],
          headerColors,
        });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof PublicSheetReadError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Couldn't read the sheet.";
        setState({ status: "error", message });
      }
    }

    void load();
    const timer = setInterval(load, FALLBACK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiKey, spreadsheetId, sheetName, poolsRefreshedAt]);

  // Recomputes the real scrollLeft target (and contentHeight) from
  // panEl's current layout -- its own function so it can also be re-run
  // by the ResizeObserver further down when panEl's size changes after
  // the fact (e.g. LOCAL_FONT_FACE_CSS's custom fonts loading
  // asynchronously and reflowing wider). Native scroll's `scrollLeft`
  // self-clamps to the browser's own live scrollWidth/clientWidth, so a
  // stale target can at worst scroll to the wrong spot, never leave the
  // card short of the viewport's true edge.
  const recomputeScroll = useCallback(() => {
    const scrollEl = viewportRef.current;
    const panEl = panRef.current;
    if (!scrollEl || !panEl) return;
    setContentHeight(panEl.offsetHeight);
    const target = selectedPool
      ? panEl.querySelector<HTMLElement>(
          `[data-pool-title="${CSS.escape(selectedPool)}"]`,
        )
      : null;
    // No target -- either no pool is currently marked "Show on Overlay"
    // (selectedPool null) or that title isn't in the DOM (a stale/
    // renamed pool). Leaves scrollLeft exactly where it already is,
    // rather than snapping back to 0 -- explicit user request: an
    // operator clearing the live pool between matches (or switching
    // away and back) shouldn't yank the camera back to the far left
    // and lose whatever pool a viewer was just looking at; it should
    // just hold there until a genuinely NEW pool is selected, which
    // re-runs this same effect and pans normally.
    if (!target) {
      return;
    }
    // target isn't a direct child of panEl, so walk the offsetParent
    // chain summing offsetLeft at each hop until panEl is reached.
    let targetLeft = 0;
    for (
      let node: HTMLElement | null = target;
      node && node !== panEl;
      node = node.offsetParent as HTMLElement | null
    ) {
      targetLeft += node.offsetLeft;
    }
    const targetCenterX = targetLeft + target.offsetWidth / 2;
    // No manual clamping needed -- assigning scrollLeft outside its
    // valid [0, scrollWidth - clientWidth] range is a no-op past
    // whichever edge it overshoots (the browser's own native behavior),
    // same effect the old code's explicit Math.max/min achieved by
    // hand.
    scrollEl.scrollLeft = targetCenterX - scrollEl.clientWidth / 2;
  }, [selectedPool]);

  // Runs recomputeScroll whenever the live pool changes or the sheet
  // reloads (in case that shifts box positions/widths) -- unconditional,
  // before the early returns below, same as every other hook in this
  // component. No-ops before real content exists yet (viewportRef/panRef
  // still null pre-mount of the "ok" branch's JSX).
  useLayoutEffect(() => {
    recomputeScroll();
  }, [recomputeScroll, state]);

  // Catches size changes recomputeScroll's own dependency array can't
  // see coming (e.g. an async font swap reflowing panEl wider).
  useEffect(() => {
    const panEl = panRef.current;
    if (!panEl) return;
    const observer = new ResizeObserver(() => recomputeScroll());
    observer.observe(panEl);
    return () => observer.disconnect();
  }, [recomputeScroll]);

  // Measures and corrects the title bar's own sticky-offset bug (see
  // titleBarNudgeRef's own comment above). Compares where the title
  // bar's sticky wrapper is currently sitting against its own `left: 40`
  // ask, relative to the scroll container's edge, and stores the
  // correction. A ResizeObserver since the needed correction is tied to
  // the title bar's own border/padding box, which can change size.
  useEffect(() => {
    const scrollEl = viewportRef.current;
    const nudgeEl = titleBarNudgeRef.current;
    if (!scrollEl || !nudgeEl) return;
    const measure = () => {
      const currentLeft =
        nudgeEl.getBoundingClientRect().left -
        scrollEl.getBoundingClientRect().left;
      setTitleBarNudge((prev) => prev + (40 - currentLeft));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nudgeEl);
    // Also re-measure on the scroll container's own scroll events --
    // `scrollLeft = x` (recomputeScroll) doesn't move synchronously
    // under `scroll-behavior: smooth`, it animates over following
    // frames. `scrollend` re-measures once the animation genuinely
    // finishes; the plain `scroll` listener is a fallback for engines
    // without `scrollend` support.
    scrollEl.addEventListener("scroll", measure);
    scrollEl.addEventListener("scrollend", measure);
    return () => {
      observer.disconnect();
      scrollEl.removeEventListener("scroll", measure);
      scrollEl.removeEventListener("scrollend", measure);
    };
    // `state`, not `[]` -- on first mount data is still "loading" and
    // nudgeEl isn't attached to anything yet, so this needs to re-run
    // once real content (and a real ref) exists.
  }, [state]);

  const pools = state.status === "ok" ? state.pools : EMPTY_POOLS;
  const colors = state.status === "ok" ? state.colors : EMPTY_COLORS;
  const headerColors =
    state.status === "ok" ? state.headerColors : EMPTY_HEADER_COLORS;
  // Split into two rows by the "Pool L..." naming convention, sorted
  // numerically within each row by poolSortKey (not raw sheet scan
  // order, which isn't guaranteed to match each pool's own numbering).
  const loserPools = pools
    .filter((p) => LOSER_POOL_TITLE.test(p.title))
    .sort((a, b) => poolSortKey(a.title) - poolSortKey(b.title));
  const winnerPools = pools
    .filter((p) => !LOSER_POOL_TITLE.test(p.title))
    .sort((a, b) => poolSortKey(a.title) - poolSortKey(b.title));

  if (!apiKey || !spreadsheetId) {
    const missing = [!apiKey && "apiKey", !spreadsheetId && "spreadsheetId"]
      .filter(Boolean)
      .join(", ");
    return (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        Missing query parameter(s): {missing}. Use the "Copy Bracket overlay
        URL" button in the Bracket Overlay settings section rather than
        building this URL by hand -- it fills these in automatically from
        your saved Sheets settings.
      </Callout>
    );
  }
  if (state.status === "loading") {
    return null; // avoid a flash of an empty/error box on first load
  }
  if (state.status === "error") {
    return (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        {state.message}
      </Callout>
    );
  }

  // One row per distinct letter (see groupByLetter) instead of one row
  // per side (a sheet with no lettered sub-sets still produces exactly
  // one group per side).
  const winnerGroups = groupByLetter(winnerPools);
  const loserGroups = groupByLetter(loserPools);
  // The destination box only ever reflects the LAST round on each side
  // (see finalPools), not a running flatten of every pool that has ever
  // fed players forward.
  const winnerFinalAdvancing = aggregateAdvancing(
    finalPools(winnerPools),
    colors,
  );
  const loserFinalAdvancing = aggregateAdvancing(
    finalPools(loserPools),
    colors,
  );
  const winnerFinalCount = totalAdvancingCount(finalPools(winnerPools), colors);
  const loserFinalCount = totalAdvancingCount(finalPools(loserPools), colors);
  // The combined "Top N" both destination boxes title themselves with --
  // requires BOTH sides' final-pool counts to be known, not just one, so
  // a partial sum doesn't understate the real total.
  const bracketPlayTotal =
    winnerFinalCount != null && loserFinalCount != null
      ? winnerFinalCount + loserFinalCount
      : null;
  // Column position is keyed by set NUMBER, shared across every
  // letter-row on both sides, so "Pool 2A" and "Pool L2A" share a column
  // even on different rows.
  const allNumbers = [...new Set(pools.map((p) => poolSetNumber(p.title)))].sort(
    (a, b) => a - b,
  );
  const columnIndexForNumber = new Map(allNumbers.map((n, i) => [n, i]));
  const validDividers = dividers
    .map((d) => ({
      ...d,
      poolIdx: columnIndexForNumber.get(d.beforeSetNumber),
    }))
    .filter(
      (d): d is typeof d & { poolIdx: number } => d.poolIdx !== undefined,
    )
    .sort((a, b) => a.poolIdx - b.poolIdx);
  const dividerTracksBefore = (poolIdx: number) =>
    validDividers.filter((d) => d.poolIdx <= poolIdx).length;
  const columnFor = (pool: ParsedPool) => {
    const poolIdx = columnIndexForNumber.get(poolSetNumber(pool.title))!;
    return 1 + poolIdx * 2 + dividerTracksBefore(poolIdx);
  };
  const dividerColumns = new Map(
    validDividers.map((d, i) => [d.id, 1 + d.poolIdx * 2 + i]),
  );
  const destCol = 1 + allNumbers.length * 2 + validDividers.length;
  const DIVIDER_BOX_WIDTH = 64;
  const DIVIDER_SIDE_MARGIN = 16;
  const DIVIDER_TRACK_WIDTH = DIVIDER_BOX_WIDTH + DIVIDER_SIDE_MARGIN * 2;
  const gridColumnTemplate = (() => {
    const tracks: string[] = [];
    for (let i = 0; i < allNumbers.length; i++) {
      for (const d of validDividers) {
        if (d.poolIdx === i) tracks.push(`${DIVIDER_TRACK_WIDTH}px`);
      }
      tracks.push("minmax(380px, max-content)");
      tracks.push("150px");
    }
    tracks.push("240px");
    return tracks.join(" ");
  })();
  // Row 1 is the title bar, row 2 is the Winners label.
  const losersLabelRow = 3 + winnerGroups.length;
  const loserFirstRow = losersLabelRow + 1;
  const totalRows = losersLabelRow + loserGroups.length;

  return (
    // `height: contentHeight` overrides CSS auto-height (undefined on
    // first render falls through to ordinary auto-sizing).
    <div style={{ ...outerWrapperStyle, height: contentHeight }}>
      {/* Real native horizontal scroll, not a CSS transform. Scrollbar
          hidden -- scrolling here is entirely programmatic
          (recomputeScroll sets scrollLeft directly). */}
      <style>{HIDE_SCROLLBAR_CSS}</style>
      <div
        ref={viewportRef}
        className={HIDE_SCROLLBAR_CLASS}
        style={scrollContainerStyle}
      >
        <div ref={panRef} style={cardStyle}>
          {/* A plain `style` prop can't express @font-face -- see
              local-fonts.ts's own comment on this. */}
          <style>{LOCAL_FONT_FACE_CSS}</style>
      <div style={cardContentStyle}>
        <div style={gridStyle(gridColumnTemplate, totalRows)}>
          {validDividers.map((d) => (
            <div
              key={d.id}
              style={{
                gridColumn: dividerColumns.get(d.id),
                gridRow: `3 / ${totalRows + 1}`,
                margin: `-16px ${DIVIDER_SIDE_MARGIN}px`,
                background: COLORS.panel,
                border: "4px solid rgb(255, 255, 255)",
                borderRadius: 18,
                pointerEvents: "none",
                position: "relative",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%) rotate(180deg)",
                  writingMode: "vertical-rl",
                  textAlign: "center",
                  fontFamily: TITLE_FONT_FAMILY,
                  fontWeight: 700,
                  fontSize: "1.2em",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: COLORS.text,
                  whiteSpace: "nowrap",
                }}
              >
                {d.label}
              </span>
            </div>
          ))}
          {/* A real grid item (gridRow 1), not a separate sibling wrapper
              -- `position: sticky` only reliably activates for an
              element genuinely inside gridStyle's own grid. Split into
              two nested elements: this OUTER one carries only grid
              placement + sticky positioning, no border/padding/
              background; the INNER one carries the bar's actual chrome.
              Border/padding anywhere in a sticky element's own subtree
              throws off its sticky offset (see titleBarNudgeRef's own
              comment above for the measured correction this needed on
              top of the split). */}
          <div
            ref={titleBarNudgeRef}
            style={{
              gridColumn: "1 / -1",
              gridRow: 1,
              justifySelf: "start",
              position: "sticky",
              left: 40,
              transform: `translateX(${titleBarNudge}px)`,
            }}
          >
            {/* Shared with bracket-tree.tsx's own title bar (same
                component, not just similarly-styled) -- see
                BroadcastTitleBar's own doc for why. No subtitle here,
                unlike that one's phase.name -- this view has no
                equivalent "live, dynamic" info the title itself can't
                already express. */}
            <BroadcastTitleBar icon={icon} title={title || "Gauntlet Pools"} />
          </div>
          <div
            style={{
              ...sectionLabelStyle,
              color: COLORS.mint,
              gridColumn: "1 / -1",
              gridRow: 2,
              marginTop: 128,
              // justifySelf: "start" is load-bearing -- a grid item with
              // no explicit width defaults to justify-self: stretch,
              // which fills the entire `1 / -1` grid area and leaves
              // sticky no room to offset within.
              justifySelf: "start",
              position: "sticky",
              left: 40,
            }}
          >
            Winners Side Bracket
          </div>
          {winnerGroups.flatMap((group, gi) =>
            group.pools.map((pool) => (
              <PoolBox
                key={pool.title}
                title={pool.title}
                pool={pool}
                col={columnFor(pool)}
                row={3 + gi}
                colors={colors}
                headerColors={headerColors}
                allPools={pools}
                selectedPool={selectedPool}
                upcomingPools={upcomingPools}
                scoreFormat={scoreFormat}
              />
            )),
          )}
          {winnerGroups.flatMap((group, gi) =>
            group.pools.map((pool) => (
              <ArrowCell
                key={`arrow-${pool.title}`}
                col={columnFor(pool) + 1}
                row={3 + gi}
                count={advancingCount(pool, colors)}
              />
            )),
          )}
          {winnerPools.length > 0 && (
            <DestinationBox
              title={
                bracketPlayTotal != null
                  ? `Top ${bracketPlayTotal} Winner's Side`
                  : "Winner's Side"
              }
              col={destCol}
              row={`3 / span ${winnerGroups.length}`}
              advancing={winnerFinalAdvancing}
            />
          )}

          <div
            style={{
              ...sectionLabelStyle,
              color: COLORS.coral,
              gridColumn: "1 / -1",
              gridRow: losersLabelRow,
              marginTop: 128,
              justifySelf: "start",
              position: "sticky",
              left: 40,
            }}
          >
            Losers Side Bracket
          </div>
          {loserGroups.flatMap((group, gi) =>
            group.pools.map((pool) => (
              <PoolBox
                key={pool.title}
                title={pool.title}
                pool={pool}
                col={columnFor(pool)}
                row={loserFirstRow + gi}
                colors={colors}
                headerColors={headerColors}
                allPools={pools}
                selectedPool={selectedPool}
                upcomingPools={upcomingPools}
                scoreFormat={scoreFormat}
              />
            )),
          )}
          {loserGroups.flatMap((group, gi) =>
            group.pools.map((pool) => (
              <ArrowCell
                key={`arrow-${pool.title}`}
                col={columnFor(pool) + 1}
                row={loserFirstRow + gi}
                count={advancingCount(pool, colors)}
              />
            )),
          )}
          {loserPools.length > 0 && (
            <DestinationBox
              title={
                bracketPlayTotal != null
                  ? `Top ${bracketPlayTotal} Loser's Side`
                  : "Loser's Side"
              }
              col={destCol}
              row={`${loserFirstRow} / span ${loserGroups.length}`}
              advancing={loserFinalAdvancing}
            />
          )}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}

/** Pairs each of a pool's roster rows with its Final Ranking status, via
 * the name-keyed lookup above -- not that row's own Final Ranking cell
 * color directly, since that cell can belong to a different player than
 * whoever occupies the row. */
function classifiedRows(pool: ParsedPool, colors: (CellColor | null)[]) {
  const statusByName = finalRankingStatusByName(pool, colors);
  return pool.rows.map((row, idx) => ({
    row,
    idx,
    status: statusByName.get(row.player.trim().toLowerCase()) ?? null,
  }));
}

/** Names of every player marked "advancing" by Final Ranking's own
 * color, ordered by score. Gated on the pool's "Finished" checkbox --
 * unlike advancingCount below, this names specific people, and a Final
 * Ranking cell can be pre-colored by template before any name is in it. */
function advancingNames(
  pool: ParsedPool | undefined,
  colors: (CellColor | null)[],
): string[] | null {
  if (!pool || !pool.finished) return null;
  const ranks = topScoreRanks(pool);
  const advancing = classifiedRows(pool, colors).filter(
    (r) => r.status === "advancing",
  );
  if (advancing.length === 0) return null;
  return advancing
    .sort((a, b) => (ranks.get(a.idx) ?? 99) - (ranks.get(b.idx) ?? 99))
    .map((r) => r.row.player);
}

/** How many players progress out of a pool -- a property of the pool's
 * own template coloring (which Final Ranking row-slots are marked
 * green), not of any specific player. Counts by raw row position
 * (`pool.headerRowIndex + 1` through `+ POOL_SLOT_COUNT`), not
 * classifiedRows/finalRankingStatusByName, since those need an actual
 * name in the cell and a not-yet-fully-seeded pool may not have one for
 * every slot. Not gated on pool.finished. Returns null, not 0, only
 * when nothing is colored at all, so the UI can fall back to "TBD". */
function advancingCount(
  pool: ParsedPool | undefined,
  colors: (CellColor | null)[],
): number | null {
  if (!pool) return null;
  let count = 0;
  for (let slot = 1; slot <= POOL_SLOT_COUNT; slot++) {
    if (
      classifyRankingColor(colors[pool.headerRowIndex + slot]) === "advancing"
    ) {
      count++;
    }
  }
  return count > 0 ? count : null;
}

/** Sums advancingCount across a set of pools (normally just finalPools'
 * one pool per side, but a lettered final round can legitimately be
 * more than one). Ignores any pool whose count isn't known yet; only
 * returns null if none of them are known. */
function totalAdvancingCount(
  pools: ParsedPool[],
  colors: (CellColor | null)[],
): number | null {
  const counts = pools
    .map((p) => advancingCount(p, colors))
    .filter((c): c is number => c != null);
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
}

/** Combines a set of pools' own advancingNames(...), in order -- used
 * for the destination box, which shows every contributing pool's
 * advancing players. A pool contributes as soon as it finishes, without
 * waiting on any other pool passed in alongside it. */
function aggregateAdvancing(
  pools: ParsedPool[],
  colors: (CellColor | null)[],
): string[] | null {
  const names = pools.flatMap((pool) => advancingNames(pool, colors) ?? []);
  return names.length > 0 ? names : null;
}

/** The pool(s) at the highest set number for one side -- e.g. if the
 * winner's side numbers its pools 1 through 7, this returns just "Pool
 * 7" (or both "Pool 7A" and "Pool 7B" together, if the final round is
 * still split into lettered sub-sets sharing that same number -- see
 * poolSetNumber, which strips the letter). This is deliberately NOT every
 * pool on the side: the destination box represents that final round's
 * own actual result (who really finishes 1st-Nth overall), not a
 * running tally of every pool that has ever fed players forward. Also
 * doubles as the source of "how many advance" for the box's own title
 * (see its call sites) -- reads that count straight from however many
 * players the last pool's own Final Ranking colors mark advancing. */
function finalPools(pools: ParsedPool[]): ParsedPool[] {
  if (pools.length === 0) return [];
  const maxNumber = Math.max(...pools.map((p) => poolSetNumber(p.title)));
  return pools.filter((p) => poolSetNumber(p.title) === maxNumber);
}

/** Parses a Progression cell's shorthand -- {rank}P{L?}{number}{letter?},
 * e.g. "3PL2" = 3rd place of Pool L2, "1P1" = 1st place of Pool 1 --
 * into its rank (1-based) and the lowercase/trimmed lookup key its
 * source pool's title would have. null if the cell doesn't match this
 * format. */
function parseProgressionCode(
  progressionCode: string,
): { rank: number; sourceKey: string } | null {
  const match = progressionCode
    .trim()
    .match(/^(\d+)\s*p\s*(l)?\s*(\d+)\s*([a-z]?)$/i);
  if (!match) return null;
  const [, rankStr, loser, num, letter] = match;
  return {
    rank: parseInt(rankStr, 10),
    sourceKey: `pool ${loser ? "l" : ""}${num}${letter.toLowerCase()}`.trim(),
  };
}

/** "1st"/"2nd"/"3rd"/"4th"/... -- English ordinal suffix, handling the
 * 11th/12th/13th exceptions. */
function ordinal(rank: number): string {
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${rank}th`;
  switch (rank % 10) {
    case 1:
      return `${rank}st`;
    case 2:
      return `${rank}nd`;
    case 3:
      return `${rank}rd`;
    default:
      return `${rank}th`;
  }
}

// Every pool always has up to this many player slots -- mirrors
// parse-pools.ts's own `slotIndex < 4` cap (parsePoolsFromRows).
const POOL_SLOT_COUNT = 4;

// A pool box's own column deliberately GROWS to fit whatever's in it
// (gridStyle's own minmax(380px, max-content) pool-column tracks, see
// its own comment) rather than truncating like bracket-tree.tsx's fixed-
// width MatchBox does -- confirmed live this works correctly, right up
// until a genuinely long name (a long team tag plus a long gamer tag,
// not uncommon for a real roster) balloons that column, and every OTHER
// pool sharing it (same set number, different letter-row), well past
// what a normal browser tab would need to scroll for. That's fine in a
// resizable tab -- overflowX:auto plus the auto-pan camera's own
// programmatic scrollLeft assignment (recomputeScroll) handles it -- but
// this overlay is captured by OBS as a browser SOURCE at a FIXED canvas
// size, with no viewer able to drag a scrollbar the way a real browser
// tab allows; the auto-pan camera only centers WHICH pool is on screen,
// it can't shrink a single pool box that's already wider than the whole
// canvas. This budget keeps the "grow to fit" comfort for any normal-
// length name (chosen generously past minmax's own 380px floor) while
// still guaranteeing one outlier name can't blow out an entire pool
// column -- and by extension every pool sharing it, and the whole card
// -- past what actually fits on screen.
const MAX_POOL_NAME_CHARS = 30;
function truncatePoolName(name: string): string {
  return name.length > MAX_POOL_NAME_CHARS
    ? name.slice(0, MAX_POOL_NAME_CHARS - 1) + "…"
    : name;
}

/** One rendered slot in a PoolBox: a real, already-in-the-sheet player;
 * a predicted player resolved from a Progression code naming an exact
 * rank in an already-finished source pool (real name, but not yet an
 * official row in this pool's own sheet data); or a display-only
 * placeholder for a slot nothing can resolve yet. */
type PoolSlotDisplay =
  | { kind: "real"; row: PoolPlayerRow }
  | { kind: "predicted"; player: string; sourceTitle: string }
  | { kind: "placeholder"; label: string };

/** Resolves one empty slot's own Progression code to exactly what
 * should render there, no fallback to any other mechanism. A slot with
 * no code, or one that can't be resolved, says so plainly:
 *  - blank cell: "TBD" -- nothing stated yet, not an error.
 *  - "N/A" (or "NA", case-insensitive, optional slash either way): this
 *    seat is never getting filled by design -- a pool that's
 *    permanently short a player, not one still waiting on a result.
 *    Explicit user request to distinguish this from plain "TBD," which
 *    implied "coming eventually." Checked before the shorthand parse
 *    below since it isn't that shorthand at all, just a fixed keyword.
 *  - text that doesn't match the {rank}P{L?}{number}{letter?} shorthand
 *    at all, or names a pool that isn't currently loaded (a typo, or a
 *    renamed/removed pool): "TBD (Progression Code Error)" --
 *    something's actually wrong here, worth distinguishing from "not
 *    decided yet."
 *  - names a real pool that hasn't finished yet: an ordinal placeholder
 *    ("1st of Pool 1") -- the code itself already says this much, on
 *    its own, no other mechanism needed.
 *  - names a real, FINISHED pool but that rank doesn't actually exist
 *    in it (fewer real scores than the code implies): "TBD (Progression
 *    Code Error)" -- also a genuine anomaly, not a normal "still
 *    waiting" state.
 *  - names a real, finished pool with that rank resolvable: the actual
 *    player, straight from that pool's own score-rank (topScoreRanks),
 *    not Final Ranking's color (color only ever says
 *    advancing/eliminated, a 2-way split, never a precise ordinal) --
 *    real name, but not yet an official row in THIS pool's own sheet
 *    data. Still rendered with plain, non-placeholder styling though
 *    (see PoolBox's own "predicted" case) -- who it is is genuinely
 *    known at this point, not a guess. */
function resolveSlotDisplay(
  progressionCode: string,
  allPools: ParsedPool[],
): PoolSlotDisplay {
  if (!progressionCode) return { kind: "placeholder", label: "TBD" };
  if (/^n\/?a$/i.test(progressionCode.trim())) {
    return { kind: "placeholder", label: "N/A" };
  }
  const parsed = parseProgressionCode(progressionCode);
  if (!parsed) return { kind: "placeholder", label: "TBD (Progression Code Error)" };
  const source = allPools.find(
    (p) => p.title.trim().toLowerCase() === parsed.sourceKey,
  );
  if (!source) return { kind: "placeholder", label: "TBD (Progression Code Error)" };
  if (!source.finished) {
    return {
      kind: "placeholder",
      label: `${ordinal(parsed.rank)} of ${source.title}`,
    };
  }
  const ranks = topScoreRanks(source);
  const idx = [...ranks].find(([, r]) => r === parsed.rank)?.[0];
  const player = idx !== undefined ? source.rows[idx]?.player : undefined;
  if (!player) return { kind: "placeholder", label: "TBD (Progression Code Error)" };
  return { kind: "predicted", player, sourceTitle: source.title };
}

/** Builds all POOL_SLOT_COUNT rows for one pool, purely for PoolBox's
 * own rendering -- never mutates `pool.rows`. Kept local to this file
 * rather than a change to parse-pools.ts, since dashboard.tsx and
 * pool-results.tsx consume ParsedPool's exact current shape directly
 * and don't need this padding.
 *
 * Placed by each row's own `slotIndex` (real rows) or array position
 * (empty slots), not "every real row first, then pad the rest" -- a
 * pool whose seeded byes sit in non-adjacent rows needs a player to
 * stay in the row they're actually assigned to, not wherever
 * left-to-right padding would put them. */
function poolSlotDisplays(
  pool: ParsedPool,
  allPools: ParsedPool[],
): PoolSlotDisplay[] {
  const bySlot: (PoolSlotDisplay | undefined)[] = new Array(POOL_SLOT_COUNT);
  for (const row of pool.rows) {
    bySlot[row.slotIndex] = { kind: "real", row };
  }
  for (let slot = 0; slot < POOL_SLOT_COUNT; slot++) {
    if (bySlot[slot]) continue;
    const progressionCode = pool.progressionCodes[slot] || "";
    bySlot[slot] = resolveSlotDisplay(progressionCode, allPools);
  }
  return bySlot as PoolSlotDisplay[];
}

type PoolStatus = "final" | "live" | "upcoming";

/** A pool's own broadcast-facing status pill, or null to show none.
 * "Live" matches event.selectedPool (the operator's "Show on Overlay"
 * button in dashboard.tsx), not score-data inference. "Upcoming" is
 * opt-in per pool (event.gauntletPoolsUpcoming) rather than the
 * automatic default for every not-finished, not-selected pool. */
function poolStatus(
  pool: ParsedPool,
  selectedPool: string | null,
  upcomingPools: Record<string, boolean>,
): PoolStatus | null {
  if (pool.finished) return "final";
  if (pool.title === selectedPool) return "live";
  return upcomingPools[pool.title] ? "upcoming" : null;
}

const STATUS_LABELS: Record<PoolStatus, string> = {
  final: "Final",
  live: "Live",
  upcoming: "On Deck",
};

// Solid, high-contrast fills -- not Blueprint's Tag `intent`/`minimal`
// styling, which reads poorly layered over a pool's own arbitrary
// header-color tint. red = live, grey = final, gold = upcoming.
const STATUS_COLORS: Record<PoolStatus, string> = {
  final: COLORS.muted,
  live: COLORS.red,
  upcoming: COLORS.gold,
};

function PoolBox({
  title,
  pool,
  col,
  row,
  colors,
  headerColors,
  allPools,
  selectedPool,
  upcomingPools,
  scoreFormat,
}: {
  title: string;
  pool: ParsedPool | undefined;
  col: number;
  row: number;
  colors: (CellColor | null)[];
  /** Column B's own cell colors, aligned to this pool via headerRowIndex. */
  headerColors: (CellColor | null)[];
  /** So poolSlotDisplays/resolveSlotDisplay can look up a named source
   * pool by title for each of this pool's own empty slots. */
  allPools: ParsedPool[];
  selectedPool: string | null;
  upcomingPools: Record<string, boolean>;
  scoreFormat: ScoreFormat;
}) {
  // colorToCss(null) would return near-white, wrong for this dark card
  // -- "no sheet color set" falls through to boxHeaderStyle's own
  // appearance instead.
  const headerColor = pool ? (headerColors[pool.headerRowIndex] ?? null) : null;
  const status = pool ? poolStatus(pool, selectedPool, upcomingPools) : null;
  // Border picks up color from this box's own status pill, live/
  // upcoming only -- a finished or no-status pool doesn't need the
  // extra pull.
  const borderColor =
    status === "live" || status === "upcoming"
      ? STATUS_COLORS[status]
      : COLORS.border;
  // Same live/upcoming-only gate, translucent versions of the same
  // STATUS_COLORS hex values so the glow matches the border/pill.
  const glow =
    status === "live"
      ? "0 0 18px 2px rgba(239, 68, 68, 0.45)"
      : status === "upcoming"
        ? "0 0 18px 2px rgba(239, 199, 94, 0.45)"
        : "none";
  return (
    <div
      // Looked up by the auto-pan camera to find whichever pool is Live.
      data-pool-title={title}
      style={{
        ...boxStyle,
        border: `3px solid ${borderColor}`,
        boxShadow: glow,
        gridColumn: col,
        gridRow: row,
      }}
    >
      <div
        style={{
          ...poolHeaderBarStyle,
          backgroundColor: headerColor ? colorToCss(headerColor) : undefined,
        }}
      >
        <span>{title}</span>
        {status && (
          <span
            style={{ ...statusPillStyle, backgroundColor: STATUS_COLORS[status] }}
          >
            {STATUS_LABELS[status]}
          </span>
        )}
      </div>
      {!pool ? (
        <div style={emptyNoteStyle}>Not yet in sheet</div>
      ) : (
        <PoolRowList
          pool={pool}
          colors={colors}
          allPools={allPools}
          scoreFormat={scoreFormat}
        />
      )}
    </div>
  );
}

/** The name/score rows inside one PoolBox -- split out from PoolBox so
 * `pool` can be typed as non-optional here. */
function PoolRowList({
  pool,
  colors,
  allPools,
  scoreFormat,
}: {
  pool: ParsedPool;
  colors: (CellColor | null)[];
  allPools: ParsedPool[];
  scoreFormat: ScoreFormat;
}) {
  const statusByName = finalRankingStatusByName(pool, colors);
  return (
    <div style={poolRowListStyle}>
      {poolSlotDisplays(pool, allPools).map((slot, idx) => {
        if (slot.kind === "placeholder") {
          // Same convention as bracket-tree.tsx's describeEmptySlot: the
          // placeholder text sits inline where a real name would go.
          return (
            <div key={idx} style={{ ...poolRowStyle, ...placeholderRowStyle }}>
              <span style={poolPlayerNameStyle}>
                {truncatePoolName(slot.label)}
              </span>
              {/* Empty second cell, purely so this row's gridline
                  (borderBottom, on both cell styles) runs the full row
                  width like every real row's does -- without it, a
                  placeholder row's divider stopped short at the
                  label's own width instead of reaching the score
                  column, breaking the "spreadsheet" look. */}
              <span style={playerTotalStyle} />
            </div>
          );
        }
        if (slot.kind === "predicted") {
          // Real name, resolved from a Progression code naming an exact
          // rank in an already-FINISHED source pool -- who's landing in
          // this seat is genuinely KNOWN at this point, not a guess,
          // even though there's no official row in THIS pool's own
          // sheet data yet and so no real score to show. Plain
          // poolRowStyle, same as a real confirmed row below -- explicit
          // bug report: this used to also get placeholderRowStyle
          // (dimmed + italic), the exact same treatment a genuinely
          // unresolved "TBD" slot gets, which read as "we don't know
          // who's here yet" for a player who very much was known. Only
          // the score cell stays a plain "--" (unstyled, same as a real
          // row's own blank-total fallback below) -- that part really
          // is still unknown until this pool's sheet has a real row for
          // them.
          return (
            <div key={idx} style={poolRowStyle}>
              <span style={poolPlayerNameStyle}>
                {truncatePoolName(slot.player)}
              </span>
              <span style={playerTotalStyle}>--</span>
            </div>
          );
        }
        const playerRow = slot.row;
        // Advancing is read from Final Ranking's own color, keyed by
        // this row's own player name rather than cell position. Gated
        // on pool.finished, unlike the pool's own progression count
        // (advancingCount) -- naming a specific person waits for the
        // pool to actually be done.
        const status = pool.finished
          ? (statusByName.get(playerRow.player.trim().toLowerCase()) ?? null)
          : null;
        return (
          <div
            key={idx}
            style={{
              ...poolRowStyle,
              // Only "eliminated" shifts color (dims to COLORS.muted);
              // advancing renders as plain full-brightness text.
              color:
                status === "eliminated" ? COLORS.muted : COLORS.text,
            }}
          >
            <span style={poolPlayerNameStyle}>
              {truncatePoolName(playerRow.player)}
            </span>
            {/* playerRow.total is the sheet's own Total column cell,
                read as raw text (see PoolPlayerRow's own doc) -- run
                through formatSongScore (same helper pool-results.tsx's
                song/total cells use) so it respects the operator's
                chosen ScoreFormat instead of always showing whatever
                percentage shape the Sheet itself happens to format
                that cell as. */}
            <span style={playerTotalStyle}>
              {formatSongScore(playerRow.total, scoreFormat) || "--"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DestinationBox({
  title,
  col,
  row,
  advancing,
}: {
  title: string;
  col: number;
  /** A plain row number, or a CSS grid "start / span N" string -- one
   * shared destination box per side spans every one of that side's
   * letter-rows, staying vertically centered. */
  row: number | string;
  advancing: string[] | null;
}) {
  return (
    <div
      style={{
        ...boxStyle,
        gridColumn: col,
        gridRow: row,
        borderColor: COLORS.gold,
        justifyContent: "center",
      }}
    >
      <div style={{ ...boxHeaderStyle, color: COLORS.gold }}>{title}</div>
      {advancing ? (
        advancing.map((name) => (
          <div key={name} style={{ ...playerRowStyle, color: COLORS.text }}>
            <span style={playerNameStyle}>{name}</span>
          </div>
        ))
      ) : (
        <div style={emptyNoteStyle}>TBD</div>
      )}
    </div>
  );
}

function ArrowCell({
  col,
  row,
  count,
}: {
  col: number;
  row: number;
  /** How many players progress out of this pool, derived from Final
   * Ranking's own colors. null means not known yet -- the real count
   * varies pool to pool, so guessing a fixed number before the pool
   * finishes would be wrong as often as right. */
  count: number | null;
}) {
  return (
    // Positions within the grid cell itself, not the chip, so the chip
    // stays auto-sized instead of stretching to fill the column.
    <div
      style={{
        gridColumn: col,
        gridRow: row,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Solid chip -- plain muted text wasn't legible enough. The
          arrow is colored gold to match the destination box it points at. */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          color: COLORS.text,
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 999,
          padding: "6px 16px",
          fontFamily: BODY_FONT_FAMILY,
          fontSize: "0.8em",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
        }}
      >
        <span>{count != null ? `Top ${count}` : "TBD"}</span>
        {/* A CSS-drawn triangle, not the "→" character -- a Unicode
            arrow glyph's visible ink is asymmetric (arrowhead heavier
            than the shaft) and can render off-center depending on font/
            browser. A plain CSS triangle's visual center is always its
            box center. */}
        <span
          style={{
            width: 0,
            height: 0,
            borderTop: "0.5em solid transparent",
            borderBottom: "0.5em solid transparent",
            borderLeft: `0.7em solid ${COLORS.gold}`,
          }}
        />
      </div>
    </div>
  );
}

// The actual scrolling element -- real native horizontal scroll, not a
// CSS transform. `scrollBehavior: "smooth"` means a plain
// `scrollEl.scrollLeft = x` assignment animates on its own.
const scrollContainerStyle: React.CSSProperties = {
  width: "100%",
  overflowX: "auto",
  overflowY: "hidden",
  scrollBehavior: "smooth",
  scrollbarWidth: "none",
  msOverflowStyle: "none",
};

// WebKit/Chromium's `::-webkit-scrollbar` is a pseudo-element inline
// styles can't target -- needs a real `<style>` tag.
const HIDE_SCROLLBAR_CLASS = "gauntlet-pools-scroll-container";
const HIDE_SCROLLBAR_CSS = `.${HIDE_SCROLLBAR_CLASS}::-webkit-scrollbar { display: none; }`;

// `gridTemplateColumns` is built by the caller (GauntletPoolsOverlay's
// own gridColumnTemplate) -- (pool, arrow) repeated once per distinct
// set number across both sides, plus one trailing destination column.
// `numRows` is a label row plus one row per letter-group on each side.
//
// Each pool-column track is `minmax(240px, max-content)`, not a flat
// width -- a fixed width just clips any name too long to fit. The arrow
// (150px) and destination columns stay fixed -- only pool columns grow.
function gridStyle(
  gridTemplateColumns: string,
  numRows: number,
): React.CSSProperties {
  return {
    display: "grid",
    // Positioned ancestor for anything inside that needs one (e.g.
    // recomputeScroll's own offsetParent chain-walk).
    position: "relative",
    gridTemplateColumns,
    gridTemplateRows: `repeat(${numRows}, auto)`,
    columnGap: "2px",
    rowGap: "8px",
  };
}


const boxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  backgroundColor: COLORS.panel,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 18,
  padding: "16px 20px",
  minHeight: 160,
};

const boxHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontFamily: TITLE_FONT_FAMILY,
  fontWeight: 400,
  fontSize: "1.1em",
  marginBottom: 10,
};

// PoolBox-only header bar for the optional per-pool color tint. Bleeds
// through boxStyle's own padding via a matching negative margin so an
// actual tint reads as a real edge-to-edge bar.
const poolHeaderBarStyle: React.CSSProperties = {
  ...boxHeaderStyle,
  // Longhand top/left/right, not the `margin` shorthand -- inline React
  // styles apply at each key's first-insertion position, so a shorthand
  // added after the spread would silently overwrite boxHeaderStyle's
  // own earlier marginBottom.
  marginTop: -16,
  marginLeft: -20,
  marginRight: -20,
  padding: "12px 20px",
  // 15px, not boxStyle's own 18px -- a border's inner edge has to curve
  // tighter than its outer edge by roughly the border's own width to
  // stay concentric. 18 - 3 = 15.
  borderRadius: "15px 15px 0 0",
  marginBottom: 8,
};

const emptyNoteStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.8em",
  color: COLORS.muted,
  fontStyle: "italic",
};

// Same "not a real, in-sheet value" idea as bracket-tree.tsx's own
// describeEmptySlot rendering -- spread onto playerRowStyle rather than
// replacing it, so a placeholder row still lines up with real rows.
const placeholderRowStyle: React.CSSProperties = {
  color: COLORS.dim,
  fontStyle: "italic",
};

// A real two-column grid (name | score), not a flex row with
// justify-content:space-between -- every row shares the same two grid
// tracks, so the name/score columns (and the divider between them, see
// playerTotalStyle's borderLeft) line up down the whole box regardless
// of name length.
const playerRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  alignItems: "center",
  columnGap: 12,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.9em",
  padding: "8px 0",
  borderBottom: `1px solid ${COLORS.border}`,
};

// PoolBox's own row list is one shared grid, not one independent grid
// per row -- making every row's two cells direct items of one grid
// container (via display:contents below) forces every row to share the
// exact same two column tracks, so the vertical divider is pixel-
// identical top to bottom regardless of name length.
//
// This "0.9em" is the source of truth broadcast-theme.ts's own
// POOL_PLAYER_ROW_FONT_SIZE mirrors (cardStyle's base 28 * 0.9 = 25.2px)
// -- bracket-tree.tsx's MatchBox names are scaled to match this exactly.
// Changing this value without updating that one re-introduces the same
// "the two views don't actually match" drift this was written to fix.
const poolRowListStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  columnGap: 0,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.9em",
};

// display:contents -- this row's own box disappears for layout
// purposes, so its two children become direct items of the shared
// poolRowListStyle grid above. Inherited properties (color, font,
// italic) still cascade through normally.
const poolRowStyle: React.CSSProperties = {
  display: "contents",
};

// Still used by DestinationBox, whose column stays a fixed width --
// truncation is the right call there. Not used by PoolBox (see
// poolPlayerNameStyle below), whose column grows to fit instead.
const playerNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

// PoolBox names grow their own column instead of truncating -- see
// gridStyle's minmax(...) pool-column tracks. padding/borderBottom live
// here (not a wrapping row div) since this cell IS the box that paints
// them, its own row being display:contents.
const poolPlayerNameStyle: React.CSSProperties = {
  whiteSpace: "nowrap",
  padding: "8px 24px 8px 0",
  borderBottom: `1px solid ${COLORS.border}`,
};

// Vertical divider between a player's name and their score, as a
// borderLeft on the score cell -- every score cell across every row
// occupies the same grid track in the shared poolRowListStyle grid, so
// this always renders at the same x position.
const playerTotalStyle: React.CSSProperties = {
  fontWeight: 600,
  padding: "8px 0 8px 24px",
  borderLeft: `1px solid ${COLORS.border}`,
  borderBottom: `1px solid ${COLORS.border}`,
};
