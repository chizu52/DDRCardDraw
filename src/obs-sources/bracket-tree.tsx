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
  let body: React.ReactNode;
  if (result.fetching && !result.data) {
    body = (
      <div style={{ color: COLORS.muted, fontSize: 20, padding: "8px 4px" }}>
        Loading bracket…
      </div>
    );
  } else if (result.error) {
    body = (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        {result.error.message}
      </Callout>
    );
  } else if (!result.data?.phase) {
    body = (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        That phase wasn't found -- it may have been deleted, or the API key
        doesn't have access to it.
      </Callout>
    );
  } else {
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
              component, not just similarly-styled). No subtitle here
              (unlike before) -- phase.name only exists once `body`
              above has real phase data, and moved down into `body`
              itself for that reason, so the title bar can render
              immediately without waiting on it. */}
          <BroadcastTitleBar icon={icon} title={title || "Bracket"} />
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
// Must comfortably clear a live match's elapsed-timer pill, which
// extends 8px (gap) + LIVE_TIMER_WIDTH (58px) = 66px past its own box's
// right edge -- needs real room to spare beyond that 66px.
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
  });
  // Every column with a live match in it -- a Set, not a single index,
  // since more than one match can be live at once in different columns.
  // Each one's header gets a soft glow so "what round are we in" reads
  // at a glance.
  const liveCols = new Set(
    side.columns
      .map((col, i) => (col.some((m) => isSetLive(m.set)) ? i : -1))
      .filter((i) => i !== -1),
  );
  // Unique per BracketTree instance (winners/losers render as two
  // separate <svg> roots on the same page) -- an SVG filter id has to be
  // unique document-wide for url(#id) to reliably resolve to THIS
  // side's own <filter>, not whichever same-named one happens to appear
  // first in the DOM.
  const glowFilterId = `live-col-glow-${useId()}`;
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
      // isSetLive too -- a live match's elapsed-timer pill needs the same
      // right-side room as an outgoing promotion pill, even on a match
      // with no promotion pill of its own (see MatchBox's hasTimer).
      return prog.winner || prog.loser || isSetLive(m.set);
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
          // A soft, pulsing green glow -- not the old solid blue accent
          // tint (blue didn't tie back to anything else in this palette;
          // the live indicator everywhere else -- box outline, elapsed
          // timer -- is green, so the header highlight now matches
          // rather than introducing an unrelated color) and not a
          // static glow either (tried both white and green static
          // first; a slow breathing opacity reads as "something is
          // happening here right now," closer to how a real broadcast
          // graphic calls out a live segment, without being distracting
          // at a 2s cycle).
          <defs>
            <filter
              id={glowFilterId}
              x="-80%"
              y="-80%"
              width="260%"
              height="260%"
            >
              <feGaussianBlur stdDeviation="7" />
            </filter>
          </defs>
        )}
        <g transform={`translate(${paddingLeft},${BASE_PADDING})`}>
          {side.columns.map((colMatches, col) => {
            const x = col * (BOX_WIDTH + COL_GAP);
            const isCurrent = liveCols.has(col);
            return (
              <g key={col}>
                {isCurrent && (
                  <rect
                    x={x - 10}
                    y={-4}
                    width={BOX_WIDTH + 20}
                    height={HEADER_HEIGHT - 16}
                    rx={6}
                    fill={COLORS.live}
                    opacity={0.4}
                    filter={`url(#${glowFilterId})`}
                  >
                    <animate
                      attributeName="opacity"
                      values="0.15;0.45;0.15"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </rect>
                )}
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

// A name row's real available width, before the score pill starts: from
// NAME_INSET_X (16) to BOX_WIDTH - SCORE_PILL_WIDTH - SCORE_PILL_MARGIN
// (200 - 30 - 8 = 162) is 146px -- confirmed directly against a real
// rendered bracket (getBBox() on the live SVG text/tspan elements), not
// assumed. That same live check is what caught this budget being wrong
// in the first place: a real entrant ("Bhop Goomba Roomba", 18 chars,
// under the old 20-char cap) measured 162.89px wide, 17px past the pill.
// Real per-character widths in this custom BODY_FONT_FAMILY (which is
// user-supplied and gitignored, see local-fonts.ts -- not something this
// comment's numbers can be re-derived from without a live render) ranged
// 8.3-9.05px/char across several real names depending on weight/letters;
// MAX_NAME_ROW_CHARS below uses 9px/char (the widest observed, i.e. the
// safe direction to round) against 140px (146 minus a few px of margin,
// not the exact flush edge) -- 140/9 = 15.5, floored to 15.
const MAX_NAME_ROW_CHARS = 15;
// Tightened from 10 -- with MAX_NAME_ROW_CHARS now much smaller than the
// old 20, a 10-char prefix could still eat 2/3 of the entire budget by
// itself. 8 keeps a genuinely long tag readable while leaving more room
// for MIN_NAME_ROW_CHARS below.
const MAX_PREFIX_CHARS = 8;
// The name's own floor even when a maxed-out prefix eats the rest of
// MAX_NAME_ROW_CHARS -- worst case (8-char prefix + 1 space + 6-char
// name = 15 chars) still lands exactly at budget, not over it.
const MIN_NAME_ROW_CHARS = 6;

function MatchBox({
  match,
  setsById,
  currentPhaseId,
  nowMs,
  winnersEntrantIds,
  seedProgressionById,
  phantomSetsById,
}: {
  match: { set: StartggSet; x: number; y: number; col: number };
  setsById: SetsById;
  currentPhaseId: string;
  nowMs: number;
  winnersEntrantIds?: WinnersEntrantIds;
  seedProgressionById?: SeedProgressionById;
  phantomSetsById?: PhantomSetsById;
}) {
  const { set, x, y } = match;
  const winIdx = winningSlotIndex(set);
  const slots = set.slots || [];
  const live = isSetLive(set);
  const called = isSetCalled(set);
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

  const hasTimer = live && set.startedAt != null;

  return (
    <g transform={`translate(${x},${y})`} opacity={isFarOut ? 0.5 : 1}>
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
          // Pushed past the elapsed-timer pill (8px gap + its own width)
          // when both are present, so they don't collide -- see the
          // ElapsedTimerPill render below.
          edgeX={BOX_WIDTH + (hasTimer ? 8 + LIVE_TIMER_WIDTH + 8 : 0)}
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
        strokeWidth={live || called ? 3 : 2}
      />
      <line
        x1={0}
        y1={ROW_DIVIDER_Y}
        x2={BOX_WIDTH}
        y2={ROW_DIVIDER_Y}
        stroke={COLORS.border}
      />
      {/* Elapsed-since-started clock, not a "LIVE" text badge -- matches
          start.gg's own report view (compared directly against a live
          screenshot of it), which uses the timer itself as the live
          indicator rather than a separate label. No equivalent exists for
          Called: start.gg doesn't expose a "time since called" timestamp
          anywhere in the schema (only Set.startedAt), so Called only gets
          the outline + bell icons below, no pill. */}
      {live && set.startedAt != null && (
        <ElapsedTimerPill
          x={BOX_WIDTH + 8}
          y={ROW_DIVIDER_Y}
          startedAt={set.startedAt}
          nowMs={nowMs}
          color={COLORS.live}
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
        const rowY = ROW_TOP_PAD + i * (ROW_HEIGHT + ROW_GAP);
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
        // Only a real, filled slot has a clan tag to show -- a
        // placeholder/TBD row's own "name" text (e.g. "winner of A") has
        // no entrant, so this is naturally null for those already.
        // Capped short (tags are conventionally a few characters on
        // start.gg) so a long one can't crowd out the name it's
        // labeling; the name's own truncation budget shrinks to make
        // room for whatever the tag actually took, rather than the two
        // being sized independently and risking an overflow into the
        // score pill area on the row's right edge.
        const prefix = slot?.entrant?.participants?.[0]?.prefix || null;
        const displayPrefix =
          prefix && prefix.length > MAX_PREFIX_CHARS
            ? prefix.slice(0, MAX_PREFIX_CHARS - 1) + "…"
            : prefix;
        const nameBudget = displayPrefix
          ? Math.max(
              MIN_NAME_ROW_CHARS,
              MAX_NAME_ROW_CHARS - displayPrefix.length - 1,
            )
          : MAX_NAME_ROW_CHARS;
        const displayName =
          name.length > nameBudget ? name.slice(0, nameBudget - 1) + "…" : name;
        return (
          <g key={i}>
            <g transform={`translate(0,${rowY})`}>
              <text
                x={NAME_INSET_X}
                y={ROW_HEIGHT / 2 + 5}
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
                    x={BOX_WIDTH - SCORE_PILL_WIDTH - SCORE_PILL_MARGIN}
                    y={(ROW_HEIGHT - 22) / 2}
                    width={SCORE_PILL_WIDTH}
                    height={22}
                    rx={4}
                    fill={COLORS.dq}
                  />
                  <text
                    x={BOX_WIDTH - SCORE_PILL_WIDTH / 2 - SCORE_PILL_MARGIN}
                    y={ROW_HEIGHT / 2 + 5}
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
                    x={BOX_WIDTH - SCORE_PILL_WIDTH - SCORE_PILL_MARGIN}
                    y={(ROW_HEIGHT - 22) / 2}
                    width={SCORE_PILL_WIDTH}
                    height={22}
                    rx={4}
                    fill={COLORS.winnerScore}
                  />
                  <text
                    x={BOX_WIDTH - SCORE_PILL_WIDTH / 2 - SCORE_PILL_MARGIN}
                    y={ROW_HEIGHT / 2 + 5}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize={13}
                    fontWeight={700}
                  >
                    ✓
                  </text>
                </g>
              ) : (
                score != null && (
                  <g>
                    <rect
                      x={BOX_WIDTH - SCORE_PILL_WIDTH - SCORE_PILL_MARGIN}
                      y={(ROW_HEIGHT - 22) / 2}
                      width={SCORE_PILL_WIDTH}
                      height={22}
                      rx={4}
                      fill={isWinner ? COLORS.winnerScore : COLORS.loserScore}
                    />
                    <text
                      x={BOX_WIDTH - SCORE_PILL_WIDTH / 2 - SCORE_PILL_MARGIN}
                      y={ROW_HEIGHT / 2 + 5}
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
  const height = 22;
  return (
    <g transform={`translate(${x},${y - height / 2})`}>
      <rect width={LIVE_TIMER_WIDTH} height={height} rx={4} fill={color} />
      <text
        x={LIVE_TIMER_WIDTH / 2}
        y={height / 2 + 5}
        textAnchor="middle"
        fill="#fff"
        fontWeight={700}
        fontSize={12}
      >
        {mm}:{ss.toString().padStart(2, "0")}
      </text>
    </g>
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
  const height = 22;
  const paddingX = 14;
  const charWidth = 10;
  const width = Math.max(56, label.length * charWidth + paddingX * 2);
  const gap = 20;
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
      <text
        x={pillX + width / 2}
        y={y + 4}
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
      <text
        x={12}
        y={10}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontWeight={700}
        fontSize={11}
      >
        {label}
      </text>
    </g>
  );
}
