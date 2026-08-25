import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "partyserver";
import type {
  ActionAck,
  ActionReject,
  CatchupRequest,
  CatchupResponse,
  ClientMessage,
  Pong,
  ReduxAction,
  Roomstate,
  StampedAction,
} from "./types";
import { configureStore } from "@reduxjs/toolkit";
import { reducer } from "../state/root-reducer";
import type { AppState } from "../state/store";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "./database.types";
import { applyMigrations } from "../state/migrations";
import { CaptureBridge } from "./capture-bridge-server";

// wrangler.jsonc's "main" points here -- Durable Object classes must be
// exported from that entry script for durable_objects.bindings to resolve
// them, and something has to provide the top-level fetch handler (below).
// Folded into this file rather than a separate worker.ts/index.ts: it's
// ~15 lines with no independent reason to exist on its own.
export { CaptureBridge };

function isAppState(state: unknown): state is AppState {
  if (state && !Array.isArray(state) && typeof state === "object") {
    return "config" in state && "drawings" in state;
  }
  return false;
}

/** upper bound on remembered action ids used to dedupe client re-sends */
const MAX_REMEMBERED_ACTIONS = 1000;
/** how many recent stamped actions to retain for incremental catch-up */
const MAX_TAIL = 500;
/** storage key holding the sequencer counter + dedupe set (survives hibernation) */
const SYNC_META_KEY = "syncMeta";

/** shape of the persisted sequencer metadata */
interface SyncMeta {
  seq: number;
  seenIds: string[];
}

/**
 * greppable prefix shared by every diagnostic line this server emits. Filter
 * production logs with this to trace a room's persisted-snapshot lifecycle.
 */
const LOG_PREFIX = "[party-diag]";

/**
 * Cheap, side-effect-free fingerprint of the shared state so snapshots can be
 * compared to see whether the persisted state advanced. Uses the drawings
 * entity count plus the serialized length as a poor-man's hash; this is for
 * observability only and never feeds back into state.
 */
function fingerprintParts(state: AppState) {
  const drawings = state.drawings?.ids?.length ?? 0;
  let stateLen = -1;
  try {
    stateLen = JSON.stringify(state).length;
  } catch {
    stateLen = -1;
  }
  return { drawings, stateLen };
}

function formatFingerprint(parts: { drawings: number; stateLen: number }) {
  return `drawings=${parts.drawings} stateLen=${parts.stateLen}`;
}

function stateFingerprint(state: AppState): string {
  return formatFingerprint(fingerprintParts(state));
}

/** shape of the `?debug` snapshot for one persistence target */
interface SnapshotInfo {
  present: boolean;
  fingerprint?: string;
  drawings?: number;
  stateLen?: number;
  updatedAt?: string;
  matchesMemory?: boolean;
  error?: string;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

/**
 * Ported from the old `implements Party.Server` (partykit/server) shape to
 * `extends Server` (partyserver), which deploys via plain `wrangler deploy`
 * instead of the `partykit` CLI -- see wrangler.jsonc's own comment for why.
 * Wire protocol, sync/dedupe/catch-up behavior, and persistence semantics
 * are all unchanged; only the framework glue moved:
 *   - `this.room.id` -> `this.name`
 *   - `this.room.storage` -> `this.ctx.storage`
 *   - `this.room.broadcast` / `this.room.getConnections()` -> `this.broadcast` / `this.getConnections()`
 *   - `onMessage`'s params are (connection, message) instead of (message, sender)
 *   - `onClose` gets (connection, code, reason, wasClean) instead of just (conn)
 *   - `onError`'s error is `unknown` instead of `Error`
 *   - SUPABASE_URL/SUPABASE_KEY come from `this.env` (a wrangler binding, set
 *     via `wrangler secret put`) instead of `process.env` (which PartyKit's
 *     own CLI shimmed in at build time -- raw Workers has no such shim, so
 *     the old module-level `getSupabase()`/`const supabase = ...` singleton
 *     became an instance-level lazy init in onStart() instead, since `env`
 *     isn't available until the Durable Object actually exists).
 */
export class Main extends Server<Env> {
  static options = { hibernate: true };

  // @ts-expect-error I assign this for sure
  private store: typeof appReduxStore;

  private supabase: SupabaseClient<Database> | undefined;

  /** monotonic counter assigning the canonical order of applied actions */
  private seq = 0;

  /** recently applied action ids mapped to their seq, oldest first */
  private seenActionIds = new Map<string, number>();

  /**
   * tail of recently stamped actions (ascending seq) used to answer catch-up
   * requests. In-memory only: a client only asks for catch-up after seeing a
   * gap on a *live* socket, which means this actor has been running the whole
   * time and the tail is intact. A restart/hibernation drops every socket, so
   * clients reconnect and take a fresh roomstate instead of catching up.
   */
  private tail: StampedAction[] = [];

  // ---- diagnostics, reported by `GET ...?debug`. In-memory only: they
  // describe the *current* room instance and reset when it is evicted.

  private instanceStartedAt = Date.now();

  /** how this instance's state was hydrated at startup */
  private hydration: {
    source: "storage" | "supabase" | "fresh";
    at: string;
    fingerprint: string | null;
    error: string | null;
  } | null = null;

  /** tallies for the fire-and-forget `currentState` writes */
  private storageWrites = {
    started: 0,
    ok: 0,
    failed: 0,
    lastOkAt: null as string | null,
    lastErrorAt: null as string | null,
  };

  private supabaseWrites = {
    ok: 0,
    failed: 0,
    lastOkAt: null as string | null,
    lastErrorAt: null as string | null,
  };

  private lastAction: { type: string; seq: number; at: string } | null = null;

  private lastError: { at: string; where: string; message: string } | null =
    null;

  private recordError(where: string, e: unknown) {
    this.lastError = {
      at: new Date().toISOString(),
      where,
      message: describeError(e),
    };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    console.log("constructor start");
  }

  /** emit a single greppable diagnostic line tagged with this room's id */
  private log(event: string, details = "") {
    console.log(
      `${LOG_PREFIX} room=${this.name} ${event}${details ? ` ${details}` : ""}`,
    );
  }

  /** current count of live connections, for correlating socket cycles */
  private connectionCount(): number {
    return [...this.getConnections()].length;
  }

  /** builds (or leaves undefined) the Supabase client from wrangler-bound
   * env vars -- see this class's own doc for why this moved here from a
   * module-level singleton. Called once from onStart(); `this.env` isn't
   * populated before the Durable Object actually starts. */
  private initSupabase(): SupabaseClient<Database> | undefined {
    if (!this.env.SUPABASE_URL || !this.env.SUPABASE_KEY) {
      console.log("Your env is missing SUPABASE_URL and/or SUPABASE_KEY.");
      console.log("Disabling supabase persistence.");
      return undefined;
    }
    return createClient<Database>(this.env.SUPABASE_URL, this.env.SUPABASE_KEY, {
      auth: { persistSession: false },
    });
  }

  async onStart() {
    this.supabase = this.initSupabase();

    let preloadedState: AppState | undefined;
    let source: "storage" | "supabase" | "fresh" = "fresh";
    let hydrateError: string | null = null;
    try {
      // preserve the original `storage || supabase` short-circuit: supabase is
      // only consulted when storage came back empty. Split apart only so the
      // hydration source can be logged.
      const fromStorage = await this.getFromStorage();
      const fromSupabase = fromStorage
        ? undefined
        : await this.getFromSupabase();
      preloadedState = fromStorage || fromSupabase;
      if (fromStorage) source = "storage";
      else if (fromSupabase) source = "supabase";
      if (preloadedState) applyMigrations(preloadedState);
    } catch (e) {
      // previously swallowed silently; surface it since a failed hydrate is a
      // prime suspect for reverting a room to a stale checkpoint.
      hydrateError = describeError(e);
      this.recordError("onStart", e);
      console.error(
        `${LOG_PREFIX} room=${this.name} onStart:hydrate-error`,
        e,
      );
    }
    if (preloadedState) {
      this.store = configureStore({ reducer, preloadedState });
    } else {
      this.store = configureStore({ reducer });
    }
    // restore the sequencer counter + dedupe set so a hibernated/restarted
    // room doesn't reset seq to 0 or forget which ids it already applied
    // (which would let a client's re-send be applied a second time)
    let metaSource = "none";
    try {
      const meta = await this.ctx.storage.get<SyncMeta>(SYNC_META_KEY);
      if (meta) {
        this.seq = meta.seq;
        this.seenActionIds = new Map(meta.seenIds.map((id) => [id, meta.seq]));
        metaSource = "storage";
      }
    } catch (e) {
      metaSource = "error";
      console.error(
        `${LOG_PREFIX} room=${this.name} onStart:syncMeta-error`,
        e,
      );
    }
    const fingerprint = stateFingerprint(this.store.getState());
    this.hydration = {
      source,
      at: new Date().toISOString(),
      fingerprint,
      error: hydrateError,
    };
    // logged after the sequencer restore so `seq` reflects the resumed value
    // rather than a misleading 0
    this.log(
      "onStart",
      `source=${source} syncMeta=${metaSource} seq=${this.seq} ${fingerprint}`,
    );
  }

  private async getFromSupabase() {
    if (!this.supabase) return;
    const { data, error } = await this.supabase
      .from("event_state")
      .select("state")
      .eq("id", this.name)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    if (data && isAppState(data.state)) return data.state;
  }

  private getFromStorage() {
    return this.ctx.storage.get<AppState>("currentState");
  }

  onRequest(req: Request): Response | Promise<Response> {
    if (req.method === "GET") {
      // opt-in health snapshot: `?debug` reports how this room instance
      // hydrated and whether its writes are landing, without changing the
      // default response clients rely on.
      if (new URL(req.url).searchParams.has("debug")) {
        return this.debugResponse();
      }
      return Response.json(this.store.getState(), {
        headers: CORS_HEADERS,
      });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  /**
   * Compare the in-memory state against both persistence targets so a single
   * request answers "did this room's persisted snapshot stop advancing?".
   *
   * Caveat: requesting this instantiates the room if it was evicted, so the
   * counters describe the instance you just woke, not the one that died. The
   * durable comparison below is what survives an eviction.
   */
  private async debugResponse(): Promise<Response> {
    const memoryState = this.store.getState();
    const memory = fingerprintParts(memoryState);
    const memoryFingerprint = formatFingerprint(memory);

    const [storage, supabaseSnapshot] = await Promise.all([
      this.describeStorage(memoryFingerprint),
      this.describeSupabase(memoryFingerprint),
    ]);

    const unsettled =
      this.storageWrites.started -
      this.storageWrites.ok -
      this.storageWrites.failed;

    const warnings: string[] = [];
    if (unsettled > 0) {
      warnings.push(
        `${unsettled} storage write(s) started but never settled — they may not flush before eviction`,
      );
    }
    if (storage.present && storage.matchesMemory === false) {
      warnings.push(
        "persisted storage snapshot differs from in-memory state — the durable write is not keeping up",
      );
    }
    if (!storage.present && this.lastAction) {
      warnings.push(
        "no currentState in storage despite actions having been applied",
      );
    }
    if (
      storage.present &&
      supabaseSnapshot.present &&
      storage.fingerprint !== supabaseSnapshot.fingerprint
    ) {
      warnings.push(
        "storage and supabase disagree — onStart prefers storage, so a stale storage value pins this room to an old checkpoint",
      );
    }
    if (this.storageWrites.failed > 0) {
      warnings.push(`${this.storageWrites.failed} storage write(s) failed`);
    }
    if (this.supabaseWrites.failed > 0) {
      warnings.push(`${this.supabaseWrites.failed} supabase upsert(s) failed`);
    }
    if (this.hydration?.error) {
      warnings.push(`hydration errored: ${this.hydration.error}`);
    }

    return Response.json(
      {
        room: this.name,
        now: new Date().toISOString(),
        instance: {
          startedAt: new Date(this.instanceStartedAt).toISOString(),
          uptimeMs: Date.now() - this.instanceStartedAt,
        },
        seq: this.seq,
        connections: this.connectionCount(),
        rememberedActionIds: this.seenActionIds.size,
        memory: { ...memory, fingerprint: memoryFingerprint },
        storage,
        supabase: supabaseSnapshot,
        hydration: this.hydration,
        writes: {
          storage: { ...this.storageWrites, unsettled },
          supabase: { ...this.supabaseWrites, enabled: !!this.supabase },
        },
        lastAction: this.lastAction,
        lastError: this.lastError,
        healthy: warnings.length === 0,
        warnings,
      },
      { headers: CORS_HEADERS },
    );
  }

  /** read back what is actually durable in room storage right now */
  private async describeStorage(
    memoryFingerprint: string,
  ): Promise<SnapshotInfo> {
    try {
      const stored = await this.getFromStorage();
      if (!stored) return { present: false };
      const parts = fingerprintParts(stored);
      const fingerprint = formatFingerprint(parts);
      return {
        present: true,
        ...parts,
        fingerprint,
        matchesMemory: fingerprint === memoryFingerprint,
      };
    } catch (e) {
      return { present: false, error: describeError(e) };
    }
  }

  private async describeSupabase(
    memoryFingerprint: string,
  ): Promise<SnapshotInfo> {
    if (!this.supabase)
      return { present: false, error: "supabase not configured" };
    try {
      const { data, error } = await this.supabase
        .from("event_state")
        .select("state, updated_at")
        .eq("id", this.name)
        .maybeSingle();
      if (error) return { present: false, error: error.message };
      if (!data) return { present: false };
      if (!isAppState(data.state)) {
        return {
          present: true,
          updatedAt: data.updated_at,
          error: "stored row is not a recognizable AppState",
        };
      }
      const parts = fingerprintParts(data.state);
      const fingerprint = formatFingerprint(parts);
      return {
        present: true,
        ...parts,
        fingerprint,
        updatedAt: data.updated_at,
        matchesMemory: fingerprint === memoryFingerprint,
      };
    } catch (e) {
      return { present: false, error: describeError(e) };
    }
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // A websocket just connected!
    console.log(
      `Connected:
  id: ${connection.id}
  room: ${this.name}
  url: ${new URL(ctx.request.url).pathname}`,
    );

    const servedState = this.store.getState();
    this.log(
      "onConnect",
      `conn=${connection.id} connections=${this.connectionCount()} serving roomstate seq=${this.seq} ${stateFingerprint(servedState)}`,
    );

    // send the initial state to this client
    connection.send(JSON.stringify(this.roomstateMessage()));
  }

  async onMessage(connection: Connection, message: WSMessage) {
    // clients only ever send text (JSON) frames; a non-string message
    // (binary) isn't something this protocol defines.
    if (typeof message !== "string") return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    switch (parsed.type) {
      case "ping":
        connection.send(JSON.stringify(<Pong>{ type: "pong" }));
        return;
      case "catchup":
        this.handleCatchup(parsed, connection);
        return;
      case "action":
        await this.handleAction(parsed, connection, message);
        return;
    }
  }

  private async handleAction(
    parsed: ReduxAction,
    sender: Connection,
    rawMessage: string,
  ) {
    if (parsed.id && this.seenActionIds.has(parsed.id)) {
      // a re-send of an action already applied: confirm receipt again
      // (the original ack may have been lost) but don't apply it twice
      this.sendAck(sender, parsed.id);
      return;
    }

    // Apply the action *before* ordering or broadcasting it. The echo doubles
    // as the receipt confirmation, so anything broadcast is a promise that the
    // server applied it; ordering first would let an action that the reducer
    // refuses reach every peer (and, since step 2, enter the catch-up tail and
    // recentActionIds) while the server's own store never took it — leaving
    // the server silently behind every client until the next roomstate
    // reverted them all.
    try {
      this.store.dispatch(parsed.action);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `${LOG_PREFIX} room=${this.name} action:rejected type=${parsed.action?.type} id=${parsed.id ?? "none"} seq=${this.seq}`,
        e,
      );
      // seq is not consumed, the id is not remembered, nothing is broadcast:
      // the room is exactly as it was before this message arrived
      if (parsed.id) this.sendReject(sender, parsed.id, reason);
      return;
    }

    if (parsed.id) {
      // stamp the action with its canonical position and broadcast to
      // everyone *including* the sender: the echo doubles as the receipt
      // confirmation, and all replicas apply actions in seq order
      this.seq += 1;
      const stamped: StampedAction = {
        ...parsed,
        id: parsed.id,
        seq: this.seq,
      };
      this.rememberStampedAction(stamped);
      this.broadcast(JSON.stringify(stamped));
    } else {
      // legacy client that can't recognize its own echo: relay the
      // unstamped action to everyone else only. It has no ack channel, so a
      // rejection can only be silent for these.
      this.broadcast(rawMessage, [sender.id]);
    }

    const nextState = this.store.getState();
    const fingerprint = stateFingerprint(nextState);
    this.lastAction = {
      type: String(parsed.action?.type),
      seq: this.seq,
      at: new Date().toISOString(),
    };
    this.log(
      "handleAction",
      `type=${parsed.action?.type} id=${parsed.id ?? "none"} seq=${parsed.id ? this.seq : "n/a"} ${fingerprint}`,
    );

    // persist to durable storage: the state itself, plus the sequencer
    // metadata so dedupe/ordering survive a hibernation or restart. Both stay
    // fire-and-forget (unchanged behavior); wrapped only so we can observe
    // whether the write actually resolves before the room is evicted, or
    // rejects.
    this.storageWrites.started += 1;
    this.log("storage.put:start", fingerprint);
    void this.ctx.storage
      .put("currentState", nextState)
      .then(() => {
        this.storageWrites.ok += 1;
        this.storageWrites.lastOkAt = new Date().toISOString();
        this.log("storage.put:ok", fingerprint);
      })
      .catch((e: unknown) => {
        this.storageWrites.failed += 1;
        this.storageWrites.lastErrorAt = new Date().toISOString();
        this.recordError("storage.put", e);
        console.error(
          `${LOG_PREFIX} room=${this.name} storage.put:error ${fingerprint}`,
          e,
        );
      });

    if (parsed.id) {
      void this.ctx.storage
        .put<SyncMeta>(SYNC_META_KEY, {
          seq: this.seq,
          seenIds: Array.from(this.seenActionIds.keys()),
        })
        .then(() => this.log("syncMeta.put:ok", `seq=${this.seq}`))
        .catch((e: unknown) =>
          console.error(
            `${LOG_PREFIX} room=${this.name} syncMeta.put:error seq=${this.seq}`,
            e,
          ),
        );
    }

    // persist the state to supabase
    try {
      if (this.supabase) {
        // supabase returns errors in the result rather than throwing, so the
        // existing catch never saw them: capture and log the returned error
        // loudly, since a swallowed upsert failure would leave the served
        // snapshot stale on the next reconnect.
        const { error } = await this.supabase.from("event_state").upsert({
          id: this.name,
          state: nextState as unknown as Json,
          updated_at: new Date().toISOString(),
        });
        if (error) {
          this.supabaseWrites.failed += 1;
          this.supabaseWrites.lastErrorAt = new Date().toISOString();
          this.recordError("supabase.upsert", error);
          console.error(
            `${LOG_PREFIX} room=${this.name} supabase.upsert:error ${fingerprint}`,
            error,
          );
        } else {
          this.supabaseWrites.ok += 1;
          this.supabaseWrites.lastOkAt = new Date().toISOString();
          this.log("supabase.upsert:ok", fingerprint);
        }
      }
    } catch (e) {
      this.supabaseWrites.failed += 1;
      this.supabaseWrites.lastErrorAt = new Date().toISOString();
      this.recordError("supabase.upsert", e);
      console.error(
        `${LOG_PREFIX} room=${this.name} supabase.upsert:throw ${fingerprint}`,
        e,
      );
    }
  }

  /**
   * Serve a client's catch-up request: replay the stamped actions after
   * `since`. If the gap reaches back further than our retained tail, fall
   * back to a full roomstate so the client resyncs wholesale.
   */
  private handleCatchup(req: CatchupRequest, sender: Connection) {
    if (req.since >= this.seq) {
      // client is already current (or ahead); nothing to replay
      this.log(
        "catchup",
        `conn=${sender.id} since=${req.since} result=current`,
      );
      sender.send(
        JSON.stringify(<CatchupResponse>{ type: "catchup", actions: [] }),
      );
      return;
    }
    const earliest = this.tail.length ? this.tail[0].seq : Infinity;
    if (req.since >= earliest - 1) {
      const actions = this.tail.filter((a) => a.seq > req.since);
      this.log(
        "catchup",
        `conn=${sender.id} since=${req.since} result=replay actions=${actions.length} seq=${this.seq}`,
      );
      sender.send(
        JSON.stringify(<CatchupResponse>{ type: "catchup", actions }),
      );
    } else {
      // the gap predates our tail; only a fresh snapshot can repair the client
      this.log(
        "catchup",
        `conn=${sender.id} since=${req.since} result=full-roomstate earliest=${earliest} seq=${this.seq}`,
      );
      sender.send(JSON.stringify(this.roomstateMessage()));
    }
  }

  private roomstateMessage(): Roomstate {
    return {
      type: "roomstate",
      state: this.store.getState(),
      recentActionIds: Array.from(this.seenActionIds.keys()),
      seq: this.seq,
    };
  }

  onClose(connection: Connection) {
    // correlate socket cycles (flaky venue wifi) and potential hibernation with
    // whichever snapshot was last served/persisted for this room.
    this.log(
      "onClose",
      `conn=${connection.id} connections=${this.connectionCount()} seq=${this.seq} ${stateFingerprint(this.store.getState())}`,
    );
  }

  onError(connection: Connection, error: unknown) {
    console.error(
      `${LOG_PREFIX} room=${this.name} onError conn=${connection.id} seq=${this.seq}`,
      error,
    );
  }

  private sendAck(conn: Connection, id: string) {
    conn.send(JSON.stringify(<ActionAck>{ type: "ack", id }));
  }

  private sendReject(conn: Connection, id: string, reason: string) {
    conn.send(JSON.stringify(<ActionReject>{ type: "reject", id, reason }));
  }

  private rememberStampedAction(stamped: StampedAction) {
    this.tail.push(stamped);
    if (this.tail.length > MAX_TAIL) {
      this.tail.shift();
    }
    this.seenActionIds.set(stamped.id, stamped.seq);
    if (this.seenActionIds.size > MAX_REMEMBERED_ACTIONS) {
      for (const oldest of this.seenActionIds.keys()) {
        this.seenActionIds.delete(oldest);
        break;
      }
    }
  }
}

/**
 * Replaces what the old `partykit` CLI generated automatically from
 * partykit.json's `parties` map. `routePartykitRequest` matches
 * `/parties/:server/:name` -- the same URL shape host.ts already builds
 * (partykitEndpoint / captureBridgeEndpoint) -- against the Durable Object
 * bindings in wrangler.jsonc, kebab-casing each binding name to get its URL
 * segment (Main -> "main", CaptureBridge -> "capture-bridge"). See host.ts's
 * own comment for why the capture bridge's URL uses a hyphen now instead of
 * the underscore the old partykit.json party name used.
 */
export default {
  async fetch(request: Request, env: Env) {
    const response = await routePartykitRequest(request, env);
    return (
      response ??
      new Response("Not found", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
      })
    );
  },
};
