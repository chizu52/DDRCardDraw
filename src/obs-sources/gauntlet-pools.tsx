import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout, Tag } from "@blueprintjs/core";
import {
  parsePoolsFromRows,
  topScoreRanks,
  ParsedPool,
} from "../sheets/parse-pools";
import {
  fetchPublicSheetValues,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { useAppState } from "../state/store";
import {
  BODY_FONT_FAMILY,
  LOCAL_FONT_FACE_CSS,
  TITLE_FONT_FAMILY,
} from "./local-fonts";

// Same fallback-poll idea as pool-results.tsx -- covers this overlay
// being left running with nobody around to trigger
// event.poolsRefreshedAt (e.g. unattended after a broadcast wraps).
const FALLBACK_POLL_INTERVAL_MS = 60_000;

// Same dark broadcast-panel tokens as schedule.tsx, not just visually
// similar by coincidence -- reusing the exact values (rather than
// eyeballing a close match) is what makes this overlay actually read
// as "the same broadcast package" as Schedule when both are on stream
// together, not just two separately-designed dark panels.
const COLORS = {
  panel: "#1c2127",
  border: "#3a3f49",
  text: "#f6f7f9",
  muted: "#9aa2ac",
  mint: "#22c55e",
  gold: "#efc75e",
  coral: "#f0a868",
};

// Which pools are the loser's side of the gauntlet -- a "Pool L..."
// title (Pool L1, Pool L2, ...), same as the reference diagram. Every
// other pool matching parsePoolsFromRows' own /pool/i title match (see
// dashboard.tsx's MatchesImportPanel/Pool Results, which this mirrors
// exactly) is winner's side. Deliberately NOT a fixed list of exact
// titles/count anymore -- that silently dropped or blanked out any
// pool whose name or count didn't match the hardcoded 5 exactly,
// which is exactly the "wrong number of pools" bug this replaced.
// Locating pools this generically, off whatever's actually in the
// sheet, is the same principle Pool Results already uses.
const LOSER_POOL_TITLE = /^pool\s*l/i;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; pools: ParsedPool[] };

export function GauntletPoolsOverlay() {
  const [params] = useSearchParams();
  const apiKey = params.get("apiKey");
  const spreadsheetId = params.get("spreadsheetId");
  const sheetName = params.get("sheet") || "Pools";

  // No room-synced "which pool" selector here -- unlike pool-results.tsx,
  // this overlay always shows every pool at once. poolsRefreshedAt is
  // still the right signal to re-fetch on: it's the same "something in
  // the Pools sheet changed" bump the Matches tab already sends after
  // every Export, regardless of which specific pool changed.
  const poolsRefreshedAt = useAppState((s) => s.event.poolsRefreshedAt);

  const [state, setState] = useState<LoadState>({ status: "loading" });

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
        setState({ status: "ok", pools });
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

  if (!apiKey || !spreadsheetId) {
    const missing = [!apiKey && "apiKey", !spreadsheetId && "spreadsheetId"]
      .filter(Boolean)
      .join(", ");
    return (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        Missing query parameter(s): {missing}. Use the "Copy Overlay URL"
        button in the Gauntlet Pools Overlay settings section rather than
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

  // Same discovery as Pool Results: take every pool parsePoolsFromRows
  // actually found, no assumed count or exact-name list. The only thing
  // added on top is sorting into two rows by the "Pool L..." naming
  // convention -- relative order within each row is whatever order the
  // sheet already lists them in (parsePoolsFromRows appends in scan
  // order), same as Pool Results' own pool list.
  const loserPools = state.pools.filter((p) => LOSER_POOL_TITLE.test(p.title));
  const winnerPools = state.pools.filter(
    (p) => !LOSER_POOL_TITLE.test(p.title),
  );
  // Grid needs enough pool-columns for the longer of the two rows --
  // the shorter row's own destination box just follows immediately
  // after its own last pool rather than trying to force both rows'
  // destination boxes into the same column when the counts differ.
  const maxCols = Math.max(winnerPools.length, loserPools.length, 1);

  return (
    <div style={cardStyle}>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      <div style={gridStyle(maxCols)}>
        {winnerPools.map((pool, i) => (
          <PoolBox key={pool.title} title={pool.title} pool={pool} col={1 + i * 2} row={1} />
        ))}
        {winnerPools.map((_, i) => (
          <ArrowCell key={i} col={2 + i * 2} row={1} label="Top 2" />
        ))}
        {winnerPools.length > 0 && (
          <DestinationBox
            title="Top 4 Winner's Side"
            col={1 + winnerPools.length * 2}
            row={1}
            advancing={topTwoNames(winnerPools[winnerPools.length - 1])}
          />
        )}

        {/* Vertical connectors pair pools by position (i-th winner pool
            -> i-th loser pool) -- both rows place their i-th pool at
            the same column (1 + i*2), so this lines up under whichever
            pool is actually there without needing to know a specific
            title in advance. A row longer than the other just leaves
            the extra pools without a connector, rather than guessing
            where an uneven pool's bottom-2 actually goes. */}
        {Array.from({ length: Math.min(winnerPools.length, loserPools.length) }).map(
          (_, i) => (
            <ArrowCell
              key={i}
              col={1 + i * 2}
              row={2}
              label="Bottom 2"
              vertical
            />
          ),
        )}

        {loserPools.map((pool, i) => (
          <PoolBox key={pool.title} title={pool.title} pool={pool} col={1 + i * 2} row={3} />
        ))}
        {loserPools.map((_, i) => (
          <ArrowCell key={i} col={2 + i * 2} row={3} label="Top 2" />
        ))}
        {loserPools.length > 0 && (
          <DestinationBox
            title="Top 4 Loser's Side"
            col={1 + loserPools.length * 2}
            row={3}
            advancing={topTwoNames(loserPools[loserPools.length - 1])}
          />
        )}
      </div>
    </div>
  );
}

/** Top 2 player names by score, only once the pool is marked Finished --
 * same "don't show a premature result" convention pool-results.tsx uses
 * for its own advance-arrow tags. Undefined pool (not in the sheet yet)
 * or not yet finished both just render as "TBD". */
function topTwoNames(pool: ParsedPool | undefined): string[] | null {
  if (!pool || !pool.finished) return null;
  const ranks = topScoreRanks(pool);
  return pool.rows
    .map((row, idx) => ({ row, rank: ranks.get(idx) }))
    .filter((r) => r.rank !== undefined && r.rank <= 2)
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => r.row.player);
}

function PoolBox({
  title,
  pool,
  col,
  row,
}: {
  title: string;
  pool: ParsedPool | undefined;
  col: number;
  row: number;
}) {
  const ranks = pool?.finished ? topScoreRanks(pool) : new Map<number, number>();
  return (
    <div style={{ ...boxStyle, gridColumn: col, gridRow: row }}>
      <div style={boxHeaderStyle}>
        <span>{title}</span>
        {pool && (
          <Tag round minimal intent={pool.finished ? "success" : "danger"}>
            {pool.finished ? "Final" : "Live"}
          </Tag>
        )}
      </div>
      {!pool ? (
        <div style={emptyNoteStyle}>Not yet in sheet</div>
      ) : (
        <div>
          {pool.rows.map((r, idx) => {
            const rank = ranks.get(idx);
            const advancing = rank !== undefined && rank <= 2;
            return (
              <div
                key={idx}
                style={{
                  ...playerRowStyle,
                  color: pool.finished
                    ? advancing
                      ? COLORS.mint
                      : COLORS.muted
                    : COLORS.text,
                }}
              >
                <span style={playerNameStyle}>{r.player}</span>
                <span style={playerTotalStyle}>{r.total || "--"}</span>
              </div>
            );
          })}
        </div>
      )}
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
  row: number;
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
  label,
  vertical,
}: {
  col: number;
  row: number;
  label: string;
  vertical?: boolean;
}) {
  return (
    <div
      style={{
        gridColumn: col,
        gridRow: row,
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        color: COLORS.muted,
        fontFamily: BODY_FONT_FAMILY,
        fontSize: "0.8em",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: "1.3em" }}>{vertical ? "↓" : "→"}</span>
    </div>
  );
}

// One cohesive card, same outer treatment as schedule.tsx (rgba(17, 20,
// 24, 0.92) fill, 20px radius, inline-block so it sizes to its own
// content) -- previously this overlay was just a bare grid of floating
// boxes straight on the page background, the biggest visible gap
// against Schedule's "one panel" look when the two sit on stream
// together. Deliberately NOT importing schedule.tsx's own banner-art
// backdrop here -- that image is that overlay's specific branding, and
// reusing the identical background on a second, simultaneously-visible
// overlay would read as a duplicated backdrop rather than a shared
// design system. Ask if you want that added too.
const cardStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  background: "rgba(17, 20, 24, 0.92)",
  borderRadius: 20,
  padding: 24,
  display: "inline-block",
  color: COLORS.text,
};

// `count` is however many pool-columns the longer row needs (see
// maxCols above) -- (pool, arrow) repeated `count` times, plus one
// trailing destination column. A fixed 7-column template only ever fit
// the originally-assumed 3-winner/2-loser shape; this scales to
// whatever the sheet actually has.
function gridStyle(count: number): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(${count}, 180px 56px) 180px`,
    // 3 rows: winner pools, a thin row for the vertical bottom-2 arrows,
    // loser pools.
    gridTemplateRows: "auto 40px auto",
    columnGap: "4px",
    rowGap: "4px",
  };
}

// 14px radius and a plain 1px border, matching schedule.tsx's own row
// treatment (not that overlay's header panel, which gets a heavier 3px
// white border reserved for the one biggest element on its page --
// nothing here plays quite that role, so every box here stays at row
// weight instead of header weight).
const boxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  backgroundColor: COLORS.panel,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 14,
  padding: "10px 14px",
  minHeight: 100,
};

const boxHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontFamily: TITLE_FONT_FAMILY,
  fontWeight: 400,
  fontSize: "1.1em",
  marginBottom: 6,
};

const emptyNoteStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.8em",
  color: COLORS.muted,
  fontStyle: "italic",
};

const playerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.9em",
  padding: "2px 0",
};

const playerNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const playerTotalStyle: React.CSSProperties = {
  fontWeight: 600,
  flexShrink: 0,
};
