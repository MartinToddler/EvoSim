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
  type PhysicalPhenotypeDto,
  type HistorySliceDto,
  type SimulationSpeed,
  type SpeciesDetailsDto,
  type SpeciesSummaryDto,
  type MemoryTelemetryDto,
  type TelemetryDto,
  type TraitMeansDto,
  type TreeSnapshotDto,
  type WorkerErrorDto,
  type WorldDisplayDto,
  type WorldEventDto,
  type WorldSummaryDto,
} from "./dto";

// Player commands and canonical stroke resampling (Milestone 9, tasks J01–J02).
export {
  COMMAND_KINDS,
  COMMAND_REJECT_REASONS,
  resampleStroke,
  type BrushFalloffDto,
  type BrushKindDto,
  type BrushRequestDto,
  type CanonicalStroke,
  type CommandKindDto,
  type CommandRejectReasonDto,
  type CommandRequestDto,
  type CommandResultDto,
  type GlobalTemperatureRequestDto,
  type InterventionDisplayDto,
  type MeteorRequestDto,
  type ResampleStrokeOptions,
  type StrokePointLU,
} from "./commands";

// Message unions and safe decoding (task G01).
export {
  commandKindOf,
  decodeMainToWorkerMessage,
  decodeWorkerToMainMessage,
  envelope,
  requestEnvelope,
  type CommandResultPayload,
  type DecodeResult,
  type EntityDetailsPayload,
  type HistoryEventsPayload,
  type InitNewWorldPayload,
  type LoadWorldPayload,
  type MainToWorkerMessage,
  type MainToWorkerType,
  type QueryEntityPayload,
  type QuerySpeciesPayload,
  type QueryStateHashPayload,
  type QueueCommandPayload,
  type RecycleBufferPayload,
  type RenderSnapshotPayload,
  type RequestHistoryRangePayload,
  type RequestSavePayload,
  type RequestRewindPayload,
  type CreateBranchPayload,
  type RewindProgressPayload,
  type HistoricalModeReadyPayload,
  type SaveReason,
  type SetRenderStreamPayload,
  type SnapshotDataPayload,
  type SetRunStatePayload,
  type SpeciesDetailsPayload,
  type StateHashPayload,
  type TerrainSnapshotPayload,
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

// M14 morphology channels in the render snapshot.
export {
  MorphChannel,
  MORPH_CHANNEL_COUNT,
  MORPH_CHANNEL_NAMES,
  MORPH_MAGNITUDE_SCALE,
  morphMagnitude,
} from "./morphChannels";
