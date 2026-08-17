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

/**
 * One plant channel's ecology (M17, docs/11 §M17).
 *
 * Every field here is a *place* or *timing* property. What it costs an organism
 * to process the channel is not here — that is genetic and morphological, and
 * putting it in the environment config would make the channel a diet rather
 * than a resource.
 */
export interface ResourceProfile {
  /** Base capacity per biome, indexed by Biome value 0..5. */
  baseCapacityByBiome: readonly number[];
  /** Logistic growth rate (Q per environment step) per biome, indexed 0..5. */
  growthRateQByBiome: readonly number[];
  /**
   * Units returned to a cell that has been emptied to exactly zero, where the
   * logistic term is identically zero and the channel could never come back.
   *
   * There is deliberately no threshold to go with this. A flat term that fires
   * anywhere above zero is a capacity-independent food source that grazing can
   * pin open, and it will set the population ceiling on its own — see
   * `growPlants`.
   */
  seedBankRegenUnits: number;
  /** Energy per consumed biomass unit, before the eater's own efficiency. */
  energyPerUnit: number;
  /** Temperature at which this channel's capacity peaks. */
  optimumTemperatureCentiC: number;
  /** Half-width of the temperature window; capacity is 0 outside it. */
  temperatureToleranceCentiC: number;
  /** At or below this moisture, capacity is 0. */
  minMoistureQ: number;
  /** At or above this moisture, moisture no longer limits capacity. */
  fullMoistureQ: number;
  /**
   * How much the cell's fertility matters, in `[0, Q]`.
   *
   * 0 ignores fertility entirely, Q is as fertility-hungry as the single
   * Milestone 0–16 field. Low weights are what let a channel hold ground that
   * nothing else will grow on.
   */
  fertilityWeightQ: number;
  /** Elevation at which capacity peaks, in `[0, Q]`. */
  optimumElevationQ: number;
  /** Half-width of the elevation window; Q or more is indifferent to terrain. */
  elevationToleranceQ: number;
  /**
   * Health lost per unit eaten, before the eater's toxin resistance.
   *
   * Non-zero on exactly one channel as shipped. It is a per-channel field
   * rather than a special case in the feeding phase because "which channel
   * fights back" is an ecology parameter, and a hard-coded `if (resource ===
   * Defended)` would be a category deciding behaviour.
   */
  toxicityQ: number;
}

export interface PlantConfig {
  /** The five plant channels, indexed by Resource value 0..4 (M17). */
  resources: readonly ResourceProfile[];
  /** Energy per consumed carcass meat unit before digestion efficiency. */
  meatEnergyPerUnit: number;

  /**
   * Biomass present at world creation, as a fraction of each channel's
   * capacity. Below Q so a new world is still visibly growing when the founders
   * arrive.
   */
  initialBiomassFractionQ: number;
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
/**
 * Morphological development bounds (M14, docs/11 §M14).
 *
 * Every length here is a Q-scaled MULTIPLE of the organism's adult radius,
 * never a world unit: `Gene.AdultSize` owns scale and the morphological genome
 * owns shape. Keeping them apart is what lets a lineage evolve a long thin body
 * at any size, and it stops morphology from silently re-deciding a quantity the
 * ecological genome already selects on.
 *
 * Hard minima and maxima on the two structural loci are what keep development
 * bounded: there is no recursive grammar and no growth loop, so growing a body
 * costs the same for every genome (CLAUDE.md, EvoSim 2.0 performance rule).
 */
export interface MorphologyConfig {
  /** Structural: inclusive segment-count range. */
  minSegments: number;
  maxSegments: number;
  /** Structural: inclusive appendage-pair range. */
  minAppendagePairs: number;
  maxAppendagePairs: number;

  /** Body extent along the heading, Q multiple of the adult radius. */
  bodyLengthMinQ: number;
  bodyLengthMaxQ: number;
  /** Body extent across the heading, Q multiple of the adult radius. */
  bodyWidthMinQ: number;
  bodyWidthMaxQ: number;
  /** Per-segment size multiplier toward the rear. */
  segmentFalloffMinQ: number;
  segmentFalloffMaxQ: number;

  /** Appendage length, Q multiple of the body half-width. */
  appendageLengthMinQ: number;
  appendageLengthMaxQ: number;
  /** Appendage thickness, Q fraction of its length. */
  appendageThicknessMinQ: number;
  appendageThicknessMaxQ: number;
  /** Rest angle away from the lateral axis, in heading steps. */
  appendageAngleMinSteps: number;
  appendageAngleMaxSteps: number;

  /** Head share of the body length. */
  headProportionMinQ: number;
  headProportionMaxQ: number;
  /** Feeding structure size, Q fraction of the head extent. */
  mouthSizeMinQ: number;
  mouthSizeMaxQ: number;
  /** Sensory structure size, Q fraction of the head extent. */
  sensorSizeMinQ: number;
  sensorSizeMaxQ: number;

  /** Posterior extension length, Q multiple of the body length. */
  tailLengthMinQ: number;
  tailLengthMaxQ: number;
  /** Posterior extension base width, Q fraction of the body width. */
  tailWidthMinQ: number;
  tailWidthMaxQ: number;

  /** Half-range of the primary pigment shift from the ecological hue, degrees. */
  pigmentPrimaryShiftMaxDeg: number;
  /** Half-range of the secondary pigment shift from the primary, degrees. */
  pigmentSecondaryShiftMaxDeg: number;
  /** Highest pattern repeat count; bounds the renderer's band loop. */
  patternFrequencyMax: number;

  /**
   * Ceiling on the derived silhouette extents, Q multiple of the adult radius.
   *
   * A declared bound rather than a computed maximum: the renderer sizes its
   * sprite frame from this constant, so widening any range above cannot
   * silently push artwork outside the frame it is drawn into.
   */
  maxSilhouetteExtentQ: number;
}

/**
 * How a developed body turns into physics (M15, docs/11 §M15).
 *
 * Every `…GainQ` is the Q-scaled amount one driver moves one factor when it
 * travels the whole distance from the founder body's value to the extreme. A
 * factor is `1 + Σ ±gain × (expression − founderExpression)`, so the founder
 * morphology is exactly neutral and every coefficient reads as "how much does
 * diverging in this direction matter".
 *
 * `validateConfig` bounds the summed gains of each factor below Q, so no factor
 * can be driven to zero or inverted by a legal configuration; `minFactorQ` and
 * `maxFactorQ` are the hard backstop, not the working range.
 */
export interface PhysicalMorphologyConfig {
  /** Mass of plate tissue per unit area, relative to soft tissue. */
  plateDensityQ: number;
  /** Structural mass each segment past the first adds, as a share of the trunk. */
  segmentStructureQ: number;

  /** How much of the body-area ratio to the founder reaches body mass. */
  massBulkGainQ: number;
  /** Body width → maximum energy. */
  storeGirthGainQ: number;

  /** Limb area → basal upkeep. */
  basalLimbGainQ: number;
  /** Plating → basal upkeep. */
  basalArmorGainQ: number;
  /** Mouth size → basal upkeep: jaw muscle is maintained whether or not it bites. */
  basalMouthGainQ: number;

  /** Limb area → movement cost: a big propulsive apparatus burns more to push. */
  movementLimbGainQ: number;
  /** Lateral silhouette → movement cost. */
  movementDragGainQ: number;

  /** Plating → energy per unit of grown mass. */
  growthArmorGainQ: number;
  /** Limb area → energy per unit of grown mass. */
  growthLimbGainQ: number;

  /** Rearward-swept limb area → top speed. */
  speedThrustGainQ: number;
  /** Tail length → top speed: an undulating tail is a propulsive surface. */
  speedTailGainQ: number;
  /** Lateral silhouette → top speed (a penalty). */
  speedDragGainQ: number;
  /** Plating → top speed (a penalty). */
  speedArmorGainQ: number;

  /** Rearward-swept limb area → acceleration. */
  accelThrustGainQ: number;
  /** Realized mass → acceleration (a penalty). */
  accelMassGainQ: number;

  /** Segment count → turn rate. */
  turnSegmentGainQ: number;
  /** Laterally held limb area → turn rate. */
  turnLateralGainQ: number;
  /** Fore/aft silhouette → turn rate (a penalty): body, head and tail together. */
  turnSpanGainQ: number;
  /** Mouth size → turn rate (a penalty): mass carried out at the nose. */
  turnMouthGainQ: number;

  /** Slenderness → movement speed in water. */
  waterStreamlineGainQ: number;
  /** Limb area → movement speed in water. */
  waterPaddleGainQ: number;
  /** Tail length → movement speed in water. */
  waterTailGainQ: number;
  /** Body width → movement speed in water (a penalty). */
  waterGirthGainQ: number;

  /** Plating → effective armor. */
  armorPlateGainQ: number;
  /** Mouth size → attack power. */
  attackMouthGainQ: number;
  /** Head proportion → attack power. */
  attackHeadGainQ: number;
  /** Mouth size → bite size. */
  biteMouthGainQ: number;

  /** Sensor size → vision range. */
  visionRangeSensorGainQ: number;
  /** Forward sensor placement → vision range. */
  visionRangeForwardGainQ: number;
  /** Sensor size → field of view. */
  visionFovSensorGainQ: number;
  /** Forward sensor placement → field of view (a penalty). */
  visionFovForwardGainQ: number;

  /** Slenderness → thermal tolerance (a penalty: more surface per volume). */
  thermalSlendernessGainQ: number;
  /** Fore/aft silhouette → contact extent. */
  collisionSilhouetteGainQ: number;
  /** Dig ability gained per unit of limb share above the founder's (M17). */
  digLimbGainQ: number;

  /** Realized mass → offspring construction overhead. */
  offspringBulkGainQ: number;
  /** Plating → offspring construction overhead. */
  offspringArmorGainQ: number;

  /** Hard floor on every derived factor; must be above zero. */
  minFactorQ: number;
  /** Hard ceiling on every derived factor. */
  maxFactorQ: number;
}

export interface OrganismConfig {
  /** Gene → phenotype mapping ranges (docs/08 §7). */
  geneRanges: GeneRangeConfig;

  /** Morphological development bounds (M14, docs/11 §M14). */
  morphology: MorphologyConfig;

  /** Developed body → physical phenotype (M15, docs/11 §M15). */
  physicalMorphology: PhysicalMorphologyConfig;

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
    /**
     * Upkeep per unit of processing investment above the founder's total (M17).
     *
     * The price of a broad gut. It is what keeps six independent processing
     * loci from all evolving to their maximum: each one is capability the body
     * maintains whether or not the channel is in front of it.
     */
    digestiveMaintCoeffQ: number;
    /** Upkeep per unit of toxin resistance, squared as the other defences are. */
    toxinResistMaintCoeffQ: number;
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
    /**
     * Temperature at or below which the hot-decay bonus is zero, and the
     * temperature at which it reaches {@link hotDecayBonusMaxQ}.
     *
     * docs/03 §23 requires decay to be affected "at least by temperature" and
     * docs/08 §15 gives the size of the bonus but no temperature scale to read
     * it against, so the scale has to be stated somewhere. Two explicit
     * endpoints are the cheapest honest answer: the bonus rises linearly
     * between them and saturates above.
     */
    hotDecayMinTemperatureCentiC: number;
    hotDecayFullBonusTemperatureCentiC: number;
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
  /** Per-tick upkeep of neural complexity beyond the founder's (M16). */
  complexity: NeuralComplexityConfig;
}

/** Mutation constants (docs/08 §17). Probabilities are Q fractions. */
/**
 * Structural mutation of the neural topology (M16, docs/11 §M16).
 *
 * Deliberately blunt: a probability gate, then a uniform count of bit flips.
 * The PRNG cost is `1 + 2 x flips` and is independent of network size, which is
 * what keeps one lineage's structural history out of every other organism's
 * random stream.
 */
export interface TopologyMutationConfig {
  /** Chance that a birth changes the network's shape at all. */
  structuralProbabilityQ: number;
  /** Most bits one birth may flip; bounds the PRNG cost as well as the change. */
  maxFlipsPerBirth: number;
}

/**
 * What a brain costs to keep alive, per tick, per unit of excess complexity
 * over the founder's (M16).
 *
 * Energy units, Q-scaled: `Q` is one energy per tick. The fractional scale is
 * load-bearing rather than tidy. A connection is the smallest unit of brain
 * there is and there are 576 of them, while a *useful* hidden unit arrives
 * wired to twenty inputs and five outputs; charging a whole energy unit per
 * connection made one such unit cost 26/tick against an adult's whole basal
 * bill of ~30, which is not a trade-off but a prohibition, and the first
 * measurement showed hidden units being switched on by mutation and removed by
 * selection within a generation every time (ADR 0030 §10).
 *
 * The billed total is whole energy with a floor of one for any non-zero
 * excess, so a fractional scale never becomes a free one: the smallest
 * addressable change a lineage can make still costs something every tick it
 * lives.
 */
export interface NeuralComplexityConfig {
  /** Per sensory channel active beyond the founder's twenty. */
  perSensoryChannelQ: number;
  /** Per hidden unit switched on. */
  perHiddenUnitQ: number;
  /** Per recurrent link switched on. */
  perRecurrentLinkQ: number;
  /** Per memory register retained. */
  perMemoryRegisterQ: number;
  /** Per connection active beyond the founder's hundred. */
  perConnectionQ: number;
}

export interface MutationConfig {
  /**
   * Ecological gene mutation. Sigmas are Q fractions of the NORMALIZED gene
   * range, as docs/08 §17 states them ("0.025 normalized"), and are scaled onto
   * the raw Uint16 span at use.
   */
  ecological: {
    perGeneMutationProbabilityQ: number;
    smallSigmaQ: number;
    largeMutationProbabilityQ: number;
    largeSigmaQ: number;
    resetProbabilityQ: number;
  };
  /**
   * Brain weight mutation. Sigmas are in STORED weight units, not Q fractions:
   * docs/08 §17 gives `weightSmallSigmaQ` as "0.06 weight units", i.e.
   * 0.06 × `brain.weightScale`.
   */
  brain: {
    perWeightMutationProbabilityQ: number;
    weightSmallSigmaQ: number;
    largeWeightMutationProbabilityQ: number;
    /**
     * Sigma of the rare large weight jump, in stored weight units.
     *
     * docs/08 §17 and docs/04 §18 give the brain block a large *probability* but
     * no large sigma, while the ecological block gets both. This field closes
     * that gap rather than reusing an ecological sigma whose units are
     * different; see ADR 0006 §3.
     */
    weightLargeSigmaQ: number;
  };
  /**
   * Morphological gene mutation (M14). Sigmas are Q fractions of the
   * NORMALIZED gene range, like the ecological block.
   *
   * `structuralProbabilityQ` replaces the small and large classes on the two
   * integer-valued loci: a segment count has no meaningful "slightly bigger",
   * so gaining or losing one is its own discrete ±1 event rather than an
   * artefact of where a genome happens to sit inside a bucket.
   */
  morphology: {
    perGeneMutationProbabilityQ: number;
    smallSigmaQ: number;
    largeMutationProbabilityQ: number;
    largeSigmaQ: number;
    resetProbabilityQ: number;
    structuralProbabilityQ: number;
  };
  /** Neural topology structural mutation (M16). */
  topology: TopologyMutationConfig;
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
  /**
   * Damage multiplier of the smallest possible body (0.50).
   *
   * docs/08 §14's `sizeFactor = 0.5 + 0.5 * attackerSizeNorm` is one constant
   * stated twice: the floor, and the span that carries the factor from the floor
   * to 1.0 at full size. Only the floor is configured; the span is derived as
   * `Q - floor` so the two halves cannot drift apart and the factor cannot
   * silently exceed 1.0.
   */
  attackSizeFactorFloorQ: number;
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
 * Player intervention constants (docs/01 §4, docs/02 §§15–16, docs/03 §25;
 * Milestone 9).
 *
 * Everything a canonical command may carry is bounded here, and every effect an
 * intervention has on the world is scaled by a constant from here — no literal
 * strengths anywhere in the appliers (CLAUDE.md "Configuration"). Strengths are
 * per-application deltas: the PLAYER chooses a strength within the bound each
 * stroke; the accumulated offsets have their own bounds so repeated strokes
 * saturate instead of wrapping the underlying Int16 rows.
 */
export interface InterventionConfig {
  /**
   * Hard cap on canonical brush samples one command may carry. Bounds both the
   * command payload and the phase-0 work one command can demand.
   */
  maxBrushSamplesPerCommand: number;
  /** Canonical stroke resample spacing in whole LU (docs/02 §16). */
  brushSampleSpacingLU: number;
  minBrushRadiusLU: number;
  maxBrushRadiusLU: number;
  /** Largest per-application temperature delta at the brush centre (centi-°C). */
  maxTemperatureBrushStrengthCentiC: number;
  /** Largest per-application moisture delta at the brush centre (Q). */
  maxMoistureBrushStrengthQ: number;
  /** Largest per-application fertility delta at the brush centre (Q). */
  maxFertilityBrushStrengthQ: number;
  /** Largest per-application elevation delta at the brush centre (Q). */
  maxTerrainBrushStrengthQ: number;
  /** Largest per-application biomass delta at the brush centre (biomass units). */
  maxBiomassBrushStrengthUnits: number;
  /** Saturation bound for the accumulated local temperature offset (centi-°C). */
  maxLocalTemperatureOffsetCentiC: number;
  /** Bound for the global temperature offset command (centi-°C). */
  maxGlobalTemperatureOffsetCentiC: number;
  /**
   * ADD_BIOMASS ceiling as a Q multiple of the cell's capacity (>= Q).
   * docs/03 §27 explicitly allows transient brush overfill above capacity;
   * this bounds how far above. Growth decays overfill back toward capacity.
   */
  biomassOverfillLimitQ: number;
  /** Meteor catastrophe constants (docs/03 §25). All effects fall off linearly to the rim. */
  meteor: {
    minRadiusLU: number;
    maxRadiusLU: number;
    /** Organism health damage at the impact centre (Q; Q = a full health bar). */
    damageQ: number;
    /** Fraction of plant biomass destroyed at the centre (Q). */
    biomassLossQ: number;
    /** Elevation drop at the centre (Q). */
    depressionQ: number;
    /** Fertility change at the centre (Q, signed; negative = scorched soil). */
    fertilityDeltaQ: number;
  };
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
  interventions: InterventionConfig;
  limits: LimitConfig;
}
