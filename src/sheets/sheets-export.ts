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

const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

declare global {
  interface Window {
    google: any;
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

export async function readColumnBColors(
  token: string,
  spreadsheetId: string,
  range = "Pools!B:B",
): Promise<(CellColor | null)[]> {
  const fields = "sheets.data.rowData.values.effectiveFormat.backgroundColor";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new SheetsAuthError("Token expired");
  }
  if (!res.ok) {
    throw new Error(`Sheets color read failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const rowData = data.sheets?.[0]?.data?.[0]?.rowData || [];
  return rowData.map((r: any) => {
    const bg = r.values?.[0]?.effectiveFormat?.backgroundColor;
    if (!bg) return null;
    return { r: bg.red ?? 1, g: bg.green ?? 1, b: bg.blue ?? 1 };
  });
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
