import { fromBase64Url, toBase64Url } from "../utils/base64url";

/**
 * Packs the start.gg API key into one opaque query-param value instead
 * of leaving it as a plain, immediately-readable `apiKey` param in an
 * OBS Browser Source URL -- same "not real security, just not casually
 * recognizable at a glance" reasoning as sheets-connection-param.ts's
 * own encodeSheetsConnection (see that file's own doc for what this
 * does and doesn't protect against). A separate encoder, not a reuse of
 * that one: its own shape is a Sheets-specific apiKey+spreadsheetId
 * pair, while this credential is a single value for a different API.
 */
export function encodeStartggConnection(apiKey: string): string {
  return toBase64Url(btoa(apiKey));
}

/** Tolerates a missing/malformed/hand-edited value by returning null
 * rather than throwing, same "just show the missing-params Callout"
 * behavior sheets-connection-param.ts's own decoder has. */
export function decodeStartggConnection(encoded: string | null): string | null {
  if (!encoded) return null;
  try {
    return atob(fromBase64Url(encoded)) || null;
  } catch {
    return null;
  }
}
