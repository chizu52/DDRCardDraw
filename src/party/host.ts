import type { AppState } from "../state/root-reducer";

export const PARTYKIT_HOST =
  process.env.NODE_ENV === "development"
    ? "localhost:8787" // wrangler dev's default port, not partykit dev's 1999
    : "party.soundvoltex.com";

const ENDPOINT_PROTOCOL =
  process.env.NODE_ENV === "development" ? "http" : "https";

export function partykitEndpoint(roomName: string) {
  return `${ENDPOINT_PROTOCOL}://${PARTYKIT_HOST}/parties/main/${roomName}`;
}

/** The "capture-bridge" party (see party/capture-bridge-server.ts, the
 * CaptureBridge class) -- lets Score Scope (the companion CV score reader)
 * connect to a specific room from anywhere, instead of only ever being
 * reachable at localhost. Same host/protocol as the main room-sync
 * connection above, just a different party name in the URL -- see
 * tournament-mode/dashboard.tsx's MatchesImportPanel for where this is
 * both displayed (for pairing Score Scope) and POSTed to (to trigger a
 * capture).
 *
 * Hyphenated, not underscored: partyserver's routePartykitRequest derives
 * each party's URL segment by kebab-casing its Durable Object binding name
 * (CaptureBridge -> "capture-bridge"), so this has to match that exactly --
 * see server.ts's fetch handler and wrangler.jsonc's durable_objects.bindings. */
export function captureBridgeEndpoint(roomName: string) {
  return `${ENDPOINT_PROTOCOL}://${PARTYKIT_HOST}/parties/capture-bridge/${roomName}`;
}

export async function getPartykitState(roomName: string): Promise<AppState> {
  const req = await fetch(partykitEndpoint(roomName));
  return await req.json();
}
