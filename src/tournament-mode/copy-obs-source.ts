import { copyPlainTextToClipboard } from "../utils/share";
import { encodeSheetsConnection } from "../sheets/sheets-connection-param";

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

// Same stable-URL-plus-URL-embedded-credentials pattern as
// routablePoolResultsPath above -- which phase to show is room-synced
// state (event.selectedBracketPhase), only the start.gg API key comes
// from the URL. See bracket-tree.tsx.
export const routableBracketTreePath = (apiKey: string) =>
  `../bracket-tree?${new URLSearchParams({ apiKey }).toString()}`;

// Same stable-URL, room-synced-content pattern as routableBracketTreePath
// above -- which day to show is event.selectedScheduleDay, switched live
// from the Settings tab's radio buttons, not baked into the URL. One
// overlay source total, not three. See schedule.tsx.
export const routableSchedulePath = () => `../schedule`;

// Same URL-embedded-credentials pattern as routablePoolResultsPath --
// unlike that overlay though, there's no room-synced "which pool"
// selector here at all: this shows every pool in the sheet at once (the
// whole Gauntlet Pools diagram), so there's nothing to switch live in
// the first place. See gauntlet-pools.tsx. Same opaque `src` packing as
// routablePoolResultsPath above.
export const routableGauntletPoolsPath = (
  apiKey: string,
  spreadsheetId: string,
) =>
  `../gauntlet-pools?${new URLSearchParams({ src: encodeSheetsConnection({ apiKey, spreadsheetId }) }).toString()}`;

export function copyObsSource(href: string) {
  void copyPlainTextToClipboard(href, "Copied OBS source URL to clipboard");
}
