import { Server, type Connection, type WSMessage } from "partyserver";
import type {
  BridgeClientMessage,
  CaptureRequestMsg,
  CvCaptureResult,
} from "./capture-bridge-types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Same window dashboard.tsx's own AbortController already waits on for a
 * direct localhost:8765 call -- kept identical here so a relayed capture
 * doesn't newly time out sooner (or hang longer) than a direct one did. */
const CAPTURE_TIMEOUT_MS = 35000;

const PAIRING_TOKEN_KEY = "pairingToken";

interface PendingCapture {
  resolve: (result: CvCaptureResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A small, standalone relay letting a browser anywhere trigger a Score
 * Scope capture, without Score Scope needing to be independently
 * network-reachable (no LAN requirement, no port-forwarding, no
 * mixed-content HTTPS/HTTP problem once ddr.tools itself is served over
 * HTTPS) and without becoming a participant in the app's own
 * Redux-action-sync protocol (server.ts, types.ts) -- see
 * capture-bridge-types.ts's own doc for why that split matters.
 *
 * Shape of the whole thing: Score Scope opens a WebSocket here and sends
 * a `register` with this room's pairing token (see the GET handler
 * below); once accepted, it's "the bridge" for this room. A browser's
 * Capture click is a plain POST to this same party -- if a bridge is
 * registered, the request is forwarded to it over that WebSocket and
 * this POST's response waits (up to CAPTURE_TIMEOUT_MS) for the matching
 * `captureResult` to come back, so the HTTP round trip from the
 * dashboard's point of view looks exactly like the direct-to-localhost
 * call it's replacing.
 *
 * Ported from the old `implements Party.Server` (partykit/server) shape to
 * `extends Server` (partyserver), which deploys via plain `wrangler deploy`
 * instead of the `partykit` CLI -- see wrangler.jsonc's own comment for why.
 * Wire protocol and behavior are unchanged; only the framework glue moved:
 * `this.room.id` -> `this.name`, `this.room.storage` -> `this.ctx.storage`,
 * and `onMessage`'s params are (connection, message) instead of
 * (message, sender).
 */
export class CaptureBridge extends Server<Env> {
  /** the one Score Scope connection currently registered for this room,
   * if any -- in-memory only, same reasoning as the main server's `tail`:
   * a restart/hibernation drops every socket anyway, so there's nothing
   * durable to reconstruct on wake, Score Scope's own client just
   * reconnects and re-registers. */
  private bridgeConnection: Connection | null = null;

  /** capture requests forwarded to the bridge that haven't resolved yet,
   * keyed by requestId -- almost always at most one entry, but not
   * assumed to be: nothing stops two operators clicking Capture close
   * together. */
  private pending = new Map<string, PendingCapture>();

  private log(event: string, details = "") {
    console.log(
      `[capture-bridge] room=${this.name} ${event}${details ? ` ${details}` : ""}`,
    );
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      const token = await this.getOrCreateToken();
      return Response.json({ token }, { headers: CORS_HEADERS });
    }

    if (request.method === "POST") {
      return this.handleCaptureRequest(request);
    }

    return new Response("Method not allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  /** Reads the room's pairing token from durable storage, generating and
   * persisting one on first request -- same lazy-create-on-first-GET
   * pattern as the token only ever needing to exist once an operator
   * actually opens this room's settings and asks for it. Unauthenticated
   * (any GET gets it): consistent with the rest of this app's access
   * model, where the room URL itself is the only credential -- see
   * server.ts's own GET handler, which hands back the entire room state
   * to anyone who asks. */
  private async getOrCreateToken(): Promise<string> {
    const existing = await this.ctx.storage.get<string>(PAIRING_TOKEN_KEY);
    if (existing) return existing;
    const token = generateToken();
    await this.ctx.storage.put(PAIRING_TOKEN_KEY, token);
    this.log("token:generated");
    return token;
  }

  private async handleCaptureRequest(request: Request): Promise<Response> {
    let pool: unknown;
    try {
      const body = (await request.json()) as { pool?: unknown };
      pool = body.pool;
    } catch {
      pool = undefined;
    }
    if (typeof pool !== "string") {
      return Response.json(
        { ok: false, reason: "Missing or invalid 'pool' in request body." },
        { headers: CORS_HEADERS },
      );
    }

    const bridge = this.bridgeConnection;
    if (!bridge) {
      this.log("capture:no-bridge");
      return Response.json(
        {
          ok: false,
          reason:
            "Score Scope isn't connected to this room. Make sure it's running and paired with this room's token.",
        },
        { headers: CORS_HEADERS },
      );
    }

    const requestId = crypto.randomUUID();
    const result = await new Promise<CvCaptureResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.log("capture:timeout", `requestId=${requestId}`);
        resolve({
          ok: false,
          reason: "Score Scope did not respond in time.",
        });
      }, CAPTURE_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });

      this.log("capture:forward", `requestId=${requestId} pool=${pool}`);
      bridge.send(
        JSON.stringify(<CaptureRequestMsg>{
          type: "captureRequest",
          requestId,
          pool,
        }),
      );
    });

    return Response.json(result, { headers: CORS_HEADERS });
  }

  onConnect(connection: Connection) {
    // Nothing sent on connect (unlike the main app-state party, which
    // immediately pushes a full roomstate) -- a socket here isn't "the
    // bridge" until it proves itself with a valid `register` below.
    this.log("onConnect", `conn=${connection.id}`);
  }

  async onMessage(connection: Connection, message: WSMessage) {
    // Score Scope only ever sends text (JSON) frames; a non-string message
    // (binary) isn't something this protocol defines, so it's ignored the
    // same way unparseable JSON already is below.
    if (typeof message !== "string") return;

    let parsed: BridgeClientMessage;
    try {
      parsed = JSON.parse(message) as BridgeClientMessage;
    } catch {
      return;
    }

    switch (parsed.type) {
      case "register": {
        const expected = await this.getOrCreateToken();
        if (parsed.token !== expected) {
          this.log("register:rejected", `conn=${connection.id}`);
          connection.send(
            JSON.stringify({
              type: "registerRejected",
              reason: "Incorrect pairing token.",
            }),
          );
          return;
        }
        // Last-to-register wins -- if a previous bridge connection is
        // still technically open (e.g. the operator started a second
        // Score Scope instance by mistake), it silently stops receiving
        // captureRequests rather than the two racing for each one.
        this.bridgeConnection = connection;
        this.log("register:accepted", `conn=${connection.id}`);
        connection.send(JSON.stringify({ type: "registered" }));
        return;
      }
      case "captureResult": {
        const entry = this.pending.get(parsed.requestId);
        if (!entry) {
          // Already resolved (timed out, most likely) -- a late result
          // arriving after that has nowhere left to deliver it.
          this.log("captureResult:unmatched", `requestId=${parsed.requestId}`);
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(parsed.requestId);
        this.log("captureResult:delivered", `requestId=${parsed.requestId}`);
        entry.resolve(parsed.result);
        return;
      }
    }
  }

  onClose(connection: Connection) {
    this.log("onClose", `conn=${connection.id}`);
    if (this.bridgeConnection?.id === connection.id) {
      this.bridgeConnection = null;
      this.log("bridge:disconnected");
    }
  }

  onError(connection: Connection, error: unknown) {
    console.error(
      `[capture-bridge] room=${this.name} onError conn=${connection.id}`,
      error,
    );
    if (this.bridgeConnection?.id === connection.id) {
      this.bridgeConnection = null;
    }
  }
}

/** Short enough to read over voice/comms and type into Score Scope's
 * config by hand, long enough (2^40 possibilities) that guessing it
 * isn't practical -- this isn't defending against a targeted attacker
 * with access to the room's own settings page anyway (they could just
 * read it there), only against a stranger blind-guessing at the
 * capture-bridge endpoint for a room they don't otherwise have. */
function generateToken(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
