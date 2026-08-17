import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout } from "@blueprintjs/core";
import {
  parsePoolsFromRows,
  colIndexToLetter,
  finalRankingStatusByName,
  formatSongScore,
  formatScoreValue,
  sumScoreValues,
  topScoreRanks,
  ParsedPool,
  PoolPlayerRow,
  ScoreFormat,
} from "../sheets/parse-pools";
import {
  fetchPublicCellColors,
  fetchPublicSheetValues,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { decodeSheetsConnection } from "../sheets/sheets-connection-param";
import { CellColor, colorToCss } from "../sheets/sheets-export";
import { rowColorForRank, RowColorTiers } from "../sheets/row-colors";
import { useAppState } from "../state/store";
import {
  BODY_FONT_FAMILY,
  LOCAL_FONT_FACE_CSS,
  TITLE_FONT_FAMILY,
} from "./local-fonts";
import { BROADCAST_COLORS, statusPillStyle } from "./broadcast-theme";
import {
  MARQUEE_KEYFRAMES_CSS,
  MarqueeText,
  useMarqueeDistances,
} from "./marquee";

// Scope is colors/fonts/status-pill styling only -- no banner backdrop
// or title/icon header bar here, this overlay keeps its existing
// single pool-title header bar, just recolored.
const COLORS = {
  ...BROADCAST_COLORS,
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
  // Credentials travel as one opaque `src` param (see
  // sheets-connection-param.ts), falling back to plain `apiKey`/
  // `spreadsheetId` params for an OBS source configured with the old URL.
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
  const scoreFormat = useAppState((s) => s.event.overlayScoreFormat);

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!poolTitle || !apiKey || !spreadsheetId) return;
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
        const pool = pools.find((p) => p.title === poolTitle);
        if (!pool) {
          setState({ status: "not-found" });
          return;
        }
        // Header color and Final Ranking color used to be two separate
        // Sheets API calls (one Promise.all'd alongside the values fetch,
        // one after -- the Final Ranking column's letter isn't known
        // until after parsing). Combined into ONE multi-range request now
        // (fetchPublicCellColors) -- see its own comment for why: every
        // overlay polling independently made the old per-call approach a
        // real contributor to hitting Google's per-minute Sheets API read
        // quota. Both ranges are known by this point regardless (the
        // Final Ranking column comes from the SAME parse the values
        // fetch already produced), so there's no real reason left to
        // keep them as separate requests. Wrapped in its own catch --
        // a color-fetch hiccup degrades to "no header tint, advancement
        // unknown" rather than losing the actual scores over a
        // cosmetic/secondary failure.
        const colorRanges = [`${sheetName}!B:B`];
        if (pool.finalRankingCol != null) {
          colorRanges.push(
            `${sheetName}!${colIndexToLetter(pool.finalRankingCol)}:${colIndexToLetter(pool.finalRankingCol)}`,
          );
        }
        const [colors, rankingColors] = await fetchPublicCellColors(
          apiKey!,
          spreadsheetId!,
          colorRanges,
        ).catch(() => colorRanges.map(() => [] as (CellColor | null)[]));
        if (cancelled) return;
        setState({
          status: "ok",
          pool,
          headerColor: colors[pool.headerRowIndex] ?? null,
          rankingColors: rankingColors ?? [],
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
      scoreFormat={scoreFormat}
    />
  );
}

// Dark broadcast-panel theme, matching gauntlet-pools.tsx/schedule.tsx
// -- same thStyle/tdStyle layout and header-color chip as before, just
// recolored. Row highlighting and the zebra-stripe fallback are
// untouched -- both are already low-opacity rgba() tints that blend
// correctly over either a light or dark base.
function PoolTable({
  pool,
  headerColor,
  rankingColors,
  rowColors,
  rowColorTiers,
  scoreFormat,
}: {
  pool: ParsedPool;
  headerColor: CellColor | null;
  rankingColors: (CellColor | null)[];
  rowColors: boolean;
  rowColorTiers: RowColorTiers;
  scoreFormat: ScoreFormat;
}) {
  // Same name-keyed lookup gauntlet-pools.tsx uses (see
  // finalRankingStatusByName's own doc for why by NAME, not row position)
  // -- gated on pool.finished for the same reason `ranks` above is: a
  // Final Ranking cell can be pre-colored by template before any real
  // name is in it, so attributing a specific person to a winning slot
  // before the pool is genuinely done would be a guess, not a fact yet.
  const statusByName = pool.finished
    ? finalRankingStatusByName(pool, rankingColors)
    : new Map<string, "advancing" | "eliminated">();

  // Rank still determines WHICH tier color an advancing row gets (see
  // row-colors.ts's own module doc) -- same finished gate as
  // statusByName above, same function the Matches tab preview table
  // uses, so this overlay and that table can't drift into disagreement
  // on which placement a row counts as.
  const ranks = pool.finished
    ? topScoreRanks(pool)
    : new Map<number, number>();

  // Standings sorted by current score, highest first, so this reads as
  // a live leaderboard instead of staying in original seed/entry order.
  // Array.prototype.sort is stable, so ties keep their original
  // relative order. Rank/tier lookups below still key off each row's
  // original index (rowIdx, into pool.rows), unrelated to this sort.
  const sortedRows = pool.rows
    .map((row, rowIdx) => ({
      row,
      rowIdx,
      total: sumScoreValues(row.songs),
    }))
    .sort((a, b) => b.total - a.total);

  return (
    <div style={cardStyle}>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      {/* Same reasoning, for @keyframes this time -- covers every row's
          own name marquee below (see PoolResultRow), since @keyframes
          are referenced by name, not scoped to wherever declared. */}
      <style>{MARQUEE_KEYFRAMES_CSS}</style>
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
            only affect its own cell (the name marquees instead of
            reflowing anything else, see PoolResultRow), never the
            table's overall shape. */}
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
            // Automatic -- reads the sheet's own Final Ranking color for
            // this player's name, same as gauntlet-pools.tsx, rather
            // than a manually configured rank cutoff that could drift
            // out of sync with what the sheet actually marks (a pool's
            // real advance count varies: 1, 2, or 3 players, never a
            // single fixed number across every pool). Drives BOTH the
            // row's own background tint (see row-colors.ts) and the
            // advance arrow Tag further down -- one signal, not two
            // separately-configured ones that could disagree.
            const status =
              statusByName.get(row.player.trim().toLowerCase()) ?? null;
            const tierColor = rowColors
              ? rowColorForRank(ranks.get(rowIdx), status, rowColorTiers)
              : null;
            const backgroundColor =
              tierColor ??
              (displayIdx % 2 === 0
                ? "transparent"
                : "rgba(143,153,168,0.08)");
            // How far off this player is from the opponent directly
            // above them in the current sorted standings -- explicit
            // user request. First place (displayIdx 0) never has one.
            // Also withheld for a player with no real score yet (total
            // 0 -- nothing real to be "off" from).
            const above = displayIdx > 0 ? sortedRows[displayIdx - 1] : null;
            const diffText =
              above && total > 0
                ? `-${formatScoreValue(above.total - total, scoreFormat)}`
                : "";
            return (
              <PoolResultRow
                key={rowIdx}
                row={row}
                backgroundColor={backgroundColor}
                status={status}
                diffText={diffText}
                scoreFormat={scoreFormat}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Its own component, not rendered inline inside PoolTable's own
// sortedRows.map -- the player-name marquee below needs its own
// useRef/useMarqueeDistances (see marquee.tsx), and hooks can only be
// called from a genuine component instance, not from inside a plain
// callback passed to .map(). Same reason schedule.tsx's own per-row
// marquee needed ScheduleRow to be a real component rather than staying
// inline in Schedule's own render.
function PoolResultRow({
  row,
  backgroundColor,
  status,
  diffText,
  scoreFormat,
}: {
  row: PoolPlayerRow;
  backgroundColor: string;
  status: "advancing" | "eliminated" | null;
  diffText: string;
  scoreFormat: ScoreFormat;
}) {
  const nameBoxRef = useRef<HTMLDivElement>(null);
  const nameContentRef = useRef<HTMLDivElement>(null);
  const marqueeDistances = useMarqueeDistances(
    [{ key: "name", boxRef: nameBoxRef, contentRef: nameContentRef }],
    [row.player],
  );
  const nameDistance = marqueeDistances.get("name") ?? 0;
  const nameDuration =
    POOL_MARQUEE_BASE_DURATION_S + nameDistance / POOL_MARQUEE_SPEED_PX_PER_S;
  return (
    <tr style={{ backgroundColor }}>
      <td style={{ ...tdStyle, fontWeight: 500 }}>
        {/* Same convention as gauntlet-pools.tsx's own PoolRowList --
            advancing/eliminated status reads from the player's own NAME
            color, not a separate Tag/icon (replaces the old ArrowRight
            Tag), so this overlay's row highlighting looks and behaves
            identically to the diagram overlay's.

            Scrolls instead of truncating with an ellipsis when the name
            doesn't fit the (fixed, table-layout:fixed) Player column --
            explicit user request, reusing the exact same
            MarqueeText/useMarqueeDistances schedule.tsx's own
            event/description text already uses (extracted to
            marquee.tsx once a second overlay needed it). Left
            completely static, no animation at all, whenever the name
            already fits -- same as every other marquee in this app. */}
        <MarqueeText
          boxRef={nameBoxRef}
          contentRef={nameContentRef}
          distance={nameDistance}
          duration={nameDuration}
          style={{
            // Only "eliminated" shifts color (dims to COLORS.muted);
            // advancing renders as plain full-brightness text, same as
            // gauntlet-pools.tsx.
            color: status === "eliminated" ? COLORS.muted : COLORS.text,
          }}
        >
          {row.player}
        </MarqueeText>
      </td>
      {row.songs.map((s, j) => (
        <td key={j} style={tdStyle}>
          {formatSongScore(s, scoreFormat) || "--"}
        </td>
      ))}
      {/* row.total is the sheet's own Total column cell, read as raw
          text (see PoolPlayerRow's own doc) -- run through
          formatSongScore too (same as each song cell above) so it
          respects the operator's chosen ScoreFormat instead of always
          showing whatever percentage shape the Sheet itself happens to
          format that cell as. */}
      <td style={{ ...tdStyle, fontWeight: 700 }}>
        {formatSongScore(row.total, scoreFormat) || "--"}
      </td>
      {/* Red only for a genuine, nonzero gap -- "--" (no score yet /
          first place) and a diff that rounds to exactly zero (e.g.
          "-0" in the whole-number ScoreFormat, or "-0.0000%") read the
          same "nothing meaningfully behind" way, so both get the same
          plain white as the rest of the row instead of a red that
          implies a real deficit. parseFloat, not a string-equality
          check against "-0"/"-0.0000%" -- handles every ScoreFormat's
          own zero-shape at once (it stops at the first non-numeric
          char, so the trailing "%" in maimaidx's shape is a no-op),
          and -0 === 0 is true in JS. */}
      <td
        style={{
          ...tdStyle,
          borderRight: "none",
          color: !diffText || parseFloat(diffText) === 0 ? COLORS.text : COLORS.red,
          fontWeight: 600,
        }}
      >
        {diffText || "--"}
      </td>
    </tr>
  );
}

// Same "constant-ish scroll speed, proportional cycle length" reasoning
// as schedule.tsx's own MARQUEE_SPEED_PX_PER_S/MARQUEE_BASE_DURATION_S
// -- separate constants (not reused directly) since this overlay's own
// font size/column width call for their own tuning, not schedule.tsx's.
// Plain HTML/CSS px here (unlike bracket-tree.tsx's own SVG-local-unit
// version), since this whole overlay has no extra SVG scale factor in
// play.
const POOL_MARQUEE_SPEED_PX_PER_S = 60;
const POOL_MARQUEE_BASE_DURATION_S = 2.5;

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
