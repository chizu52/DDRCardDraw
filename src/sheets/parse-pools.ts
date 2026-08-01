export interface PoolPlayerRow {
  player: string;
  songs: string[];
  total: string;
  rowIndex: number;
}

export interface ParsedPool {
  title: string;
  songCount: number;
  headerRowIndex: number;
  songCols: number[];
  totalCol: number | null;
  finishedCol: number | null;
  finished: boolean;
  rows: PoolPlayerRow[];
}

export interface ParsedSheet {
  pools: ParsedPool[];
}

const MAX_CONSECUTIVE_EMPTY = 20;

function findHeaderColumns(headerRow: string[]): {
  songCols: number[];
  totalCol: number | null;
  finishedCol: number | null;
} {
  const songCols: number[] = [];
  let totalCol: number | null = null;
  let finishedCol: number | null = null;
  // Scan the whole row (not stopping at Total) so columns further right,
  // like Final Ranking / Finished, are still found.
  for (let col = 2; col < headerRow.length; col++) {
    const cell = (headerRow[col] || "").trim();
    if (!cell) continue;
    if (/finished/i.test(cell)) {
      finishedCol = col;
    } else if (totalCol === null && /total/i.test(cell)) {
      totalCol = col;
    } else if (totalCol === null) {
      songCols.push(col);
    }
  }
  return { songCols, totalCol, finishedCol };
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
  const { songCols, totalCol, finishedCol } = findHeaderColumns(
    rows[findHeaderRowIndex(rows)] || [],
  );

  // Deliberately NOT starting from headerRowIndex + 1: in the current sheet
  // layout that row *is* Pool 1's own title row (see above), so skipping
  // past it would skip Pool 1 entirely. Row 0 is always either blank, a
  // pure master header, or a pure section title -- never a real pool's
  // title -- so a fixed start of 1 is safe across every layout seen so far.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (row[1] || "").trim();

    if (/pool/i.test(cell)) {
      current = {
        title: cell,
        songCount: songCols.length,
        headerRowIndex: i,
        songCols,
        totalCol,
        finishedCol,
        finished: false,
        rows: [],
      };
      pools.push(current);
      slotIndex = 0;
      consecutiveEmpty = 0;
      continue;
    }

    if (current && slotIndex < 4) {
      const songs = songCols.map((c) => (row[c] || "").trim());
      const total = totalCol !== null ? (row[totalCol] || "").trim() : "";
      if (cell) {
        current.rows.push({ player: cell, songs, total, rowIndex: i });
        // The sheet only carries the Finished flag on a pool's first player
        // row, not on every row -- mirror that convention here.
        if (slotIndex === 0 && finishedCol !== null) {
          current.finished = /^true$/i.test((row[finishedCol] || "").trim());
        }
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

/** Maps row index (into pool.rows) -> 1-based placement by total score
 * (highest first), ties broken by row order. Rows with no real score yet
 * (total of 0) are never included. Not capped at 2 -- callers that only
 * care about gold/silver (the Dashboard's own row highlighting) just
 * check for rank === 1 / rank === 2 and ignore the rest; the pool-results
 * overlay's configurable advance count (see event.slice.ts's
 * overlayAdvanceCount) needs ranks beyond 2nd place too. */
export function topScoreRanks(pool: ParsedPool): Map<number, number> {
  const ranked = pool.rows
    .map((row, idx) => ({ idx, total: parseFloat(sumScores(row.songs)) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  return new Map(ranked.map((r, i) => [r.idx, i + 1]));
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
