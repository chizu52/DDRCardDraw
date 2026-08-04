import { useMutation, useQuery } from "urql";
import type {
  EventSetsDocument,
  PlayerNameDocument,
  ReportSetDocument,
  SetNameDocument,
  EventListDocument,
  GauntletDivisionsDocument,
} from "./generated/graphql";
import { Client, fetchExchange, gql } from "@urql/core";
import { cacheExchange } from "@urql/exchange-graphcache";
import { getDefaultStore, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const startggKeyAtom = atomWithStorage<string | null>(
  "ddrtools.event.startggtoken",
  process.env.STARTGG_TOKEN as string,
  undefined,
  { getOnInit: true },
);
export const startggEventSlug = atomWithStorage<string | null>(
  "ddrtools.event.startggslug",
  "tournament/red-october-2024/event/stepmaniax-full-mode",
  undefined,
  { getOnInit: true },
);

export const urqlClient = new Client({
  url: "https://api.start.gg/gql/alpha",
  fetchOptions: () => ({
    headers: {
      Authorization: `Bearer ${getDefaultStore().get(startggKeyAtom)}`,
    },
  }),
  exchanges: [cacheExchange(), fetchExchange],
});

const PlayerNameDoc: typeof PlayerNameDocument = gql`
  query PlayerName($pid: ID!) {
    entrant(id: $pid) {
      __typename
      id
      name
    }
  }
`;

export function useStartggPlayerName(playerId: string) {
  const [result] = useQuery({
    query: PlayerNameDoc,
    variables: {
      pid: playerId,
    },
  });
  return result.data?.entrant?.name;
}

const SetNameDoc: typeof SetNameDocument = gql`
  query SetName($sid: ID!) {
    set(id: $sid) {
      __typename
      id
      fullRoundText
    }
  }
`;

export function useStartggSetName(setId: string) {
  const [result] = useQuery({
    query: SetNameDoc,
    variables: {
      sid: setId,
    },
  });
  return result.data?.set?.fullRoundText;
}

export function useStartggMatches() {
  const eventSlug = useAtomValue(startggEventSlug)!;
  return useQuery({
    query: EventSetsDoc,
    variables: {
      eventSlug,
      pageNo: 0,
    },
  });
}

export function useStartggPhases() {
  const eventSlug = useAtomValue(startggEventSlug)!;
  return useQuery({
    query: GauntletDivisions,
    variables: {
      eventSlug,
    },
  });
}

// Hand-written query + types, not run through graphql-codegen like the
// queries above -- codegen introspects the live start.gg schema over the
// network using a real API token (see graphql.config.ts), which isn't
// available in this environment. Every field below was individually
// verified against start.gg's public schema docs
// (smashgg-schema.netlify.app/reference/{set,setslot,standing,
// standingstats,score,phase,setfilters,setsorttype,brackettype}.doc)
// before writing this, rather than guessed from memory. `gql` still
// parses this into a real DocumentNode at runtime (same as codegen's
// output, just computed on load instead of at build time), so it's not
// possible to have a malformed query shape -- only a wrong field NAME
// would surface as a schema error, and each one here is doc-confirmed.
export interface StartggScore {
  value: number | null;
}
export interface StartggStanding {
  placement: number | null;
  // A single object, not a list -- confirmed against
  // smashgg-schema.netlify.app/reference/standingstats.doc
  // ("type StandingStats {score: Score}") and against real data
  // ({"stats":{"score":{"value":1}}}), after discovering the score pill
  // never actually rendered because the code was indexing this like an
  // array ([0].value) instead of reading the object directly.
  stats: { score: StartggScore | null } | null;
}
export interface StartggProgressionPhase {
  phase: { id: string; name: string | null } | null;
}
export interface StartggSetSlot {
  id: string | null;
  slotIndex: number | null;
  // "set" (prereqId is another Set's id) or "seed" (prereqId is a Seed's
  // id, meaning this slot is filled directly, not by a prior match).
  prereqType: string | null;
  prereqId: string | null;
  // Which placement (1st, 2nd, ...) in the prereq set/seed feeds this
  // slot -- e.g. prereqPlacement: 2 off a prereq set means "the loser of
  // that set", which is exactly how a double elimination bracket's
  // winners-to-losers drop-down is expressed.
  prereqPlacement: number | null;
  entrant: {
    id: string;
    name: string | null;
    // The entrant's clan/sponsor tag, e.g. "TSM" for "TSM | PlayerName"
    // -- start.gg calls this "prefix," confirmed live against the real
    // API (Entrant.participants[].prefix) and independently corroborated
    // by a different fork's own bracket overlay PR querying the exact
    // same field. `entrant.name` itself also embeds this as "Prefix |
    // GamerTag" when set (see controls/player-names.tsx's
    // inferShortname, which strips exactly that pattern for other UI),
    // but that's not usable here since bracket-tree.tsx wants the
    // prefix rendered in its own color, not baked into one string.
    // Effectively always at most one participant for this app's
    // singles-only brackets, so only participants[0] is read.
    participants: { prefix: string | null }[] | null;
  } | null;
  // A per-set DQ (as opposed to a full tournament-wide DQ, which would be
  // entrant.isDisqualified -- not queried here, unused for this) shows up
  // as score.value === -1 on the disqualified entrant's own slot, with
  // the opponent's score staying null. Confirmed directly against a real
  // DQ'd set's live data, not just schema docs (those don't document a
  // magic-number convention like this). See bracket-tree.tsx's MatchBox.
  standing: StartggStanding | null;
  seed: {
    // Present on ANY slot whose entrant ultimately traces back to a
    // placement in an earlier *phase* (e.g. pools feeding into a bracket)
    // -- not just a slot fed directly by seed. A slot fed by prereqType
    // "set" (a same-phase prior match) can still carry this, describing
    // where whoever eventually lands there originally came from. Only
    // rendered for a column-0 slot (see bracket-layout.ts's
    // incomingProgressionLabel) -- that's what makes it "the entry
    // point," not the field itself.
    progressionSource: {
      originPhase: { id: string; name: string | null } | null;
    } | null;
  } | null;
}
// A phase's seeds, fetched via the TOP-LEVEL Phase.seeds connection --
// deliberately separate from StartggSetSlot.seed (nested under
// phase.sets.nodes[].slots[]) even though both resolve the same
// underlying Seed objects. Confirmed directly: for a still-empty
// "prereqType: seed" slot (no entrant assigned yet, e.g. a future pool's
// entry-point slot waiting on an earlier phase to finish), the NESTED
// path returns `seed: null` -- but querying that exact same seed's id
// through this top-level connection (or via a standalone `seed(id:)`
// query) returns its progressionSource/placeholderName just fine. A
// start.gg resolver quirk, not missing data: the nested field only
// resolves once a real entrant occupies the slot. See
// bracket-layout.ts's indexSeedProgressionById/incomingProgressionLabel
// for how this fills the gap.
export interface StartggPhaseSeed {
  id: string;
  progressionSource: {
    originPhase: { id: string; name: string | null } | null;
    placeholderName: string | null;
  } | null;
}
export interface StartggSet {
  id: string;
  identifier: string | null;
  // Signed: positive = winners bracket round, negative = losers bracket
  // round (this is start.gg's own convention, confirmed in their Set
  // type's field description, not an assumption).
  round: number | null;
  fullRoundText: string | null;
  // An Int -- and despite slot.entrant.id's type saying `string`, live
  // data shows THAT comes back as a raw number too, so comparing against
  // it needs String() on both sides (see bracket-layout.ts's
  // winningSlotIndex), not just this one.
  winnerId: number | null;
  // Raw activity-state int, undocumented on the field itself but confirmed
  // against the schema's own ActivityState enum declaration order
  // (CREATED, ACTIVE, COMPLETED, READY, INVALID, CALLED, QUEUED --
  // smashgg-schema.netlify.app/reference/activitystate.doc), 1-indexed:
  // 1=Created(unstarted) 2=Active(started) 3=Completed 4=Ready 5=Invalid
  // 6=Called 7=Queued. Cross-checked against a second, independent source
  // (a Medium article citing the legacy REST API) landing on the same
  // 1/2/3/6 mapping for the values that matter here.
  state: number | null;
  startedAt: number | null;
  // Where this set's winner/loser lands once determined -- only useful
  // here when that destination is a *different* phase than the one being
  // displayed (an in-phase progression is already fully described by some
  // other fetched set's own slot.prereqId pointing back at this set's id;
  // see bracket-layout.ts's outgoingProgression, which checks for exactly
  // that to decide whether this is actually a cross-phase exit worth
  // rendering a "-> Stage X" pill for).
  winnerProgressionSeed: StartggProgressionPhase | null;
  loserProgressionSeed: StartggProgressionPhase | null;
  slots: (StartggSetSlot | null)[] | null;
}
export interface PhaseBracketQuery {
  phase: {
    id: string;
    name: string | null;
    bracketType: string | null;
    sets: { nodes: (StartggSet | null)[] | null } | null;
    seeds: { nodes: (StartggPhaseSeed | null)[] | null } | null;
  } | null;
}
export interface PhaseBracketQueryVariables {
  phaseId: string;
}

export const PhaseBracketDoc = gql<
  PhaseBracketQuery,
  PhaseBracketQueryVariables
>`
  query PhaseBracket($phaseId: ID!) {
    phase(id: $phaseId) {
      id
      name
      bracketType
      sets(
        perPage: 100
        page: 1
        sortType: ROUND
        filters: { hideEmpty: false }
      ) {
        nodes {
          id
          identifier
          round
          fullRoundText
          winnerId
          state
          startedAt
          winnerProgressionSeed {
            phase {
              id
              name
            }
          }
          loserProgressionSeed {
            phase {
              id
              name
            }
          }
          slots {
            id
            slotIndex
            prereqType
            prereqId
            prereqPlacement
            entrant {
              id
              name
              participants {
                prefix
              }
            }
            standing {
              placement
              stats {
                score {
                  value
                }
              }
            }
            seed {
              progressionSource {
                originPhase {
                  id
                  name
                }
              }
            }
          }
        }
      }
      seeds(query: { page: 1, perPage: 100 }) {
        nodes {
          id
          progressionSource {
            originPhase {
              id
              name
            }
            placeholderName
          }
        }
      }
    }
  }
`;

export function useStartggPhaseBracket(phaseId: string) {
  return useQuery({
    query: PhaseBracketDoc,
    variables: { phaseId },
  });
}

const GauntletDivisions: typeof GauntletDivisionsDocument = gql`
  query GauntletDivisions($eventSlug: String!) {
    event(slug: $eventSlug) {
      id
      phases {
        id
        name
        state
        bracketType
        seeds(query: { page: 0, perPage: 32 }) {
          nodes {
            entrant {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const EventSetsDoc: typeof EventSetsDocument = gql`
  query EventSets($eventSlug: String!, $pageNo: Int!) {
    event(slug: $eventSlug) {
      id
      sets(filters: { hideEmpty: true }, perPage: 100, page: $pageNo) {
        pageInfo {
          totalPages
          total
        }
        nodes {
          id
          fullRoundText
          identifier
          slots {
            id
            prereqType
            prereqId
            prereqPlacement
            entrant {
              id
              name
            }
          }
          phaseGroup {
            displayIdentifier
            phase {
              name
              groupCount
            }
          }
        }
      }
    }
  }
`;

const ReportSetMutation: typeof ReportSetDocument = gql`
  mutation ReportSet(
    $setId: ID!
    $winnerId: ID
    $gameData: [BracketSetGameDataInput]
  ) {
    reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
      id
      completedAt
    }
  }
`;

export type {
  BracketSetGameDataInput,
  ReportSetMutationVariables,
} from "./generated/graphql";

/**
 * Passing a winnerId will mark the set as completed.
 * Passing game data will overwrite any existing game data.
 */
export function useReportSetMutation() {
  return useMutation(ReportSetMutation);
}

const EventListQuery: typeof EventListDocument = gql`
  query EventList($page: Int!, $perPage: Int!) {
    currentUser {
      tournaments(
        query: {
          page: $page
          perPage: $perPage
          filter: { tournamentView: "admin" }
        }
      ) {
        nodes {
          id
          name
          slug
          events {
            id
            name
            slug
          }
        }
        pageInfo {
          total
          totalPages
          page
          perPage
        }
      }
    }
  }
`;

export function useCurrentUserEvents() {
  return useQuery({
    query: EventListQuery,
    variables: {
      page: 1,
      perPage: 25,
    },
  });
}
