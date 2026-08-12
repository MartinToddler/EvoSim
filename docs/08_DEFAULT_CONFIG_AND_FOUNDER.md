# 08 — Default Configuration v0.1 and Founder Controller

This file removes ambiguity for first implementation.

**Important:** these are implementation defaults for calibration, not biological claims. Put them in versioned `DEFAULT_CONFIG`; never scatter them as literals.

## 1. Fixed scales

```ts
const Q = 4096;
const POS_SCALE = 256;
const ANGLE_STEPS = 4096;
const TRIG_SCALE = 32767;
```

## 2. WorldConfig v0.1

```ts
{
  sizeLU: 4096,
  envGridSize: 256,
  envCellSizeLU: 16,
  spatialCellSizeLU: 32,

  seaLevelQ: 1884,        // ~0.46 Q
  mountainLevelQ: 3195,   // ~0.78 Q
  minLandFractionQ: 1434, // 0.35
  maxLandFractionQ: 2867, // 0.70
  generationMaxRetries: 16,

  initialOrganisms: 256,
  founderSpawnRadiusLU: 120
}
```

## 3. TimeConfig

> **Amended by `docs/adr/0002-milestone-1-hardening.md` §4 (engine 0.1.1).** `SimulationConfig.time`
> keeps only the four authoritative phase cadences (`environmentInterval`, `carcassDecayInterval`,
> `statisticsInterval`, `speciesAnalysisInterval`). The wall-clock values below —
> `targetTicksPerSecond1x`, `normalRenderSnapshotsPerSecond`, `maxModeRenderSnapshotsPerSecond`,
> `maxWorkerSliceMs` — plus `autosaveCheckInterval` and `ticksPerSimYear` now live in
> `HostRuntimeConfig` (`@eon/protocol`). This implements the sentence directly below this block:
> because the authoritative config is hashed into the world state hash, leaving hosting values in
> it made a render-rate change alter world identity. The values themselves are unchanged.

```ts
{
  targetTicksPerSecond1x: 20,
  ticksPerSimYear: 2000,
  environmentInterval: 20,
  carcassDecayInterval: 20,
  statisticsInterval: 100,
  speciesAnalysisInterval: 400,
  autosaveCheckInterval: 2000,
  normalRenderSnapshotsPerSecond: 15,
  maxModeRenderSnapshotsPerSecond: 5,
  maxWorkerSliceMs: 10
}
```

Wall-clock values affect hosting/render frequency only. They never enter authoritative calculations.

## 4. Limits

> **Amended by ADR 0002 §4 (engine 0.1.1).** `maxDetailedRenderedOrganisms` is a screen-space LOD
> budget and moved to `HostRuntimeConfig`. `maxOrganisms`, `maxCarcasses`, `recentDeadHistorySize`
> and `maxTimelineEventsInMemoryBeforeChunk` stay authoritative: caps change outcomes when reached,
> and the buffer bounds govern engine-owned state.

```ts
{
  maxOrganisms: 8192,
  maxCarcasses: 4096,
  maxDetailedRenderedOrganisms: 250,
  recentDeadHistorySize: 2048,
  maxTimelineEventsInMemoryBeforeChunk: 4096
}
```

## 5. Biome plant defaults

Base capacities:

```ts
Water: 0
Grassland: 36000
Forest: 52000
Desert: 7000
Tundra: 10000
Mountain: 4000
```

Growth rate Q per environment update:

```ts
Grassland: 49  // .01196
Forest: 37     // .00903
Desert: 12     // .00293
Tundra: 12
Mountain: 6    // .00146
```

Additional:

```ts
plantSeedBankRegenUnits: 4
plantMinRegenThreshold: 16
plantEnergyPerBiomass: 30
meatEnergyPerUnit: 45
```

Final plant capacity must multiply base by moisture/fertility/temperature suitability.

## 6. Biome thresholds

```ts
{
  tundraTemperatureCentiC: -300,
  desertMaxMoistureQ: 1024, // .25
  desertMinTemperatureCentiC: 1800,
  forestMinMoistureQ: 2540, // .62
  forestMinFertilityQ: 2253 // .55
}
```

## 7. Gene ranges

All ecological genes stored `0..65535`, except mapped signed diet.

Implementation helper converts to `geneQ 0..4096`.

### Adult radius

```text
1.25 .. 4.50 LU, nonlinear exponent target 1.35
```

If first implementation avoids power LUT, use piecewise/LUT sampled at 256 entries.

### Speed

```text
0.035 .. 0.30 LU/tick, nonlinear exponent target 1.25
```

### Acceleration

```text
0.0015 .. 0.025 LU/tick²
```

### Turn

```text
0.5° .. 14° / tick before size penalty
```

### Vision range

```text
10 .. 96 LU, exponent target 1.4
```

### FOV

```text
35° .. 270°
```

### Diet

```text
-4096 .. +4096
```

### Metabolic pace

```text
0.65 .. 1.45
```

### Thermal optimum

```text
-10.00°C .. +35.00°C
```

### Tolerance

```text
3.00°C .. 24.00°C
```

### Maturity

```text
400 .. 2200 ticks
```

### Max age

```text
2200 .. 10000 ticks
```

### Offspring investment

```text
0.08 .. 0.35 parent max energy
```

## 8. Body/energy defaults

Use deterministic integer derivation.

```ts
{
  massScalePerRadiusSquared: 100,
  baseMaxEnergy: 1000,
  maxEnergyPerMass: 120,

  birthSizeFractionQ: 1843, // .45
  reproductionMinDevelopmentQ: 3686, // .90
  initialEnergyFractionQ: 2867, // .70

  energyPerGrowthMass: 35
}
```

### Suggested maxEnergy

```text
maxEnergy = baseMaxEnergy + currentMass * maxEnergyPerMass
```

## 9. Basal cost coefficients

Represent rates in suitably scaled integer config; semantic target below is in conceptual energy/tick.

```text
base mass maintenance = mass * pace * 0.060
muscle capacity       = mass * speedNorm² * 0.020
vision                = 30 * rangeNorm² * fovNorm
attack maintenance    = mass * attack² * 0.010
armor maintenance     = mass * armor² * 0.015
tolerance maintenance = mass * toleranceNorm * 0.005
longevity maintenance = mass * maxAgeNorm * 0.003
```

Rounding policy: calculate in scaled integer and round/floor consistently. Minimum basal total at least 1 energy/tick for living organism.

These coefficients must be tuned by sweep, but implement exactly before tuning.

## 10. Movement cost

Concept target:

```text
movement = mass * speedFraction² * 0.10
acceleration surcharge = mass * accelFraction² * 0.01
```

Water:

```ts
waterSpeedMultiplierQ: 1024, // .25
waterMovementCostMultiplierQ: 16384, // 4.0 Q representation if multiplier supports >Q
waterGraceTicks: 20,
waterHealthDamageQPerTick: 12
```

Use wider integer type/config for multipliers >1.

## 11. Armor/speed and size/turn

```ts
armorMaxSpeedPenaltyQ: 1434, // .35
sizeMaxTurnPenaltyQ: 1024,   // .25
maxArmorDamageReductionQ: 2662 // .65
```

## 12. Feeding

Suggested maximum biomass claim per tick:

```text
bite = 2 + mass * 0.015 * metabolicPace
```

Clamp to reasonable config maximum such as 64 biomass/tick.

```ts
maxPlantBiteUnits: 64,
maxMeatBiteUnits: 64,
eatOutputThresholdQ: 2253 // .55
```

Diet efficiencies:

```text
affinity in 0..1
efficiency = .20 + .80 * affinity²
```

## 13. Thermal/starvation/health

Health uses 0..4096.

```ts
{
  starvationDamageQPerTick: 8,
  severeThermalMaxDamageQPerTick: 20,
  passiveHealingQPerTick: 2,
  passiveHealingMinEnergyFractionQ: 2867, // .70
  passiveHealingEnergyBaseCost: 8,
  passiveHealingEnergyMassCoeff: 0.01
}
```

Thermal basal multiplier should rise from 1× outside tolerance toward max about 3× under severe stress.

## 14. Combat

```ts
{
  attackOutputThresholdQ: 2662, // .65
  baseAttackDamageQ: 320,
  attackCooldownTicks: 5,
  baseAttackEnergyCost: 25,
  attackEnergyMassCoeff: 0.03,
  maxImpactDamageBonusQ: 1229, // +.30
  maxArmorDamageReductionQ: 2662 // .65
}
```

Suggested damage:

```text
sizeFactor = 0.5 + 0.5*attackerSizeNorm
impactBonus = 1 + 0.30*currentSpeedFraction
raw = baseDamage * attack * sizeFactor * impactBonus
final = raw * (1 - 0.65*targetArmor)
```

All fixed/integer in authoritative code.

## 15. Carcass

```ts
{
  meatPerMass: 3,
  remainingEnergyToMeatMaxFractionQ: 1024, // .25
  baseCarcassDecayFractionQPerDecayStep: 20, // ~.0049
  hotDecayBonusMaxQ: 4096
}
```

Keep first decay model simple, monotonic, deterministic.

## 16. Reproduction

```ts
{
  reproduceOutputThresholdQ: 2662, // .65
  minParentReserveFractionQ: 819,  // .20
  reproductionCooldownTicks: 40,
  childSpawnDistanceMinLU: 2,
  childSpawnDistanceMaxLU: 8
}
```

If child spawn would land in water/invalid terrain, try exactly 8 deterministic angle candidates, then place at parent position if none valid.

## 17. Mutation v0.1

Ecological genes:

```ts
{
  perGeneMutationProbabilityQ: 328, // .08
  smallSigmaQ: 102,                 // .025 normalized
  largeMutationProbabilityQ: 20,    // .0049
  largeSigmaQ: 614,                 // .15
  resetProbabilityQ: 1              // ~.00024
}
```

Brain weights:

```ts
{
  perWeightMutationProbabilityQ: 82, // .02
  weightSmallSigmaQ: 246,             // .06
  largeWeightMutationProbabilityQ: 4  // ~.001
}
```

Weight clamp ±8192.

Mutation probability comparison must use project PRNG integer draws, not floats.

## 18. Brain format v0.1

Inputs 20, hidden 12, outputs 5, skip connections. Total 400 weights.

### Input semantics

All values within `[-Q,Q]`; some inherently 0..Q.

```text
0  bias: +Q
1  energyState: -Q empty, +Q full
2  healthState: -Q dead-ish, +Q full
3  developmentState: -Q newborn, +Q mature/developed
4  localPlant: -Q empty, +Q saturated
5  plantGradientForward: -Q..+Q
6  plantGradientLateral: negative=left, positive=right food advantage
7  carcassProximity: -Q absent/far, +Q contact
8  carcassForward: -Q..+Q; 0 when absent
9  carcassLateral: negative=left, positive=right; 0 absent
10 creatureProximity: -Q absent/far, +Q contact
11 creatureForward: -Q behind, +Q ahead; 0 absent
12 creatureLateral: negative=left, positive=right; 0 absent
13 creatureRelativeSize: -Q much smaller, +Q much larger
14 creatureHueDifference: normalized signed circular difference
15 thermalComfort: +Q comfortable, -Q severe stress
16 crowding: -Q isolated, +Q crowded
17 terrainDangerForward: 0 safe, +Q dangerous/water ahead
18 terrainDangerLateral: positive = more danger on LEFT than RIGHT; negative inverse
19 internalSignal: deterministic oscillator/noise -Q..+Q
```

Turn convention:

```text
negative output = turn left / counter-clockwise
positive output = turn right / clockwise
```

Plant lateral positive therefore means food is more right; positive turn follows it.

Terrain lateral positive means more danger left; positive/right turn avoids it.

### Activation

Hard tanh `clamp(sum/scale, -Q,Q)`.

Positive-action output conversion `(raw+Q)/2`.

## 19. Founder ecological genes

Start deliberately middle-of-road and herbivore leaning.

Normalized 0..Q targets:

```ts
adultSize:          1843 // .45
maxSpeed:           2048 // .50
acceleration:       2048
turnRate:           2253 // .55
visionRange:        2048
visionFov:          2048
dietSigned:        -2458 // -.60 herbivore
attackPower:         410 // .10
armor:               614 // .15
metabolicPace:      2048
thermalOptimum:     // choose based on spawn region or fixed midpoint; prefer fixed +18°C initially
thermalTolerance:   2048
maturityAge:        1638 // .40 of gene range => relatively early
maxAge:             2048
offspringInvestment:1843 // .45 of gene normalized range
hue:                // e.g. green 120°
```

Important: thermal optimum should be explicit. Recommended founder optimum = +18°C encoded through mapping, not dynamically matched to spawn. This permits immediate thermal selection across geography.

## 20. Founder neural controller

Initialize hidden weights to 0 (or tiny deterministic values after calibration). Use direct input->output skip weights to create viable reflexes.

Weights are in conceptual real units, converted by `*4096` and clamped.

### Throttle raw

```text
+0.30 * bias
-0.40 * energyState
+0.20 * plantGradientForward
-0.50 * terrainDangerForward
```

This keeps moderate movement, increases motion while hungry, slightly follows forward food and slows before danger.

### Turn raw

```text
+1.50 * plantGradientLateral
+1.80 * terrainDangerLateral
+0.25 * internalSignal
```

### Eat raw

```text
+0.10 * bias
+1.20 * localPlant
+0.40 * carcassProximity
```

Because founder is herbivore-biased, meat gives low energy even if it occasionally attempts to eat a carcass.

### Attack raw

```text
-0.85 * bias
+0.10 * recent/creature terms if later added
```

With current inputs use simply `-0.85 * bias` in v0.1, making attack uncommon until mutation.

### Reproduce raw

```text
-0.20 * bias
+1.30 * energyState
+0.90 * developmentState
```

Actual reproduction still requires hard engine maturity/energy rules.

### Hidden layer

Hidden weights zero in first founder fixture; mutation can activate pathways.

If this makes evolution too slow, calibrate a small seeded hidden weight variance and version/hash fixture.

## 21. Founder fixture rule

Store exact encoded founder genome/400 weights in test fixture or deterministic factory with golden hash.

Changing founder values changes evolutionary history and therefore requires engine/config version consideration.

## 22. Species defaults

> **Amended by ADR 0002 §4 (engine 0.1.1).** `analysisIntervalTicks` was removed: it duplicated
> `time.speciesAnalysisInterval` (same value, same meaning), and two independently settable fields
> that must always agree are a determinism hazard. `SimulationConfig.time` is the single source of
> truth for every phase cadence.

```ts
{
  minDaughterPopulation: 20,
  analysisIntervalTicks: 400,
  kMeansIterations: 6,
  stabilityIntervals: 5,
  splitDistanceThresholdQ: 901, // ~.22 normalized RMS target
  candidateCentroidContinuityThresholdQ: 328 // ~.08
}
```

Actual distance scale depends on implementation; write synthetic tests before calibrating threshold.

## 23. Event defaults

```ts
{
  massExtinctionMinStartingSpecies: 8,
  massExtinctionFractionQ: 1638, // .40
  carnivoreObservedMeatFractionQ: 2458, // .60
  carnivoreMinPopulation: 10,
  populationBoomFractionQ: 3072, // +.75 relative
  populationCrashFractionQ: 2048, // -.50 relative
  eventCooldownStatsSamples: 10
}
```

## 24. Calibration invariant

First code must implement these defaults faithfully.

Then tune through named config commits/experiments. Never “fix” extinction by hidden conditional bonuses such as:

```ts
if (population < 50) giveFreeEnergy(); // forbidden
```

Use general rule tuning instead.
