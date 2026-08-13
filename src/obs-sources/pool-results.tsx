import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout } from "@blueprintjs/core";
import {
  parsePoolsFromRows,
  topScoreRanks,
  colIndexToLetter,
  finalRankingStatusByName,
  formatSongScore,
  sumScores,
  ParsedPool,
} from "../sheets/parse-pools";
import {
  fetchPublicColumnBColors,
  fetchPublicSheetValues,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { decodeSheetsConnection } from "../sheets/sheets-connection-param";
import { CellColor, colorToCss } from "../sheets/sheets-export";
import { RowColorTiers, rowColorForRank } from "../sheets/row-colors";
import { useAppState } from "../state/store";
import {
  BODY_FONT_FAMILY,
  LOCAL_FONT_FACE_CSS,
  TITLE_FONT_FAMILY,
} from "./local-fonts";

// Same dark broadcast-panel tokens gauntlet-pools.tsx/schedule.tsx use --
// explicit user request to bring this overlay in line with those two
// rather than staying on its own separate light/white Blueprint-table
// look. Scope is colors/fonts/status-pill styling only (confirmed with
// the user) -- no banner backdrop or title/icon header bar here, this
// overlay keeps its existing single pool-title header bar, just
// recolored.
const COLORS = {
  panel: "#1c2127",
  border: "#3a3f49",
  text: "#f6f7f9",
  muted: "#9aa2ac",
  mint: "#22c55e",
  gold: "#efc75e",
  coral: "#f0a868",
  red: "#ef4444",
};

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
  | {
      status: "ok";
      pool: ParsedPool;
      headerColor: CellColor | null;
      /** Final Ranking column's own cell colors, one per raw sheet row --
       * same mechanism gauntlet-pools.tsx uses (see its own
       * classifyRankingColor/finalRankingStatusByName) so advancement here
       * reads from the sheet's own color-coding instead of a manually
       * configured count that can drift out of sync with what the sheet
       * actually says. */
      rankingColors: (CellColor | null)[];
    };

export function PoolResultsOverlay() {
  const [params] = useSearchParams();
  // Credentials now travel as one opaque `src` param (see
  // sheets-connection-param.ts) rather than plain readable
  // `apiKey`/`spreadsheetId` params -- explicit user request. Falls back
  // to those old params directly when `src` isn't present so an OBS
  // source already configured with the old-style URL (copied before this
  // change) keeps working without needing to be re-copied/re-pasted.
  const decoded = decodeSheetsConnection(params.get("src"));
  const apiKey = decoded.apiKey ?? params.get("apiKey");
  const spreadsheetId = decoded.spreadsheetId ?? params.get("spreadsheetId");
  const sheetName = decoded.sheet ?? params.get("sheet") ?? "Pools";

  // Which pool to show, and how to display it, are room-synced state (see
  // event.slice.ts) instead of URL params -- set from the Matches tab's
  // "Show on Overlay" button and Matches Settings panel, so this URL never
  // has to change to switch pools or tweak display settings, matching how
  // every other OBS source in this app already works. Only the Sheets
  // credentials below stay URL-based (see copy-obs-source.ts for why).
  const poolTitle = useAppState((s) => s.event.selectedPool);
  const poolsRefreshedAt = useAppState((s) => s.event.poolsRefreshedAt);
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
        if (!pool) {
          setState({ status: "not-found" });
          return;
        }
        // Same two-stage fetch as gauntlet-pools.tsx -- the Final Ranking
        // column's letter isn't known until after parsing (found by
        // header text), so this can't run alongside the values/header-color
        // fetch above. No Final Ranking column on this sheet at all
        // (finalRankingCol null) just skips the fetch -- advancement then
        // reads as "unknown" for every row (classifyRankingColor's
        // callers), not a crash.
        const rankingColors =
          pool.finalRankingCol != null
            ? await fetchPublicColumnBColors(
                apiKey!,
                spreadsheetId!,
                `${sheetName}!${colIndexToLetter(pool.finalRankingCol)}:${colIndexToLetter(pool.finalRankingCol)}`,
              ).catch(() => [] as (CellColor | null)[])
            : [];
        if (cancelled) return;
        setState({
          status: "ok",
          pool,
          headerColor: colors[pool.headerRowIndex] ?? null,
          rankingColors,
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
      rankingColors={state.rankingColors}
      rowColors={rowColors}
      rowColorTiers={rowColorTiers}
    />
  );
}

// Dark broadcast-panel theme now, matching gauntlet-pools.tsx/
// schedule.tsx (explicit user request) rather than the Matches tab's own
// light Blueprint-table look this used to mirror -- same thStyle/tdStyle
// layout and same header-color chip (colorToCss, shared from
// sheets-export.ts) as before, just recolored. Row tier highlighting
// (rowColorForRank) and the zebra-stripe fallback are untouched --
// both are already low-opacity rgba() tints that blend correctly over
// either a light or dark base, so nothing there needed to change.
function PoolTable({
  pool,
  headerColor,
  rankingColors,
  rowColors,
  rowColorTiers,
}: {
  pool: ParsedPool;
  headerColor: CellColor | null;
  rankingColors: (CellColor | null)[];
  rowColors: boolean;
  rowColorTiers: RowColorTiers;
}) {
  // Only ranked (and only the advance arrow shown) once the pool is
  // marked Finished -- same convention the Dashboard's own gold/silver
  // highlighting already uses, so a still-in-progress pool never shows a
  // premature "this player already advanced".
  const ranks = pool.finished ? topScoreRanks(pool) : new Map<number, number>();
  // Same name-keyed lookup gauntlet-pools.tsx uses (see
  // finalRankingStatusByName's own doc for why by NAME, not row position)
  // -- gated on pool.finished for the same reason `ranks` above is: a
  // Final Ranking cell can be pre-colored by template before any real
  // name is in it, so attributing a specific person to a winning slot
  // before the pool is genuinely done would be a guess, not a fact yet.
  const statusByName = pool.finished
    ? finalRankingStatusByName(pool, rankingColors)
    : new Map<string, "advancing" | "eliminated">();

  // Standings sorted by current score, highest first -- explicit user
  // request ("reorganize the players and their rows by highest score to
  // lowest") so this reads as a live leaderboard instead of staying in
  // original seed/entry order. Array.prototype.sort is stable per spec,
  // so ties keep their original relative order -- same tie-break
  // convention topScoreRanks already documents ("ties broken by row
  // order"). Rank/tier lookups below still key off each row's ORIGINAL
  // index (rowIdx, into pool.rows) -- unrelated to this sort, ranks was
  // already built from that same original index space, so nothing else
  // needs to change to stay correct.
  const sortedRows = pool.rows
    .map((row, rowIdx) => ({
      row,
      rowIdx,
      total: parseFloat(sumScores(row.songs)),
    }))
    .sort((a, b) => b.total - a.total);

  return (
    <div style={cardStyle}>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      <div
        style={{
          ...headerBarStyle,
          // colorToCss(null) would return "#f5f5f5" (near-white) --
          // right for this overlay's OLD light card, wrong for the dark
          // COLORS.panel one now. "No sheet color set" falls through to
          // headerBarStyle's own background instead (same fix
          // gauntlet-pools.tsx's PoolBox already applied for the exact
          // same reason).
          backgroundColor: headerColor ? colorToCss(headerColor) : undefined,
        }}
      >
        <span>{pool.title}</span>
        {/* Solid pill, not Blueprint's Tag `intent`/`round` -- same
            "washed out over an arbitrary header tint" problem
            gauntlet-pools.tsx's own status pills already solved (see
            its STATUS_COLORS/statusPillStyle). Only two states here
            (not gauntlet-pools' three) -- this overlay only ever shows
            the ONE pool the operator has actually selected, so there's
            no "Upcoming" to distinguish from "Live." Same grey=final /
            red=live color meaning as gauntlet-pools' own pills, for
            genuine cross-overlay consistency. */}
        <span
          style={{
            ...statusPillStyle,
            backgroundColor: pool.finished ? COLORS.muted : COLORS.red,
          }}
        >
          {pool.finished ? "Final" : "Live"}
        </span>
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
          <col style={{ width: "24%" }} />
          {Array.from({ length: pool.songCount }).map((_, i) => (
            <col key={i} style={{ width: `${54 / pool.songCount}%` }} />
          ))}
          <col style={{ width: "12%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={thStyle}>Player</th>
            {Array.from({ length: pool.songCount }).map((_, i) => (
              <th key={i} style={thStyle}>
                Song {i + 1}
              </th>
            ))}
            <th style={thStyle}>Total</th>
            <th style={{ ...thStyle, borderRight: "none" }}>Diff</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(({ row, rowIdx, total }, displayIdx) => {
            const rank = ranks.get(rowIdx);
            const tierColor = rowColors
              ? rowColorForRank(rank, rowColorTiers)
              : null;
            const backgroundColor =
              tierColor ??
              (displayIdx % 2 === 0
                ? "transparent"
                : "rgba(143,153,168,0.08)");
            // Automatic now -- reads the sheet's own Final Ranking color
            // for this player's name, same as gauntlet-pools.tsx, rather
            // than a manually configured cutoff count that could drift
            // out of sync with what the sheet actually marks (a pool's
            // real advance count varies: 1, 2, or 3 players, never a
            // single fixed number across every pool).
            const status =
              statusByName.get(row.player.trim().toLowerCase()) ?? null;
            // How far off this player is from the opponent directly
            // above them in the current sorted standings -- explicit
            // user request. First place (displayIdx 0) never has one.
            // Also withheld for a player with no real score yet (total
            // 0 -- same "not entered yet" convention topScoreRanks
            // already uses) since there's nothing real to be "off" from.
            const above = displayIdx > 0 ? sortedRows[displayIdx - 1] : null;
            const diffText =
              above && total > 0
                ? `-${(above.total - total).toFixed(4)}%`
                : "";
            return (
              <tr key={rowIdx} style={{ backgroundColor }}>
                <td style={{ ...tdStyle, fontWeight: 500 }}>
                  {/* Same convention as gauntlet-pools.tsx's own
                      PoolRowList -- advancing/eliminated status reads
                      from the player's own NAME color, not a separate
                      Tag/icon (replaces the old ArrowRight Tag), so
                      this overlay's row highlighting looks and behaves
                      identically to the diagram overlay's. */}
                  <span
                    style={{
                      ...playerNameStyle,
                      // Advancing used to render in COLORS.mint (green) --
                      // explicit user request to switch that to plain
                      // COLORS.text (white) instead, same as
                      // gauntlet-pools.tsx's identical convention (kept in
                      // sync, same request applied to both overlays). Only
                      // "eliminated" still shifts color (dims to
                      // COLORS.muted); a winning player just reads as
                      // normal/full brightness now, no separate accent.
                      color:
                        status === "eliminated" ? COLORS.muted : COLORS.text,
                    }}
                  >
                    {row.player}
                  </span>
                </td>
                {row.songs.map((s, j) => (
                  <td key={j} style={tdStyle}>
                    {formatSongScore(s) || "--"}
                  </td>
                ))}
                <td style={{ ...tdStyle, fontWeight: 700 }}>{row.total}</td>
                <td
                  style={{
                    ...tdStyle,
                    borderRight: "none",
                    color: COLORS.red,
                    fontWeight: 600,
                  }}
                >
                  {diffText || "--"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Dark COLORS tokens now, not literal light-mode hex values -- explicit
// user request to match gauntlet-pools.tsx/schedule.tsx's palette
// instead of the Matches tab's own light Blueprint-table look this used
// to mirror pixel-for-pixel. `fontSynthesis: "none"` for the same reason
// gauntlet-pools.tsx/schedule.tsx both set it: the custom @font-face
// (local-fonts.ts) only ever registers ONE weight (400) per font, so any
// element here asking for a different weight would otherwise get a
// faked, blurry-looking synthetic bold instead of the font's own true
// glyphs -- see gauntlet-pools.tsx's cardStyle for the fuller writeup.
//
// Still fills the OBS browser source's canvas (whatever width/height it
// was configured with in OBS) instead of a fixed minWidth -- unrelated
// to the color change, this behavior is unchanged from before.
const cardStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontFamily: BODY_FONT_FAMILY,
  fontSynthesis: "none",
  // Explicit base, not left to inherit the browser default -- same real
  // bug, same fix as gauntlet-pools.tsx's own cardStyle (see its fuller
  // writeup): every size below is an `em` value relative to whatever
  // this cascades down as, which measured genuinely too small (table
  // headers at ~10px) once checked against a true 1920x1080 viewport
  // instead of the small preview used for most of this file's own
  // visual verification.
  fontSize: 28,
  color: COLORS.text,
  background: COLORS.panel,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 14,
  overflow: "hidden",
};

// Truncates a long player name with an ellipsis instead of overflowing
// its fixed-width column (see the colgroup comment above).
const playerNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const headerBarStyle: React.CSSProperties = {
  padding: "14px 24px",
  color: COLORS.text,
  borderBottom: `1px solid ${COLORS.border}`,
  fontFamily: TITLE_FONT_FAMILY,
  fontWeight: 400,
  fontSize: "1.1em",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "16px",
};

// Same solid-pill treatment as gauntlet-pools.tsx's own statusPillStyle
// -- not Blueprint's Tag `intent`/`round`, whose barely-tinted look
// washes out over an arbitrary sheet-set header color the same way it
// did there. See this overlay's own two call-site colors (COLORS.muted
// for Final, COLORS.red for Live) in PoolTable above.
const statusPillStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "5px 16px",
  borderRadius: 999,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.75em",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: COLORS.panel,
  whiteSpace: "nowrap",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "14px 18px",
  fontSize: "0.8em",
  fontFamily: BODY_FONT_FAMILY,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: COLORS.muted,
  borderBottom: `1px solid ${COLORS.border}`,
  borderRight: `1px solid ${COLORS.border}`,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontFamily: BODY_FONT_FAMILY,
  borderRight: `1px solid ${COLORS.border}`,
  borderBottom: `1px solid ${COLORS.border}`,
};
