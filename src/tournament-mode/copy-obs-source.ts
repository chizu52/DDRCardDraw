import { copyPlainTextToClipboard } from "../utils/share";

export const routableGlobalSourcePath = (labelId: string) =>
  `../obs-globals/${labelId}`;

export const routableCabSourcePath = (cabId: string, sourceName: string) =>
  `cab/${cabId}/source/${sourceName}`;

// This URL is stable/room-wide -- unlike the credentials below, which pool
// is showing and how it's displayed are room-synced state (event.
// selectedPool/overlayAdvanceCount/overlayRowColors, set from the Matches
// tab), not URL params, so switching pools live never means copying a new
// URL into OBS. apiKey/spreadsheetId still ARE embedded directly here
// (read from this device's saved settings by the caller) rather than
// relying on the overlay page sharing localStorage with this one -- an
// OBS browser source is a separate, isolated browser profile, so it
// wouldn't see values saved here anyway. See pool-results.tsx.
export const routablePoolResultsPath = (
  apiKey: string,
  spreadsheetId: string,
) =>
  `../pool-results?${new URLSearchParams({ apiKey, spreadsheetId }).toString()}`;

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

export function copyObsSource(href: string) {
  void copyPlainTextToClipboard(href, "Copied OBS source URL to clipboard");
}
