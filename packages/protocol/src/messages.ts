/**
 * Versioned Worker message unions (task G01, docs/02 §§12-14).
 *
 * ## Two directions, one envelope
 *
 * Every message is an {@link Envelope}: `{ protocolVersion, type, payload }`
 * plus an optional `requestId`. Request/response pairs (QUERY_ENTITY →
 * ENTITY_DETAILS, QUERY_STATE_HASH → STATE_HASH) carry a `requestId` that the
 * Worker echoes verbatim, so a caller can correlate an answer with its
 * question. Streams (RENDER_SNAPSHOT, TELEMETRY) never carry one: they are
 * subscriptions, not answers (docs/10 §21).
 *
 * ## Why decoding is defensive
 *
 * `onmessage` receives `unknown`. A structured-clone payload can be anything —
 * a stale message from a previous protocol version, a hot-reload artefact,
 * another library sharing the port. The Worker therefore *decodes* rather than
 * casts: {@link decodeMainToWorkerMessage} returns a typed message or a reason,
 * and the host answers a bad message with an ERROR instead of throwing inside
 * the message handler, where the failure would be invisible.
 *
 * ## What is NOT here yet
 *
 * docs/02 §13 also lists LOAD_WORLD, QUEUE_COMMAND, REQUEST_SAVE,
 * REQUEST_REWIND and CREATE_BRANCH. Those address engine features that do not
 * exist yet — player commands (Milestone 9) and persistence (Milestone 10).
 * Declaring their wire shapes now would mean inventing payloads for rules
 * nobody has written, so they arrive with their milestones and bump
 * PROTOCOL_VERSION then. QUERY_SPECIES, REQUEST_TREE and REQUEST_HISTORY_RANGE
 * arrived with Milestone 8 (protocol 4).
 */

import type {
  EntityDetailsDto,
  HistorySliceDto,
  SimulationSpeed,
  SpeciesDetailsDto,
  TelemetryDto,
  TreeSnapshotDto,
  WorldSummaryDto,
  WorkerErrorDto,
} from "./dto";
import type { Envelope } from "./envelope";
import type { HostRuntimeConfig } from "./hostRuntimeConfig";
import { PROTOCOL_VERSION } from "./version";

// --- Main thread -> Worker ---------------------------------------------------

export interface InitNewWorldPayload {
  seed: number;
  /**
   * Authoritative configuration, or `null` for `DEFAULT_CONFIG`.
   *
   * Typed as `unknown` on purpose: the wire must not force `@eon/protocol` to
   * depend on `@eon/engine`, and the engine validates whatever arrives anyway
   * (a config that crossed a structured clone is exactly as untrusted as one
   * read from disk).
   */
  config: unknown;
  /** Host pacing overrides, or `null` for `DEFAULT_HOST_RUNTIME_CONFIG`. */
  hostRuntime: Partial<HostRuntimeConfig> | null;
  /** Speed to start at. Worlds open paused unless told otherwise. */
  speed: SimulationSpeed;
}

export interface SetRunStatePayload {
  speed: SimulationSpeed;
}

export interface QueryEntityPayload {
  entityId: number;
}

export interface QuerySpeciesPayload {
  speciesId: number;
}

export interface RequestHistoryRangePayload {
  /**
   * Return only events with `id > sinceEventId`; 0 fetches everything the
   * engine still retains. The UI passes the highest ID it has seen, so a
   * telemetry-triggered refresh ships only what is new.
   */
  sinceEventId: number;
}

export interface QueryStateHashPayload {
  /**
   * Run to exactly this tick before hashing, or `null` to hash the current
   * state.
   *
   * This exists for the determinism acceptance test (docs/07): the same seed,
   * config and target tick must produce the same hash whether the ticks were
   * executed by a headless Node run or by the Worker's scheduler. A target in
   * the past is rejected rather than silently ignored — the engine cannot step
   * backwards, and pretending otherwise would make the comparison meaningless.
   */
  targetTick: number | null;
}

export interface RecycleBufferPayload {
  buffer: ArrayBuffer;
}

export interface SetRenderStreamPayload {
  /**
   * Whether the Worker should keep producing render snapshots.
   *
   * Turned off when nothing is watching (hidden tab, world list open). The
   * simulation keeps running: this suppresses a *projection*, never a tick.
   */
  enabled: boolean;
}

export type MainToWorkerMessage =
  | Envelope<"INIT_NEW_WORLD", InitNewWorldPayload>
  | Envelope<"SET_RUN_STATE", SetRunStatePayload>
  | Envelope<"QUERY_ENTITY", QueryEntityPayload>
  | Envelope<"QUERY_SPECIES", QuerySpeciesPayload>
  | Envelope<"REQUEST_TREE", Record<string, never>>
  | Envelope<"REQUEST_HISTORY_RANGE", RequestHistoryRangePayload>
  | Envelope<"QUERY_STATE_HASH", QueryStateHashPayload>
  | Envelope<"RECYCLE_RENDER_BUFFER", RecycleBufferPayload>
  | Envelope<"RECYCLE_VEGETATION_BUFFER", RecycleBufferPayload>
  | Envelope<"SET_RENDER_STREAM", SetRenderStreamPayload>
  | Envelope<"DISPOSE", Record<string, never>>;

export type MainToWorkerType = MainToWorkerMessage["type"];

const MAIN_TO_WORKER_TYPES: readonly MainToWorkerType[] = [
  "INIT_NEW_WORLD",
  "SET_RUN_STATE",
  "QUERY_ENTITY",
  "QUERY_SPECIES",
  "REQUEST_TREE",
  "REQUEST_HISTORY_RANGE",
  "QUERY_STATE_HASH",
  "RECYCLE_RENDER_BUFFER",
  "RECYCLE_VEGETATION_BUFFER",
  "SET_RENDER_STREAM",
  "DISPOSE",
];

// --- Worker -> Main thread ---------------------------------------------------

export interface WorldReadyPayload {
  world: WorldSummaryDto;
  hostRuntime: HostRuntimeConfig;
  /** Packed terrain field; see `./terrainSnapshot`. Transferred. */
  terrain: ArrayBuffer;
  telemetry: TelemetryDto;
}

export interface RenderSnapshotPayload {
  /** Packed render snapshot; see `./renderSnapshot`. Transferred. */
  buffer: ArrayBuffer;
  tick: number;
}

export interface VegetationSnapshotPayload {
  /** Packed vegetation field; see `./terrainSnapshot`. Transferred. */
  buffer: ArrayBuffer;
  tick: number;
}

export interface EntityDetailsPayload {
  entityId: number;
  /**
   * `null` when the entity is not alive.
   *
   * A query answered after its subject died is a normal race, not an error:
   * the main thread selected an organism from a render snapshot that is by
   * definition at least one tick old. The UI shows "no longer alive" and keeps
   * the selection ring where it was.
   */
  details: EntityDetailsDto | null;
  /** Tick at which the answer was read. */
  tick: number;
}

export interface StateHashPayload {
  tick: number;
  hash: string;
  engineVersion: string;
}

export interface SpeciesDetailsPayload {
  speciesId: number;
  /** `null` when the species ID was never issued. */
  details: SpeciesDetailsDto | null;
  /** Tick at which the answer was read. */
  tick: number;
}

export interface TreeSnapshotPayload {
  tree: TreeSnapshotDto;
}

export interface HistoryEventsPayload {
  history: HistorySliceDto;
}

export type WorkerToMainMessage =
  | Envelope<"WORLD_READY", WorldReadyPayload>
  | Envelope<"RENDER_SNAPSHOT", RenderSnapshotPayload>
  | Envelope<"VEGETATION_SNAPSHOT", VegetationSnapshotPayload>
  | Envelope<"TELEMETRY", TelemetryDto>
  | Envelope<"ENTITY_DETAILS", EntityDetailsPayload>
  | Envelope<"SPECIES_DETAILS", SpeciesDetailsPayload>
  | Envelope<"TREE_SNAPSHOT", TreeSnapshotPayload>
  | Envelope<"HISTORY_EVENTS", HistoryEventsPayload>
  | Envelope<"STATE_HASH", StateHashPayload>
  | Envelope<"ERROR", WorkerErrorDto>;

export type WorkerToMainType = WorkerToMainMessage["type"];

// --- Construction ------------------------------------------------------------

/** Build an envelope stamped with the current protocol version. */
export function envelope<T extends string, P>(type: T, payload: P): Envelope<T, P> {
  return { protocolVersion: PROTOCOL_VERSION, type, payload };
}

/** Build a correlated envelope: the response must echo `requestId`. */
export function requestEnvelope<T extends string, P>(
  type: T,
  payload: P,
  requestId: number,
): Envelope<T, P> {
  return { protocolVersion: PROTOCOL_VERSION, requestId, type, payload };
}

// --- Decoding ----------------------------------------------------------------

export type DecodeResult<T> = { ok: true; message: T } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Narrowing predicate rather than a bare `Number.isInteger` check.
 *
 * `Number.isInteger` returns a boolean, not a type guard, so a value read out
 * of an untrusted record stays `unknown` after it — and the only way to build
 * the typed payload would then be a cast, which is exactly what decoding exists
 * to avoid.
 */
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isSpeed(value: unknown): value is SimulationSpeed {
  return (
    value === "paused" ||
    value === "x1" ||
    value === "x5" ||
    value === "x20" ||
    value === "x100" ||
    value === "max"
  );
}

function bad(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * Decode an untrusted `MessageEvent.data` into a main→worker message.
 *
 * Every failure path returns a reason instead of throwing, so the caller can
 * answer with an ERROR envelope and keep the Worker alive. A malformed message
 * must never be able to stop a running simulation.
 */
export function decodeMainToWorkerMessage(data: unknown): DecodeResult<MainToWorkerMessage> {
  if (!isRecord(data)) {
    return bad(`message is not an object (${typeof data})`);
  }
  if (data["protocolVersion"] !== PROTOCOL_VERSION) {
    return bad(
      `unsupported protocol version ${String(data["protocolVersion"])} ` +
        `(this worker speaks ${PROTOCOL_VERSION})`,
    );
  }
  const type = data["type"];
  if (typeof type !== "string" || !(MAIN_TO_WORKER_TYPES as readonly string[]).includes(type)) {
    return bad(`unknown message type ${JSON.stringify(type)}`);
  }
  const requestId = data["requestId"];
  if (requestId !== undefined && !isSafeIndex(requestId)) {
    return bad(`requestId must be a non-negative safe integer, got ${JSON.stringify(requestId)}`);
  }
  const payload = data["payload"];
  if (!isRecord(payload)) {
    return bad(`payload of ${type} is not an object`);
  }

  switch (type as MainToWorkerType) {
    case "INIT_NEW_WORLD": {
      const seed = payload["seed"];
      if (!isInteger(seed)) {
        return bad(`INIT_NEW_WORLD seed must be an integer, got ${String(seed)}`);
      }
      const speed = payload["speed"];
      if (!isSpeed(speed)) {
        return bad(`INIT_NEW_WORLD speed is invalid: ${String(speed)}`);
      }
      const hostRuntime = payload["hostRuntime"];
      if (hostRuntime !== null && !isRecord(hostRuntime)) {
        return bad("INIT_NEW_WORLD hostRuntime must be an object or null");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          type: "INIT_NEW_WORLD",
          payload: {
            seed,
            config: payload["config"] ?? null,
            hostRuntime,
            speed,
          },
        },
      };
    }
    case "SET_RUN_STATE": {
      const speed = payload["speed"];
      if (!isSpeed(speed)) {
        return bad(`SET_RUN_STATE speed is invalid: ${String(speed)}`);
      }
      return {
        ok: true,
        message: { protocolVersion: PROTOCOL_VERSION, type: "SET_RUN_STATE", payload: { speed } },
      };
    }
    case "QUERY_ENTITY": {
      const entityId = payload["entityId"];
      if (!isSafeIndex(entityId)) {
        return bad(`QUERY_ENTITY entityId must be a non-negative safe integer`);
      }
      if (requestId === undefined) {
        return bad("QUERY_ENTITY requires a requestId so the answer can be correlated");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "QUERY_ENTITY",
          payload: { entityId },
        },
      };
    }
    case "QUERY_SPECIES": {
      const speciesId = payload["speciesId"];
      if (!isSafeIndex(speciesId)) {
        return bad("QUERY_SPECIES speciesId must be a non-negative safe integer");
      }
      if (requestId === undefined) {
        return bad("QUERY_SPECIES requires a requestId so the answer can be correlated");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "QUERY_SPECIES",
          payload: { speciesId },
        },
      };
    }
    case "REQUEST_TREE": {
      if (requestId === undefined) {
        return bad("REQUEST_TREE requires a requestId so the answer can be correlated");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "REQUEST_TREE",
          payload: {},
        },
      };
    }
    case "REQUEST_HISTORY_RANGE": {
      const sinceEventId = payload["sinceEventId"];
      if (!isSafeIndex(sinceEventId)) {
        return bad("REQUEST_HISTORY_RANGE sinceEventId must be a non-negative safe integer");
      }
      if (requestId === undefined) {
        return bad("REQUEST_HISTORY_RANGE requires a requestId so the answer can be correlated");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "REQUEST_HISTORY_RANGE",
          payload: { sinceEventId },
        },
      };
    }
    case "QUERY_STATE_HASH": {
      const targetTick = payload["targetTick"];
      if (targetTick !== null && !isSafeIndex(targetTick)) {
        return bad("QUERY_STATE_HASH targetTick must be a non-negative safe integer or null");
      }
      if (requestId === undefined) {
        return bad("QUERY_STATE_HASH requires a requestId so the answer can be correlated");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "QUERY_STATE_HASH",
          payload: { targetTick },
        },
      };
    }
    case "RECYCLE_RENDER_BUFFER":
    case "RECYCLE_VEGETATION_BUFFER": {
      const buffer = payload["buffer"];
      if (!(buffer instanceof ArrayBuffer)) {
        return bad(`${type} payload.buffer must be an ArrayBuffer`);
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          type: type as "RECYCLE_RENDER_BUFFER" | "RECYCLE_VEGETATION_BUFFER",
          payload: { buffer },
        },
      };
    }
    case "SET_RENDER_STREAM": {
      const enabled = payload["enabled"];
      if (typeof enabled !== "boolean") {
        return bad("SET_RENDER_STREAM enabled must be a boolean");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          type: "SET_RENDER_STREAM",
          payload: { enabled },
        },
      };
    }
    case "DISPOSE":
      return {
        ok: true,
        message: { protocolVersion: PROTOCOL_VERSION, type: "DISPOSE", payload: {} },
      };
  }
}

/**
 * Decode an untrusted `MessageEvent.data` into a worker→main message.
 *
 * The main thread is the less hostile direction — it only ever receives what
 * its own Worker sent — but a version check still matters: a page left open
 * across a deploy can hold a Worker built from different source than the page.
 */
export function decodeWorkerToMainMessage(data: unknown): DecodeResult<WorkerToMainMessage> {
  if (!isRecord(data)) {
    return bad(`message is not an object (${typeof data})`);
  }
  if (data["protocolVersion"] !== PROTOCOL_VERSION) {
    return bad(
      `unsupported protocol version ${String(data["protocolVersion"])} ` +
        `(this page speaks ${PROTOCOL_VERSION})`,
    );
  }
  const type = data["type"];
  if (typeof type !== "string") {
    return bad(`message type is not a string (${typeof type})`);
  }
  if (!isRecord(data["payload"])) {
    return bad(`payload of ${type} is not an object`);
  }
  switch (type) {
    case "WORLD_READY":
    case "RENDER_SNAPSHOT":
    case "VEGETATION_SNAPSHOT":
    case "TELEMETRY":
    case "ENTITY_DETAILS":
    case "SPECIES_DETAILS":
    case "TREE_SNAPSHOT":
    case "HISTORY_EVENTS":
    case "STATE_HASH":
    case "ERROR":
      return { ok: true, message: data as unknown as WorkerToMainMessage };
    default:
      return bad(`unknown message type ${JSON.stringify(type)}`);
  }
}
