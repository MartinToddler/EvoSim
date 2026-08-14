/**
 * @eon/protocol — versioned wire contract between the main thread and the
 * simulation Worker (docs/02 §§12-15).
 *
 * Pure serializable data and binary layouts. No React, no Pixi, no DOM, and no
 * dependency on `@eon/engine`: the render snapshot layout here matches the
 * engine's writer interface structurally, so neither package imports the other.
 */

export { PROTOCOL_VERSION } from "./version";
export type { Envelope } from "./envelope";
export {
  type HostRuntimeConfig,
  DEFAULT_HOST_RUNTIME_CONFIG,
  HOST_RUNTIME_CONFIG_SCHEMA_VERSION,
} from "./hostRuntimeConfig";
export {
  validateHostRuntimeConfig,
  HostRuntimeConfigValidationError,
} from "./validateHostRuntimeConfig";

// Data transfer objects (Milestone 6, task G01; species/history in Milestone 8).
export {
  SIMULATION_SPEEDS,
  SPEED_MULTIPLIER,
  isSimulationSpeed,
  targetTicksPerSecond,
  type EntityDetailsDto,
  type HistorySliceDto,
  type SimulationSpeed,
  type SpeciesDetailsDto,
  type SpeciesSummaryDto,
  type TelemetryDto,
  type TraitMeansDto,
  type TreeSnapshotDto,
  type WorkerErrorDto,
  type WorldDisplayDto,
  type WorldEventDto,
  type WorldSummaryDto,
} from "./dto";

// Message unions and safe decoding (task G01).
export {
  decodeMainToWorkerMessage,
  decodeWorkerToMainMessage,
  envelope,
  requestEnvelope,
  type DecodeResult,
  type EntityDetailsPayload,
  type HistoryEventsPayload,
  type InitNewWorldPayload,
  type MainToWorkerMessage,
  type MainToWorkerType,
  type QueryEntityPayload,
  type QuerySpeciesPayload,
  type QueryStateHashPayload,
  type RecycleBufferPayload,
  type RenderSnapshotPayload,
  type RequestHistoryRangePayload,
  type SetRenderStreamPayload,
  type SetRunStatePayload,
  type SpeciesDetailsPayload,
  type StateHashPayload,
  type TreeSnapshotPayload,
  type VegetationSnapshotPayload,
  type WorkerToMainMessage,
  type WorkerToMainType,
  type WorldReadyPayload,
} from "./messages";

// Packed render snapshot transport (task G04).
export {
  RENDER_HEADER_FIELDS,
  RENDER_SNAPSHOT_LAYOUT_VERSION,
  RENDER_SNAPSHOT_MAGIC,
  RenderBufferPool,
  RenderFlag,
  RenderHeader,
  RenderSnapshotFormatError,
  computeRenderSnapshotLayout,
  createRenderSnapshotBuffer,
  readRenderSnapshotCounts,
  viewRenderSnapshot,
  type RenderSnapshotView,
} from "./renderSnapshot";

// Environment field transport (task G05).
export {
  FIELD_HEADER_FIELDS,
  FIELD_SNAPSHOT_LAYOUT_VERSION,
  FieldHeader,
  FieldSnapshotFormatError,
  TERRAIN_SNAPSHOT_MAGIC,
  VEGETATION_SNAPSHOT_MAGIC,
  VegetationBufferPool,
  createTerrainBuffer,
  createVegetationBuffer,
  viewTerrainSnapshot,
  viewVegetationSnapshot,
  type TerrainSnapshotView,
  type VegetationSnapshotView,
} from "./terrainSnapshot";
