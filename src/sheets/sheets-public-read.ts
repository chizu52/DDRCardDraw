/**
 * Reads Google Sheets data without the interactive OAuth popup flow in
 * sheets-export.ts -- that flow needs a real browser tab to complete a
 * consent screen, which a headless OBS browser source can't do (see the
 * memory note on the OAuth-vs-OBS gap for the longer-term fix this
 * sidesteps rather than solves). Instead this uses the official Sheets
 * API v4 with a read-only API key (see sheets-export.ts's
 * sheetsApiKeyAtom, entered via SheetsCredsManager) -- only usable for
 * reading, and only against a spreadsheet shared as "Anyone with the
 * link can view".
 *
 * NOTE: this used to go through Google's public "gviz" CSV export
 * endpoint instead (no key needed at all). Switched away from it because
 * that endpoint caches aggressively and unpredictably -- confirmed
 * directly by editing the live sheet and seeing the old data keep coming
 * back for a long stretch afterward, even with a cache-busting query
 * param. Fine for a one-off export, not for something meant to show
 * live results during a broadcast. The Sheets API v4 doesn't have that
 * problem.
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

/** API-key equivalent of sheets-export.ts's readColumnBColors -- same
 * spreadsheet metadata read (cell formatting, not values), just
 * authenticated with ?key= instead of an OAuth Bearer token, so the
 * pool-results overlay can show each pool's header in the same color the
 * Matches tab does, without needing the interactive Google popup. */
export async function fetchPublicColumnBColors(
  apiKey: string,
  spreadsheetId: string,
  range = "Pools!B:B",
): Promise<(CellColor | null)[]> {
  const fields = "sheets.data.rowData.values.effectiveFormat.backgroundColor";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new PublicSheetReadError(
      `Couldn't read pool colors (HTTP ${res.status}): ${body}`,
    );
  }
  const data = await res.json();
  const rowData: SheetColorRowData[] =
    data.sheets?.[0]?.data?.[0]?.rowData || [];
  return rowData.map((r) => {
    const bg = r.values?.[0]?.effectiveFormat?.backgroundColor;
    if (!bg) return null;
    return { r: bg.red ?? 1, g: bg.green ?? 1, b: bg.blue ?? 1 };
  });
}
