#!/usr/bin/env node
/**
 * Reports maimai DX songs that are live in the USA client but still have one
 * or more charts withheld from the USA region (e.g. a song's EXPERT chart
 * has reached the USA build while its newly added MASTER chart hasn't).
 *
 * Reads the same raw maimai database dump as import-maimai.mts and applies
 * the same MAIMAI_PATCH corrections first, so titles/artists in the report
 * match what actually ends up in the app.
 *
 * A sheet only counts as "on USA" or "missing from USA" if it carries a
 * `regions` block at all -- sheets with no region data give no evidence
 * either way and are excluded from both buckets, rather than guessed at.
 *
 * Usage: yarn report:maimai-usa-gaps <path-to-maimai-database.json> [output.csv]
 */
import { readFile, writeFile } from "node:fs/promises";
import Papa from "papaparse";
import { MAIMAI_PATCH } from "./maimai/maimai-patches.mjs";

const [, , inputPath, outputArg] = process.argv;
if (!inputPath) {
  console.error(
    "Usage: yarn report:maimai-usa-gaps <path-to-maimai-database.json> [output.csv]",
  );
  process.exit(1);
}

const OUTPUT_PATH = outputArg || "maimai-usa-gaps.csv";

interface RawRegions {
  jp?: boolean;
  intl?: boolean;
  usa?: boolean;
}

interface RawSheet {
  difficulty?: string;
  type?: string;
  internalLevelValue?: number | null;
  regions?: RawRegions;
}

interface RawSong {
  songId?: string;
  title?: string;
  artist?: string;
  version?: string;
  releaseDate?: string;
  sheets?: RawSheet[];
}

interface ReportRow {
  title: string;
  artist: string;
  version: string;
  releaseDate: string;
  usaCharts: string;
  missingFromUsaCharts: string;
  missingCount: number;
  totalCharts: number;
}

/** Human-readable label for one chart, e.g. "dx master (Lv 13.4)" */
function chartLabel(sheet: RawSheet): string {
  const lvl =
    sheet.internalLevelValue == null ? "?" : sheet.internalLevelValue;
  return `${sheet.type ?? "?"} ${sheet.difficulty ?? "?"} (Lv ${lvl})`;
}

const raw = JSON.parse(await readFile(inputPath, "utf-8"));
const songs = (raw.songs as RawSong[]) ?? [];

const rows: ReportRow[] = [];

for (const song of songs) {
  const patch =
    MAIMAI_PATCH[song.songId ?? ""] || MAIMAI_PATCH[song.title ?? ""];
  if (patch) Object.assign(song, patch);

  const sheets = song.sheets ?? [];

  const usaCharts = sheets.filter((s) => s.regions?.usa === true);
  const missingFromUsaCharts = sheets.filter(
    (s) => s.regions && s.regions.usa !== true,
  );

  // Only songs that are BOTH already on USA (>=1 chart) AND still missing
  // at least one chart from USA belong in this gap report.
  if (usaCharts.length > 0 && missingFromUsaCharts.length > 0) {
    rows.push({
      title: song.title ?? "(unknown title)",
      artist: song.artist ?? "",
      version: song.version ?? "",
      releaseDate: song.releaseDate ?? "",
      usaCharts: usaCharts.map(chartLabel).join("; "),
      missingFromUsaCharts: missingFromUsaCharts.map(chartLabel).join("; "),
      missingCount: missingFromUsaCharts.length,
      totalCharts: sheets.length,
    });
  }
}

rows.sort((a, b) => a.title.localeCompare(b.title));

const csv = Papa.unparse(rows, {
  columns: [
    "title",
    "artist",
    "version",
    "releaseDate",
    "usaCharts",
    "missingFromUsaCharts",
    "missingCount",
    "totalCharts",
  ],
});

await writeFile(OUTPUT_PATH, csv, "utf-8");

console.log(
  `Found ${rows.length} song(s) with partial USA availability. Wrote ${OUTPUT_PATH}`,
);
