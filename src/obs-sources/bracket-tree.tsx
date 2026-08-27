import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Callout } from "@blueprintjs/core";
import {
  cacheExchange,
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
import {
  BROADCAST_COLORS,
  sectionLabelStyle,
  outerWrapperStyle,
  cardStyle,
  cardContentStyle,
} from "./broadcast-theme";
import { BroadcastTitleBar } from "./broadcast-title-bar";
import {
  MARQUEE_KEYFRAMES_CSS,
  MARQUEE_SPEED_PX_PER_S,
  MARQUEE_BASE_DURATION_S,
} from "./marquee";

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

// Module-level, not built inside BracketTreeWithApiKey via a plain
// useMemo -- a component-scoped client used to mean a BRAND NEW Client
// (and brand-new, empty cache) got constructed every single time the
// "Now showing" dropdown left bracket view and came back:
// GauntletPoolsOverlay swaps between two entirely different component
// trees for that toggle (this component vs GauntletPoolsWithCreds), a
// real unmount/remount, not just a re-render -- so no client-level
// cache could ever survive it no matter what exchanges it used.
// Hoisting the Client itself here means the SAME instance (and
// whatever cacheExchange has stored on it) survives that toggle for
// the whole page's lifetime. Keyed by apiKey rather than a single bare
// client, in case a future caller ever needs a second one with
// different credentials -- in practice this stays a map of one for
// the lifetime of a single OBS browser source/tab.
const bracketClientsByApiKey = new Map<string, Client>();

function getBracketClient(apiKey: string): Client {
  let client = bracketClientsByApiKey.get(apiKey);
  if (!client) {
    client = new Client({
      url: "https://api.start.gg/gql/alpha",
      fetchOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
      // @urql/core's own plain result cache (operation key ->
      // last response), NOT @urql/exchange-graphcache's NORMALIZED
      // cache (the app's shared startgg-gql/index.ts urqlClient uses
      // that one) -- deliberately avoided here: PhaseBracketDoc
      // doesn't request __typename on every object, and a normalized
      // cache silently resolved that as "phase not found" instead of
      // erroring loudly (the reason this client had NO cache exchange
      // at all before). This plain cache never inspects __typename --
      // it just remembers "this exact operation already returned this
      // exact response" (keyed on the query + variables) and replays
      // it on a cache-first hit. Every requestPolicy: "network-only"
      // execution (the 60s poll, the Settings tab's Refresh button --
      // see BracketTreeInner below) still goes to the network as
      // before, AND writes its fresh response back into this same
      // cache for the next cache-first hit (confirmed against
      // @urql/core's own cacheExchange source: it updates its result
      // cache on every successful query response regardless of which
      // requestPolicy triggered it, not just cache-first misses) --
      // so switching back to an already-viewed phase, or toggling the
      // "Now showing" dropdown away from and back to bracket view, now
      // renders instantly from cache instead of re-paying start.gg's
      // own multi-second bracket-query latency every single time.
      exchanges: [cacheExchange, fetchExchange],
    });
    bracketClientsByApiKey.set(apiKey, client);
  }
  return client;
}

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
  // Scoped to this key, independent of the app's own startgg-gql/
  // index.ts urqlClient -- credentials are baked into the URL rather
  // than relied on from local storage (an OBS browser source is a
  // separate, isolated profile). getBracketClient (above) is what
  // actually makes this durable across remounts -- see its own doc.
  const client = useMemo(() => getBracketClient(apiKey), [apiKey]);

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
  // Unconditional, like every other hook here -- only actually consumed
  // once real phase data exists (see the density-adaptive metrics solve
  // below), but hooks can't be called from inside that later branch.
  const viewport = useViewportSize();

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
  // True whenever `body` is a genuine (fresh or cached) bracket render,
  // as opposed to the loading/error/not-found placeholders further
  // below -- drives whether the fit-to-canvas scaling further down
  // applies at all. Scaling a tiny "Loading bracket…" caption or an
  // error Callout up to fill the whole OBS canvas would look absurd;
  // those stay at their own natural size.
  let isBracketContent = false;
  if (result.data?.phase) {
    const phase = result.data.phase;
    const layout = layoutBracket(sets);
    const winnersEntrantIds = indexWinnersEntrantIds(layout.winners);
    const seedProgressionById = indexSeedProgressionById(
      phase.seeds?.nodes || [],
    );
    // Density-adaptive sizing: solve for a width factor (kx) and height
    // factor (ky) that make the bracket's own natural totalWidth/
    // totalHeight come out matching the actual available card space
    // exactly, then build the real BracketMetrics both sides render
    // with -- see BracketMetrics's own doc for the full rationale.
    //
    // Step 1: each side's "natural" (BASE_METRICS, kx=ky=1) dimensions.
    // Each call passes the SAME arguments its matching <BracketTree>
    // call further down does (winnersEntrantIds only for Losers, never
    // Winners -- see that prop's own doc) -- computeBracketDimensions is
    // a pure function of its arguments, so mismatched arguments here
    // would silently solve against a different shape than what actually
    // renders.
    const winnersNatural = computeBracketDimensions(
      layout.winners,
      phase.id,
      setsById,
      undefined,
      seedProgressionById,
      phantomSetsById,
      BASE_METRICS,
    );
    const losersNatural = layout.losers
      ? computeBracketDimensions(
          layout.losers,
          phase.id,
          setsById,
          winnersEntrantIds,
          seedProgressionById,
          phantomSetsById,
          BASE_METRICS,
        )
      : null;
    // Step 2: how much real space is actually available for the two
    // <BracketTree>s together. cardStyleForBracket is width:100% of the
    // OBS canvas (see its own doc below), so viewport.width IS the
    // canvas width; cardContentStyle's own 40px padding is the only
    // horizontal deduction needed. Height has more fixed chrome above
    // the brackets to account for: BroadcastTitleBar's own tallest
    // child (the 100px icon) plus its 20px/32px padding and 3px border
    // (~146px), the marginBottom:20 wrapper around it, and one
    // sectionLabelStyle caption (~1.3em of cardStyle's own 28px base,
    // ~1.2 line-height, plus its own marginBottom:8) per side actually
    // shown -- these are real, deterministic style values from this
    // file/broadcast-title-bar.tsx, not guesses, but they're computed
    // here rather than measured off the live DOM (see useViewportSize's
    // own doc on why this file avoids measuring its own rendered
    // output) -- deliberately conservative names below so the reasoning
    // stays checkable against those files if either one's own numbers
    // ever change.
    const CARD_PADDING = 40;
    const TITLE_BAR_BLOCK_HEIGHT = 100 + 20 * 2 + 3 * 2 + 20; // icon + padding + border + marginBottom
    const SECTION_LABEL_HEIGHT = 28 * 1.3 * 1.2 + 8; // sectionLabelStyle em size + line-height + marginBottom
    const INTER_SIDE_GAP = 28;
    const numSides = losersNatural ? 2 : 1;
    const availableWidth = viewport.width - CARD_PADDING * 2;
    const availableHeight =
      viewport.height -
      CARD_PADDING * 2 -
      TITLE_BAR_BLOCK_HEIGHT -
      SECTION_LABEL_HEIGHT * numSides -
      (losersNatural ? INTER_SIDE_GAP : 0);
    // Step 3: solve kx from whichever side is naturally wider (so THAT
    // side ends up matching availableWidth exactly, same "shared basis"
    // principle the previous CSS-percentage version used -- see git
    // history -- just solved into a real box-width number instead of a
    // CSS percentage now); ky from both sides' combined natural height
    // against the shared vertical budget, since they stack. Guarded
    // against a not-yet-laid-out 0 viewport (SSR/very first tick) and a
    // pathological 0-natural-size bracket -- both fall back to 1 (same
    // as BASE_METRICS itself) rather than dividing by zero into
    // Infinity/NaN.
    const naturalWidthBasis = Math.max(
      winnersNatural.totalWidth,
      losersNatural?.totalWidth ?? 0,
    );
    const naturalHeightTotal =
      winnersNatural.totalHeight + (losersNatural?.totalHeight ?? 0);
    const rawKx =
      availableWidth > 0 && naturalWidthBasis > 0
        ? availableWidth / naturalWidthBasis
        : 1;
    const rawKy =
      availableHeight > 0 && naturalHeightTotal > 0
        ? availableHeight / naturalHeightTotal
        : 1;
    // Caps how far EITHER factor can scale UP, not just down -- confirmed
    // live that letting a simple bracket balloon unbounded looked just as
    // bad as shrinking one too far, arguably worse: a small 2-round
    // bracket on a 1920x1080 canvas measured kx≈3.5 against this file's
    // own reference numbers, ballooning the box to ~700px wide while the
    // still-fixed-at-the-time secondary chrome (status/promotion pills)
    // stayed tiny and stranded far from everything -- text and pills
    // visibly disconnected from an oversized box, not just "generously
    // sized." 1.5x keeps a simple bracket comfortably larger than its
    // reference design without it stopping looking like the same
    // component. Applied to both axes for the same reason MIN_KY is:
    // consistent proportions, not a width-specific patch.
    const MAX_SCALE = 1.5;
    const kx = Math.min(rawKx, MAX_SCALE);
    // Never shrinks player-name text (and everything else ky drives)
    // past MIN_PLAYER_NAME_FONT_SIZE -- see that constant's own doc for
    // the full rationale/tradeoff.
    const MIN_KY = MIN_PLAYER_NAME_FONT_SIZE / BASE_PLAYER_NAME_FONT_SIZE;
    const ky = Math.min(Math.max(rawKy, MIN_KY), MAX_SCALE);
    const metrics = scaleBracketMetrics(kx, ky);
    body = (
      <>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <BracketTree
            label="Winners"
            side={layout.winners}
            setsById={setsById}
            currentPhaseId={phase.id}
            nowMs={nowMs}
            seedProgressionById={seedProgressionById}
            phantomSetsById={phantomSetsById}
            metrics={metrics}
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
              metrics={metrics}
            />
          )}
        </div>
      </>
    );
    lastGoodBodyRef.current = body;
    isBracketContent = true;
  } else if (result.fetching && lastGoodBodyRef.current) {
    body = lastGoodBodyRef.current;
    isStale = true;
    isBracketContent = true;
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
    isBracketContent = true;
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

  // The card fills the canvas's own width (100%, not cardStyle's usual
  // `width: max-content`) so a bracket wide enough to have overflowed
  // and silently clipped at the canvas edge (see outerWrapperStyle's
  // own `overflow: hidden` in broadcast-theme.ts -- confirmed live on a
  // real Stage 2 bracket) instead scales down to fit, and a narrow one
  // scales up to use the full canvas. Overridden locally here, not in
  // the shared cardStyle constant itself -- gauntlet-pools.tsx's own
  // pools diagram keeps its own max-content card unchanged, since it
  // already handles overflow its own way (a scroll/pan camera, see its
  // own scrollContainerStyle) that this view was explicitly asked NOT
  // to add.
  //
  // The actual scaling math is density-adaptive now, not a CSS-only
  // scale of a fixed-density drawing -- see BracketMetrics's own doc
  // for the full rationale and useViewportSize for why reading the
  // window's own size (not measuring this component's own rendered
  // output) doesn't reintroduce the infinite-render-loop risk an
  // earlier ResizeObserver-based version of this had.
  const cardStyleForBracket: React.CSSProperties = isBracketContent
    ? { ...cardStyle, width: "100%" }
    : cardStyle;

  return (
    <>
      {/* A plain `style` prop can't express @font-face -- see
          local-fonts.ts's own comment on this. Shared with gauntlet-
          pools.tsx/schedule.tsx, not a local redeclaration. */}
      <style>{LOCAL_FONT_FACE_CSS}</style>
      {/* Same reasoning, for @keyframes this time -- one <style> per
          overlay instance covers every MatchBox's own name marquee
          below, since @keyframes are referenced by name, not scoped to
          wherever they're declared. */}
      <style>{MARQUEE_KEYFRAMES_CSS}</style>
      {/* Same whole-page shell gauntlet-pools.tsx's own pools diagram
          uses (outerWrapperStyle/cardStyle/cardContentStyle, shared via
          broadcast-theme.ts) -- explicit user request so switching the
          "Now showing" dropdown between the two views never visibly
          changes the overall page composition, only the content
          inside. Deliberately NOT wrapped in that other view's own
          scroll container/auto-pan camera though -- explicit user
          request to keep this view static rather than add scrolling
          behavior it never had before. Instead, cardStyleForBracket
          above fills the canvas width and each <BracketTree> scales
          its own <svg> to match -- see that block's own comment for
          why. */}
      <div style={outerWrapperStyle}>
        <div style={cardStyleForBracket}>
          <div style={cardContentStyle}>
            {/* Shared with gauntlet-pools.tsx's own title bar (same
                component, not just similarly-styled). No subtitle in the
                normal case -- explicit user request to drop the phase
                name (e.g. "Pool 1A") this used to show as a small
                caption above the bracket entirely, not just move it up
                into here instead. Only reused here for isStale's own
                small, honest "this isn't fresh" indicator. Plain static
                positioning, not gauntlet-pools.tsx's own sticky-in-grid
                treatment -- there's nothing to scroll away from here (see
                this view's own no-camera doc above), so a sticky offset
                would have nothing to stick against; it renders at the
                same visual position either way since that other view's
                own sticky title bar only ever visibly differs from plain
                static positioning once its content has actually scrolled.
                Deliberately NOT part of cardStyleForBracket's own width-
                driven scaling -- explicit user request to leave the title
                bar's own sizing alone for now. */}
            <div style={{ marginBottom: 20 }}>
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
            </div>
            {body}
          </div>
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

// Module-level, not a component-scoped ref -- for the identical reason
// the urql Client above got hoisted out of BracketTreeWithApiKey:
// BracketTreeInner (and this hook along with it) fully unmounts every
// time the "Now showing" dropdown leaves bracket view and returns,
// which used to wipe a component-scoped cache and force the ENTIRE
// sequential multi-hop chain below to redo from scratch on every
// single toggle back into bracket view, not just once per page load.
// NOT keyed by phaseId -- a resolved set id is safe to reuse across
// ANY phase that happens to reference it (start.gg set ids are unique
// across the whole tournament, never reused between phases), so one
// flat map growing for the lifetime of the page is exactly as correct
// as the original component-scoped version, just durable across
// remounts too.
const phantomSetsCache: PhantomSetsById = new Map();

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
 * real seconds on top of the main bracket query. phantomSetsCache exists
 * specifically to keep that cost from being paid AGAIN on every single
 * refetch (the 60s poll, a manual Refresh, a phase switch while staying
 * in bracket view) OR remount (leaving and returning to bracket view,
 * see phantomSetsCache's own doc) -- a bye-collapse chain's own shape is
 * structural, fixed once a bracket is generated, not something that
 * changes as an event progresses, so once an id is resolved it never
 * needs re-fetching for the lifetime of the page. Confirmed live: this
 * was a real, measurable contributor to "the bracket takes forever to
 * load" on every poll/refresh, not just the first one -- and, before
 * phantomSetsCache moved to module scope, on every remount too. */
function usePhantomSets(
  sets: (StartggSet | null)[],
  setsById: SetsById,
): PhantomSetsById {
  const client = useClient();
  // Seeded from the module-level cache, not always-empty -- a remount
  // into a phase whose phantom chain was already resolved earlier this
  // page-session starts warm instead of redoing every hop.
  const [phantomSetsById, setPhantomSetsById] = useState<PhantomSetsById>(
    () => new Map(phantomSetsCache),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Seeded from the accumulated module-level cache, not a fresh
      // empty Map -- see this hook's own doc above for why that's
      // safe. collectUnresolvedSetPrereqIds already treats anything in
      // here as resolved, so a cache hit costs nothing more than the
      // Map lookup it already does.
      const collected: PhantomSetsById = new Map(phantomSetsCache);
      let idsToFetch = collectUnresolvedSetPrereqIds(sets, setsById, collected);
      let hops = 0;
      while (idsToFetch.length && hops < MAX_PHANTOM_HOPS && !cancelled) {
        const fetched = await fetchPhantomSets(client, idsToFetch);
        for (const [id, set] of fetched) {
          collected.set(id, set);
          // Written back to the module-level cache incrementally, hop
          // by hop -- not just once at the very end -- so even a
          // cancelled effect (this component unmounting mid-chain)
          // keeps whatever WAS resolved by that point instead of
          // discarding a mid-flight partial accumulation.
          phantomSetsCache.set(id, set);
        }
        idsToFetch = collectUnresolvedSetPrereqIds(
          [...fetched.values()],
          setsById,
          collected,
        );
        hops++;
      }
      if (!cancelled) {
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

// Every pixel constant below that drives the bracket's OVERALL footprint
// (box size, row/column spacing, padding, player-name/header font size)
// is density-adaptive now -- computed fresh per render from BASE_METRICS
// (this view's original, hand-tuned "reference" numbers, unchanged from
// before) times a width factor (kx) and a height factor (ky), solved in
// BracketTreeInner so the bracket's own natural totalWidth/totalHeight
// come out matching the actual OBS canvas exactly, however many rounds/
// entrants it has -- explicit user request ("standardize... so brackets
// fit properly without constantly readjusting"), after confirming CSS-
// only canvas-fitting (this view's previous approach: one shared scale
// factor applied to a fixed-density drawing) can only ever bound ONE
// axis without either leaving empty margin or distorting proportions.
// kx and ky are independent -- box WIDTH-relevant constants (boxWidth,
// colGap, horizontal padding) scale by kx, box HEIGHT/text-relevant
// constants (matchBoxHeight, row spacing, header/name font size) scale
// by ky -- so a bracket that's short-but-wide vs tall-but-narrow both
// end up genuinely filling the canvas, not letterboxed. This does NOT
// distort glyphs (that would need a single element non-uniformly
// stretched via `transform: scale(kx,ky)`, never applied here) -- font
// size is a real recomputed number fed into real text/box geometry, so
// a shrunk name just renders smaller, not squished.
//
// Status/promotion/score pills and the identifier tag scale too, not
// just the main box -- an earlier version of this left them fixed-size
// (a disclosed scope limit at the time), which confirmed live to look
// actively broken rather than just incomplete: a simple bracket with
// plenty of canvas room can scale kx up several-fold (a genuinely small
// 2-round bracket on a 1920x1080 canvas measured kx≈3.5 against this
// file's own reference numbers), ballooning the box far past its
// pills' original fixed size -- text and pills stranded looking tiny
// and disconnected inside a comically oversized box, not just "a bit
// small." Pill WIDTHS (scorePillWidth, liveTimerWidth, upNextPillWidth,
// promotionPillPaddingX/CharWidth/Gap) scale by kx, matching the main
// box; pill HEIGHTS and their own text (scorePillHeight, pillFontSize,
// smallPillFontSize) scale by ky, matching row height/player-name font
// -- same width-vs-height split as the main box, so a pill's own
// proportions don't warp independently of the box it sits beside.
interface BracketMetrics {
  boxWidth: number;
  colGap: number;
  matchBoxHeight: number;
  rowHeight: number;
  rowGap: number;
  rowTopPad: number;
  rowBottomPad: number;
  /** The midpoint between the two entrant rows -- see BASE_ROW_DIVIDER_Y's
   * own doc below for why this isn't simply matchBoxHeight / 2. */
  rowDividerY: number;
  headerHeight: number;
  headerFontSize: number;
  /** Horizontal padding inside the card, on whichever side(s) don't
   * have a cross-phase promotion pill reserving pillMargin instead. */
  basePaddingX: number;
  basePaddingY: number;
  pillMargin: number;
  nameInsetX: number;
  maxPrefixWidth: number;
  playerNameFontSize: number;
  /** The raw width/height factors themselves, for the rare shape that
   * needs to scale its own hand-drawn geometry (MatchBox's own
   * checkmark path) proportionally rather than reading a pre-derived
   * field -- everything else on this object should prefer its own
   * specific field over reaching for these directly. */
  kx: number;
  ky: number;
  scorePillWidth: number;
  scorePillMargin: number;
  scorePillHeight: number;
  liveTimerWidth: number;
  upNextPillWidth: number;
  /** max(liveTimerWidth, upNextPillWidth) -- see BASE_STATUS_PILL_WIDTH's
   * own doc for why the wider of the two is what actually matters. */
  statusPillWidth: number;
  statusPillHeight: number;
  promotionPillHeight: number;
  promotionPillPaddingX: number;
  promotionPillCharWidth: number;
  promotionPillGap: number;
  /** Status pill (elapsed timer / "UP NEXT") text size. */
  pillFontSize: number;
  /** Promotion pill, identifier-tag, and the DQ score-pill's own text
   * size -- smaller than pillFontSize even at kx=ky=1, a separate field
   * rather than a fraction of it so each can still be tuned
   * independently later. */
  smallPillFontSize: number;
  /** The score-pill's own number text -- one size up from
   * smallPillFontSize even at kx=ky=1 (a 2-digit score needs to read
   * clearly), not the same field reused. */
  scorePillFontSize: number;
  /** Uniform scale for IdentifierTag's own hand-drawn path (a small
   * fixed SVG shape, not a formula of box width/height) -- tied to ky
   * specifically since the tag is vertically anchored to rowDividerY,
   * not to the box's own width. */
  identifierTagScale: number;
}

// Tightened up from this component's first "readability" pass to read
// closer to start.gg's own, more compact proportions -- this is a
// spacing pass only, the dark broadcast palette/LIVE badge/etc are
// unchanged (colors are revisited separately). These are the values
// BracketMetrics scales from (at kx=ky=1) -- the actual rendered numbers
// live on the metrics object now, not these constants directly (see
// scaleBracketMetrics below).
const BASE_BOX_WIDTH = 200;
// Must comfortably clear a Live/Called match's own right-side status
// pill, which extends 8px (gap) + STATUS_PILL_WIDTH past its own box's
// right edge (defined further down, after that constant exists) --
// needs real room to spare beyond that.
const BASE_COL_GAP = 90;
// Still bigger than start.gg's own site (meant to be read up close while
// clicking around, not from across a room), but tightened toward their
// actual proportions in this spacing pass -- a 26px row per slot with a
// slimmer gap, an opaque panel behind every match instead of bare text
// (so it stays legible over arbitrary video, not just a plain website
// background), and a wider score pill sized for 2-digit scores.
const BASE_ROW_HEIGHT = 28;
const BASE_ROW_GAP = 6;
// Padding inside the box above row 0 and below row 1 -- gives the score
// pills/name text breathing room from the box's own border.
const BASE_ROW_TOP_PAD = 14;
const BASE_ROW_BOTTOM_PAD = 10;
const BASE_MATCH_BOX_HEIGHT =
  BASE_ROW_TOP_PAD + BASE_ROW_HEIGHT * 2 + BASE_ROW_GAP + BASE_ROW_BOTTOM_PAD;
// Not simply BASE_MATCH_BOX_HEIGHT / 2, since the top/bottom row padding
// above isn't symmetric.
const BASE_ROW_DIVIDER_Y = BASE_ROW_TOP_PAD + BASE_ROW_HEIGHT + BASE_ROW_GAP / 2;
// The gap between the header text and a row-0 match's LIVE/NEXT badge is
// controlled by the two elements' relative y offsets (see the header
// text's own comment further down), not by this -- so this can stay a
// reasonably compact value rather than growing to manufacture clearance.
const BASE_HEADER_HEIGHT = 38;
const BASE_HEADER_FONT_SIZE = 13;
// Extra side margin reserved only on whichever edge actually has a
// cross-phase promotion pill to draw (see PromotionPill) -- most sides
// don't need it, so it's added conditionally rather than baked into a
// wider constant padding for every bracket. Sized for the left side's
// longer placeholderName labels ("Stage 1 1: Losers", ~18 chars -- see
// incomingProgressionLabel), not just a short phase name.
const BASE_PILL_MARGIN = 200;
const BASE_PADDING = 16;
const BASE_NAME_INSET_X = 16;
// A separate, smaller cap on just the prefix's own width, so one very
// long clan tag can't eat most of the name row by itself and squeeze
// the actual player name down to almost nothing.
const BASE_MAX_PREFIX_WIDTH = 70;
// This file's own un-scaled baseline text size for a player's name.
const BASE_PLAYER_NAME_FONT_SIZE = 15;
// The smallest this view will ever shrink a player's name down to,
// regardless of how large/complex the bracket gets -- explicit user
// request after confirming the unclamped math COULD shrink text well
// past comfortable stream legibility for a genuinely big bracket (a
// real, sanity-checked example: ~6.5px at ky≈0.44 for a 5-6 round
// double-elim bracket on a 1920x1080 canvas). Enforced by flooring ky
// itself (see MIN_KY below), not by clamping playerNameFontSize alone
// after the fact -- every other ky-driven metric (row height/gap,
// header text) stays proportionally consistent with the floored font
// size instead of independently continuing to shrink around it. Once a
// bracket is big enough to actually hit this floor, it genuinely no
// longer fits the canvas vertically (the same clipped-at-the-bottom
// behavior this whole density-adaptive system was built to avoid for
// the common case) -- an accepted, explicit tradeoff: legible-but-
// occasionally-clipped over always-fits-but-eventually-unreadable.
const MIN_PLAYER_NAME_FONT_SIZE = 11;

// Sized for 2-digit scores.
const BASE_SCORE_PILL_WIDTH = 30;
const BASE_SCORE_PILL_MARGIN = 8;
const BASE_SCORE_PILL_HEIGHT = 22;
const BASE_LIVE_TIMER_WIDTH = 58;
// Sized to comfortably fit "Up Next" at this pill's own font -- a fixed
// pill for a fixed, known string doesn't need the real Canvas2D
// measurement player names get (that exists because a NAME'S length is
// unpredictable real-world data; this text never changes), just a
// hand-picked value with real headroom, same as liveTimerWidth's own
// already-established convention.
const BASE_UP_NEXT_PILL_WIDTH = 72;
// Whichever of the two right-side status pills (Live's ticking timer,
// Called's static "Up Next") is actually showing on a given match, both
// need the SAME amount of space reserved beside it -- sized to the
// wider of the two so neither one is ever the surprise case that
// doesn't quite fit.
const BASE_STATUS_PILL_WIDTH = Math.max(
  BASE_LIVE_TIMER_WIDTH,
  BASE_UP_NEXT_PILL_WIDTH,
);
const BASE_PROMOTION_PILL_HEIGHT = 22;
const BASE_PROMOTION_PILL_PADDING_X = 14;
const BASE_PROMOTION_PILL_CHAR_WIDTH = 10;
const BASE_PROMOTION_PILL_GAP = 20;
const BASE_PILL_FONT_SIZE = 12;
const BASE_SMALL_PILL_FONT_SIZE = 11;
const BASE_SCORE_PILL_FONT_SIZE = 13;

const BASE_METRICS: BracketMetrics = {
  kx: 1,
  ky: 1,
  boxWidth: BASE_BOX_WIDTH,
  colGap: BASE_COL_GAP,
  matchBoxHeight: BASE_MATCH_BOX_HEIGHT,
  rowHeight: BASE_ROW_HEIGHT,
  rowGap: BASE_ROW_GAP,
  rowTopPad: BASE_ROW_TOP_PAD,
  rowBottomPad: BASE_ROW_BOTTOM_PAD,
  rowDividerY: BASE_ROW_DIVIDER_Y,
  headerHeight: BASE_HEADER_HEIGHT,
  headerFontSize: BASE_HEADER_FONT_SIZE,
  basePaddingX: BASE_PADDING,
  basePaddingY: BASE_PADDING,
  pillMargin: BASE_PILL_MARGIN,
  nameInsetX: BASE_NAME_INSET_X,
  maxPrefixWidth: BASE_MAX_PREFIX_WIDTH,
  playerNameFontSize: BASE_PLAYER_NAME_FONT_SIZE,
  scorePillWidth: BASE_SCORE_PILL_WIDTH,
  scorePillMargin: BASE_SCORE_PILL_MARGIN,
  scorePillHeight: BASE_SCORE_PILL_HEIGHT,
  liveTimerWidth: BASE_LIVE_TIMER_WIDTH,
  upNextPillWidth: BASE_UP_NEXT_PILL_WIDTH,
  statusPillWidth: BASE_STATUS_PILL_WIDTH,
  statusPillHeight: BASE_SCORE_PILL_HEIGHT,
  promotionPillHeight: BASE_PROMOTION_PILL_HEIGHT,
  promotionPillPaddingX: BASE_PROMOTION_PILL_PADDING_X,
  promotionPillCharWidth: BASE_PROMOTION_PILL_CHAR_WIDTH,
  promotionPillGap: BASE_PROMOTION_PILL_GAP,
  pillFontSize: BASE_PILL_FONT_SIZE,
  smallPillFontSize: BASE_SMALL_PILL_FONT_SIZE,
  scorePillFontSize: BASE_SCORE_PILL_FONT_SIZE,
  identifierTagScale: 1,
};

/** Builds the real metrics used to render, from BASE_METRICS times an
 * independent width factor (kx) and height factor (ky) -- see
 * BracketMetrics's own doc above for why the two are kept separate
 * instead of one shared scale. Row-derived fields (matchBoxHeight,
 * rowDividerY) are recomputed from the ALREADY-ky-scaled row constants,
 * not re-derived from BASE_MATCH_BOX_HEIGHT directly, so they can never
 * drift out of sync with each other the way two independently-scaled
 * copies of the same relationship could. */
function scaleBracketMetrics(kx: number, ky: number): BracketMetrics {
  const rowHeight = BASE_ROW_HEIGHT * ky;
  const rowGap = BASE_ROW_GAP * ky;
  const rowTopPad = BASE_ROW_TOP_PAD * ky;
  const rowBottomPad = BASE_ROW_BOTTOM_PAD * ky;
  const liveTimerWidth = BASE_LIVE_TIMER_WIDTH * kx;
  const upNextPillWidth = BASE_UP_NEXT_PILL_WIDTH * kx;
  return {
    kx,
    ky,
    boxWidth: BASE_BOX_WIDTH * kx,
    colGap: BASE_COL_GAP * kx,
    matchBoxHeight: rowTopPad + rowHeight * 2 + rowGap + rowBottomPad,
    rowHeight,
    rowGap,
    rowTopPad,
    rowBottomPad,
    rowDividerY: rowTopPad + rowHeight + rowGap / 2,
    headerHeight: BASE_HEADER_HEIGHT * ky,
    headerFontSize: BASE_HEADER_FONT_SIZE * ky,
    scorePillWidth: BASE_SCORE_PILL_WIDTH * kx,
    scorePillMargin: BASE_SCORE_PILL_MARGIN * kx,
    scorePillHeight: BASE_SCORE_PILL_HEIGHT * ky,
    liveTimerWidth,
    upNextPillWidth,
    statusPillWidth: Math.max(liveTimerWidth, upNextPillWidth),
    statusPillHeight: BASE_SCORE_PILL_HEIGHT * ky,
    promotionPillHeight: BASE_PROMOTION_PILL_HEIGHT * ky,
    promotionPillPaddingX: BASE_PROMOTION_PILL_PADDING_X * kx,
    promotionPillCharWidth: BASE_PROMOTION_PILL_CHAR_WIDTH * kx,
    promotionPillGap: BASE_PROMOTION_PILL_GAP * kx,
    pillFontSize: BASE_PILL_FONT_SIZE * ky,
    smallPillFontSize: BASE_SMALL_PILL_FONT_SIZE * ky,
    scorePillFontSize: BASE_SCORE_PILL_FONT_SIZE * ky,
    identifierTagScale: ky,
    basePaddingX: BASE_PADDING * kx,
    basePaddingY: BASE_PADDING * ky,
    pillMargin: BASE_PILL_MARGIN * kx,
    nameInsetX: BASE_NAME_INSET_X * kx,
    maxPrefixWidth: BASE_MAX_PREFIX_WIDTH * kx,
    playerNameFontSize: BASE_PLAYER_NAME_FONT_SIZE * ky,
  };
}

/** window.innerWidth/innerHeight, kept in sync via a plain `resize`
 * listener -- deliberately NOT a ResizeObserver on this component's own
 * rendered output. Measuring an element to decide that SAME element's
 * own size is what caused a real infinite-render-loop bug earlier this
 * file's history (see git log) -- this only ever reads the window
 * itself, an input this component doesn't influence, so there's no
 * feedback loop to guard against. */
function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** One side's whole drawing's pixel footprint, at whatever `metrics`
 * describes (BASE_METRICS for the k=1 "natural" pre-pass BracketTreeInner
 * runs once to solve kx/ky, or the real scaleBracketMetrics(kx,ky)
 * result for actual rendering) -- BracketTreeInner calls this once per
 * side for EACH of those, and BracketTree calls it again internally
 * (with the final metrics) for its own totalWidth/totalHeight. One
 * function, not several independent copies of the same padding/pill
 * logic that could quietly drift out of sync. */
function computeBracketDimensions(
  side: LayoutSide,
  currentPhaseId: string,
  setsById: SetsById,
  winnersEntrantIds: WinnersEntrantIds | undefined,
  seedProgressionById: SeedProgressionById | undefined,
  phantomSetsById: PhantomSetsById | undefined,
  metrics: BracketMetrics,
): { totalWidth: number; totalHeight: number; paddingLeft: number } {
  const geo = computeSideGeometry(side, {
    boxWidth: metrics.boxWidth,
    colGap: metrics.colGap,
    boxHeight: metrics.matchBoxHeight,
    dividerOffset: metrics.rowDividerY - metrics.matchBoxHeight / 2,
  });
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
      return (
        prog.winner || prog.loser || isSetLive(m.set) || isSetCalled(m.set)
      );
    }),
  );
  const paddingLeft =
    metrics.basePaddingX + (hasLeftPill ? metrics.pillMargin : 0);
  const paddingRight =
    metrics.basePaddingX + (hasRightPill ? metrics.pillMargin : 0);
  return {
    totalWidth: geo.width + paddingLeft + paddingRight,
    totalHeight: geo.height + metrics.basePaddingY * 2 + metrics.headerHeight,
    // Returned too, not just folded into totalWidth -- BracketTree's
    // own render still needs this alone, to know where its drawing
    // group starts (translateX), not just the final total.
    paddingLeft,
  };
}

function BracketTree({
  label,
  side,
  setsById,
  currentPhaseId,
  nowMs,
  winnersEntrantIds,
  seedProgressionById,
  phantomSetsById,
  metrics,
}: {
  label: string;
  side: LayoutSide;
  setsById: SetsById;
  currentPhaseId: string;
  nowMs: number;
  winnersEntrantIds?: WinnersEntrantIds;
  seedProgressionById?: SeedProgressionById;
  phantomSetsById?: PhantomSetsById;
  /** Density-adaptive sizing, solved once by BracketTreeInner and
   * shared by both sides -- see BracketMetrics's own doc. */
  metrics: BracketMetrics;
}) {
  const geo = computeSideGeometry(side, {
    boxWidth: metrics.boxWidth,
    colGap: metrics.colGap,
    boxHeight: metrics.matchBoxHeight,
    // rowDividerY isn't matchBoxHeight / 2 (top/bottom row padding
    // isn't symmetric, see BASE_ROW_DIVIDER_Y's own doc) -- without
    // telling computeSideGeometry that, its connector lines converged
    // on the box's plain geometric center instead of the divider,
    // landing visibly off from where the box's own divider line
    // actually is.
    dividerOffset: metrics.rowDividerY - metrics.matchBoxHeight / 2,
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
  // Same computeBracketDimensions function BracketTreeInner already
  // called (twice: once at BASE_METRICS to solve kx/ky, once more to
  // build the natural-vs-final comparison) -- not a second,
  // independently-written copy of the same padding/pill logic, just
  // the same pure function run again for this side with the final
  // metrics. geo itself (above) still comes from its own direct
  // computeSideGeometry call, not from this -- this only returns the
  // two final totals, not the full per-column layout BracketTree's own
  // JSX still needs.
  const { totalWidth, totalHeight, paddingLeft } = computeBracketDimensions(
    side,
    currentPhaseId,
    setsById,
    winnersEntrantIds,
    seedProgressionById,
    phantomSetsById,
    metrics,
  );
  return (
    <div>
      {/* Same section-label treatment gauntlet-pools.tsx's own pools
          diagram uses for its "Winners Side Bracket"/"Losers Side
          Bracket" captions (sectionLabelStyle, shared via
          broadcast-theme.ts) -- explicit user request to bring the two
          views' look in line; this used to render no visible label at
          all here (label only reached the SVG's own <title> below, for
          screen readers). Color carries the side identity, same
          mint/coral convention as that other view. */}
      <div
        style={{
          ...sectionLabelStyle,
          // Overridden to 300 here specifically, not in sectionLabelStyle
          // itself -- explicit user request for lighter text across this
          // view only; gauntlet-pools.tsx's own "Winners/Losers Side
          // Bracket" captions still use sectionLabelStyle's own 700
          // unchanged, since that wasn't asked for.
          fontWeight: 300,
          color: label === "Winners" ? COLORS.mint : COLORS.coral,
          marginBottom: 8,
        }}
      >
        {label} Bracket
      </div>
      <svg
        role="img"
        // Explicit pixel width/height now, matching viewBox 1:1 -- no
        // CSS scaling layer at all. totalWidth/totalHeight are already
        // computed FROM density-adaptive metrics (kx/ky solved in
        // BracketTreeInner against the real available space), so they
        // already equal the target size directly (for whichever side is
        // naturally wider/the shared height budget); the narrower side
        // (if any) just renders at its own smaller natural size instead
        // of being stretched to match, same visual result the old CSS
        // percentage trick produced, with one fewer moving part. See
        // BracketMetrics's own doc for the full rationale.
        width={totalWidth}
        height={totalHeight}
        style={{ display: "block" }}
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
        <g transform={`translate(${paddingLeft},${metrics.basePaddingY})`}>
          {side.columns.map((colMatches, col) => {
            const x = col * (metrics.boxWidth + metrics.colGap);
            const isCurrent = liveCols.has(col);
            return (
              <g key={col}>
                {/* y is headerHeight - a 26px-at-base offset (scaled by
                    the same ky ratio headerHeight itself used), not just
                    "- 12" -- if both this and the LIVE/NEXT badge's own y
                    (headerHeight - BADGE_HEIGHT/2, see MatchBox) were
                    simple headerHeight deltas, the gap between them would
                    stay 0 regardless of headerHeight. This one sits
                    further from headerHeight's own baseline than the
                    badge does. */}
                <text
                  x={x}
                  y={
                    metrics.headerHeight -
                    26 * (metrics.headerHeight / BASE_HEADER_HEIGHT)
                  }
                  fontSize={metrics.headerFontSize}
                  fontWeight={300}
                  fill={isCurrent ? COLORS.text : COLORS.muted}
                >
                  {colMatches[0]?.set.fullRoundText || ""}
                </text>
              </g>
            );
          })}
          <g transform={`translate(0,${metrics.headerHeight})`}>
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
                metrics={metrics}
              />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}

// A name that's too long to fit now scrolls (see the marquee rendering
// in MatchBox's own row map below) instead of being cut off with an
// ellipsis -- explicit user request, same MARQUEE_KEYFRAMES_CSS cycle
// shape schedule.tsx originally introduced for its own event/description
// text (see that constant's own doc). Only the clan tag prefix still
// truncates (metrics.maxPrefixWidth) -- it's secondary, static-by-design
// information, not the primary thing a viewer is watching scroll by.
// Used to need converting from real px/s into this SVG's own local
// units via a fixed SVG_SCALE factor (the whole SVG used to render at a
// literal pixel multiple of its own viewBox) -- now that this view's
// viewBox units ARE real screen pixels 1:1 (density-adaptive sizing
// bakes the fit directly into the box/row/font metrics, not a
// separate post-hoc CSS/attribute scale, see BracketMetrics's own
// doc), MARQUEE_SPEED_PX_PER_S/MARQUEE_BASE_DURATION_S are used
// directly below with no conversion needed.

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
  metrics,
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
  /** Density-adaptive sizing, see BracketMetrics's own doc. */
  metrics: BracketMetrics;
}) {
  const { set, x, y } = match;
  const winIdx = winningSlotIndex(set);
  const slots = set.slots || [];
  const live = isSetLive(set);
  const called = isSetCalled(set);
  // Base for each row's own <clipPath> id below (row 0/1 append their
  // own suffix) -- unique per MatchBox instance, same reasoning as
  // BracketTree's own liveGlowFilterId: an SVG id has to be unique
  // document-wide for url(#id) to reliably resolve to the right
  // <clipPath>, not whichever same-named one happens to appear first.
  const nameClipIdBase = useId();
  // Flat 3px regardless of state -- matches gauntlet-pools.tsx's own
  // PoolBox, whose border is always 3px too (only the COLOR swaps for
  // live/upcoming, never the weight). Used to be 2px normally and only
  // 3px for live/called, which also meant the divider `<line>` below
  // (computed from this same value, so it never drifts out of sync)
  // shifted its own inset by half a pixel every time a match's state
  // changed -- a flat value removes that too, not just the box-to-box
  // mismatch against PoolBox.
  const boxStrokeWidth = 3;
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
  const row0Y = metrics.rowTopPad + metrics.rowHeight / 2;
  const row1Y =
    metrics.rowTopPad + metrics.rowHeight + metrics.rowGap + metrics.rowHeight / 2;

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
    if (!outgoingLabel) return metrics.boxWidth + 8;
    const promoNearEdgeX =
      metrics.boxWidth + 8 + metrics.statusPillWidth + 8 + metrics.promotionPillGap;
    const gapWidth = promoNearEdgeX - metrics.boxWidth;
    return metrics.boxWidth + (gapWidth - pillWidth) / 2;
  }

  return (
    <g transform={`translate(${x},${y})`}>
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
          width={metrics.boxWidth + 12}
          height={metrics.matchBoxHeight + 12}
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
          metrics={metrics}
        />
      )}
      {row1Label && (
        <PromotionPill
          label={row1Label}
          edgeX={-28}
          boxEdgeX={0}
          y={row1Y}
          side="left"
          metrics={metrics}
        />
      )}
      {(outgoing.winner || outgoing.loser) && (
        <PromotionPill
          label={(outgoing.winner || outgoing.loser)!}
          // Pushed past the status pill (8px gap + its own width) when
          // both are present, so the PILL itself doesn't collide with
          // it -- see the ElapsedTimerPill/UpNextPill render below.
          edgeX={
            metrics.boxWidth +
            (hasStatusPill ? 8 + metrics.statusPillWidth + 8 : 0)
          }
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
          boxEdgeX={metrics.boxWidth}
          y={metrics.rowDividerY}
          side="right"
          metrics={metrics}
        />
      )}
      <rect
        x={0}
        y={0}
        width={metrics.boxWidth}
        height={metrics.matchBoxHeight}
        // 10, not 6 -- matches the soft glow rect's own rx just above
        // (it was already 10, so a live match's square-ish 6px box used
        // to sit oddly inside its own rounder halo), and reads closer
        // to gauntlet-pools.tsx's own PoolBox (18px, on a much bigger
        // box -- 10 is the proportionate match for MatchBox's much
        // smaller footprint, not a literal copy of that number).
        rx={10}
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
        y1={metrics.rowDividerY}
        x2={metrics.boxWidth - boxStrokeWidth / 2}
        y2={metrics.rowDividerY}
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
          x={statusPillX(metrics.liveTimerWidth)}
          y={metrics.rowDividerY}
          startedAt={set.startedAt}
          nowMs={nowMs}
          color={COLORS.live}
          metrics={metrics}
        />
      )}
      {called && (
        <UpNextPill
          x={statusPillX(metrics.upNextPillWidth)}
          y={metrics.rowDividerY}
          color={COLORS.called}
          metrics={metrics}
        />
      )}
      {set.identifier && (
        <IdentifierTag
          label={set.identifier}
          y={metrics.rowDividerY}
          metrics={metrics}
        />
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
        const scorePillX =
          metrics.boxWidth - metrics.scorePillWidth - metrics.scorePillMargin;
        // Each player's own "box" within the match -- bounded by the
        // match's own outer edge on one side and the divider line on the
        // other, NOT split evenly by rowHeight/rowGap/rowTopPad/
        // rowBottomPad (those only set the OVERALL match box's
        // proportions -- see matchBoxHeight/rowDividerY's own docs --
        // they were never meant to describe where each individual row's
        // own visual boundary sits). Row 0's own box is [0,
        // rowDividerY], row 1's is [rowDividerY, matchBoxHeight] --
        // confirmed these aren't equal spans at this file's base metrics
        // (the divider isn't exactly at the box's own geometric
        // midpoint, BASE_ROW_DIVIDER_Y=45 vs BASE_MATCH_BOX_HEIGHT/2=43),
        // which is exactly why centering row content against a flat
        // rowHeight-tall slice (an earlier approach) didn't actually
        // match where the real outer-border-to-divider boundary sits.
        const rowTop = i === 0 ? 0 : metrics.rowDividerY;
        const rowBottom = i === 0 ? metrics.rowDividerY : metrics.matchBoxHeight;
        const rowCenterY = (rowTop + rowBottom) / 2;
        // Relative to rowCenterY (0 = center, since the row's own <g>
        // below translates to rowCenterY directly) -- unlike
        // scorePillX, this can't be a single row-independent constant
        // anymore, since row 0 and row 1's own boxes aren't the same
        // height. Half of metrics.scorePillHeight, negated -- the pill
        // itself is drawn from `y={scorePillY}` down by its own full
        // height, so this centers it on rowCenterY (0) the same way a
        // literal -11 always centered the old fixed 22-tall pill.
        const scorePillY = -metrics.scorePillHeight / 2;
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
        // Flat 300 regardless of isWinner now -- explicit user request
        // for lighter text across this whole view; winner/loser is
        // still distinguished by nameColor, just not by weight anymore.
        const rowFontWeight = 300;
        // Only a real, filled slot has a clan tag to show -- a
        // placeholder/TBD row's own "name" text (e.g. "winner of A") has
        // no entrant, so this is naturally null for those already.
        // Still capped to metrics.maxPrefixWidth so a long one can't
        // crowd out the name it's labeling -- the prefix stays
        // truncated/static even though the NAME below no longer is (see
        // nameOverflows' own doc); it's secondary, static-by-design
        // information, not the primary thing a viewer is watching
        // scroll by.
        const prefix = slot?.entrant?.participants?.[0]?.prefix || null;
        const displayPrefix = prefix
          ? truncateToWidth(
              prefix,
              metrics.maxPrefixWidth,
              metrics.playerNameFontSize,
              rowFontWeight,
            )
          : null;
        // Called's bell + the (possibly-truncated) clan tag, together:
        // whatever sits BEFORE the name and stays completely static,
        // never part of the marquee below. Measured explicitly (not left
        // to SVG's own text flow to place it) so the marquee's own clip
        // region can start exactly where this leaves off -- two
        // separate <text> elements now, not one <text> with a <tspan>
        // and trailing plain text, since the marquee needs its own
        // independently-clippable, independently-animated element.
        const bellPrefix = called && slot?.entrant ? "🔔 " : "";
        const staticPrefixText = displayPrefix
          ? `${bellPrefix}${displayPrefix} `
          : bellPrefix;
        const staticPrefixWidth = staticPrefixText
          ? measureTextWidth(
              staticPrefixText,
              metrics.playerNameFontSize,
              rowFontWeight,
            )
          : 0;
        // A name row's real available width, before the score pill
        // starts: from metrics.nameInsetX to metrics.boxWidth -
        // metrics.scorePillWidth - metrics.scorePillMargin -- recomputed
        // from the now-scaled values every render, not a flat scaled
        // copy of the old fixed 146px value, so this stays exactly
        // accurate regardless of kx.
        const nameRowAvailableWidth =
          metrics.boxWidth -
          metrics.nameInsetX -
          metrics.scorePillWidth -
          metrics.scorePillMargin;
        const nameAvailableWidth = Math.max(
          0,
          nameRowAvailableWidth - staticPrefixWidth,
        );
        const nameWidth = measureTextWidth(
          name,
          metrics.playerNameFontSize,
          rowFontWeight,
        );
        // Scrolls instead of truncating with an ellipsis when it doesn't
        // fit -- explicit user request, reusing marquee.tsx's own
        // MARQUEE_KEYFRAMES_CSS cycle shape (rendered once per overlay
        // instance, see BracketTreeInner's own <style> tag) adapted for
        // SVG: an HTML overflow:hidden box has no SVG equivalent, so
        // this clips via <clipPath> instead, on a separate stationary
        // wrapper <g> from the one that actually animates (see the
        // render below) -- putting both the clip AND the animated
        // transform on the SAME element risks the clip region itself
        // sliding along with the animation instead of staying fixed,
        // depending on transform/clip evaluation order, which splitting
        // them across two elements sidesteps entirely. A name that
        // already fits renders with no clip-path/animation at all and
        // is visually identical to plain static text.
        const nameOverflows = nameWidth > nameAvailableWidth;
        const nameMarqueeDistance = nameOverflows
          ? nameWidth - nameAvailableWidth
          : 0;
        const nameMarqueeDuration =
          MARQUEE_BASE_DURATION_S +
          nameMarqueeDistance / MARQUEE_SPEED_PX_PER_S;
        const nameClipId = `${nameClipIdBase}-name-${i}`;
        // One shared baseline for both the static prefix text and the
        // marqueeing name text below, so they visually align on the same
        // line -- measured against `name` itself (the row's main
        // content), not the prefix (Canvas2D's ascent/descent metrics
        // aren't reliable for the bell emoji specifically, and the
        // prefix is typically similar cap-height regardless).
        const nameBaselineY = verticalCenterBaselineY(
          name,
          0,
          metrics.playerNameFontSize,
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
              {staticPrefixText && (
                <text
                  x={metrics.nameInsetX}
                  y={nameBaselineY}
                  fill={nameColor}
                  fontSize={metrics.playerNameFontSize}
                  fontWeight={rowFontWeight}
                  fontStyle={slot?.entrant ? "normal" : "italic"}
                >
                  {/* Called shows a bell next to both entrants -- matches
                      start.gg's own report view, which marks Called this
                      way instead of (or alongside) the outline. */}
                  {bellPrefix}
                  {displayPrefix && (
                    <tspan fill={COLORS.prefix}>{displayPrefix} </tspan>
                  )}
                </text>
              )}
              <clipPath id={nameClipId}>
                <rect
                  x={0}
                  y={-metrics.playerNameFontSize}
                  width={nameAvailableWidth}
                  height={metrics.playerNameFontSize * 2}
                />
              </clipPath>
              {/* Stationary wrapper -- carries the one-time position
                  translate AND the clip-path, neither of which ever
                  changes. The animated <text> nests one level inside,
                  entirely separate from this element (see nameOverflows'
                  own doc above for why that split matters). */}
              <g
                transform={`translate(${metrics.nameInsetX + staticPrefixWidth},0)`}
                clipPath={`url(#${nameClipId})`}
              >
                <text
                  x={0}
                  y={nameBaselineY}
                  fill={nameColor}
                  fontSize={metrics.playerNameFontSize}
                  fontWeight={rowFontWeight}
                  fontStyle={slot?.entrant ? "normal" : "italic"}
                  style={
                    nameOverflows
                      ? ({
                          "--marquee-distance": `-${nameMarqueeDistance}px`,
                          animation: `broadcastMarqueeScroll ${nameMarqueeDuration}s ease-in-out infinite`,
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  {name}
                </text>
              </g>
              {isDq ? (
                <g>
                  <rect
                    x={scorePillX}
                    y={scorePillY}
                    width={metrics.scorePillWidth}
                    height={metrics.scorePillHeight}
                    rx={4}
                    fill={COLORS.dq}
                  />
                  {/* Baseline measured via verticalCenterBaselineY at
                      the pill's own true center (scorePillY +
                      scorePillHeight/2) -- scorePillY already centers
                      this pill ON the row, so centering the text ON the
                      pill also centers it on the row. See that
                      function's own doc for why it measures real glyph
                      ink instead of trusting dominantBaseline="central"
                      (tried first, confirmed live still not reliable
                      for this custom font). */}
                  <text
                    x={scorePillX + metrics.scorePillWidth / 2}
                    y={verticalCenterBaselineY(
                      "DQ",
                      scorePillY + metrics.scorePillHeight / 2,
                      metrics.smallPillFontSize,
                      300,
                    )}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize={metrics.smallPillFontSize}
                    fontWeight={300}
                  >
                    DQ
                  </text>
                </g>
              ) : showWinCheck ? (
                <g>
                  <rect
                    x={scorePillX}
                    y={scorePillY}
                    width={metrics.scorePillWidth}
                    height={metrics.scorePillHeight}
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
                      centers correctly regardless of font/browser. Offsets
                      (8/13/22 horizontal, 11/16/6 vertical) were tuned
                      against the base 30x22 pill -- scaled by metrics.kx/
                      ky respectively so the checkmark keeps the same
                      proportion of the pill regardless of how big/small
                      the pill itself has scaled, not a fixed shape
                      floating inside a resized one. strokeWidth follows
                      ky too, for the same reason. */}
                  <path
                    d={`M${scorePillX + 8 * metrics.kx},${scorePillY + 11 * metrics.ky} L${scorePillX + 13 * metrics.kx},${scorePillY + 16 * metrics.ky} L${scorePillX + 22 * metrics.kx},${scorePillY + 6 * metrics.ky}`}
                    stroke="#fff"
                    strokeWidth={2.5 * metrics.ky}
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
                      width={metrics.scorePillWidth}
                      height={metrics.scorePillHeight}
                      rx={4}
                      fill={isWinner ? COLORS.winnerScore : COLORS.loserScore}
                    />
                    {/* Same measured-baseline fix as the DQ pill's own
                        text above. */}
                    <text
                      x={scorePillX + metrics.scorePillWidth / 2}
                      y={verticalCenterBaselineY(
                        String(score),
                        scorePillY + metrics.scorePillHeight / 2,
                        metrics.scorePillFontSize,
                        300,
                      )}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={metrics.scorePillFontSize}
                      fontWeight={300}
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
  metrics,
}: {
  x: number;
  y: number;
  startedAt: number;
  nowMs: number;
  color: string;
  metrics: BracketMetrics;
}) {
  const elapsedSec = Math.max(0, Math.round(nowMs / 1000 - startedAt));
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  const label = `${mm}:${ss.toString().padStart(2, "0")}`;
  const height = metrics.statusPillHeight;
  return (
    <g transform={`translate(${x},${y - height / 2})`}>
      {/* rx={height/2} (a true pill/capsule), not a barely-rounded
          rx={4} rect -- matches PromotionPill's own shape further down
          this file, and gauntlet-pools.tsx's statusPillStyle
          (borderRadius: 999), whose "Live"/"Final"/"Upcoming" pill this
          is the bracket view's own equivalent of. */}
      <rect
        width={metrics.liveTimerWidth}
        height={height}
        rx={height / 2}
        fill={color}
      />
      {/* Baseline measured via verticalCenterBaselineY, not
          dominantBaseline="central" -- tried that first (matching
          IdentifierTag's own established pattern), but confirmed live it
          still wasn't reliably centering every pill in this custom font.
          See that function's own doc for why measuring the real glyph
          ink is more robust than trusting the font's own baseline-table
          metrics. */}
      <text
        x={metrics.liveTimerWidth / 2}
        y={verticalCenterBaselineY(label, height / 2, metrics.pillFontSize, 300)}
        textAnchor="middle"
        // COLORS.panel (dark), not white -- matches
        // gauntlet-pools.tsx's own statusPillStyle convention (dark
        // text on a bright colored pill, not white-on-bright, which
        // reads as low-contrast against a bright fill like COLORS.live
        // or COLORS.called).
        fill={COLORS.panel}
        fontWeight={300}
        fontSize={metrics.pillFontSize}
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
  metrics,
}: {
  x: number;
  y: number;
  color: string;
  metrics: BracketMetrics;
}) {
  const height = metrics.statusPillHeight;
  return (
    <g transform={`translate(${x},${y - height / 2})`}>
      {/* Same true-pill shape as ElapsedTimerPill -- see its own doc. */}
      <rect
        width={metrics.upNextPillWidth}
        height={height}
        rx={height / 2}
        fill={color}
      />
      {/* Measured baseline, not dominantBaseline="central" -- see
          ElapsedTimerPill's own doc on this same fix, same reasoning
          applies here (mutually exclusive with it, but otherwise an
          identical shape). "UP NEXT" (all-caps in the source text, not
          a CSS textTransform -- SVG <text> here), matching
          gauntlet-pools.tsx's own STATUS_LABELS pill convention
          (Title Case source + textTransform: uppercase in HTML/CSS;
          simplest to just spell it out directly for this one static
          two-word SVG label rather than reach for a CSS property that
          doesn't gain anything over hardcoding the two words). Same
          COLORS.panel text fill fix as ElapsedTimerPill, for the same
          contrast reason. */}
      <text
        x={metrics.upNextPillWidth / 2}
        y={verticalCenterBaselineY(
          "UP NEXT",
          height / 2,
          metrics.pillFontSize,
          300,
        )}
        textAnchor="middle"
        fill={COLORS.panel}
        fontWeight={300}
        fontSize={metrics.pillFontSize}
      >
        UP NEXT
      </text>
    </g>
  );
}

// Shared between PromotionPill's own rendering below and MatchBox's
// status-pill centering math, which needs to predict where the outgoing
// promotion pill's own near edge will actually land -- without this
// living in one place, MatchBox would have to duplicate the same sizing
// formula by hand and risk drifting out of sync with it.
function promotionPillWidth(label: string, metrics: BracketMetrics): number {
  return Math.max(
    56 * metrics.kx,
    label.length * metrics.promotionPillCharWidth +
      metrics.promotionPillPaddingX * 2,
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
  metrics,
}: {
  label: string;
  edgeX: number;
  y: number;
  side: "left" | "right";
  boxEdgeX?: number;
  metrics: BracketMetrics;
}) {
  const height = metrics.promotionPillHeight;
  const width = promotionPillWidth(label, metrics);
  const gap = metrics.promotionPillGap;
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
        y={verticalCenterBaselineY(label, y, metrics.smallPillFontSize, 300)}
        textAnchor="middle"
        fill={COLORS.muted}
        fontSize={metrics.smallPillFontSize}
        fontWeight={300}
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
function IdentifierTag({
  label,
  y,
  metrics,
}: {
  label: string;
  y: number;
  metrics: BracketMetrics;
}) {
  // Every coordinate below (the path, x=12, the baseline args) stays at
  // its own original, unscaled local value -- this outer transform does
  // ALL the scaling, uniformly, for the whole shape at once. translate
  // uses -16*s/y-10*s (not the plain -16/y-10 a naive read might expect)
  // specifically so the tag's own local anchor point (16,10 -- roughly
  // its visual center, where the label sits) maps to the exact same
  // final position (0, y) at every scale: plug px=16,py=10 into
  // `(s*(px-16), y+s*(py-10))` (what this composition works out to) and
  // the s cancels out entirely. Without that, the tag would drift away
  // from rowDividerY as metrics.identifierTagScale moved away from 1,
  // instead of just growing/shrinking in place around it.
  const s = metrics.identifierTagScale;
  return (
    <g transform={`translate(${-16 * s},${y - 10 * s}) scale(${s})`}>
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
        y={verticalCenterBaselineY(label, 10, 11, 300)}
        textAnchor="middle"
        fill="#fff"
        fontWeight={300}
        fontSize={11}
      >
        {label}
      </text>
    </g>
  );
}
