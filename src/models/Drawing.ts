import { nanoid } from "nanoid";
import { Song } from "./SongData";

export interface EligibleChart {
  name: string;
  jacket: string;
  nameTranslation?: string;
  artist: string;
  artistTranslation?: string;
  bpm: string;
  diffAbbr: string;
  diffColor: string;
  level: number;
  granularLevel?: number;
  maxScore?: number;
  drawGroup?: number;
  flags: string[];
  extras: string[];
  cardVariant: string | undefined;
  dateAdded?: string;
  song: Song;
  folder?: string;
}

export const CHART_PLACEHOLDER = "PLACEHOLDER";

export interface PlayerPickPlaceholder {
  id: string;
  type: typeof CHART_PLACEHOLDER;
}

export const CHART_DRAWN = "DRAWN";
export interface DrawnChart extends EligibleChart {
  id: string;
  type: typeof CHART_DRAWN;
}

export interface Player {
  id: string;
  name: string;
}

/** create a new player with a freshly-generated unique id */
export function newPlayer(name: string): Player {
  return { id: nanoid(10), name };
}

export interface PlayerActionOnChart {
  /** id of the player who took the action */
  player: string;
  chartId: string;
}

export interface PocketPick extends PlayerActionOnChart {
  pick: EligibleChart;
}

interface DrawMeta {
  title: string;
  players: Player[];
}

interface StartggMeta extends DrawMeta {
  type: "startgg";
  phaseName: string;
}

export interface StartggVersusMeta extends StartggMeta {
  subtype: "versus";
  /** id of the set */
  id: string;
}

export interface StartggGauntletMeta extends StartggMeta {
  subtype: "gauntlet";
  /** id of the phase */
  id: string;
  /** first index is entrant ID, second index is the drawn chart ID */
  scoresByEntrant?: Record<string, Record<string, number | undefined>>;
}

/** A gauntlet drawn from a spreadsheet pool (see sheets/parse-pools.ts)
 * instead of a start.gg phase -- for formats like Gauntlet Pools that
 * start.gg has no bracket type for at all. Deliberately NOT nested
 * under StartggMeta/type:"startgg" -- this draw has no start.gg phase
 * or entrant ids behind it, so claiming that type would be a lie the
 * associatedMatchIds/PhaseName-style start.gg-specific code elsewhere
 * would trip on. Otherwise mirrors StartggGauntletMeta's shape (id,
 * scoresByEntrant) so the same GauntletScoreEditor works unmodified --
 * see isGauntletMeta below. */
export interface SheetGauntletMeta extends DrawMeta {
  type: "sheet";
  subtype: "gauntlet";
  /** The pool's title cell from the spreadsheet (e.g. "Pool 1", "Pool
   * L1") -- this format has no phase/set id to key off, so the pool
   * title itself is the stable identifier, filling the same role
   * StartggGauntletMeta.id (a phase id) plays for the "already drawn"
   * check in matches.tsx's associatedMatchIds. Parsed pool titles are
   * unique within a sheet by construction (parsePoolsFromRows), so
   * this is safe to use as-is. */
  id: string;
  /** Player ids here are freshly-minted (newPlayer), not start.gg
   * entrant ids -- a sheet pool's rows are just player name strings,
   * nothing to key scoresByEntrant off otherwise. */
  scoresByEntrant?: Record<string, Record<string, number | undefined>>;
}

export interface SimpleMeta extends DrawMeta {
  type: "simple";
}

/** a player's name, falling back to a positional placeholder when unnamed */
export function playerDisplayName(player: Player, index: number) {
  return player.name || `P${index + 1}`;
}

export function getAllPlayers(d: Pick<Drawing, "meta">) {
  return d.meta.players.map(playerDisplayName);
}

export function playerById(meta: Drawing["meta"], id: string) {
  return meta.players.find((p) => p.id === id);
}

/**
 * Display name for a player id. A present-but-unnamed player falls back to its
 * positional placeholder (`P1`, `P2`, …); an id matching no player yields the
 * `fallback` (empty by default).
 */
export function playerNameById(
  meta: Drawing["meta"],
  id: string,
  fallback = "",
) {
  const index = meta.players.findIndex((p) => p.id === id);
  return index === -1
    ? fallback
    : playerDisplayName(meta.players[index], index);
}

/** True for either gauntlet source (start.gg phase or spreadsheet pool)
 * -- the two meta types share subtype/id/scoresByEntrant but differ in
 * `type`, so callers that only care "is this a gauntlet, regardless of
 * where its players came from" (score-editor visibility, win-count
 * display) should use this instead of re-deriving the OR by hand at
 * each call site. `"subtype" in meta` guards SimpleMeta, which has no
 * subtype field at all. */
export function isGauntletMeta(
  meta: Drawing["meta"],
): meta is StartggGauntletMeta | SheetGauntletMeta {
  return "subtype" in meta && meta.subtype === "gauntlet";
}

/** used to reference a sub draw, or the charts in the parent draw by omitting the target */
export type CompoundSetId = [parentId: string, targetId: string];

export interface Drawing {
  id: string;
  configId: string;
  meta: SimpleMeta | StartggVersusMeta | StartggGauntletMeta | SheetGauntletMeta;
  winners: Record<string, string | null>;
  charts?: Array<DrawnChart | PlayerPickPlaceholder>;
  bans: Record<string, PlayerActionOnChart | null>;
  protects: Record<string, PlayerActionOnChart | null>;
  pocketPicks: Record<string, PocketPick | null>;
  tiebreakers: Record<string, true>;
  pickOrder: string[];
  actionTimestamps: Record<string, number>;
  priorityPlayer?: string;
  subDrawings: Record<string, SubDrawing>;
}

export interface SubDrawing {
  compoundId: CompoundSetId;
  configId: string;
  charts: Array<DrawnChart | PlayerPickPlaceholder>;
}

export type MergedDrawing = Drawing & SubDrawing;
