import type { DeepReadonly } from "@eon/shared";
import { Q, qmul } from "../math/fixed";
import { CONFIG_SCHEMA_VERSION } from "../version";
import { Biome, BIOME_COUNT } from "../world/biomes";
import type { SimulationConfig } from "./SimulationConfig";

/** Error thrown when a SimulationConfig violates structural invariants. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Plausibility bound for temperature fields expressed in hundredths of °C.
 * Wide enough for any calibration the project could want (-200 °C … +200 °C),
 * narrow enough to catch a unit mix-up (e.g. writing 18 for 18 °C, or a raw
 * Kelvin value).
 */
const TEMPERATURE_CENTI_C_LIMIT = 20_000;

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new ConfigValidationError(message);
  }
}

function checkInt(value: number, name: string): void {
  check(Number.isSafeInteger(value), `${name} must be a safe integer, got ${value}`);
}

function checkPositiveInt(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer, got ${value}`,
  );
}

function checkNonNegativeInt(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value >= 0,
    `${name} must be a non-negative integer, got ${value}`,
  );
}

/** Normalized fraction in [0, Q] — the standard Q encoding of 0.0 … 1.0. */
function checkQFraction(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value >= 0 && value <= Q,
    `${name} must be an integer Q fraction in [0, ${Q}], got ${value}`,
  );
}

/** Q-scaled multiplier that must be at least 1.0 (i.e. >= Q). */
function checkQMultiplierAtLeastOne(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value >= Q,
    `${name} must be a Q multiplier >= ${Q} (1.0), got ${value}`,
  );
}

/**
 * Q-scaled coefficient that may exceed Q (rates, damage bases, cost
 * coefficients). Only the sign and integrality are structural.
 */
function checkPositiveQCoefficient(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive Q-scaled coefficient, got ${value}`,
  );
}

function checkNonNegativeQCoefficient(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) && value >= 0,
    `${name} must be a non-negative Q-scaled coefficient, got ${value}`,
  );
}

/** Temperature in hundredths of °C. Negative values are legitimate. */
function checkCentiCelsius(value: number, name: string): void {
  check(
    Number.isSafeInteger(value) &&
      value >= -TEMPERATURE_CENTI_C_LIMIT &&
      value <= TEMPERATURE_CENTI_C_LIMIT,
    `${name} must be an integer centi-Celsius value within ±${TEMPERATURE_CENTI_C_LIMIT}, got ${value}`,
  );
}

function checkNonNegativeIntArray(
  values: readonly number[],
  expectedLength: number,
  name: string,
): void {
  check(values.length === expectedLength, `${name} must have ${expectedLength} entries`);
  for (let i = 0; i < values.length; i += 1) {
    checkNonNegativeInt(values[i] as number, `${name}[${i}]`);
  }
}

/**
 * Validate structural invariants of a SimulationConfig.
 *
 * Every leaf field is checked for type and representable range, so world,
 * organism and evolution code written in later milestones can consume these
 * values without re-validating. What this deliberately does NOT check is
 * ecological balance: whether a value produces a viable ecosystem is a
 * calibration question answered by sweeps (docs/07 part C), not by a schema
 * check. Bounds here are therefore permissive where tuning must stay free, and
 * strict only where a value is structurally impossible (negative energy costs,
 * fractions above 1.0, multipliers below 1.0, mismatched array lengths).
 *
 * Accepts deeply readonly configs so frozen configurations can be re-validated.
 * Throws {@link ConfigValidationError} on the first violation.
 */
export function validateConfig(config: DeepReadonly<SimulationConfig>): void {
  check(
    config.schemaVersion === CONFIG_SCHEMA_VERSION,
    `config schemaVersion ${config.schemaVersion} does not match supported version ${CONFIG_SCHEMA_VERSION}`,
  );

  validateWorld(config);
  validateTime(config);
  validatePlants(config);
  validateOrganism(config);
  validateBrain(config);
  validateMutation(config);
  validateCombat(config);
  validateReproduction(config);
  validateSpecies(config);
  validateHistory(config);
  validateLimits(config);
}

function validateWorld(config: DeepReadonly<SimulationConfig>): void {
  const { world } = config;

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
  check(
    world.founderSpawnRadiusLU * 2 <= world.sizeLU,
    "world: founder spawn diameter must fit inside the world",
  );

  const thresholds = world.biomeThresholds;
  checkCentiCelsius(
    thresholds.tundraTemperatureCentiC,
    "world.biomeThresholds.tundraTemperatureCentiC",
  );
  checkCentiCelsius(
    thresholds.desertMinTemperatureCentiC,
    "world.biomeThresholds.desertMinTemperatureCentiC",
  );
  checkQFraction(thresholds.desertMaxMoistureQ, "world.biomeThresholds.desertMaxMoistureQ");
  checkQFraction(thresholds.forestMinMoistureQ, "world.biomeThresholds.forestMinMoistureQ");
  checkQFraction(thresholds.forestMinFertilityQ, "world.biomeThresholds.forestMinFertilityQ");
  check(
    thresholds.tundraTemperatureCentiC < thresholds.desertMinTemperatureCentiC,
    "world.biomeThresholds: tundra temperature must be below the desert minimum temperature",
  );
  check(
    thresholds.desertMaxMoistureQ < thresholds.forestMinMoistureQ,
    "world.biomeThresholds: desert maximum moisture must be below the forest minimum moisture",
  );

  validateGeneration(world);
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function validateGeneration(world: DeepReadonly<SimulationConfig>["world"]): void {
  const generation = world.generation;

  check(
    generation.elevationOctaves.length > 0,
    "world.generation.elevationOctaves must contain at least one octave",
  );
  let weightSum = 0;
  for (let i = 0; i < generation.elevationOctaves.length; i += 1) {
    const octave = generation.elevationOctaves[i] as { wavelengthCells: number; weightQ: number };
    // Power-of-two wavelengths keep the lattice aligned to the grid, so the
    // fractional position inside a lattice cell is an exact Q value.
    check(
      isPowerOfTwo(octave.wavelengthCells),
      `world.generation.elevationOctaves[${i}].wavelengthCells must be a power of two, got ${octave.wavelengthCells}`,
    );
    checkQFraction(octave.weightQ, `world.generation.elevationOctaves[${i}].weightQ`);
    weightSum += octave.weightQ;
  }
  check(
    weightSum === Q,
    `world.generation.elevationOctaves weights must sum to exactly ${Q}, got ${weightSum}`,
  );

  checkPositiveInt(generation.edgeFalloffCells, "world.generation.edgeFalloffCells");
  check(
    generation.edgeFalloffCells * 2 < world.envGridSize,
    "world.generation.edgeFalloffCells must leave land in the middle of the grid",
  );
  for (const [name, value] of [
    ["moistureWavelengthCells", generation.moistureWavelengthCells],
    ["temperatureWavelengthCells", generation.temperatureWavelengthCells],
    ["fertilityWavelengthCells", generation.fertilityWavelengthCells],
  ] as const) {
    check(isPowerOfTwo(value), `world.generation.${name} must be a power of two, got ${value}`);
  }
  checkPositiveInt(generation.waterInfluencePasses, "world.generation.waterInfluencePasses");
  check(
    generation.waterInfluencePasses < Q,
    "world.generation.waterInfluencePasses must stay below Q so each pass decays by at least one unit",
  );

  const validity = world.validity;
  checkPositiveInt(validity.minFounderRegionCells, "world.validity.minFounderRegionCells");
  check(
    validity.minFounderRegionCells <= world.envGridSize * world.envGridSize,
    "world.validity.minFounderRegionCells cannot exceed the number of cells",
  );
  checkPositiveInt(validity.minTotalPlantCapacity, "world.validity.minTotalPlantCapacity");
  checkPositiveInt(validity.minBiomeClasses, "world.validity.minBiomeClasses");
  check(
    validity.minBiomeClasses <= BIOME_COUNT,
    `world.validity.minBiomeClasses cannot exceed ${BIOME_COUNT}`,
  );

  const moisture = world.moisture;
  checkQFraction(moisture.noiseWeightQ, "world.moisture.noiseWeightQ");
  checkQFraction(moisture.inverseElevationWeightQ, "world.moisture.inverseElevationWeightQ");
  checkQFraction(moisture.waterInfluenceWeightQ, "world.moisture.waterInfluenceWeightQ");
  check(
    moisture.noiseWeightQ + moisture.inverseElevationWeightQ + moisture.waterInfluenceWeightQ === Q,
    `world.moisture weights must sum to exactly ${Q}`,
  );

  const climate = world.climate;
  checkCentiCelsius(climate.equatorTemperatureCentiC, "world.climate.equatorTemperatureCentiC");
  checkNonNegativeInt(climate.poleTemperatureDropCentiC, "world.climate.poleTemperatureDropCentiC");
  checkNonNegativeInt(climate.elevationCoolingCentiC, "world.climate.elevationCoolingCentiC");
  checkNonNegativeInt(
    climate.temperatureNoiseAmplitudeCentiC,
    "world.climate.temperatureNoiseAmplitudeCentiC",
  );

  const fertility = world.fertility;
  checkQFraction(fertility.moistureWeightQ, "world.fertility.moistureWeightQ");
  checkQFraction(fertility.temperatureWeightQ, "world.fertility.temperatureWeightQ");
  checkQFraction(fertility.lowlandWeightQ, "world.fertility.lowlandWeightQ");
  checkQFraction(fertility.noiseWeightQ, "world.fertility.noiseWeightQ");
  check(
    fertility.moistureWeightQ +
      fertility.temperatureWeightQ +
      fertility.lowlandWeightQ +
      fertility.noiseWeightQ ===
      Q,
    `world.fertility weights must sum to exactly ${Q}`,
  );
  checkCentiCelsius(fertility.optimumTemperatureCentiC, "world.fertility.optimumTemperatureCentiC");
  checkPositiveInt(fertility.toleranceCentiC, "world.fertility.toleranceCentiC");
}

function validateTime(config: DeepReadonly<SimulationConfig>): void {
  const { time } = config;
  checkPositiveInt(time.environmentInterval, "time.environmentInterval");
  checkPositiveInt(time.carcassDecayInterval, "time.carcassDecayInterval");
  checkPositiveInt(time.statisticsInterval, "time.statisticsInterval");
  checkPositiveInt(time.speciesAnalysisInterval, "time.speciesAnalysisInterval");
}

function validatePlants(config: DeepReadonly<SimulationConfig>): void {
  const { plants } = config;
  checkNonNegativeIntArray(plants.baseCapacityByBiome, BIOME_COUNT, "plants.baseCapacityByBiome");
  checkNonNegativeIntArray(plants.growthRateQByBiome, BIOME_COUNT, "plants.growthRateQByBiome");
  for (let i = 0; i < BIOME_COUNT; i += 1) {
    checkQFraction(plants.growthRateQByBiome[i] as number, `plants.growthRateQByBiome[${i}]`);
  }
  // Water grows nothing: aquatic ecology is explicitly out of MVP scope
  // (CLAUDE.md scope exclusions), and non-zero water capacity would place food
  // where terrestrial organisms drown.
  check(
    plants.baseCapacityByBiome[Biome.Water] === 0 && plants.growthRateQByBiome[Biome.Water] === 0,
    "plants: water biome capacity and growth rate must be 0 while aquatic life is out of scope",
  );
  checkNonNegativeInt(plants.plantSeedBankRegenUnits, "plants.plantSeedBankRegenUnits");
  checkNonNegativeInt(plants.plantMinRegenThreshold, "plants.plantMinRegenThreshold");
  checkPositiveInt(plants.plantEnergyPerBiomass, "plants.plantEnergyPerBiomass");
  checkPositiveInt(plants.meatEnergyPerUnit, "plants.meatEnergyPerUnit");
  checkQFraction(plants.initialBiomassFractionQ, "plants.initialBiomassFractionQ");

  const suitability = plants.capacitySuitability;
  checkCentiCelsius(
    suitability.optimumTemperatureCentiC,
    "plants.capacitySuitability.optimumTemperatureCentiC",
  );
  checkPositiveInt(
    suitability.temperatureToleranceCentiC,
    "plants.capacitySuitability.temperatureToleranceCentiC",
  );
  checkQFraction(suitability.minMoistureQ, "plants.capacitySuitability.minMoistureQ");
  checkQFraction(suitability.fullMoistureQ, "plants.capacitySuitability.fullMoistureQ");
  check(
    suitability.minMoistureQ < suitability.fullMoistureQ,
    "plants.capacitySuitability: minMoistureQ must be below fullMoistureQ",
  );
  // Every biome base capacity must fit the Uint16 biomass arrays.
  for (let i = 0; i < BIOME_COUNT; i += 1) {
    check(
      (plants.baseCapacityByBiome[i] as number) <= 65535,
      `plants.baseCapacityByBiome[${i}] must fit in the Uint16 biomass array (<= 65535)`,
    );
  }
}

function validateOrganism(config: DeepReadonly<SimulationConfig>): void {
  const { organism } = config;

  checkPositiveInt(organism.massScalePerRadiusSquared, "organism.massScalePerRadiusSquared");
  checkPositiveInt(organism.baseMaxEnergy, "organism.baseMaxEnergy");
  checkPositiveInt(organism.maxEnergyPerMass, "organism.maxEnergyPerMass");
  checkQFraction(organism.birthSizeFractionQ, "organism.birthSizeFractionQ");
  checkQFraction(organism.reproductionMinDevelopmentQ, "organism.reproductionMinDevelopmentQ");
  checkQFraction(organism.initialEnergyFractionQ, "organism.initialEnergyFractionQ");
  // Zero is a legitimate ablation ("growth is free"), so non-negative, not positive.
  checkNonNegativeInt(organism.energyPerGrowthMass, "organism.energyPerGrowthMass");
  check(
    organism.birthSizeFractionQ < organism.reproductionMinDevelopmentQ,
    "organism: birth size fraction must be below the development required to reproduce",
  );

  const { basal } = organism;
  checkNonNegativeQCoefficient(basal.baseMassPaceCoeffQ, "organism.basal.baseMassPaceCoeffQ");
  checkNonNegativeQCoefficient(basal.muscleCapacityCoeffQ, "organism.basal.muscleCapacityCoeffQ");
  checkNonNegativeInt(basal.visionBaseCost, "organism.basal.visionBaseCost");
  checkNonNegativeQCoefficient(basal.attackMaintCoeffQ, "organism.basal.attackMaintCoeffQ");
  checkNonNegativeQCoefficient(basal.armorMaintCoeffQ, "organism.basal.armorMaintCoeffQ");
  checkNonNegativeQCoefficient(basal.toleranceMaintCoeffQ, "organism.basal.toleranceMaintCoeffQ");
  checkNonNegativeQCoefficient(basal.longevityMaintCoeffQ, "organism.basal.longevityMaintCoeffQ");
  // docs/08 §9: a living organism always pays at least 1 energy/tick.
  checkPositiveInt(basal.minimumBasalPerTick, "organism.basal.minimumBasalPerTick");
  check(
    basal.minimumBasalPerTick <= organism.baseMaxEnergy,
    "organism.basal.minimumBasalPerTick must not exceed baseMaxEnergy or nothing could survive a tick",
  );

  const { movement } = organism;
  checkNonNegativeQCoefficient(movement.movementCostCoeffQ, "organism.movement.movementCostCoeffQ");
  checkNonNegativeQCoefficient(
    movement.accelerationCostCoeffQ,
    "organism.movement.accelerationCostCoeffQ",
  );
  checkQFraction(movement.waterSpeedMultiplierQ, "organism.movement.waterSpeedMultiplierQ");
  checkQMultiplierAtLeastOne(
    movement.waterMovementCostMultiplierQ,
    "organism.movement.waterMovementCostMultiplierQ",
  );
  checkNonNegativeInt(movement.waterGraceTicks, "organism.movement.waterGraceTicks");
  checkQFraction(movement.waterHealthDamageQPerTick, "organism.movement.waterHealthDamageQPerTick");
  checkQFraction(movement.armorMaxSpeedPenaltyQ, "organism.movement.armorMaxSpeedPenaltyQ");
  check(
    movement.armorMaxSpeedPenaltyQ < Q,
    "organism.movement.armorMaxSpeedPenaltyQ must stay below Q or full armor would forbid movement",
  );
  checkQFraction(movement.sizeMaxTurnPenaltyQ, "organism.movement.sizeMaxTurnPenaltyQ");
  check(
    movement.sizeMaxTurnPenaltyQ < Q,
    "organism.movement.sizeMaxTurnPenaltyQ must stay below Q or the largest organism could not turn",
  );

  const { health } = organism;
  checkQFraction(health.starvationDamageQPerTick, "organism.health.starvationDamageQPerTick");
  checkQFraction(
    health.severeThermalMaxDamageQPerTick,
    "organism.health.severeThermalMaxDamageQPerTick",
  );
  checkQFraction(health.passiveHealingQPerTick, "organism.health.passiveHealingQPerTick");
  checkQFraction(
    health.passiveHealingMinEnergyFractionQ,
    "organism.health.passiveHealingMinEnergyFractionQ",
  );
  checkNonNegativeInt(
    health.passiveHealingEnergyBaseCost,
    "organism.health.passiveHealingEnergyBaseCost",
  );
  checkNonNegativeQCoefficient(
    health.passiveHealingEnergyMassCoeffQ,
    "organism.health.passiveHealingEnergyMassCoeffQ",
  );
  checkQMultiplierAtLeastOne(
    health.severeThermalBasalMultiplierMaxQ,
    "organism.health.severeThermalBasalMultiplierMaxQ",
  );

  const { feeding } = organism;
  checkPositiveInt(feeding.maxPlantBiteUnits, "organism.feeding.maxPlantBiteUnits");
  checkPositiveInt(feeding.maxMeatBiteUnits, "organism.feeding.maxMeatBiteUnits");
  checkQFraction(feeding.eatOutputThresholdQ, "organism.feeding.eatOutputThresholdQ");
  checkNonNegativeInt(feeding.biteBaseUnits, "organism.feeding.biteBaseUnits");
  checkNonNegativeQCoefficient(feeding.biteMassCoeffQ, "organism.feeding.biteMassCoeffQ");
  checkQFraction(feeding.digestionEfficiencyFloorQ, "organism.feeding.digestionEfficiencyFloorQ");
  checkQFraction(feeding.digestionEfficiencySpanQ, "organism.feeding.digestionEfficiencySpanQ");
  check(
    feeding.digestionEfficiencyFloorQ + feeding.digestionEfficiencySpanQ <= Q,
    "organism.feeding: digestion efficiency floor + span must not exceed Q",
  );
  check(
    feeding.biteBaseUnits <= feeding.maxPlantBiteUnits &&
      feeding.biteBaseUnits <= feeding.maxMeatBiteUnits,
    "organism.feeding: biteBaseUnits must not exceed the per-tick bite caps",
  );

  // Carcass constants are all ablatable: 0 meat per mass, or 0 decay ("carrion
  // never rots"), are legitimate experimental configurations.
  const { carcass } = organism;
  checkNonNegativeInt(carcass.meatPerMass, "organism.carcass.meatPerMass");
  checkQFraction(
    carcass.remainingEnergyToMeatMaxFractionQ,
    "organism.carcass.remainingEnergyToMeatMaxFractionQ",
  );
  checkQFraction(
    carcass.baseCarcassDecayFractionQPerDecayStep,
    "organism.carcass.baseCarcassDecayFractionQPerDecayStep",
  );
  checkQFraction(carcass.hotDecayBonusMaxQ, "organism.carcass.hotDecayBonusMaxQ");
  check(
    qmul(carcass.baseCarcassDecayFractionQPerDecayStep, Q + carcass.hotDecayBonusMaxQ) <= Q,
    "organism.carcass: base decay scaled by the maximum hot bonus must not exceed 100% per decay step",
  );
}

function validateBrain(config: DeepReadonly<SimulationConfig>): void {
  const { brain } = config;
  checkPositiveInt(brain.inputCount, "brain.inputCount");
  checkPositiveInt(brain.hiddenCount, "brain.hiddenCount");
  checkPositiveInt(brain.outputCount, "brain.outputCount");
  checkPositiveInt(brain.weightCount, "brain.weightCount");
  check(
    brain.weightCount ===
      brain.inputCount * brain.hiddenCount +
        brain.hiddenCount * brain.outputCount +
        brain.inputCount * brain.outputCount,
    "brain.weightCount must equal inputs*hidden + hidden*outputs + inputs*outputs",
  );
  // Sensor values are Q-scaled everywhere in the engine, so the network's value
  // scale is structurally tied to Q rather than freely tunable (docs/04 §11).
  check(
    brain.valueScale === Q,
    `brain.valueScale must equal Q (${Q}) because sensor values are Q-scaled, got ${brain.valueScale}`,
  );
  checkPositiveInt(brain.weightScale, "brain.weightScale");
  check(
    (brain.weightScale & (brain.weightScale - 1)) === 0,
    "brain.weightScale must be a power of two so weight division stays exact",
  );
  checkInt(brain.weightMin, "brain.weightMin");
  checkInt(brain.weightMax, "brain.weightMax");
  check(brain.weightMin < brain.weightMax, "brain.weightMin must be below brain.weightMax");
  // docs/08 §17 specifies a symmetric clamp of ±8192.
  check(
    brain.weightMin === -brain.weightMax,
    "brain: the weight clamp must be symmetric (weightMin === -weightMax)",
  );

  // The quantized inference accumulator sums weightCount products of a Q-scaled
  // value and a weight (docs/04 §11: "choose bounds safely below exact integer
  // limit"). Keep the worst case an order of magnitude below 2^53.
  const worstCaseAccumulator = brain.weightCount * Q * Math.max(-brain.weightMin, brain.weightMax);
  check(
    worstCaseAccumulator <= Number.MAX_SAFE_INTEGER / 8,
    `brain: worst-case inference accumulator ${worstCaseAccumulator} is too close to the exact ` +
      "integer limit; reduce weightCount or the weight clamp",
  );
}

function validateMutation(config: DeepReadonly<SimulationConfig>): void {
  const { ecological, brain } = config.mutation;

  checkQFraction(
    ecological.perGeneMutationProbabilityQ,
    "mutation.ecological.perGeneMutationProbabilityQ",
  );
  checkQFraction(
    ecological.largeMutationProbabilityQ,
    "mutation.ecological.largeMutationProbabilityQ",
  );
  checkQFraction(ecological.resetProbabilityQ, "mutation.ecological.resetProbabilityQ");
  checkNonNegativeQCoefficient(ecological.smallSigmaQ, "mutation.ecological.smallSigmaQ");
  checkNonNegativeQCoefficient(ecological.largeSigmaQ, "mutation.ecological.largeSigmaQ");
  check(
    ecological.largeSigmaQ >= ecological.smallSigmaQ,
    "mutation.ecological: largeSigmaQ must not be smaller than smallSigmaQ",
  );

  checkQFraction(
    brain.perWeightMutationProbabilityQ,
    "mutation.brain.perWeightMutationProbabilityQ",
  );
  checkQFraction(
    brain.largeWeightMutationProbabilityQ,
    "mutation.brain.largeWeightMutationProbabilityQ",
  );
  checkNonNegativeQCoefficient(brain.weightSmallSigmaQ, "mutation.brain.weightSmallSigmaQ");
}

function validateCombat(config: DeepReadonly<SimulationConfig>): void {
  const { combat } = config;
  checkQFraction(combat.attackOutputThresholdQ, "combat.attackOutputThresholdQ");
  // Zero base damage is a valid "combat disabled" ablation.
  checkNonNegativeQCoefficient(combat.baseAttackDamageQ, "combat.baseAttackDamageQ");
  checkNonNegativeInt(combat.attackCooldownTicks, "combat.attackCooldownTicks");
  checkNonNegativeInt(combat.baseAttackEnergyCost, "combat.baseAttackEnergyCost");
  checkNonNegativeQCoefficient(combat.attackEnergyMassCoeffQ, "combat.attackEnergyMassCoeffQ");
  // An impact bonus above +100% is unusual but not structurally invalid.
  checkNonNegativeQCoefficient(combat.maxImpactDamageBonusQ, "combat.maxImpactDamageBonusQ");
  checkQFraction(combat.maxArmorDamageReductionQ, "combat.maxArmorDamageReductionQ");
  check(
    combat.maxArmorDamageReductionQ < Q,
    "combat.maxArmorDamageReductionQ must stay below Q or full armor would grant total immunity",
  );
}

function validateReproduction(config: DeepReadonly<SimulationConfig>): void {
  const { reproduction } = config;
  checkQFraction(reproduction.reproduceOutputThresholdQ, "reproduction.reproduceOutputThresholdQ");
  checkQFraction(reproduction.minParentReserveFractionQ, "reproduction.minParentReserveFractionQ");
  check(
    reproduction.minParentReserveFractionQ < Q,
    "reproduction.minParentReserveFractionQ must stay below Q or reproduction is impossible",
  );
  checkNonNegativeInt(
    reproduction.reproductionCooldownTicks,
    "reproduction.reproductionCooldownTicks",
  );
  checkNonNegativeInt(reproduction.childSpawnDistanceMinLU, "reproduction.childSpawnDistanceMinLU");
  checkNonNegativeInt(reproduction.childSpawnDistanceMaxLU, "reproduction.childSpawnDistanceMaxLU");
  check(
    reproduction.childSpawnDistanceMinLU <= reproduction.childSpawnDistanceMaxLU,
    "reproduction: childSpawnDistanceMinLU must be <= childSpawnDistanceMaxLU",
  );
  checkPositiveInt(reproduction.spawnAngleCandidates, "reproduction.spawnAngleCandidates");
}

function validateSpecies(config: DeepReadonly<SimulationConfig>): void {
  const { species, limits } = config;
  checkPositiveInt(species.minDaughterPopulation, "species.minDaughterPopulation");
  checkPositiveInt(species.kMeansIterations, "species.kMeansIterations");
  checkPositiveInt(species.stabilityIntervals, "species.stabilityIntervals");
  checkQFraction(species.splitDistanceThresholdQ, "species.splitDistanceThresholdQ");
  checkQFraction(
    species.candidateCentroidContinuityThresholdQ,
    "species.candidateCentroidContinuityThresholdQ",
  );
  // A candidate must be able to look "the same as last time" more easily than
  // its two clusters look "far apart", or a split could never stabilize.
  check(
    species.candidateCentroidContinuityThresholdQ < species.splitDistanceThresholdQ,
    "species: centroid continuity threshold must be below the split distance threshold",
  );
  // docs/05 §6: only species with at least 2 * minDaughterPopulation members are
  // analyzed, so that eligibility must be reachable at all.
  check(
    2 * species.minDaughterPopulation <= limits.maxOrganisms,
    "species: 2 * minDaughterPopulation must fit inside limits.maxOrganisms",
  );
}

function validateHistory(config: DeepReadonly<SimulationConfig>): void {
  const { history, limits } = config;
  checkPositiveInt(
    history.massExtinctionMinStartingSpecies,
    "history.massExtinctionMinStartingSpecies",
  );
  check(
    history.massExtinctionMinStartingSpecies >= 2,
    "history.massExtinctionMinStartingSpecies must be at least 2 for a mass extinction to be meaningful",
  );
  checkQFraction(history.massExtinctionFractionQ, "history.massExtinctionFractionQ");
  checkQFraction(history.carnivoreObservedMeatFractionQ, "history.carnivoreObservedMeatFractionQ");
  checkPositiveInt(history.carnivoreMinPopulation, "history.carnivoreMinPopulation");
  check(
    history.carnivoreMinPopulation <= limits.maxOrganisms,
    "history.carnivoreMinPopulation must be reachable within limits.maxOrganisms",
  );
  // Boom/crash thresholds are RELATIVE changes (docs/08 §23: 3072 == +0.75,
  // 2048 == -0.50 stored as magnitude). A boom may legitimately exceed +1.0,
  // while a crash beyond -1.0 would be meaningless.
  checkPositiveQCoefficient(history.populationBoomFractionQ, "history.populationBoomFractionQ");
  checkQFraction(history.populationCrashFractionQ, "history.populationCrashFractionQ");
  check(
    history.populationCrashFractionQ > 0,
    "history.populationCrashFractionQ must be positive or every tick would look like a crash",
  );
  checkNonNegativeInt(history.eventCooldownStatsSamples, "history.eventCooldownStatsSamples");
}

function validateLimits(config: DeepReadonly<SimulationConfig>): void {
  const { limits, world } = config;
  checkPositiveInt(limits.maxOrganisms, "limits.maxOrganisms");
  checkPositiveInt(limits.maxCarcasses, "limits.maxCarcasses");
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
