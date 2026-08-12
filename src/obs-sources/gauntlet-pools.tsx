import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Callout } from "@blueprintjs/core";
import {
  parsePoolsFromRows,
  topScoreRanks,
  colIndexToLetter,
  classifyRankingColor,
  finalRankingStatusByName,
  ParsedPool,
  PoolPlayerRow,
} from "../sheets/parse-pools";
import {
  fetchPublicSheetValues,
  fetchPublicColumnBColors,
  PublicSheetReadError,
} from "../sheets/sheets-public-read";
import { decodeSheetsConnection } from "../sheets/sheets-connection-param";
import { CellColor, colorToCss } from "../sheets/sheets-export";
import { useAppState } from "../state/store";
import {
  BODY_FONT_FAMILY,
  LOCAL_FONT_FACE_CSS,
  TITLE_FONT_FAMILY,
} from "./local-fonts";
// Same image, same webpack asset/resource handling, as schedule.tsx's
// own Banner import -- see its comment. Explicit user request to reuse
// it here too (rather than a second, separately-uploaded image) as
// part of making this overlay match Schedule's broadcast package, not
// just its color/font tokens.
import Banner from "../other-assets/backgrounds/bg.png";

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
  red: "#ef4444",
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
// sheet, is the same principle Pool Results already uses. No longer
// exported -- used to also drive dashboard.tsx's manual pool-routing
// editor, which was removed once the Progression column made it
// unnecessary (see this file's own history).
const LOSER_POOL_TITLE = /^pool\s*l/i;

/** Parses a pool title's own trailing "set number + optional letter"
 * suffix once -- e.g. "Pool 2" -> {setNumber: 2, subsetLetter: ""},
 * "Pool L2B" -> {setNumber: 2, subsetLetter: "B"} -- shared by
 * poolSortKey/poolSetNumber/poolSubsetLetter below, which each used to
 * run their own near-identical regex over the same title. null if the
 * title has no trailing number at all. */
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
 * order as the numbers themselves. A title with no trailing number at
 * all sorts after every numbered one (Number.MAX_SAFE_INTEGER),
 * keeping its relative scan-order position among other unnumbered
 * titles rather than colliding with them all at some other arbitrary
 * shared rank -- Array.prototype.sort is a stable sort (guaranteed
 * since ES2019), so ties preserve original order. */
function poolSortKey(title: string): number {
  const parsed = parsePoolTitleSuffix(title);
  if (!parsed) return Number.MAX_SAFE_INTEGER;
  const letterOffset = parsed.subsetLetter
    ? parsed.subsetLetter.charCodeAt(0) - "A".charCodeAt(0) + 1
    : 0;
  return parsed.setNumber * 100 + letterOffset;
}

/** Just the trailing letter of a lettered sub-set (e.g. "Pool 2B" ->
 * "B", "Pool 3" -> "") -- used to group pools into one row per letter,
 * so every "A" pool across every numbered set sits together on one
 * row, every "B" pool sits together on the next, and so on. */
function poolSubsetLetter(title: string): string {
  return parsePoolTitleSuffix(title)?.subsetLetter ?? "";
}

/** Just the trailing set number (e.g. "Pool 2B" -> 2) -- this pool's
 * column position. Shared across every letter-row AND across the
 * winner/loser sides (see winnerGroups/loserGroups/allNumbers below),
 * so the same set number lines up in the same column everywhere, not
 * just within one row. A title with no trailing number at all sorts
 * into its own trailing column, after every numbered one -- same
 * fallback (Number.MAX_SAFE_INTEGER) and reasoning as poolSortKey
 * above. */
function poolSetNumber(title: string): number {
  return parsePoolTitleSuffix(title)?.setNumber ?? Number.MAX_SAFE_INTEGER;
}

/** Groups pools into one row per distinct letter (see poolSubsetLetter), each
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

  // Unlike pool-results.tsx, this overlay always shows every pool at
  // once -- selectedPool isn't used to filter which pools render here,
  // only to know WHICH one the operator has actually put on Pool
  // Results right now (dashboard.tsx's "Show on Overlay" button), so
  // that same pool's own status pill can read "Live" here too instead
  // of guessing from score data (see poolStatus). poolsRefreshedAt is
  // still the right signal to re-fetch on: it's the same "something in
  // the Pools sheet changed" bump the Matches tab already sends after
  // every Export, regardless of which specific pool changed.
  const poolsRefreshedAt = useAppState((s) => s.event.poolsRefreshedAt);
  const selectedPool = useAppState((s) => s.event.selectedPool);
  // Which pools the operator has manually opted into showing "Upcoming"
  // -- see poolStatus's own comment on why this is opt-in now, not the
  // automatic default it used to be.
  const upcomingPools = useAppState((s) => s.event.gauntletPoolsUpcoming);
  // This overlay's own header title/icon -- same room-synced,
  // dashboard-editable pattern as schedule.tsx's subtitle/icon (see
  // dashboard.tsx's GauntletPoolsSettingsSection), rendered in the new
  // header bar below. Empty/null render the generic fallback/nothing,
  // same "absent means don't show it" idea scheduleSubtitle/scheduleIcon
  // already use.
  const title = useAppState((s) => s.event.gauntletPoolsTitle);
  const icon = useAppState((s) => s.event.gauntletPoolsIcon);

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
  const allNumbers = [...new Set(pools.map((p) => poolSetNumber(p.title)))].sort(
    (a, b) => a - b,
  );
  const columnIndexForNumber = new Map(allNumbers.map((n, i) => [n, i]));
  const columnFor = (pool: ParsedPool) =>
    1 + columnIndexForNumber.get(poolSetNumber(pool.title))! * 2;
  const destCol = 1 + allNumbers.length * 2;
  const losersLabelRow = 2 + winnerGroups.length;
  const loserFirstRow = losersLabelRow + 1;
  const totalRows = losersLabelRow + loserGroups.length;

  return (
    <div style={cardStyle}>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      {/* The banner art as a soft out-of-focus backdrop, same treatment
          (and the same actual image) as schedule.tsx's own Banner
          layer -- isolated on its own absolutely-positioned layer since
          inline styles can't express ::before, `inset: -20px` so the
          blur has room to bleed past the card's own edges without
          visibly softening right at the border. See cardStyle's own
          comment for why the card needs `overflow: hidden` + `position:
          relative` for this to clip and anchor correctly. */}
      <div
        style={{
          position: "absolute",
          inset: -20,
          background: `url(${Banner}) center/cover no-repeat`,
          filter: "blur(3px) brightness(0.55)",
        }}
      />
      <div style={cardContentStyle}>
        {/* Same header-bar treatment as schedule.tsx's own title panel
            (solid COLORS.panel fill, 3px white border, TITLE_FONT_FAMILY
            at the same 44px size) -- this overlay had no title/header of
            its own before, just the "Winners"/"Losers" section labels
            straight into the grid, the biggest remaining visible gap
            against Schedule's "one branded panel" look when both sit on
            stream together. */}
        <div style={titleBarStyle}>
          {/* Optional, same "no icon means don't show one" idea as an
              empty title -- see schedule.tsx's own icon rendering. */}
          {icon && (
            <img
              src={icon}
              alt=""
              style={{
                height: 100,
                width: "auto",
                maxWidth: 200,
                objectFit: "contain",
                borderRadius: 10,
                flexShrink: 0,
              }}
            />
          )}
          {/* 56px, up from 36 -- see cardStyle's own comment on why this
              file's sizes were rechecked against a true 1920x1080
              viewport instead of the small preview used most of this
              file's development. */}
          <div style={{ fontFamily: TITLE_FONT_FAMILY, fontSize: 56 }}>
            {title || "Gauntlet Pools"}
          </div>
        </div>
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
            Winners Side Bracket
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
                allPools={pools}
                selectedPool={selectedPool}
                upcomingPools={upcomingPools}
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
              // Explicit user request for more breathing room between
              // the Winners and Losers sections -- gridStyle's own
              // rowGap applies uniformly to every row gap in the grid
              // (between pool rows within a side too), so it can't be
              // bumped just for this one transition without affecting
              // everything else. A top margin on this specific label
              // adds extra space only here, on top of the existing gap.
              marginTop: 128,
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
  );
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
 * only returns null if NONE of them are known. Feeds bracketPlayTotal
 * below (each side's own final-round count, then summed into one
 * combined "Top N" both destination boxes title themselves with) --
 * same finished-independent, template-driven count as advancingCount
 * itself, never gated on pool.finished or on a name being present. */
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
 * poolSetNumber, which strips the letter). This is deliberately NOT every
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
  const maxNumber = Math.max(...pools.map((p) => poolSetNumber(p.title)));
  return pools.filter((p) => poolSetNumber(p.title) === maxNumber);
}

/** Parses a Progression cell's shorthand -- {rank}P{L?}{number}{letter?},
 * e.g. "3PL2" = 3rd place of Pool L2, "1P1" = 1st place of Pool 1 --
 * into its rank (1-based) and the lowercase/trimmed lookup key its
 * SOURCE pool's title would have (e.g. "pool l2", "pool 1"). Used by
 * resolveSlotDisplay to look up that source pool by title and, once
 * it's finished, find whoever placed at that rank. null if the cell
 * doesn't match this format at all (blank, or some other convention). */
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
 * 11th/12th/13th exceptions (not "1th"/"2th"/"3th" and not "11st"/
 * "12nd"/"13rd"). Used for a Progression slot's own fallback label (see
 * resolveSlotDisplay) when the exact player isn't resolvable yet. */
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
// parse-pools.ts's own `slotIndex < 4` cap (parsePoolsFromRows)
// exactly. Duplicated as a literal here rather than exported from
// parse-pools.ts, since nothing about that shared parser changes for
// this -- see poolSlotDisplays' own comment on why the padding stays
// entirely local to this file.
const POOL_SLOT_COUNT = 4;

/** One rendered slot in a PoolBox: a real, already-in-the-sheet player
 * (`row` is exactly a ParsedPool.rows entry, untouched); a PREDICTED
 * player -- resolved from a Progression code naming an exact rank in
 * an already-finished source pool (see resolveSlotDisplay), real name
 * but not yet an official row in THIS pool's own sheet data; or a
 * display-only placeholder standing in for a slot nothing can resolve
 * yet. */
type PoolSlotDisplay =
  | { kind: "real"; row: PoolPlayerRow }
  | { kind: "predicted"; player: string; sourceTitle: string }
  | { kind: "placeholder"; label: string };

/** Resolves ONE empty slot's own Progression code to exactly what
 * should render there -- explicit user request: no fallback to any
 * other mechanism. (An earlier version derived a pool-level "Winner of
 * {pool}" guess from Final-Ranking-text-matching, an operator-entered
 * mapping, and a Winners-To/Losers-To column, none of which stated a
 * specific rank the way Progression does -- removed once nothing else
 * used it.) A slot with no code, or one that can't be resolved, says so
 * plainly rather than guessing from some other signal:
 *  - blank cell: "TBD" -- nothing stated yet, not an error.
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
 *    data, so PoolBox still renders it in placeholder styling (see its
 *    "predicted" case). */
function resolveSlotDisplay(
  progressionCode: string,
  allPools: ParsedPool[],
): PoolSlotDisplay {
  if (!progressionCode) return { kind: "placeholder", label: "TBD" };
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
 * own rendering -- never mutates `pool.rows` and never returns anything
 * that flows back into a ParsedPool. Deliberately kept local to this
 * file rather than a change to parse-pools.ts's parsePoolsFromRows/
 * ParsedPool/PoolPlayerRow: dashboard.tsx's mergePendingIntoPool merges
 * CV-read scores into pool.rows purely by array position ("1st Pending
 * row -> pool's 1st row," per its own doc comment), and both
 * dashboard.tsx and pool-results.tsx consume parsePoolsFromRows'/
 * ParsedPool's exact current shape directly -- neither needs or
 * expects this padding, so it stays a pure, render-only transform
 * instead of touching the shared parser.
 *
 * Placed by each row's own `slotIndex` (real rows) or array position
 * (empty slots' own Progression code, `pool.progressionCodes[i]`), NOT
 * by "every real row first, then pad the rest at the end" -- a real,
 * fixed bug: a pool whose seeded byes sit in non-adjacent rows (e.g.
 * slot 0 and slot 3 pre-filled, slots 1-2 still open Progression
 * seats) used to render both real players compacted into the first two
 * visual rows, and hand the wrong Progression codes to the wrong empty
 * seats, once real.length no longer matched which physical rows were
 * actually the empty ones. Explicit user request: a player stays in
 * the same row they're assigned, not wherever this function's own
 * padding happens to put them. */
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

/** A pool's own broadcast-facing status pill, or null to show no pill
 * at all. "Live" matches what the operator has actually told Pool
 * Results to show right now (event.selectedPool, set via
 * dashboard.tsx's "Show on Overlay" button) rather than guessing from
 * score data -- explicit user request: a pool counts as Live exactly
 * when it's the one currently selected for the Pool Results overlay,
 * the same ground truth the operator already maintains there, not an
 * independent inference this overlay could get out of sync with.
 * "Upcoming" used to be the automatic default for every not-finished,
 * not-selected pool -- explicit user follow-up request to remove that:
 * with a real number of pools, EVERY pool nobody's watching yet showed
 * "Upcoming," which wasn't useful signal. Now it's opt-in per pool
 * (event.gauntletPoolsUpcoming, one checkbox per pool in dashboard.tsx's
 * Matches tab) -- a not-finished, not-selected pool the operator hasn't
 * flagged shows no pill at all rather than a default "Upcoming." */
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
  upcoming: "Upcoming",
};

// Solid, high-contrast fills -- not Blueprint's Tag `intent`/`minimal`
// styling, whose barely-tinted text-on-near-transparent look was
// confirmed hard to read once layered over a pool's own header-color
// tint (which can be any hue the sheet's column B picks -- a pale
// green "Final" tag on a pale-green-tinted header, for instance, is
// nearly invisible). An opaque pill behind the label reads the same
// regardless of what's underneath it. Explicit user color choice:
// red = live (the one thing that most needs your attention right
// now), grey = final (done, no longer needs attention), gold/yellow
// = upcoming (on deck, not yet relevant).
const STATUS_COLORS: Record<PoolStatus, string> = {
  final: COLORS.muted,
  live: COLORS.red,
  upcoming: COLORS.gold,
};

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
  /** Needed so poolSlotDisplays/resolveSlotDisplay can look up a named
   * source pool by title (and, once it's finished, its own score-rank)
   * for each of this pool's own empty slots. */
  allPools: ParsedPool[];
  /** Which pool the operator has actually put on Pool Results right now
   * (event.selectedPool) -- see poolStatus's own comment. */
  selectedPool: string | null;
  /** Which pools the operator has manually opted into showing
   * "Upcoming" (event.gauntletPoolsUpcoming) -- see poolStatus's own
   * comment. */
  upcomingPools: Record<string, boolean>;
}) {
  // colorToCss(null) would return "#f5f5f5" (near-white) -- right for
  // pool-results.tsx's light card, wrong for this file's dark
  // COLORS.panel card. "No sheet color set" is handled explicitly (no
  // backgroundColor at all, falling through to boxHeaderStyle's own
  // current appearance) rather than ever calling colorToCss(null).
  const headerColor = pool ? (headerColors[pool.headerRowIndex] ?? null) : null;
  const status = pool ? poolStatus(pool, selectedPool, upcomingPools) : null;
  // Explicit user follow-up: the winner/loser side-tinted border is
  // gone for good (see boxStyle's own comment -- only its radius came
  // back), but the border should still pick up color from this box's
  // OWN status pill -- and only for "live"/"upcoming", not "final" or
  // no status at all. A pool that's live or coming up is the one that
  // actually needs the extra visual pull; a finished pool (already
  // read as "done" via its own muted pill) or one with no status yet
  // doesn't need to compete for attention the same way.
  const borderColor =
    status === "live" || status === "upcoming"
      ? STATUS_COLORS[status]
      : COLORS.border;
  // Same live/upcoming-only gate as borderColor -- explicit user
  // follow-up for a faint glow to go with it. Translucent rgba
  // versions of the exact same STATUS_COLORS.live/upcoming hex values
  // (rgb(239,68,68)/rgb(239,199,94)) rather than a new color, so the
  // glow always matches the border/pill it's paired with. `boxShadow`
  // (not `filter: drop-shadow`, which would also blur the box's own
  // sharp edges/text) keeps the box itself crisp and only softens the
  // glow radiating outward from it.
  const glow =
    status === "live"
      ? "0 0 18px 2px rgba(239, 68, 68, 0.45)"
      : status === "upcoming"
        ? "0 0 18px 2px rgba(239, 199, 94, 0.45)"
        : "none";
  return (
    <div
      style={{
        ...boxStyle,
        border: `1px solid ${borderColor}`,
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
        <PoolRowList pool={pool} colors={colors} allPools={allPools} />
      )}
    </div>
  );
}

/** The name/score rows inside one PoolBox -- split out from PoolBox
 * itself purely so `pool` can be typed as a plain (non-optional)
 * ParsedPool here, letting TypeScript narrow it for free instead of
 * needing an IIFE (or a non-null assertion) to compute
 * finalRankingStatusByName/poolSlotDisplays once PoolBox has already
 * confirmed `pool` exists. */
function PoolRowList({
  pool,
  colors,
  allPools,
}: {
  pool: ParsedPool;
  colors: (CellColor | null)[];
  allPools: ParsedPool[];
}) {
  // Computed once per pool, not per row -- see finalRankingStatusByName's
  // own comment for why this has to be a name lookup rather than each
  // row reading its own Final Ranking cell directly.
  const statusByName = finalRankingStatusByName(pool, colors);
  return (
    <div style={poolRowListStyle}>
      {poolSlotDisplays(pool, allPools).map((slot, idx) => {
        if (slot.kind === "placeholder") {
          // Same convention as bracket-tree.tsx's own describeEmptySlot
          // rendering for a not-yet-determined start.gg bracket slot:
          // the placeholder text sits inline where a real name would
          // go, muted + italic -- not a separate note block.
          return (
            <div key={idx} style={{ ...poolRowStyle, ...placeholderRowStyle }}>
              <span style={poolPlayerNameStyle}>{slot.label}</span>
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
          // Real name, resolved from a Progression code + that source
          // pool's own finished score-rank (see resolveSlotDisplay) --
          // not yet an official row in THIS pool's own sheet data, so
          // still styled like a placeholder (muted + italic) rather
          // than a confirmed row, just showing who it actually is
          // instead of a generic label.
          return (
            <div key={idx} style={{ ...poolRowStyle, ...placeholderRowStyle }}>
              <span style={poolPlayerNameStyle}>{slot.player}</span>
              <span style={playerTotalStyle}>--</span>
            </div>
          );
        }
        const playerRow = slot.row;
        // Advancing is read from Final Ranking's own color, keyed by
        // THIS row's own player NAME (statusByName) rather than this
        // row's own cell position -- see finalRankingStatusByName's
        // comment for why: the real count who advance out of a pool
        // varies (1, 2, or 3 players, not always 2), and which
        // specific player that is isn't necessarily whoever the Final
        // Ranking column happens to sit beside. Gated on pool.finished,
        // unlike the pool's own progression count (advancingCount, see
        // its comment) -- explicit user instruction: a pool's Final
        // Ranking cells can be pre-colored by template before any name
        // is even in them, which tells you HOW MANY slots are winning
        // ones but says nothing about WHICH player ends up in one, so
        // naming/highlighting a specific person waits for the pool to
        // actually be done. Kept in sync with the row's own
        // destination box (aggregateAdvancing/advancingNames, same
        // Finished gate) so this box and that one always agree on
        // who's advancing. Uniform between Winner's and Loser's-side
        // pools -- not advancing renders the same muted way regardless
        // of which side eliminates a player.
        const status = pool.finished
          ? (statusByName.get(playerRow.player.trim().toLowerCase()) ?? null)
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
            <span style={poolPlayerNameStyle}>{playerRow.player}</span>
            <span style={playerTotalStyle}>{playerRow.total || "--"}</span>
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
    // Positions within the grid cell itself (not the chip below) so the
    // chip can stay auto-sized to its own content instead of stretching
    // to fill the whole 56px arrow column.
    <div
      style={{
        gridColumn: col,
        gridRow: row,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Explicit user request: plain muted-gray text floating with no
          background of its own wasn't legible enough. Same solid-chip
          idea as statusPillStyle's status badges -- COLORS.text (this
          palette's highest-contrast option) on a solid COLORS.panel
          fill, bordered so it still reads as a distinct chip against
          the card's own near-identical background color. The arrow
          itself is colored gold to match the destination box it's
          literally pointing at (COLORS.gold is that box's own border/
          title color), rather than sharing the label's plain white. */}
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
        {/* A CSS-drawn triangle now, not the "→" character -- explicit
            user report: it measured as exactly bounding-box-centered in
            this environment's own browser (verified directly via
            getBoundingClientRect), but still looked off-center in a
            real browser/OBS elsewhere. Unicode arrow glyphs are a known
            case of this: the actual visible "ink" is asymmetric (the
            arrowhead carries more visual weight than the thin shaft),
            so a geometrically-centered character box can still read as
            optically off, and exactly how far off depends on the font
            actually rendering it -- which can differ by browser/OS/font
            fallback in a way this environment can't reproduce or
            verify. A plain CSS triangle (three transparent/solid
            borders meeting at a point) has no such glyph-shape
            asymmetry and no font-fallback dependency at all -- its
            visual center IS its box center, everywhere, guaranteed. */}
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

// One cohesive card, same outer treatment as schedule.tsx (rgba(17, 20,
// 24, 0.92) fill, 20px radius, inline-block so it sizes to its own
// content) -- previously this overlay was just a bare grid of floating
// boxes straight on the page background, the biggest visible gap
// against Schedule's "one panel" look when the two sit on stream
// together. Now also reuses schedule.tsx's own blurred banner-art
// backdrop (explicit user request, once this overlay had its own title
// header to anchor it against) -- `position: relative` + `overflow:
// hidden` are new specifically for that layer: relative so the banner's
// `position: absolute` anchors to THIS box (not some further-out
// ancestor), hidden so its `inset: -20px` bleed (see the banner div's
// own comment) clips at this card's own rounded corners instead of
// spilling past them.
const cardStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  // Explicit base size, not left to inherit the browser default (~14-16px
  // effective) -- confirmed as a real bug: every size elsewhere in this
  // file is an `em` value relative to whatever this cascades down as
  // (0.8em/0.9em/1.1em/1.3em/etc.), which read fine against the small
  // ~748px preview viewport used for most of this file's own visual
  // verification, but measured genuinely too small (a pool title at
  // 15.4px) once actually checked against a real 1920x1080 canvas -- the
  // resolution this overlay is actually meant to broadcast at. 28px as
  // the new base was chosen empirically, then verified: it puts the pool
  // title around 31px, section labels around 36px, and player rows
  // around 25px, all live-checked against a true 1920x1080 viewport
  // (not the downscaled screenshot preview, which understates real size
  // -- see get the actual computed sizes via getBoundingClientRect,
  // not by eye). Padding/gap/border-radius values throughout this file
  // were scaled up alongside this (roughly proportionally) since those
  // are plain px, not em, and wouldn't have grown on their own.
  fontSize: 28,
  // The @font-face for both custom fonts (local-fonts.ts's
  // LOCAL_FONT_FACE_CSS) only ever registers ONE weight (400, hardcoded)
  // regardless of the actual supplied file's own native weight. This
  // overlay has real elements asking for a heavier weight than that --
  // sectionLabelStyle (700) and playerTotalStyle (600) -- with no real
  // bold/semibold face to fall back to, so the browser was synthesizing
  // a fake bold by algorithmically thickening the 400-weight glyphs,
  // which is what actually makes a custom display font look blurry/
  // smeared instead of crisp. `font-synthesis` is inherited, so setting
  // `none` once here blocks that synthesis for every descendant --
  // those elements now render at the font's own true (400) weight
  // instead of a faked-heavier one, rather than needing every individual
  // fontWeight value hunted down and changed by hand.
  fontSynthesis: "none",
  background: "rgba(17, 20, 24, 0.92)",
  borderRadius: 20,
  position: "relative",
  overflow: "hidden",
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

// The actual padded content, layered ABOVE the banner (see cardStyle's
// own comment) via normal DOM order -- position:relative isn't strictly
// needed for the stacking here (the banner has no z-index and this
// comes after it in source order, so it already paints on top), but
// matches schedule.tsx's own content-layer div for consistency between
// the two. Padding lives here now, not on cardStyle itself, since
// cardStyle's own box is what overflow:hidden clips the banner against
// -- padding on that same box would shrink the banner's visible area
// along with the real content instead of only the latter.
const cardContentStyle: React.CSSProperties = {
  position: "relative",
  padding: 40,
  display: "flex",
  flexDirection: "column",
  gap: 128,
};

// This overlay's own title bar -- same solid-panel treatment as
// schedule.tsx's header (COLORS.panel fill, 3px solid white border,
// 14px radius) but without that overlay's day/clock/status-badge
// column, since nothing here plays quite that role. `alignSelf:
// "flex-start"` -- explicit user request: this used to stretch to match
// however wide the grid below it rendered (cardContentStyle's flex
// column defaults every child to `stretch`), reading as a full-width
// strip rather than a bar that hugs just its own icon+title content.
const titleBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  alignSelf: "flex-start",
  gap: 24,
  background: COLORS.panel,
  border: "3px solid rgb(255, 255, 255)",
  borderRadius: 18,
  padding: "20px 32px",
  fontFamily: TITLE_FONT_FAMILY,
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
    // Pool/arrow/destination column floors scaled up alongside the rest
    // of this file's sizes (240/56/180 -> 320/72/240) -- unchanged
    // otherwise (still minmax/max-content, still auto rows), just wide
    // enough that the now-larger player-name/score text (see cardStyle's
    // own comment on the 28px base) has room to sit comfortably instead
    // of forcing every column straight to its own max-content floor.
    // Arrow column bumped again, 72px -> 150px -- explicit user request
    // ("fix the pill spacings"): the ArrowCell chip's own natural width
    // (padding + "Top 2" text + arrow, at this file's current font
    // sizes) is closer to ~140px, so a 72px track was letting the chip
    // overflow its own column regardless of how big columnGap was --
    // the gap was never the actual problem. 150px gives it real room to
    // sit inside its own track with a little breathing space left over.
    gridTemplateColumns: `repeat(${numColumns}, minmax(320px, max-content) 150px) 240px`,
    gridTemplateRows: `repeat(${numRows}, auto)`,
    // Was 4px -- fine back when ArrowCell was borderless floating text,
    // but explicit user request ("fix the spacing of the pills") once it
    // became a bordered chip (see ArrowCell's own comment): 4px left it
    // sitting almost flush against the pool boxes on both sides, reading
    // as cramped rather than a distinct chip between two boxes. Scaled
    // up further (12px -> 20px, 4px -> 8px) alongside this file's other
    // sizes.
    columnGap: "20px",
    rowGap: "8px",
  };
}

// Same "Winners"/"Losers" section-labeling idea as start.gg's own
// bracket page (and this app's own bracket-tree.tsx overlay, which
// already renders a label above each side's own <svg> for the exact
// same reason). Went through two treatments before landing here: plain
// colored text (not legible enough against the blurred banner showing
// through), then a solid COLORS.panel box with a left accent stripe
// (legible, but explicit user request to drop the box highlight
// entirely -- "get rid of the box highlight for the bracket titles").
// This keeps the ORIGINAL side-identity color as the text itself
// (COLORS.mint for Winners, COLORS.coral for Losers, set per call site,
// same tint PoolBox's own border uses) and gets its legibility from a
// dark drop shadow behind the glyphs instead of a background shape --
// enough to read clearly against the banner without a boxed look.
const sectionLabelStyle: React.CSSProperties = {
  fontFamily: TITLE_FONT_FAMILY,
  fontWeight: 700,
  fontSize: "1.3em",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  textShadow: "0 2px 6px rgba(0, 0, 0, 0.85)",
};

// Plain 1px border, no side-tinted color (see PoolBox's own comment).
// Radius went 18px -> 0 (square) -> back to 18px again -- explicit user
// follow-up: square corners read as a mismatch sitting right next to
// each pool's own fully-rounded status pill (statusPillStyle's 999px).
// 18px doesn't literally copy that value (999px on a whole multi-row
// box would just look like an odd, overly-rounded blob, not a "pill"),
// it's the same rounded-corner LANGUAGE this file already uses
// elsewhere (titleBarStyle's own radius) -- reads as "rounded, like the
// pill" without being a bizarre exact match.
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

// PoolBox-only header bar for the optional per-pool color tint (see
// PoolBox's own headerColor). Derived from boxHeaderStyle by spread,
// never mutating it -- DestinationBox also spreads boxHeaderStyle
// directly and must stay visually untouched by this. Bleeds through
// boxStyle's own padding via a matching negative margin so an actual
// tint reads as a real edge-to-edge bar. No borderBottom hairline is
// added, so the "no color set" case (backgroundColor: undefined) stays
// pixel-identical to before this existed.
const poolHeaderBarStyle: React.CSSProperties = {
  ...boxHeaderStyle,
  // Must exactly match boxStyle's own padding/borderRadius (16px 20px /
  // 18px) -- see this style's own doc above for why.
  margin: "-16px -20px 0",
  padding: "12px 20px",
  borderRadius: "18px 18px 0 0",
};

const emptyNoteStyle: React.CSSProperties = {
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.8em",
  color: COLORS.muted,
  fontStyle: "italic",
};

// Same "not a real, in-sheet value" idea as bracket-tree.tsx's own
// describeEmptySlot rendering for an undetermined start.gg bracket slot
// (italic, inline in the name position) -- spread onto playerRowStyle
// rather than replacing it, so a placeholder row still lines up with
// real rows (same padding/font-size/gap). Color was COLORS.muted
// (plain gray) -- explicit user request for better legibility on these
// rows (the Progression-driven "TBD"/ordinal-placeholder/predicted-
// player text). Switched to COLORS.gold instead of just brightening the
// gray: gold already means "pending, not yet decided" everywhere else
// on this card (the Upcoming status pill, the destination boxes' own
// border/title color), so this also makes a placeholder row's own
// "not real yet" status legible at a glance, not just its text.
const placeholderRowStyle: React.CSSProperties = {
  color: COLORS.gold,
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
  columnGap: 12,
  fontFamily: BODY_FONT_FAMILY,
  fontSize: "0.9em",
  padding: "8px 0",
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
  columnGap: 28,
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
  padding: "8px 0",
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
  padding: "8px 0 8px 24px",
  borderLeft: `1px solid ${COLORS.border}`,
  borderBottom: `1px solid ${COLORS.border}`,
};
