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
  FormGroup,
  H3,
  H4,
  HTMLSelect,
  InputGroup,
  NumericInput,
  Tab,
  Tabs,
  Tag,
} from "@blueprintjs/core";
import {
  Add,
  ArrowRight,
  Duplicate,
  Edit,
  EyeOff,
  EyeOn,
  Export,
  FloppyDisk,
  Import,
  Refresh,
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
  readColumnBColors,
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
  ParsedPool,
  ParsedSheet,
  colIndexToLetter,
  sumScores,
  topScoreRanks,
} from "../sheets/parse-pools";
import { RowColorTiers, rowColorForRank } from "../sheets/row-colors";
import { startggKeyAtom, useStartggPhases } from "../startgg-gql";
import { eventSlice } from "../state/event.slice";
import { useAppDispatch, useAppState } from "../state/store";
import { useTheme } from "../theme-toggle";
import {
  copyObsSource,
  routableBracketTreePath,
  routableGlobalSourcePath,
  routablePoolResultsPath,
} from "./copy-obs-source";
import styles from "./dashboard.css";

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
  const [token, setToken] = useAtom(sheetsTokenAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  const clientId = useAtomValue(googleClientIdAtom);
  const dispatch = useAppDispatch();
  // Same room-synced settings the pool-results OBS overlay uses (see
  // event.slice.ts) -- applied here too so this table and the overlay are
  // a 1:1 match rather than two designs that can drift apart.
  const advanceCount = useAppState((s) => s.event.overlayAdvanceCount);
  const rowColors = useAppState((s) => s.event.overlayRowColors);
  const rowColorTiers = useAppState((s) => s.event.overlayRowColorTiers);
  const selectedPool = useAppState((s) => s.event.selectedPool);
  const [sheet, setSheet] = useState<ParsedSheet>({ pools: [] });
  const [colors, setColors] = useState<(CellColor | null)[]>([]);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importingPool, setImportingPool] = useState<string | null>(null);
  const [finishedSaving, setFinishedSaving] = useState<string | null>(null);

  const loadPools = useCallback(async () => {
    if (!token || !spreadsheetId) return;
    try {
      const rows = await readSheetValues(token, spreadsheetId);
      setSheet(parsePoolsFromRows(rows));
      const cellColors = await readColumnBColors(token, spreadsheetId);
      setColors(cellColors);
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
    loadPools();
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
      await batchUpdateValues(token, spreadsheetId, data);
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

  const toggleFinished = async (
    poolIdx: number,
    pool: ParsedSheet["pools"][number],
  ) => {
    if (!token || !spreadsheetId) return;
    // The sheet only carries this flag on the pool's first player row.
    if (pool.finishedCol === null || !pool.rows.length) return;

    const newValue = !pool.finished;
    const setFinished = (value: boolean) =>
      setSheet((prev) => ({
        pools: prev.pools.map((p, pi) =>
          pi === poolIdx ? { ...p, finished: value } : p,
        ),
      }));

    setFinished(newValue);
    setFinishedSaving(pool.title);
    try {
      const range = `Pools!${colIndexToLetter(pool.finishedCol)}${pool.rows[0].rowIndex + 1}`;
      await batchUpdateValues(token, spreadsheetId, [
        { range, values: [[newValue ? "TRUE" : "FALSE"]] },
      ]);
      await loadPools();
    } catch (err) {
      setFinished(!newValue); // revert on failure
      if (err instanceof SheetsAuthError) {
        setStatus({ type: "danger", message: "Session expired." });
      } else {
        setStatus({
          type: "danger",
          message:
            err instanceof Error
              ? err.message
              : "Failed to update Finished status.",
        });
      }
    } finally {
      setFinishedSaving(null);
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
        <Button icon={<Refresh />} minimal onClick={loadPools} />
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
                  <Checkbox
                    className={styles.finishedCheckbox}
                    checked={pool.finished}
                    label={pool.finished ? "Finished" : "In - Progress"}
                    disabled={
                      pool.finishedCol === null ||
                      !pool.rows.length ||
                      finishedSaving === pool.title
                    }
                    onChange={() => toggleFinished(poolIdx, pool)}
                    style={{
                      color: "black",
                      margin: 0,
                      fontWeight: 400,
                      fontSize: "0.85em",
                    }}
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
                    title="Show this pool on the OBS overlay"
                    onClick={() =>
                      dispatch(eventSlice.actions.setSelectedPool(pool.title))
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
                        rank !== undefined && rank <= advanceCount;
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
                              <input
                                value={s}
                                onChange={(e) =>
                                  updateCell(poolIdx, rowIdx, j, e.target.value)
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
 * overlayAdvanceCount/overlayRowColors, see event.slice.ts) rather than
 * device-local, and rather than baked into a URL -- changing them here
 * updates every connected overlay live, with nothing to re-copy. */
function MatchesSettingsPanel() {
  const advanceCount = useAppState((s) => s.event.overlayAdvanceCount);
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
      <Card elevation={1} className={styles.settingsSection}>
        <h3>Pool Results Overlay</h3>
        <FormGroup label="Advancements" inline>
          <NumericInput
            value={advanceCount}
            min={1}
            max={4}
            clampValueOnBlur
            onValueChange={(n) => {
              if (Number.isFinite(n)) {
                dispatch(
                  eventSlice.actions.setOverlayAdvanceCount(Math.round(n)),
                );
              }
            }}
            style={{ width: "60px" }}
          />
        </FormGroup>
        <Checkbox
          checked={rowColors}
          label="Colored Placements upon Finalization"
          onChange={(e) =>
            dispatch(
              eventSlice.actions.setOverlayRowColors(e.currentTarget.checked),
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
        <CopyOverlayUrlButton />
      </Card>
      <BracketSettingsSection />
    </div>
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
      <h3>Start.gg Bracket Overlay</h3>
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
      <ButtonGroup>
        <Button
          icon={<Refresh />}
          onClick={() => dispatch(eventSlice.actions.signalBracketRefresh())}
        >
          Refresh
        </Button>
        <Button
          icon={<Duplicate />}
          disabled={!ready}
          title={
            ready
              ? undefined
              : "Save a start.gg API key first (see the start.gg connection panel)"
          }
          onClick={() =>
            copyObsSource(new URL(href, document.location.href).href)
          }
        >
          Copy Overlay URL
        </Button>
      </ButtonGroup>
    </Card>
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
      icon={<Duplicate />}
      disabled={!ready}
      title={
        ready
          ? undefined
          : "Save a Sheets API key in Google Sheets settings first (see the Sheets connection panel)"
      }
      onClick={() => copyObsSource(new URL(href, document.location.href).href)}
      style={{ marginTop: "0.75rem" }}
    >
      Overlay URL
    </Button>
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
