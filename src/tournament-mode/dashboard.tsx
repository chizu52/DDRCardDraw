import {
  AnchorButton,
  Button,
  ButtonGroup,
  Callout,
  Card,
  CardList,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Divider,
  FormGroup,
  H3,
  H4,
  HTMLSelect,
  InputGroup,
  NumericInput,
  Radio,
  RadioGroup,
  Tab,
  Tabs,
  Tag,
} from "@blueprintjs/core";
import { TimePicker } from "@blueprintjs/datetime";
import {
  Add,
  ArrowRight,
  Clipboard,
  Duplicate,
  Edit,
  EyeOff,
  EyeOn,
  Export,
  FloppyDisk,
  Import,
  LogIn,
  Refresh,
  Trash,
} from "@blueprintjs/icons";
import { css } from "@codemirror/lang-css";
import ReactCodeMirror from "@uiw/react-codemirror";
import { useAtom, useAtomValue } from "jotai";
import { nanoid } from "nanoid";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useHref } from "react-router-dom";
import {
  colorToCss,
  googleClientIdAtom,
  readCellColors,
  readSheetValues,
  requestSheetsToken,
  sheetsApiKeyAtom,
  sheetsTokenAtom,
  spreadsheetIdAtom,
  SheetsAuthError,
  CellColor,
  batchUpdateValues,
} from "../sheets/sheets-export";
import {
  parsePoolsFromRows,
  parsePendingRows,
  mergePendingIntoPool,
  ParsedSheet,
  colIndexToLetter,
  sumScores,
  topScoreRanks,
  finalRankingStatusByName,
  formatSongScore,
} from "../sheets/parse-pools";
import { RowColorTiers, rowColorForRank } from "../sheets/row-colors";
import { startggKeyAtom, useStartggPhases } from "../startgg-gql";
import {
  DEFAULT_SCHEDULE_STATUS,
  eventSlice,
  type ScheduleDay,
  type ScheduleItem,
  type ScheduleStatusState,
} from "../state/event.slice";
import { useAppDispatch, useAppState } from "../state/store";
import { useTheme } from "../theme-toggle";
import {
  copyObsSource,
  routableBracketTreePath,
  routableGauntletPoolsPath,
  routableGlobalSourcePath,
  routablePoolResultsPath,
  routableSchedulePath,
} from "./copy-obs-source";
import styles from "./dashboard.css";
import { iconLabel, localIcons } from "../obs-sources/local-icons";

// Score Scope (the Python CV score reader) runs a small local HTTP
// server so this button can trigger a fresh capture before importing,
// instead of importing whatever Pending happened to already contain.
// Only reachable if that app is running on the same machine as the
// browser -- if it's not, we fall back to importing existing Pending
// data as-is (see triggerCvCapture's null case).
const CV_READER_TRIGGER_URL = "http://localhost:8765/capture";
const CV_READER_TRIGGER_TIMEOUT_MS = 35000;

// The "Pending" tab is a single fixed 4-row staging block, not a
// per-pool reserved range -- confirmed directly against the live sheet:
// header on row 1, then exactly 4 data rows (2-5), Seed/Pool always
// blank, reused/overwritten by whatever was captured most recently.
// start_row is where Score Scope should start writing captured songs --
// see its src/read_scores.py: "column 0 writes to start_row, column 1
// writes to start_row + 1", so this points at the Pending tab's first
// data row, not anything pool-specific (there's no per-pool block to
// point at -- pool.rows[*].rowIndex belongs to the *Pools* tab, a
// completely different row numbering, and would be wrong here).
const PENDING_START_ROW = 2;

interface CvCaptureResult {
  ok: boolean;
  reason?: string;
  written?: number;
  dry_run?: boolean;
  archived?: number;
}

/** Returns null if the CV reader isn't running/reachable -- that's not an
 * error, just means we import whatever Pending already has. `pool` is
 * passed through so the CV reader can archive uncropped per-player source
 * screenshots under Matches/<pool>/ -- purely for building up reference
 * material, it has no effect on which sheet rows get written to.
 * start_row (PENDING_START_ROW) is what actually does: without it, Score
 * Scope reads and logs scores but doesn't know where to write them, so
 * it skips writing to the sheet entirely. */
async function triggerCvCapture(pool: string): Promise<CvCaptureResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CV_READER_TRIGGER_TIMEOUT_MS,
  );
  try {
    const res = await fetch(CV_READER_TRIGGER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool, start_row: PENDING_START_ROW }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return (await res.json()) as CvCaptureResult;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function describeCaptureResult(result: CvCaptureResult | null): string {
  if (result === null) {
    return "CV reader isn't running -- imported existing Pending data.";
  }
  const archivedNote = result.archived
    ? ` Archived ${result.archived} source screenshot(s).`
    : "";
  if (!result.ok) {
    return `CV reader capture failed (${result.reason ?? "unknown error"}) -- imported existing Pending data.${archivedNote}`;
  }
  if (result.dry_run) {
    return `CV reader captured in dry-run mode (nothing new written) -- imported existing Pending data.${archivedNote}`;
  }
  return `CV reader captured fresh scores (${result.written ?? 0} cell(s) written) before importing.${archivedNote}`;
}

type DashboardTabId = "obs-text-sources" | "matches" | "matches-settings";

export function Dashboard() {
  const [currentTab, setCurrentTab] =
    useState<DashboardTabId>("obs-text-sources");

  return (
    <div className={styles.container}>
      <Tabs
        id="dashboard"
        size="large"
        selectedTabId={currentTab}
        onChange={(newTabId: DashboardTabId) => setCurrentTab(newTabId)}
      >
        <Tab id="obs-text-sources" panel={<ObsTextSources />}>
          OBS Text Sources
        </Tab>
        <Tab id="matches" panel={<MatchesImportPanel />}>
          Pool Results
        </Tab>
        <Tab id="matches-settings" panel={<MatchesSettingsPanel />}>
          Settings
        </Tab>
      </Tabs>
    </div>
  );
}

interface ExportStatus {
  type: "success" | "danger";
  message: string;
}

function MatchesImportPanel() {
  // useAtom (not useAtomValue) -- this tab now also WRITES sheetsTokenAtom
  // itself (see reconnectGoogle below), not just reads it.
  const [token, setToken] = useAtom(sheetsTokenAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  // Only needed to actually request a fresh token (see reconnectGoogle
  // below) -- SheetsCredsManager's own "Connected -- reconnect" button
  // already does exactly this, but living on a separate settings page
  // means an operator hitting "Session expired." mid-event (see the
  // SheetsAuthError catches below) has to navigate away from the very
  // panel that just told them something's wrong to fix it. Explicit user
  // request: a reconnect action right here instead.
  const googleClientId = useAtomValue(googleClientIdAtom);
  const reconnectGoogle = useCallback(() => {
    if (!googleClientId) return;
    requestSheetsToken(googleClientId, setToken);
  }, [googleClientId, setToken]);
  const dispatch = useAppDispatch();
  // Same room-synced settings the pool-results OBS overlay uses (see
  // event.slice.ts) -- applied here too so this table and the overlay are
  // a 1:1 match rather than two designs that can drift apart.
  const rowColors = useAppState((s) => s.event.overlayRowColors);
  const rowColorTiers = useAppState((s) => s.event.overlayRowColorTiers);
  const selectedPool = useAppState((s) => s.event.selectedPool);
  // Which pools currently show "Upcoming" on the gauntlet-pools overlay
  // -- see event.slice.ts's own doc on gauntletPoolsUpcoming for why
  // this is opt-in now rather than that overlay's own automatic default.
  const upcomingPools = useAppState((s) => s.event.gauntletPoolsUpcoming);
  const [sheet, setSheet] = useState<ParsedSheet>({ pools: [] });
  const [colors, setColors] = useState<(CellColor | null)[]>([]);
  // Final Ranking column's own cell colors -- same automatic,
  // color-driven advancement gauntlet-pools.tsx uses (see
  // finalRankingStatusByName), rather than a manually configured count.
  const [rankingColors, setRankingColors] = useState<(CellColor | null)[]>(
    [],
  );
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importingPool, setImportingPool] = useState<string | null>(null);

  const loadPools = useCallback(async () => {
    if (!token || !spreadsheetId) return;
    try {
      const rows = await readSheetValues(token, spreadsheetId);
      const parsed = parsePoolsFromRows(rows);
      setSheet(parsed);
      // Header (column B) and Final Ranking colors combined into ONE
      // multi-range request now (readCellColors) instead of two separate
      // ones -- same fix as gauntlet-pools.tsx/pool-results.tsx, see
      // readCellColors' own comment for the full quota-reduction
      // rationale. Both ranges are known right after parsing (the Final
      // Ranking column comes from the SAME parse), so there's no reason
      // left to keep them as separate requests. Wrapped in its own catch
      // so a color-fetch hiccup degrades to "no header tint, advancement
      // unknown" rather than failing this whole load.
      const finalRankingCol = parsed.pools.find(
        (p) => p.finalRankingCol !== null,
      )?.finalRankingCol;
      const colorRanges = ["Pools!B:B"];
      if (finalRankingCol != null) {
        colorRanges.push(
          `Pools!${colIndexToLetter(finalRankingCol)}:${colIndexToLetter(finalRankingCol)}`,
        );
      }
      const [cellColors, rankColors] = await readCellColors(
        token,
        spreadsheetId,
        colorRanges,
      ).catch(() => colorRanges.map(() => [] as (CellColor | null)[]));
      setColors(cellColors ?? []);
      setRankingColors(rankColors ?? []);
      setStatus(null);
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        setStatus({ type: "danger", message: "Session expired." });
        return;
      }
      setStatus({
        type: "danger",
        message: err instanceof Error ? err.message : "Read failed.",
      });
    }
  }, [token, spreadsheetId]);

  useEffect(() => {
    // loadPools already catches its own errors internally (sets `status`
    // on failure, never rejects) -- void makes the intentional fire-and-
    // forget explicit rather than leaving an unhandled-looking promise.
    void loadPools();
  }, [loadPools]);

  const importPoolFromPending = async (
    poolIdx: number,
    pool: ParsedSheet["pools"][number],
  ) => {
    if (!token || !spreadsheetId) return;
    setImportingPool(pool.title);
    try {
      const captureResult = await triggerCvCapture(pool.title);
      const captureNote = describeCaptureResult(captureResult);

      const rows = await readSheetValues(token, spreadsheetId, "Pending");
      const pending = parsePendingRows(rows);
      const { pool: mergedPool, mergedCount } = mergePendingIntoPool(
        pool,
        pending,
      );

      setSheet((prev) => ({
        pools: prev.pools.map((p, pi) => (pi === poolIdx ? mergedPool : p)),
      }));

      if (!pending.length) {
        setStatus({
          type: "danger",
          message: `Pending tab has no rows with any scores filled in. ${captureNote}`,
        });
      } else {
        setStatus({
          type: "success",
          message: `Merged ${mergedCount} row(s) from Pending into ${pool.title}, in order. ${captureNote}`,
        });
      }
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        setStatus({ type: "danger", message: "Session expired." });
        return;
      }
      setStatus({
        type: "danger",
        message: err instanceof Error ? err.message : "Import failed.",
      });
    } finally {
      setImportingPool(null);
    }
  };

  const updateCell = (
    poolIdx: number,
    rowIdx: number,
    field: number,
    value: string,
  ) => {
    setSheet((prev) => {
      const pools = prev.pools.map((p, pi) => {
        if (pi !== poolIdx) return p;
        const rows = p.rows.map((r, ri) => {
          if (ri !== rowIdx) return r;
          const songs = r.songs.slice();
          songs[field] = value;
          return { ...r, songs };
        });
        return { ...p, rows };
      });
      return { pools };
    });
  };

  const exportPool = async (pool: ParsedSheet["pools"][number]) => {
    if (!token || !spreadsheetId) return;
    setExporting(pool.title);
    try {
      const data = pool.rows.map((row) => {
        const firstCol = pool.songCols[0] ?? 2;
        const lastCol = pool.songCols[pool.songCols.length - 1] ?? firstCol;
        const range = `Pools!${colIndexToLetter(firstCol)}${row.rowIndex + 1}:${colIndexToLetter(lastCol)}${row.rowIndex + 1}`;
        return { range, values: [[...row.songs]] };
      });
      // Exporting IS the operator's own "this pool is done" signal now --
      // explicit user request: no separate manual Finished toggle, no
      // completeness check, just TRUE every time Export runs (same sheet
      // cell/mechanism the old manual checkbox used to write to -- see
      // the Checkbox's own comment below for why it's a read-only
      // indicator now). Folded into the same batchUpdateValues call as
      // the scores themselves rather than a second request -- one write,
      // not two round trips to Sheets. Only writable if this sheet
      // actually has a Finished column and the pool has a first row to
      // anchor it to, same guard the old toggleFinished had.
      if (pool.finishedCol !== null && pool.rows.length) {
        data.push({
          range: `Pools!${colIndexToLetter(pool.finishedCol)}${pool.rows[0].rowIndex + 1}`,
          values: [["TRUE"]],
        });
      }
      await batchUpdateValues(token, spreadsheetId, data);
      setSheet((prev) => ({
        pools: prev.pools.map((p) =>
          p.title === pool.title ? { ...p, finished: true } : p,
        ),
      }));
      setStatus({ type: "success", message: `${pool.title} exported.` });
      // The overlay polls Sheets on a long fallback interval (see
      // pool-results.tsx) -- this makes it refetch immediately instead of
      // waiting on that timer, so an exported score shows on stream right
      // away.
      dispatch(eventSlice.actions.signalPoolsRefresh());
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        setStatus({ type: "danger", message: "Session expired." });
      } else {
        setStatus({
          type: "danger",
          message: err instanceof Error ? err.message : "Export failed.",
        });
      }
    } finally {
      setExporting(null);
    }
  };

  return (
    <section style={{ maxWidth: "800px" }}>
      <h1
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        Pools
        <ButtonGroup>
          {/* Reconnect the Google account itself (a fresh OAuth token),
              distinct from the plain data-refresh button beside it --
              see reconnectGoogle's own comment above for why this lives
              here instead of only on the separate Settings page. Always
              visible/actionable (not just once a "Session expired." error
              has already appeared), same "don't make the operator wait
              for it to break" idea as this whole button existing at all. */}
          <Button
            icon={<LogIn />}
            minimal
            disabled={!googleClientId}
            title={
              googleClientId
                ? "Reconnect Google account"
                : "Save a Google OAuth client ID in Google Sheets settings first (see the Sheets connection panel)"
            }
            onClick={reconnectGoogle}
          />
          <Button
            icon={<Refresh />}
            minimal
            title="Refresh pools"
            onClick={loadPools}
          />
        </ButtonGroup>
      </h1>
      {status && (
        <Callout intent={status.type} style={{ marginBottom: "1rem" }}>
          {status.message}
        </Callout>
      )}
      {!token || !spreadsheetId ? (
        <p>Connect Google Sheets first to see matches here.</p>
      ) : (
        <>
          {sheet.pools.map((pool, poolIdx) => (
            <div
              key={pool.title}
              style={{
                marginBottom: "1.25rem",
                border: "1px solid var(--pt-divider-black, #d8d8d8)",
                borderRadius: "6px",
                overflow: "hidden",
                boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
              }}
            >
              <div
                style={{
                  padding: "8px 14px",
                  backgroundColor: colorToCss(colors[pool.headerRowIndex]),
                  borderBottom: "1px solid var(--pt-divider-black, #d8d8d8)",
                  fontWeight: 600,
                  fontSize: "1.05em",
                  color: "black",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px" }}
                >
                  {pool.title}
                  {/* A plain Tag now, not a Checkbox -- explicit user
                      request to remove EVERY interactive affordance, not
                      just the click handler. A disabled Checkbox still
                      renders as a form control (hover/focus states,
                      checkbox-shaped indicator) even with nothing wired
                      to it; a Tag has no interactive semantics at all
                      unless one is explicitly added, so there's nothing
                      left to remove. Same intent-color meaning the old
                      custom checkbox CSS gave it (red = not finished,
                      green = finished), and the same "Final"/"Live"-style
                      Tag pool-results.tsx's own overlay already uses for
                      this exact status, just labeled for the editing
                      context here ("In - Progress," not "Live"). */}
                  <Tag round intent={pool.finished ? "success" : "danger"}>
                    {pool.finished ? "Finished" : "In - Progress"}
                  </Tag>
                  {/* Explicit user request: the gauntlet-pools overlay's
                      "Upcoming" pill used to be that overlay's own
                      automatic default for every not-finished,
                      not-currently-selected pool, which meant literally
                      every pool nobody's watching yet showed it -- not
                      useful signal. Now it's opt-in per pool, this
                      checkbox being the opt-in. Disabled once Finished
                      or already Live (Show on Overlay) -- poolStatus
                      checks those first, so this checkbox genuinely has
                      no effect in either case; disabling it says so
                      instead of letting it look like a live control. */}
                  <Checkbox
                    inline
                    style={{ margin: 0 }}
                    label="Upcoming"
                    checked={!!upcomingPools[pool.title]}
                    disabled={pool.finished || selectedPool === pool.title}
                    onChange={(e) =>
                      dispatch(
                        eventSlice.actions.setPoolUpcoming({
                          title: pool.title,
                          upcoming: e.currentTarget.checked,
                        }),
                      )
                    }
                  />
                </div>
                <ButtonGroup>
                  <Button
                    small
                    icon={<Import />}
                    loading={importingPool === pool.title}
                    onClick={() => importPoolFromPending(poolIdx, pool)}
                  >
                    Capture
                  </Button>
                  <Button
                    small
                    icon={<Export />}
                    loading={exporting === pool.title}
                    onClick={() => exportPool(pool)}
                  >
                    Export
                  </Button>
                  <Button
                    small
                    icon={selectedPool === pool.title ? <EyeOn /> : <EyeOff />}
                    intent={selectedPool === pool.title ? "success" : undefined}
                    title={
                      selectedPool === pool.title
                        ? "Stop showing this pool on the OBS overlay"
                        : "Show this pool on the OBS overlay"
                    }
                    // A real toggle now -- explicit user request: clicking
                    // this while it's already the active pool turns it
                    // OFF (null) instead of just re-setting the same
                    // value. Previously one-directional (always set to
                    // THIS pool, no way to clear it from here at all
                    // short of picking a different pool).
                    onClick={() =>
                      dispatch(
                        eventSlice.actions.setSelectedPool(
                          selectedPool === pool.title ? null : pool.title,
                        ),
                      )
                    }
                  >
                    {selectedPool === pool.title
                      ? "Showing on Overlay"
                      : "Show on Overlay"}
                  </Button>
                  <Button
                    small
                    icon={<Refresh />}
                    title="Push this pool's current Sheets data to the overlay right now, without waiting for its poll interval"
                    onClick={() =>
                      dispatch(eventSlice.actions.signalPoolsRefresh())
                    }
                  />
                </ButtonGroup>
              </div>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.9em",
                  tableLayout: "fixed",
                }}
              >
                {/* Fixed, content-independent column widths -- without
                    table-layout: fixed, a plain HTML table recomputes
                    every column's width from its widest current content
                    on every render. The Player column only grows an
                    advance-arrow Tag once a pool goes from Live to
                    Final, so that recompute alone was enough to visibly
                    reflow every other column at that moment. Same
                    percentages as the pool-results overlay's table, for
                    a 1:1 match. */}
                <colgroup>
                  <col style={{ width: "26%" }} />
                  {Array.from({ length: pool.songCount }).map((_, i) => (
                    <col key={i} style={{ width: `${60 / pool.songCount}%` }} />
                  ))}
                  <col style={{ width: "14%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={thStyle}>Player</th>
                    {Array.from({ length: pool.songCount }).map((_, i) => (
                      <th key={i} style={thStyle}>
                        Song {i + 1}
                      </th>
                    ))}
                    <th style={{ ...thStyle, borderRight: "none" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const topRanks = pool.finished
                      ? topScoreRanks(pool)
                      : new Map<number, number>();
                    // Same name-keyed lookup gauntlet-pools.tsx/
                    // pool-results.tsx use, same finished gate (see
                    // finalRankingStatusByName's own doc) -- automatic,
                    // color-driven advancement instead of a manually
                    // configured count, so this table stays a true 1:1
                    // match with the overlay.
                    const statusByName = pool.finished
                      ? finalRankingStatusByName(pool, rankingColors)
                      : new Map<string, "advancing" | "eliminated">();
                    return pool.rows.map((row, rowIdx) => {
                      const rank = topRanks.get(rowIdx);
                      const tierColor = rowColors
                        ? rowColorForRank(rank, rowColorTiers)
                        : null;
                      const backgroundColor =
                        tierColor ??
                        (rowIdx % 2 === 0
                          ? "transparent"
                          : "rgba(143,153,168,0.08)");
                      const advances =
                        statusByName.get(row.player.trim().toLowerCase()) ===
                        "advancing";
                      return (
                        <tr key={rowIdx} style={{ backgroundColor }}>
                          <td style={{ ...tdStyle, fontWeight: 500 }}>
                            <div style={playerCellStyle}>
                              <span style={playerNameStyle}>{row.player}</span>
                              {advances && (
                                <Tag
                                  minimal
                                  intent="success"
                                  icon={<ArrowRight size={12} />}
                                />
                              )}
                            </div>
                          </td>
                          {row.songs.map((s, j) => (
                            <td key={j} style={tdStyle}>
                              {/* onChange keeps the raw typed text --
                                  reformatting on every keystroke would
                                  fight anyone actually typing a value
                                  (an early "9" instantly becoming
                                  "9.0000%" mid-keystroke). onBlur is
                                  where this "reflects the number format"
                                  -- snaps to the same 0.0000% shape
                                  pool-results.tsx displays once the cell
                                  isn't actively being edited, and updates
                                  the real underlying value (not just what's
                                  shown), so exportPool below writes the
                                  normalized form back to the sheet too. */}
                              <input
                                value={s}
                                onChange={(e) =>
                                  updateCell(poolIdx, rowIdx, j, e.target.value)
                                }
                                onBlur={(e) =>
                                  updateCell(
                                    poolIdx,
                                    rowIdx,
                                    j,
                                    formatSongScore(e.target.value),
                                  )
                                }
                                style={inputStyle}
                              />
                            </td>
                          ))}
                          <td
                            style={{
                              ...tdStyle,
                              borderRight: "none",
                              fontWeight: 700,
                            }}
                          >
                            {sumScores(row.songs)}
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          ))}
          {!sheet.pools.length && <p>No pools found in column B yet.</p>}
        </>
      )}
    </section>
  );
}

/** Controls how the pool-results OBS overlay (see obs-sources/
 * pool-results.tsx) displays -- its own tab next to Matches since these
 * are event-wide preferences, not tied to any one pool, connecting to
 * Sheets, or the Matches tab's own table (which always shows every
 * row/rank as-is regardless of these settings). Room-synced (event.
 * overlayRowColors, see event.slice.ts) rather than device-local, and
 * rather than baked into a URL -- changing them here updates every
 * connected overlay live, with nothing to re-copy. Advancement itself
 * (who gets the arrow tag) isn't a setting here anymore -- it reads
 * straight from the sheet's own Final Ranking color, same automatic
 * logic gauntlet-pools.tsx uses, so there's no count to configure. */
function MatchesSettingsPanel() {
  const rowColors = useAppState((s) => s.event.overlayRowColors);
  const rowColorTiers = useAppState((s) => s.event.overlayRowColorTiers);
  const dispatch = useAppDispatch();

  return (
    // Each overlay's settings live in its own elevated Card -- previously
    // this was one flat scrolling section with Pool Results unboxed and
    // Bracket/Schedule only set apart by a thin top border, which made it
    // hard to tell at a glance where one overlay's settings ended and the
    // next began. A consistent card boundary + gap between them (rather
    // than each section styling its own divider differently) is what
    // actually reads as "three separate things," not just three headings.
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {/* Groups the three bracket/pool-progress overlays -- explicit user
          request -- separately from ScheduleSettingsSection below, which
          stays outside this wrapper (a different kind of overlay, event
          timing rather than tournament progress). elevation={0}, lower
          than the elevation={1} cards nested inside, so this reads as a
          flatter grouping box the other three visually sit on top of,
          rather than competing with them. */}
      <Card elevation={0} className={styles.tournamentOverlaysGroup}>
        <h2>Tournament Overlays</h2>
        <div
          style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}
        >
          <Card elevation={1} className={styles.settingsSection}>
            {/* Same minimal-icon-in-the-heading treatment as the other two
                settings sections below -- see BracketSettingsSection's own
                comment on this. Icon sits right next to the heading text
                (small gap, no space-between) rather than pushed out to the
                card's far edge. */}
            <h3
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              Pool Results Overlay
              <CopyOverlayUrlButton />
            </h3>
            <Checkbox
              checked={rowColors}
              label="Colored Placements upon Finalization"
              onChange={(e) =>
                dispatch(
                  eventSlice.actions.setOverlayRowColors(
                    e.currentTarget.checked,
                  ),
                )
              }
            />
            <div style={{ marginLeft: "1.5rem", marginTop: "-0.25rem" }}>
              <RowColorTierCheckbox
                tier="first"
                label="1st place (gold)"
                tiers={rowColorTiers}
                disabled={!rowColors}
              />
              <RowColorTierCheckbox
                tier="second"
                label="2nd place (silver)"
                tiers={rowColorTiers}
                disabled={!rowColors}
              />
              <RowColorTierCheckbox
                tier="third"
                label="3rd place (bronze)"
                tiers={rowColorTiers}
                disabled={!rowColors}
              />
              <RowColorTierCheckbox
                tier="fourthPlus"
                label="4th place and below (gray)"
                tiers={rowColorTiers}
                disabled={!rowColors}
              />
            </div>
          </Card>
          <GauntletPoolsSettingsSection />
          <BracketSettingsSection />
        </div>
      </Card>
      <ScheduleSettingsSection />
    </div>
  );
}

/** Controls for the Gauntlet Pools diagram OBS overlay (see
 * obs-sources/gauntlet-pools.tsx) -- reads the same "Pools" sheet tab
 * Pool Results does, so it needs the same Sheets credentials. Unlike
 * the other three sections, there's no room-synced SELECTOR here
 * (which pool to show, which day, which phase) because this overlay
 * always renders every pool in the sheet at once, not one thing at a
 * time -- but it does have its own title/icon, same idea as Schedule's
 * own header (see ScheduleSettingsSection), reusing the exact same
 * bundled-icon-or-custom-upload picker rather than a second one-off. */
function GauntletPoolsSettingsSection() {
  const dispatch = useAppDispatch();

  // Same bundled-icon-dropdown-with-a-Custom-upload-option pattern as
  // ScheduleSettingsSection's own icon picker -- see its comments for
  // why each piece here works the way it does (the generic
  // ICON_CUSTOM_VALUE/readIconFile helpers above are shared by both).
  const gauntletPoolsIcon = useAppState((s) => s.event.gauntletPoolsIcon);
  const iconFileInputRef = useRef<HTMLInputElement>(null);
  const selectedIconValue = !gauntletPoolsIcon
    ? ""
    : (localIcons.find((icon) => icon.url === gauntletPoolsIcon)?.url ??
      ICON_CUSTOM_VALUE);
  async function handleIconFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await readIconFile(file);
      dispatch(eventSlice.actions.setGauntletPoolsIcon(dataUrl));
    } catch {
      // A corrupt/unreadable file just means no icon change goes out.
    }
  }
  function handleIconSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (value === ICON_CUSTOM_VALUE) {
      iconFileInputRef.current?.click();
      return;
    }
    dispatch(eventSlice.actions.setGauntletPoolsIcon(value || null));
  }

  // Same buffer-locally-then-Save pattern as ScheduleSettingsSection's
  // own subtitle field -- see its comment for why `dirty` is an
  // explicit flag rather than a derived `title !== savedTitle` check.
  const savedTitle = useAppState((s) => s.event.gauntletPoolsTitle);
  const [title, setTitle] = useState(savedTitle);
  const [titleDirty, setTitleDirty] = useState(false);
  useEffect(() => {
    if (!titleDirty) {
      // eslint-disable-next-line react-hooks-js/set-state-in-effect
      setTitle(savedTitle);
    }
  }, [savedTitle, titleDirty]);

  return (
    <Card elevation={1} className={styles.settingsSection}>
      {/* Same minimal-icon-in-the-heading treatment as the other three
          settings sections -- see BracketSettingsSection's own comment
          on this. */}
      <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        Gauntlet Pools Overlay
        <CopyGauntletPoolsUrlButton />
      </h3>
      {/* Same "immediately live" tint as ScheduleSettingsSection's own
          liveControls group -- a title/icon change here goes straight
          to the overlay's header bar the moment it's saved/picked,
          same as that group's own fields do. */}
      <div className={styles.liveControls}>
        <FormGroup label="Overlay title">
          <InputGroup
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleDirty(true);
            }}
            placeholder="Gauntlet Pools"
            rightElement={
              <Button
                disabled={!titleDirty}
                intent={titleDirty ? "primary" : undefined}
                onClick={() => {
                  dispatch(eventSlice.actions.setGauntletPoolsTitle(title));
                  setTitleDirty(false);
                }}
              >
                Save
              </Button>
            }
          />
        </FormGroup>
        <FormGroup label="Icon">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {gauntletPoolsIcon && (
              <img
                src={gauntletPoolsIcon}
                alt=""
                style={{
                  width: 32,
                  height: 32,
                  objectFit: "contain",
                  borderRadius: 4,
                  background: "rgba(255, 255, 255, 0.06)",
                }}
              />
            )}
            <HTMLSelect
              value={selectedIconValue}
              onChange={handleIconSelectChange}
            >
              <option value="">None</option>
              {localIcons.map((icon) => (
                <option key={icon.url} value={icon.url}>
                  {iconLabel(icon)}
                </option>
              ))}
              <option value={ICON_CUSTOM_VALUE}>Custom…</option>
            </HTMLSelect>
            <input
              ref={iconFileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                void handleIconFileChange(e);
              }}
            />
          </div>
        </FormGroup>
      </div>
      <Divider style={{ margin: "1rem 0" }} />
      <GauntletPoolsDividerEditor />
    </Card>
  );
}

function GauntletPoolsDividerEditor() {
  const dispatch = useAppDispatch();
  const savedDividers = useAppState((s) => s.event.gauntletPoolsDividers);
  const [dividers, setDividers] = useState<DividerRow[]>(savedDividers);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) {
      // eslint-disable-next-line react-hooks-js/set-state-in-effect
      setDividers(savedDividers);
    }
  }, [savedDividers, dirty]);

  function updateRow(index: number, patch: Partial<DividerRow>) {
    setDividers((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setDirty(true);
  }

  function addRow() {
    setDividers((prev) => [...prev, emptyDividerRow()]);
    setDirty(true);
  }

  function removeRow(index: number) {
    setDividers((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function submit() {
    dispatch(eventSlice.actions.setGauntletPoolsDividers(dividers));
    setDirty(false);
  }

  return (
    <FormGroup label="Dividers">
      {dividers.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginBottom: "0.75rem",
          }}
        >
          {dividers.map((row, i) => (
            <div
              key={row.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <span style={{ whiteSpace: "nowrap" }}>Before Pool #</span>
              <NumericInput
                value={row.beforeSetNumber}
                min={1}
                clampValueOnBlur
                buttonPosition="none"
                style={{ width: "70px" }}
                onValueChange={(n, valueAsString) => {
                  if (valueAsString !== "") {
                    updateRow(i, { beforeSetNumber: n });
                  }
                }}
              />
              <InputGroup
                placeholder="Label, e.g. Day 2"
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                style={{ flex: 1 }}
              />
              <Button icon={<Trash />} minimal onClick={() => removeRow(i)} />
            </div>
          ))}
        </div>
      )}
      <ButtonGroup>
        <Button icon={<Add />} onClick={addRow}>
          Add divider
        </Button>
        <Button
          disabled={!dirty}
          intent={dirty ? "primary" : undefined}
          onClick={submit}
        >
          Submit
        </Button>
      </ButtonGroup>
    </FormGroup>
  );
}

interface DividerRow {
  id: string;
  beforeSetNumber: number;
  label: string;
}

function emptyDividerRow(): DividerRow {
  return { id: nanoid(5), beforeSetNumber: 1, label: "" };
}


/** Same URL-embedded-Sheets-credentials pattern as Pool Results' own
 * CopyOverlayUrlButton above (see its comment) -- this overlay reads
 * the exact same "Pools" tab, so it's gated on the same credentials. */
function CopyGauntletPoolsUrlButton() {
  const apiKey = useAtomValue(sheetsApiKeyAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  const ready = !!apiKey && !!spreadsheetId;
  const href = useHref(
    routableGauntletPoolsPath(apiKey || "", spreadsheetId || ""),
  );
  return (
    <Button
      icon={<Clipboard />}
      minimal
      disabled={!ready}
      title={
        ready
          ? "Copy Gauntlet Pools overlay URL"
          : "Save a Sheets API key in Google Sheets settings first (see the Sheets connection panel)"
      }
      onClick={() => copyObsSource(new URL(href, document.location.href).href)}
    />
  );
}

/** Controls for the bracket-tree OBS overlay (see
 * obs-sources/bracket-tree.tsx) -- which start.gg phase it shows is
 * room-synced state (event.selectedBracketPhase), same "pick it here,
 * not a new OBS URL" pattern as the pool-results overlay's pool
 * selection. Phase list reuses the same GauntletDivisions query the
 * Matches tab's own start.gg picker already depends on
 * (useStartggPhases, in startgg-gql/index.ts) -- no new query for that
 * part. */
function BracketSettingsSection() {
  const dispatch = useAppDispatch();
  const selectedPhase = useAppState((s) => s.event.selectedBracketPhase);
  const [phasesResult] = useStartggPhases();
  const phases = phasesResult.data?.event?.phases || [];
  const startggApiKey = useAtomValue(startggKeyAtom);
  const ready = !!startggApiKey;
  const href = useHref(routableBracketTreePath(startggApiKey || ""));

  return (
    <Card elevation={1} className={styles.settingsSection}>
      {/* minimal, icon-only Refresh + copy-URL right next to the heading
          text itself -- same treatment as the Pool Results tab's own
          "Pools" heading (see its Button minimal above), rather than
          labeled buttons lost among the other controls below. */}
      <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        Start.gg Bracket Tree
        <div style={{ display: "flex", gap: "0.25rem" }}>
          <Button
            icon={<Refresh />}
            minimal
            title="Refresh bracket data"
            onClick={() => dispatch(eventSlice.actions.signalBracketRefresh())}
          />
          <Button
            icon={<Clipboard />}
            minimal
            disabled={!ready}
            title={
              ready
                ? "Copy bracket overlay URL"
                : "Save a start.gg API key first (see the start.gg connection panel)"
            }
            onClick={() =>
              copyObsSource(new URL(href, document.location.href).href)
            }
          />
        </div>
      </h3>
      <FormGroup label="Bracket to display" inline>
        <HTMLSelect
          value={selectedPhase ?? ""}
          onChange={(e) =>
            dispatch(
              eventSlice.actions.setSelectedBracketPhase(
                e.currentTarget.value || null,
              ),
            )
          }
        >
          <option value="">None selected</option>
          {phases.map((phase) => (
            <option key={phase?.id} value={phase?.id ?? undefined}>
              {phase?.name}
            </option>
          ))}
        </HTMLSelect>
      </FormGroup>
    </Card>
  );
}

function emptyScheduleItem(): ScheduleItem {
  return { time: "", event: "", description: "" };
}

// See ScheduleDayEditor's savedSchedule for why this needs to be a
// stable module-level reference, not an inline `[]`.
const EMPTY_SCHEDULE: ScheduleItem[] = [];

// Schedule times are wall-clock, as typed by the user (e.g. "20:30" for
// 8:30 PM) -- stored and rendered as-is, no timezone conversion (see
// ScheduleItem's own doc in event.slice.ts).
function parseScheduleTime(time: string | undefined): Date | null {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function formatScheduleTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const SCHEDULE_DAYS: { id: ScheduleDay; label: string }[] = [
  { id: "fri", label: "Friday" },
  { id: "sat", label: "Saturday" },
  { id: "sun", label: "Sunday" },
];

// The dropdown's last option -- distinct from every real icon's own URL
// value, used both as that option's <option value> and as the signal
// (in the select's onChange) to open the file picker instead of
// dispatching directly. Shared by every overlay's own icon picker
// (Schedule, Gauntlet Pools) -- not schedule-specific despite the name
// this used to have, same as the rest of the icon-picking machinery
// below it.
const ICON_CUSTOM_VALUE = "__custom__";
const ICON_MAX_SIZE = 160;

/** Reads a user-picked image file, downscaling it (never upscaling) to
 * ICON_MAX_SIZE on its longer edge. This is going to be stored as a data
 * URL directly in room-synced Redux state and re-sent over the party
 * socket to every connected client on every change -- there's no
 * server-side upload/asset host for this app to save an actual file to
 * -- so an un-resized multi-MB phone photo would be a real, repeated
 * cost rather than a one-time one. Shared by every overlay's own icon
 * picker, not schedule-specific -- nothing about this depends on
 * schedule's own data shape. */
function readIconFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        const scale = Math.min(
          1,
          ICON_MAX_SIZE / Math.max(img.width, img.height),
        );
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** Controls for the schedule OBS overlay (see obs-sources/schedule.tsx)
 * -- one stable overlay URL, which day it currently shows is room-synced
 * state (event.selectedScheduleDay) picked here via radio buttons, same
 * live-picker idea as BracketSettingsSection's phase dropdown above (just
 * radios instead of a dropdown, since there are only ever three options).
 * The day TABS below are a separate concern -- editing each day's own
 * content, independent of which one is currently live on stream. */
function ScheduleSettingsSection() {
  const dispatch = useAppDispatch();
  const selectedDay = useAppState((s) => s.event.selectedScheduleDay);
  // "Manual" (default) leaves current/completed exactly as set below in
  // each day's own editor; "Automatic" derives them live from the real
  // clock instead (see event.slice.ts's own doc on scheduleMode) --
  // manual mode's own controls are untouched either way, this only
  // decides whether the overlay actually reads them.
  const scheduleMode = useAppState((s) => s.event.scheduleMode);
  const href = useHref(routableSchedulePath());
  const [currentDay, setCurrentDay] = useState<ScheduleDay>("fri");

  // Picked from a dropdown of bundled files (see local-icons.ts) by
  // default, with a last "Custom..." option that opens the file picker
  // instead -- applies immediately either way, same "deliberate one-shot
  // action" reasoning as the day radios above.
  const scheduleIcon = useAppState((s) => s.event.scheduleIcon);
  const iconFileInputRef = useRef<HTMLInputElement>(null);
  // The select's own controlled value -- a bundled icon's URL if
  // scheduleIcon matches one, "" for no icon, or else (a data URL from
  // an earlier custom upload doesn't match any bundled icon's URL) the
  // custom sentinel, so the dropdown correctly shows "Custom..." as
  // selected rather than nothing matching.
  const selectedIconValue = !scheduleIcon
    ? ""
    : (localIcons.find((icon) => icon.url === scheduleIcon)?.url ??
      ICON_CUSTOM_VALUE);
  async function handleIconFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so choosing the SAME file again later still fires onChange
    // -- the input's own value otherwise doesn't change, so no event
    // would fire the second time.
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await readIconFile(file);
      dispatch(eventSlice.actions.setScheduleIcon(dataUrl));
    } catch {
      // A corrupt/unreadable file just means no icon change goes out --
      // nothing else on this form depends on the read succeeding.
    }
  }
  function handleIconSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (value === ICON_CUSTOM_VALUE) {
      // Don't dispatch anything yet -- if the operator cancels the file
      // dialog, scheduleIcon (and so this select's own controlled value)
      // just stays whatever it already was, snapping the dropdown back
      // to its real selection rather than getting stuck showing
      // "Custom..." with nothing actually picked.
      iconFileInputRef.current?.click();
      return;
    }
    dispatch(eventSlice.actions.setScheduleIcon(value || null));
  }

  // Global to the whole overlay, not per-day (see event.slice.ts's own
  // doc on scheduleSubtitle) -- one field here, not one per Tab below.
  const savedSubtitle = useAppState((s) => s.event.scheduleSubtitle);
  const [subtitle, setSubtitle] = useState(savedSubtitle);
  // Explicit flag, not `subtitle !== savedSubtitle` -- see
  // ScheduleDayEditor's own `dirty` state for why a derived comparison
  // is the wrong check (confirmed as a real bug there: it can't tell
  // "user is editing" apart from "this component hasn't caught up to a
  // savedSubtitle it's never seen before," which look identical but
  // need opposite handling).
  const [subtitleDirty, setSubtitleDirty] = useState(false);
  // Same resync-while-not-dirty pattern as ScheduleDayEditor's own
  // savedSchedule effect below -- picks up an external change (another
  // device, or this device's own save echoing back through the party
  // socket) without clobbering an unsaved edit still in progress. Not
  // the "derive state from props" antipattern set-state-in-effect
  // normally warns about -- savedSubtitle is a genuinely external,
  // independently-changing source (room-synced Redux state, not a
  // prop/state this component owns), and the dirty guard is exactly the
  // part a plain render-time derivation can't express.
  useEffect(() => {
    if (!subtitleDirty) {
      // eslint-disable-next-line react-hooks-js/set-state-in-effect
      setSubtitle(savedSubtitle);
    }
  }, [savedSubtitle, subtitleDirty]);

  return (
    <Card
      elevation={1}
      className={`${styles.settingsSection} ${styles.scheduleSettingsSection}`}
    >
      {/* Same minimal-icon-in-the-heading treatment as the other two
          settings sections above -- see BracketSettingsSection's own
          comment on this. */}
      <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        Schedule Overlay
        <Button
          icon={<Clipboard />}
          minimal
          title="Copy schedule overlay URL"
          onClick={() =>
            copyObsSource(new URL(href, document.location.href).href)
          }
        />
      </h3>
      {/* Grouped and tinted specifically because "Day to display" below
          is a room-synced radio group that immediately changes what's
          live on stream -- functionally unrelated to, but visually
          almost identical to (same 3 day names, same order), the Tabs
          strip further down that just picks which day's content THIS
          editor is showing. Stacked directly on top of each other with
          no distinction, those read as one confusing double day-picker;
          the tint marks this whole group as the one that actually
          broadcasts immediately, so the tabs below default to reading
          as the (inert until Submit) editing surface. */}
      <div className={styles.liveControls}>
        <FormGroup label="Schedule title">
          <InputGroup
            value={subtitle}
            onChange={(e) => {
              setSubtitle(e.target.value);
              setSubtitleDirty(true);
            }}
            placeholder="Schedule Title"
            rightElement={
              <Button
                disabled={!subtitleDirty}
                intent={subtitleDirty ? "primary" : undefined}
                onClick={() => {
                  dispatch(eventSlice.actions.setScheduleSubtitle(subtitle));
                  setSubtitleDirty(false);
                }}
              >
                Save
              </Button>
            }
          />
        </FormGroup>
        <FormGroup label="Icon">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {scheduleIcon && (
              <img
                src={scheduleIcon}
                alt=""
                style={{
                  width: 32,
                  height: 32,
                  objectFit: "contain",
                  borderRadius: 4,
                  background: "rgba(255, 255, 255, 0.06)",
                }}
              />
            )}
            <HTMLSelect
              value={selectedIconValue}
              onChange={handleIconSelectChange}
            >
              <option value="">None</option>
              {localIcons.map((icon) => (
                <option key={icon.url} value={icon.url}>
                  {iconLabel(icon)}
                </option>
              ))}
              <option value={ICON_CUSTOM_VALUE}>Custom…</option>
            </HTMLSelect>
            {/* Hidden -- only ever opened programmatically, by picking
                "Custom..." above (handleIconSelectChange). */}
            <input
              ref={iconFileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                void handleIconFileChange(e);
              }}
            />
          </div>
        </FormGroup>
        <RadioGroup
          label="Day to display"
          inline
          selectedValue={selectedDay ?? ""}
          onChange={(e) =>
            dispatch(
              eventSlice.actions.setSelectedScheduleDay(
                (e.currentTarget.value || null) as ScheduleDay | null,
              ),
            )
          }
          options={[
            { label: "None", value: "" },
            ...SCHEDULE_DAYS.map(({ id, label }) => ({ label, value: id })),
          ]}
        />
        {/* Explicit user request: a way to switch the whole overlay
            between the original manual current/completed control (each
            day's own editor below, untouched) and automatic mode, which
            derives them live from the clock instead -- see
            event.slice.ts's own doc on scheduleMode and schedule.tsx's
            visibleRows for how automatic mode actually works. */}
        <RadioGroup
          label="Scheduling mode"
          inline
          selectedValue={scheduleMode}
          onChange={(e) =>
            dispatch(
              eventSlice.actions.setScheduleMode(
                e.currentTarget.value as "manual" | "automatic",
              ),
            )
          }
          options={[
            { label: "Manual", value: "manual" },
            { label: "Automatic", value: "automatic" },
          ]}
        />
      </div>
      <Divider style={{ margin: "1rem 0 0.75rem" }} />
      <div className={styles.scheduleEditorLabel}>Edit a schedule</div>
      {/* animate={false} -- unlike the outer "dashboard" Tabs (which stays
          mounted for the whole session, so its indicator only slides when
          you actually switch tabs), this whole section unmounts every time
          you leave the Settings tab and remounts fresh -- always back on
          "fri" -- the next time you click into it. Left animated, the
          indicator replayed its grow-in-from-nothing mount transition on
          every single visit to Settings, not just real day-to-day
          switches, which read as an unwanted flourish rather than a
          deliberate move. */}
      <Tabs
        id="schedule-days"
        animate={false}
        selectedTabId={currentDay}
        onChange={(newDay: ScheduleDay) => setCurrentDay(newDay)}
      >
        {SCHEDULE_DAYS.map(({ id, label }) => (
          <Tab
            key={id}
            id={id}
            title={label}
            panel={<ScheduleDayEditor day={id} />}
          />
        ))}
      </Tabs>
    </Card>
  );
}

function ScheduleDayEditor({ day }: { day: ScheduleDay }) {
  const dispatch = useAppDispatch();
  // EMPTY_SCHEDULE, not an inline `?? []` -- a fresh array literal on
  // every selector call is a NEW reference every time even when a day
  // has no saved items (the common case for a new event), which
  // react-redux's default reference-equality check reads as "changed"
  // on every single dispatch. Combined with the resync effect below
  // (which depends on this value), that was a real, confirmed infinite
  // loop ("Maximum update depth exceeded") the moment this tab was
  // opened on a day with nothing saved yet -- not a hypothetical
  // concern, this actually happened. A stable reference for the empty
  // case fixes it.
  const savedSchedule = useAppState(
    (s) => s.event.schedules[day] ?? EMPTY_SCHEDULE,
  );
  // Per-day (like savedSchedule above), staged/submitted alongside this
  // day's own rows via the same dirty flag and Submit button below --
  // moved here (out of the always-live "Day to display" controls above)
  // so a status change goes out deliberately, reviewed together with
  // whatever row edits are also pending, rather than the instant the
  // operator touches the radio.
  const savedStatus = useAppState(
    (s) => s.event.scheduleStatus[day] ?? DEFAULT_SCHEDULE_STATUS,
  );
  const [schedule, setSchedule] = useState<ScheduleItem[]>(savedSchedule);
  const [status, setStatus] = useState(savedStatus);
  // An explicit flag the user's own edits set, NOT a derived comparison
  // of schedule vs savedSchedule -- comparing values conflates "the user
  // is actively editing, don't clobber it" with "this component just
  // hasn't caught up to a savedSchedule it's never seen before," which
  // look identical (local != saved) but need opposite handling. That
  // second case is real, not hypothetical: confirmed directly -- an
  // external update (another operator's submit, arriving while this
  // editor's local buffer was still sitting at its initial empty
  // default) got permanently stuck showing 0 rows, because that empty
  // default already "differed" from the incoming saved value the moment
  // it arrived, so the old isDirty-by-comparison guard treated it as
  // an in-progress edit worth protecting and never synced at all.
  const [dirty, setDirty] = useState(false);

  // Re-sync to the room-synced value whenever it changes from elsewhere
  // (another operator's dashboard, or this device's own submit echoing
  // back through the party socket) -- but only while nothing unsaved is
  // in progress locally. Without the dirty guard, an incoming update
  // mid-edit would silently overwrite whatever the user was still
  // typing; without the effect at all (the bug this is fixing, confirmed
  // against the original PR this was ported from), an external update
  // never shows up here until the tab is reloaded. Not the "derive
  // state from props" antipattern set-state-in-effect normally warns
  // about -- same reasoning as ScheduleSettingsSection's own subtitle
  // effect above.
  useEffect(() => {
    if (!dirty) {
      // eslint-disable-next-line react-hooks-js/set-state-in-effect
      setSchedule(savedSchedule);
      setStatus(savedStatus);
    }
  }, [savedSchedule, savedStatus, dirty]);

  function updateRow(index: number, patch: Partial<ScheduleItem>) {
    setSchedule((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setDirty(true);
  }

  // Radio semantics -- clearing every OTHER row's own `current` flag is
  // what actually enforces "at most one," not just this row's own
  // checked state. A native radio input's built-in mutual exclusivity
  // only affects which one LOOKS checked in the DOM; these are
  // controlled by `schedule` state, so the state itself has to be the
  // one source of truth or the previously-current row would silently
  // stay `current: true` in the data even once visually unchecked.
  // `index: null` clears every row's `current` flag -- passed when the
  // ALREADY-current row's own radio is clicked again, since a native
  // radio has no built-in way to deselect back to "nothing selected"
  // (clicking the same option again is normally a no-op).
  function setCurrentRow(index: number | null) {
    setSchedule((prev) =>
      prev.map((row, i) => ({ ...row, current: i === index })),
    );
    setDirty(true);
  }

  function addRow() {
    setSchedule((prev) => [...prev, emptyScheduleItem()]);
    setDirty(true);
  }

  function removeRow(index: number) {
    setSchedule((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function submit() {
    dispatch(eventSlice.actions.setDaySchedule({ day, items: schedule }));
    dispatch(eventSlice.actions.setScheduleStatus({ day, ...status }));
    setDirty(false);
  }

  function sortByTime() {
    setSchedule((prev) =>
      [...prev].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")),
    );
    setDirty(true);
  }

  return (
    <>
      {/* Global status (see savedStatus's own comment above), staged
          here alongside this day's rows -- same dirty flag, same Submit
          button below sends both together. FormGroup below is NOT
          `inline` -- RadioGroup always stacks its label above its
          options, so giving Minutes the same shape (label above input)
          is what makes the two blocks comparable in the first place.
          `alignItems: "flex-start"` on the row then lines "Schedule
          status" up with "Minutes"; the 14.5px marginTop on the
          FormGroup below separately re-centers *its own* label+input
          pair on the radio row specifically (not on the taller
          RadioGroup block as a whole) -- measured against the rendered
          radio row's own height, which doesn't move independently of
          this, so it isn't expected to drift; re-measure and adjust
          this number if the radio row's own font-size/line-height ever
          changes. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem" }}>
        <RadioGroup
          label="Schedule status"
          inline
          selectedValue={status.state}
          onChange={(e) => {
            setStatus((prev) => ({
              ...prev,
              state: e.currentTarget.value as ScheduleStatusState,
            }));
            setDirty(true);
          }}
          options={[
            { label: "Ahead of Schedule", value: "ahead" },
            { label: "On Time", value: "onTime" },
            { label: "Delayed", value: "delayed" },
          ]}
        />
        <FormGroup label="Minutes" style={{ marginTop: "14.5px" }}>
          <NumericInput
            value={status.minutes}
            min={0}
            clampValueOnBlur
            onValueChange={(n) => {
              setStatus((prev) => ({
                ...prev,
                minutes: Number.isFinite(n) ? Math.round(n) : 0,
              }));
              setDirty(true);
            }}
            style={{ width: "70px" }}
          />
        </FormGroup>
      </div>
      <Divider style={{ margin: "1rem 0" }} />
      {/* Horizontally scrollable, not just "let it overflow" -- the
          TimePicker's own up/down-arrow buttons give it a wide, rigid
          intrinsic width that a plain browser table-layout treats as
          fixed, then starves whatever's left (Event/Description, both
          flexible text inputs) down to a sliver instead of ever growing
          the table past its container. Explicit minWidths on those two
          inputs below force the table to actually need the extra space
          rather than silently accepting near-zero. */}
      <div style={{ overflowX: "auto" }}>
        <table className={styles.scheduleTable}>
          <thead>
            <tr>
              <th>Color</th>
              <th>Time</th>
              <th>Event</th>
              <th>Description</th>
              <th>Current</th>
              <th>Completed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((row, i) => (
              <tr key={i}>
                <td>
                  {/* Native color input, not a Blueprint component --
                    Blueprint doesn't ship one, and the browser's own
                    picker already gives a proper hex swatch UI + value
                    for free. Empty string (not a real color) shows as
                    the browser's own default black/gray swatch, which
                    reads fine as "unset" without needing a separate
                    clear control -- the overlay only applies a border
                    tint when row.color is actually set (see
                    obs-sources/schedule.tsx). */}
                  <input
                    type="color"
                    value={row.color ?? "#000000"}
                    onChange={(e) => updateRow(i, { color: e.target.value })}
                    style={{
                      width: 32,
                      height: 32,
                      padding: 0,
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                    }}
                  />
                </td>
                <td style={{ minWidth: 160 }}>
                  <TimePicker
                    precision="minute"
                    showArrowButtons
                    useAmPm
                    value={parseScheduleTime(row.time)}
                    onChange={(newTime) =>
                      updateRow(i, { time: formatScheduleTime(newTime) })
                    }
                  />
                </td>
                <td>
                  <InputGroup
                    style={{ minWidth: 220 }}
                    value={row.event ?? ""}
                    onChange={(e) => updateRow(i, { event: e.target.value })}
                  />
                </td>
                <td>
                  <InputGroup
                    style={{ minWidth: 320 }}
                    value={row.description ?? ""}
                    onChange={(e) =>
                      updateRow(i, { description: e.target.value })
                    }
                  />
                </td>
                <td>
                  {/* A completed row can't also be current -- the overlay
                    itself already assumes this can't happen ("completed
                    wins over current," schedule.tsx), but nothing here
                    previously actually enforced it. Disabling instead of
                    just hiding keeps the column's shape stable
                    (no layout shift row-to-row) and makes it visibly
                    clear why it can't be picked, rather than silently
                    doing nothing on click. */}
                  <Radio
                    name={`schedule-current-${day}`}
                    checked={!!row.current}
                    disabled={!!row.completed}
                    // Both onClick AND onChange, calling the same logic --
                    // confirmed directly that a native radio's `change`
                    // event doesn't fire when clicking one that's already
                    // checked (its own checked state isn't changing), so
                    // onClick is what actually catches the deselect click.
                    // onChange stays too, just to satisfy React's "checked
                    // prop needs an onChange handler" warning on a
                    // controlled input -- for a normal select-a-different-
                    // row click, both fire and both compute the same
                    // result, which is harmless.
                    onClick={() => setCurrentRow(row.current ? null : i)}
                    onChange={() => setCurrentRow(row.current ? null : i)}
                  />
                </td>
                <td>
                  <Checkbox
                    checked={!!row.completed}
                    onChange={(e) => {
                      const completed = e.currentTarget.checked;
                      // Closes the same gap from the other direction --
                      // marking an already-current row completed has to
                      // clear `current` too, or the disallowed combination
                      // still happens via this path even with the radio
                      // itself now disabled.
                      updateRow(i, {
                        completed,
                        current: completed ? false : row.current,
                      });
                    }}
                  />
                </td>
                <td>
                  <Button icon={<Trash />} onClick={() => removeRow(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ButtonGroup className={styles.scheduleAddRow}>
        <Button icon={<Add />} onClick={addRow}>
          Add row
        </Button>
        <Button disabled={schedule.length < 2} onClick={sortByTime}>
          Sort by time
        </Button>
        <Button
          disabled={!dirty}
          intent={dirty ? "primary" : undefined}
          onClick={submit}
        >
          Submit
        </Button>
      </ButtonGroup>
    </>
  );
}

function RowColorTierCheckbox(props: {
  tier: keyof RowColorTiers;
  label: string;
  tiers: RowColorTiers;
  disabled: boolean;
}) {
  const dispatch = useAppDispatch();
  return (
    <Checkbox
      checked={props.tiers[props.tier]}
      disabled={props.disabled}
      label={props.label}
      onChange={(e) =>
        dispatch(
          eventSlice.actions.setOverlayRowColorTier({
            tier: props.tier,
            enabled: e.currentTarget.checked,
          }),
        )
      }
    />
  );
}

/** Copies the stable, room-wide URL for the pool-results broadcast overlay
 * (see obs-sources/pool-results.tsx) -- read-only, reads the Sheets API
 * key + spreadsheet ID from this device's saved settings and bakes them
 * directly into the copied URL (no separate setup needed inside OBS's own
 * browser profile), but NOT which pool to show or how -- that's
 * room-synced state set from the Matches tab's "Show on Overlay" buttons
 * and the settings above, so this URL only ever needs to be copied into
 * OBS once, even as the event moves through different pools. Requires
 * both a Sheets API key to be saved (see SheetsCredsManager) and the
 * spreadsheet's sharing to be "Anyone with the link can view" -- the
 * overlay page itself shows a clear error if either is missing. */
function CopyOverlayUrlButton() {
  const apiKey = useAtomValue(sheetsApiKeyAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  const ready = !!apiKey && !!spreadsheetId;
  const href = useHref(
    routablePoolResultsPath(apiKey || "", spreadsheetId || ""),
  );
  return (
    <Button
      icon={<Clipboard />}
      minimal
      disabled={!ready}
      title={
        ready
          ? "Copy pool results overlay URL"
          : "Save a Sheets API key in Google Sheets settings first (see the Sheets connection panel)"
      }
      onClick={() => copyObsSource(new URL(href, document.location.href).href)}
    />
  );
}

// Same as pool-results.tsx's playerCellStyle/playerNameStyle -- keeps the
// player name and the advance-arrow Tag on the same line regardless of
// column width (flex row, no wrap), truncating a long name with an
// ellipsis instead of overflowing its now-fixed-width column. minWidth: 0
// overrides a flex item's default min-width: auto, which otherwise stops
// it shrinking below its own content size and silently defeats
// text-overflow: ellipsis inside a flex container.
const playerCellStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const playerNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: "0.8em",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: "var(--pt-text-color-muted, #5c7080)",
  borderBottom: "1px solid var(--pt-divider-black, #d8d8d8)",
  borderRight: "1px solid var(--pt-divider-black, #e8e8e8)",
};

const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRight: "1px solid var(--pt-divider-black, #eee)",
  borderBottom: "1px solid var(--pt-divider-black, #f2f2f2)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "transparent",
  padding: "4px",
  fontSize: "inherit",
  fontFamily: "inherit",
};

function ObsTextSources() {
  const [currentEdit, setCurrentEdit] = useState<string | null>(null);
  const labels = useAppState((s) => s.event.obsLabels);

  return (
    <>
      <section style={{ maxWidth: "600px" }}>
        <EditDialog sourceId={currentEdit} close={() => setCurrentEdit(null)} />
        <H3>
          OBS Text Sources{" "}
          <Button
            icon={<Add />}
            onClick={() => setCurrentEdit(nanoid())}
          ></Button>
        </H3>
        <CardList>
          {Object.entries(labels).map(([id, { label, value }]) => (
            <LabelCard
              key={id}
              id={id}
              label={label}
              value={value}
              onEdit={() => setCurrentEdit(id)}
            />
          ))}
        </CardList>
      </section>
      <CssEditor />
    </>
  );
}

function LabelCard(props: {
  id: string;
  label: string;
  value: string;
  onEdit(this: void): void;
}) {
  const href = useHref(routableGlobalSourcePath(props.id));
  return (
    <Card className={styles.textSourceCard}>
      <div>
        <p>{props.label}</p>
        <H4>{props.value}</H4>
      </div>
      <ButtonGroup>
        <Button icon={<Edit />} onClick={props.onEdit} />
        <AnchorButton
          icon={<Duplicate />}
          onClick={(e) => {
            e.preventDefault();
            copyObsSource(new URL(href, document.location.href).href);
          }}
          href={href}
        />
      </ButtonGroup>
    </Card>
  );
}

function EditDialog({
  sourceId,
  close,
}: {
  sourceId: string | null;
  close(this: void): void;
}) {
  const label = useAppState((s) =>
    sourceId ? s.event.obsLabels[sourceId] : null,
  ) || { label: "", value: "" };
  const dispatch = useAppDispatch();
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  if (!label || !sourceId) {
    return null;
  }
  const submit = () => {
    dispatch(
      eventSlice.actions.updateLabel({
        id: sourceId,
        label: nameInput.current?.value || "",
        value: valueInput.current?.value || "",
      }),
    );
    close();
  };
  const handleInputKeydown: React.KeyboardEventHandler<HTMLInputElement> = (
    e,
  ) => {
    if (
      e.key === "Enter" &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.metaKey
    ) {
      submit();
    }
  };
  return (
    <Dialog isOpen={!!sourceId} title="Edit Custom OBS label" onClose={close}>
      <DialogBody>
        <form action={submit}>
          <FormGroup label="Label Name">
            <InputGroup
              inputRef={nameInput}
              defaultValue={label.label}
              onKeyDown={handleInputKeydown}
            />
          </FormGroup>
          <FormGroup label="Value">
            <InputGroup
              inputRef={valueInput}
              defaultValue={label.value}
              onKeyDown={handleInputKeydown}
            />
          </FormGroup>
        </form>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button intent="primary" onClick={submit}>
              Save
            </Button>
          </>
        }
      />
    </Dialog>
  );
}

function CssEditor() {
  const cleanDoc = useAppState((s) => s.event.obsCss);
  const [isDirty, setIsDirty] = useState(false);
  const [localDoc, setLocalDoc] = useState(cleanDoc);
  const dispatch = useAppDispatch();
  const theme = useTheme();

  return (
    <section>
      <H3>
        Global OBS Source Styles{" "}
        <Button
          icon={<FloppyDisk />}
          disabled={!isDirty}
          intent={isDirty ? "primary" : undefined}
          onClick={() => {
            dispatch(eventSlice.actions.updateObsCss(localDoc));
            setIsDirty(false);
          }}
        />
      </H3>
      <ReactCodeMirror
        height="200"
        minHeight="5"
        theme={theme}
        value={isDirty ? localDoc : cleanDoc}
        extensions={[css()]}
        onChange={(newDoc) => {
          if (newDoc === cleanDoc) {
            setIsDirty(false);
          } else {
            setIsDirty(true);
          }
          setLocalDoc(newDoc);
        }}
      />
    </section>
  );
}
