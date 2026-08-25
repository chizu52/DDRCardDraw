/**
 * Message shapes for the "capture-bridge" party (see capture-bridge-server.ts)
 * -- a small, standalone relay so a browser anywhere can trigger a Score
 * Scope capture running on a machine it may have no direct network path to
 * (no LAN requirement, no mixed-content HTTPS/HTTP issue), without Score
 * Scope becoming a participant in the app's own Redux-action-sync protocol
 * (party/types.ts). Deliberately a SEPARATE, narrower protocol: just two
 * things travel over it (a capture request, a capture result), so it can't
 * be broken by unrelated changes to how room state itself syncs, and Score
 * Scope's own client never has to speak that protocol at all.
 *
 * Wire shape mirrors dashboard.tsx's existing CvCaptureResult exactly --
 * the browser's HTTP response is one of these, unchanged from what it
 * already expects from a direct localhost:8765 call, so only the request's
 * target URL needs to change on the dashboard side once this is wired up.
 */

/** One on-screen player column's captured songs -- see dashboard.tsx's
 * CaptureResultRow / parse-pools.ts's mergeCaptureIntoPool. */
export interface CaptureResultRow {
  column: number;
  songs: (string | null)[];
}

export interface CvCaptureResult {
  ok: boolean;
  reason?: string;
  read_count?: number;
  archived?: number;
  results?: CaptureResultRow[];
}

/** Score Scope -> server: identifies this connection as the capture bridge
 * for the room it connected to, authenticated by the pairing token shown
 * in ddr.tools' own settings for that room (see the server's GET handler).
 * Required before any captureRequest is forwarded to this connection --
 * an unauthenticated socket is just a socket, not "the" bridge. */
export interface BridgeRegister {
  type: "register";
  token: string;
}

/** server -> Score Scope: the register above was accepted. This
 * connection is now the room's active bridge (replacing any previous
 * one, last-to-register wins). */
export interface BridgeRegistered {
  type: "registered";
}

/** server -> Score Scope: the register above was refused (wrong/missing
 * token) -- this connection is NOT the bridge and won't receive
 * captureRequests. */
export interface BridgeRegisterRejected {
  type: "registerRejected";
  reason: string;
}

/** server -> Score Scope: forward of a browser's capture click.
 * requestId correlates the eventual captureResult back to the specific
 * HTTP request that's still waiting on it -- the server may have several
 * outstanding at once (unlikely in practice, but not impossible if two
 * operators click Capture close together). */
export interface CaptureRequestMsg {
  type: "captureRequest";
  requestId: string;
  pool: string;
}

/** Score Scope -> server: the result of a previously-forwarded
 * captureRequest, matched back to its waiting HTTP response by
 * requestId. */
export interface CaptureResultMsg {
  type: "captureResult";
  requestId: string;
  result: CvCaptureResult;
}

/** All messages Score Scope may send to the capture-bridge party. */
export type BridgeClientMessage = BridgeRegister | CaptureResultMsg;

/** All messages the capture-bridge party may send to Score Scope. */
export type BridgeServerMessage =
  | BridgeRegistered
  | BridgeRegisterRejected
  | CaptureRequestMsg;
