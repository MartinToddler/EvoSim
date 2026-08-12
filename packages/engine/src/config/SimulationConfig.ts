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
 * CONFIG_SCHEMA_VERSION (see version.ts).
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

  /** Procedural generation constants (docs/03 §15). */
  generation: {
    /**
     * Elevation octaves, coarsest first. Weights are Q-scaled and sum to Q, so
     * the layered result needs no rescale. docs/03 §15 suggests
     * 0.55/0.30/0.15 over wavelengths 64/32/16 cells.
     */
    elevationOctaves: readonly { wavelengthCells: number; weightQ: number }[];
    /** Border margin in cells over which elevation fades to ocean. */
    edgeFalloffCells: number;
    /** Wavelength of the independent moisture noise field, in cells. */
    moistureWavelengthCells: number;
    /** Wavelength of the low-frequency temperature noise field, in cells. */
    temperatureWavelengthCells: number;
    /** Wavelength of the fertility noise field, in cells. */
    fertilityWavelengthCells: number;
    /** Dilation passes approximating distance-to-water for moisture (docs/03 §16). */
    waterInfluencePasses: number;
  };

  /** World-generation validity thresholds (docs/03 §15). */
  validity: {
    /** Minimum cells in the connected land region chosen for the founders. */
    minFounderRegionCells: number;
    /** Minimum total plant capacity summed over the world. */
    minTotalPlantCapacity: number;
    /** Minimum number of distinct biome classes present. */
    minBiomeClasses: number;
  };

  /** Moisture composition weights (docs/03 §16). Q-scaled, summing to Q. */
  moisture: {
    noiseWeightQ: number;
    inverseElevationWeightQ: number;
    waterInfluenceWeightQ: number;
  };

  /** Temperature field shape (docs/03 §17). Not an Earth climate model. */
  climate: {
    /** Sea-level temperature at the equator row. */
    equatorTemperatureCentiC: number;
    /** Total cooling from the equator to either pole edge. */
    poleTemperatureDropCentiC: number;
    /** Additional cooling at maximum elevation above sea level. */
    elevationCoolingCentiC: number;
    /** Amplitude of the signed low-frequency temperature noise. */
    temperatureNoiseAmplitudeCentiC: number;
  };

  /** Fertility composition (docs/03 §18). Weights are Q-scaled and sum to Q. */
  fertility: {
    moistureWeightQ: number;
    temperatureWeightQ: number;
    /** Weight of "low ground is more fertile". */
    lowlandWeightQ: number;
    noiseWeightQ: number;
    /** Temperature at which the fertility contribution peaks. */
    optimumTemperatureCentiC: number;
    /** Half-width of the fertility temperature window; suitability is 0 outside. */
    toleranceCentiC: number;
  };
}

/**
 * Authoritative tick scheduling (docs/03 §8).
 *
 * Every field here changes which phases run on which tick and therefore
 * changes authoritative state. Wall-clock pacing, render cadence, autosave
 * cadence and the simulated-year display divisor are deliberately NOT here —
 * they live in HostRuntimeConfig (@eon/protocol) so that changing them cannot
 * change a world's state hash.
 */
export interface TimeConfig {
  /** Environment update phase interval in ticks. */
  environmentInterval: number;
  /** Carcass decay phase interval in ticks. */
  carcassDecayInterval: number;
  /** Statistics/event detection interval in ticks. */
  statisticsInterval: number;
  /** Species analysis interval in ticks. */
  speciesAnalysisInterval: number;
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

  /**
   * Biomass present at world creation, as a fraction of each cell's capacity.
   * Below Q so a new world is still visibly growing when the founders arrive.
   */
  initialBiomassFractionQ: number;

  /**
   * Capacity suitability (docs/03 §20: capacity = biome base × fertility ×
   * broad moisture/temperature suitability).
   */
  capacitySuitability: {
    /** Temperature at which plant capacity suitability peaks. */
    optimumTemperatureCentiC: number;
    /** Half-width of the capacity temperature window; suitability is 0 outside. */
    temperatureToleranceCentiC: number;
    /** At or below this moisture, capacity suitability is 0. */
    minMoistureQ: number;
    /** At or above this moisture, moisture no longer limits capacity. */
    fullMoistureQ: number;
  };
}

/**
 * Gene → phenotype mapping ranges (docs/04 §3, docs/08 §7).
 *
 * Every ecological gene is stored quantized and mapped onto one of these
 * ranges by `genetics/genes.ts`. Units are the engine's native integer units,
 * not the human units of docs/08, so the mapping needs no floating point:
 *
 * - `*Pos`  — world sub-units, POS_SCALE (256) per LU;
 * - `*Vel`  — velocity units, VELOCITY_SCALE (256) per sub-unit per tick,
 *             i.e. 65 536 per LU/tick;
 * - `*Steps` — heading steps, ANGLE_STEPS (4096) per full turn;
 * - `*Q`     — normalized Q fractions/multipliers;
 * - `*CentiC`, `*Ticks` — hundredths of °C and simulation ticks.
 *
 * The three `*ExponentQ` fields are the nonlinear response exponents of
 * docs/08 §7 (size 1.35, speed 1.25, vision 1.4) applied by the deterministic
 * integer `powQ`.
 */
export interface GeneRangeConfig {
  /** Adult body radius, 1.25 … 4.50 LU. */
  adultRadiusMinPos: number;
  adultRadiusMaxPos: number;
  adultRadiusExponentQ: number;

  /** Genetic maximum speed, 0.035 … 0.30 LU/tick (before the armor penalty). */
  maxSpeedMinVel: number;
  maxSpeedMaxVel: number;
  maxSpeedExponentQ: number;

  /** Acceleration, 0.0015 … 0.025 LU/tick². */
  accelerationMinVel: number;
  accelerationMaxVel: number;

  /** Maximum turn per tick, 0.5° … 14° (before the size penalty). */
  maxTurnMinSteps: number;
  maxTurnMaxSteps: number;

  /** Vision range, 10 … 96 LU. */
  visionRangeMinPos: number;
  visionRangeMaxPos: number;
  visionRangeExponentQ: number;

  /** Total field of view, 35° … 270°. */
  visionFovMinSteps: number;
  visionFovMaxSteps: number;

  /** Metabolic pace multiplier, 0.65 … 1.45. */
  metabolicPaceMinQ: number;
  metabolicPaceMaxQ: number;

  /** Thermal optimum, -10 … +35 °C. */
  thermalOptimumMinCentiC: number;
  thermalOptimumMaxCentiC: number;

  /** Thermal tolerance half-width, 3 … 24 °C. */
  thermalToleranceMinCentiC: number;
  thermalToleranceMaxCentiC: number;

  /** Age at maturity, 400 … 2200 ticks. */
  maturityAgeMinTicks: number;
  maturityAgeMaxTicks: number;

  /** Hard maximum age, 2200 … 10 000 ticks. */
  maxAgeMinTicks: number;
  maxAgeMaxTicks: number;

  /** Offspring investment, 0.08 … 0.35 of parent max energy. */
  offspringInvestmentMinQ: number;
  offspringInvestmentMaxQ: number;
}

/** Body, energy, metabolism and health constants (docs/08 §§8–13, 15). */
export interface OrganismConfig {
  /** Gene → phenotype mapping ranges (docs/08 §7). */
  geneRanges: GeneRangeConfig;

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
    /**
     * Fraction of a soft-collision overlap resolved per tick (docs/03 §13).
     * Organisms may overlap; this only nudges them apart, and a value of Q
     * would separate them completely in one tick, which reads as a rigid body.
     */
    softSeparationStrengthQ: number;
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
    /**
     * Floor for the divisor in `stress = excess / max(tolerance, minimum)`
     * (docs/04 §8). Without it an organism with near-zero thermal tolerance
     * would divide by zero.
     */
    thermalStressMinToleranceCentiC: number;
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
 * Sensor configuration (docs/04 §§12–16, task D05).
 *
 * Only the sensors that need a tunable scale appear here. Vision range and
 * field of view are genetic, not configured, and no sensor may reveal
 * anything an organism could not plausibly perceive — there is deliberately
 * no "is a predator" or species input (docs/04 §12).
 */
export interface SenseConfig {
  /** Radius in LU inside which neighbours count toward the crowding sensor. */
  crowdingRadiusLU: number;
  /** Neighbour count at which the crowding sensor saturates at +Q. */
  crowdingSaturationCount: number;
  /** Distance ahead (and to either side) probed for terrain danger, in LU. */
  terrainProbeDistanceLU: number;
  /**
   * Evenly spaced samples along the forward danger probe. More than one makes
   * the forward sensor rise gradually as water approaches instead of flipping.
   */
  terrainForwardProbeSamples: number;
  /** Period of the internal triangular oscillator, in ticks (docs/04 §16). */
  oscillatorPeriodTicks: number;
  /**
   * Amplitude of the stateless hash noise mixed into the internal signal.
   * Stateless by design: querying or rendering must never advance the PRNG.
   */
  internalNoiseAmplitudeQ: number;
}

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

/**
 * Species detection constants (docs/05 §§6–7, docs/08 §22).
 *
 * The analysis cadence is NOT repeated here: docs/08 lists it both as
 * `species.analysisIntervalTicks` and `time.speciesAnalysisInterval`, and two
 * fields that must always agree are a determinism hazard. `time` is the single
 * source of truth for every phase cadence.
 */
export interface SpeciesConfig {
  minDaughterPopulation: number;
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

/**
 * Hard safety limits (docs/03 §2, docs/08 §4).
 *
 * These are authoritative: reaching a cap deterministically changes outcomes
 * (rejected reproduction, skipped carcass creation — docs/03 §2, docs/10 §14),
 * and the buffer sizes govern engine-owned state that snapshots must reproduce.
 * The renderer's detail budget is host-side and lives in HostRuntimeConfig.
 */
export interface LimitConfig {
  maxOrganisms: number;
  maxCarcasses: number;
  /** Ring-buffer size for recently dead organisms kept for inspection (docs/05 §20). */
  recentDeadHistorySize: number;
  /** In-memory timeline event budget before chunking (engine-owned buffer). */
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
