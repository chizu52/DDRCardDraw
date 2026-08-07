import { Button, Card, Classes, Spinner, Text } from "@blueprintjs/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useStartggMatches, useStartggPhases } from "./startgg-gql";
import { createAppSelector, useAppState } from "./state/store";
import { inferShortname } from "./controls/player-names";
import { Refresh } from "@blueprintjs/icons";
import { newPlayer } from "./models/Drawing";
import {
  readSheetValues,
  sheetsTokenAtom,
  spreadsheetIdAtom,
  SheetsAuthError,
} from "./sheets/sheets-export";
import { parsePoolsFromRows, ParsedSheet } from "./sheets/parse-pools";

export interface PickedMatch {
  title: string;
  players: Array<{ id: string; name: string }>;
  id: string;
  subtype: "versus" | "gauntlet";
  /** Absent for a spreadsheet-sourced pick -- there's no start.gg phase
   * behind it to name. See SheetGauntletPicker. */
  phaseName?: string;
}

// Covers both gauntlet sources (start.gg phase id, or spreadsheet pool
// title -- see SheetGauntletPicker) in one flat list, since both
// pickers below just need "has *something* already turned this into a
// drawing," regardless of which source it came from.
const associatedMatchIds = createAppSelector(
  [(s) => s.drawings.entities],
  (entities) => {
    return Object.values(entities).flatMap((drawing) => {
      if (drawing.meta.type === "startgg") return drawing.meta.id;
      if (drawing.meta.type === "sheet") return drawing.meta.id;
      return [];
    });
  },
);

export function MatchPicker(props: { onPickMatch?(match: PickedMatch): void }) {
  const [resp, refetch] = useStartggMatches();
  const existingMatches = useAppState(associatedMatchIds);
  const event = resp.data?.event;
  const matches = event?.sets?.nodes;
  const reloadButton = (
    <Button
      icon={resp.fetching ? <Spinner size={20} /> : <Refresh size={20} />}
      onClick={() => refetch({ requestPolicy: "network-only" })}
    />
  );
  if (!event) {
    return (
      <div>
        {reloadButton} startgg didn't have an event for the current slug
      </div>
    );
  }
  if (!matches) {
    if (resp.fetching) {
      return (
        <div>
          {reloadButton}
          <Card>
            <p className={Classes.SKELETON}>loading content for a match</p>
          </Card>
          <Card>
            <p className={Classes.SKELETON}>loading content for a match</p>
          </Card>
          <Card>
            <p className={Classes.SKELETON}>loading content for a match</p>
          </Card>
        </div>
      );
    } else {
      return <div>{reloadButton} startgg didn't respond matches</div>;
    }
  }
  if (!matches.length)
    return <div>{reloadButton} no un-settled matches found</div>;

  return (
    <div>
      {reloadButton}
      {matches
        .filter((m) => !!m)
        .map((match) => {
          const titlePieces: string[] = [match.fullRoundText || "???"];
          if ((match.phaseGroup?.phase?.groupCount || 0) > 1) {
            titlePieces.unshift(`Group ${match.phaseGroup?.displayIdentifier}`);
          }
          if (match.phaseGroup?.phase?.name) {
            titlePieces.unshift(match.phaseGroup.phase.name);
          }
          const title = titlePieces.join(" - ");

          const p1 = inferShortname(match.slots![0]?.entrant?.name);
          const p2 = inferShortname(match.slots![1]?.entrant?.name);
          const matchUsed = existingMatches.includes(match.id!);
          return (
            <Card
              key={match.id!}
              interactive={!matchUsed}
              style={{
                opacity: matchUsed ? 0.5 : undefined,
              }}
              compact
              onClick={
                matchUsed
                  ? undefined
                  : () =>
                      props.onPickMatch?.({
                        title,
                        players: match.slots!.map((slot) => ({
                          id: slot!.entrant!.id!,
                          name: inferShortname(slot!.entrant!.name)!,
                        })),
                        id: match.id!,
                        subtype: "versus",
                        phaseName: match.phaseGroup?.phase?.name || "",
                      })
              }
            >
              <Text tagName="p">
                <strong>{title}</strong> - {p1 || <em>TBD</em>} vs{" "}
                {p2 || <em>TBD</em>}
              </Text>
            </Card>
          );
        })}
    </div>
  );
}

export function GauntletPicker(props: {
  onPickMatch?(match: PickedMatch): void;
}) {
  const [resp, refetch] = useStartggPhases();
  const existingMatches = useAppState(associatedMatchIds);
  const event = resp.data?.event;
  const phases = event?.phases?.filter(
    (p) => p?.bracketType === "CUSTOM_SCHEDULE",
  );
  const reloadButton = (
    <Button
      icon={resp.fetching ? <Spinner size={20} /> : <Refresh size={20} />}
      onClick={() => refetch({ requestPolicy: "network-only" })}
    />
  );
  if (!event) {
    return (
      <div>
        {reloadButton} startgg didn't have an event for the current slug
      </div>
    );
  }
  if (!phases) {
    if (resp.fetching) {
      return (
        <div>
          {reloadButton}
          <Card>
            <p className={Classes.SKELETON}>loading content for a gauntlet</p>
          </Card>
          <Card>
            <p className={Classes.SKELETON}>loading content for a gauntlet</p>
          </Card>
          <Card>
            <p className={Classes.SKELETON}>loading content for a gauntlet</p>
          </Card>
        </div>
      );
    } else {
      return <div>{reloadButton} startgg didn't respond with phases</div>;
    }
  }
  if (!phases.length)
    return <div>{reloadButton} no phases with custom schedule found</div>;

  return (
    <div>
      {reloadButton}
      {phases
        .filter((p) => !!p)
        .map((phase) => {
          const title = phase.name || "???";
          const entrants =
            phase.seeds?.nodes?.flatMap((seed) => {
              if (
                !seed ||
                !seed.entrant ||
                !seed.entrant.name ||
                !seed.entrant.id
              ) {
                return [];
              }
              return {
                name: inferShortname(seed.entrant.name),
                id: seed.entrant.id,
              };
            }) || [];
          const matchUsed = existingMatches.includes(phase.id!);
          return (
            <Card
              key={phase.id!}
              interactive={!matchUsed}
              style={{
                opacity: matchUsed ? 0.5 : undefined,
              }}
              compact
              onClick={
                matchUsed
                  ? undefined
                  : () =>
                      props.onPickMatch?.({
                        title,
                        players: entrants,
                        id: phase.id!,
                        subtype: "gauntlet",
                        phaseName: phase.name || "",
                      })
              }
            >
              <Text tagName="p">
                <strong>{title}</strong> (
                {entrants.map((e) => e.name).join(", ")})
              </Text>
            </Card>
          );
        })}
    </div>
  );
}

/** Same "pick a group of players, draw a multi-way gauntlet" idea as
 * GauntletPicker above, but sourced from the same "Pools" spreadsheet
 * tab the Pool Results overlay already reads (see sheets/parse-pools.ts)
 * instead of a start.gg phase -- for formats like Gauntlet Pools that
 * start.gg has no bracket type for at all. Player ids are freshly
 * minted (newPlayer) since a sheet pool is just player-name strings,
 * nothing start.gg-derived to key off. */
export function SheetGauntletPicker(props: {
  onPickMatch?(match: PickedMatch): void;
}) {
  const token = useAtomValue(sheetsTokenAtom);
  const spreadsheetId = useAtomValue(spreadsheetIdAtom);
  const existingMatches = useAppState(associatedMatchIds);
  const [sheet, setSheet] = useState<ParsedSheet>({ pools: [] });
  const [status, setStatus] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const loadPools = useCallback(async () => {
    if (!token || !spreadsheetId) return;
    setFetching(true);
    try {
      const rows = await readSheetValues(token, spreadsheetId);
      setSheet(parsePoolsFromRows(rows));
      setStatus(null);
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        setStatus("Session expired.");
      } else {
        setStatus(err instanceof Error ? err.message : "Read failed.");
      }
    } finally {
      setFetching(false);
    }
  }, [token, spreadsheetId]);

  useEffect(() => {
    void loadPools();
  }, [loadPools]);

  const reloadButton = (
    <Button
      icon={fetching ? <Spinner size={20} /> : <Refresh size={20} />}
      onClick={() => void loadPools()}
    />
  );

  if (!token || !spreadsheetId) {
    return <div>Connect Google Sheets first to see pools here.</div>;
  }
  if (status) {
    return (
      <div>
        {reloadButton} {status}
      </div>
    );
  }
  if (!sheet.pools.length) {
    return <div>{reloadButton} no pools found in the spreadsheet</div>;
  }

  return (
    <div>
      {reloadButton}
      {sheet.pools.map((pool) => {
        const players = pool.rows.map((row) => row.player);
        const matchUsed = existingMatches.includes(pool.title);
        return (
          <Card
            key={pool.title}
            interactive={!matchUsed}
            style={{
              opacity: matchUsed ? 0.5 : undefined,
            }}
            compact
            onClick={
              matchUsed
                ? undefined
                : () =>
                    props.onPickMatch?.({
                      title: pool.title,
                      players: pool.rows.map((row) => newPlayer(row.player)),
                      id: pool.title,
                      subtype: "gauntlet",
                    })
            }
          >
            <Text tagName="p">
              <strong>{pool.title}</strong> ({players.join(", ")})
            </Text>
          </Card>
        );
      })}
    </div>
  );
}
