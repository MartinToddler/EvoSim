import { deepFreezeJson } from "@eon/shared";
import { CONFIG_SCHEMA_VERSION } from "../version";
import type { ReadonlySimulationConfig } from "./cloneConfig";
import type { SimulationConfig } from "./SimulationConfig";

/**
 * DEFAULT_CONFIG v0.1 — implementation defaults for calibration, verbatim
 * from docs/08 (values quantized to integer Q representation exactly as the
 * spec lists them; conceptual real values in comments). These are versioned
 * starting hypotheses, not biological claims. Tuning happens later through
 * named config commits and sweep experiments, never through hidden
 * conditional bonuses (docs/08 §24).
 */
const DEFAULT_CONFIG_SOURCE: SimulationConfig = {
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

    generation: {
      // docs/03 §15: 0.55 / 0.30 / 0.15 over wavelengths 64 / 32 / 16 cells.
      elevationOctaves: [
        { wavelengthCells: 64, weightQ: 2253 }, // 0.55
        { wavelengthCells: 32, weightQ: 1229 }, // 0.30
        { wavelengthCells: 16, weightQ: 614 }, // 0.15
      ],
      // Calibrated over 12 seeds: a 16-cell border fade still guarantees an
      // ocean rim while keeping 10/12 seeds inside the 35–70% land window on
      // the first attempt (a wider fade drowned most worlds and forced retries).
      edgeFalloffCells: 16,
      moistureWavelengthCells: 64,
      temperatureWavelengthCells: 128,
      fertilityWavelengthCells: 32,
      // Reach of the coastal moisture gradient, in cells. The docs/03 §16
      // formula alone averages ~0.42 moisture, below the 0.62 forest threshold,
      // so a short reach left forest nearly absent; 24 passes give wet coasts
      // and dry interiors, and forest in 9 of 12 calibration seeds.
      waterInfluencePasses: 24,
    },

    validity: {
      minFounderRegionCells: 256,
      minTotalPlantCapacity: 50_000_000,
      minBiomeClasses: 3,
    },

    moisture: {
      noiseWeightQ: 2662, // 0.65
      inverseElevationWeightQ: 820, // 0.20
      waterInfluenceWeightQ: 614, // 0.15
    },

    climate: {
      equatorTemperatureCentiC: 3000, // +30 °C at the equator, sea level
      poleTemperatureDropCentiC: 4000, // -10 °C at the pole edges, sea level
      elevationCoolingCentiC: 1000, // a further -10 °C on the highest ground
      temperatureNoiseAmplitudeCentiC: 400, // ±4 °C of regional variation
    },

    fertility: {
      moistureWeightQ: 1638, // 0.40
      temperatureWeightQ: 1229, // 0.30
      lowlandWeightQ: 614, // 0.15
      noiseWeightQ: 615, // 0.15
      optimumTemperatureCentiC: 2000, // 20 °C
      toleranceCentiC: 2000, // fertile band roughly 0 °C … 40 °C
    },
  },

  // Authoritative tick scheduling only. Wall-clock pacing, render cadence,
  // autosave cadence and the sim-year display divisor live in
  // DEFAULT_HOST_RUNTIME_CONFIG (@eon/protocol).
  time: {
    environmentInterval: 20,
    carcassDecayInterval: 20,
    statisticsInterval: 100,
    speciesAnalysisInterval: 400,
  },

  plants: {
    // Indexed by Biome: Water, Grassland, Forest, Desert, Tundra, Mountain.
    //
    // Calibrated at 0.6x the docs/08 v0.1 values (ADR 0025 §2b, closing L11).
    // The v0.1 world was productive enough to push a third of calibration
    // seeds into the maxOrganisms safety cap (ADR 0021 §5a) — the cap, not
    // the ecology, was setting the carrying capacity, and docs/01 §12 makes
    // that a release-gate failure. Factors 1.0/0.8/0.7/0.6 were swept over
    // twelve seeds at 10 000 ticks, with the survivors re-run to 25 000 on
    // the worst cap seeds: 0.8 and 1.0 cap 3/12 seeds by tick 10 000, 0.7
    // caps both risk seeds by 25 000, and 0.6 leaves every seed under the
    // cap with headroom while keeping 12/12 survival and universal
    // scavenging. docs/08 §24: tuned through named experiments, recorded
    // here and in the changelog.
    // M17 (docs/11 §M17, ADR 0031). Five channels that PARTITION the world's
    // productivity rather than stack on it.
    //
    // The first version kept foliage at its Milestone 0-16 values and added the
    // other four on top, reasoning that preserving foliage preserved the
    // calibrated ecology. It did the opposite: measured over three seeds, total
    // plant capacity came out 3.5-4.4x the old foliage-only figure, foliage
    // fell to 23-28% of its own world, and the 100 000-tick soak finished
    // pinned at 8192 organisms — exactly `limits.maxOrganisms`, against 572 for
    // M16. docs/01 §12 makes the cap setting carrying capacity a release-gate
    // failure, and ADR 0006 §7 had already described the same shape.
    //
    // Every channel is now scaled so the SUM matches what Milestones 0-13
    // calibrated: 95.7M / 108.7M / 116.7M against the old foliage-only 93.1M /
    // 107.2M / 125.1M on the same three seeds. Foliage keeps the plurality it
    // is specified to have — 44-48% — with roots, browse and defended growth
    // filling the ground it does not want and fruit staying the rarity it is.
    //
    // The lesson is the one M17 kept relearning: "unchanged" describes a number
    // in isolation, and an ecology is a sum. Preserving one term of a sum while
    // adding four more does not preserve the sum.
    //
    // ## Why the energy spread is narrow (30 … 48, measured)
    //
    // The first version spread it 30 … 96, on the reasoning that a channel that
    // is harder to reach should be worth more. Measured on the ordinary engine,
    // the founder ate 91% DEFENDED growth in its first hundred ticks — the one
    // channel that damages it, which it has no resistance to, and which it is
    // bad at processing. The arithmetic is unforgiving: expected gain is
    // `energyPerUnit x efficiency`, the founder's efficiencies span 0.36 … 0.84
    // (2.3x) and the energies spanned 3.2x, so the richest channel won for
    // EVERY genome. A resource whose value beats every genetic difference is a
    // universal strategy wearing five names, and docs/11 §M17's acceptance
    // criterion is precisely that no such strategy exists.
    //
    // With the spread compressed inside the efficiency spread, the genome
    // decides instead: the founder gets 25.2/unit from foliage against 15.8
    // from defended and 17.3 from fruit, and a lineage that specializes flips
    // that. What a channel is worth is now a fact about the eater.
    //
    // Each of the other four is placed where foliage is weak, which is what
    // makes them niches rather than decoration: browse in the wet forest
    // foliage already likes but at twice the standing mass and a sixth of the
    // regrowth, fruit in a narrow warm/wet band, roots in the dry and infertile
    // ground where foliage capacity collapses, and defended growth in the
    // hot/dry margin where almost nothing else stands.
    resources: [
      {
        // Foliage — the Milestone 0-16 field at 0.45x, so that it keeps the
        // plurality of a world it now shares with four other channels while the
        // TOTAL stays what docs/08 §24's twelve-seed experiments calibrated.
        // Its shape (growth rates, seed bank, energy, climate curves) is
        // untouched; only the scale moved, and it moved because the sum did.
        baseCapacityByBiome: [0, 9720, 14040, 1890, 2700, 1080],
        growthRateQByBiome: [0, 49, 37, 12, 12, 6], // ~.012 .009 .003 .003 .0015
        seedBankRegenUnits: 4,
        energyPerUnit: 30,
        optimumTemperatureCentiC: 1800, // 18 °C
        temperatureToleranceCentiC: 2200, // roughly -4 °C … 40 °C
        minMoistureQ: 205, // 0.05
        fullMoistureQ: 2458, // 0.60
        fertilityWeightQ: 4096, // 1.00 — exactly as fertility-hungry as before
        optimumElevationQ: 2048,
        elevationToleranceQ: 4096, // indifferent to terrain
        toxicityQ: 0,
      },
      {
        // Browse — tough vegetation. Where it grows it out-masses foliage two
        // to one, and it comes back roughly six times slower, so a browsed
        // stand is a standing store rather than a renewing one. Forest and
        // grassland only: this is woody growth.
        baseCapacityByBiome: [0, 3780, 9660, 252, 630, 378],
        growthRateQByBiome: [0, 8, 7, 2, 2, 1],
        seedBankRegenUnits: 2,
        energyPerUnit: 34,
        optimumTemperatureCentiC: 1600,
        temperatureToleranceCentiC: 2600, // tolerates cold better than foliage
        minMoistureQ: 820, // 0.20 — needs real moisture
        fullMoistureQ: 2867, // 0.70
        fertilityWeightQ: 2867, // 0.70
        optimumElevationQ: 2048,
        elevationToleranceQ: 4096,
        toxicityQ: 0,
      },
      {
        // Fruit — concentrated and slow. The highest energy per unit of any
        // plant channel against the smallest capacity and the slowest regrowth,
        // and a narrow warm/wet window that puts it in a few places rather than
        // everywhere. "Intermittent" is the consequence: a stripped patch is
        // gone for thousands of ticks, so the living is made by finding the
        // next one rather than by waiting at this one.
        baseCapacityByBiome: [0, 5200, 9000, 700, 500, 400],
        // Slow, but not "never": at rate 3 a grazed patch took longer than any
        // run to come back, which made fruit a one-time treasure rather than a
        // channel a lineage could live on — fruit specialists held 1% of a world
        // built to favour them. Still the slowest channel by a factor of six
        // against foliage, so "slow to return" is intact.
        growthRateQByBiome: [0, 8, 8, 2, 2, 1],
        seedBankRegenUnits: 2,
        energyPerUnit: 48,
        optimumTemperatureCentiC: 2300, // 23 °C — warmer than foliage likes
        temperatureToleranceCentiC: 900, // and much fussier about it
        minMoistureQ: 1638, // 0.40
        fullMoistureQ: 3277, // 0.80
        fertilityWeightQ: 4096,
        optimumElevationQ: 1843, // lowland
        elevationToleranceQ: 1638,
        toxicityQ: 0,
      },
      {
        // Roots — persistent. A high regeneration floor against a slow rate is
        // what "always there in small amounts" has to mean mechanically: this
        // is the channel that is never quite absent, including where every
        // other channel has been grazed flat. Nearly indifferent to fertility
        // and happy in dry ground, so it holds the desert.
        baseCapacityByBiome: [0, 1377, 1224, 1102, 1285, 643],
        growthRateQByBiome: [0, 6, 5, 5, 5, 3],
        // Persistence is the FLOOR, not the rate. The first version had
        // 12 units per environment step against a threshold of 260, which is
        // 6000 free units per cell per 10 000 ticks — three times foliage's
        // and twelve times fruit's, in every cell of every world, regardless
        // of capacity, fertility, moisture or the world's resource mix. That
        // is not a persistent channel, it is a faucet grazing cannot close,
        // and it made roots the best living almost everywhere: it won a world
        // built to favour fruit (ADR 0031 §5c).
        //
        // The rate now matches foliage's, so roots earn no more than anything
        // else. What still makes them persistent is the threshold — 120 against
        // 8 … 24 for every other channel — so a grazed root cell holds a real
        // standing stock where a grazed fruit patch holds nothing.
        seedBankRegenUnits: 4,
        energyPerUnit: 38,
        optimumTemperatureCentiC: 1500,
        temperatureToleranceCentiC: 3200, // very wide: underground is buffered
        minMoistureQ: 0, // no moisture floor at all
        fullMoistureQ: 1229, // 0.30 — satisfied by very little
        fertilityWeightQ: 1229, // 0.30 — grows in poor ground
        optimumElevationQ: 2048,
        elevationToleranceQ: 4096,
        toxicityQ: 0,
      },
      {
        // Defended — the richest plant channel, and the only one that costs
        // health to eat. Placed in the hot dry margin where the others are
        // weakest, so the trade it offers is real: the ground nobody else can
        // use, in exchange for damage that only a resistant lineage can absorb.
        baseCapacityByBiome: [0, 1260, 1080, 1980, 720, 936],
        growthRateQByBiome: [0, 10, 9, 12, 6, 7],
        seedBankRegenUnits: 3,
        energyPerUnit: 44,
        optimumTemperatureCentiC: 2600, // 26 °C — the hot end
        temperatureToleranceCentiC: 2000,
        minMoistureQ: 0,
        fullMoistureQ: 1024, // 0.25 — thrives dry
        fertilityWeightQ: 819, // 0.20
        optimumElevationQ: 2048,
        elevationToleranceQ: 4096,
        // Health lost per unit eaten, in Q health units, at zero resistance.
        //
        // Sized against the bite, not guessed: `maxPlantBiteUnits` is 64 and
        // health runs 0 … Q (4096), so 12 per unit costs a full bite about 19%
        // of health — a real price a fed organism can absorb and heal off, and
        // a fatal one for anything already hurt. The first value was 246, which
        // read as "0.06 health per unit" and is nothing of the kind: it made
        // seventeen units lethal, so one bite killed outright and the channel
        // was a suicide button rather than a trade.
        toxicityQ: 12,
      },
    ],
    meatEnergyPerUnit: 45,
    initialBiomassFractionQ: 2048, // 0.50
  },

  organism: {
    // M14 (docs/11 §M14). Every length is a Q multiple of the adult radius,
    // so these are proportions and `adultRadius*` above is the only scale.
    // The ranges are wide enough that two lineages can look genuinely
    // unrelated and narrow enough that no point in the space draws as
    // something that is not an animal.
    morphology: {
      minSegments: 1,
      maxSegments: 5,
      minAppendagePairs: 0,
      maxAppendagePairs: 4,
      bodyLengthMinQ: 2867, // 0.70 × radius
      bodyLengthMaxQ: 9830, // 2.40 × radius
      bodyWidthMinQ: 1638, // 0.40 × radius
      bodyWidthMaxQ: 6963, // 1.70 × radius
      segmentFalloffMinQ: 2253, // 0.55
      segmentFalloffMaxQ: 4096, // 1.00 — equal segments
      appendageLengthMinQ: 0,
      appendageLengthMaxQ: 5734, // 1.40 × half-width
      appendageThicknessMinQ: 492, // 0.12 of its length
      appendageThicknessMaxQ: 2253, // 0.55 of its length
      appendageAngleMinSteps: 0, // straight out sideways
      appendageAngleMaxSteps: 768, // 67.5° swept off lateral
      headProportionMinQ: 410, // 0.10 of the body length
      headProportionMaxQ: 1843, // 0.45 of the body length
      mouthSizeMinQ: 205, // 0.05
      mouthSizeMaxQ: 2867, // 0.70
      sensorSizeMinQ: 123, // 0.03
      sensorSizeMaxQ: 1638, // 0.40
      tailLengthMinQ: 0,
      tailLengthMaxQ: 4506, // 1.10 × body length
      tailWidthMinQ: 205, // 0.05 of the body width
      tailWidthMaxQ: 2458, // 0.60 of the body width
      pigmentPrimaryShiftMaxDeg: 40,
      pigmentSecondaryShiftMaxDeg: 180,
      patternFrequencyMax: 6,
      // 10 × radius: the widest body (2.40) plus the longest head (0.45 of it)
      // plus the longest tail (1.10 of it) reaches 6.1, so the frame has room
      // for a later widening without artwork leaving it.
      maxSilhouetteExtentQ: 40960,
    },

    // M15, docs/11 §M15 and ADR 0029. Read every value as "travelling the whole
    // distance from the founder body to the extreme moves this quantity by X".
    // The founder body is exactly neutral, so these are all differences, not
    // absolutes, and nothing here re-tunes the calibrated MVP ecology on its own.
    physicalMorphology: {
      // Plate tissue weighs twice what soft tissue does per unit area, and each
      // segment past the first adds 15% of the trunk as structural mass.
      plateDensityQ: 8192, // 2.00
      segmentStructureQ: 614, // 0.15

      // The largest body the config can express is ~11.5x the founder's area,
      // so the gain is what keeps morphology consequential without letting one
      // mutation direction dwarf every ecological gene. 0.25 also keeps the
      // heaviest expressible body (3.87x) clear of the maxFactorQ backstop, so
      // the clamp stays a guard rather than a working part of the physics.
      massBulkGainQ: 1024, // 0.25
      storeGirthGainQ: 1229, // 0.30

      basalLimbGainQ: 2458, // 0.60
      basalArmorGainQ: 1638, // 0.40
      basalMouthGainQ: 1229, // 0.30

      // Locomotion is billed twice, as it should be: once for maintaining the
      // apparatus and once for using it. Without the second term a lineage that
      // grows limbs pays a few percent of upkeep for a few percent of speed and
      // wins in every world, which is the "always maximize" shape the trade-off
      // rule forbids (ADR 0029 §5c).
      movementLimbGainQ: 3686, // 0.90
      movementDragGainQ: 2048, // 0.50

      growthArmorGainQ: 2458, // 0.60 — plate is the dearest tissue to build
      growthLimbGainQ: 2048, // 0.50

      speedThrustGainQ: 2867, // 0.70
      speedTailGainQ: 410, // 0.10
      speedDragGainQ: 1638, // 0.40
      speedArmorGainQ: 1229, // 0.30

      accelThrustGainQ: 2458, // 0.60
      accelMassGainQ: 1024, // 0.25

      turnSegmentGainQ: 1229, // 0.30
      turnLateralGainQ: 2458, // 0.60
      turnSpanGainQ: 1638, // 0.40
      turnMouthGainQ: 1024, // 0.25

      waterStreamlineGainQ: 1638, // 0.40
      waterPaddleGainQ: 2458, // 0.60
      waterTailGainQ: 1229, // 0.30
      waterGirthGainQ: 1638, // 0.40

      armorPlateGainQ: 2458, // 0.60
      attackMouthGainQ: 2048, // 0.50
      attackHeadGainQ: 1229, // 0.30
      biteMouthGainQ: 1638, // 0.40

      visionRangeSensorGainQ: 1638, // 0.40
      visionRangeForwardGainQ: 819, // 0.20
      visionFovSensorGainQ: 819, // 0.20
      visionFovForwardGainQ: 1229, // 0.30

      thermalSlendernessGainQ: 1229, // 0.30
      collisionSilhouetteGainQ: 1229, // 0.30
      // M17. The strongest single-locus factor in the block, deliberately: a
      // fully limbed body digs about 2.4x as well as the founder, which has to
      // be enough to make the roots channel worth the limb bill it is paid for.
      digLimbGainQ: 5734, // 1.40

      offspringBulkGainQ: 819, // 0.20
      offspringArmorGainQ: 1229, // 0.30

      // Backstops, not the working range: the gain bounds above keep every
      // factor well inside these for any body the config can grow.
      minFactorQ: 819, // 0.20
      maxFactorQ: 16384, // 4.00
    },

    // docs/08 §7 in engine units. Conversions: LU → sub-units ×256,
    // LU/tick → velocity units ×65536, degrees → steps ×4096/360.
    geneRanges: {
      adultRadiusMinPos: 320, // 1.25 LU
      adultRadiusMaxPos: 1152, // 4.50 LU
      adultRadiusExponentQ: 5530, // 1.35

      maxSpeedMinVel: 2294, // 0.035 LU/tick
      maxSpeedMaxVel: 19661, // 0.30 LU/tick
      maxSpeedExponentQ: 5120, // 1.25

      accelerationMinVel: 98, // 0.0015 LU/tick²
      accelerationMaxVel: 1638, // 0.025 LU/tick²

      maxTurnMinSteps: 6, // 0.53°/tick
      maxTurnMaxSteps: 159, // 13.97°/tick

      visionRangeMinPos: 2560, // 10 LU
      visionRangeMaxPos: 24576, // 96 LU
      visionRangeExponentQ: 5734, // 1.4

      visionFovMinSteps: 398, // 35°
      visionFovMaxSteps: 3072, // 270°

      metabolicPaceMinQ: 2662, // 0.65
      metabolicPaceMaxQ: 5939, // 1.45

      thermalOptimumMinCentiC: -1000, // -10 °C
      thermalOptimumMaxCentiC: 3500, // +35 °C

      thermalToleranceMinCentiC: 300, // 3 °C
      thermalToleranceMaxCentiC: 2400, // 24 °C

      maturityAgeMinTicks: 400,
      maturityAgeMaxTicks: 2200,

      maxAgeMinTicks: 2200,
      maxAgeMaxTicks: 10000,

      offspringInvestmentMinQ: 328, // 0.08
      offspringInvestmentMaxQ: 1434, // 0.35
    },

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
      // M17. Calibrated against the founder's own basal coefficient rather
      // than picked: the founder's mass coefficient is ~0.09, so raising every
      // one of the five non-foliage loci from the founder's 0.50 to the maximum
      // adds 5 x 0.50 = 2.5 of investment and costs 2.5 x 0.020 = 0.05 — a bit
      // over half the founder's whole basal coefficient again, for a body that
      // can eat anything well. Real, and payable where the breadth is worth it.
      digestiveMaintCoeffQ: 82, // 0.020
      // Squared, like attack and armor, so partial resistance is cheap and full
      // resistance is not. At maximum it adds 0.030 against a 0.09 baseline.
      toxinResistMaintCoeffQ: 123, // 0.030
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
      softSeparationStrengthQ: 1024, // 0.25 of the overlap per tick
    },

    health: {
      starvationDamageQPerTick: 8,
      severeThermalMaxDamageQPerTick: 20,
      passiveHealingQPerTick: 2,
      passiveHealingMinEnergyFractionQ: 2867, // 0.70
      passiveHealingEnergyBaseCost: 8,
      passiveHealingEnergyMassCoeffQ: 41, // 0.01
      severeThermalBasalMultiplierMaxQ: 12288, // 3.0
      thermalStressMinToleranceCentiC: 100, // 1 °C floor for the stress divisor
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
      // Calibrated 20 → 48 (ADR 0025 §2c). Meat persistence was measured
      // head-to-head against a bigger carcass store and against 2x this rot
      // rate on the decisive seeds at 25 000 ticks: a 16 384 store lets the
      // natural 13-16k carrion stock feed runaway booms into the organism
      // cap, decay 96 intensifies the scavenging race enough to do the same,
      // and 48 is the measured optimum — zero cap refusals, peaks under the
      // cap, scavenging intact. The 4 096 store deliberately stays: during
      // mass-death episodes the deterministic skip is an overflow valve, and
      // removing it was measured to destabilize the population gate.
      baseCarcassDecayFractionQPerDecayStep: 48, // ~0.0117
      hotDecayBonusMaxQ: 4096, // 1.0
      // The world's temperature field runs roughly -15 °C … +35 °C (docs/03
      // §17), so rot is free at freezing and doubles at the hot end of the map.
      hotDecayMinTemperatureCentiC: 0, // 0 °C
      hotDecayFullBonusTemperatureCentiC: 3500, // 35 °C
    },
  },

  senses: {
    crowdingRadiusLU: 24, // ~5 adult body diameters
    crowdingSaturationCount: 8,
    terrainProbeDistanceLU: 12, // under one environment cell (16 LU) ahead
    terrainForwardProbeSamples: 2,
    oscillatorPeriodTicks: 64,
    internalNoiseAmplitudeQ: 512, // 0.125 of the signal is stateless noise
  },

  brain: {
    inputCount: 32,
    hiddenCount: 12,
    outputCount: 5,
    weightCount: 604, // 20*12 + 12*5 + 20*5
    valueScale: 4096,
    weightScale: 4096,
    weightMin: -8192,
    weightMax: 8192,
    // M16, recalibrated against measurement (ADR 0030 §10). Reference points:
    // a newborn founder pays 10 energy/tick in basal upkeep and the adult mean
    // is 30.
    //
    // The unit that matters is not a connection but a *usable hidden unit*,
    // which arrives wired to 20 inputs, 5 outputs and itself — 26 connections.
    // The first calibration charged one whole energy per connection, so that
    // unit cost 26 + 3 + 2 = 31/tick: an adult's entire basal bill for one
    // neuron. Measured over 10 000 ticks of an ordinary world, the mean hidden
    // unit count was 0.002 — mutation switched them on and selection removed
    // them every time. A cost that forbids a trait is not a trade-off.
    //
    // Now: one usable hidden unit costs 0.75 + 0.40 + 26 x 0.03 = 1.93/tick,
    // about a fifth of a newborn's basal cost. The maximum brain — every unit,
    // every register, every wire — costs 32/tick, which roughly doubles an
    // adult's upkeep. That is the intended shape: a real bill that a lineage
    // can choose to pay, rather than one it cannot.
    //
    // Connections stay cheapest because a brain needs many; memory is dearest
    // per item because a register is the only thing here that persists between
    // ticks, and persistence is the capability being sold.
    complexity: {
      perSensoryChannelQ: 4096, // 1.00 — unreachable: the founder holds all 20
      perHiddenUnitQ: 3072, // 0.75
      perRecurrentLinkQ: 1638, // 0.40
      perMemoryRegisterQ: 4096, // 1.00
      perConnectionQ: 123, // 0.03
    },
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
      // docs/08 §17 omits this; 6x the small sigma matches the ratio the
      // ecological block does specify (614/102), which puts a large jump at
      // ~0.36 weight units against founder skip weights of 0.10 … 1.80 —
      // disruptive but not destructive (ADR 0006 §3).
      weightLargeSigmaQ: 1476, // 0.36 weight units
    },
    // M14. Per-locus probabilities match the ecological block: a body has more
    // loci than the ecological genome, so matching the rate makes a birth
    // change slightly more about the body than about the ecology, which is
    // what makes morphological drift visible within a few hundred generations
    // without destabilizing anything the ecological genome decides.
    //
    // The large sigma is smaller than the ecological one (0.12 against 0.15):
    // a large ecological jump changes one number, a large morphological jump
    // changes a silhouette, and the same normalized step reads as a much
    // bigger event.
    morphology: {
      perGeneMutationProbabilityQ: 328, // 0.08
      smallSigmaQ: 102, // 0.025
      largeMutationProbabilityQ: 20, // ~0.0049
      largeSigmaQ: 492, // 0.12
      resetProbabilityQ: 1, // ~0.00024
      // Per structural locus, so ~1 birth in 100 changes a segment or an
      // appendage pair by exactly one. Rare enough that a body plan is a
      // lineage property, common enough to be reachable.
      structuralProbabilityQ: 41, // 0.01
    },
    // M16. One birth in twenty changes the network's shape, and when it does it
    // moves at most four bits out of 624. Rare enough that a topology is a
    // lineage property rather than per-organism noise; common enough that a
    // hidden unit or a memory register is reachable inside a few hundred
    // generations, which M15 measured as the timescale selection works on.
    topology: {
      structuralProbabilityQ: 205, // 0.05
      maxFlipsPerBirth: 4,
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
    attackSizeFactorFloorQ: 2048, // 0.50 at the smallest body, 1.00 at the largest
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
    // Cadence lives in time.speciesAnalysisInterval (single source of truth).
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

  interventions: {
    maxBrushSamplesPerCommand: 64,
    brushSampleSpacingLU: 8,
    minBrushRadiusLU: 4,
    maxBrushRadiusLU: 128,
    maxTemperatureBrushStrengthCentiC: 400, // ±4.00 °C per application
    maxMoistureBrushStrengthQ: 512, // ±0.125 per application
    maxFertilityBrushStrengthQ: 512, // ±0.125 per application
    maxTerrainBrushStrengthQ: 256, // ~0.0625 elevation per application
    maxBiomassBrushStrengthUnits: 4000,
    maxLocalTemperatureOffsetCentiC: 4000, // saturates at ±40 °C
    maxGlobalTemperatureOffsetCentiC: 2000, // ±20 °C
    biomassOverfillLimitQ: 8192, // 2.0 × capacity (docs/03 §27 transient overfill)
    meteor: {
      minRadiusLU: 24,
      maxRadiusLU: 256,
      damageQ: 8192, // 2.0 health bars at the centre: lethal within the inner half-radius
      biomassLossQ: 4096, // all plants at the centre
      depressionQ: 450, // ~0.11 elevation drop: lowlands flood, mountains crater
      fertilityDeltaQ: -614, // ~-0.15: scorched soil at the centre
    },
  },

  limits: {
    maxOrganisms: 8192,
    maxCarcasses: 4096,
    recentDeadHistorySize: 2048,
    maxTimelineEventsInMemoryBeforeChunk: 4096,
  },
};

/**
 * The shipped default configuration, deeply frozen.
 *
 * It is exposed as a deeply readonly value so that no consumer can mutate the
 * shared default in place. Build a variant with `cloneConfig(DEFAULT_CONFIG)`
 * and modify the copy.
 */
export const DEFAULT_CONFIG: ReadonlySimulationConfig = deepFreezeJson(DEFAULT_CONFIG_SOURCE);
