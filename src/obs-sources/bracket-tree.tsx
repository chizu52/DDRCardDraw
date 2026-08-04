import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
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

// Long fallback poll, same rationale as pool-results.tsx's
// FALLBACK_POLL_INTERVAL_MS -- the Matches Settings tab's refresh button
// (bracketRefreshedAt) is the fast path, this just covers the overlay
// being left running with nobody around to trigger that.
const FALLBACK_POLL_INTERVAL_MS = 60_000;

// Now the follow-up promised when this was first built to match
// start.gg's own look exactly (see the git history for that version) --
// this app's own dark broadcast palette (same tokens as pool-results.tsx:
// panel #1c2127, border #30343c, text #f6f7f9, green advance/winner
// accent), sized up and higher-contrast than a website's own text, since
// a stream viewer reads this from further away and at lower effective
// resolution than someone actively browsing start.gg. Specific choices
// aimed at "keeping up," not just legibility:
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
  panel: "#1c2127",
  border: "#30343c",
  text: "#f6f7f9",
  textLoser: "#9aa1ab",
  textTbd: "#5c636c",
  muted: "#8a919c",
  accent: "#2d72d2",
  winnerScore: "#3dcc91",
  loserScore: "#3a3f47",
  dq: "#cd4246",
  identifier: "#454b54",
  connector: "#3a3f47",
  // Live match outline (and the elapsed-timer pill's fill) -- same green
  // as winnerScore/checkmark, not a separate color. Outline only, no box
  // fill tint (see the match box's own rect below).
  live: "#3dcc91",
  // Called (assigned a station, not yet started) -- an outline only too,
  // same treatment as Live, just yellow.
  called: "#e6c02e",
  // A player's clan/sponsor tag (start.gg's "prefix") -- deliberately a
  // hue nothing else in this palette uses (every other color already
  // carries a meaning: green=live/winner, yellow=called, red=DQ,
  // blue=header accent), so a tag reads as its own distinct category at
  // a glance instead of blending into or being confused with a status
  // color.
  prefix: "#a78bfa",
};
const FONT_FAMILY = "Roboto, Helvetica, Arial, sans-serif";

export function BracketTreeOverlay() {
  const [params] = useSearchParams();
  const apiKey = params.get("apiKey");

  // A dedicated client scoped to this key, independent of the app's own
  // startgg-gql/index.ts urqlClient (which reads its token from this
  // device's localStorage atom) -- same reasoning as pool-results.tsx's
  // apiKey/spreadsheetId: an OBS browser source is a separate, isolated
  // profile, so credentials are baked into the URL rather than relied on
  // from local storage. No cacheExchange -- this overlay always wants a
  // fresh read (see the network-only reexecuteQuery below), so a
  // normalized cache adds nothing but risk: it needs __typename on every
  // object to normalize entities correctly, which PhaseBracketDoc doesn't
  // request (confirmed this the hard way -- with graphcache in place, a
  // response missing __typename silently resolved as "phase not found"
  // instead of erroring loudly).
  const client = useMemo(() => {
    if (!apiKey) return null;
    return new Client({
      url: "https://api.start.gg/gql/alpha",
      fetchOptions: { headers: { Authorization: `Bearer ${apiKey}` } },
      exchanges: [fetchExchange],
    });
  }, [apiKey]);

  const phaseId = useAppState((s) => s.event.selectedBracketPhase);

  if (!apiKey) {
    return (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        Missing "apiKey" query parameter. Use the "Copy Overlay URL" button in
        the Matches Settings tab rather than building this URL by hand.
      </Callout>
    );
  }
  if (!phaseId) {
    return (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        No bracket selected. Pick one from the Matches Settings tab.
      </Callout>
    );
  }

  return (
    <UrqlProvider value={client!}>
      <BracketTreeInner phaseId={phaseId} />
    </UrqlProvider>
  );
}

function BracketTreeInner({ phaseId }: { phaseId: string }) {
  const refreshedAt = useAppState((s) => s.event.bracketRefreshedAt);
  const [result, reexecuteQuery] = useStartggPhaseBracket(phaseId);
  // Ticks once a second so ElapsedTimerPill's mm:ss actually counts up on
  // screen. Date.now() has to live inside the effect below, not called
  // directly during render (React's purity rule -- an impure call in the
  // render body can produce inconsistent results across renders of the
  // same state; an effect is explicitly the sanctioned place for this).
  // Starts at 0 rather than Date.now() for the same reason -- the effect
  // sets the real value on mount, a render or two before that just shows
  // 0:00 briefly.
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
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
    setNowMs(Date.now());
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

  if (result.fetching && !result.data) {
    return null; // avoid a flash of an empty/error box on first load
  }
  if (result.error) {
    return (
      <Callout intent="danger" style={{ maxWidth: 480 }}>
        {result.error.message}
      </Callout>
    );
  }
  const phase = result.data?.phase;
  if (!phase) {
    return (
      <Callout intent="warning" style={{ maxWidth: 480 }}>
        That phase wasn't found -- it may have been deleted, or the API key
        doesn't have access to it.
      </Callout>
    );
  }

  const layout = layoutBracket(sets);
  const winnersEntrantIds = indexWinnersEntrantIds(layout.winners);
  const seedProgressionById = indexSeedProgressionById(
    phase.seeds?.nodes || [],
  );

  return (
    <div
      style={{
        fontFamily: FONT_FAMILY,
        background: "#111418",
        padding: 20,
        borderRadius: 8,
        display: "inline-block",
      }}
    >
      <div
        style={{
          color: COLORS.text,
          fontWeight: 700,
          fontSize: 40,
          marginBottom: 20,
          textAlign: "center",
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
            // set, so passing it there too would wrongly suppress its
            // own legitimate pill. See indexWinnersEntrantIds's doc.
            winnersEntrantIds={winnersEntrantIds}
            seedProgressionById={seedProgressionById}
            phantomSetsById={phantomSetsById}
          />
        )}
      </div>
    </div>
  );
}

// How many rounds of "fetch whatever unresolved phantom ids the last
// round turned up" to run before giving up -- a real bye-collapse chain
// (confirmed one level deep for Stage 5) shouldn't ever need many hops,
// this is purely a safety cap against a pathological/cyclical data shape
// looping forever, not a limit expected to actually bind in practice.
const MAX_PHANTOM_HOPS = 5;

/** Fetches whatever bye-collapse phantom sets (see PhantomSet's own doc
 * in bracket-layout.ts) this phase's real sets reference via a "set"
 * prereq id that never came back in the main phase.sets query -- start
 * .gg only materializes REAL sets there; a still-unstarted bracket's
 * deeper structural rounds are only reachable one `set(id:)` lookup at a
 * time (confirmed directly: Stage 5's losers round 1 needed exactly
 * this to reach the real promotion underneath a bye-only phantom match).
 * Loops via collectUnresolvedSetPrereqIds, since a freshly-fetched
 * phantom set can itself reference another, deeper phantom id -- not
 * assumed to always bottom out in exactly one hop, just bounded by
 * MAX_PHANTOM_HOPS so a pathological chain can't loop forever. */
function usePhantomSets(
  sets: (StartggSet | null)[],
  setsById: SetsById,
): PhantomSetsById {
  const client = useClient();
  const [phantomSetsById, setPhantomSetsById] = useState<PhantomSetsById>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const collected: PhantomSetsById = new Map();
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
      if (!cancelled) setPhantomSetsById(new Map(collected));
    })();
    return () => {
      cancelled = true;
    };
  }, [sets, setsById, client]);

  return phantomSetsById;
}

/** One GraphQL request per hop, aliasing every id in that hop's batch
 * together (s0, s1, ...) instead of one request per id. A raw query
 * string (not a static gql document -- there's no fixed set of ids to
 * write a document for ahead of time) built fresh per call; urql's
 * Client.query accepts a plain string directly (DocumentInput = string
 * | DocumentNode | TypedDocumentNode, confirmed against @urql/core's own
 * type declarations), so no gql-tag parsing dance is needed. Requests
 * only the minimal fields resolveThroughByes/describeEmptySlot/
 * incomingProgressionLabel actually read -- not a full Set. */
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

// Tightened up from this component's first "readability" pass to read
// closer to start.gg's own, more compact proportions -- this is a spacing
// pass only, the dark broadcast palette/LIVE badge/etc are unchanged
// (colors are being revisited separately later).
const BOX_WIDTH = 200;
// Must comfortably clear a live match's elapsed-timer pill, which
// extends 8px (gap) + LIVE_TIMER_WIDTH (58px) = 66px past its own box's
// right edge -- 56 wasn't enough (confirmed live: the timer pill visibly
// overlapped the next column's box), so this needs to be bigger than
// that 66px with real room to spare, not just barely past it.
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
  // since more than one match can be live at once in DIFFERENT columns
  // (confirmed directly against real Stage 2 data: "Losers Round 1" and
  // "Losers Quarter-Final" were both live simultaneously). Each one's
  // header gets a soft glow so "what round are we in" reads at a glance
  // instead of needing to scan every column for the live match yourself
  // -- findIndex's old single-column version silently dropped every
  // live column after the first.
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
      <div
        style={{
          color: COLORS.muted,
          fontWeight: 700,
          fontSize: 30,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <svg
        role="img"
        width={totalWidth}
        height={totalHeight}
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
                {/* y is HEADER_HEIGHT - 26, not just "- 12", specifically
                    so it does NOT scale 1:1 with the LIVE/NEXT badge's own
                    y (HEADER_HEIGHT - BADGE_HEIGHT/2, see MatchBox) --
                    when both offsets were simple HEADER_HEIGHT deltas, the
                    gap between them stayed exactly 0 no matter how big
                    HEADER_HEIGHT got (confirmed via getBoundingClientRect:
                    36, 44, and 50 all measured a 0px gap). This one has to
                    sit further from HEADER_HEIGHT's own baseline than the
                    badge does, not just closer to it. */}
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
  // One independent pill per PROMOTED PLAYER, not per box -- if both
  // slots in a match are genuinely promoted, both get their own pill and
  // their own straight (never diagonal) line at their own row, duplicated
  // rather than merged into one. Strictly confirmed data only
  // (incomingProgressionLabel) -- no fallback for a still-undetermined
  // slot, deliberately (see that function's own doc comment for why
  // every fallback tried here turned out wrong). setsById/phantomSetsById
  // let this see through a losers-side bye-collapse chain to the real
  // seed underneath (see resolveThroughByes) -- without them a slot fed
  // by an unmaterialized phantom set just looks like an ordinary
  // same-phase connector with nothing to show a pill for.
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
          prefix && prefix.length > 10 ? prefix.slice(0, 9) + "…" : prefix;
        const nameBudget = displayPrefix
          ? Math.max(8, 20 - displayPrefix.length - 1)
          : 20;
        const displayName =
          name.length > nameBudget ? name.slice(0, nameBudget - 1) + "…" : name;
        return (
          <g key={i}>
            <g transform={`translate(0,${rowY})`}>
              <text
                x={NAME_INSET_X}
                y={ROW_HEIGHT / 2 + 5}
                fill={nameColor}
                fontSize={15}
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
 * start.gg's own dotted connector into/out of the pill (verified
 * directly against a real screenshot -- always one level line into one
 * pill, never split or angled toward a specific row).
 *
 * The line spans from the box edge to the pill's OWN near edge (gap
 * away from the box), not from the box edge to a point `gap` away that
 * happens to land inside the pill's own footprint -- an earlier version
 * did the latter (computed the line's far endpoint as a fixed offset
 * from edgeX without ever checking where the pill itself actually
 * started), which put the entire line underneath the pill's own opaque
 * rect, 100% hidden the whole time despite genuinely existing in the
 * DOM (confirmed the hard way: every "is the line drawn" check kept
 * saying yes, because it was -- just invisibly, under an opaque shape on
 * top of it). Rewritten so the pill's position is computed first, and
 * the line explicitly stops at its edge.
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
