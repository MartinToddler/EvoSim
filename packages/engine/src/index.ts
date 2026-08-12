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
export { isqrt, qsqrt, powQ } from "./math/isqrt";

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
  GeneRangeConfig,
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
export { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
export { validateConfig, ConfigValidationError } from "./config/validateConfig";
export { hashConfig, canonicalJsonStringify, ConfigSerializationError } from "./config/hashConfig";

// Deterministic value noise (task C02).
export {
  NOISE_SALT,
  latticeValueQ,
  smoothstepQ,
  valueNoiseQ,
  layeredNoiseQ,
  type NoiseOctave,
} from "./math/noise";

// World model (Milestone 2, tasks C02–C09).
export { Biome, BIOME_COUNT, BIOME_NAMES, classifyBiome } from "./world/biomes";
export { EnvironmentStore } from "./world/EnvironmentStore";
export { generateEnvironment, generationSubSeed } from "./world/generateWorld";
export {
  validateWorld,
  landFractionQ,
  distinctBiomeCount,
  labelLandComponents,
  selectFounderRegion,
  type WorldValidity,
  type FounderRegion,
} from "./world/validateWorld";
export { createWorld, WorldGenerationError, type GeneratedWorld } from "./world/createWorld";
export {
  computePlantCapacity,
  recomputeAllPlantCapacities,
  growPlants,
  plantGradientXQAt,
  plantGradientYQAt,
  totalPlantBiomass,
  totalPlantCapacity,
  temperatureSuitabilityQ,
  moistureSuitabilityQ,
} from "./world/plants";
export { updateEnvironment } from "./world/environmentUpdate";
export {
  captureEnvironment,
  restoreEnvironment,
  EnvironmentSnapshotError,
  type EnvironmentSnapshot,
} from "./world/environmentSnapshot";

// Organisms, genome, brain, spatial index and ecology (Milestone 3, D01–D13).
export {
  Gene,
  GENE_COUNT,
  GENE_NAMES,
  GENE_RAW_MAX,
  HUE_DEGREES,
  geneToQ,
  geneFromQ,
  dietSignedQ,
  digestionEfficiencyQ,
  herbivoreAffinityQ,
  carnivoreAffinityQ,
  adultRadiusPos,
  geneMaxSpeedVel,
  accelerationVel,
  geneMaxTurnSteps,
  visionRangePos,
  visionFovSteps,
  metabolicPaceQ,
  thermalOptimumCentiC,
  thermalToleranceCentiC,
  maturityAgeTicks,
  maxAgeTicks,
  offspringInvestmentQ,
  hueDegrees,
  effectiveMaxSpeedVel,
  effectiveMaxTurnSteps,
} from "./genetics/genes";
export { FOUNDER_GENE_Q, createFounderGenes } from "./genetics/founderGenome";
export {
  BRAIN_INPUT_COUNT,
  BRAIN_HIDDEN_COUNT,
  BRAIN_OUTPUT_COUNT,
  BRAIN_WEIGHT_COUNT,
  BRAIN_INPUT_NAMES,
  BRAIN_OUTPUT_NAMES,
  BrainInput,
  BrainOutput,
  IH_OFFSET,
  HO_OFFSET,
  IO_OFFSET,
  ihWeightIndex,
  hoWeightIndex,
  ioWeightIndex,
} from "./brain/BrainLayout";
export { inferBrain, positiveOutputQ } from "./brain/inferBrain";
export { FOUNDER_SKIP_WEIGHTS, createFounderBrainWeights } from "./brain/founderBrain";
export { OrganismStore } from "./organisms/OrganismStore";
export { GenomeStore } from "./organisms/GenomeStore";
export {
  PhenotypeStore,
  derivePhenotype,
  massFromRadiusPos,
  currentRadiusPos,
  maxEnergyForMass,
} from "./organisms/phenotype";
export { thermalStressQ, SEVERE_THERMAL_STRESS_Q } from "./organisms/thermal";
export {
  growthTargetQ,
  basalCost,
  thermalBasalMultiplierQ,
  applyMetabolismGrowthThermalAging,
} from "./organisms/metabolism";
export {
  DeathCause,
  DEATH_CAUSE_COUNT,
  DEATH_CAUSE_NAMES,
  finalizeDeaths,
  markDeath,
} from "./organisms/death";
export {
  VELOCITY_SCALE,
  integrateMovement,
  resolveTerrainAndSoftCollisions,
} from "./organisms/movement";
export {
  FOUNDER_SPECIES_ID,
  FOUNDER_PLACEMENT_ATTEMPTS,
  spawnOrganism,
  spawnFounderPopulation,
  type SpawnRequest,
} from "./organisms/spawn";
export {
  captureOrganisms,
  restoreOrganisms,
  OrganismSnapshotError,
  type OrganismSnapshot,
} from "./organisms/organismSnapshot";
export { SpatialGrid } from "./spatial/SpatialGrid";
export {
  FOV_COS_SCALE,
  findNearestVisibleCreature,
  countCrowding,
  type NearestCreature,
} from "./spatial/queries";
export {
  FeedingTarget,
  plantBiteUnits,
  buildFeedingClaims,
  resolveFeedingClaims,
  totalAllocatedBiomass,
} from "./ecology/feedingClaims";
export { senseAll } from "./brain/sensors";
export { runBrainsAndBuildIntents } from "./brain/intents";
export { EngineScratch } from "./EngineScratch";
export type { EngineContext } from "./EngineContext";

// Engine shell, state hash and snapshots (tasks B05/B06/B08).
// NOTE: `internal.ts` is deliberately not re-exported — the authoritative PRNG
// must stay unreachable from outside this package (see internal.ts).
export { SimulationEngine, type SimulationEngineOptions, MAX_TICK } from "./SimulationEngine";
export { computeStateHash, STATE_HASH_MAGIC } from "./hashState";
export { type EngineCoreSnapshot, SnapshotCompatibilityError } from "./snapshot/EngineSnapshot";
export { engineFromSnapshot } from "./snapshot/deserialize";
