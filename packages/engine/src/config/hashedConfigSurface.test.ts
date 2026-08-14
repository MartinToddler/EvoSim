import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaultConfig";

/**
 * Frozen inventory of every field that enters the authoritative config digest,
 * and through it the canonical world state hash (hashState.ts).
 *
 * This is a tripwire, not documentation. Adding a field to SimulationConfig is
 * a deliberate act with consequences: it changes every world hash and requires
 * an ENGINE_VERSION bump plus regenerated goldens. Adding a *host-flavoured*
 * field (a rate in Hz, a millisecond budget, a render or storage limit) is
 * worse — it would make world identity depend on how the simulation happened to
 * be hosted, which is the defect that split HostRuntimeConfig out in the first
 * place (ADR 0002 §4).
 *
 * If this test fails, do not just paste the new list in. Ask first whether the
 * field belongs in SimulationConfig at all, or in HostRuntimeConfig
 * (@eon/protocol).
 */
const HASHED_CONFIG_LEAF_PATHS: readonly string[] = [
  "brain.hiddenCount",
  "brain.inputCount",
  "brain.outputCount",
  "brain.valueScale",
  "brain.weightCount",
  "brain.weightMax",
  "brain.weightMin",
  "brain.weightScale",
  "combat.attackCooldownTicks",
  "combat.attackEnergyMassCoeffQ",
  "combat.attackOutputThresholdQ",
  "combat.attackSizeFactorFloorQ",
  "combat.baseAttackDamageQ",
  "combat.baseAttackEnergyCost",
  "combat.maxArmorDamageReductionQ",
  "combat.maxImpactDamageBonusQ",
  "history.carnivoreMinPopulation",
  "history.carnivoreObservedMeatFractionQ",
  "history.eventCooldownStatsSamples",
  "history.massExtinctionFractionQ",
  "history.massExtinctionMinStartingSpecies",
  "history.populationBoomFractionQ",
  "history.populationCrashFractionQ",
  // Milestone 9 (ADR 0015): intervention bounds and effect scales are
  // authoritative on purpose — they bound what a command may carry and scale
  // what an applied command does, so two configs differing here produce
  // different worlds from the first accepted command onward.
  "interventions.biomassOverfillLimitQ",
  "interventions.brushSampleSpacingLU",
  "interventions.maxBiomassBrushStrengthUnits",
  "interventions.maxBrushRadiusLU",
  "interventions.maxBrushSamplesPerCommand",
  "interventions.maxFertilityBrushStrengthQ",
  "interventions.maxGlobalTemperatureOffsetCentiC",
  "interventions.maxLocalTemperatureOffsetCentiC",
  "interventions.maxMoistureBrushStrengthQ",
  "interventions.maxTemperatureBrushStrengthCentiC",
  "interventions.maxTerrainBrushStrengthQ",
  "interventions.meteor.biomassLossQ",
  "interventions.meteor.damageQ",
  "interventions.meteor.depressionQ",
  "interventions.meteor.fertilityDeltaQ",
  "interventions.meteor.maxRadiusLU",
  "interventions.meteor.minRadiusLU",
  "interventions.minBrushRadiusLU",
  "limits.maxCarcasses",
  "limits.maxOrganisms",
  "limits.maxTimelineEventsInMemoryBeforeChunk",
  "limits.recentDeadHistorySize",
  "mutation.brain.largeWeightMutationProbabilityQ",
  "mutation.brain.perWeightMutationProbabilityQ",
  "mutation.brain.weightLargeSigmaQ",
  "mutation.brain.weightSmallSigmaQ",
  "mutation.ecological.largeMutationProbabilityQ",
  "mutation.ecological.largeSigmaQ",
  "mutation.ecological.perGeneMutationProbabilityQ",
  "mutation.ecological.resetProbabilityQ",
  "mutation.ecological.smallSigmaQ",
  "organism.basal.armorMaintCoeffQ",
  "organism.basal.attackMaintCoeffQ",
  "organism.basal.baseMassPaceCoeffQ",
  "organism.basal.longevityMaintCoeffQ",
  "organism.basal.minimumBasalPerTick",
  "organism.basal.muscleCapacityCoeffQ",
  "organism.basal.toleranceMaintCoeffQ",
  "organism.basal.visionBaseCost",
  "organism.baseMaxEnergy",
  "organism.birthSizeFractionQ",
  "organism.carcass.baseCarcassDecayFractionQPerDecayStep",
  "organism.carcass.hotDecayBonusMaxQ",
  "organism.carcass.hotDecayFullBonusTemperatureCentiC",
  "organism.carcass.hotDecayMinTemperatureCentiC",
  "organism.carcass.meatPerMass",
  "organism.carcass.remainingEnergyToMeatMaxFractionQ",
  "organism.energyPerGrowthMass",
  "organism.feeding.biteBaseUnits",
  "organism.feeding.biteMassCoeffQ",
  "organism.feeding.digestionEfficiencyFloorQ",
  "organism.feeding.digestionEfficiencySpanQ",
  "organism.feeding.eatOutputThresholdQ",
  "organism.feeding.maxMeatBiteUnits",
  "organism.feeding.maxPlantBiteUnits",
  "organism.geneRanges.accelerationMaxVel",
  "organism.geneRanges.accelerationMinVel",
  "organism.geneRanges.adultRadiusExponentQ",
  "organism.geneRanges.adultRadiusMaxPos",
  "organism.geneRanges.adultRadiusMinPos",
  "organism.geneRanges.maturityAgeMaxTicks",
  "organism.geneRanges.maturityAgeMinTicks",
  "organism.geneRanges.maxAgeMaxTicks",
  "organism.geneRanges.maxAgeMinTicks",
  "organism.geneRanges.maxSpeedExponentQ",
  "organism.geneRanges.maxSpeedMaxVel",
  "organism.geneRanges.maxSpeedMinVel",
  "organism.geneRanges.maxTurnMaxSteps",
  "organism.geneRanges.maxTurnMinSteps",
  "organism.geneRanges.metabolicPaceMaxQ",
  "organism.geneRanges.metabolicPaceMinQ",
  "organism.geneRanges.offspringInvestmentMaxQ",
  "organism.geneRanges.offspringInvestmentMinQ",
  "organism.geneRanges.thermalOptimumMaxCentiC",
  "organism.geneRanges.thermalOptimumMinCentiC",
  "organism.geneRanges.thermalToleranceMaxCentiC",
  "organism.geneRanges.thermalToleranceMinCentiC",
  "organism.geneRanges.visionFovMaxSteps",
  "organism.geneRanges.visionFovMinSteps",
  "organism.geneRanges.visionRangeExponentQ",
  "organism.geneRanges.visionRangeMaxPos",
  "organism.geneRanges.visionRangeMinPos",
  "organism.health.passiveHealingEnergyBaseCost",
  "organism.health.passiveHealingEnergyMassCoeffQ",
  "organism.health.passiveHealingMinEnergyFractionQ",
  "organism.health.passiveHealingQPerTick",
  "organism.health.severeThermalBasalMultiplierMaxQ",
  "organism.health.severeThermalMaxDamageQPerTick",
  "organism.health.starvationDamageQPerTick",
  "organism.health.thermalStressMinToleranceCentiC",
  "organism.initialEnergyFractionQ",
  "organism.massScalePerRadiusSquared",
  "organism.maxEnergyPerMass",
  "organism.movement.accelerationCostCoeffQ",
  "organism.movement.armorMaxSpeedPenaltyQ",
  "organism.movement.movementCostCoeffQ",
  "organism.movement.sizeMaxTurnPenaltyQ",
  "organism.movement.softSeparationStrengthQ",
  "organism.movement.waterGraceTicks",
  "organism.movement.waterHealthDamageQPerTick",
  "organism.movement.waterMovementCostMultiplierQ",
  "organism.movement.waterSpeedMultiplierQ",
  "organism.reproductionMinDevelopmentQ",
  "plants.baseCapacityByBiome[]",
  "plants.capacitySuitability.fullMoistureQ",
  "plants.capacitySuitability.minMoistureQ",
  "plants.capacitySuitability.optimumTemperatureCentiC",
  "plants.capacitySuitability.temperatureToleranceCentiC",
  "plants.growthRateQByBiome[]",
  "plants.initialBiomassFractionQ",
  "plants.meatEnergyPerUnit",
  "plants.plantEnergyPerBiomass",
  "plants.plantMinRegenThreshold",
  "plants.plantSeedBankRegenUnits",
  "reproduction.childSpawnDistanceMaxLU",
  "reproduction.childSpawnDistanceMinLU",
  "reproduction.minParentReserveFractionQ",
  "reproduction.reproduceOutputThresholdQ",
  "reproduction.reproductionCooldownTicks",
  "reproduction.spawnAngleCandidates",
  "schemaVersion",
  "senses.crowdingRadiusLU",
  "senses.crowdingSaturationCount",
  "senses.internalNoiseAmplitudeQ",
  "senses.oscillatorPeriodTicks",
  "senses.terrainForwardProbeSamples",
  "senses.terrainProbeDistanceLU",
  "species.candidateCentroidContinuityThresholdQ",
  "species.kMeansIterations",
  "species.minDaughterPopulation",
  "species.splitDistanceThresholdQ",
  "species.stabilityIntervals",
  "time.carcassDecayInterval",
  "time.environmentInterval",
  "time.speciesAnalysisInterval",
  "time.statisticsInterval",
  "world.biomeThresholds.desertMaxMoistureQ",
  "world.biomeThresholds.desertMinTemperatureCentiC",
  "world.biomeThresholds.forestMinFertilityQ",
  "world.biomeThresholds.forestMinMoistureQ",
  "world.biomeThresholds.tundraTemperatureCentiC",
  "world.climate.elevationCoolingCentiC",
  "world.climate.equatorTemperatureCentiC",
  "world.climate.poleTemperatureDropCentiC",
  "world.climate.temperatureNoiseAmplitudeCentiC",
  "world.envCellSizeLU",
  "world.envGridSize",
  "world.fertility.lowlandWeightQ",
  "world.fertility.moistureWeightQ",
  "world.fertility.noiseWeightQ",
  "world.fertility.optimumTemperatureCentiC",
  "world.fertility.temperatureWeightQ",
  "world.fertility.toleranceCentiC",
  "world.founderSpawnRadiusLU",
  "world.generation.edgeFalloffCells",
  "world.generation.elevationOctaves[]",
  "world.generation.fertilityWavelengthCells",
  "world.generation.moistureWavelengthCells",
  "world.generation.temperatureWavelengthCells",
  "world.generation.waterInfluencePasses",
  "world.generationMaxRetries",
  "world.initialOrganisms",
  "world.maxLandFractionQ",
  "world.minLandFractionQ",
  "world.moisture.inverseElevationWeightQ",
  "world.moisture.noiseWeightQ",
  "world.moisture.waterInfluenceWeightQ",
  "world.mountainLevelQ",
  "world.seaLevelQ",
  "world.sizeLU",
  "world.spatialCellSizeLU",
  "world.validity.minBiomeClasses",
  "world.validity.minFounderRegionCells",
  "world.validity.minTotalPlantCapacity",
];

/** Wall-clock, render and storage vocabulary that must never appear in a path. */
const HOST_FLAVOURED_TOKENS = [
  "PerSecond",
  "Ms",
  "Hz",
  "Fps",
  "Render",
  "Autosave",
  "Wall",
  "Frame",
];

function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return [`${prefix}[]`];
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).flatMap((key) =>
      leafPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe("hashed authoritative config surface", () => {
  it("matches the frozen inventory of hashed fields", () => {
    expect(leafPaths(DEFAULT_CONFIG).sort()).toEqual([...HASHED_CONFIG_LEAF_PATHS]);
  });

  it("contains no wall-clock, render or storage vocabulary", () => {
    const offenders = HASHED_CONFIG_LEAF_PATHS.filter((path) =>
      HOST_FLAVOURED_TOKENS.some((token) => path.includes(token)),
    );
    expect(offenders).toEqual([]);
  });
});
