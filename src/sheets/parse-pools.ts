import { CellColor } from "./sheets-export";

export interface PoolPlayerRow {
  player: string;
  songs: string[];
  total: string;
  /** Raw text from the Final Ranking column (e.g. "1st"), if this sheet
   * has one -- empty string otherwise. The actual advance/eliminated
   * decision comes from that column's cell background color (read
   * separately -- see gauntlet-pools.tsx's classifyRankingColor -- since
   * the number of players who actually advance out of a pool isn't fixed
   * at any particular rank cutoff), not from parsing this text. Kept
   * here for display/debugging only. */
  finalRanking: string;
  rowIndex: number;
  /** This row's own position within its POOL (0-3), not the sheet --
   * e.g. a pool whose 1st and 4th slots are pre-seeded byes and whose
   * 2nd/3rd slots are still-empty Progression seats has slotIndex 0 and
   * 3 here, not 0 and 1. `rows` only ever contains FILLED slots (see
   * parsePoolsFromRows' own `if (cell)` gate), so this is the one place
   * that still remembers which physical slot a filled row actually
   * occupied -- gauntlet-pools.tsx's poolSlotDisplays needs it to keep
   * a real player in their own assigned row instead of compacting every
   * filled row to the front and only then appending empty/predicted
   * slots at the end, which silently misassigns both the player's
   * displayed position AND which Progression code (also indexed by
   * slot -- see progressionCodes below) applies to which empty seat
   * whenever a pool's filled rows aren't a contiguous top block. */
  slotIndex: number;
}

export interface ParsedPool {
  title: string;
  songCount: number;
  headerRowIndex: number;
  songCols: number[];
  totalCol: number | null;
  /** Column holding each player's Final Ranking text + advance-signaling
   * background color -- null if this sheet's header row doesn't have a
   * Final Ranking column. */
  finalRankingCol: number | null;
  /** Column holding each row's Progression text (e.g. "3PL2" = 3rd
   * place of Pool L2) -- null if this sheet's header row doesn't have
   * one. */
  progressionCol: number | null;
  finishedCol: number | null;
  finished: boolean;
  rows: PoolPlayerRow[];
  /** Every Progression cell across this pool's row range -- e.g. "3PL2"
   * (3rd place of Pool L2) -- ALWAYS exactly POOL_SLOT_COUNT (4) long,
   * one entry per slot position ("" for a slot with no code), read
   * regardless of whether that specific row has a player name yet.
   * Position matters: gauntlet-pools.tsx's poolSlotDisplays looks up a
   * SPECIFIC empty slot's own code by index (progressionCodes[slotIndex])
   * to resolve exactly which rank/pool that one slot refers to, not
   * just "does this pool have any code anywhere" -- filtering out
   * blanks here (an earlier version of this field did) silently shifts
   * every later slot's code into the wrong position. Confirmed as a
   * real bug once this pool tracked progression per-PoolPlayerRow
   * instead: a Progression code is placed on the DESTINATION pool's row
   * (stating where that seat's occupant came FROM, not where this
   * pool's own players are going -- confirmed with the user directly),
   * which is exactly the row most likely to have NO player name yet
   * (that's the whole reason the code exists at all) -- rows.push only
   * ever happens `if (cell)` (a real player name present), so any code
   * sitting on a still-empty seat was being silently dropped before
   * gauntlet-pools.tsx's poolSlotDisplays ever saw it. */
  progressionCodes: string[];
}

export interface ParsedSheet {
  pools: ParsedPool[];
}

const MAX_CONSECUTIVE_EMPTY = 20;

function findHeaderColumns(headerRow: string[]): {
  titleCol: number;
  songCols: number[];
  totalCol: number | null;
  finalRankingCol: number | null;
  progressionCol: number | null;
  finishedCol: number | null;
} {
  // Which column is "Seed" -- and therefore which column right after it
  // is the pool title / player-name column -- isn't fixed at 0/1
  // either: confirmed by a real sheet gaining a new column A
  // ("Progression"), shifting Seed to B and the title/player column to
  // C. Detected by content first, same principle findHeaderRowIndex
  // already applies to finding the header ROW, rather than assuming
  // either column sits at a fixed index. Falls back to the old fixed
  // assumption (column 1) if this sheet's header row doesn't literally
  // spell out "Seed" -- every real layout seen so far does, but this
  // keeps a sheet that somehow doesn't working exactly as before.
  let seedCol: number | null = null;
  for (let col = 0; col < headerRow.length; col++) {
    if (/^seed$/i.test((headerRow[col] || "").trim())) {
      seedCol = col;
      break;
    }
  }
  const titleCol = seedCol !== null ? seedCol + 1 : 1;

  const songCols: number[] = [];
  let totalCol: number | null = null;
  let finalRankingCol: number | null = null;
  let progressionCol: number | null = null;
  let finishedCol: number | null = null;
  // Scan every column after the title column (skips Seed and the title
  // column itself, same as the old fixed `col = 2` start did, just
  // computed instead of assumed) so columns further right, like Final
  // Ranking / Progression / Finished, are still found.
  for (let col = titleCol + 1; col < headerRow.length; col++) {
    const cell = (headerRow[col] || "").trim();
    if (!cell) continue;
    if (/finished/i.test(cell)) {
      finishedCol = col;
    } else if (/final\s*ranking/i.test(cell)) {
      // Checked as its own branch (not folded into the totalCol===null
      // fallback below) so it's captured regardless of where it falls
      // relative to Total -- previously this cell matched neither
      // /finished/i nor /total/i and, once totalCol was already set,
      // fell through and was silently discarded.
      finalRankingCol = col;
    } else if (/progression/i.test(cell)) {
      progressionCol = col;
    } else if (totalCol === null && /total/i.test(cell)) {
      totalCol = col;
    } else if (totalCol === null) {
      songCols.push(col);
    }
  }
  return {
    titleCol,
    songCols,
    totalCol,
    finalRankingCol,
    progressionCol,
    finishedCol,
  };
}

// The real header (the row carrying Song 1/2/3/4/Total/Finished labels)
// isn't reliably at a fixed row index -- the sheet has gained a "Gauntlet
// Pools" title row above it at least once already, and could grow more
// title/spacer rows above that in the future. Search for it by content
// instead of assuming row 0: the header is whichever row actually yields
// song columns.
function findHeaderRowIndex(rows: string[][]): number {
  for (let i = 0; i < rows.length; i++) {
    const { songCols } = findHeaderColumns(rows[i] || []);
    if (songCols.length > 0) {
      return i;
    }
  }
  return 0;
}

export function parsePoolsFromRows(rows: string[][]): ParsedSheet {
  const pools: ParsedPool[] = [];
  let current: ParsedPool | null = null;
  let slotIndex = 0;
  let consecutiveEmpty = 0;

  // Column layout (which columns are Song 1/2/3/4, Total, Finished) is
  // fixed for the whole "Pools" tab, but which row actually carries those
  // labels isn't fixed -- sometimes it's a standalone master header row,
  // sometimes (as of the "Gauntlet Pools" reorg) each pool's own title row
  // repeats the full labels itself (e.g. "Seed | Pool 1 | Song 1 | ... |
  // Finished"). Either way, detecting the layout by content once, from
  // whichever row actually has song columns, is what fixes both the old
  // per-pool-redetection bug (misreading a stray "Final Ranking" label as a
  // lone "Song 1" column) and the newer wrong-row bug (a title-only row like
  // "Gauntlet Pools" above the real header).
  const {
    titleCol,
    songCols,
    totalCol,
    finalRankingCol,
    progressionCol,
    finishedCol,
  } = findHeaderColumns(rows[findHeaderRowIndex(rows)] || []);

  // Deliberately NOT starting from headerRowIndex + 1: in the current sheet
  // layout that row *is* Pool 1's own title row (see above), so skipping
  // past it would skip Pool 1 entirely. Row 0 is always either blank, a
  // pure master header, or a pure section title -- never a real pool's
  // title -- so a fixed start of 1 is safe across every layout seen so far.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (row[titleCol] || "").trim();

    if (/pool/i.test(cell)) {
      current = {
        title: cell,
        songCount: songCols.length,
        headerRowIndex: i,
        songCols,
        totalCol,
        finalRankingCol,
        progressionCol,
        finishedCol,
        finished: false,
        rows: [],
        progressionCodes: [],
      };
      pools.push(current);
      slotIndex = 0;
      consecutiveEmpty = 0;
      continue;
    }

    if (current && slotIndex < 4) {
      const songs = songCols.map((c) => (row[c] || "").trim());
      const total = totalCol !== null ? (row[totalCol] || "").trim() : "";
      const finalRanking =
        current.finalRankingCol !== null
          ? (row[current.finalRankingCol] || "").trim()
          : "";
      const progression =
        current.progressionCol !== null
          ? (row[current.progressionCol] || "").trim()
          : "";
      // Pushed unconditionally (even "") -- captured regardless of
      // whether this row has a player name yet, see ParsedPool's own
      // progressionCodes comment for why that matters (a code is most
      // often sitting on exactly the row that doesn't have a name
      // yet). Position matters just as much as content here:
      // gauntlet-pools.tsx's poolSlotDisplays indexes this array by
      // SLOT (progressionCodes[slotIndex]) to resolve each specific
      // empty slot's own code, not just "does this pool have any code
      // anywhere" -- filtering out blanks here would shift every later
      // slot's code into the wrong position.
      current.progressionCodes.push(progression);
      // Read unconditionally (not gated behind `if (cell)` below) for the
      // same reason progressionCodes above is: a pool seeded from
      // still-unresolved Progression results can have an EMPTY slot 0
      // (e.g. its 1st-place seat reads "3rd of Pool 2," not a real name
      // yet) while its later slots already hold real bye-seeded players --
      // confirmed against real sheet data (Pool L2: slots 0-1 are still
      // progression placeholders, slots 2-3 already have real names).
      // Gating this behind `cell` meant a pool in exactly that shape could
      // never read Finished=TRUE from the sheet at all, no matter what was
      // actually written there -- silently breaking every finished-gated
      // feature for that pool forever: the Final/Live status pill,
      // "Colored Placements upon Finalization" row tinting, and
      // advancing/eliminated name coloring. Root cause of a real reported
      // bug ("color placements stopped working").
      if (slotIndex === 0 && finishedCol !== null) {
        current.finished = /^true$/i.test((row[finishedCol] || "").trim());
      }
      if (cell) {
        current.rows.push({
          player: cell,
          songs,
          total,
          finalRanking,
          rowIndex: i,
          slotIndex,
        });
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
      }
      slotIndex++;
      continue;
    }

    if (!cell) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }
  }

  return { pools };
}

/** Total column is derived, not entered -- sums whatever song scores (each
 * a "DDD.DDDD%" string) are currently filled in, skipping blanks. */
export function sumScores(songs: string[]): string {
  const values = songs
    .map((s) => parseFloat(s.replace("%", "")))
    .filter((n) => !Number.isNaN(n));
  if (!values.length) return "0.000%";
  const sum = values.reduce((a, b) => a + b, 0);
  return `${sum.toFixed(4)}%`;
}

/** Formats a raw per-song score cell to a consistent "98.5000%" display --
 * always exactly 4 decimal places and a % sign, regardless of how the
 * value was actually typed into the sheet ("98.5", "98.5%", "98.50000%",
 * ...). Blank stays blank -- the caller's own "--" placeholder (see
 * pool-results.tsx) means "not entered yet," a different signal than "a
 * real score of exactly 0," so this doesn't collapse the two. Anything
 * that isn't a real number (a typo, a non-numeric note someone typed
 * instead of a score) is shown exactly as typed rather than silently
 * replaced with a nonsensical "NaN%". */
export function formatSongScore(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const value = parseFloat(trimmed.replace("%", ""));
  if (Number.isNaN(value)) return trimmed;
  return `${value.toFixed(4)}%`;
}

/** Maps row index (into pool.rows) -> 1-based placement by total score
 * (highest first), ties broken by row order. Rows with no real score yet
 * (total of 0) are never included. Not capped at 2 -- callers that only
 * care about gold/silver (the Dashboard's own row highlighting) just
 * check for rank === 1 / rank === 2 and ignore the rest; a pool's real
 * advance count varies (1, 2, or 3 players, see classifyRankingColor/
 * finalRankingStatusByName below) and needs ranks beyond 2nd place too. */
export function topScoreRanks(pool: ParsedPool): Map<number, number> {
  const ranked = pool.rows
    .map((row, idx) => ({ idx, total: parseFloat(sumScores(row.songs)) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  return new Map(ranked.map((r, i) => [r.idx, i + 1]));
}

/** Classifies a Final Ranking cell's background color as "advancing"
 * (green) or "eliminated" (red) by HUE, not raw channel dominance --
 * confirmed as a real bug: a channel-dominance check (is green clearly
 * bigger than red and blue by some margin) fails on Google Sheets' own
 * default PASTEL green/red fill presets (e.g. their "light green 3"
 * swatch, ~rgb(217,234,211) -- green is barely bigger than red there,
 * nowhere near a fixed dominance margin), since a pale and a saturated
 * shade of the same color share roughly the same hue but very different
 * channel gaps. Hue is robust to exactly that kind of lightness/
 * saturation variation, so this reads correctly whether the sheet uses a
 * bold or a pastel swatch. Near-gray/white/unset cells (very low
 * saturation -- every channel close together) are excluded up front so a
 * faint zebra-stripe tint or a blank cell never misclassifies. Shared by
 * every place that reads pool advancement -- the gauntlet-pools overlay,
 * the pool-results overlay, and the Matches tab's own live table -- so
 * they can never drift into disagreeing about who's actually advancing. */
export function classifyRankingColor(
  cellColor: CellColor | null | undefined,
): "advancing" | "eliminated" | null {
  if (!cellColor) return null;
  const { r, g, b } = cellColor;
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
 * very often names a completely different player than whoever's printed
 * in that same row's own player-name column -- real example: row 1 is
 * "DaUTF" (own score is 2nd-highest in the pool), but row 1's Final
 * Ranking cell reads "Tibby," the pool's actual highest scorer. The
 * COLOR (bright green = a winning rank, bright red = a losing rank)
 * lives on that same cell and still means exactly what it always meant
 * -- but it describes the RANK SLOT that row represents, not whichever
 * player happens to share that row, so the player it actually applies to
 * is whoever's name is written there as text. Confirmed live: coloring
 * by row position instead of by this text attributes wins/losses to the
 * wrong players entirely (a pool's actual top scorer showing eliminated,
 * its actual bottom scorer showing advancing) once rows aren't already
 * in score order. Callers should still gate on `pool.finished` before
 * attributing a specific NAME to a colored slot -- a Final Ranking cell
 * can be (and often is) pre-colored by template before any real name is
 * in it, which tells you how many slots are winning ones but nothing
 * about which player ends up in one yet. */
export function finalRankingStatusByName(
  pool: ParsedPool,
  colors: (CellColor | null)[],
): Map<string, "advancing" | "eliminated"> {
  const byName = new Map<string, "advancing" | "eliminated">();
  for (const row of pool.rows) {
    const status = classifyRankingColor(colors[row.rowIndex]);
    // Case-insensitive key -- confirmed against real data that the same
    // player's name isn't always typed with matching capitalization in
    // both places (real example: roster column has "jabronski," that
    // same pool's Final Ranking column names them "Jabronski").
    const name = row.finalRanking.trim().toLowerCase();
    if (status && name) byName.set(name, status);
  }
  return byName;
}

export function colIndexToLetter(col: number): string {
  let letter = "";
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

export interface PendingRow {
  songs: string[];
  rowIndex: number;
}

/**
 * Parses the "Pending" tab -- the CV score-reader's staging area. Header is
 * Seed | Pool | Song 1 | Song 2 | Song 3 | Song 4. Rows are returned in
 * sheet order with no identity matching (no Seed/Pool lookup) -- merging
 * is purely positional, see mergePendingIntoPool. Fully blank rows are
 * skipped so they don't consume a slot.
 */
export function parsePendingRows(rows: string[][]): PendingRow[] {
  const result: PendingRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const songs = [2, 3, 4, 5].map((c) => (row[c] || "").trim());
    if (songs.every((s) => !s)) continue;
    result.push({ songs, rowIndex: i });
  }
  return result;
}

export interface MergeResult {
  pool: ParsedPool;
  mergedCount: number;
}

/**
 * Overlays Pending rows onto a single already-parsed pool purely by
 * position: the 1st Pending row -> the pool's 1st row, 2nd -> 2nd, and so
 * on -- no Seed/name lookup. Only fills song slots that Pending actually
 * has a value for; blanks fall back to whatever was already in the pool's
 * row, so a partial CV read never clobbers a good manually-entered score.
 * Extra Pending rows beyond the pool's row count are ignored.
 */
export function mergePendingIntoPool(
  pool: ParsedPool,
  pending: PendingRow[],
): MergeResult {
  let mergedCount = 0;

  const rows = pool.rows.map((row, idx) => {
    const p = pending[idx];
    if (!p) return row;
    mergedCount++;
    const songs = row.songs.map(
      (existing, songIdx) => p.songs[songIdx] || existing,
    );
    return { ...row, songs };
  });

  return { pool: { ...pool, rows }, mergedCount };
}
