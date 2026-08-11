/**
 * Typed simulation configuration (docs/02 §17, defaults in docs/08).
 *
 * Pure serializable data only — no functions, classes, typed arrays or
 * browser objects. Every tunable biological/ecological constant lives here or
 * in named derived constants; hot loops must not contain unexplained magic
 * numbers (CLAUDE.md configuration rule).
 *
 * Conventions:
 * - `*Q` fields are Q-scaled fractions/multipliers (Q = 4096 == 1.0). Values
 *   above Q encode multipliers > 1 (e.g. water movement cost 4.0 == 16384).
 * - `*CentiC` fields are temperatures in hundredths of °C.
 * - `*LU` fields are logical world units; `*Ticks` are simulation ticks.
 *
 * Schema evolution: adding/removing/renaming any field bumps
 * CONFIG_SCHEMA_VERSION (see version.ts). The `senses` section and the gene
 * mapping ranges (docs/08 §7) are intentionally deferred to the milestone
 * that implements them (M3 organisms) and will arrive with a schema bump.
 */

export interface WorldConfig {
  /** World edge length in logical units. */
  sizeLU: number;
  /** Environment grid resolution per axis (envGridSize² cells). */
  envGridSize: number;
  /** Environment cell edge in LU; envGridSize * envCellSizeLU === sizeLU. */
  envCellSizeLU: number;
  /** Spatial hash cell edge in LU; must divide sizeLU. */
  spatialCellSizeLU: number;

  /** Normalized elevation below which a cell is water (~0.46). */
  seaLevelQ: number;
  /** Normalized elevation above which a cell is mountain (~0.78). */
  mountainLevelQ: number;
  /** World generation validity: minimum land fraction (~0.35). */
  minLandFractionQ: number;
  /** World generation validity: maximum land fraction (~0.70). */
  maxLandFractionQ: number;
  /** Deterministic regeneration attempts with derived sub-seeds before failing. */
  generationMaxRetries: number;

  /** Founder population size. */
  initialOrganisms: number;
  /** Founder spawn region radius in LU. */
  founderSpawnRadiusLU: number;

  /** Biome classification thresholds (docs/08 §6, rule order in docs/03 §19). */
  biomeThresholds: {
    tundraTemperatureCentiC: number;
    desertMaxMoistureQ: number;
    desertMinTemperatureCentiC: number;
    forestMinMoistureQ: number;
    forestMinFertilityQ: number;
  };
}

export interface TimeConfig {
  /** Wall-clock pacing target at 1× (hosting concern only, never authoritative). */
  targetTicksPerSecond1x: number;
  /** Simulated-year length used for display/statistics. */
  ticksPerSimYear: number;
  /** Environment update phase interval in ticks. */
  environmentInterval: number;
  /** Carcass decay phase interval in ticks. */
  carcassDecayInterval: number;
  /** Statistics/event detection interval in ticks. */
  statisticsInterval: number;
  /** Species analysis interval in ticks. */
  speciesAnalysisInterval: number;
  /** Autosave check interval in ticks. */
  autosaveCheckInterval: number;
  /** Render snapshot rate at normal speeds (worker hosting concern). */
  normalRenderSnapshotsPerSecond: number;
  /** Render snapshot rate in MAX mode (worker hosting concern). */
  maxModeRenderSnapshotsPerSecond: number;
  /** MAX-mode worker batch slice budget in ms (worker hosting concern). */
  maxWorkerSliceMs: number;
}

export interface PlantConfig {
  /** Base plant capacity per biome, indexed by Biome enum value 0..5. */
  baseCapacityByBiome: readonly number[];
  /** Logistic growth rate (Q per environment step) per biome, indexed 0..5. */
  growthRateQByBiome: readonly number[];
  /** Seed-bank regeneration units below the regen threshold (docs/03 §20). */
  plantSeedBankRegenUnits: number;
  /** Biomass threshold below which seed-bank regeneration applies. */
  plantMinRegenThreshold: number;
  /** Energy per consumed plant biomass unit before digestion efficiency. */
  plantEnergyPerBiomass: number;
  /** Energy per consumed carcass meat unit before digestion efficiency. */
  meatEnergyPerUnit: number;
}

/** Body, energy, metabolism and health constants (docs/08 §§8–13, 15). */
export interface OrganismConfig {
  /** mass = massScalePerRadiusSquared * radiusLU² (docs/04 §3). */
  massScalePerRadiusSquared: number;
  /** maxEnergy = baseMaxEnergy + currentMass * maxEnergyPerMass. */
  baseMaxEnergy: number;
  maxEnergyPerMass: number;

  /** Birth development fraction of adult size (~0.45). */
  birthSizeFractionQ: number;
  /** Development fraction required to reproduce (~0.90). */
  reproductionMinDevelopmentQ: number;
  /** Founder initial energy fraction of max (~0.70, inside the 65–80% band). */
  initialEnergyFractionQ: number;
  /** Energy cost per unit of grown mass. */
  energyPerGrowthMass: number;

  /** Basal cost coefficients, Q-scaled per conceptual energy/tick (docs/08 §9). */
  basal: {
    /** base = mass * pace * coeff; 246/Q ~ 0.060. */
    baseMassPaceCoeffQ: number;
    /** muscle = mass * speedNorm² * coeff; 82/Q ~ 0.020. */
    muscleCapacityCoeffQ: number;
    /** vision = coeff * rangeNorm² * fovNorm; flat energy units. */
    visionBaseCost: number;
    /** attack maintenance = mass * attack² * coeff; 41/Q ~ 0.010. */
    attackMaintCoeffQ: number;
    /** armor maintenance = mass * armor² * coeff; 61/Q ~ 0.015. */
    armorMaintCoeffQ: number;
    /** tolerance maintenance = mass * toleranceNorm * coeff; 20/Q ~ 0.005. */
    toleranceMaintCoeffQ: number;
    /** longevity maintenance = mass * maxAgeNorm * coeff; 12/Q ~ 0.003. */
    longevityMaintCoeffQ: number;
    /** Living organisms always pay at least this basal energy per tick. */
    minimumBasalPerTick: number;
  };

  /** Movement/water constants (docs/03 §12, docs/08 §§10–11). */
  movement: {
    /** movement = mass * speedFraction² * coeff; 410/Q ~ 0.10. */
    movementCostCoeffQ: number;
    /** acceleration surcharge = mass * accelFraction² * coeff; 41/Q ~ 0.01. */
    accelerationCostCoeffQ: number;
    /** Speed multiplier in water (0.25). */
    waterSpeedMultiplierQ: number;
    /** Movement energy multiplier in water (4.0 → 16384, >Q by design). */
    waterMovementCostMultiplierQ: number;
    /** Ticks in water before health damage starts. */
    waterGraceTicks: number;
    /** Health damage per tick in water after grace. */
    waterHealthDamageQPerTick: number;
    /** Max-speed penalty at full armor (0.35). */
    armorMaxSpeedPenaltyQ: number;
    /** Max-turn penalty at full size (0.25). */
    sizeMaxTurnPenaltyQ: number;
  };

  /** Starvation/thermal/health constants (docs/08 §13). Health range is 0..Q. */
  health: {
    starvationDamageQPerTick: number;
    severeThermalMaxDamageQPerTick: number;
    passiveHealingQPerTick: number;
    /** Passive healing requires energy above this fraction (~0.70). */
    passiveHealingMinEnergyFractionQ: number;
    passiveHealingEnergyBaseCost: number;
    /** Healing energy mass coefficient; 41/Q ~ 0.01. */
    passiveHealingEnergyMassCoeffQ: number;
    /** Thermal basal multiplier ceiling under severe stress (~3.0 → 12288). */
    severeThermalBasalMultiplierMaxQ: number;
  };

  /** Feeding action constants (docs/08 §12). */
  feeding: {
    maxPlantBiteUnits: number;
    maxMeatBiteUnits: number;
    /** Brain eat output threshold (~0.55). */
    eatOutputThresholdQ: number;
    /** bite = biteBaseUnits + mass * biteMassCoeff * pace; 61/Q ~ 0.015. */
    biteBaseUnits: number;
    biteMassCoeffQ: number;
    /** Digestion efficiency = floor + span * affinity² (docs/03 §24). */
    digestionEfficiencyFloorQ: number;
    digestionEfficiencySpanQ: number;
  };

  /** Carcass creation/decay constants (docs/08 §15). */
  carcass: {
    meatPerMass: number;
    /** Bounded remaining-energy contribution to meat (0.25). */
    remainingEnergyToMeatMaxFractionQ: number;
    /** Base decay fraction per decay step (~0.0049). */
    baseCarcassDecayFractionQPerDecayStep: number;
    /** Maximum additional hot-climate decay bonus (1.0). */
    hotDecayBonusMaxQ: number;
  };
}

/**
 * Sensor configuration (docs/04 §§12–16). Intentionally empty in schema v1;
 * populated by Milestone 3 (task D05) together with a CONFIG_SCHEMA_VERSION
 * bump.
 */
export type SenseConfig = Record<string, never>;

/** Fixed v0.1 neural topology and quantization (docs/04 §§10–11, docs/08 §18). */
export interface BrainConfig {
  inputCount: number;
  hiddenCount: number;
  outputCount: number;
  /** 240 input→hidden + 60 hidden→output + 100 input→output skip = 400. */
  weightCount: number;
  /** NN_VALUE_SCALE. */
  valueScale: number;
  /** NN_WEIGHT_SCALE. */
  weightScale: number;
  weightMin: number;
  weightMax: number;
}

/** Mutation constants (docs/08 §17). Probabilities are Q fractions. */
export interface MutationConfig {
  ecological: {
    perGeneMutationProbabilityQ: number;
    smallSigmaQ: number;
    largeMutationProbabilityQ: number;
    largeSigmaQ: number;
    resetProbabilityQ: number;
  };
  brain: {
    perWeightMutationProbabilityQ: number;
    weightSmallSigmaQ: number;
    largeWeightMutationProbabilityQ: number;
  };
}

/** Combat constants (docs/04 §21, docs/08 §14). */
export interface CombatConfig {
  attackOutputThresholdQ: number;
  baseAttackDamageQ: number;
  attackCooldownTicks: number;
  baseAttackEnergyCost: number;
  /** Attack energy mass coefficient; 123/Q ~ 0.03. */
  attackEnergyMassCoeffQ: number;
  /** Impact bonus at full speed (+0.30). */
  maxImpactDamageBonusQ: number;
  /** Damage reduction at full armor (0.65). */
  maxArmorDamageReductionQ: number;
}

/** Reproduction constants (docs/04 §19, docs/08 §16). */
export interface ReproductionConfig {
  reproduceOutputThresholdQ: number;
  /** Parent must retain this fraction of max energy after birth (0.20). */
  minParentReserveFractionQ: number;
  reproductionCooldownTicks: number;
  childSpawnDistanceMinLU: number;
  childSpawnDistanceMaxLU: number;
  /** Deterministic alternative spawn angles tried before falling back to parent position. */
  spawnAngleCandidates: number;
}

/** Species detection constants (docs/05 §§6–7, docs/08 §22). */
export interface SpeciesConfig {
  minDaughterPopulation: number;
  analysisIntervalTicks: number;
  kMeansIterations: number;
  stabilityIntervals: number;
  splitDistanceThresholdQ: number;
  candidateCentroidContinuityThresholdQ: number;
}

/** Event detection constants (docs/05 §§13–17, docs/08 §23). */
export interface HistoryConfig {
  massExtinctionMinStartingSpecies: number;
  massExtinctionFractionQ: number;
  carnivoreObservedMeatFractionQ: number;
  carnivoreMinPopulation: number;
  populationBoomFractionQ: number;
  populationCrashFractionQ: number;
  eventCooldownStatsSamples: number;
}

/** Hard safety limits (docs/03 §2, docs/08 §4). */
export interface LimitConfig {
  maxOrganisms: number;
  maxCarcasses: number;
  maxDetailedRenderedOrganisms: number;
  recentDeadHistorySize: number;
  maxTimelineEventsInMemoryBeforeChunk: number;
}

export interface SimulationConfig {
  schemaVersion: number;
  world: WorldConfig;
  time: TimeConfig;
  plants: PlantConfig;
  organism: OrganismConfig;
  senses: SenseConfig;
  brain: BrainConfig;
  mutation: MutationConfig;
  combat: CombatConfig;
  reproduction: ReproductionConfig;
  species: SpeciesConfig;
  history: HistoryConfig;
  limits: LimitConfig;
}
