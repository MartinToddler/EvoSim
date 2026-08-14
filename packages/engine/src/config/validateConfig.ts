import type { DeepReadonly } from "@eon/shared";
import { ANGLE_STEPS, POS_SCALE, Q, qmul } from "../math/fixed";
import { CONFIG_SCHEMA_VERSION } from "../version";
import { Biome, BIOME_COUNT } from "../world/biomes";
import { DEFAULT_CONFIG } from "./defaultConfig";
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

/**
 * Largest value a `Uint16Array` row can hold.
 *
 * Several config fields are counters or capacities that end up stored in a
 * Uint16 row of `OrganismStore`, `EnvironmentStore` or `PhenotypeStore`. A
 * value above this bound is not clamped by the assignment, it *wraps* — a
 * 70 000-tick cooldown becomes 4 464 — so the validator has to reject it here
 * rather than let the storage silently contradict the configuration.
 */
const UINT16_MAX = 65535;

/**
 * Largest value a `Uint32Array` row can hold.
 *
 * Same reasoning as {@link UINT16_MAX} one storage width up: `CarcassStore`
 * keeps `remainingMeat` in a Uint32 row while its conservation counters are
 * plain safe integers, so a body worth more meat than this would wrap the row
 * and leave the store claiming to have created meat it does not hold.
 */
const UINT32_MAX = 4_294_967_295;

/**
 * Largest value an `Int16Array` row can hold. The accumulated local
 * temperature offset saturation bound must fit this row or repeated brush
 * strokes would wrap it.
 */
const INT16_MAX = 32_767;

/**
 * Allocation ceiling for the environment grid (16.7M cells) — far above the
 * 256 the MVP uses. Without it a typo reaches `new Uint16Array()` and surfaces
 * as a bare RangeError naming no config field (foundation-gate ADR §6).
 */
const MAX_ENV_GRID_SIZE = 4096;

/**
 * Largest world edge in LU whose fixed-point positions still fit Int32.
 *
 * Organism positions are `Int32Array` sub-units at POS_SCALE per LU
 * (docs/03 §§3, 6), so a wider world would wrap coordinates rather than merely
 * be large (foundation-gate ADR §6).
 */
const MAX_WORLD_SIZE_LU = Math.floor(2_147_483_647 / POS_SCALE);

/** Sanity ceiling on canonical brush samples per command (allocation bound). */
const MAX_BRUSH_SAMPLES_CEILING = 1024;

/** Sanity ceiling on the ADD_BIOMASS overfill multiplier (16×capacity). */
const MAX_BIOMASS_OVERFILL_LIMIT_Q = 16 * Q;

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

  checkSchemaShape(config);
  validateWorld(config);
  validateTime(config);
  validatePlants(config);
  validateOrganism(config);
  validateGeneRanges(config);
  validateSenses(config);
  validateBrain(config);
  validateMutation(config);
  validateCombat(config);
  validateReproduction(config);
  validateSpecies(config);
  validateHistory(config);
  validateInterventions(config);
  validateLimits(config);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

/**
 * Require `actual` to have exactly the shape of `template`.
 *
 * Arrays match element-wise against their first template element, so tables
 * whose length is a tuning choice (elevation octaves) stay free; every other
 * node must have exactly the same key set and the same primitive types.
 */
function checkShape(actual: unknown, template: unknown, path: string): void {
  if (Array.isArray(template)) {
    check(Array.isArray(actual), `${path} must be an array, got ${describeType(actual)}`);
    if (template.length === 0) {
      return;
    }
    const element: unknown = template[0];
    for (let i = 0; i < (actual as unknown[]).length; i += 1) {
      checkShape((actual as unknown[])[i], element, `${path}[${i}]`);
    }
    return;
  }

  if (template !== null && typeof template === "object") {
    check(
      actual !== null && typeof actual === "object" && !Array.isArray(actual),
      `${path === "" ? "config" : path} must be an object, got ${describeType(actual)}`,
    );
    const templateKeys = Object.keys(template);
    const actualKeys = Object.keys(actual as object);
    for (const key of actualKeys) {
      check(
        Object.prototype.hasOwnProperty.call(template, key),
        `${path === "" ? key : `${path}.${key}`} is not a field of config schema ` +
          `${CONFIG_SCHEMA_VERSION}. Unknown fields are rejected because they would silently ` +
          "enter the authoritative config hash and change world identity",
      );
    }
    for (const key of templateKeys) {
      check(
        Object.prototype.hasOwnProperty.call(actual, key),
        `${path === "" ? key : `${path}.${key}`} is missing from the configuration`,
      );
    }
    for (const key of templateKeys) {
      checkShape(
        (actual as Record<string, unknown>)[key],
        (template as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
      );
    }
    return;
  }

  check(
    typeof actual === typeof template,
    `${path} must be a ${typeof template}, got ${describeType(actual)}`,
  );
}

/**
 * Reject any configuration whose shape differs from the schema
 * (foundation-gate ADR §4).
 *
 * `hashConfig` serializes whatever keys the object actually has, so a stray
 * field — a leftover from an older schema, a typo such as
 * `time.enviromentInterval`, or a host value like `targetTicksPerSecond1x`
 * pasted into the wrong config — would be ignored by every rule below and
 * still change the world hash. A missing field is worse: the reader gets
 * `undefined` in a hot loop. Both must fail at construction.
 *
 * DEFAULT_CONFIG is the schema template because TypeScript already forces it
 * to carry exactly the fields of `SimulationConfig`, so this runtime check can
 * never drift from the interface it is guarding.
 */
function checkSchemaShape(config: DeepReadonly<SimulationConfig>): void {
  checkShape(config, DEFAULT_CONFIG, "");
}

function validateWorld(config: DeepReadonly<SimulationConfig>): void {
  const { world } = config;

  checkPositiveInt(world.sizeLU, "world.sizeLU");
  checkPositiveInt(world.envGridSize, "world.envGridSize");
  checkPositiveInt(world.envCellSizeLU, "world.envCellSizeLU");
  checkPositiveInt(world.spatialCellSizeLU, "world.spatialCellSizeLU");
  check(
    world.sizeLU <= MAX_WORLD_SIZE_LU,
    `world.sizeLU must not exceed ${MAX_WORLD_SIZE_LU}, or fixed-point positions ` +
      `(${POS_SCALE} sub-units per LU) would leave the Int32 range`,
  );
  check(
    world.envGridSize <= MAX_ENV_GRID_SIZE,
    `world.envGridSize must not exceed ${MAX_ENV_GRID_SIZE} (${MAX_ENV_GRID_SIZE}² cells), got ${world.envGridSize}`,
  );
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
  // Zero founders is a legitimate configuration, not a mistake: it is the
  // lifeless control world that isolates the environment model from grazing,
  // which is what the 100k environment soak needs now that a populated world
  // reproduces. Nothing in the engine special-cases it — spawnFounderPopulation
  // simply places nobody and draws nothing.
  checkNonNegativeInt(world.initialOrganisms, "world.initialOrganisms");
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
      (plants.baseCapacityByBiome[i] as number) <= UINT16_MAX,
      `plants.baseCapacityByBiome[${i}] must fit in the Uint16 biomass array (<= ${UINT16_MAX})`,
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
  // Zero is a legitimate "organisms pass through each other" ablation; above Q
  // a pair would overshoot past each other and oscillate.
  checkQFraction(movement.softSeparationStrengthQ, "organism.movement.softSeparationStrengthQ");

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
  checkPositiveInt(
    health.thermalStressMinToleranceCentiC,
    "organism.health.thermalStressMinToleranceCentiC",
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
  checkCentiCelsius(
    carcass.hotDecayMinTemperatureCentiC,
    "organism.carcass.hotDecayMinTemperatureCentiC",
  );
  checkCentiCelsius(
    carcass.hotDecayFullBonusTemperatureCentiC,
    "organism.carcass.hotDecayFullBonusTemperatureCentiC",
  );
  // Strictly ordered, not merely ordered: an empty span would divide by zero in
  // the decay ramp, and inverting it would make cold carrion rot fastest.
  check(
    carcass.hotDecayFullBonusTemperatureCentiC > carcass.hotDecayMinTemperatureCentiC,
    "organism.carcass.hotDecayFullBonusTemperatureCentiC must be above " +
      "hotDecayMinTemperatureCentiC, or the hot-decay ramp has no width",
  );

  // The largest body this configuration can grow must leave a carcass that fits
  // the Uint32 `remainingMeat` row. `meatPerMass` is otherwise unbounded, and a
  // large enough value wraps the row while `totalMeatCreated` keeps the full
  // amount — meat conservation, the invariant this milestone rests on, then
  // silently stops holding (ADR 0008 §2). Bounding the inputs here is what makes
  // the store's own assertion unreachable, exactly as the Uint16 cooldown bound
  // does for the reproduction counter (ADR 0007 §2).
  //
  // The arithmetic mirrors `ecology/carcasses.ts#carcassMeatUnits` at full
  // development, which is where the largest body is reached.
  const maxRadiusPos = organism.geneRanges.adultRadiusMaxPos;
  const maxMass = Math.trunc(
    (organism.massScalePerRadiusSquared * maxRadiusPos * maxRadiusPos) / (POS_SCALE * POS_SCALE),
  );
  const maxBodyMeat = maxMass * carcass.meatPerMass;
  const maxRecoverable = qmul(
    organism.baseMaxEnergy + maxMass * organism.maxEnergyPerMass,
    carcass.remainingEnergyToMeatMaxFractionQ,
  );
  const meatEnergyPerUnit = config.plants.meatEnergyPerUnit;
  const maxEnergyMeat = meatEnergyPerUnit > 0 ? Math.trunc(maxRecoverable / meatEnergyPerUnit) : 0;
  check(
    maxBodyMeat + maxEnergyMeat <= UINT32_MAX,
    `organism.carcass.meatPerMass ${carcass.meatPerMass} makes the largest possible body worth ` +
      `${maxBodyMeat + maxEnergyMeat} meat units, above the Uint32 remainingMeat row ` +
      `(max ${UINT32_MAX}); the row would wrap and meat conservation would break silently`,
  );
}

/**
 * Gene mapping ranges (docs/08 §7).
 *
 * The rule is structural only: a range must be ordered and representable, and
 * must fit the typed array that caches the derived phenotype. Whether a range
 * is *ecologically* sensible is a calibration question. An empty range
 * (min === max) is explicitly legal — pinning a gene is a standard ablation
 * for isolating one trait in a selection experiment (docs/07 §5).
 */
function validateGeneRanges(config: DeepReadonly<SimulationConfig>): void {
  const g = config.organism.geneRanges;

  const orderedRange = (min: number, max: number, name: string, limit: number): void => {
    checkInt(min, `${name} minimum`);
    checkInt(max, `${name} maximum`);
    check(min <= max, `organism.geneRanges: ${name} minimum must not exceed its maximum`);
    check(
      max <= limit,
      `organism.geneRanges: ${name} maximum ${max} exceeds the representable limit ${limit}`,
    );
  };

  // Uint16 caches hold radius, speed, acceleration, turn, vision and ages.
  const U16 = UINT16_MAX;
  orderedRange(g.adultRadiusMinPos, g.adultRadiusMaxPos, "adultRadius", U16);
  check(g.adultRadiusMinPos > 0, "organism.geneRanges: adultRadiusMinPos must be positive");
  orderedRange(g.maxSpeedMinVel, g.maxSpeedMaxVel, "maxSpeed", U16);
  checkNonNegativeInt(g.maxSpeedMinVel, "organism.geneRanges.maxSpeedMinVel");
  orderedRange(g.accelerationMinVel, g.accelerationMaxVel, "acceleration", U16);
  checkNonNegativeInt(g.accelerationMinVel, "organism.geneRanges.accelerationMinVel");
  orderedRange(g.maxTurnMinSteps, g.maxTurnMaxSteps, "maxTurn", ANGLE_STEPS / 2);
  checkNonNegativeInt(g.maxTurnMinSteps, "organism.geneRanges.maxTurnMinSteps");
  orderedRange(g.visionRangeMinPos, g.visionRangeMaxPos, "visionRange", U16);
  checkNonNegativeInt(g.visionRangeMinPos, "organism.geneRanges.visionRangeMinPos");
  // A field of view is a whole-turn fraction; beyond a full turn it is meaningless.
  orderedRange(g.visionFovMinSteps, g.visionFovMaxSteps, "visionFov", ANGLE_STEPS);
  checkNonNegativeInt(g.visionFovMinSteps, "organism.geneRanges.visionFovMinSteps");

  for (const [name, value] of [
    ["adultRadiusExponentQ", g.adultRadiusExponentQ],
    ["maxSpeedExponentQ", g.maxSpeedExponentQ],
    ["visionRangeExponentQ", g.visionRangeExponentQ],
  ] as const) {
    checkPositiveQCoefficient(value, `organism.geneRanges.${name}`);
  }

  orderedRange(g.metabolicPaceMinQ, g.metabolicPaceMaxQ, "metabolicPace", U16);
  check(
    g.metabolicPaceMinQ > 0,
    "organism.geneRanges.metabolicPaceMinQ must be positive; a zero pace would stop metabolism entirely",
  );

  checkCentiCelsius(g.thermalOptimumMinCentiC, "organism.geneRanges.thermalOptimumMinCentiC");
  checkCentiCelsius(g.thermalOptimumMaxCentiC, "organism.geneRanges.thermalOptimumMaxCentiC");
  check(
    g.thermalOptimumMinCentiC <= g.thermalOptimumMaxCentiC,
    "organism.geneRanges: thermalOptimum minimum must not exceed its maximum",
  );
  orderedRange(
    g.thermalToleranceMinCentiC,
    g.thermalToleranceMaxCentiC,
    "thermalTolerance",
    TEMPERATURE_CENTI_C_LIMIT,
  );
  checkNonNegativeInt(g.thermalToleranceMinCentiC, "organism.geneRanges.thermalToleranceMinCentiC");

  orderedRange(g.maturityAgeMinTicks, g.maturityAgeMaxTicks, "maturityAge", U16);
  checkPositiveInt(g.maturityAgeMinTicks, "organism.geneRanges.maturityAgeMinTicks");
  orderedRange(g.maxAgeMinTicks, g.maxAgeMaxTicks, "maxAge", U16);
  checkPositiveInt(g.maxAgeMinTicks, "organism.geneRanges.maxAgeMinTicks");
  // A lifespan shorter than maturity would make reproduction unreachable for
  // every genome, not merely for unlucky ones.
  check(
    g.maxAgeMinTicks > g.maturityAgeMinTicks,
    "organism.geneRanges: the shortest maximum age must exceed the earliest maturity age",
  );

  checkQFraction(g.offspringInvestmentMinQ, "organism.geneRanges.offspringInvestmentMinQ");
  checkQFraction(g.offspringInvestmentMaxQ, "organism.geneRanges.offspringInvestmentMaxQ");
  check(
    g.offspringInvestmentMinQ <= g.offspringInvestmentMaxQ,
    "organism.geneRanges: offspringInvestment minimum must not exceed its maximum",
  );
}

function validateSenses(config: DeepReadonly<SimulationConfig>): void {
  const { senses, world } = config;
  checkNonNegativeInt(senses.crowdingRadiusLU, "senses.crowdingRadiusLU");
  check(
    senses.crowdingRadiusLU <= world.spatialCellSizeLU,
    "senses.crowdingRadiusLU must not exceed the spatial cell size, or the crowding query would " +
      "have to scan more than the immediate neighbour cells",
  );
  checkPositiveInt(senses.crowdingSaturationCount, "senses.crowdingSaturationCount");
  checkNonNegativeInt(senses.terrainProbeDistanceLU, "senses.terrainProbeDistanceLU");
  checkPositiveInt(senses.terrainForwardProbeSamples, "senses.terrainForwardProbeSamples");
  checkPositiveInt(senses.oscillatorPeriodTicks, "senses.oscillatorPeriodTicks");
  check(
    senses.oscillatorPeriodTicks % 2 === 0,
    "senses.oscillatorPeriodTicks must be even so the triangular oscillator is symmetric",
  );
  checkQFraction(senses.internalNoiseAmplitudeQ, "senses.internalNoiseAmplitudeQ");
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
  // The three classes are disjoint intervals of one uniform draw in [0, Q)
  // (genetics/mutation.ts), so their sum has to fit inside that draw. A config
  // whose probabilities summed above Q would silently make the last class
  // unreachable instead of failing.
  check(
    ecological.resetProbabilityQ +
      ecological.largeMutationProbabilityQ +
      ecological.perGeneMutationProbabilityQ <=
      Q,
    "mutation.ecological: reset + large + perGene probabilities must not exceed Q",
  );
  // Sigmas are Q fractions of the normalized gene range. Bounding them at Q is
  // both meaningful (a standard deviation wider than the whole gene range is not
  // a mutation, it is a re-roll — that is what resetProbabilityQ is for) and
  // what keeps geneDeltaRaw's product inside exact integer range.
  checkQFraction(ecological.smallSigmaQ, "mutation.ecological.smallSigmaQ");
  checkQFraction(ecological.largeSigmaQ, "mutation.ecological.largeSigmaQ");
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
  check(
    brain.largeWeightMutationProbabilityQ + brain.perWeightMutationProbabilityQ <= Q,
    "mutation.brain: large + perWeight probabilities must not exceed Q",
  );
  checkNonNegativeQCoefficient(brain.weightSmallSigmaQ, "mutation.brain.weightSmallSigmaQ");
  checkNonNegativeQCoefficient(brain.weightLargeSigmaQ, "mutation.brain.weightLargeSigmaQ");
  check(
    brain.weightLargeSigmaQ >= brain.weightSmallSigmaQ,
    "mutation.brain: weightLargeSigmaQ must not be smaller than weightSmallSigmaQ",
  );
  // Brain sigmas are in stored weight units, so the meaningful ceiling is the
  // clamp span: a sigma wider than the whole legal weight range would put almost
  // every mutated weight on one of the two bounds.
  const weightSpan = config.brain.weightMax - config.brain.weightMin;
  check(
    brain.weightLargeSigmaQ <= weightSpan,
    `mutation.brain.weightLargeSigmaQ must not exceed the weight clamp span ${weightSpan}, ` +
      `got ${brain.weightLargeSigmaQ}`,
  );
}

function validateCombat(config: DeepReadonly<SimulationConfig>): void {
  const { combat } = config;
  checkQFraction(combat.attackOutputThresholdQ, "combat.attackOutputThresholdQ");
  // Zero base damage is a valid "combat disabled" ablation.
  checkNonNegativeQCoefficient(combat.baseAttackDamageQ, "combat.baseAttackDamageQ");
  checkNonNegativeInt(combat.attackCooldownTicks, "combat.attackCooldownTicks");
  // Same Uint16 storage trap as reproduction.reproductionCooldownTicks. The
  // `attackCooldown` row already exists in OrganismStore, so the bound is
  // asserted now rather than after Milestone 5 starts writing it.
  check(
    combat.attackCooldownTicks <= UINT16_MAX,
    `combat.attackCooldownTicks must fit in the Uint16 cooldown row (<= ${UINT16_MAX}), got ` +
      `${combat.attackCooldownTicks}`,
  );
  checkNonNegativeInt(combat.baseAttackEnergyCost, "combat.baseAttackEnergyCost");
  checkNonNegativeQCoefficient(combat.attackEnergyMassCoeffQ, "combat.attackEnergyMassCoeffQ");
  // An impact bonus above +100% is unusual but not structurally invalid.
  checkNonNegativeQCoefficient(combat.maxImpactDamageBonusQ, "combat.maxImpactDamageBonusQ");
  checkQFraction(combat.maxArmorDamageReductionQ, "combat.maxArmorDamageReductionQ");
  check(
    combat.maxArmorDamageReductionQ < Q,
    "combat.maxArmorDamageReductionQ must stay below Q or full armor would grant total immunity",
  );
  // A floor of Q means "size does not matter"; above Q the derived span would be
  // negative and a big body would hit SOFTER than a small one.
  checkQFraction(combat.attackSizeFactorFloorQ, "combat.attackSizeFactorFloorQ");
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
  // The counter it drives is a Uint16 row of OrganismStore. Above the Uint16
  // bound the assignment wraps instead of clamping, so a parent would come off
  // cooldown 65 536 ticks early and reproduce far faster than configured — a
  // silent contradiction of the configuration rather than a visible failure.
  check(
    reproduction.reproductionCooldownTicks <= UINT16_MAX,
    `reproduction.reproductionCooldownTicks must fit in the Uint16 cooldown row ` +
      `(<= ${UINT16_MAX}), got ${reproduction.reproductionCooldownTicks}`,
  );
  checkNonNegativeInt(reproduction.childSpawnDistanceMinLU, "reproduction.childSpawnDistanceMinLU");
  checkNonNegativeInt(reproduction.childSpawnDistanceMaxLU, "reproduction.childSpawnDistanceMaxLU");
  check(
    reproduction.childSpawnDistanceMinLU <= reproduction.childSpawnDistanceMaxLU,
    "reproduction: childSpawnDistanceMinLU must be <= childSpawnDistanceMaxLU",
  );
  checkPositiveInt(reproduction.spawnAngleCandidates, "reproduction.spawnAngleCandidates");
  // The placement search rotates by floor(ANGLE_STEPS / candidates) per attempt.
  // Above ANGLE_STEPS that step truncates to zero and every "alternative" angle
  // would be the same angle, so the retries would silently do nothing.
  check(
    reproduction.spawnAngleCandidates <= ANGLE_STEPS,
    `reproduction.spawnAngleCandidates must not exceed ANGLE_STEPS (${ANGLE_STEPS}), got ` +
      `${reproduction.spawnAngleCandidates}`,
  );
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
  // its two clusters look "far apart", or a split could never stabilize. The
  // factor of two is what makes the docs/05 §7 A/B-swap comparison unambiguous:
  // qualifying centroids are at least splitDistanceThresholdQ apart, so with
  // the continuity radius below half of that, a new centroid can never sit
  // within continuity range of BOTH stored centroids at once.
  check(
    2 * species.candidateCentroidContinuityThresholdQ < species.splitDistanceThresholdQ,
    "species: the split distance threshold must exceed twice the centroid continuity " +
      "threshold, or candidate A/B matching could become ambiguous",
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

function validateInterventions(config: DeepReadonly<SimulationConfig>): void {
  const { interventions, world } = config;

  checkPositiveInt(
    interventions.maxBrushSamplesPerCommand,
    "interventions.maxBrushSamplesPerCommand",
  );
  check(
    interventions.maxBrushSamplesPerCommand <= MAX_BRUSH_SAMPLES_CEILING,
    `interventions.maxBrushSamplesPerCommand must not exceed ${MAX_BRUSH_SAMPLES_CEILING}, ` +
      `got ${interventions.maxBrushSamplesPerCommand}`,
  );
  checkPositiveInt(interventions.brushSampleSpacingLU, "interventions.brushSampleSpacingLU");
  checkPositiveInt(interventions.minBrushRadiusLU, "interventions.minBrushRadiusLU");
  checkPositiveInt(interventions.maxBrushRadiusLU, "interventions.maxBrushRadiusLU");
  check(
    interventions.minBrushRadiusLU <= interventions.maxBrushRadiusLU,
    "interventions: minBrushRadiusLU must not exceed maxBrushRadiusLU",
  );
  check(
    interventions.maxBrushRadiusLU <= world.sizeLU,
    "interventions.maxBrushRadiusLU must fit inside the world",
  );

  checkPositiveInt(
    interventions.maxTemperatureBrushStrengthCentiC,
    "interventions.maxTemperatureBrushStrengthCentiC",
  );
  check(
    interventions.maxTemperatureBrushStrengthCentiC <= TEMPERATURE_CENTI_C_LIMIT,
    `interventions.maxTemperatureBrushStrengthCentiC must not exceed ${TEMPERATURE_CENTI_C_LIMIT}`,
  );
  checkQFraction(
    interventions.maxMoistureBrushStrengthQ,
    "interventions.maxMoistureBrushStrengthQ",
  );
  check(
    interventions.maxMoistureBrushStrengthQ > 0,
    "interventions.maxMoistureBrushStrengthQ must be positive",
  );
  checkQFraction(
    interventions.maxFertilityBrushStrengthQ,
    "interventions.maxFertilityBrushStrengthQ",
  );
  check(
    interventions.maxFertilityBrushStrengthQ > 0,
    "interventions.maxFertilityBrushStrengthQ must be positive",
  );
  checkQFraction(interventions.maxTerrainBrushStrengthQ, "interventions.maxTerrainBrushStrengthQ");
  check(
    interventions.maxTerrainBrushStrengthQ > 0,
    "interventions.maxTerrainBrushStrengthQ must be positive",
  );
  checkPositiveInt(
    interventions.maxBiomassBrushStrengthUnits,
    "interventions.maxBiomassBrushStrengthUnits",
  );
  check(
    interventions.maxBiomassBrushStrengthUnits <= UINT16_MAX,
    `interventions.maxBiomassBrushStrengthUnits must fit a Uint16 biomass row (max ${UINT16_MAX})`,
  );

  checkPositiveInt(
    interventions.maxLocalTemperatureOffsetCentiC,
    "interventions.maxLocalTemperatureOffsetCentiC",
  );
  check(
    interventions.maxLocalTemperatureOffsetCentiC <= INT16_MAX,
    "interventions.maxLocalTemperatureOffsetCentiC must fit the Int16 offset row " +
      `(max ${INT16_MAX}), got ${interventions.maxLocalTemperatureOffsetCentiC}`,
  );
  checkPositiveInt(
    interventions.maxGlobalTemperatureOffsetCentiC,
    "interventions.maxGlobalTemperatureOffsetCentiC",
  );
  check(
    interventions.maxGlobalTemperatureOffsetCentiC <= TEMPERATURE_CENTI_C_LIMIT,
    `interventions.maxGlobalTemperatureOffsetCentiC must not exceed ${TEMPERATURE_CENTI_C_LIMIT}`,
  );

  checkQMultiplierAtLeastOne(
    interventions.biomassOverfillLimitQ,
    "interventions.biomassOverfillLimitQ",
  );
  check(
    interventions.biomassOverfillLimitQ <= MAX_BIOMASS_OVERFILL_LIMIT_Q,
    `interventions.biomassOverfillLimitQ must not exceed ${MAX_BIOMASS_OVERFILL_LIMIT_Q} (16.0)`,
  );

  const meteor = interventions.meteor;
  checkPositiveInt(meteor.minRadiusLU, "interventions.meteor.minRadiusLU");
  checkPositiveInt(meteor.maxRadiusLU, "interventions.meteor.maxRadiusLU");
  check(
    meteor.minRadiusLU <= meteor.maxRadiusLU,
    "interventions.meteor: minRadiusLU must not exceed maxRadiusLU",
  );
  check(
    meteor.maxRadiusLU <= world.sizeLU,
    "interventions.meteor.maxRadiusLU must fit inside the world",
  );
  // Damage may exceed one health bar (Q): the excess widens the lethal core of
  // the linear falloff. Bounded so the centre damage cannot dwarf the health
  // scale into meaninglessness.
  check(
    Number.isSafeInteger(meteor.damageQ) && meteor.damageQ >= 0 && meteor.damageQ <= 4 * Q,
    `interventions.meteor.damageQ must be an integer in [0, ${4 * Q}], got ${meteor.damageQ}`,
  );
  checkQFraction(meteor.biomassLossQ, "interventions.meteor.biomassLossQ");
  checkQFraction(meteor.depressionQ, "interventions.meteor.depressionQ");
  check(
    Number.isSafeInteger(meteor.fertilityDeltaQ) &&
      meteor.fertilityDeltaQ >= -Q &&
      meteor.fertilityDeltaQ <= Q,
    `interventions.meteor.fertilityDeltaQ must be an integer in [-${Q}, ${Q}], ` +
      `got ${meteor.fertilityDeltaQ}`,
  );
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
