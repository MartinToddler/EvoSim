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
 * Everything docs/02 §§13-14 lists is now here. QUERY_SPECIES, REQUEST_TREE and
 * REQUEST_HISTORY_RANGE arrived with Milestone 8 (protocol 4); QUEUE_COMMAND
 * with Milestone 9 (protocol 5); REQUEST_SAVE, SNAPSHOT_DATA and LOAD_WORLD
 * with Milestone 10 (protocol 6); REQUEST_REWIND, RETURN_TO_PRESENT,
 * CREATE_BRANCH, REWIND_PROGRESS and HISTORICAL_MODE_READY with Milestone 11
 * (protocol 7).
 *
 * ## Why rewinding is split across the port
 *
 * The database lives on the main thread and the engine lives in the Worker, so
 * neither can rewind alone. The main thread picks the newest save at or before
 * the target — it is the only side that can see the saves — and sends the bytes
 * with REQUEST_REWIND. The Worker restores them into a SECOND engine and
 * replays it forward, reporting REWIND_PROGRESS per slice and finishing with
 * HISTORICAL_MODE_READY. The live engine is never touched, which is why
 * "return to present" is a mode switch and not a reload.
 *
 * ## Why saving is a message and not a storage call
 *
 * The engine lives in the Worker, and only the Worker can serialize it. The
 * database lives on the main thread, where the UI can report what happened.
 * REQUEST_SAVE therefore asks the Worker for *bytes* — it does not ask it to
 * store anything — and SNAPSHOT_DATA transfers those bytes back for the main
 * thread to write. LOAD_WORLD is the mirror image. Persistence stays a host
 * concern on both sides of the port, and the engine keeps knowing nothing
 * about storage (docs/02 §3, docs/06 §26).
 */

import {
  COMMAND_KINDS,
  type BrushRequestDto,
  type CommandKindDto,
  type CommandRequestDto,
  type CommandResultDto,
} from "./commands";
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

export interface QueueCommandPayload {
  /**
   * One canonical player command request (Milestone 9). The Worker forwards it
   * to the engine, which validates, stamps identity and records it; the
   * COMMAND_RESULT response echoes the outcome. Commands are the ONLY channel
   * through which the UI can change authoritative state.
   */
  command: CommandRequestDto;
}

/**
 * Why a save was asked for. Echoed back with the bytes so a save started before
 * an autosave can be told apart from it when both answers arrive.
 *
 * `"branch"` is not a third flavour of the same thing: it names bytes that will
 * become a DIFFERENT world's origin (Milestone 11), so the host must write them
 * under a new manifest instead of appending them to the current world's saves.
 */
export type SaveReason = "manual" | "autosave" | "branch";

export interface RequestSavePayload {
  reason: SaveReason;
}

export interface RequestRewindPayload {
  /**
   * The durable save the replay starts from — the newest one at or before
   * `targetTick`. The main thread owns the database and therefore chooses it;
   * the Worker owns the engine and therefore replays it (docs/02 §3).
   */
  snapshot: unknown;
  /** Exact tick to reconstruct. Landing anywhere else is an error, not a rounding. */
  targetTick: number;
}

export interface CreateBranchPayload {
  /**
   * Tick the branch starts from. Must equal the tick of the open historical
   * preview: a branch that claims one tick and carries another is the defect
   * this field exists to catch.
   */
  branchTick: number;
}

export interface LoadWorldPayload {
  /**
   * A durable snapshot container (`@eon/persistence`). Typed as `unknown` for
   * the same reason `InitNewWorldPayload.config` is: the wire must not force
   * `@eon/protocol` to depend on the persistence package, and the bytes are
   * validated on arrival regardless of what the types here claim.
   */
  snapshot: unknown;
  /** Host pacing overrides, or `null` for `DEFAULT_HOST_RUNTIME_CONFIG`. */
  hostRuntime: Partial<HostRuntimeConfig> | null;
  /** Speed to resume at. */
  speed: SimulationSpeed;
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
  | Envelope<"QUEUE_COMMAND", QueueCommandPayload>
  | Envelope<"QUERY_ENTITY", QueryEntityPayload>
  | Envelope<"QUERY_SPECIES", QuerySpeciesPayload>
  | Envelope<"REQUEST_TREE", Record<string, never>>
  | Envelope<"REQUEST_HISTORY_RANGE", RequestHistoryRangePayload>
  | Envelope<"QUERY_STATE_HASH", QueryStateHashPayload>
  | Envelope<"REQUEST_SAVE", RequestSavePayload>
  | Envelope<"LOAD_WORLD", LoadWorldPayload>
  | Envelope<"REQUEST_REWIND", RequestRewindPayload>
  | Envelope<"RETURN_TO_PRESENT", Record<string, never>>
  | Envelope<"CREATE_BRANCH", CreateBranchPayload>
  | Envelope<"RECYCLE_RENDER_BUFFER", RecycleBufferPayload>
  | Envelope<"RECYCLE_VEGETATION_BUFFER", RecycleBufferPayload>
  | Envelope<"SET_RENDER_STREAM", SetRenderStreamPayload>
  | Envelope<"DISPOSE", Record<string, never>>;

export type MainToWorkerType = MainToWorkerMessage["type"];

const MAIN_TO_WORKER_TYPES: readonly MainToWorkerType[] = [
  "INIT_NEW_WORLD",
  "SET_RUN_STATE",
  "QUEUE_COMMAND",
  "QUERY_ENTITY",
  "QUERY_SPECIES",
  "REQUEST_TREE",
  "REQUEST_HISTORY_RANGE",
  "QUERY_STATE_HASH",
  "REQUEST_SAVE",
  "LOAD_WORLD",
  "REQUEST_REWIND",
  "RETURN_TO_PRESENT",
  "CREATE_BRANCH",
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

export interface TerrainSnapshotPayload {
  /**
   * Packed terrain fields, the same layout WORLD_READY ships; see
   * `./terrainSnapshot`. Transferred. Sent again whenever an applied command
   * changed the environment (Milestone 9) — terrain stopped being static the
   * moment the player could raise, lower, flood and scorch it.
   */
  buffer: ArrayBuffer;
  tick: number;
}

export interface CommandResultPayload {
  result: CommandResultDto;
  /** Tick at which the engine answered. */
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

export interface SnapshotDataPayload {
  /** The durable snapshot container. Transferred, not copied. */
  buffer: ArrayBuffer;
  tick: number;
  /** Canonical state hash at `tick`; also inside the container's header. */
  stateHash: string;
  engineVersion: string;
  snapshotSchemaVersion: number;
  configHash: string;
  seed: number;
  /** Echoed from the request. */
  reason: SaveReason;
}

export interface RewindProgressPayload {
  targetTick: number;
  /** Tick of the save the replay started from. */
  fromTick: number;
  currentTick: number;
  ticksReplayed: number;
  ticksTotal: number;
}

export interface HistoricalModeReadyPayload {
  /** Tick now being previewed, read-only. */
  tick: number;
  /** Tick the live world is paused at, so the UI can say "3 548 of 7 097". */
  presentTick: number;
  /** Canonical hash of the reconstructed state, for verification and display. */
  stateHash: string;
  /** Whether this world can be rewound below `tick` (false at a branch origin). */
  earliestTick: number;
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
  | Envelope<"TERRAIN_SNAPSHOT", TerrainSnapshotPayload>
  | Envelope<"TELEMETRY", TelemetryDto>
  | Envelope<"COMMAND_RESULT", CommandResultPayload>
  | Envelope<"ENTITY_DETAILS", EntityDetailsPayload>
  | Envelope<"SPECIES_DETAILS", SpeciesDetailsPayload>
  | Envelope<"TREE_SNAPSHOT", TreeSnapshotPayload>
  | Envelope<"HISTORY_EVENTS", HistoryEventsPayload>
  | Envelope<"STATE_HASH", StateHashPayload>
  | Envelope<"SNAPSHOT_DATA", SnapshotDataPayload>
  | Envelope<"REWIND_PROGRESS", RewindProgressPayload>
  | Envelope<"HISTORICAL_MODE_READY", HistoricalModeReadyPayload>
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
    case "QUEUE_COMMAND": {
      if (requestId === undefined) {
        return bad("QUEUE_COMMAND requires a requestId so the result can be correlated");
      }
      const decoded = decodeCommandRequest(payload["command"]);
      if (!decoded.ok) {
        return bad(`QUEUE_COMMAND ${decoded.reason}`);
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "QUEUE_COMMAND",
          payload: { command: decoded.command },
        },
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
    case "REQUEST_SAVE": {
      if (requestId === undefined) {
        return bad("REQUEST_SAVE requires a requestId so the bytes can be correlated");
      }
      const reason = payload["reason"];
      if (reason !== "manual" && reason !== "autosave" && reason !== "branch") {
        return bad(
          `REQUEST_SAVE reason must be "manual", "autosave" or "branch", got ${String(reason)}`,
        );
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "REQUEST_SAVE",
          payload: { reason },
        },
      };
    }
    case "LOAD_WORLD": {
      const snapshot = payload["snapshot"];
      if (!(snapshot instanceof ArrayBuffer)) {
        return bad("LOAD_WORLD snapshot must be an ArrayBuffer");
      }
      const speed = payload["speed"];
      if (!isSpeed(speed)) {
        return bad(`LOAD_WORLD speed is invalid: ${String(speed)}`);
      }
      const hostRuntime = payload["hostRuntime"];
      if (hostRuntime !== null && !isRecord(hostRuntime)) {
        return bad("LOAD_WORLD hostRuntime must be an object or null");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          type: "LOAD_WORLD",
          payload: { snapshot, hostRuntime, speed },
        },
      };
    }
    case "REQUEST_REWIND": {
      if (requestId === undefined) {
        return bad("REQUEST_REWIND requires a requestId so a stale reply can be discarded");
      }
      const snapshot = payload["snapshot"];
      if (!(snapshot instanceof ArrayBuffer)) {
        return bad("REQUEST_REWIND snapshot must be an ArrayBuffer");
      }
      const targetTick = payload["targetTick"];
      if (!isSafeIndex(targetTick)) {
        return bad(`REQUEST_REWIND targetTick must be a non-negative safe integer`);
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "REQUEST_REWIND",
          payload: { snapshot, targetTick },
        },
      };
    }
    case "RETURN_TO_PRESENT": {
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          type: "RETURN_TO_PRESENT",
          payload: {},
        },
      };
    }
    case "CREATE_BRANCH": {
      if (requestId === undefined) {
        return bad("CREATE_BRANCH requires a requestId so the bytes can be correlated");
      }
      const branchTick = payload["branchTick"];
      if (!isSafeIndex(branchTick)) {
        return bad("CREATE_BRANCH branchTick must be a non-negative safe integer");
      }
      return {
        ok: true,
        message: {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          type: "CREATE_BRANCH",
          payload: { branchTick },
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
 * Structural decode of one command request (Milestone 9).
 *
 * Deliberately SHAPE-only: field types, array parallelism, known kind and
 * falloff names. Values — bounds, signs, integrality — are the ENGINE's to
 * judge, and it answers with a deterministic COMMAND_RESULT rejection rather
 * than a protocol error, so a slider bug in the UI produces a readable "out of
 * bounds" toast instead of a dead message.
 */
function decodeCommandRequest(
  value: unknown,
): { ok: true; command: CommandRequestDto } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "command must be an object" };
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !(COMMAND_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `command kind is unknown: ${JSON.stringify(kind)}` };
  }
  const targetTick = value["targetTick"];
  if (targetTick !== undefined && targetTick !== null && typeof targetTick !== "number") {
    return { ok: false, reason: "command targetTick must be a number, null or absent" };
  }
  const tickField = targetTick === undefined ? {} : { targetTick };

  if (kind === "setGlobalTemperature") {
    const offsetCentiC = value["offsetCentiC"];
    if (typeof offsetCentiC !== "number") {
      return { ok: false, reason: "setGlobalTemperature offsetCentiC must be a number" };
    }
    return { ok: true, command: { kind, offsetCentiC, ...tickField } };
  }

  if (kind === "meteor") {
    const centerXLU = value["centerXLU"];
    const centerYLU = value["centerYLU"];
    const radiusLU = value["radiusLU"];
    if (
      typeof centerXLU !== "number" ||
      typeof centerYLU !== "number" ||
      typeof radiusLU !== "number"
    ) {
      return { ok: false, reason: "meteor centre and radius must be numbers" };
    }
    return { ok: true, command: { kind, centerXLU, centerYLU, radiusLU, ...tickField } };
  }

  const radiusLU = value["radiusLU"];
  const strength = value["strength"];
  const falloff = value["falloff"];
  const samplesXLU = value["samplesXLU"];
  const samplesYLU = value["samplesYLU"];
  if (typeof radiusLU !== "number" || typeof strength !== "number") {
    return { ok: false, reason: `${kind} radius and strength must be numbers` };
  }
  if (falloff !== "linear" && falloff !== "hard") {
    return { ok: false, reason: `${kind} falloff must be "linear" or "hard"` };
  }
  if (!isNumberArray(samplesXLU) || !isNumberArray(samplesYLU)) {
    return { ok: false, reason: `${kind} samples must be number arrays` };
  }
  if (samplesXLU.length !== samplesYLU.length || samplesXLU.length === 0) {
    return { ok: false, reason: `${kind} sample arrays must be parallel and non-empty` };
  }
  const command: BrushRequestDto = {
    kind: kind as BrushRequestDto["kind"],
    radiusLU,
    strength,
    falloff,
    samplesXLU: [...samplesXLU],
    samplesYLU: [...samplesYLU],
    ...tickField,
  };
  return { ok: true, command };
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

/** The wire kind of a command request, for COMMAND_RESULT echoes. */
export function commandKindOf(command: CommandRequestDto): CommandKindDto {
  return command.kind;
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
    case "TERRAIN_SNAPSHOT":
    case "TELEMETRY":
    case "COMMAND_RESULT":
    case "ENTITY_DETAILS":
    case "SPECIES_DETAILS":
    case "TREE_SNAPSHOT":
    case "HISTORY_EVENTS":
    case "STATE_HASH":
    case "SNAPSHOT_DATA":
    case "REWIND_PROGRESS":
    case "HISTORICAL_MODE_READY":
    case "ERROR":
      return { ok: true, message: data as unknown as WorkerToMainMessage };
    default:
      return bad(`unknown message type ${JSON.stringify(type)}`);
  }
}
