import { atomWithStorage } from "jotai/utils";

export interface MatchLogEntry {
  timestamp: number;
  matchTitle: string;
  rowCount: number;
}

export const matchLogAtom = atomWithStorage<MatchLogEntry[]>(
  "ddrtools.event.matchlog",
  [],
  undefined,
  { getOnInit: true },
);
