import { BIOME_COUNT } from "../world/biomes";
import { Q } from "../math/fixed";
import { CONFIG_SCHEMA_VERSION } from "../version";
import type { SimulationConfig } from "./SimulationConfig";

/** Error thrown when a SimulationConfig violates structural invariants. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new ConfigValidationError(message);
  }
}

function checkPositiveInt(value: number, name: string): void {
  check(Number.isInteger(value) && value > 0, `${name} must be a positive integer, got ${value}`);
}

function checkNonNegativeInt(value: number, name: string): void {
  check(
    Number.isInteger(value) && value >= 0,
    `${name} must be a non-negative integer, got ${value}`,
  );
}

function checkQFraction(value: number, name: string): void {
  check(
    Number.isInteger(value) && value >= 0 && value <= Q,
    `${name} must be an integer Q fraction in [0, ${Q}], got ${value}`,
  );
}

/**
 * Validate structural invariants of a SimulationConfig (task C01 shell).
 * Throws {@link ConfigValidationError} on the first violation.
 *
 * This checks representation invariants, not ecological balance — calibration
 * is a separate concern (docs/07 part C).
 */
export function validateConfig(config: SimulationConfig): void {
  check(
    config.schemaVersion === CONFIG_SCHEMA_VERSION,
    `config schemaVersion ${config.schemaVersion} does not match supported version ${CONFIG_SCHEMA_VERSION}`,
  );

  const { world, time, plants, organism, limits } = config;

  // World geometry.
  checkPositiveInt(world.sizeLU, "world.sizeLU");
  checkPositiveInt(world.envGridSize, "world.envGridSize");
  checkPositiveInt(world.envCellSizeLU, "world.envCellSizeLU");
  checkPositiveInt(world.spatialCellSizeLU, "world.spatialCellSizeLU");
  check(
    world.envGridSize * world.envCellSizeLU === world.sizeLU,
    "world: envGridSize * envCellSizeLU must equal sizeLU",
  );
  check(
    world.sizeLU % world.spatialCellSizeLU === 0,
    "world: spatialCellSizeLU must divide sizeLU",
  );

  checkQFraction(world.seaLevelQ, "world.seaLevelQ");
  checkQFraction(world.mountainLevelQ, "world.mountainLevelQ");
  check(world.seaLevelQ < world.mountainLevelQ, "world: seaLevelQ must be below mountainLevelQ");
  checkQFraction(world.minLandFractionQ, "world.minLandFractionQ");
  checkQFraction(world.maxLandFractionQ, "world.maxLandFractionQ");
  check(
    world.minLandFractionQ < world.maxLandFractionQ,
    "world: minLandFractionQ must be below maxLandFractionQ",
  );
  checkPositiveInt(world.generationMaxRetries, "world.generationMaxRetries");
  checkPositiveInt(world.initialOrganisms, "world.initialOrganisms");
  checkPositiveInt(world.founderSpawnRadiusLU, "world.founderSpawnRadiusLU");

  // Time intervals (authoritative scheduling).
  checkPositiveInt(time.ticksPerSimYear, "time.ticksPerSimYear");
  checkPositiveInt(time.environmentInterval, "time.environmentInterval");
  checkPositiveInt(time.carcassDecayInterval, "time.carcassDecayInterval");
  checkPositiveInt(time.statisticsInterval, "time.statisticsInterval");
  checkPositiveInt(time.speciesAnalysisInterval, "time.speciesAnalysisInterval");
  checkPositiveInt(time.autosaveCheckInterval, "time.autosaveCheckInterval");
  checkPositiveInt(time.targetTicksPerSecond1x, "time.targetTicksPerSecond1x");
  checkPositiveInt(time.normalRenderSnapshotsPerSecond, "time.normalRenderSnapshotsPerSecond");
  checkPositiveInt(time.maxModeRenderSnapshotsPerSecond, "time.maxModeRenderSnapshotsPerSecond");
  checkPositiveInt(time.maxWorkerSliceMs, "time.maxWorkerSliceMs");

  // Plants.
  check(
    plants.baseCapacityByBiome.length === BIOME_COUNT,
    `plants.baseCapacityByBiome must have ${BIOME_COUNT} entries`,
  );
  check(
    plants.growthRateQByBiome.length === BIOME_COUNT,
    `plants.growthRateQByBiome must have ${BIOME_COUNT} entries`,
  );
  for (let i = 0; i < BIOME_COUNT; i += 1) {
    checkNonNegativeInt(
      plants.baseCapacityByBiome[i] as number,
      `plants.baseCapacityByBiome[${i}]`,
    );
    checkNonNegativeInt(plants.growthRateQByBiome[i] as number, `plants.growthRateQByBiome[${i}]`);
  }
  checkNonNegativeInt(plants.plantSeedBankRegenUnits, "plants.plantSeedBankRegenUnits");
  checkNonNegativeInt(plants.plantMinRegenThreshold, "plants.plantMinRegenThreshold");
  checkPositiveInt(plants.plantEnergyPerBiomass, "plants.plantEnergyPerBiomass");
  checkPositiveInt(plants.meatEnergyPerUnit, "plants.meatEnergyPerUnit");

  // Organism fractions used as Q values.
  checkQFraction(organism.birthSizeFractionQ, "organism.birthSizeFractionQ");
  checkQFraction(organism.reproductionMinDevelopmentQ, "organism.reproductionMinDevelopmentQ");
  checkQFraction(organism.initialEnergyFractionQ, "organism.initialEnergyFractionQ");
  checkPositiveInt(organism.massScalePerRadiusSquared, "organism.massScalePerRadiusSquared");
  checkPositiveInt(organism.baseMaxEnergy, "organism.baseMaxEnergy");
  checkPositiveInt(organism.maxEnergyPerMass, "organism.maxEnergyPerMass");
  checkPositiveInt(organism.basal.minimumBasalPerTick, "organism.basal.minimumBasalPerTick");
  check(
    organism.movement.waterMovementCostMultiplierQ >= Q,
    "organism.movement.waterMovementCostMultiplierQ must be >= Q (a multiplier of at least 1.0)",
  );
  checkQFraction(
    organism.movement.waterSpeedMultiplierQ,
    "organism.movement.waterSpeedMultiplierQ",
  );
  checkQFraction(
    organism.movement.armorMaxSpeedPenaltyQ,
    "organism.movement.armorMaxSpeedPenaltyQ",
  );
  checkQFraction(organism.movement.sizeMaxTurnPenaltyQ, "organism.movement.sizeMaxTurnPenaltyQ");
  checkQFraction(organism.feeding.eatOutputThresholdQ, "organism.feeding.eatOutputThresholdQ");
  check(
    organism.feeding.digestionEfficiencyFloorQ + organism.feeding.digestionEfficiencySpanQ <= Q,
    "organism.feeding: digestion efficiency floor + span must not exceed Q",
  );

  // Brain topology is fixed for v0.1 (docs/04 §10).
  const { brain } = config;
  check(
    brain.weightCount ===
      brain.inputCount * brain.hiddenCount +
        brain.hiddenCount * brain.outputCount +
        brain.inputCount * brain.outputCount,
    "brain.weightCount must equal inputs*hidden + hidden*outputs + inputs*outputs",
  );
  check(brain.weightMin < brain.weightMax, "brain.weightMin must be below brain.weightMax");
  checkPositiveInt(brain.valueScale, "brain.valueScale");
  checkPositiveInt(brain.weightScale, "brain.weightScale");

  // Mutation probabilities are Q fractions.
  const { ecological, brain: brainMut } = config.mutation;
  checkQFraction(
    ecological.perGeneMutationProbabilityQ,
    "mutation.ecological.perGeneMutationProbabilityQ",
  );
  checkQFraction(
    ecological.largeMutationProbabilityQ,
    "mutation.ecological.largeMutationProbabilityQ",
  );
  checkQFraction(ecological.resetProbabilityQ, "mutation.ecological.resetProbabilityQ");
  checkQFraction(
    brainMut.perWeightMutationProbabilityQ,
    "mutation.brain.perWeightMutationProbabilityQ",
  );
  checkQFraction(
    brainMut.largeWeightMutationProbabilityQ,
    "mutation.brain.largeWeightMutationProbabilityQ",
  );

  // Combat/reproduction thresholds.
  checkQFraction(config.combat.attackOutputThresholdQ, "combat.attackOutputThresholdQ");
  checkQFraction(config.combat.maxArmorDamageReductionQ, "combat.maxArmorDamageReductionQ");
  checkQFraction(
    config.reproduction.reproduceOutputThresholdQ,
    "reproduction.reproduceOutputThresholdQ",
  );
  checkQFraction(
    config.reproduction.minParentReserveFractionQ,
    "reproduction.minParentReserveFractionQ",
  );
  check(
    config.reproduction.childSpawnDistanceMinLU <= config.reproduction.childSpawnDistanceMaxLU,
    "reproduction: childSpawnDistanceMinLU must be <= childSpawnDistanceMaxLU",
  );

  // Limits.
  checkPositiveInt(limits.maxOrganisms, "limits.maxOrganisms");
  checkPositiveInt(limits.maxCarcasses, "limits.maxCarcasses");
  checkPositiveInt(limits.maxDetailedRenderedOrganisms, "limits.maxDetailedRenderedOrganisms");
  checkPositiveInt(limits.recentDeadHistorySize, "limits.recentDeadHistorySize");
  checkPositiveInt(
    limits.maxTimelineEventsInMemoryBeforeChunk,
    "limits.maxTimelineEventsInMemoryBeforeChunk",
  );
  check(
    world.initialOrganisms <= limits.maxOrganisms,
    "world.initialOrganisms must not exceed limits.maxOrganisms",
  );
}
