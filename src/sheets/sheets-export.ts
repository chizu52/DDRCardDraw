import { atomWithStorage } from "jotai/utils";

export const sheetsTokenAtom = atomWithStorage<string | null>(
  "ddrtools.event.sheetstoken",
  null,
  undefined,
  { getOnInit: true },
);

export const spreadsheetIdAtom = atomWithStorage<string | null>(
  "ddrtools.event.spreadsheetid",
  null,
  undefined,
  { getOnInit: true },
);

export const googleClientIdAtom = atomWithStorage<string | null>(
  "ddrtools.event.googleclientid",
  null,
  undefined,
  { getOnInit: true },
);

// A separate, read-only API key -- not the OAuth client ID above. Used
// only by the pool-results OBS overlay (see sheets-public-read.ts),
// which can't do the interactive OAuth popup consent flow that the rest
// of this app's Sheets access relies on (OBS browser sources run
// headless). Restricted in Google Cloud Console to just the Sheets API,
// and only ever works against a spreadsheet shared as "Anyone with the
// link can view" -- it can't write, and can't read anything not already
// public.
export const sheetsApiKeyAtom = atomWithStorage<string | null>(
  "ddrtools.event.sheetsapikey",
  null,
  undefined,
  { getOnInit: true },
);

const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

// Just the shape this file actually calls (Google Identity Services'
// token client) -- not the full GIS API surface, which would need
// installing a types package for the rest of it we don't use.
declare global {
  interface Window {
    google: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token: string }) => void;
          }): { requestAccessToken(): void };
        };
      };
    };
  }
}

export function requestSheetsToken(
  clientId: string,
  onToken: (token: string) => void,
) {
  const tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (response: { access_token: string }) => {
      onToken(response.access_token);
    },
  });
  tokenClient.requestAccessToken();
}

export class SheetsAuthError extends Error {}

// Thrown instead of the generic "Sheets read failed" Error when the
// spreadsheet simply doesn't have a tab named `range` -- Google's own
// 400 body for this ({"error":{"message":"Unable to parse range: X"}})
// read as an opaque JSON dump to an operator ("Sheets read failed: 400
// {...}"), not an actionable message, even though the actual problem
// (missing tab, easy to fix by adding one) is common and easy to name
// plainly.
export class SheetsRangeError extends Error {
  constructor(public range: string) {
    super(`This spreadsheet has no "${range}" tab.`);
  }
}

export async function readSheetValues(
  token: string,
  spreadsheetId: string,
  range = "Pools",
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new SheetsAuthError("Token expired");
  }
  if (res.status === 400) {
    const body = await res.text();
    if (body.includes("Unable to parse range")) {
      throw new SheetsRangeError(range);
    }
    throw new Error(`Sheets read failed: ${res.status} ${body}`);
  }
  if (!res.ok) {
    throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.values || [];
}

export async function appendRowsToSheet(
  token: string,
  spreadsheetId: string,
  rows: string[][],
) {
  const range = "Pools!A1";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });
  if (res.status === 401) {
    throw new SheetsAuthError("Token expired");
  }
  if (!res.ok) {
    throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
export interface CellColor {
  r: number;
  g: number;
  b: number;
}

/** Shared by the Matches tab and the pool-results OBS overlay so a pool's
 * header bar renders the same color in both places -- see readColumnBColors
 * (OAuth) and sheets-public-read.ts's fetchPublicColumnBColors (API key)
 * for where the color data itself comes from. */
export function colorToCss(c: CellColor | null | undefined): string {
  if (!c) return "#f5f5f5";
  const darken = 0.8;
  const r = Math.round(c.r * 255 * darken);
  const g = Math.round(c.g * 255 * darken);
  const b = Math.round(c.b * 255 * darken);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Reads one or more ranges' cell colors in a SINGLE Sheets API request --
 * same multi-range `ranges=` combining as sheets-public-read.ts's
 * fetchPublicCellColors (see its own comment for the full rationale/quota
 * reasoning), just OAuth-authenticated. Replaces the old one-range-per-
 * call `readColumnBColors`, which dashboard.tsx's Matches tab called
 * twice per poll (once for header colors, once for Final Ranking colors)
 * -- a real, avoidable contributor to hitting Google's per-minute Sheets
 * API read quota (see [[project_sheets_api_rate_limit]]). */
export async function readCellColors(
  token: string,
  spreadsheetId: string,
  ranges: string[],
): Promise<(CellColor | null)[][]> {
  const fields = "sheets.data.rowData.values.effectiveFormat.backgroundColor";
  const rangesParam = ranges
    .map((r) => `ranges=${encodeURIComponent(r)}`)
    .join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?${rangesParam}&fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new SheetsAuthError("Token expired");
  }
  if (!res.ok) {
    throw new Error(
      `Sheets color read failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = await res.json();
  // `sheets[0].data[i]` -- the i-th requested range's own rowData, NOT
  // `sheets[i]` (see fetchPublicCellColors's identical comment).
  const perRange: { rowData?: SheetsRowData[] }[] = data.sheets?.[0]?.data || [];
  return ranges.map((_, i) => {
    const rowData: SheetsRowData[] = perRange[i]?.rowData || [];
    return rowData.map((r) => {
      const bg = r.values?.[0]?.effectiveFormat?.backgroundColor;
      if (!bg) return null;
      // `?? 0`, not `?? 1` -- see fetchPublicCellColors's identical fix
      // (sheets-public-read.ts) for the full explanation: the Sheets API
      // omits a color channel from its JSON when that channel is exactly
      // 0, not when it's "unspecified, default to white." A pure red or
      // pure green cell was silently coming back as white under the old
      // `?? 1` fallback.
      return { r: bg.red ?? 0, g: bg.green ?? 0, b: bg.blue ?? 0 };
    });
  });
}

// Just the fields actually read above -- not the full Sheets API
// RowData shape.
interface SheetsRowData {
  values?: {
    effectiveFormat?: {
      backgroundColor?: { red?: number; green?: number; blue?: number };
    };
  }[];
}
export async function batchUpdateValues(
  token: string,
  spreadsheetId: string,
  data: { range: string; values: string[][] }[],
) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (res.status === 401) {
    throw new SheetsAuthError("Token expired");
  }
  if (!res.ok) {
    throw new Error(
      `Sheets batch update failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}
