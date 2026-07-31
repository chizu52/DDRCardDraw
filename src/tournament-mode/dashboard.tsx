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
  InputGroup,
  Tab,
  Tabs,
} from "@blueprintjs/core";
import {
  Add,
  Duplicate,
  Edit,
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
  googleClientIdAtom,
  readColumnBColors,
  readSheetValues,
  requestSheetsToken,
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
} from "../sheets/parse-pools";
import { eventSlice } from "../state/event.slice";
import { useAppDispatch, useAppState } from "../state/store";
import { useTheme } from "../theme-toggle";
import { copyObsSource, routableGlobalSourcePath } from "./copy-obs-source";
import styles from "./dashboard.css";

// The Python CV score reader (nDDRCRcv/gui.py) runs a small local HTTP
// server so this button can trigger a fresh capture before importing,
// instead of importing whatever Pending happened to already contain.
// Only reachable if that app is running on the same machine as the
// browser -- if it's not, we fall back to importing existing Pending
// data as-is (see triggerCvCapture's null case).
const CV_READER_TRIGGER_URL = "http://localhost:8765/capture";
const CV_READER_TRIGGER_TIMEOUT_MS = 35000;

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
 * material, it has no effect on which sheet rows get written to. */
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
      body: JSON.stringify({ pool }),
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

type DashboardTabId = "obs-text-sources" | "matches";

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
          Matches
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
            err instanceof Error ? err.message : "Failed to update Finished status.",
        });
      }
    } finally {
      setFinishedSaving(null);
    }
  };

  return (
    <section style={{ maxWidth: "800px" }}>
      <H3
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        Matches
        <Button icon={<Refresh />} minimal onClick={loadPools} />
      </H3>
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
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
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
                    style={{ color: "black", margin: 0, fontWeight: 400, fontSize: "0.85em" }}
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
                </ButtonGroup>
              </div>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.9em",
                }}
              >
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
                      : new Map<number, 1 | 2>();
                    return pool.rows.map((row, rowIdx) => {
                      const rank = topRanks.get(rowIdx);
                      const backgroundColor =
                        rank === 1
                          ? "rgba(255, 215, 0, 0.25)"
                          : rank === 2
                            ? "rgba(192, 192, 192, 0.25)"
                            : rowIdx % 2 === 0
                              ? "transparent"
                              : "rgba(143,153,168,0.08)";
                      return (
                    <tr
                      key={rowIdx}
                      style={{ backgroundColor }}
                    >
                      <td style={{ ...tdStyle, fontWeight: 500 }}>
                        {row.player}
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
                        style={{ ...tdStyle, borderRight: "none", fontWeight: 700 }}
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

/** Total column is derived, not entered -- sums whatever song scores (each
 * a "DDD.DDDD%" string) are currently filled in, skipping blanks. */
function sumScores(songs: string[]): string {
  const values = songs
    .map((s) => parseFloat(s.replace("%", "")))
    .filter((n) => !Number.isNaN(n));
  if (!values.length) return "0.000%";
  const sum = values.reduce((a, b) => a + b, 0);
  return `${sum.toFixed(4)}%`;
}

/** Maps row index (into pool.rows) -> 1 for the highest total, 2 for the
 * 2nd highest, ties broken by row order. Rows with no real score yet
 * (total of 0) are never included. */
function topScoreRanks(pool: ParsedPool): Map<number, 1 | 2> {
  const ranked = pool.rows
    .map((row, idx) => ({ idx, total: parseFloat(sumScores(row.songs)) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 2);
  return new Map(ranked.map((r, i) => [r.idx, (i + 1) as 1 | 2]));
}

function colorToCss(c: CellColor | null | undefined): string {
  if (!c) return "var(--pt-app-background-color, #f5f5f5)";
  const darken = 0.8;
  const r = Math.round(c.r * 255 * darken);
  const g = Math.round(c.g * 255 * darken);
  const b = Math.round(c.b * 255 * darken);
  return `rgb(${r}, ${g}, ${b})`;
}

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
    sourceId ? s.event.obsLabels[sourceId] : null
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
      })
    );
    close();
  };
  const handleInputKeydown: React.KeyboardEventHandler<HTMLInputElement> = (
    e
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
