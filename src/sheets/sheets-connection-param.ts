/**
 * Packs the public-Sheets-read credentials (see sheets-public-read.ts)
 * into ONE opaque query-param value instead of leaving `apiKey` and
 * `spreadsheetId` as separate, immediately-readable params in an OBS
 * Browser Source URL (e.g. "...?apiKey=AIzaSy...&spreadsheetId=..."). Not
 * real security -- base64 is trivially reversible by anyone who bothers,
 * so this does nothing against a deliberate attacker -- it only stops
 * the key from being casually recognizable at a glance (someone reading
 * the URL bar, a screenshot of OBS's source list, a copy-pasted URL in
 * chat). The actual mitigation for a leaked key doing real damage is
 * restricting it in Google Cloud Console (read-only, Sheets API only) --
 * this is a cheap layer on top of that, not a replacement for it.
 *
 * Deliberately only covers the PUBLIC Sheets read credentials
 * (apiKey/spreadsheetId/sheet) used by gauntlet-pools.tsx/
 * pool-results.tsx -- NOT bracket-tree.tsx's start.gg key, a different
 * credential for a different API that was never part of this ask.
 *
 * Pipe-delimited + base64url, not JSON + plain base64 (the first version
 * of this file) -- explicit user request to shorten the URL, and JSON's
 * own `"apiKey":`/`"spreadsheetId":` key names plus base64's ~33%
 * overhead actually made the URL LONGER than the two plain params it
 * replaced (160 chars vs. 105, measured against a real key+id). Dropping
 * the JSON structure entirely (a plain `|`-joined string -- safe since
 * neither a Sheets API key nor a spreadsheet ID ever contains `|`) and
 * switching standard base64's `+`/`/`/`=` to base64url's `-`/`_`/no-padding
 * (which needs no percent-encoding when placed in a query string, unlike
 * `+`/`/`/`=`) brings it down to 120 -- close to the original, and still
 * fully obscures the key. There's a hard floor here: base64('s ~33%
 * overhead on the ~85 raw bytes two real credentials need) means this
 * can't beat the original 105-char plain-params length by much without
 * actually storing the credentials somewhere (server-side, keyed by a
 * short id) instead of encoding them into the URL at all -- a bigger
 * change already discussed and deliberately not pursued.
 */

export interface SheetsConnectionParams {
  apiKey: string;
  spreadsheetId: string;
  /** Sheet tab name -- optional, callers that omit it fall back to
   * "Pools" the same way the old separate `sheet` query param did. */
  sheet?: string;
}

// btoa/atob only produce/accept standard base64 (+, /, = padding) --
// query-string-safe base64url swaps those for -, _, and drops padding
// (recoverable on decode: padding is always inferable from length).
function toBase64Url(standardB64: string): string {
  return standardB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(urlB64: string): string {
  const withSlashes = urlB64.replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - (withSlashes.length % 4)) % 4;
  return withSlashes + "=".repeat(paddingNeeded);
}

export function encodeSheetsConnection(
  params: SheetsConnectionParams,
): string {
  const raw = `${params.apiKey}|${params.spreadsheetId}|${params.sheet ?? ""}`;
  return toBase64Url(btoa(raw));
}

/** Decodes the `src` param back into its three pieces -- tolerates a
 * missing/malformed/hand-edited value by returning all-null rather than
 * throwing, same "just show the missing-params Callout" behavior the
 * overlays already have for a literally-absent apiKey/spreadsheetId. */
export function decodeSheetsConnection(encoded: string | null): {
  apiKey: string | null;
  spreadsheetId: string | null;
  sheet: string | null;
} {
  if (!encoded) return { apiKey: null, spreadsheetId: null, sheet: null };
  try {
    const [apiKey, spreadsheetId, sheet] = atob(fromBase64Url(encoded)).split(
      "|",
    );
    return {
      apiKey: apiKey || null,
      spreadsheetId: spreadsheetId || null,
      sheet: sheet || null,
    };
  } catch {
    return { apiKey: null, spreadsheetId: null, sheet: null };
  }
}
