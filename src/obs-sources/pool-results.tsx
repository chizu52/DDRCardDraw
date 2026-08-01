import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout, Tag } from "@blueprintjs/core";
import { ArrowRight } from "@blueprintjs/icons";
import {
  parsePoolsFromRows,
  topScoreRanks,
  ParsedPool,
} from "../sheets/parse-pools";
import {
  fetchPublicColumnBColors,
  fetchPublicSheetValues,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { CellColor, colorToCss } from "../sheets/sheets-export";
import { RowColorTiers, rowColorForRank } from "../sheets/row-colors";
import { useAppState } from "../state/store";

// Fallback poll interval -- covers the case where nobody on the Matches
// tab is around to trigger event.poolsRefreshedAt (see the useEffect
// below), e.g. this OBS source is left running unattended after a
// broadcast wraps for the night. Long, since the normal path is now the
// instant Partykit-synced signal, not this timer.
const FALLBACK_POLL_INTERVAL_MS = 60_000;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "not-found" }
  | { status: "ok"; pool: ParsedPool; headerColor: CellColor | null };

export function PoolResultsOverlay() {
  const [params] = useSearchParams();
  const apiKey = params.get("apiKey");
  const spreadsheetId = params.get("spreadsheetId");
  const sheetName = params.get("sheet") || "Pools";

  // Which pool to show, and how to display it, are room-synced state (see
  // event.slice.ts) instead of URL params -- set from the Matches tab's
  // "Show on Overlay" button and Matches Settings panel, so this URL never
  // has to change to switch pools or tweak display settings, matching how
  // every other OBS source in this app already works. Only the Sheets
  // credentials below stay URL-based (see copy-obs-source.ts for why).
  const poolTitle = useAppState((s) => s.event.selectedPool);
  const poolsRefreshedAt = useAppState((s) => s.event.poolsRefreshedAt);
  const advanceCount = useAppState((s) => s.event.overlayAdvanceCount);
  const rowColors = useAppState((s) => s.event.overlayRowColors);
  const rowColorTiers = useAppState((s) => s.event.overlayRowColorTiers);

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!poolTitle || !apiKey || !spreadsheetId) return;
    let cancelled = false;

    async function load() {
      try {
        // Colors are fetched separately from the values -- if that call
        // fails (e.g. a quota hiccup) the pool still renders, just
        // without its custom header color, rather than losing the actual
        // scores over a cosmetic-only failure.
        const [rows, colors] = await Promise.all([
          fetchPublicSheetValues(apiKey!, spreadsheetId!, sheetName),
          fetchPublicColumnBColors(
            apiKey!,
            spreadsheetId!,
            `${sheetName}!B:B`,
          ).catch(() => [] as (CellColor | null)[]),
        ]);
        if (cancelled) return;
        const { pools } = parsePoolsFromRows(rows);
        const pool = pools.find((p) => p.title === poolTitle);
        setState(
          pool
            ? {
                status: "ok",
                pool,
                headerColor: colors[pool.headerRowIndex] ?? null,
              }
            : { status: "not-found" },
        );
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
    // poolsRefreshedAt is intentionally a dependency with no other use --
    // the Matches tab bumps it after a successful Export so this effect
    // reruns and refetches immediately, instead of waiting on the
    // fallback timer above.
  }, [poolTitle, apiKey, spreadsheetId, sheetName, poolsRefreshedAt]);

  if (!apiKey || !spreadsheetId) {
    const missing = [!apiKey && "apiKey", !spreadsheetId && "spreadsheetId"]
      .filter(Boolean)
      .join(", ");
    return (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        Missing query parameter(s): {missing}. Use the "Copy Overlay URL" button
        in the Matches Settings tab rather than building this URL by hand -- it
        fills these in automatically from your saved Sheets settings.
      </Callout>
    );
  }
  if (!poolTitle) {
    return (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        No pool selected. Click "Show on Overlay" on a pool in the Matches tab.
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
  if (state.status === "not-found") {
    return (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        No pool titled "{poolTitle}" found in column B.
      </Callout>
    );
  }

  return (
    <PoolTable
      pool={state.pool}
      headerColor={state.headerColor}
      advanceCount={advanceCount}
      rowColors={rowColors}
      rowColorTiers={rowColorTiers}
    />
  );
}

// Same card/table shape as the Matches tab (dashboard.tsx's
// MatchesImportPanel) -- same thStyle/tdStyle layout, same header-color
// chip (colorToCss, shared from sheets-export.ts), same gold/silver rank
// highlighting -- so the broadcast overlay reads as a themed extension of
// the app's own UI rather than a one-off custom design. See the note
// above the style consts below for why colors are literal values here
// rather than reusing dashboard.tsx's CSS var references.
function PoolTable({
  pool,
  headerColor,
  advanceCount,
  rowColors,
  rowColorTiers,
}: {
  pool: ParsedPool;
  headerColor: CellColor | null;
  advanceCount: number;
  rowColors: boolean;
  rowColorTiers: RowColorTiers;
}) {
  // Only ranked (and only the advance arrow shown) once the pool is
  // marked Finished -- same convention the Dashboard's own gold/silver
  // highlighting already uses, so a still-in-progress pool never shows a
  // premature "this player already advanced".
  const ranks = pool.finished ? topScoreRanks(pool) : new Map<number, number>();

  return (
    <div style={cardStyle}>
      <div
        style={{ ...headerBarStyle, backgroundColor: colorToCss(headerColor) }}
      >
        <span>{pool.title}</span>
        <Tag round intent={pool.finished ? "success" : "danger"}>
          {pool.finished ? "Final" : "Live"}
        </Tag>
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.9em",
          tableLayout: "fixed",
        }}
      >
        {/* Fixed, content-independent column widths -- without
            table-layout: fixed, a plain HTML table recomputes every
            column's width from its widest current content on every
            render. The Player column only grows an advance-arrow Tag
            once a pool goes from Live to Final, so that recompute alone
            was enough to visibly reflow every other column at that
            moment. Locking widths here means the ADV Tag appearing can
            only affect its own cell (truncating via playerNameStyle
            below if needed), never the table's overall shape. */}
        <colgroup>
          <col style={{ width: "26%" }} />
          {Array.from({ length: pool.songCount }).map((_, i) => (
            <col key={i} style={{ width: `${60 / pool.songCount}%` }} />
          ))}
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={thStyle}>Player</th>
            {Array.from({ length: pool.songCount }).map((_, i) => (
              <th key={i} style={thStyle}>
                Song {i + 1}
              </th>
            ))}
            <th style={{ ...thStyle, borderRight: "none" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {pool.rows.map((row, rowIdx) => {
            const rank = ranks.get(rowIdx);
            const tierColor = rowColors
              ? rowColorForRank(rank, rowColorTiers)
              : null;
            const backgroundColor =
              tierColor ??
              (rowIdx % 2 === 0 ? "transparent" : "rgba(143,153,168,0.08)");
            const advances = rank !== undefined && rank <= advanceCount;
            return (
              <tr key={rowIdx} style={{ backgroundColor }}>
                <td style={{ ...tdStyle, fontWeight: 500 }}>
                  <div style={playerCellStyle}>
                    <span style={playerNameStyle}>{row.player}</span>
                    {advances && (
                      <Tag
                        minimal
                        intent="success"
                        icon={<ArrowRight size={12} />}
                      />
                    )}
                  </div>
                </td>
                {row.songs.map((s, j) => (
                  <td key={j} style={tdStyle}>
                    {s || "--"}
                  </td>
                ))}
                <td
                  style={{ ...tdStyle, borderRight: "none", fontWeight: 700 }}
                >
                  {row.total}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Plain literal colors, not CSS vars -- dashboard.tsx's Matches tab
// referenced --pt-divider-black/--pt-text-color-muted as if they were
// real Blueprint theme tokens, but Blueprint doesn't actually define
// those custom properties anywhere (see node_modules/@blueprintjs/core's
// compiled CSS), so they were always silently falling back to their
// fallback value. That's invisible inside the app's own page chrome, but
// this overlay is a bare, unwrapped route -- so the values here are the
// literal fallback dashboard.tsx's own thStyle/tdStyle already resolve
// to, copied exactly for a pixel match, rather than the non-functional
// var() wrapper. The one exception is the header chip's background,
// which now really is dynamic (colorToCss(headerColor) above) instead of
// a fallback-only var.
//
// Fills the OBS browser source's canvas (whatever width/height it was
// configured with in OBS) instead of a fixed minWidth -- previously this
// was `display: inline-block; minWidth: 480`, sized only to its own
// content, so it could sit tiny and unscaled inside a much larger source
// or get clipped inside a smaller one.
const cardStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #d8d8d8",
  borderRadius: "6px",
  overflow: "hidden",
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
};

// Keeps the player name and the advance-arrow Tag on the same line no
// matter how narrow the Player column ends up -- flex items in a row
// never wrap onto separate lines against each other (only flex-wrap does
// that, which this doesn't set), unlike the plain inline text + Tag this
// replaced, which could break between them when the table's other
// columns squeezed this one narrow.
const playerCellStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

// Truncates a long player name with an ellipsis instead of overflowing
// its now-fixed-width column (see the colgroup comment above). minWidth:
// 0 overrides a flex item's default min-width: auto, which otherwise
// stops it shrinking below its own content size and silently defeats
// text-overflow: ellipsis inside a flex container.
const playerNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const headerBarStyle: React.CSSProperties = {
  padding: "8px 14px",
  color: "black",
  borderBottom: "1px solid #d8d8d8",
  fontWeight: 600,
  fontSize: "1.05em",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: "0.8em",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: "#5c7080",
  borderBottom: "1px solid #d8d8d8",
  borderRight: "1px solid #e8e8e8",
};

const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRight: "1px solid #eee",
  borderBottom: "1px solid #f2f2f2",
};
