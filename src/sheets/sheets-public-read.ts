/**
 * Reads Google Sheets data without the interactive OAuth popup flow in
 * sheets-export.ts -- that flow needs a real browser tab to complete a
 * consent screen, which a headless OBS browser source can't do. Instead
 * this uses the official Sheets API v4 with a read-only API key (see
 * sheets-export.ts's sheetsApiKeyAtom, entered via SheetsCredsManager)
 * -- only usable for reading, and only against a spreadsheet shared as
 * "Anyone with the link can view".
 *
 * NOTE: this used to go through Google's public "gviz" CSV export
 * endpoint instead (no key needed at all). Switched away from it since
 * that endpoint caches aggressively and unpredictably -- fine for a
 * one-off export, not for something meant to show live results during a
 * broadcast. The Sheets API v4 doesn't have that problem.
 */

import { CellColor } from "./sheets-export";

export class PublicSheetReadError extends Error {}

export async function fetchPublicSheetValues(
  apiKey: string,
  spreadsheetId: string,
  sheetName = "Pools",
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new PublicSheetReadError(
      `Couldn't read the sheet (HTTP ${res.status}): ${body}. Make sure it's shared as "Anyone with the link can view", the API key is restricted to the Sheets API, and the Sheets API is enabled for that key's project.`,
    );
  }
  const data = await res.json();
  return data.values || [];
}

interface SheetColorRowData {
  values?: {
    effectiveFormat?: {
      backgroundColor?: { red?: number; green?: number; blue?: number };
    };
  }[];
}

/** API-key equivalent of sheets-export.ts's readCellColors -- same
 * spreadsheet metadata read (cell formatting, not values), just
 * authenticated with ?key= instead of an OAuth Bearer token, so overlays
 * can show a pool's header/advancement colors without the interactive
 * Google popup.
 *
 * Reads one or more ranges in a SINGLE Sheets API request -- repeated
 * `ranges=` query params are standard `spreadsheets.get` behavior, and
 * the response's `sheets[0].data[]` array comes back with exactly one
 * entry per requested range, in the same order they were given. Used to
 * be one function per single range (`fetchPublicColumnBColors`), called
 * twice per overlay poll (once for the header-color column, once for the
 * Final Ranking column) -- each call is its own Sheets API quota hit, and
 * every overlay/dashboard tab polling independently made this a real
 * contributor to hitting Google's per-minute read quota (see
 * [[project_sheets_api_rate_limit]]). Combining into one multi-range
 * request cuts that from 2 calls to 1 per poll, for every caller. */
export async function fetchPublicCellColors(
  apiKey: string,
  spreadsheetId: string,
  ranges: string[],
): Promise<(CellColor | null)[][]> {
  const fields = "sheets.data.rowData.values.effectiveFormat.backgroundColor";
  const rangesParam = ranges
    .map((r) => `ranges=${encodeURIComponent(r)}`)
    .join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?${rangesParam}&fields=${encodeURIComponent(fields)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new PublicSheetReadError(
      `Couldn't read pool colors (HTTP ${res.status}): ${body}`,
    );
  }
  const data = await res.json();
  // `sheets[0].data[i]` -- the i-th requested range's own rowData, NOT
  // `sheets[i]` (there's only ever one sheet object here; `data[]` is
  // what's indexed per-range).
  const perRange: { rowData?: SheetColorRowData[] }[] =
    data.sheets?.[0]?.data || [];
  return ranges.map((_, i) => {
    const rowData: SheetColorRowData[] = perRange[i]?.rowData || [];
    return rowData.map((r) => {
      const bg = r.values?.[0]?.effectiveFormat?.backgroundColor;
      if (!bg) return null;
      // `?? 0`, not `?? 1` -- the Sheets API's JSON serialization omits a
      // channel key entirely when its value is exactly 0 (proto3
      // default-omission), not when it's "unspecified, fall back to
      // white." A pure green cell comes back as {green: 1} with red/blue
      // omitted (meaning 0); defaulting missing channels to 1 would turn
      // that into white instead.
      return { r: bg.red ?? 0, g: bg.green ?? 0, b: bg.blue ?? 0 };
    });
  });
}
