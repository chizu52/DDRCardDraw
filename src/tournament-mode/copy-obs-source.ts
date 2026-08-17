import { copyPlainTextToClipboard } from "../utils/share";
import { encodeSheetsConnection } from "../sheets/sheets-connection-param";
import { encodeStartggConnection } from "../startgg-gql/startgg-connection-param";

export const routableGlobalSourcePath = (labelId: string) =>
  `../obs-globals/${labelId}`;

export const routableCabSourcePath = (cabId: string, sourceName: string) =>
  `cab/${cabId}/source/${sourceName}`;

// This URL is stable/room-wide -- unlike the credentials below, which pool
// is showing and how it's displayed are room-synced state (event.
// selectedPool/overlayRowColors, set from the Matches tab), not URL
// params, so switching pools live never means copying a new URL into OBS.
// apiKey/spreadsheetId still ARE embedded directly here
// (read from this device's saved settings by the caller) rather than
// relying on the overlay page sharing localStorage with this one -- an
// OBS browser source is a separate, isolated browser profile, so it
// wouldn't see values saved here anyway. See pool-results.tsx. Packed
// into one opaque `src` param via encodeSheetsConnection rather than
// left as separate, immediately-readable `apiKey`/`spreadsheetId`
// params -- explicit user request, see that module's own doc for what
// this does and doesn't protect against.
export const routablePoolResultsPath = (
  apiKey: string,
  spreadsheetId: string,
) =>
  `../pool-results?${new URLSearchParams({ src: encodeSheetsConnection({ apiKey, spreadsheetId }) }).toString()}`;

// Same stable-URL, room-synced-content pattern as routablePoolResultsPath
// above -- which day to show is event.selectedScheduleDay, switched live
// from the Settings tab's radio buttons, not baked into the URL. One
// overlay source total, not three. See schedule.tsx.
export const routableSchedulePath = () => `../schedule`;

// Same URL-embedded-credentials pattern as routablePoolResultsPath for
// the Sheets side (`src`) -- unlike that overlay though, there's no
// room-synced "which pool" selector for the pools diagram itself, it
// always shows every pool in the sheet at once. This one overlay now
// covers the start.gg bracket tree too (event.gauntletPoolsShowsBracket
// picks which of the two actually shows, room-synced, not part of this
// URL) -- `startggApiKey` is optional since an operator may only ever
// use the pools half and never save one; when present it's packed the
// same opaque way (encodeStartggConnection) bracket-tree.tsx's own,
// now-retired standalone route used to pack it. See gauntlet-pools.tsx.
export const routableGauntletPoolsPath = (
  apiKey: string,
  spreadsheetId: string,
  startggApiKey?: string,
) => {
  const params = new URLSearchParams({
    src: encodeSheetsConnection({ apiKey, spreadsheetId }),
  });
  if (startggApiKey) {
    params.set("bracketSrc", encodeStartggConnection(startggApiKey));
  }
  return `../gauntlet-pools?${params.toString()}`;
};

export function copyObsSource(href: string) {
  void copyPlainTextToClipboard(href, "Copied OBS source URL to clipboard");
}
