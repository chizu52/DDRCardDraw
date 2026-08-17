import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Callout } from "@blueprintjs/core";
import {
  Client,
  fetchExchange,
  Provider as UrqlProvider,
  useClient,
} from "urql";
import { useStartggPhaseBracket, StartggSet } from "../startgg-gql";
import {
  layoutBracket,
  computeSideGeometry,
  winningSlotIndex,
  isSetLive,
  isSetCalled,
  hasAnyEntrant,
  indexSetsById,
  indexWinnersEntrantIds,
  indexSeedProgressionById,
  collectUnresolvedSetPrereqIds,
  describeEmptySlot,
  incomingProgressionLabel,
  outgoingProgression,
  LayoutSide,
  SetsById,
  WinnersEntrantIds,
  SeedProgressionById,
  PhantomSet,
  PhantomSetsById,
} from "../startgg-gql/bracket-layout";
import { useAppState } from "../state/store";
import { BODY_FONT_FAMILY, LOCAL_FONT_FACE_CSS } from "./local-fonts";
import { BROADCAST_COLORS, POOL_PLAYER_ROW_FONT_SIZE } from "./broadcast-theme";
import { BroadcastTitleBar } from "./broadcast-title-bar";
import Banner from "../other-assets/backgrounds/bg.png";

// Long fallback poll, same rationale as pool-results.tsx's
// FALLBACK_POLL_INTERVAL_MS -- the Settings tab's refresh button
// (bracketRefreshedAt) is the fast path, this just covers the overlay
// being left running with nobody around to trigger that.
const FALLBACK_POLL_INTERVAL_MS = 60_000;

// This app's own dark broadcast palette (BROADCAST_COLORS -- same
// tokens as gauntlet-pools.tsx/pool-results.tsx/schedule.tsx, so all
// four overlays read as one broadcast package), sized up and
// higher-contrast than a website's own text, since a stream viewer
// reads this from further away and at lower effective resolution than
// someone actively browsing start.gg. Specific choices aimed at
// "keeping up," not just legibility:
//  - an opaque panel per match (not just floating text) so it stays
//    readable over arbitrary, moving video instead of a plain website
//    background
//  - a live match gets a green outline (not a full fill -- tried that
//    after start.gg's own TO-facing report view, reverted per feedback)
//    plus an elapsed-time pill (see ElapsedTimerPill), same idea as a
//    Called match's yellow outline but with a real ticking clock instead
//    of a static text badge
//  - the round column containing that live match gets its own accent
//    highlight, answering "what round are we even in" at a glance
//  - matches with no real entrants yet (both slots still TBD, i.e.
//    several rounds out) are dimmed, so attention goes to what's
//    actually happening now instead of the whole tree competing equally
const COLORS = {
  ...BROADCAST_COLORS,
  // This file's own additions, layered on top -- each a distinct role
  // with its own independently-tuned value, not a re-declaration of
  // anything already identical above.
  textLoser: "#9aa1ab",
  textTbd: "#5c636c",
  identifier: "#454b54",
  connector: "#3a3f47",
  loserScore: "#3a3f47",
  // A player's clan/sponsor tag (start.gg's "prefix") -- deliberately a
  // hue nothing else in this palette uses (every other color already
  // carries a meaning: green=live/winner, gold=called, red=DQ), so a
  // tag reads as its own distinct category at a glance instead of
  // blending into or being confused with a status color.
  prefix: "#a78bfa",
  // Same red gauntlet-pools.tsx/pool-results.tsx already added on top
  // of BROADCAST_COLORS for their own danger-adjacent uses -- was this
  // file's own private, slightly different red (#cd4246) before.
  dq: "#ef4444",
  // Live match outline (and the elapsed-timer pill's fill) -- the same
  // green ("current"/live) the other three overlays already use, not
  // this file's own separate near-identical green. Outline only, no box
  // fill tint (see the match box's own rect below).
  live: BROADCAST_COLORS.mint,
  // Same token as `live` -- a winner's checkmark/score pill used its own
  // literally-identical green before splitting it into a second name.
  winnerScore: BROADCAST_COLORS.mint,
  // Called (assigned a station, not yet started) -- an outline only too,
  // same treatment as Live, now the same gold schedule.tsx/pool-
  // results.tsx already use for a "needs attention" pill instead of
  // this file's own separate yellow.
  called: BROADCAST_COLORS.gold,
};

/** Takes a resolved start.gg apiKey directly, rather than reading a
 * `src`/`apiKey` query param itself -- this overlay no longer has a
 * standalone route of its own (folded into gauntlet-pools.tsx's own
 * overlay, see GauntletPoolsOverlay's own doc for why), so it's always
 * rendered by a caller that already resolved credentials some other
 * way. (An earlier version of this WAS the standalone route's own
 * component, decoding `src` via useSearchParams() itself -- kept as
 * plain props instead of, say, that caller nesting a second <Router>
 * with a synthetic location just to satisfy this reading it that way,
 * which React Router hard-errors on ("You cannot render a <Router>
 * inside another <Router>") -- see git history.) */
export function BracketTreeWithApiKey({
  apiKey,
  title,
  icon,
}: {
  apiKey: string;
  /** Shares the caller's own branding rather than having its own
   * separate title/icon fields -- this view no longer has its own
   * settings section (folded into the merged overlay's, see
   * dashboard.tsx's GauntletPoolsSettingsSection), so there's nowhere
   * left to set a bracket-specific one anyway. */
  title: string;
  icon: string | null;
}) {
  // A dedicated client scoped to this key, independent of the app's own
  // startgg-gql/index.ts urqlClient -- credentials are baked into the
  // URL rather than relied on from local storage (an OBS browser source
  // is a separate, isolated profile). No cacheExchange: PhaseBracketDoc
  // doesn't request __typename on every object, so a normalized cache
  // silently resolved a response as "phase not found" instead of
  // erroring loudly.
  const client = useMemo(
    () =>
      new Client({
        url: "https://api.start.gg/gql/alpha",
        fetchOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
        exchanges: [fetchExchange],
      }),
    [apiKey],
  );

  const phaseId = useAppState((s) => s.event.selectedBracketPhase);

  if (!phaseId) {
    return (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        No bracket selected. Pick one from the Settings tab.
      </Callout>
    );
  }

  return (
    <UrqlProvider value={client}>
      <BracketTreeInner phaseId={phaseId} title={title} icon={icon} />
    </UrqlProvider>
  );
}

function BracketTreeInner({
  phaseId,
  title,
  icon,
}: {
  phaseId: string;
  title: string;
  icon: string | null;
}) {
  const refreshedAt = useAppState((s) => s.event.bracketRefreshedAt);
  const [result, reexecuteQuery] = useStartggPhaseBracket(phaseId);
  // A lazy initializer, not useState(0) + an effect setting the real
  // value on mount -- see schedule.tsx's own nowMs for the fuller
  // writeup of why that version is a real bug, not just a style choice
  // (it self-corrects a render or two after mount, which is enough for
  // date-derived UI read off it to briefly show wrong/inconsistent
  // values). Nothing here is as failure-prone as schedule.tsx's own
  // entrance animation was, but ElapsedTimerPill's elapsed-time math
  // (nowMs / 1000 - startedAt) would still flash a bogus ~55-year
  // "elapsed" time on the very first paint of any live match with this
  // started at 0, clamped to a visible "0:00" by its own Math.max(0, …)
  // -- correct a moment later, but a real, avoidable flash regardless.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Only reruns reexecuteQuery for a GENUINE refreshedAt change (the
  // Settings tab's "Refresh bracket data" button, see dashboard.tsx) --
  // a plain `useEffect(..., [refreshedAt])` also fires once on mount
  // regardless of whether refreshedAt "changed," which forced a second,
  // fully redundant network-only fetch immediately after
  // useStartggPhaseBracket's own automatic on-mount fetch (urql's
  // useQuery already fetches once on mount/variable-change for free).
  // Doubling every fetch on first load -- and on every subsequent mount,
  // i.e. every time the "Now showing" dropdown switches into the
  // bracket view -- is exactly the kind of avoidable extra traffic that
  // trips start.gg's own rate limiting under real tournament load,
  // surfacing as intermittent failures that have nothing to do with the
  // bracket data itself.
  const isFirstRefreshRef = useRef(true);
  useEffect(() => {
    if (isFirstRefreshRef.current) {
      isFirstRefreshRef.current = false;
      return;
    }
    reexecuteQuery({ requestPolicy: "network-only" });
    // refreshedAt is the only reason to rerun this effect -- see
    // dashboard.tsx's Bracket settings "Refresh" button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshedAt]);

  useEffect(() => {
    const id = setInterval(() => {
      reexecuteQuery({ requestPolicy: "network-only" });
    }, FALLBACK_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reexecuteQuery]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Computed here, before the early returns below, and memoized on
  // result.data specifically (not just called plain in the render body)
  // -- usePhantomSets is a hook, so it has to run unconditionally like
  // every hook above regardless of whether phase data is loaded yet, AND
  // its own effect depends on setsById by reference: nowMs above already
  // ticks this component every second, and an unmemoized indexSetsById
  // call would hand it a brand-new Map every single one of those ticks,
  // re-triggering its fetch effect in a tight loop instead of only when
  // a genuinely new query result arrives.
  const sets = useMemo(
    () => result.data?.phase?.sets?.nodes || [],
    [result.data],
  );
  const setsById = useMemo(() => indexSetsById(sets), [sets]);
  const phantomSetsById = usePhantomSets(sets, setsById);

  // The chrome (banner, title bar) below is now ALWAYS rendered, not
  // gated behind these checks the way a plain early `return null`/
  // `return <Callout>` used to be -- title/icon are already known (came
  // in as props, not from this query), so there's no reason the operator
  // should stare at a completely blank overlay for however long
  // start.gg's own API takes to respond (independently known to be
  // slow, sometimes several seconds, for bracket-shaped queries) --
  // only the BODY below the title bar needs to reflect fetching/error/
  // not-found/ready, not the whole card disappearing and reappearing
  // around it. Computed as a value here, not a nested early-return,
  // specifically so the chrome JSX further down stays single-sourced
  // rather than duplicated across every branch.
  //
  // lastGoodBodyRef persists the last successfully-rendered bracket body
  // across both refetches (the 60s poll, a manual Refresh) and a
  // phaseId prop change (BracketTreeInner re-renders in place when the
  // "Now showing" dropdown picks a different phase -- see
  // BracketTreeWithApiKey's own JSX -- it doesn't unmount, so a plain
  // useRef survives that switch too). Preferred over the loading/error/
  // not-found states below whenever there's nothing FRESH to show yet:
  // an operator switching phases live, or a routine poll hitting a
  // transient network hiccup, shouldn't see the whole bracket blank out
  // for however many seconds start.gg's API takes to respond -- showing
  // what was last correct until the fresh version lands reads as "the
  // bracket updates in place," confirmed live to actually matter (a
  // manual refresh visibly sat on stale data for several real seconds
  // before this, not the instant swap the loading gate alone implied).
  const lastGoodBodyRef = useRef<React.ReactNode | null>(null);
  let body: React.ReactNode;
  // Only true when `body` is a stale fallback (either the cache, or the
  // very first "nothing cached yet" loading message) -- drives the small
  // honest indicator below rather than silently passing off old data as
  // current.
  let isStale = false;
  if (result.data?.phase) {
    const phase = result.data.phase;
    const layout = layoutBracket(sets);
    const winnersEntrantIds = indexWinnersEntrantIds(layout.winners);
    const seedProgressionById = indexSeedProgressionById(
      phase.seeds?.nodes || [],
    );
    body = (
      <>
        <div
          style={{
            fontFamily: BODY_FONT_FAMILY,
            fontSize: 20,
            color: COLORS.muted,
            marginTop: -8,
          }}
        >
          {phase.name}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <BracketTree
            label="Winners"
            side={layout.winners}
            setsById={setsById}
            currentPhaseId={phase.id}
            nowMs={nowMs}
            seedProgressionById={seedProgressionById}
            phantomSetsById={phantomSetsById}
          />
          {layout.losers && (
            <BracketTree
              label="Losers"
              side={layout.losers}
              setsById={setsById}
              currentPhaseId={phase.id}
              nowMs={nowMs}
              // Only the losers side needs this -- a winners-round-1
              // entrant trivially "appears in winners" via this exact
              // set, so passing it there too would wrongly suppress
              // its own legitimate pill. See indexWinnersEntrantIds's
              // doc.
              winnersEntrantIds={winnersEntrantIds}
              seedProgressionById={seedProgressionById}
              phantomSetsById={phantomSetsById}
            />
          )}
        </div>
      </>
    );
    lastGoodBodyRef.current = body;
  } else if (result.fetching && lastGoodBodyRef.current) {
    body = lastGoodBodyRef.current;
    isStale = true;
  } else if (result.fetching) {
    // The genuine first-ever load, nothing cached yet -- this message is
    // already its own self-explanatory loading state, not a stale
    // fallback standing in for something better, so isStale stays false
    // here (no redundant "Updating…" subtitle stacked above a body that
    // already says the same thing).
    body = (
      <div style={{ color: COLORS.muted, fontSize: 20, padding: "8px 4px" }}>
        Loading bracket…
      </div>
    );
  } else if (result.error && lastGoodBodyRef.current) {
    // Errored, but something's cached -- most likely a transient blip
    // the next 60s poll (or a manual Refresh) will clear on its own, not
    // worth replacing a perfectly good bracket with a scary red Callout
    // over.
    body = lastGoodBodyRef.current;
    isStale = true;
  } else if (result.error) {
    body = (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        {result.error.message}
      </Callout>
    );
  } else {
    // Settled (not fetching), no error, and still no phase -- a genuine
    // "not found" rather than a transient state, so this always
    // surfaces even when something's cached: unlike a network blip, the
    // next poll isn't going to fix a deleted/inaccessible phase, and an
    // operator needs to actually see that instead of staring at a
    // silently-stale bracket forever.
    body = (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        That phase wasn't found -- it may have been deleted, or the API key
        doesn't have access to it.
      </Callout>
    );
  }

  return (
    <>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. Shared with gauntlet-
          pools.tsx/schedule.tsx, not a local redeclaration. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      <div
        style={{
          // The card's base is the BODY font -- most of its text (match
          // names, round headers) is body content. The title bar
          // overrides to TITLE_FONT_FAMILY individually, below.
          fontFamily: BODY_FONT_FAMILY,
          // local-fonts.ts's @font-face only ever registers ONE weight
          // (400) regardless of the supplied file's own native weight --
          // without this, elements asking for 700/600 (round headers,
          // winner names, the title bar) get a synthesized fake bold,
          // which makes a custom display font look blurry instead of
          // crisp. Inherited, so this reaches the SVG text below too.
          fontSynthesis: "none",
          // A fallback fill only -- the content wrapper below (its own
          // sibling-of-the-banner, painted after it) is what actually
          // hides the banner in steady state.
          background: "rgb(17, 20, 24)",
          borderRadius: 20,
          overflow: "hidden",
          display: "inline-block",
          position: "relative",
          color: COLORS.text,
        }}
      >
        {/* Same soft out-of-focus banner backdrop as gauntlet-pools.tsx/
            schedule.tsx -- isolated on its own absolutely-positioned
            layer so `filter: blur()` never touches the sharp bracket
            tree stacked on top of it. `inset: -20px` gives the blur room
            to bleed past the card's own edges. */}
        <div
          style={{
            position: "absolute",
            inset: -20,
            background: `url(${Banner}) center/cover no-repeat`,
            filter: "blur(3px) brightness(0.55)",
          }}
        />
        <div
          style={{
            // Opaque, same color as the outer wrapper's own fallback
            // fill above -- this is what actually hides the banner:
            // this div sits ON TOP of the blurred banner layer (a
            // preceding sibling) in paint order and exactly matches its
            // parent's own content box, so a solid fill here covers the
            // banner completely, including the gaps between the title
            // bar and the bracket below that would otherwise let it
            // bleed through.
            position: "relative",
            background: "rgb(17, 20, 24)",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {/* Shared with gauntlet-pools.tsx's own title bar (same
              component, not just similarly-styled). No subtitle in the
              normal case -- phase.name only exists once `body` above has
              real phase data, and lives inside `body` itself for that
              reason, so the title bar can render immediately without
              waiting on it. Only reused here for isStale's own small,
              honest "this isn't fresh" indicator, which belongs beside
              the title rather than stacked above body's own (possibly
              stale, reused-from-cache) phase.name caption. */}
          <BroadcastTitleBar
            icon={icon}
            title={title || "Bracket"}
            subtitle={
              isStale
                ? result.error
                  ? "Couldn't refresh — showing the last loaded bracket"
                  : "Updating…"
                : undefined
            }
          />
          {body}
        </div>
      </div>
    </>
  );
}

// How many rounds of "fetch whatever unresolved phantom ids the last
// round turned up" to run before giving up -- a real bye-collapse chain
// shouldn't ever need many hops; this is a safety cap against a
// pathological/cyclical data shape looping forever.
const MAX_PHANTOM_HOPS = 5;

/** Fetches whatever bye-collapse phantom sets (see PhantomSet's own doc
 * in bracket-layout.ts) this phase's real sets reference via a "set"
 * prereq id that never came back in the main phase.sets query -- start
 * .gg only materializes real sets there; a still-unstarted bracket's
 * deeper structural rounds are only reachable one `set(id:)` lookup at a
 * time. Loops via collectUnresolvedSetPrereqIds, since a freshly-fetched
 * phantom set can itself reference another, deeper phantom id, bounded
 * by MAX_PHANTOM_HOPS so a pathological chain can't loop forever.
 *
 * Each hop is its own full round-trip, sequential (hop N+1's ids aren't
 * known until hop N's response arrives) -- combined with start.gg's own
 * latency for this kind of lookup, a multi-hop chain can add several
 * real seconds on top of the main bracket query. cacheRef exists
 * specifically to keep that cost from being paid AGAIN on every single
 * refetch (the 60s poll, a manual Refresh, a phase switch while staying
 * in bracket view) -- a bye-collapse chain's own shape is structural,
 * fixed once a bracket is generated, not something that changes as an
 * event progresses, so once an id is resolved it never needs
 * re-fetching for the lifetime of this component instance. Confirmed
 * live: this was a real, measurable contributor to "the bracket takes
 * forever to load" on every poll/refresh, not just the first one. */
function usePhantomSets(
  sets: (StartggSet | null)[],
  setsById: SetsById,
): PhantomSetsById {
  const client = useClient();
  const [phantomSetsById, setPhantomSetsById] = useState<PhantomSetsById>(
    () => new Map(),
  );
  // The actual accumulating cache -- a ref, not phantomSetsById itself,
  // so the effect below can read+write it synchronously across hops
  // without waiting on a re-render each time. phantomSetsById (state)
  // stays what's exposed to callers; this is the source of truth the
  // effect accumulates into and seeds every future run from.
  const cacheRef = useRef<PhantomSetsById>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Seeded from the accumulated cache, not a fresh empty Map --
      // see this hook's own doc above for why that's safe.
      // collectUnresolvedSetPrereqIds already treats anything in here
      // as resolved, so a cache hit costs nothing more than the Map
      // lookup it already does.
      const collected: PhantomSetsById = new Map(cacheRef.current);
      let idsToFetch = collectUnresolvedSetPrereqIds(sets, setsById, collected);
      let hops = 0;
      while (idsToFetch.length && hops < MAX_PHANTOM_HOPS && !cancelled) {
        const fetched = await fetchPhantomSets(client, idsToFetch);
        for (const [id, set] of fetched) collected.set(id, set);
        idsToFetch = collectUnresolvedSetPrereqIds(
          [...fetched.values()],
          setsById,
          collected,
        );
        hops++;
      }
      if (!cancelled) {
        cacheRef.current = collected;
        setPhantomSetsById(new Map(collected));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sets, setsById, client]);

  return phantomSetsById;
}

/** One GraphQL request per hop, aliasing every id in that hop's batch
 * together (s0, s1, ...) instead of one request per id. A raw query
 * string, not a static gql document -- there's no fixed set of ids to
 * write a document for ahead of time, and urql's Client.query accepts a
 * plain string directly. Requests only the minimal fields
 * resolveThroughByes/describeEmptySlot/incomingProgressionLabel
 * actually read, not a full Set. */
async function fetchPhantomSets(
  client: Client,
  ids: string[],
): Promise<Map<string, PhantomSet>> {
  const query = `query PhantomSets(${ids.map((_, i) => `$id${i}: ID!`).join(", ")}) {
    ${ids
      .map(
        (_, i) =>
          `s${i}: set(id: $id${i}) { id identifier slots { prereqType prereqId prereqPlacement entrant { id name } } }`,
      )
      .join("\n    ")}
  }`;
  const variables = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const result = await client
    .query<Record<string, PhantomSet | null>>(query, variables)
    .toPromise();
  const map = new Map<string, PhantomSet>();
  ids.forEach((id, i) => {
    const set = result.data?.[`s${i}`];
    if (set) map.set(id, set);
  });
  return map;
}

// This file's own un-scaled baseline text size for a player's name (see
// MatchBox's own fontSize prop, further down, which reads this same
// constant) -- SVG_SCALE below is computed against it, not a re-tuned
// literal, so the two can never quietly drift apart from each other.
const PLAYER_NAME_FONT_SIZE = 15;
// The whole bracket <svg> renders at this many times its own natural
// width/height (viewBox stays at the ORIGINAL, unscaled coordinate
// space) -- standard SVG technique, scales every child (text, strokes,
// pills, connectors, everything) proportionally for free. Exists so this
// view's player names visually match gauntlet-pools.tsx's own PoolBox
// rows exactly (POOL_PLAYER_ROW_FONT_SIZE, see its own doc in
// broadcast-theme.ts) -- the two views were tuned independently before,
// to two "looks about right" sizes that didn't actually match, so
// switching the "Now showing" dropdown between them made every name
// suddenly jump ~68% larger or smaller. Deliberately NOT hand-retuning
// BOX_WIDTH/ROW_HEIGHT/every other constant below by this same ratio
// instead -- they're already carefully tuned relative to EACH OTHER (see
// this component's own "tightened toward start.gg's own compact
// proportions" comment just below), and re-deriving a dozen of them by
// hand risks quietly missing one; scaling the rendered SVG uniformly
// can't miss anything since there's nothing left to individually retune.
const SVG_SCALE = POOL_PLAYER_ROW_FONT_SIZE / PLAYER_NAME_FONT_SIZE;

// Tightened up from this component's first "readability" pass to read
// closer to start.gg's own, more compact proportions -- this is a spacing
// pass only, the dark broadcast palette/LIVE badge/etc are unchanged
// (colors are being revisited separately later).
const BOX_WIDTH = 200;
// Must comfortably clear a Live/Called match's own right-side status
// pill, which extends 8px (gap) + STATUS_PILL_WIDTH past its own box's
// right edge (defined further down, after that constant exists) --
// needs real room to spare beyond that.
const COL_GAP = 90;
// The gap between the header text and a row-0 match's LIVE/NEXT badge is
// controlled by the two elements' relative y offsets (see the header
// text's own comment below), not by this -- so this can stay a
// reasonably compact value rather than growing to manufacture clearance.
const HEADER_HEIGHT = 38;
// Extra side margin reserved only on whichever edge actually has a
// cross-phase promotion pill to draw (see PromotionPill) -- most sides
// don't need it, so it's added conditionally rather than baked into a
// wider constant padding for every bracket. Sized for the left side's
// longer placeholderName labels ("Stage 1 1: Losers", ~18 chars -- see
// incomingProgressionLabel), not just a short phase name.
const PILL_MARGIN = 200;
const BASE_PADDING = 16;

function BracketTree({
  label,
  side,
  setsById,
  currentPhaseId,
  nowMs,
  winnersEntrantIds,
  seedProgressionById,
  phantomSetsById,
}: {
  label: string;
  side: LayoutSide;
  setsById: SetsById;
  currentPhaseId: string;
  nowMs: number;
  winnersEntrantIds?: WinnersEntrantIds;
  seedProgressionById?: SeedProgressionById;
  phantomSetsById?: PhantomSetsById;
}) {
  const geo = computeSideGeometry(side, {
    boxWidth: BOX_WIDTH,
    colGap: COL_GAP,
    boxHeight: MATCH_BOX_HEIGHT,
    // ROW_DIVIDER_Y isn't MATCH_BOX_HEIGHT / 2 (top/bottom row padding
    // isn't symmetric, see ROW_DIVIDER_Y's own doc) -- without telling
    // computeSideGeometry that, its connector lines converged on the
    // box's plain geometric center instead of the divider, landing
    // visibly off from where the box's own divider line actually is.
    dividerOffset: ROW_DIVIDER_Y - MATCH_BOX_HEIGHT / 2,
  });
  // Every column with a live match in it -- a Set, not a single index,
  // since more than one match can be live at once in different columns.
  // Only drives the header text's own bold/white-vs-muted color below
  // now -- this used to ALSO drive a pulsing glow rect behind the whole
  // column header ("what round are we in" at a glance), removed per
  // explicit feedback (too distracting running continuously across an
  // entire column). A much subtler version of that same pulse lives on
  // each live MATCH's own box instead now -- see MatchBox's own glow,
  // liveGlowFilterId just below.
  const liveCols = new Set(
    side.columns
      .map((col, i) => (col.some((m) => isSetLive(m.set)) ? i : -1))
      .filter((i) => i !== -1),
  );
  // Unique per BracketTree instance (winners/losers render as two
  // separate <svg> roots on the same page) -- an SVG filter id has to be
  // unique document-wide for url(#id) to reliably resolve to THIS
  // side's own <filter>, not whichever same-named one happens to appear
  // first in the DOM. One shared filter definition for every live match
  // box on this side, not one per box -- the blur radius is identical
  // either way, no reason to duplicate the <filter> itself per match.
  const liveGlowFilterId = `live-match-glow-${useId()}`;
  const hasLeftPill = (side.columns[0] || []).some((m) =>
    (m.set.slots || []).some((s) =>
      incomingProgressionLabel(
        s,
        currentPhaseId,
        winnersEntrantIds,
        seedProgressionById,
        setsById,
        phantomSetsById,
      ),
    ),
  );
  const hasRightPill = side.columns.some((col) =>
    col.some((m) => {
      const prog = outgoingProgression(m.set, setsById);
      // isSetLive/isSetCalled too -- either one's own right-side status
      // pill (ticking timer / "Up Next") needs the same room as an
      // outgoing promotion pill, even on a match with no promotion pill
      // of its own (see MatchBox's hasStatusPill).
      return (
        prog.winner || prog.loser || isSetLive(m.set) || isSetCalled(m.set)
      );
    }),
  );
  const paddingLeft = BASE_PADDING + (hasLeftPill ? PILL_MARGIN : 0);
  const paddingRight = BASE_PADDING + (hasRightPill ? PILL_MARGIN : 0);
  const totalWidth = geo.width + paddingLeft + paddingRight;
  const totalHeight = geo.height + BASE_PADDING * 2 + HEADER_HEIGHT;
  return (
    <div>
      {/* No visible "Winners"/"Losers" text header above the tree
          itself -- `label` still flows into the SVG's own <title>
          below (screen readers/accessibility), just not rendered as
          its own standalone heading here. */}
      <svg
        role="img"
        // Rendered size is SVG_SCALE times the natural geometry below --
        // viewBox stays at the true, unscaled totalWidth/totalHeight, so
        // every child renders at its own normal coordinates and the
        // browser scales the whole result uniformly to fit. See
        // SVG_SCALE's own doc for why this exists.
        width={totalWidth * SVG_SCALE}
        height={totalHeight * SVG_SCALE}
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
      >
        <title>{label} bracket</title>
        {liveCols.size > 0 && (
          // Same soft-blur filter every live match box's own glow uses
          // (see MatchBox's own comment on it) -- a tighter blur than
          // this file's old column-header version (stdDeviation 4, not
          // 7), since it now hugs one match box's own outline rather
          // than a much wider column-header rect.
          <defs>
            <filter
              id={liveGlowFilterId}
              x="-80%"
              y="-80%"
              width="260%"
              height="260%"
            >
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
        )}
        <g transform={`translate(${paddingLeft},${BASE_PADDING})`}>
          {side.columns.map((colMatches, col) => {
            const x = col * (BOX_WIDTH + COL_GAP);
            const isCurrent = liveCols.has(col);
            return (
              <g key={col}>
                {/* y is HEADER_HEIGHT - 26, not just "- 12" -- if both
                    this and the LIVE/NEXT badge's own y (HEADER_HEIGHT -
                    BADGE_HEIGHT/2, see MatchBox) are simple HEADER_HEIGHT
                    deltas, the gap between them stays 0 regardless of
                    HEADER_HEIGHT. This one sits further from
                    HEADER_HEIGHT's own baseline than the badge does. */}
                <text
                  x={x}
                  y={HEADER_HEIGHT - 26}
                  fontSize={13}
                  fontWeight={700}
                  fill={isCurrent ? COLORS.text : COLORS.muted}
                >
                  {colMatches[0]?.set.fullRoundText || ""}
                </text>
              </g>
            );
          })}
          <g transform={`translate(0,${HEADER_HEIGHT})`}>
            {geo.connectors.map((d, i) => (
              <path
                key={i}
                d={d}
                stroke={COLORS.connector}
                fill="none"
                strokeWidth={2}
                strokeDasharray="3,3"
              />
            ))}
            {geo.matches.map((match) => (
              <MatchBox
                key={match.set.id}
                match={match}
                setsById={setsById}
                currentPhaseId={currentPhaseId}
                nowMs={nowMs}
                winnersEntrantIds={winnersEntrantIds}
                seedProgressionById={seedProgressionById}
                phantomSetsById={phantomSetsById}
                liveGlowFilterId={liveGlowFilterId}
              />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}

// Still bigger than start.gg's own site (meant to be read up close while
// clicking around, not from across a room), but tightened toward their
// actual proportions in this spacing pass -- a 26px row per slot with a
// slimmer gap, an opaque panel behind every match instead of bare text
// (so it stays legible over arbitrary video, not just a plain website
// background), and a wider score pill sized for 2-digit scores.
const ROW_HEIGHT = 28;
const ROW_GAP = 6;
// Padding inside the box above row 0 and below row 1 -- gives the score
// pills/name text breathing room from the box's own border.
const ROW_TOP_PAD = 14;
const ROW_BOTTOM_PAD = 10;
export const MATCH_BOX_HEIGHT =
  ROW_TOP_PAD + ROW_HEIGHT * 2 + ROW_GAP + ROW_BOTTOM_PAD;
// The midpoint between the two entrant rows -- where the identifier tag,
// divider line, and outgoing/elapsed-timer pills all anchor. Not simply
// MATCH_BOX_HEIGHT / 2, since the top/bottom padding above isn't
// symmetric.
const ROW_DIVIDER_Y = ROW_TOP_PAD + ROW_HEIGHT + ROW_GAP / 2;
const NAME_INSET_X = 16;
const SCORE_PILL_WIDTH = 30;
const SCORE_PILL_MARGIN = 8;
const LIVE_TIMER_WIDTH = 58;
// Sized to comfortably fit "Up Next" at this pill's own font (12px/700,
// same as ElapsedTimerPill's mm:ss text) -- a fixed pill for a fixed,
// known string doesn't need the real Canvas2D measurement player names
// get further down (that exists because a NAME'S length is unpredictable
// real-world data; this text never changes), just a hand-picked value
// with real headroom, same as LIVE_TIMER_WIDTH's own already-established
// convention.
const UP_NEXT_PILL_WIDTH = 72;
// Whichever of the two right-side status pills (Live's ticking timer,
// Called's static "Up Next") is actually showing on a given match, both
// need the SAME amount of space reserved beside it (PromotionPill's own
// edgeX offset, BracketTree's hasRightPill/COL_GAP margin) -- sized to
// the wider of the two so neither one is ever the surprise case that
// doesn't quite fit.
const STATUS_PILL_WIDTH = Math.max(LIVE_TIMER_WIDTH, UP_NEXT_PILL_WIDTH);

// A name row's real available width, before the score pill starts: from
// NAME_INSET_X (16) to BOX_WIDTH - SCORE_PILL_WIDTH - SCORE_PILL_MARGIN
// (200 - 30 - 8 = 162) is 146px -- confirmed directly against a real
// rendered bracket (getBBox() on the live SVG text/tspan elements), not
// assumed.
const NAME_ROW_AVAILABLE_WIDTH = 146;
// A separate, smaller cap on just the prefix's own width, so one very
// long clan tag can't eat most of NAME_ROW_AVAILABLE_WIDTH by itself and
// squeeze the actual player name down to almost nothing.
const MAX_PREFIX_WIDTH = 70;

// Was a fixed character-count budget (e.g. "20 chars total, 15 for the
// name") before this -- confirmed live that doesn't actually work well
// for a non-monospace font: the SAME character count has to be
// conservative enough to never overflow for a WIDE-lettered name ("Bhop
// Goomba Roomba" measured ~9px/char), which made it needlessly tight for
// a NARROW-lettered one, producing an ugly double-truncation ("DDRIlli…
// Carte…") on a name that would have fit close to in full. Real per-
// character widths ranged 7.9-9.05px/char across live names depending on
// actual letterforms -- no single character count serves both cases
// well. truncateToWidth below measures the ACTUAL rendered width via
// Canvas2D instead of guessing, so every name gets exactly as much room
// as it really needs, no more and no less.
let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  // Lazy + cached, not created at module load -- created on first real
  // use so this file has no top-level `document` access (harmless in a
  // browser, but there's no reason to require one just to define this
  // function), and one canvas is plenty for every measurement this
  // component ever needs.
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  return measureCtx;
}

/** Real, measured pixel width of `text` at the given size/weight in this
 * overlay's own BODY_FONT_FAMILY -- not a guessed average px/char (see
 * this section's own doc above for why that didn't hold up). Falls back
 * to a rough character-count estimate only if Canvas2D itself somehow
 * isn't available -- shouldn't happen in a real browser, defensive only,
 * matching this same font's own worst observed px/char so the fallback
 * stays on the safe (under, not over) side. */
function measureTextWidth(
  text: string,
  fontSize: number,
  fontWeight: number,
): number {
  const ctx = getMeasureCtx();
  if (!ctx) return text.length * 9;
  ctx.font = `${fontWeight} ${fontSize}px ${BODY_FONT_FAMILY}`;
  return ctx.measureText(text).width;
}

/** Truncates `text` with a trailing "…" to fit within `maxWidth` real
 * pixels, binary-searching the longest prefix that fits rather than
 * guessing a fixed character count. Returns `text` unchanged if it
 * already fits -- never adds an ellipsis to something that didn't need
 * one. */
function truncateToWidth(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number,
): string {
  if (measureTextWidth(text, fontSize, fontWeight) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + "…";
    if (measureTextWidth(candidate, fontSize, fontWeight) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + "…";
}

/** The y (baseline) to draw `text` at so it's ACTUALLY visually centered
 * at `centerY` -- measured via Canvas2D's real glyph ink extents
 * (actualBoundingBoxAscent/Descent), not SVG's own
 * dominantBaseline="central". That was tried first here and looked right
 * in isolated checks, but confirmed live it still wasn't reliably
 * centering every pill: "central" trusts this custom BODY_FONT_FAMILY's
 * own internal baseline-table metrics (see local-fonts.ts's own doc on
 * this being a user-supplied, never-audited font file), which aren't
 * guaranteed to describe this specific typeface's actual visual weight
 * correctly. Measuring the real rendered ink instead -- same "measure,
 * don't guess" approach truncateToWidth above already uses for
 * horizontal sizing -- removes that dependency entirely: the returned y
 * is correct for whatever this font actually draws, not what its own
 * metadata claims it draws. */
function verticalCenterBaselineY(
  text: string,
  centerY: number,
  fontSize: number,
  fontWeight: number,
): number {
  const ctx = getMeasureCtx();
  if (!ctx) return centerY + fontSize * 0.35; // rough fallback, see measureTextWidth's own
  ctx.font = `${fontWeight} ${fontSize}px ${BODY_FONT_FAMILY}`;
  const metrics = ctx.measureText(text);
  // Both default to 0 on a browser that doesn't support the
  // actualBoundingBox* metrics (all current major engines do) -- falls
  // through to centerY itself in that case, which is still a reasonable
  // approximation (alphabetic baseline AT the center) rather than a
  // crash.
  const ascent = metrics.actualBoundingBoxAscent || 0;
  const descent = metrics.actualBoundingBoxDescent || 0;
  return centerY + (ascent - descent) / 2;
}

function MatchBox({
  match,
  setsById,
  currentPhaseId,
  nowMs,
  winnersEntrantIds,
  seedProgressionById,
  phantomSetsById,
  liveGlowFilterId,
}: {
  match: { set: StartggSet; x: number; y: number; col: number };
  setsById: SetsById;
  currentPhaseId: string;
  nowMs: number;
  winnersEntrantIds?: WinnersEntrantIds;
  seedProgressionById?: SeedProgressionById;
  phantomSetsById?: PhantomSetsById;
  /** BracketTree's own shared <filter> id for the soft glow below --
   * only actually referenced when this match is live, but always passed
   * down regardless (simpler than threading an optional-only-if-live
   * prop) since the id itself is cheap to pass and BracketTree already
   * computed it unconditionally. */
  liveGlowFilterId: string;
}) {
  const { set, x, y } = match;
  const winIdx = winningSlotIndex(set);
  const slots = set.slots || [];
  const live = isSetLive(set);
  const called = isSetCalled(set);
  // Both a live and a called match get a thicker outline than a normal
  // one -- read once here so the outline `<rect>` and the divider
  // `<line>` below (which needs to stay clear of however thick that
  // outline actually is, see its own comment) always agree.
  const boxStrokeWidth = live || called ? 3 : 2;
  // Several rounds out with nothing determined yet -- dim it so the
  // still-active/decided matches read as the focus, not equally-weighted
  // clutter.
  const isFarOut = !live && winIdx === null && !hasAnyEntrant(set);
  const outgoing = outgoingProgression(set, setsById);
  // Only the very first column of a side has entry-point slots (filled
  // directly by seed, not by a prior same-phase set) -- everywhere else,
  // an empty slot is always fed by a same-phase connector instead.
  const isEntryColumn = match.col === 0;
  // One independent pill per promoted player, not per box -- if both
  // slots in a match are genuinely promoted, both get their own pill
  // and their own straight (never diagonal) line at their own row.
  // Strictly confirmed data only (incomingProgressionLabel), no
  // fallback for a still-undetermined slot. setsById/phantomSetsById
  // let this see through a losers-side bye-collapse chain to the real
  // seed underneath (see resolveThroughByes).
  const row0Label = isEntryColumn
    ? incomingProgressionLabel(
        slots[0],
        currentPhaseId,
        winnersEntrantIds,
        seedProgressionById,
        setsById,
        phantomSetsById,
      )
    : null;
  const row1Label = isEntryColumn
    ? incomingProgressionLabel(
        slots[1],
        currentPhaseId,
        winnersEntrantIds,
        seedProgressionById,
        setsById,
        phantomSetsById,
      )
    : null;
  const row0Y = ROW_TOP_PAD + ROW_HEIGHT / 2;
  const row1Y = ROW_TOP_PAD + ROW_HEIGHT + ROW_GAP + ROW_HEIGHT / 2;

  // Either the ticking elapsed timer (Live) or the static "Up Next" pill
  // (Called) -- never both, isSetLive/isSetCalled are mutually exclusive
  // (see isSetCalled's own doc). Both reserve the same STATUS_PILL_WIDTH
  // of right-side room regardless of which is actually showing.
  const hasStatusPill = (live && set.startedAt != null) || called;
  const outgoingLabel = outgoing.winner || outgoing.loser;
  // Where a given status pill (by its own width -- the two aren't the
  // same size) should start so it's actually centered in the real gap
  // between the match box's edge and the outgoing promotion pill's near
  // edge -- confirmed live this was a real, visible bug: both pills
  // previously rendered at a flat BOX_WIDTH + 8, which only "centers"
  // whichever one happens to exactly fill STATUS_PILL_WIDTH (neither
  // one always does -- the 58-wide timer sat flush against the box with
  // all the slack pushed to the far side instead of split evenly, and
  // neither pill actually centered against the true visual gap -- box
  // edge to the promotion pill's own near edge -- once that was measured
  // rather than assumed). promoNearEdgeX mirrors the outgoing
  // PromotionPill's own edgeX/gap math exactly (see its call site
  // below) -- independent of the promotion pill's own width, which only
  // affects where its FAR edge sits, not its near one.
  function statusPillX(pillWidth: number): number {
    if (!outgoingLabel) return BOX_WIDTH + 8;
    const promoNearEdgeX =
      BOX_WIDTH + 8 + STATUS_PILL_WIDTH + 8 + PROMOTION_PILL_GAP;
    const gapWidth = promoNearEdgeX - BOX_WIDTH;
    return BOX_WIDTH + (gapWidth - pillWidth) / 2;
  }

  return (
    <g transform={`translate(${x},${y})`} opacity={isFarOut ? 0.5 : 1}>
      {/* A very subtle, slowly breathing glow behind the box's own solid
          outline -- confirmed live: rendering this BEFORE the outline
          rect (not after) is what makes it read as a soft halo peeking
          out from behind a crisp border, rather than a haze painted on
          top that would dull the border's own edge. Deliberately a
          narrow opacity swing (0.06-0.18, not the old column-header
          glow's 0.15-0.45) and a tighter blur (see BracketTree's own
          liveGlowFilterId) -- explicit feedback was that the previous
          column-wide version was too flashy; this is meant to be
          noticed on a second look, not grab attention on its own. */}
      {live && (
        <rect
          x={-6}
          y={-6}
          width={BOX_WIDTH + 12}
          height={MATCH_BOX_HEIGHT + 12}
          rx={10}
          fill={COLORS.live}
          opacity={0.1}
          filter={`url(#${liveGlowFilterId})`}
        >
          <animate
            attributeName="opacity"
            values="0.06;0.18;0.06"
            dur="2.6s"
            repeatCount="indefinite"
          />
        </rect>
      )}
      {row0Label && (
        // edgeX (pill positioning) starts past the identifier ribbon
        // (which occupies roughly -16 to +13 at ROW_DIVIDER_Y, see
        // IdentifierTag) so the pill itself doesn't overlap it -- but
        // boxEdgeX={0} still extends the connecting line all the way to
        // the box's actual outline, not just to that offset point, so it
        // visibly touches the match it belongs to.
        <PromotionPill
          label={row0Label}
          edgeX={-28}
          boxEdgeX={0}
          y={row0Y}
          side="left"
        />
      )}
      {row1Label && (
        <PromotionPill
          label={row1Label}
          edgeX={-28}
          boxEdgeX={0}
          y={row1Y}
          side="left"
        />
      )}
      {(outgoing.winner || outgoing.loser) && (
        <PromotionPill
          label={(outgoing.winner || outgoing.loser)!}
          // Pushed past the status pill (8px gap + its own width) when
          // both are present, so the PILL itself doesn't collide with
          // it -- see the ElapsedTimerPill/UpNextPill render below.
          edgeX={BOX_WIDTH + (hasStatusPill ? 8 + STATUS_PILL_WIDTH + 8 : 0)}
          // boxEdgeX explicitly at the box's own true edge, NOT left to
          // default to edgeX above -- confirmed live this was a real
          // bug: on any match with a status pill showing, the connector
          // line started wherever the PILL itself was pushed to instead
          // of the box's actual edge, so it visually read as connecting
          // to the status pill (or floating in the gap after it) rather
          // than to the match it actually belongs to. The line still
          // visually passes behind/through the status pill's own opaque
          // rect where they overlap -- that's fine and expected, same as
          // how PromotionPill's own far end already stops at the pill's
          // edge, drawn in front of it.
          boxEdgeX={BOX_WIDTH}
          y={ROW_DIVIDER_Y}
          side="right"
        />
      )}
      <rect
        x={0}
        y={0}
        width={BOX_WIDTH}
        height={MATCH_BOX_HEIGHT}
        rx={6}
        fill={COLORS.panel}
        stroke={live ? COLORS.live : called ? COLORS.called : COLORS.border}
        strokeWidth={boxStrokeWidth}
      />
      {/* Inset by half the box's own border stroke, not flush with x=0/
          BOX_WIDTH -- an SVG stroke is centered on its path, so the
          outline rect's border already extends boxStrokeWidth/2 inward
          from those exact coordinates. A divider drawn AT x=0/BOX_WIDTH
          (after, i.e. on top of, the outline in paint order) painted
          straight over the inner half of that border stroke -- barely
          visible against a thin 2px normal border, but a real, confirmed
          visual glitch against a live/called match's thicker 3px one
          (the grey divider color showing through/above the green or gold
          border right at its own left/right ends). */}
      <line
        x1={boxStrokeWidth / 2}
        y1={ROW_DIVIDER_Y}
        x2={BOX_WIDTH - boxStrokeWidth / 2}
        y2={ROW_DIVIDER_Y}
        stroke={COLORS.border}
      />
      {/* Elapsed-since-started clock for Live -- matches start.gg's own
          report view (compared directly against a live screenshot of
          it), which uses the timer itself as the live indicator rather
          than a separate label. Called gets a static "Up Next" pill
          instead (start.gg doesn't expose a "time since called"
          timestamp anywhere in the schema, only Set.startedAt, so
          there's no elapsed time to show there) -- isSetLive/isSetCalled
          are mutually exclusive, so only one of these two ever renders. */}
      {live && set.startedAt != null && (
        <ElapsedTimerPill
          x={statusPillX(LIVE_TIMER_WIDTH)}
          y={ROW_DIVIDER_Y}
          startedAt={set.startedAt}
          nowMs={nowMs}
          color={COLORS.live}
        />
      )}
      {called && (
        <UpNextPill
          x={statusPillX(UP_NEXT_PILL_WIDTH)}
          y={ROW_DIVIDER_Y}
          color={COLORS.called}
        />
      )}
      {set.identifier && (
        <IdentifierTag label={set.identifier} y={ROW_DIVIDER_Y} />
      )}
      {[0, 1].map((i) => {
        const slot = slots[i];
        const isWinner = winIdx === i;
        const isLoser = winIdx !== null && !isWinner;
        // start.gg encodes a per-set DQ as score.value === -1 on the
        // disqualified entrant's own slot -- NOT via entrant.isDisqualified,
        // which stays null for this (that field is for a full
        // tournament-wide DQ, a different concept). Confirmed directly
        // against live data.
        const score = slot?.standing?.stats?.score?.value;
        const isDq = score === -1;
        // A declared winner with no reported score at all (common when a
        // TO calls the winner without entering game-by-game scores, not
        // just the DQ case) still needs *some* result shown, or the row
        // reads as if nothing happened -- a plain checkmark, same as the
        // DQ-opponent's win, covers both causes with one signal.
        const showWinCheck = !isDq && isWinner && score == null;
        // Shared by all three score-pill variants (DQ/checkmark/number)
        // below, computed once instead of each branch repeating the same
        // expression independently.
        const scorePillX = BOX_WIDTH - SCORE_PILL_WIDTH - SCORE_PILL_MARGIN;
        // Each player's own "box" within the match -- bounded by the
        // match's own outer edge on one side and the divider line on the
        // other, NOT split evenly by ROW_HEIGHT/ROW_GAP/ROW_TOP_PAD/
        // ROW_BOTTOM_PAD (those only set the OVERALL match box's
        // proportions -- see MATCH_BOX_HEIGHT/ROW_DIVIDER_Y's own docs --
        // they were never meant to describe where each individual row's
        // own visual boundary sits). Row 0's own box is [0,
        // ROW_DIVIDER_Y], row 1's is [ROW_DIVIDER_Y, MATCH_BOX_HEIGHT] --
        // confirmed these aren't equal spans (the divider isn't exactly
        // at the box's own geometric midpoint, ROW_DIVIDER_Y=45 vs
        // MATCH_BOX_HEIGHT/2=43 with this file's current constants),
        // which is exactly why centering row content against a flat
        // ROW_HEIGHT-tall slice (the previous approach) didn't actually
        // match where the real outer-border-to-divider boundary sits.
        const rowTop = i === 0 ? 0 : ROW_DIVIDER_Y;
        const rowBottom = i === 0 ? ROW_DIVIDER_Y : MATCH_BOX_HEIGHT;
        const rowCenterY = (rowTop + rowBottom) / 2;
        // Relative to rowCenterY (0 = center, since the row's own <g>
        // below translates to rowCenterY directly) -- unlike
        // scorePillX, this can't be a single row-independent constant
        // anymore, since row 0 and row 1's own boxes aren't the same
        // height.
        const scorePillY = -11;
        const name = describeEmptySlot(
          slot,
          setsById,
          seedProgressionById,
          phantomSetsById,
        );
        const nameColor = !slot?.entrant
          ? COLORS.textTbd
          : isLoser
            ? COLORS.textLoser
            : COLORS.text;
        // Same weight the <text> below actually renders this row at --
        // measuring at any other weight would size-check against a
        // slightly different rendered width than what really shows up.
        const rowFontWeight = isWinner ? 700 : 400;
        // Only a real, filled slot has a clan tag to show -- a
        // placeholder/TBD row's own "name" text (e.g. "winner of A") has
        // no entrant, so this is naturally null for those already.
        // Capped to MAX_PREFIX_WIDTH so a long one can't crowd out the
        // name it's labeling; the name's own available width shrinks by
        // exactly whatever the (possibly-truncated) tag actually
        // measures, rather than the two being sized independently and
        // risking an overflow into the score pill area on the row's
        // right edge.
        const prefix = slot?.entrant?.participants?.[0]?.prefix || null;
        const displayPrefix = prefix
          ? truncateToWidth(prefix, MAX_PREFIX_WIDTH, PLAYER_NAME_FONT_SIZE, rowFontWeight)
          : null;
        const nameAvailableWidth = displayPrefix
          ? NAME_ROW_AVAILABLE_WIDTH -
            measureTextWidth(
              `${displayPrefix} `,
              PLAYER_NAME_FONT_SIZE,
              rowFontWeight,
            )
          : NAME_ROW_AVAILABLE_WIDTH;
        const displayName = truncateToWidth(
          name,
          nameAvailableWidth,
          PLAYER_NAME_FONT_SIZE,
          rowFontWeight,
        );
        return (
          <g key={i}>
            {/* Translated to rowCenterY directly, not the old top-
                anchored rowY -- every y coordinate inside this <g> is
                relative to the row's own real center now (0 = center),
                not relative to a flat ROW_HEIGHT-tall slice from the
                row's own top. */}
            <g transform={`translate(0,${rowCenterY})`}>
              {/* Baseline measured against just displayName (not the
                  optional bell emoji prefix, which Canvas2D's own
                  ascent/descent metrics don't reliably report for --
                  the prefix tspan shares this same baseline regardless,
                  same as normal SVG text flow, so measuring the row's
                  main content is representative enough). */}
              <text
                x={NAME_INSET_X}
                y={verticalCenterBaselineY(
                  displayPrefix ? `${displayPrefix} ${displayName}` : displayName,
                  0,
                  PLAYER_NAME_FONT_SIZE,
                  rowFontWeight,
                )}
                fill={nameColor}
                fontSize={PLAYER_NAME_FONT_SIZE}
                fontWeight={isWinner ? 700 : 400}
                fontStyle={slot?.entrant ? "normal" : "italic"}
              >
                {/* Called shows a bell next to both entrants -- matches
                    start.gg's own report view, which marks Called this
                    way instead of (or alongside) the outline. */}
                {called && slot?.entrant ? "🔔 " : ""}
                {displayPrefix && (
                  <tspan fill={COLORS.prefix}>{displayPrefix} </tspan>
                )}
                {displayName}
              </text>
              {isDq ? (
                <g>
                  <rect
                    x={scorePillX}
                    y={scorePillY}
                    width={SCORE_PILL_WIDTH}
                    height={22}
                    rx={4}
                    fill={COLORS.dq}
                  />
                  {/* Baseline measured via verticalCenterBaselineY at
                      the pill's own true center (scorePillY + 11, half
                      its own 22 height) -- scorePillY already centers
                      this pill ON the row, so centering the text ON the
                      pill also centers it on the row. See that
                      function's own doc for why it measures real glyph
                      ink instead of trusting dominantBaseline="central"
                      (tried first, confirmed live still not reliable
                      for this custom font). */}
                  <text
                    x={scorePillX + SCORE_PILL_WIDTH / 2}
                    y={verticalCenterBaselineY(
                      "DQ",
                      scorePillY + 11,
                      11,
                      700,
                    )}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize={11}
                    fontWeight={700}
                  >
                    DQ
                  </text>
                </g>
              ) : showWinCheck ? (
                <g>
                  <rect
                    x={scorePillX}
                    y={scorePillY}
                    width={SCORE_PILL_WIDTH}
                    height={22}
                    rx={4}
                    fill={COLORS.winnerScore}
                  />
                  {/* A hand-drawn checkmark, not the "✓" character --
                      same reasoning gauntlet-pools.tsx's own arrow
                      triangle already documents: a Unicode glyph's own
                      ink isn't symmetric within its advance-width box,
                      so textAnchor="middle" centers by ADVANCE width,
                      not by visual weight -- confirmed live, "✓" rendered
                      clearly left-of-center inside this pill. A path's
                      own bounding box IS its visual weight, so this
                      centers correctly regardless of font/browser. */}
                  <path
                    d={`M${scorePillX + 8},${scorePillY + 11} L${scorePillX + 13},${scorePillY + 16} L${scorePillX + 22},${scorePillY + 6}`}
                    stroke="#fff"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </g>
              ) : (
                score != null && (
                  <g>
                    <rect
                      x={scorePillX}
                      y={scorePillY}
                      width={SCORE_PILL_WIDTH}
                      height={22}
                      rx={4}
                      fill={isWinner ? COLORS.winnerScore : COLORS.loserScore}
                    />
                    {/* Same measured-baseline fix as the DQ pill's own
                        text above. */}
                    <text
                      x={scorePillX + SCORE_PILL_WIDTH / 2}
                      y={verticalCenterBaselineY(
                        String(score),
                        scorePillY + 11,
                        13,
                        700,
                      )}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={13}
                      fontWeight={700}
                    >
                      {score}
                    </text>
                  </g>
                )
              )}
            </g>
          </g>
        );
      })}
    </g>
  );
}

/** The elapsed-since-started clock for a Live match, sitting just past
 * the box's right edge at row-divider height -- ticks up once a second
 * via BracketTreeInner's nowMs state (not Date.now() called directly
 * here -- that has to live inside an effect, not a component's render
 * body, per React's purity rule). */
function ElapsedTimerPill({
  x,
  y,
  startedAt,
  nowMs,
  color,
}: {
  x: number;
  y: number;
  startedAt: number;
  nowMs: number;
  color: string;
}) {
  const elapsedSec = Math.max(0, Math.round(nowMs / 1000 - startedAt));
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  const label = `${mm}:${ss.toString().padStart(2, "0")}`;
  const height = 22;
  return (
    <g transform={`translate(${x},${y - height / 2})`}>
      <rect width={LIVE_TIMER_WIDTH} height={height} rx={4} fill={color} />
      {/* Baseline measured via verticalCenterBaselineY, not
          dominantBaseline="central" -- tried that first (matching
          IdentifierTag's own established pattern), but confirmed live it
          still wasn't reliably centering every pill in this custom font.
          See that function's own doc for why measuring the real glyph
          ink is more robust than trusting the font's own baseline-table
          metrics. */}
      <text
        x={LIVE_TIMER_WIDTH / 2}
        y={verticalCenterBaselineY(label, height / 2, 12, 700)}
        textAnchor="middle"
        fill="#fff"
        fontWeight={700}
        fontSize={12}
      >
        {label}
      </text>
    </g>
  );
}

/** A Called match's own right-side status pill -- same position/shape as
 * ElapsedTimerPill (they're mutually exclusive, see MatchBox's own
 * hasStatusPill), just static text instead of a ticking clock: start.gg
 * doesn't expose a "time since called" timestamp anywhere in the schema,
 * so there's no elapsed time to show for this state, only that the match
 * has been called to a station and is coming up. */
function UpNextPill({
  x,
  y,
  color,
}: {
  x: number;
  y: number;
  color: string;
}) {
  const height = 22;
  return (
    <g transform={`translate(${x},${y - height / 2})`}>
      <rect width={UP_NEXT_PILL_WIDTH} height={height} rx={4} fill={color} />
      {/* Measured baseline, not dominantBaseline="central" -- see
          ElapsedTimerPill's own doc on this same fix, same reasoning
          applies here (mutually exclusive with it, but otherwise an
          identical shape). */}
      <text
        x={UP_NEXT_PILL_WIDTH / 2}
        y={verticalCenterBaselineY("Up Next", height / 2, 12, 700)}
        textAnchor="middle"
        fill="#fff"
        fontWeight={700}
        fontSize={12}
      >
        Up Next
      </text>
    </g>
  );
}

// Shared between PromotionPill's own rendering below and MatchBox's
// status-pill centering math, which needs to predict where the outgoing
// promotion pill's own near edge will actually land -- without this
// living in one place, MatchBox would have to duplicate the same sizing
// formula by hand and risk drifting out of sync with it.
const PROMOTION_PILL_HEIGHT = 22;
const PROMOTION_PILL_PADDING_X = 14;
const PROMOTION_PILL_CHAR_WIDTH = 10;
const PROMOTION_PILL_GAP = 20;
function promotionPillWidth(label: string): number {
  return Math.max(
    56,
    label.length * PROMOTION_PILL_CHAR_WIDTH + PROMOTION_PILL_PADDING_X * 2,
  );
}

/** The rounded "Stage X" pill start.gg draws where a match's connector
 * would otherwise go, whenever that connector actually leads to a
 * different *phase* rather than another match in this same view -- on
 * the left for an entry-point slot seeded from an earlier phase's
 * placement (incomingProgressionLabel), on the right for a winner/loser
 * that progresses out to a later phase (outgoingProgression). Connected
 * to the match box with a single plain dashed line, same idea as
 * start.gg's own dotted connector into/out of the pill -- always one
 * level line into one pill, never split or angled toward a specific row.
 *
 * The line spans from the box edge to the pill's own near edge (gap
 * away from the box), not from the box edge to a point `gap` away that
 * happens to land inside the pill's own footprint -- that would put the
 * entire line underneath the pill's own opaque rect, invisibly hidden
 * despite genuinely existing in the DOM. The pill's position is
 * computed first, and the line explicitly stops at its edge.
 *
 * `boxEdgeX` (defaults to `edgeX`) is where the line's OTHER end lands --
 * separate from `edgeX` because the left/incoming case positions the
 * pill clear of the identifier ribbon (a few px in from the box's true
 * edge), but the line itself should still visibly reach the box's actual
 * outline, not stop short at that same offset point. */
function PromotionPill({
  label,
  edgeX,
  y,
  side,
  boxEdgeX,
}: {
  label: string;
  edgeX: number;
  y: number;
  side: "left" | "right";
  boxEdgeX?: number;
}) {
  const height = PROMOTION_PILL_HEIGHT;
  const width = promotionPillWidth(label);
  const gap = PROMOTION_PILL_GAP;
  const pillX = side === "right" ? edgeX + gap : edgeX - gap - width;
  const pillNearEdgeX = side === "right" ? pillX : pillX + width;
  return (
    <g>
      <line
        x1={boxEdgeX ?? edgeX}
        y1={y}
        x2={pillNearEdgeX}
        y2={y}
        stroke={COLORS.muted}
        strokeWidth={1.5}
        strokeDasharray="3,3"
      />
      <rect
        x={pillX}
        y={y - height / 2}
        width={width}
        height={height}
        rx={height / 2}
        fill={COLORS.panel}
        stroke={COLORS.border}
      />
      {/* Measured baseline at the pill's own true y, not
          dominantBaseline="central" -- same fix as ElapsedTimerPill/
          UpNextPill's own text, see their doc. This is also the pill
          the status pills' own connector line runs past/behind (see
          MatchBox's hasStatusPill) -- keeping this one's own vertical
          center exact matters doubly here, since a status pill and this
          pill sit on the same y and visibly need to actually agree. */}
      <text
        x={pillX + width / 2}
        y={verticalCenterBaselineY(label, y, 11, 600)}
        textAnchor="middle"
        fill={COLORS.muted}
        fontSize={11}
        fontWeight={600}
      >
        {label}
      </text>
    </g>
  );
}

/** The small flag/ribbon tag start.gg overlaps on a match's left edge to
 * show its bracket-position letter (e.g. "A") -- shape traced from the
 * real SVG path on their bracket page, just sized up a little to match
 * this component's bigger boxes/text. */
function IdentifierTag({ label, y }: { label: string; y: number }) {
  return (
    <g transform={`translate(-16,${y - 10})`}>
      <path
        d="M4,0 H19 Q20.5,0 21.5,1 L29,10 Q30,10 29,10 L21.5,19 Q20.5,20 19,20 H4 A4,4 0 0 1 0,16 V4 A4,4 0 0 1 4,0 Z"
        fill={COLORS.identifier}
      />
      {/* Measured baseline, not dominantBaseline="central" -- see
          verticalCenterBaselineY's own doc for why (every other pill in
          this file used to follow this same "central" pattern, copied
          from here originally, before confirming live it wasn't
          reliably centering in this custom font). */}
      <text
        x={12}
        y={verticalCenterBaselineY(label, 10, 11, 700)}
        textAnchor="middle"
        fill="#fff"
        fontWeight={700}
        fontSize={11}
      >
        {label}
      </text>
    </g>
  );
}
