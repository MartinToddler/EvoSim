// @eon/engine — pure deterministic simulation core (no React/Pixi/DOM/wall clock).

export { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION } from "./version";

// Fixed-point math and angles (tasks B01/B02).
export {
  Q,
  POS_SCALE,
  ANGLE_STEPS,
  TRIG_SCALE,
  qmul,
  qdiv,
  clamp,
  clampQ,
  clampSignedQ,
  lerpQ,
  distSq,
  absInt,
} from "./math/fixed";
export { wrapAngle, addAngle, signedAngleDiff, degreesToSteps } from "./math/angle";
export { SIN_LUT, sinLut, cosLut } from "./math/trigLut";

// Canonical hashing (task B06).
export { StateHash, HASH_TAG, hashWords } from "./math/hash";

// Deterministic randomness (tasks B03/B04).
export { Xoshiro128, splitmix32, type Xoshiro128State } from "./random/Xoshiro128";
export { statelessNoiseU32, statelessNoiseSignedQ } from "./random/statelessNoise";

// Configuration (default config shell for Milestone 1).
export type {
  SimulationConfig,
  WorldConfig,
  TimeConfig,
  PlantConfig,
  OrganismConfig,
  SenseConfig,
  BrainConfig,
  MutationConfig,
  CombatConfig,
  ReproductionConfig,
  SpeciesConfig,
  HistoryConfig,
  LimitConfig,
} from "./config/SimulationConfig";
export { DEFAULT_CONFIG } from "./config/defaultConfig";
export { validateConfig, ConfigValidationError } from "./config/validateConfig";
export { hashConfig, canonicalJsonStringify, ConfigSerializationError } from "./config/hashConfig";

// World constants shared with config (full world model arrives in Milestone 2).
export { Biome, BIOME_COUNT } from "./world/biomes";

// Engine shell, state hash and snapshots (tasks B05/B06/B08).
export { SimulationEngine, type SimulationEngineOptions } from "./SimulationEngine";
export { computeStateHash, STATE_HASH_MAGIC } from "./hashState";
export type { EngineCoreSnapshot } from "./snapshot/EngineSnapshot";
export { engineFromSnapshot, SnapshotCompatibilityError } from "./snapshot/deserialize";
