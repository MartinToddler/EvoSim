import {
  PROTOCOL_VERSION,
  decodeWorkerToMainMessage,
  type CommandRequestDto,
  type CommandResultPayload,
  type EntityDetailsPayload,
  type HistoryEventsPayload,
  type HostRuntimeConfig,
  type MainToWorkerMessage,
  type RenderSnapshotPayload,
  type SimulationSpeed,
  type SpeciesDetailsPayload,
  type SnapshotDataPayload,
  type RewindProgressPayload,
  type HistoricalModeReadyPayload,
  type StateHashPayload,
  type TelemetryDto,
  type TerrainSnapshotPayload,
  type TreeSnapshotPayload,
  type VegetationSnapshotPayload,
  type WorkerErrorDto,
  type WorkerToMainMessage,
  type WorldReadyPayload,
} from "@eon/protocol";

/**
 * Typed main-thread facade over the simulation Worker (docs/10 §21).
 *
 * Two shapes of traffic meet here and are deliberately handled differently:
 *
 * - **Requests** (QUERY_ENTITY, QUERY_STATE_HASH) get a `requestId` and return
 *   a promise. The Worker echoes the ID; this class matches it against a
 *   pending map and settles exactly one promise.
 * - **Subscriptions** (WORLD_READY, RENDER_SNAPSHOT, VEGETATION_SNAPSHOT,
 *   TELEMETRY, ERROR) are callbacks. They arrive unprompted and must never be
 *   modelled as promises: a stream of 15 snapshots a second through a promise
 *   API would allocate 15 promises a second and lose every frame but one.
 *
 * ## Stale responses are dropped, not mishandled
 *
 * The user can select a second organism before the first one's answer arrives.
 * Both answers come back; only the one still in the pending map settles a
 * promise, and the other is discarded silently. A response for an unknown
 * `requestId` is not an error — it is the normal consequence of a UI that moved
 * on, and treating it as one would produce spurious error toasts on fast
 * clicking.
 */

/**
 * The transport, abstracted so the client can be driven by a real `Worker`, by
 * a `MessagePort`, or by a fake in a Node test.
 */
export interface ClientPort {
  post(message: MainToWorkerMessage, transfer?: readonly ArrayBuffer[]): void;
  setListener(listener: (data: unknown) => void): void;
  close(): void;
}

export interface WorkerClientHandlers {
  onWorldReady?: (payload: WorldReadyPayload) => void;
  onRenderSnapshot?: (payload: RenderSnapshotPayload) => void;
  onVegetationSnapshot?: (payload: VegetationSnapshotPayload) => void;
  /** Terrain re-shipped after a player command edited the world (Milestone 9). */
  onTerrainSnapshot?: (payload: TerrainSnapshotPayload) => void;
  onTelemetry?: (payload: TelemetryDto) => void;
  /**
   * Replay progress while a rewind is in flight (Milestone 11).
   *
   * A stream, not an answer: a reconstruction reports many times and resolves
   * once, so progress must not consume the pending request. `requestId` lets a
   * caller ignore reports from a rewind it has already superseded.
   */
  onRewindProgress?: (payload: RewindProgressPayload, requestId: number) => void;
  onError?: (payload: WorkerErrorDto) => void;
  /** Reported when a message could not be decoded — a protocol-level fault. */
  onProtocolViolation?: (reason: string) => void;
}

interface PendingRequest {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  kind:
    | "ENTITY_DETAILS"
    | "SPECIES_DETAILS"
    | "TREE_SNAPSHOT"
    | "HISTORY_EVENTS"
    | "STATE_HASH"
    | "HISTORICAL_MODE_READY"
    | "SNAPSHOT_DATA"
    | "COMMAND_RESULT";
}

export class WorkerClient {
  readonly #port: ClientPort;
  readonly #handlers: WorkerClientHandlers;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;

  constructor(port: ClientPort, handlers: WorkerClientHandlers = {}) {
    this.#port = port;
    this.#handlers = handlers;
    port.setListener((data) => {
      this.#receive(data);
    });
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  // --- Commands --------------------------------------------------------------

  initNewWorld(options: {
    seed: number;
    speed: SimulationSpeed;
    config?: unknown;
    hostRuntime?: Partial<HostRuntimeConfig>;
  }): void {
    this.#send({
      protocolVersion: PROTOCOL_VERSION,
      type: "INIT_NEW_WORLD",
      payload: {
        seed: options.seed,
        config: options.config ?? null,
        hostRuntime: options.hostRuntime ?? null,
        speed: options.speed,
      },
    });
  }

  setSpeed(speed: SimulationSpeed): void {
    this.#send({
      protocolVersion: PROTOCOL_VERSION,
      type: "SET_RUN_STATE",
      payload: { speed },
    });
  }

  setRenderStream(enabled: boolean): void {
    this.#send({
      protocolVersion: PROTOCOL_VERSION,
      type: "SET_RENDER_STREAM",
      payload: { enabled },
    });
  }

  /**
   * Hand a spent render buffer back to the Worker's pool.
   *
   * Transferred, not copied: the main thread's view is detached by this call,
   * which is exactly right — the renderer is finished with it, and a detached
   * buffer cannot be read from stale code by mistake.
   */
  recycleRenderBuffer(buffer: ArrayBuffer): void {
    if (this.#closed || buffer.byteLength === 0) {
      return;
    }
    this.#send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "RECYCLE_RENDER_BUFFER",
        payload: { buffer },
      },
      [buffer],
    );
  }

  recycleVegetationBuffer(buffer: ArrayBuffer): void {
    if (this.#closed || buffer.byteLength === 0) {
      return;
    }
    this.#send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "RECYCLE_VEGETATION_BUFFER",
        payload: { buffer },
      },
      [buffer],
    );
  }

  // --- Requests --------------------------------------------------------------

  /**
   * Queue one player command (Milestone 9). Resolves with the engine's
   * verdict — acceptance carries the stamped (id, tick, sequence) identity,
   * rejection a deterministic reason — and never rejects for a mere refusal:
   * a promise rejection here means the Worker itself failed.
   */
  queueCommand(command: CommandRequestDto): Promise<CommandResultPayload> {
    return this.#request<CommandResultPayload>("COMMAND_RESULT", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "QUEUE_COMMAND",
      payload: { command },
    }));
  }

  queryEntity(entityId: number): Promise<EntityDetailsPayload> {
    return this.#request<EntityDetailsPayload>("ENTITY_DETAILS", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "QUERY_ENTITY",
      payload: { entityId },
    }));
  }

  querySpecies(speciesId: number): Promise<SpeciesDetailsPayload> {
    return this.#request<SpeciesDetailsPayload>("SPECIES_DETAILS", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "QUERY_SPECIES",
      payload: { speciesId },
    }));
  }

  requestTree(): Promise<TreeSnapshotPayload> {
    return this.#request<TreeSnapshotPayload>("TREE_SNAPSHOT", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "REQUEST_TREE",
      payload: {},
    }));
  }

  /** Fetch retained events newer than `sinceEventId` plus the world series. */
  requestHistory(sinceEventId: number): Promise<HistoryEventsPayload> {
    return this.#request<HistoryEventsPayload>("HISTORY_EVENTS", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "REQUEST_HISTORY_RANGE",
      payload: { sinceEventId },
    }));
  }

  /**
   * Ask for the canonical state hash, optionally after running to `targetTick`.
   *
   * The determinism acceptance path: the same seed and config run to the same
   * tick must hash identically whether the ticks happened here or in a headless
   * Node process.
   */
  queryStateHash(targetTick: number | null = null): Promise<StateHashPayload> {
    return this.#request<StateHashPayload>("STATE_HASH", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "QUERY_STATE_HASH",
      payload: { targetTick },
    }));
  }

  /**
   * Ask the Worker to serialize its world into durable snapshot bytes
   * (Milestone 10).
   *
   * The client does not store anything: it hands the bytes back to its caller,
   * which owns the database. Saving cannot change the simulation, so this is
   * safe to call while the world is running at any speed.
   */
  requestSave(reason: "manual" | "autosave" = "manual"): Promise<SnapshotDataPayload> {
    return this.#request<SnapshotDataPayload>("SNAPSHOT_DATA", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "REQUEST_SAVE",
      payload: { reason },
    }));
  }

  /**
   * Replace the Worker's world with one restored from durable bytes.
   *
   * The buffer is transferred, so the caller must not touch it afterwards —
   * pass a copy if the save is still needed on this side. Success is announced
   * by the ordinary WORLD_READY handler, exactly as a new world is; failure
   * arrives as a non-fatal ERROR, and the world already running keeps running.
   */
  /**
   * Reconstruct `targetTick` from `snapshot` and enter historical mode.
   *
   * The caller supplies the save because only the main thread can see the
   * database. Resolves with the preview's identity once the replay lands;
   * progress arrives through `onRewindProgress` in the meantime.
   */
  requestRewind(
    snapshot: ArrayBuffer,
    targetTick: number,
    /**
     * Called synchronously with the id this request was issued under, so the
     * caller can match the progress stream to it. Without it the caller would
     * have to guess, and progress from a superseded rewind would be
     * indistinguishable from progress on the current one.
     */
    onIssued?: (requestId: number) => void,
  ): Promise<HistoricalModeReadyPayload> {
    return this.#request<HistoricalModeReadyPayload>("HISTORICAL_MODE_READY", (requestId) => {
      onIssued?.(requestId);
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        type: "REQUEST_REWIND",
        payload: { snapshot, targetTick },
      };
    });
  }

  /** Leave historical mode. Fire-and-forget: the present never stopped existing. */
  returnToPresent(): void {
    this.#send({
      protocolVersion: PROTOCOL_VERSION,
      type: "RETURN_TO_PRESENT",
      payload: {},
    });
  }

  /**
   * Ask for the bytes that become a branch's origin, taken from the open
   * preview at `branchTick`.
   */
  createBranch(branchTick: number): Promise<SnapshotDataPayload> {
    return this.#request<SnapshotDataPayload>("SNAPSHOT_DATA", (requestId) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: "CREATE_BRANCH",
      payload: { branchTick },
    }));
  }

  loadWorld(options: {
    snapshot: ArrayBuffer;
    speed: SimulationSpeed;
    hostRuntime?: Partial<HostRuntimeConfig>;
  }): void {
    this.#send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "LOAD_WORLD",
        payload: {
          snapshot: options.snapshot,
          hostRuntime: options.hostRuntime ?? null,
          speed: options.speed,
        },
      },
      [options.snapshot],
    );
  }

  /** Stop the Worker and fail every outstanding request. */
  dispose(): void {
    if (this.#closed) {
      return;
    }
    this.#send({ protocolVersion: PROTOCOL_VERSION, type: "DISPOSE", payload: {} });
    this.#closed = true;
    this.#rejectAllPending(new Error("worker client disposed"));
    this.#port.close();
  }

  // --- Internals -------------------------------------------------------------

  #send(message: MainToWorkerMessage, transfer?: readonly ArrayBuffer[]): void {
    if (this.#closed) {
      return;
    }
    this.#port.post(message, transfer);
  }

  #request<T>(
    kind: PendingRequest["kind"],
    build: (requestId: number) => MainToWorkerMessage,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("worker client is closed"));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, {
        resolve,
        reject,
        kind,
      });
      this.#port.post(build(requestId));
    });
  }

  #receive(data: unknown): void {
    const decoded = decodeWorkerToMainMessage(data);
    if (!decoded.ok) {
      this.#handlers.onProtocolViolation?.(decoded.reason);
      return;
    }
    const message: WorkerToMainMessage = decoded.message;

    // Progress is correlated but is not the answer: routing it through the
    // pending map would either resolve the rewind early or reject it for
    // arriving as the wrong type.
    if (message.type === "REWIND_PROGRESS") {
      this.#handlers.onRewindProgress?.(message.payload, message.requestId ?? 0);
      return;
    }

    if (message.requestId !== undefined) {
      const pending = this.#pending.get(message.requestId);
      if (pending === undefined) {
        // Stale: the caller stopped caring before the answer arrived. Errors
        // still reach the error handler so a failure is never silent.
        if (message.type === "ERROR") {
          this.#handlers.onError?.(message.payload);
        }
        return;
      }
      this.#pending.delete(message.requestId);
      if (message.type === "ERROR") {
        pending.reject(new Error(message.payload.message));
        // A fatal failure kills every outstanding request, not just the one it
        // happened to be answering — the world is gone, so nothing else can be
        // answered either, and leaving those promises pending would hang the
        // callers forever.
        if (message.payload.fatal) {
          this.#rejectAllPending(new Error(message.payload.message));
        }
        this.#handlers.onError?.(message.payload);
        return;
      }
      if (message.type !== pending.kind) {
        pending.reject(
          new Error(
            `expected ${pending.kind} for request ${message.requestId}, got ${message.type}`,
          ),
        );
        return;
      }
      pending.resolve(message.payload as never);
      return;
    }

    switch (message.type) {
      case "WORLD_READY":
        this.#handlers.onWorldReady?.(message.payload);
        return;
      case "RENDER_SNAPSHOT":
        this.#handlers.onRenderSnapshot?.(message.payload);
        return;
      case "VEGETATION_SNAPSHOT":
        this.#handlers.onVegetationSnapshot?.(message.payload);
        return;
      case "TERRAIN_SNAPSHOT":
        this.#handlers.onTerrainSnapshot?.(message.payload);
        return;
      case "TELEMETRY":
        this.#handlers.onTelemetry?.(message.payload);
        return;
      case "ERROR":
        if (message.payload.fatal) {
          this.#rejectAllPending(new Error(message.payload.message));
        }
        this.#handlers.onError?.(message.payload);
        return;
      default:
        // A correlated response that arrived without its requestId. Nothing can
        // be settled, so report it rather than drop it.
        this.#handlers.onProtocolViolation?.(`${message.type} arrived without a requestId`);
    }
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * The slice of `Worker` the adapter needs. Structural, so a Node test can pass
 * a fake and a browser passes the real thing; the session's `SessionWorker`
 * is the same shape.
 */
export interface RawWorker {
  // Two call shapes rather than one optional parameter, mirroring the real
  // `Worker.postMessage` overloads — a single `transfer?:` signature is not
  // satisfiable by the DOM type, whose transfer-list overload is required.
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

/** Adapt a real `Worker` (or a test fake) to {@link ClientPort}. */
export function workerPort(worker: RawWorker): ClientPort {
  let listener: ((event: { data: unknown }) => void) | null = null;
  return {
    post(message, transfer): void {
      if (transfer !== undefined && transfer.length > 0) {
        worker.postMessage(message, transfer as ArrayBuffer[]);
      } else {
        worker.postMessage(message);
      }
    },
    setListener(next): void {
      if (listener !== null) {
        worker.removeEventListener("message", listener);
      }
      listener = (event: { data: unknown }): void => {
        next(event.data);
      };
      worker.addEventListener("message", listener);
    },
    close(): void {
      if (listener !== null) {
        worker.removeEventListener("message", listener);
        listener = null;
      }
      worker.terminate();
    },
  };
}
