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
  MutationClass,
  classifyGeneRoll,
  classifyWeightRoll,
  geneDeltaRaw,
  mutateEcologicalGenes,
  mutateBrainWeights,
  mutateGenome,
} from "./genetics/mutation";
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
  type SpawnEnergy,
} from "./organisms/spawn";
export {
  canReproduce,
  reproductionEnergyCost,
  resolveReproduction,
  type ReproductionCost,
} from "./ecology/reproduction";
export {
  captureOrganisms,
  restoreOrganisms,
  OrganismSnapshotError,
  type OrganismSnapshot,
} from "./organisms/organismSnapshot";
export { SpatialGrid } from "./spatial/SpatialGrid";
export { FOV_COS_SCALE } from "./spatial/fov";
export {
  findNearestVisibleCreature,
  findNearestVisibleCarcass,
  findCarcassInMouthRange,
  findContactTarget,
  countCrowding,
  type NearestCreature,
  type NearestTarget,
} from "./spatial/queries";
export {
  FeedingTarget,
  plantBiteUnits,
  meatBiteUnits,
  buildFeedingClaims,
  resolveFeedingClaims,
  totalAllocatedBiomass,
  totalAllocatedMeat,
} from "./ecology/feedingClaims";

// Predation: carrion and combat (Milestone 5, F01-F08).
export { CarcassStore } from "./ecology/CarcassStore";
export {
  MIN_CARCASS_DECAY_UNITS,
  carcassMeatUnits,
  carcassDecayFractionQ,
  createCarcass,
  decayCarcasses,
} from "./ecology/carcasses";
export {
  attackEnergyCost,
  attackDamageQ,
  buildCombatClaims,
  resolveCombatSimultaneously,
} from "./ecology/combatClaims";
export {
  captureCarcasses,
  restoreCarcasses,
  CarcassSnapshotError,
  type CarcassSnapshot,
} from "./ecology/carcassSnapshot";
export { senseAll } from "./brain/sensors";
export { runBrainsAndBuildIntents } from "./brain/intents";
export { EngineScratch } from "./EngineScratch";
export type { EngineContext } from "./EngineContext";

// Render projection and inspection queries (Milestone 6, tasks G04/G09).
//
// These are read-only projections of authoritative state. They allocate
// nothing, advance no tick and touch no PRNG, so a renderer or an inspector
// cannot change the world it is looking at.
export {
  RenderFlagBit,
  TEMPERATURE_DISPLAY_MAX_CENTI_C,
  TEMPERATURE_DISPLAY_MIN_CENTI_C,
  capacityDisplayReference,
  speedLUPerTick,
  writeRenderSnapshot,
  writeTerrainFields,
  writeVegetationField,
  type RenderSnapshotCounts,
  type RenderSnapshotWriter,
  type StaticWorldFieldsWriter,
} from "./render/renderSnapshot";
export {
  collectTelemetryAggregates,
  queryEntity,
  type EntityDetails,
  type TraitMeans,
} from "./render/queryEntity";

// Phase profiling hooks (CLAUDE.md "Profiling"). The engine reports phase
// boundaries; the host owns the clock.
export {
  TICK_PHASE_COUNT,
  TICK_PHASE_NAMES,
  TickPhase,
  type TickPhaseId,
  type TickProfiler,
} from "./profiling/TickProfiler";

// Engine shell, state hash and snapshots (tasks B05/B06/B08).
export {
  SpeciesStore,
  SpeciesEndReason,
  SPECIES_END_REASON_NAMES,
  SpeciesSnapshotError,
  type SpeciesRecord,
  type SplitCandidateState,
  type SpeciesSnapshot,
} from "./evolution/SpeciesStore";
export {
  TRAIT_VECTOR_VERSION,
  TRAIT_DIMENSIONS,
  TRAIT_DIM_NAMES,
  TraitDim,
  buildTraitRanges,
  writeTraitVector,
  traitDistanceSumSq,
  rmsThresholdSumSq,
  type TraitRanges,
} from "./evolution/traitVector";
export { analyzeSpecies } from "./evolution/speciation";
export {
  EventStore,
  WorldEventType,
  WORLD_EVENT_TYPE_COUNT,
  WORLD_EVENT_TYPE_NAMES,
  EventSeverity,
  EVENT_SEVERITY_NAMES,
  EventSnapshotError,
  type WorldEventRecord,
  type WorldEventInput,
  type EventStoreSnapshot,
} from "./history/EventStore";
export {
  EventDetectors,
  EventDetectorsSnapshotError,
  collectStatisticsAndDetectEvents,
  reportCombatKill,
  POPULATION_BASELINE_WINDOW_SAMPLES,
  POPULATION_EVENT_MIN_ABS_DELTA,
  MASS_EXTINCTION_WINDOW_SAMPLES,
  MASS_EXTINCTION_MAX_LISTED_SPECIES,
  CARNIVORE_PERSIST_SAMPLES,
  CARNIVORE_MIN_INTERVAL_ENERGY,
  type EventDetectorsSnapshot,
} from "./history/eventDetection";
export {
  StatisticsStore,
  StatisticsSnapshotError,
  WorldStatMetric,
  WORLD_STAT_METRIC_COUNT,
  WORLD_STAT_METRIC_NAMES,
  SpeciesStatMetric,
  SPECIES_STAT_METRIC_COUNT,
  SPECIES_STAT_METRIC_NAMES,
  STATS_TIER_COUNT,
  STATS_TIER_RATIO,
  STATS_TIER_CAPACITY,
  SPECIES_SERIES_CAPACITY,
  type StatisticsSnapshot,
  type ExtractedSeries,
} from "./history/StatisticsStore";
export {
  querySpecies,
  queryTree,
  queryHistory,
  type SpeciesSummary,
  type SpeciesDetails,
  type TreeSnapshot,
  type HistorySlice,
} from "./render/querySpecies";
export {
  COMMAND_SCHEMA_VERSION,
  InterventionKind,
  INTERVENTION_KIND_COUNT,
  INTERVENTION_KIND_NAMES,
  COMMAND_TYPE_NAMES,
  BrushFalloff,
  BRUSH_FALLOFF_NAMES,
  CommandRejectReason,
  COMMAND_REJECT_REASON_NAMES,
  isBrushKind,
  brushStrengthBound,
  brushStrengthIsSigned,
  validateCommandInput,
  type SimulationCommand,
  type GlobalTemperatureCommand,
  type BrushCommand,
  type MeteorCommand,
  type BrushKind,
  type CommandInput,
  type GlobalTemperatureInput,
  type BrushInput,
  type MeteorInput,
  type CommandQueueResult,
} from "./commands/SimulationCommand";
export {
  CommandLog,
  CommandLogSnapshotError,
  type CommandLogSnapshot,
} from "./commands/CommandLog";
export { applyCommandsForTick } from "./commands/applyCommands";
export { FIXTURE_COMMANDS } from "./fixtures/fixtureCommands";
export { recomputeDerivedRegion } from "./world/recomputeRegion";
// NOTE: `internal.ts` is deliberately not re-exported — the authoritative PRNG
// must stay unreachable from outside this package (see internal.ts).
export { SimulationEngine, type SimulationEngineOptions, MAX_TICK } from "./SimulationEngine";
export { computeStateHash, STATE_HASH_MAGIC } from "./hashState";
export { type EngineCoreSnapshot, SnapshotCompatibilityError } from "./snapshot/EngineSnapshot";
export { engineFromSnapshot } from "./snapshot/deserialize";

// Historical reconstruction and branch origins (Milestone 11, K07–K10).
export {
  Reconstruction,
  ReconstructionError,
  reconstructAt,
  prepareBranchSnapshot,
  type ReconstructionOptions,
  type ReconstructAtOptions,
  type ReconstructionProgress,
} from "./replay/reconstruct";
