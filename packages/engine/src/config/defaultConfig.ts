import { CONFIG_SCHEMA_VERSION } from "../version";
import type { SimulationConfig } from "./SimulationConfig";

/**
 * DEFAULT_CONFIG v0.1 — implementation defaults for calibration, verbatim
 * from docs/08 (values quantized to integer Q representation exactly as the
 * spec lists them; conceptual real values in comments). These are versioned
 * starting hypotheses, not biological claims. Tuning happens later through
 * named config commits and sweep experiments, never through hidden
 * conditional bonuses (docs/08 §24).
 */
export const DEFAULT_CONFIG: SimulationConfig = deepFreeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,

  world: {
    sizeLU: 4096,
    envGridSize: 256,
    envCellSizeLU: 16,
    spatialCellSizeLU: 32,

    seaLevelQ: 1884, // ~0.46
    mountainLevelQ: 3195, // ~0.78
    minLandFractionQ: 1434, // 0.35
    maxLandFractionQ: 2867, // 0.70
    generationMaxRetries: 16,

    initialOrganisms: 256,
    founderSpawnRadiusLU: 120,

    biomeThresholds: {
      tundraTemperatureCentiC: -300, // -3.00 °C
      desertMaxMoistureQ: 1024, // 0.25
      desertMinTemperatureCentiC: 1800, // 18.00 °C
      forestMinMoistureQ: 2540, // 0.62
      forestMinFertilityQ: 2253, // 0.55
    },
  },

  time: {
    targetTicksPerSecond1x: 20,
    ticksPerSimYear: 2000,
    environmentInterval: 20,
    carcassDecayInterval: 20,
    statisticsInterval: 100,
    speciesAnalysisInterval: 400,
    autosaveCheckInterval: 2000,
    normalRenderSnapshotsPerSecond: 15,
    maxModeRenderSnapshotsPerSecond: 5,
    maxWorkerSliceMs: 10,
  },

  plants: {
    // Indexed by Biome: Water, Grassland, Forest, Desert, Tundra, Mountain.
    baseCapacityByBiome: [0, 36000, 52000, 7000, 10000, 4000],
    growthRateQByBiome: [0, 49, 37, 12, 12, 6], // ~.012 .009 .003 .003 .0015
    plantSeedBankRegenUnits: 4,
    plantMinRegenThreshold: 16,
    plantEnergyPerBiomass: 30,
    meatEnergyPerUnit: 45,
  },

  organism: {
    massScalePerRadiusSquared: 100,
    baseMaxEnergy: 1000,
    maxEnergyPerMass: 120,

    birthSizeFractionQ: 1843, // 0.45
    reproductionMinDevelopmentQ: 3686, // 0.90
    initialEnergyFractionQ: 2867, // 0.70
    energyPerGrowthMass: 35,

    basal: {
      baseMassPaceCoeffQ: 246, // 0.060
      muscleCapacityCoeffQ: 82, // 0.020
      visionBaseCost: 30,
      attackMaintCoeffQ: 41, // 0.010
      armorMaintCoeffQ: 61, // 0.015
      toleranceMaintCoeffQ: 20, // 0.005
      longevityMaintCoeffQ: 12, // 0.003
      minimumBasalPerTick: 1,
    },

    movement: {
      movementCostCoeffQ: 410, // 0.10
      accelerationCostCoeffQ: 41, // 0.01
      waterSpeedMultiplierQ: 1024, // 0.25
      waterMovementCostMultiplierQ: 16384, // 4.0
      waterGraceTicks: 20,
      waterHealthDamageQPerTick: 12,
      armorMaxSpeedPenaltyQ: 1434, // 0.35
      sizeMaxTurnPenaltyQ: 1024, // 0.25
    },

    health: {
      starvationDamageQPerTick: 8,
      severeThermalMaxDamageQPerTick: 20,
      passiveHealingQPerTick: 2,
      passiveHealingMinEnergyFractionQ: 2867, // 0.70
      passiveHealingEnergyBaseCost: 8,
      passiveHealingEnergyMassCoeffQ: 41, // 0.01
      severeThermalBasalMultiplierMaxQ: 12288, // 3.0
    },

    feeding: {
      maxPlantBiteUnits: 64,
      maxMeatBiteUnits: 64,
      eatOutputThresholdQ: 2253, // 0.55
      biteBaseUnits: 2,
      biteMassCoeffQ: 61, // 0.015
      digestionEfficiencyFloorQ: 819, // 0.20
      digestionEfficiencySpanQ: 3277, // 0.80
    },

    carcass: {
      meatPerMass: 3,
      remainingEnergyToMeatMaxFractionQ: 1024, // 0.25
      baseCarcassDecayFractionQPerDecayStep: 20, // ~0.0049
      hotDecayBonusMaxQ: 4096, // 1.0
    },
  },

  senses: {},

  brain: {
    inputCount: 20,
    hiddenCount: 12,
    outputCount: 5,
    weightCount: 400, // 20*12 + 12*5 + 20*5
    valueScale: 4096,
    weightScale: 4096,
    weightMin: -8192,
    weightMax: 8192,
  },

  mutation: {
    ecological: {
      perGeneMutationProbabilityQ: 328, // 0.08
      smallSigmaQ: 102, // 0.025
      largeMutationProbabilityQ: 20, // ~0.0049
      largeSigmaQ: 614, // 0.15
      resetProbabilityQ: 1, // ~0.00024
    },
    brain: {
      perWeightMutationProbabilityQ: 82, // 0.02
      weightSmallSigmaQ: 246, // 0.06 weight units
      largeWeightMutationProbabilityQ: 4, // ~0.001
    },
  },

  combat: {
    attackOutputThresholdQ: 2662, // 0.65
    baseAttackDamageQ: 320,
    attackCooldownTicks: 5,
    baseAttackEnergyCost: 25,
    attackEnergyMassCoeffQ: 123, // 0.03
    maxImpactDamageBonusQ: 1229, // +0.30
    maxArmorDamageReductionQ: 2662, // 0.65
  },

  reproduction: {
    reproduceOutputThresholdQ: 2662, // 0.65
    minParentReserveFractionQ: 819, // 0.20
    reproductionCooldownTicks: 40,
    childSpawnDistanceMinLU: 2,
    childSpawnDistanceMaxLU: 8,
    spawnAngleCandidates: 8,
  },

  species: {
    minDaughterPopulation: 20,
    analysisIntervalTicks: 400,
    kMeansIterations: 6,
    stabilityIntervals: 5,
    splitDistanceThresholdQ: 901, // ~0.22 normalized RMS
    candidateCentroidContinuityThresholdQ: 328, // ~0.08
  },

  history: {
    massExtinctionMinStartingSpecies: 8,
    massExtinctionFractionQ: 1638, // 0.40
    carnivoreObservedMeatFractionQ: 2458, // 0.60
    carnivoreMinPopulation: 10,
    populationBoomFractionQ: 3072, // +0.75 relative
    populationCrashFractionQ: 2048, // -0.50 relative
    eventCooldownStatsSamples: 10,
  },

  limits: {
    maxOrganisms: 8192,
    maxCarcasses: 4096,
    maxDetailedRenderedOrganisms: 250,
    recentDeadHistorySize: 2048,
    maxTimelineEventsInMemoryBeforeChunk: 4096,
  },
});

/** Recursively freeze a config object (defence against accidental mutation). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
