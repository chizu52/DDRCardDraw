import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout, Tag } from "@blueprintjs/core";
import {
  parsePoolsFromRows,
  topScoreRanks,
  colIndexToLetter,
  ParsedPool,
  PoolPlayerRow,
} from "../sheets/parse-pools";
import {
  fetchPublicSheetValues,
  fetchPublicColumnBColors,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { CellColor, colorToCss } from "../sheets/sheets-export";
import { useAppState } from "../state/store";
import { GauntletPoolMappingEdge } from "../state/event.slice";
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

// Winners/Losers side identity, reusing colors this file already gives
// meaning to elsewhere (mint = advancing, coral = eliminated/OUT)
// rather than introducing unrelated new hues -- a translucent tint of
// each, not the full-strength color, so a pool box's own border reads
// as "which side this is" at a glance without competing with the
// solid-gold destination boxes (still the strongest accent on the
// page) or the mint/coral/muted text colors inside each box.
const WINNER_POOL_BORDER = "rgba(34, 197, 94, 0.45)";
const LOSER_POOL_BORDER = "rgba(240, 168, 104, 0.45)";

// Which pools are the loser's side of the gauntlet -- a "Pool L..."
// title (Pool L1, Pool L2, ...), same as the reference diagram. Every
// other pool matching parsePoolsFromRows' own /pool/i title match (see
// dashboard.tsx's MatchesImportPanel/Pool Results, which this mirrors
// exactly) is winner's side. Deliberately NOT a fixed list of exact
// titles/count anymore -- that silently dropped or blanked out any
// pool whose name or count didn't match the hardcoded 5 exactly,
// which is exactly the "wrong number of pools" bug this replaced.
// Locating pools this generically, off whatever's actually in the
// sheet, is the same principle Pool Results already uses. Exported so
// dashboard.tsx's GauntletPoolMappingEditor can classify fetched pool
// titles into its two dropdowns using this exact same rule.
export const LOSER_POOL_TITLE = /^pool\s*l/i;

/** Natural/numeric sort key from a pool title's own trailing number,
 * plus an optional trailing letter for a lettered sub-set (e.g.
 * "Pool 2" -> 200, "Pool L10" -> 1000, "Pool 1A" -> 101, "Pool L2B" ->
 * 202) -- used to order each row's pools by their own numbering rather
 * than by raw sheet scan order (see winnerPools/loserPools below for
 * why that was a real bug). The letter is a SECONDARY sort key nested
 * under the number (multiplying the number by 100 leaves room for
 * A-Z's offset of 1-26 without colliding with the next number), so
 * "Pool 1A"/"Pool 1B" both sort right after "Pool 1" and before
 * "Pool 2" -- an unlettered pool (offset 0) sorts before its own
 * lettered variants, same relative order as the numbers themselves. A
 * title with no trailing number at all sorts after every numbered one
 * (Number.MAX_SAFE_INTEGER), keeping its relative scan-order position
 * among other unnumbered titles rather than colliding with them all at
 * some other arbitrary shared rank -- Array.prototype.sort is a stable
 * sort (guaranteed since ES2019), so ties preserve original order. */
function poolSortKey(title: string): number {
  const match = title.match(/(\d+)\s*([A-Za-z]?)\s*$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const num = parseInt(match[1], 10);
  const letterOffset = match[2]
    ? match[2].toUpperCase().charCodeAt(0) - "A".charCodeAt(0) + 1
    : 0;
  return num * 100 + letterOffset;
}

/** Just the trailing letter of a lettered sub-set (e.g. "Pool 2B" ->
 * "B", "Pool 3" -> "") -- used to group pools into one row per letter,
 * so every "A" pool across every numbered set sits together on one
 * row, every "B" pool sits together on the next, and so on. */
function poolLetter(title: string): string {
  const match = title.match(/(\d+)\s*([A-Za-z]?)\s*$/);
  return match && match[2] ? match[2].toUpperCase() : "";
}

/** Just the trailing number (e.g. "Pool 2B" -> 2) -- this pool's column
 * position. Shared across every letter-row AND across the winner/loser
 * sides (see winnerGroups/loserGroups/allNumbers below), so the same
 * set number lines up in the same column everywhere, not just within
 * one row. A title with no trailing number at all sorts into its own
 * trailing column, after every numbered one -- same fallback
 * (Number.MAX_SAFE_INTEGER) and reasoning as poolSortKey above. */
function poolNumber(title: string): number {
  const match = title.match(/(\d+)\s*[A-Za-z]?\s*$/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Groups pools into one row per distinct letter (see poolLetter), each
 * row's own pools sorted by number. Unlettered pools (the ordinary
 * "Pool 1/2/3..." case, no A/B sub-sets) all share the single ""
 * group, so a sheet with no lettered sub-sets renders exactly one row
 * per side -- same as before this existed, not a special case. Groups
 * are ordered "" first (if present), then A, B, C... alphabetically
 * (String.localeCompare already puts "" before any letter). */
function groupByLetter(
  pools: ParsedPool[],
): { letter: string; pools: ParsedPool[] }[] {
  const groups = new Map<string, ParsedPool[]>();
  for (const pool of pools) {
    const letter = poolLetter(pool.title);
    const group = groups.get(letter);
    if (group) group.push(pool);
    else groups.set(letter, [pool]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, groupPools]) => ({
      letter,
      pools: [...groupPools].sort(
        (a, b) => poolNumber(a.title) - poolNumber(b.title),
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
      /** Column B's own cell background colors, one per raw sheet row --
       * a separate fetch/array from `colors` above (which is the Final
       * Ranking column's colors, used for advancement). This one is
       * purely cosmetic: whatever color an operator has set on a pool's
       * own title cell, mirrored onto that pool's header bar, same as
       * pool-results.tsx already does. */
      headerColors: (CellColor | null)[];
    };

// Stable references for the "not loaded yet" case -- a fresh `[]`
// literal inline at each render would be a new array reference every
// time, which matters here specifically because the measurement effect
// below keys on `state` (not on winnerPools/loserPools themselves, see
// its own comment) partly to avoid exactly that kind of spurious-
// reference churn.
const EMPTY_POOLS: ParsedPool[] = [];
const EMPTY_COLORS: (CellColor | null)[] = [];
const EMPTY_HEADER_COLORS: (CellColor | null)[] = [];

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
  // Operator-entered Bottom-N routing -- see event.slice.ts's
  // GauntletPoolMappingEdge. Color (see classifyRankingColor below) can
  // tell us how many players drop out of a pool, never which specific
  // loser pool receives them -- that's nowhere in the sheet, so it's a
  // manual, room-synced setting instead.
  const mapping = useAppState((s) => s.event.gauntletPoolMapping);

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!apiKey || !spreadsheetId) return;
    let cancelled = false;

    async function load() {
      try {
        // Column B's identity is static (unlike the Final Ranking
        // column below, whose letter isn't known until after parsing),
        // so its color fetch can run right alongside the values fetch
        // -- same Promise.all pattern pool-results.tsx already uses for
        // its own header-color read. A failure here degrades
        // gracefully (no header tint, not a broken overlay) same as
        // every other color fetch in this file.
        const [rows, headerColors] = await Promise.all([
          fetchPublicSheetValues(apiKey!, spreadsheetId!, sheetName),
          fetchPublicColumnBColors(
            apiKey!,
            spreadsheetId!,
            `${sheetName}!B:B`,
          ).catch(() => [] as (CellColor | null)[]),
        ]);
        if (cancelled) return;
        const { pools } = parsePoolsFromRows(rows);
        // The Final Ranking column's letter isn't known until after
        // parsing (found by header text, like every other column here),
        // so this fetch can't start alongside the values fetch the way
        // pool-results.tsx's fixed-column-B color fetch does -- it
        // depends on the parse result. Same column for every pool in
        // the sheet (parsePoolsFromRows' own assumption -- see
        // findHeaderColumns), so the first pool that has one stands in
        // for the whole sheet. A sheet with no Final Ranking column at
        // all (finalRankingCol always null) just skips the fetch
        // entirely -- advancement then falls back to "unknown" for
        // every row (see classifyRankingColor's callers), not a crash.
        const finalRankingCol = pools.find(
          (p) => p.finalRankingCol !== null,
        )?.finalRankingCol;
        const colors =
          finalRankingCol != null
            ? await fetchPublicColumnBColors(
                apiKey!,
                spreadsheetId!,
                `${sheetName}!${colIndexToLetter(finalRankingCol)}:${colIndexToLetter(finalRankingCol)}`,
              ).catch(() => [] as (CellColor | null)[])
            : [];
        if (cancelled) return;
        setState({ status: "ok", pools, colors, headerColors });
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

  const pools = state.status === "ok" ? state.pools : EMPTY_POOLS;
  const colors = state.status === "ok" ? state.colors : EMPTY_COLORS;
  const headerColors =
    state.status === "ok" ? state.headerColors : EMPTY_HEADER_COLORS;
  // Same discovery as Pool Results: take every pool parsePoolsFromRows
  // actually found, no assumed count or exact-name list. Split into two
  // rows by the "Pool L..." naming convention, then sorted numerically
  // within each row (poolSortKey) -- confirmed as a real bug: raw sheet
  // scan order isn't guaranteed to match each pool's own numbering
  // (rows can be added/reordered independently of their title's
  // number), which is exactly what could make an unrelated pool
  // visually "line up" under the wrong column purely by coincidence of
  // scan order.
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

  // Prefer routing the sheet itself already encodes (see
  // deriveRoutingEdges) over the operator-entered fallback -- the
  // manual mapping only fills in whatever the sheet doesn't already
  // say, rather than being the only source of truth. Drops any
  // operator-entered edge whose pool title isn't in the currently-
  // loaded sheet (renamed/removed pool, or a stale leftover editor
  // row) -- same "no data, no arrow, no guessing" principle the old
  // index-paired loop had, just checked by title now instead of array
  // bounds. Sheet-derived edges need no such filtering -- they're only
  // ever built from titles that are already in winnerPools/loserPools.
  const resolvedEdges = mergeMappingEdges(
    deriveRoutingEdges(winnerPools, loserPools, colors),
    resolveMappingEdges(mapping, winnerPools, loserPools),
  );

  // One row per distinct letter (see groupByLetter) instead of one row
  // per side -- a sheet using "Pool 1A"/"Pool 1B"-style lettered
  // sub-sets previously packed every pool into a single wide row
  // regardless of letter, which read as one undifferentiated block
  // rather than the two (or more) parallel sets it actually is. A
  // sheet with no lettered sub-sets (plain "Pool 1/2/3...") still
  // produces exactly one group per side, so this is a no-op for that
  // shape -- same single-row layout as before.
  const winnerGroups = groupByLetter(winnerPools);
  const loserGroups = groupByLetter(loserPools);
  // The destination box only ever reflects the LAST round on each side
  // (see finalPools) -- not a running flatten of every pool that has
  // ever fed players forward.
  const winnerFinalAdvancing = aggregateAdvancing(
    finalPools(winnerPools),
    colors,
  );
  const loserFinalAdvancing = aggregateAdvancing(
    finalPools(loserPools),
    colors,
  );
  // Feeds bracketPlayTotal below -- template-driven and known as soon
  // as the sheet is (advancingCount, same as PoolBox's own arrow), NOT
  // gated on the final pool actually finishing the way
  // winnerFinalAdvancing/loserFinalAdvancing (the ACTUAL NAMES shown in
  // each destination box's body) still are.
  const winnerFinalCount = totalAdvancingCount(finalPools(winnerPools), colors);
  const loserFinalCount = totalAdvancingCount(finalPools(loserPools), colors);
  // The combined "Top N" both destination boxes title themselves with
  // -- e.g. 2 winner's-side + 2 loser's-side seats both read "Top 4,"
  // since together they ARE the Top 4 field moving into Bracket Play,
  // not two separate totals. Requires BOTH sides' final-pool counts to
  // be known, not just one: a partial sum would understate the real
  // total rather than say "not known yet," which is worse than just
  // waiting for both.
  const bracketPlayTotal =
    winnerFinalCount != null && loserFinalCount != null
      ? winnerFinalCount + loserFinalCount
      : null;
  // Column position is keyed by set NUMBER alone, shared across every
  // letter-row on BOTH sides -- so "Pool 2A" (winners) and "Pool L2A"
  // (losers) sit in the same column even though they're on different
  // rows, and a row missing a particular number (e.g. no "Pool L1B")
  // just leaves that column blank on its own row rather than
  // compressing everything else leftward.
  const allNumbers = [...new Set(pools.map((p) => poolNumber(p.title)))].sort(
    (a, b) => a - b,
  );
  const columnIndexForNumber = new Map(allNumbers.map((n, i) => [n, i]));
  const columnFor = (pool: ParsedPool) =>
    1 + columnIndexForNumber.get(poolNumber(pool.title))! * 2;
  const destCol = 1 + allNumbers.length * 2;
  const losersLabelRow = 2 + winnerGroups.length;
  const loserFirstRow = losersLabelRow + 1;
  const totalRows = losersLabelRow + loserGroups.length;

  return (
    <div style={cardStyle}>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      <div style={gridStyle(allNumbers.length, totalRows)}>
        {/* Explicit Winners/Losers section labels -- same idea as
            start.gg's own bracket page, and this app's own
            bracket-tree.tsx overlay, which already renders a label
            above each side's own <svg> for the exact same reason: rows
            of pools with no heading reads as one ambiguous block to
            anyone who doesn't already know which side is which. */}
        <div
          style={{
            ...sectionLabelStyle,
            color: COLORS.mint,
            gridColumn: "1 / -1",
            gridRow: 1,
          }}
        >
          Winners
        </div>
        {winnerGroups.flatMap((group, gi) =>
          group.pools.map((pool) => (
            <PoolBox
              key={pool.title}
              title={pool.title}
              pool={pool}
              col={columnFor(pool)}
              row={2 + gi}
              colors={colors}
              headerColors={headerColors}
              resolvedEdges={resolvedEdges}
              winnerPools={winnerPools}
            />
          )),
        )}
        {winnerGroups.flatMap((group, gi) =>
          group.pools.map((pool) => (
            <ArrowCell
              key={`arrow-${pool.title}`}
              col={columnFor(pool) + 1}
              row={2 + gi}
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
            row={`2 / span ${winnerGroups.length}`}
            advancing={winnerFinalAdvancing}
          />
        )}

        <div
          style={{
            ...sectionLabelStyle,
            color: COLORS.coral,
            gridColumn: "1 / -1",
            gridRow: losersLabelRow,
          }}
        >
          Losers
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
              resolvedEdges={resolvedEdges}
              winnerPools={winnerPools}
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
  );
}

/** Classifies a Final Ranking cell's background color as "advancing"
 * (green) or "eliminated" (red) by HUE, not raw channel dominance --
 * confirmed as a real bug this session: a channel-dominance check (is
 * green clearly bigger than red and blue by some margin) fails on
 * Google Sheets' own default PASTEL green/red fill presets (e.g. their
 * "light green 3" swatch, ~rgb(217,234,211) -- green is barely bigger
 * than red there, nowhere near a fixed dominance margin), since a pale
 * and a saturated shade of the same color share roughly the same hue
 * but very different channel gaps. Hue is robust to exactly that kind
 * of lightness/saturation variation, so this reads correctly whether
 * the sheet uses a bold or a pastel swatch. Near-gray/white/unset
 * cells (very low saturation -- every channel close together) are
 * excluded up front so a faint zebra-stripe tint or a blank cell never
 * misclassifies. */
function classifyRankingColor(
  c: CellColor | null | undefined,
): "advancing" | "eliminated" | null {
  if (!c) return null;
  const { r, g, b } = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 0.06) return null; // too gray/pale/white to have a real hue
  let hue: number;
  if (max === r) hue = (((g - b) / delta) % 6 + 6) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue >= 70 && hue <= 170) return "advancing"; // green range
  if (hue <= 20 || hue >= 340) return "eliminated"; // red range, wraps past 360
  return null;
}

/** Winner/loser status for a finished pool, keyed by player NAME rather
 * than row position -- confirmed against real sheet data that Final
 * Ranking is a rank-summary list (row 1's cell names whoever placed 1st
 * by score in this pool, row 2's names 2nd, and so on), not "this row's
 * own result." A pool's rows stay in their original seed/entry order
 * rather than being re-sorted by score, so a row's Final Ranking TEXT
 * very often names a completely different player than whoever's
 * printed in that same row's own player-name column -- real example:
 * row 1 is "DaUTF" (own score is 2nd-highest in the pool), but row 1's
 * Final Ranking cell reads "Tibby," the pool's actual highest scorer.
 * The COLOR (bright green = a winning rank, bright red = a losing rank)
 * lives on that same cell and still means exactly what it always
 * meant -- but it describes the RANK SLOT that row represents, not
 * whichever player happens to share that row, so the player it
 * actually applies to is whoever's name is written there as text.
 * Confirmed live against the real sheet: coloring by row position
 * instead of by this text was attributing wins/losses to the wrong
 * players entirely (a pool's actual top scorer showing eliminated,
 * its actual bottom scorer showing advancing) once rows weren't
 * already in score order. */
function finalRankingStatusByName(
  pool: ParsedPool,
  colors: (CellColor | null)[],
): Map<string, "advancing" | "eliminated"> {
  const byName = new Map<string, "advancing" | "eliminated">();
  for (const row of pool.rows) {
    const status = classifyRankingColor(colors[row.rowIndex]);
    // Case-insensitive key -- confirmed against real data that the
    // same player's name isn't always typed with matching
    // capitalization in both places (real example: roster column has
    // "jabronski," that same pool's Final Ranking column names them
    // "Jabronski"). Same normalization deriveRoutingEdges already uses
    // for its own pool-title matching, for the same reason.
    const name = row.finalRanking.trim().toLowerCase();
    if (status && name) byName.set(name, status);
  }
  return byName;
}

/** Pairs each of a pool's ROSTER rows with its Final Ranking status, via
 * the name-keyed lookup above (finalRankingStatusByName) -- NOT via
 * that row's own Final Ranking cell color directly, since that cell
 * can (and often does, see finalRankingStatusByName's own comment)
 * belong to a different player than whoever occupies the row. */
function classifiedRows(pool: ParsedPool, colors: (CellColor | null)[]) {
  const statusByName = finalRankingStatusByName(pool, colors);
  return pool.rows.map((row, idx) => ({
    row,
    idx,
    status: statusByName.get(row.player.trim().toLowerCase()) ?? null,
  }));
}

/** Names of every player marked "advancing" by Final Ranking's own
 * color, ordered by score (topScoreRanks) -- color decides WHO'S
 * included (the real per-pool count varies: 1, 2, or 3 players, not a
 * fixed cutoff), score only decides the DISPLAY ORDER among them. Gated
 * on the pool's own "Finished" checkbox -- unlike advancingCount below,
 * this NAMES specific people, and a Final Ranking cell can be (and on
 * real unstarted sheets, is) pre-colored by template before any match
 * is played or before that rank slot has a name in it at all -- see
 * advancingCount's own comment. Attributing an actual person to a
 * winning slot before the pool is genuinely done would be a guess, not
 * a fact yet, even though how MANY slots are winning ones already is.
 * Explicit user instruction: highlighting specific players waits for
 * Final; the progression count does not. */
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
 * own TEMPLATE coloring (which Final Ranking row-SLOTS are marked
 * green), not of any specific player. Confirmed against a real,
 * completely unstarted sheet (every score 0%, zero names anywhere in
 * Final Ranking) that these cells are already colored ahead of time --
 * the sheet already knows "this pool sends 2 forward" the moment it's
 * set up; it just doesn't know WHICH 2 people yet. So this deliberately
 * counts by RAW ROW POSITION (`pool.headerRowIndex + 1` through `+
 * POOL_SLOT_COUNT`), not `pool.rows` or classifiedRows/
 * finalRankingStatusByName -- those need an actual name in the cell to
 * attribute a result to anyone, which a not-yet-fully-seeded pool may
 * not have for every slot yet (a pool missing some of its roster still
 * has all 4 of its Final Ranking cells pre-templated). Not gated on
 * pool.finished either, same reasoning. Returns null -- not 0 -- only
 * when nothing is colored at all, so the UI can fall back to "TBD"
 * rather than claim a real answer it doesn't have (e.g. no Final
 * Ranking column on this sheet, or a pool whose template genuinely
 * hasn't been colored in yet). */
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
 * one pool per side, but a lettered final round -- e.g. "Pool 7A" and
 * "Pool 7B" both sharing the highest set number -- can legitimately be
 * more than one). Ignores any pool whose own count isn't known yet
 * rather than letting one undetermined pool blank out the whole sum;
 * only returns null if NONE of them are known. Used for both a
 * destination box's own title (see its "Total Value" rename) and the
 * combined Bracket Play total below -- same finished-independent,
 * template-driven count as advancingCount itself, never gated on
 * pool.finished or on a name being present. */
function totalAdvancingCount(
  pools: ParsedPool[],
  colors: (CellColor | null)[],
): number | null {
  const counts = pools
    .map((p) => advancingCount(p, colors))
    .filter((c): c is number => c != null);
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
}

/** Combines a set of pools' own advancingNames(...), in the order given
 * -- used for the destination box, which shows every CONTRIBUTING
 * pool's advancing players (see finalPools below for which pools that
 * actually is). A pool contributes as soon as IT finishes, without
 * waiting on any other pool passed in alongside it -- once a pool is
 * finished its own result is final, and every PoolBox already shows
 * live/final pools side-by-side, so waiting on the slowest pool here
 * would look inconsistent with the boxes right next to it. */
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
 * poolNumber, which strips the letter). This is deliberately NOT every
 * pool on the side: the destination box represents that final round's
 * own actual result (who really finishes 1st-Nth overall), not a
 * running tally of every pool that has ever fed players forward. Used
 * to be "every pool on the side" (aggregateAdvancing flattened all of
 * winnerPools/loserPools), which produced e.g. 14 names out of 7 winner
 * pools into a box literally labeled "Top 4" -- confirmed wrong against
 * real tournament data once a side has more than one round of pools.
 * Also doubles as the source of "how many advance" for the box's own
 * title (see its call sites) -- an event's Top N varies (Top 4, Top 6,
 * Top 8...), and this reads that count straight from however many
 * players the LAST pool's own Final Ranking colors mark advancing,
 * rather than needing a separate spreadsheet convention or a ddrtools
 * settings dropdown to say "N" up front. */
function finalPools(pools: ParsedPool[]): ParsedPool[] {
  if (pools.length === 0) return [];
  const maxNumber = Math.max(...pools.map((p) => poolNumber(p.title)));
  return pools.filter((p) => poolNumber(p.title) === maxNumber);
}

/** Drops any mapping edge referencing a pool title not currently in the
 * loaded sheet -- same "no data, no arrow, no guessing" principle the
 * old index-paired connector loop had, just checked against titles now
 * instead of array bounds. Also naturally handles an in-progress,
 * not-yet-fully-filled-in editor row (an empty "" title can never match
 * a real pool title). */
function resolveMappingEdges(
  mapping: GauntletPoolMappingEdge[],
  winnerPools: ParsedPool[],
  loserPools: ParsedPool[],
): GauntletPoolMappingEdge[] {
  const winnerTitles = new Set(winnerPools.map((p) => p.title));
  const loserTitles = new Set(loserPools.map((p) => p.title));
  return mapping.filter(
    (e) => winnerTitles.has(e.winnerPool) && loserTitles.has(e.loserPool),
  );
}

/** Derives Bottom-N routing straight from the sheet: for an eliminated
 * player, Final Ranking's own cell text is sometimes the destination
 * pool's title (e.g. "Pool L2") instead of a placement -- the sheet
 * reuses the same column for both, depending on whether that player
 * advances. Matched structurally (does the text equal a real,
 * currently-loaded pool title, case/whitespace-insensitively?), not by
 * a separate format marker, since ordinal placement text ("4th") and a
 * pool title don't collide. Deliberately NOT capped at one edge per
 * winner pool -- different droppers from the same pool could
 * legitimately name different destinations (fan-out), same as multiple
 * winner pools naming the same destination is already expected
 * (fan-in, see this file's own history on why that matters). A pool
 * with no eliminated player whose text matches a real title (older
 * sheet without this formula, or one that hasn't resolved yet)
 * contributes no edges here -- resolved purely from the operator's
 * manual mapping instead, via mergeMappingEdges below. */
function deriveRoutingEdges(
  winnerPools: ParsedPool[],
  loserPools: ParsedPool[],
  colors: (CellColor | null)[],
): GauntletPoolMappingEdge[] {
  const loserTitleByKey = new Map(
    loserPools.map((p) => [p.title.trim().toLowerCase(), p.title]),
  );
  const seen = new Set<string>();
  const edges: GauntletPoolMappingEdge[] = [];
  for (const pool of winnerPools) {
    for (const { row, status } of classifiedRows(pool, colors)) {
      if (status !== "eliminated") continue;
      const target = loserTitleByKey.get(row.finalRanking.trim().toLowerCase());
      if (!target) continue;
      const key = `${pool.title}=>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ winnerPool: pool.title, loserPool: target });
    }
  }
  return edges;
}

/** Unions two edge lists, de-duplicating identical (winnerPool,
 * loserPool) pairs so an edge present in both the sheet-derived and the
 * manually-entered lists doesn't draw as two overlapping connectors. */
function mergeMappingEdges(
  ...edgeLists: GauntletPoolMappingEdge[][]
): GauntletPoolMappingEdge[] {
  const seen = new Set<string>();
  const merged: GauntletPoolMappingEdge[] = [];
  for (const edge of edgeLists.flat()) {
    const key = `${edge.winnerPool}=>${edge.loserPool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged;
}

// Every pool always has up to this many player slots -- mirrors
// parse-pools.ts's own `slotIndex < 4` cap (parsePoolsFromRows)
// exactly. Duplicated as a literal here rather than exported from
// parse-pools.ts, since nothing about that shared parser changes for
// this -- see poolSlotDisplays' own comment on why the padding stays
// entirely local to this file.
const POOL_SLOT_COUNT = 4;

/** One rendered slot in a PoolBox: either a real, already-in-the-sheet
 * player (`row` is exactly a ParsedPool.rows entry, untouched) or a
 * display-only placeholder standing in for a slot the sheet hasn't
 * filled in yet. */
type PoolSlotDisplay =
  | { kind: "real"; row: PoolPlayerRow }
  | { kind: "placeholder"; label: string };

/** Pads a pool's real rows up to POOL_SLOT_COUNT with placeholder
 * entries, purely for PoolBox's own rendering -- never mutates
 * `pool.rows` and never returns anything that flows back into a
 * ParsedPool. Deliberately kept local to this file rather than a
 * change to parse-pools.ts's parsePoolsFromRows/ParsedPool/
 * PoolPlayerRow: dashboard.tsx's mergePendingIntoPool merges CV-read
 * scores into pool.rows purely by array position ("1st Pending row ->
 * pool's 1st row," per its own doc comment), and both dashboard.tsx
 * and pool-results.tsx consume parsePoolsFromRows'/ParsedPool's exact
 * current shape directly -- neither needs or expects this padding, so
 * it stays a pure, render-only transform instead of touching the
 * shared parser. */
function poolSlotDisplays(
  pool: ParsedPool,
  resolvedEdges: GauntletPoolMappingEdge[],
  winnerPools: ParsedPool[],
): PoolSlotDisplay[] {
  const real: PoolSlotDisplay[] = pool.rows.map((row) => ({
    kind: "real",
    row,
  }));
  const missing = POOL_SLOT_COUNT - real.length;
  if (missing <= 0) return real; // parsePoolsFromRows' own slotIndex<4 cap guarantees this; defensive only
  const label =
    unfinishedFeederLabel(pool.title, resolvedEdges, winnerPools) ?? "TBD";
  const placeholders: PoolSlotDisplay[] = Array.from(
    { length: missing },
    () => ({ kind: "placeholder", label }),
  );
  return [...real, ...placeholders];
}

/** "Awaiting {pool}" when exactly one winner pool has a resolvedEdges
 * entry routing into `loserPoolTitle` AND that specific winner pool
 * hasn't finished yet -- the one case where attribution is
 * unambiguous. Returns null (caller falls back to generic "TBD")
 * otherwise:
 *  - zero such edges: nothing has resolved a route into this pool yet,
 *    or every pool that DOES route here has already finished (nothing
 *    left to actually wait on, so naming an already-done pool would be
 *    misleading rather than helpful);
 *  - more than one distinct unfinished feeder: a genuine fan-in of two
 *    or more still-in-progress pools, where naming just one would
 *    misattribute which pool a given empty slot is actually waiting
 *    on.
 * Safe by construction, not by a special case here: deriveRoutingEdges
 * only ever builds edges `for (const pool of winnerPools)`, and
 * resolveMappingEdges filters operator-entered edges against the same
 * winnerPools-derived title set -- so resolvedEdges can never contain
 * an edge whose winnerPool is actually a loser pool's own title. A
 * winner pool's own placeholder search (called from poolSlotDisplays
 * for ANY pool, winner or loser) therefore always finds zero matches
 * here and correctly falls straight to "TBD". */
function unfinishedFeederLabel(
  loserPoolTitle: string,
  resolvedEdges: GauntletPoolMappingEdge[],
  winnerPools: ParsedPool[],
): string | null {
  const finishedByTitle = new Map(
    winnerPools.map((p) => [p.title, p.finished]),
  );
  const unfinishedFeeders = new Set(
    resolvedEdges
      .filter((e) => e.loserPool === loserPoolTitle)
      .map((e) => e.winnerPool)
      .filter((title) => finishedByTitle.get(title) === false),
  );
  if (unfinishedFeeders.size !== 1) return null;
  const [only] = unfinishedFeeders;
  return `Awaiting ${only}`;
}

function PoolBox({
  title,
  pool,
  col,
  row,
  colors,
  headerColors,
  resolvedEdges,
  winnerPools,
}: {
  title: string;
  pool: ParsedPool | undefined;
  col: number;
  row: number;
  colors: (CellColor | null)[];
  /** Column B's own cell colors (see GauntletPoolsOverlay's
   * `headerColors`), aligned to this specific pool via its
   * headerRowIndex, same mechanism pool-results.tsx already uses. */
  headerColors: (CellColor | null)[];
  /** Needed to compute a placeholder's "Awaiting {pool}" attribution --
   * see poolSlotDisplays/unfinishedFeederLabel. */
  resolvedEdges: GauntletPoolMappingEdge[];
  winnerPools: ParsedPool[];
}) {
  // colorToCss(null) would return "#f5f5f5" (near-white) -- right for
  // pool-results.tsx's light card, wrong for this file's dark
  // COLORS.panel card. "No sheet color set" is handled explicitly (no
  // backgroundColor at all, falling through to boxHeaderStyle's own
  // current appearance) rather than ever calling colorToCss(null).
  const headerColor = pool ? (headerColors[pool.headerRowIndex] ?? null) : null;
  // Side-tinted border (see WINNER_POOL_BORDER/LOSER_POOL_BORDER) --
  // the one piece of styling that differentiates a Winners pool box
  // from a Losers one beyond the section label above them, since a
  // viewer scanning a specific box in isolation (e.g. a close OBS crop)
  // won't always have that label in frame.
  const sideBorder = LOSER_POOL_TITLE.test(title)
    ? LOSER_POOL_BORDER
    : WINNER_POOL_BORDER;
  return (
    <div
      style={{ ...boxStyle, border: `1px solid ${sideBorder}`, gridColumn: col, gridRow: row }}
    >
      <div
        style={{
          ...poolHeaderBarStyle,
          backgroundColor: headerColor ? colorToCss(headerColor) : undefined,
        }}
      >
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
        <div style={poolRowListStyle}>
          {(() => {
            // Computed once per pool, not per row -- see
            // finalRankingStatusByName's own comment for why this has
            // to be a name lookup rather than each row reading its own
            // Final Ranking cell directly.
            const statusByName = finalRankingStatusByName(pool, colors);
            return poolSlotDisplays(pool, resolvedEdges, winnerPools).map(
            (slot, idx) => {
              if (slot.kind === "placeholder") {
                // Same convention as bracket-tree.tsx's own
                // describeEmptySlot rendering for a not-yet-determined
                // start.gg bracket slot: the placeholder text sits
                // inline where a real name would go, muted + italic --
                // not a separate note block.
                return (
                  <div
                    key={idx}
                    style={{ ...poolRowStyle, ...placeholderRowStyle }}
                  >
                    <span style={poolPlayerNameStyle}>{slot.label}</span>
                    {/* Empty second cell, purely so this row's gridline
                        (borderBottom, on both cell styles) runs the full
                        row width like every real row's does -- without
                        it, a placeholder row's divider stopped short at
                        the label's own width instead of reaching the
                        score column, breaking the "spreadsheet" look. */}
                    <span style={playerTotalStyle} />
                  </div>
                );
              }
              const r = slot.row;
              // Advancing is read from Final Ranking's own color, keyed
              // by THIS row's own player NAME (statusByName) rather
              // than this row's own cell position -- see
              // finalRankingStatusByName's comment for why: the real
              // count who advance out of a pool varies (1, 2, or 3
              // players, not always 2), and which specific player that
              // is isn't necessarily whoever the Final Ranking column
              // happens to sit beside. Gated on pool.finished, unlike
              // the pool's own progression count (advancingCount, see
              // its comment) -- explicit user instruction: a pool's
              // Final Ranking cells can be pre-colored by template
              // before any name is even in them, which tells you HOW
              // MANY slots are winning ones but says nothing about
              // WHICH player ends up in one, so naming/highlighting a
              // specific person waits for the pool to actually be
              // done. Kept in sync with the row's own destination box
              // (aggregateAdvancing/advancingNames, same Finished gate)
              // so this box and that one always agree on who's
              // advancing. Uniform between Winner's and Loser's-side
              // pools -- not advancing renders the same muted way
              // regardless of which side eliminates a player.
              const status = pool.finished
                ? (statusByName.get(r.player.trim().toLowerCase()) ?? null)
                : null;
              return (
                <div
                  key={idx}
                  style={{
                    ...poolRowStyle,
                    color:
                      status === "advancing"
                        ? COLORS.mint
                        : status === "eliminated"
                          ? COLORS.muted
                          : COLORS.text,
                  }}
                >
                  <span style={poolPlayerNameStyle}>{r.player}</span>
                  <span style={playerTotalStyle}>{r.total || "--"}</span>
                </div>
              );
            },
            );
          })()}
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
  /** A plain row number (single-group case), or a CSS grid "start /
   * span N" string -- one shared destination box per side now spans
   * every one of that side's letter-rows (see groupByLetter), rather
   * than repeating once per row, so it stays vertically centered
   * against however many rows that side actually has. */
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
  /** How many players progress out of this pool -- always derived
   * straight from Final Ranking's own colors (advancingNames), never a
   * guessed default. null means not known yet (pool still live, or the
   * players it names aren't in this pool's own roster): the real count
   * genuinely varies pool to pool (1, 2, or 3 players, not always 2),
   * so guessing a fixed number before the pool actually finishes would
   * just be wrong as often as it's right -- same "don't show a
   * premature result" rule advancingNames itself already follows for
   * the destination boxes. */
  count: number | null;
}) {
  return (
    <div
      style={{
        gridColumn: col,
        gridRow: row,
        display: "flex",
        flexDirection: "row",
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
      <span>{count != null ? `Top ${count}` : "TBD"}</span>
      <span style={{ fontSize: "1.3em" }}>→</span>
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
  // Confirmed as the real cause of a genuine bug: text (long player
  // names, e.g. real sheet data like "Sambruh12345678") visibly running
  // outside a pool box's own outline. `display:inline-block` alone
  // sizes via "shrink-to-fit," which is capped at the AVAILABLE width
  // of this card's own containing block (effectively the OBS browser
  // source's viewport) even when its true content needs more --
  // confirmed live: with many pools, this card's natural content needs
  // ~1900px+, but shrink-to-fit was clamping it to ~748px (the
  // viewport), which left every gridStyle pool-column with nowhere
  // near enough room and forced them all down to their 180px floor
  // regardless of `minmax(180px, max-content)`'s max side -- the
  // overflowing text was real content that the grid had nowhere left
  // to put. `width: "max-content"` overrides that clamp: this card (and
  // the grid inside it) now always renders at its true natural width,
  // scrolling horizontally in OBS/a browser if that's wider than the
  // visible canvas, rather than silently compressing every pool column
  // and spilling text past its own border.
  width: "max-content",
  color: COLORS.text,
};

// `numColumns` is however many distinct set numbers exist across BOTH
// sides (see allNumbers) -- (pool, arrow) repeated `numColumns` times,
// plus one trailing destination column shared by every row. `numRows`
// is a label row plus one row per letter-group on each side (see
// winnerGroups/loserGroups/losersLabelRow/totalRows) -- no more fixed
// connector-band row now that the Bottom-N arrows are gone.
//
// Each pool-column track is `minmax(240px, max-content)`, not a flat
// width -- confirmed as a real bug: a fixed width just clipped any name
// too long to fit. A CSS Grid track's max-content size is already
// computed from every cell sharing that column (every row's pool box
// alike), so this gets "every box in a pool column matches its own
// widest name" for free from the grid itself -- no per-box measurement
// code needed, just letting the name text (poolPlayerNameStyle) report
// its real natural width instead of truncating it (see that style's
// own comment). The 240px floor (previously 180px) is deliberately
// wide enough that a pool box reads as a clear rectangle rather than
// square even when every name is short -- explicit ask, since a short-
// named pool's box height (header + 4 rows) was landing close enough
// to its old 180px width to look nearly square. The arrow (56px) and
// destination (180px) columns stay fixed -- only pool columns are
// asked to grow.
function gridStyle(numColumns: number, numRows: number): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(${numColumns}, minmax(240px, max-content) 56px) 180px`,
    gridTemplateRows: `repeat(${numRows}, auto)`,
    columnGap: "4px",
    rowGap: "4px",
  };
}

// Same "Winners"/"Losers" section-labeling idea as start.gg's own
// bracket page (and this app's own bracket-tree.tsx overlay, which
// already renders a label above each side's own <svg> for the exact
// same reason). `color` is deliberately left out of this shared base --
// each call site overrides it (COLORS.mint for Winners, COLORS.coral
// for Losers, the same two side-identity tints PoolBox's own border
// uses) so the two sections read as visually distinct at a glance, not
// just by their text.
const sectionLabelStyle: React.CSSProperties = {
  fontFamily: TITLE_FONT_FAMILY,
  fontWeight: 700,
  fontSize: "1.3em",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

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

// PoolBox-only header bar for the optional per-pool color tint (see
// PoolBox's own headerColor). Derived from boxHeaderStyle by spread,
// never mutating it -- DestinationBox also spreads boxHeaderStyle
// directly and must stay visually untouched by this. Bleeds through
// boxStyle's own 10px/14px padding via a matching negative margin, with
// its own top-corner radius (matching boxStyle's own 14), so an actual
// tint reads as a real edge-to-edge bar flush with the card's rounded
// top corners. No borderBottom hairline is added, so the "no color set"
// case (backgroundColor: undefined) stays pixel-identical to before
// this existed.
const poolHeaderBarStyle: React.CSSProperties = {
  ...boxHeaderStyle,
  margin: "-10px -14px 0",
  padding: "8px 14px",
  borderRadius: "14px 14px 0 0",
};

const emptyNoteStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.8em",
  color: COLORS.muted,
  fontStyle: "italic",
};

// Same "not a real, in-sheet value" treatment as bracket-tree.tsx's own
// describeEmptySlot rendering for an undetermined start.gg bracket
// slot (muted + italic, inline in the name position) -- spread onto
// playerRowStyle rather than replacing it, so a placeholder row still
// lines up with real rows (same padding/font-size/gap).
const placeholderRowStyle: React.CSSProperties = {
  color: COLORS.muted,
  fontStyle: "italic",
};

// A real two-column grid (name | score), not a flex row with
// justify-content:space-between -- that flex version is what let a long
// nowrap name push a row wider than the PoolBox actually rendered at
// (the row and its parent box each intrinsic-size independently, and
// visibly disagreed once a name got long, painting text past the box's
// own rounded border instead of growing it). Every row in a box now
// shares the literal same two grid tracks, so the name column and the
// score column -- and the divider between them (playerTotalStyle's
// borderLeft) -- line up perfectly down the whole box, same as a real
// spreadsheet's column gridlines, and the box (sized by gridStyle's
// minmax(180px, max-content) track) can only ever be exactly as wide as
// the widest row actually needs. borderBottom gives each row its own
// horizontal gridline too, same idea, on every row including the last
// -- Google Sheets doesn't drop the final row's underline either.
const playerRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  alignItems: "center",
  columnGap: 8,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.9em",
  padding: "4px 0",
  borderBottom: `1px solid ${COLORS.border}`,
};

// PoolBox's own row list is ONE SHARED grid, not one independent grid
// per row (unlike playerRowStyle above, which DestinationBox still uses
// as-is -- it only ever shows a single name column, nothing to align
// against). Per-row independent grids were a real risk for "line up and
// connect perfectly": each row sized its own name/score columns off
// only ITS OWN content, so the divider could in principle land at a
// slightly different x-position row to row (DDR percentage scores
// happen to be nearly the same width in practice, which is why this
// wasn't visibly broken, but it was never actually GUARANTEED). Making
// every row's two cells direct items of one grid container (via
// display:contents below) forces every row to share the exact same two
// column tracks, so the vertical divider is pixel-identical top to
// bottom, and with no row gap, every row's borderBottom butts directly
// against the next row's top edge -- reading as one continuous ruled
// line rather than a stack of separately-drawn segments.
const poolRowListStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  columnGap: 20,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.9em",
};

// display:contents -- this row's own box disappears entirely for layout
// purposes, so its two children (name, score spans) become direct
// items of the shared poolRowListStyle grid above instead of being
// boxed up in their own independent one. Non-inherited visual
// properties (padding, the gridlines themselves) can't live here
// anymore since there's no box left to paint them on -- see
// poolPlayerNameStyle/playerTotalStyle, which carry those directly now.
// Inherited properties (color, font, italic) still cascade through a
// display:contents element completely normally, so spreading a status
// color or placeholderRowStyle onto this still works exactly as it did
// when this was a real box.
const poolRowStyle: React.CSSProperties = {
  display: "contents",
};

// Still used by DestinationBox, whose column stays a fixed 180px --
// truncation is the right call there. NOT used by PoolBox anymore (see
// poolPlayerNameStyle below) -- a pool box's own column now grows to
// fit its widest name instead of clipping it.
const playerNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

// PoolBox names are allowed to grow their own column instead of
// truncating -- see gridStyle's minmax(180px, max-content) pool-column
// tracks, a CSS Grid track's max-content size already accounts for
// every cell sharing that column. Deliberately no overflow/ellipsis/
// minWidth:0 (unlike playerNameStyle above): those exist specifically
// to let text shrink and clip, which is the opposite of what's wanted
// here -- this needs to report its real natural width so the column
// actually grows to fit it.
// padding/borderBottom live here now (not on a wrapping row div) --
// this cell IS the box that paints them, since its own row is
// display:contents (see poolRowStyle). The horizontal gridline runs on
// every row including the last, same as playerRowStyle's own version --
// Google Sheets doesn't drop the final row's underline either.
const poolPlayerNameStyle: React.CSSProperties = {
  whiteSpace: "nowrap",
  padding: "4px 0",
  borderBottom: `1px solid ${COLORS.border}`,
};

// Vertical divider between a player's name and their score -- reuses
// COLORS.border (already the muted line around each box, rather than a
// new token) as a borderLeft on the score cell, which is this row's
// own second column in the SHARED poolRowListStyle grid every row in a
// box now plugs into (see its own comment) -- not just a same-width
// column within one row's own independent grid. That's the difference
// between "usually lines up" and "forced to line up": every score
// cell, across every row, occupies the literal same grid track, so
// this same borderLeft can only ever render at the same x position.
const playerTotalStyle: React.CSSProperties = {
  fontWeight: 600,
  padding: "4px 0 4px 16px",
  borderLeft: `1px solid ${COLORS.border}`,
  borderBottom: `1px solid ${COLORS.border}`,
};
