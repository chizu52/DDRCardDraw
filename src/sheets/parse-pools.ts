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

export function parsePoolsFromRows(rows: string[][]): ParsedSheet {
  const pools: ParsedPool[] = [];
  let current: ParsedPool | null = null;
  let currentSongCols: number[] = [];
  let currentTotalCol: number | null = null;
  let currentFinishedCol: number | null = null;
  let slotIndex = 0;
  let consecutiveEmpty = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (row[1] || "").trim();

    if (/pool/i.test(cell)) {
      const { songCols, totalCol, finishedCol } = findHeaderColumns(row);
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
      currentSongCols = songCols;
      currentTotalCol = totalCol;
      currentFinishedCol = finishedCol;
      pools.push(current);
      slotIndex = 0;
      consecutiveEmpty = 0;
      continue;
    }

    if (current && slotIndex < 4) {
      const songs = currentSongCols.map((c) => (row[c] || "").trim());
      const total =
        currentTotalCol !== null ? (row[currentTotalCol] || "").trim() : "";
      if (cell) {
        current.rows.push({ player: cell, songs, total, rowIndex: i });
        // The sheet only carries the Finished flag on a pool's first player
        // row, not on every row -- mirror that convention here.
        if (slotIndex === 0 && currentFinishedCol !== null) {
          current.finished = /^true$/i.test(
            (row[currentFinishedCol] || "").trim(),
          );
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
    const songs = row.songs.map((existing, songIdx) => p.songs[songIdx] || existing);
    return { ...row, songs };
  });

  return { pool: { ...pool, rows }, mergedCount };
}
