import { BRAIN_INPUT_COUNT } from "../brain/BrainLayout";
import { engineInternals } from "../internal";
import { ANGLE_STEPS, POS_SCALE, Q, qmul } from "../math/fixed";
import { basalCost, thermalBasalMultiplierQ } from "../organisms/metabolism";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";
import { thermalStressQ } from "../organisms/thermal";
import type { SimulationEngine } from "../SimulationEngine";
import { BIOME_NAMES } from "../world/biomes";
import { speedLUPerTick } from "./renderSnapshot";

/**
 * On-demand inspection of one organism (task G09, docs/02 §11, docs/06 §11).
 *
 * ## Why this is a query and not a stream
 *
 * The inspector needs about thirty numbers for *one* organism. Streaming them
 * for all 8192 would be two orders of magnitude more data than the entire
 * render snapshot, for information nobody is looking at. So selection asks, and
 * the engine answers once per request.
 *
 * ## Read-only by construction
 *
 * Every field below is read or derived; nothing is written. Querying a dead or
 * never-existing entity returns `null` rather than throwing, because that is
 * not an error condition: the main thread selects from a render snapshot that
 * is at least one tick old, so "the organism you clicked has since died" is an
 * ordinary outcome of a live simulation, not a bug to crash on.
 *
 * ## Units are human, not authoritative
 *
 * Location units, radians, degrees Celsius, fractions in [0, 1]. The caller is
 * a UI; giving it Q-scaled integers would just move the conversion somewhere
 * with less context about what the numbers mean.
 */

export interface EntityDetails {
  entityId: number;
  speciesId: number;
  generation: number;
  parentEntityId: number;
  ageTicks: number;

  xLU: number;
  yLU: number;
  headingRadians: number;
  speedLUPerTick: number;

  energy: number;
  maxEnergy: number;
  health: number;
  development: number;
  radiusLU: number;
  mass: number;

  diet: number;
  maxSpeedLUPerTick: number;
  visionRangeLU: number;
  visionFovDegrees: number;
  attack: number;
  armor: number;
  metabolicPace: number;
  thermalOptimumC: number;
  thermalToleranceC: number;
  maturityAgeTicks: number;
  maxAgeTicks: number;
  hueDegrees: number;
  reproductionCooldownTicks: number;

  costBasalPerTick: number;
  costMovementPerTick: number;
  thermalStress: number;

  brainInputs: readonly number[];
  brainIntents: readonly number[];

  plantEnergyEaten: number;
  meatEnergyEaten: number;
  kills: number;

  biome: number;
  biomeName: string;
  cellTemperatureC: number;
  cellPlantBiomass: number;
}

const DEGREES_PER_STEP = 360 / ANGLE_STEPS;
const RADIANS_PER_STEP = (Math.PI * 2) / ANGLE_STEPS;
/** Velocity units per location unit per tick; see movement.ts. */
const VELOCITY_UNITS_PER_LU = 256 * POS_SCALE;

/**
 * Details for one live organism, or `null` if that entity ID is not alive.
 *
 * The engine's state is not modified in any way by this call.
 */
export function queryEntity(engine: SimulationEngine, entityId: number): EntityDetails | null {
  const { context } = engineInternals(engine);
  const { organisms, phenotypes, environment, scratch, config } = context;

  const slot = organisms.findSlotByEntityId(entityId);
  if (slot < 0 || organisms.alive[slot] !== 1) {
    return null;
  }

  const developmentQ = organisms.developmentQ[slot] as number;
  const radiusPos = currentRadiusPos(phenotypes.adultRadiusPos[slot] as number, developmentQ);
  const mass = massFromRadiusPos(radiusPos, config.organism.massScalePerRadiusSquared);
  const xPos = organisms.x[slot] as number;
  const yPos = organisms.y[slot] as number;
  const cell = environment.cellIndexFromPosition(xPos, yPos);

  // --- Running costs (docs/06 §11), the same formulas metabolism will apply --
  //
  // Recomputed read-only from current state rather than stored: the physiology
  // phase has no reason to remember a per-organism breakdown 8192 organisms
  // wide for the one organism somebody is looking at. The movement term reads
  // the effort fractions the movement phase left in scratch, so it describes
  // the most recent tick, not a hypothetical.
  const { basal, movement, health } = config.organism;
  const stressQ = thermalStressQ(
    environment.getTemperatureCentiC(cell),
    phenotypes.thermalOptimumCentiC[slot] as number,
    phenotypes.thermalToleranceCentiC[slot] as number,
    health.thermalStressMinToleranceCentiC,
  );
  let costBasalPerTick = qmul(
    basalCost(context, slot, mass),
    thermalBasalMultiplierQ(stressQ, health.severeThermalBasalMultiplierMaxQ),
  );
  if (costBasalPerTick < basal.minimumBasalPerTick) {
    costBasalPerTick = basal.minimumBasalPerTick;
  }
  const speedFractionQ = scratch.speedFractionQ[slot] as number;
  const accelFractionQ = scratch.accelFractionQ[slot] as number;
  let costMovementPerTick = qmul(
    mass,
    qmul(qmul(speedFractionQ, speedFractionQ), movement.movementCostCoeffQ),
  );
  costMovementPerTick += qmul(
    mass,
    qmul(qmul(accelFractionQ, accelFractionQ), movement.accelerationCostCoeffQ),
  );
  if (scratch.inWater[slot] === 1) {
    costMovementPerTick = qmul(costMovementPerTick, movement.waterMovementCostMultiplierQ);
  }

  // --- Brain view (docs/06 §11): what the last tick sensed and decided -------
  //
  // Scratch retains each organism's sensor block and mapped intents after the
  // tick completes, so this is a read of what actually happened — nothing is
  // re-inferred, no PRNG is touched, and before the first tick it is honestly
  // all zeroes.
  const brainInputs: number[] = new Array<number>(BRAIN_INPUT_COUNT);
  const sensorBase = slot * BRAIN_INPUT_COUNT;
  for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
    brainInputs[i] = (scratch.sensorValues[sensorBase + i] as number) / Q;
  }
  // Indexed like BRAIN_OUTPUT_NAMES: throttle, turn, eat, attack, reproduce.
  const brainIntents: number[] = [
    (scratch.throttleQ[slot] as number) / Q,
    (scratch.turnQ[slot] as number) / Q,
    (scratch.eatQ[slot] as number) / Q,
    (scratch.attackQ[slot] as number) / Q,
    (scratch.reproduceQ[slot] as number) / Q,
  ];

  return {
    entityId,
    speciesId: organisms.speciesId[slot] as number,
    generation: organisms.generation[slot] as number,
    parentEntityId: organisms.parentEntityId[slot] as number,
    ageTicks: organisms.ageTicks[slot] as number,

    xLU: xPos / POS_SCALE,
    yLU: yPos / POS_SCALE,
    headingRadians: (organisms.angle[slot] as number) * RADIANS_PER_STEP,
    speedLUPerTick: speedLUPerTick(organisms.vx[slot] as number, organisms.vy[slot] as number),

    energy: organisms.energy[slot] as number,
    maxEnergy: maxEnergyForMass(mass, config),
    health: (organisms.healthQ[slot] as number) / Q,
    development: developmentQ / Q,
    radiusLU: radiusPos / POS_SCALE,
    mass,

    diet: (phenotypes.dietQ[slot] as number) / Q,
    maxSpeedLUPerTick: (phenotypes.maxSpeedVel[slot] as number) / VELOCITY_UNITS_PER_LU,
    visionRangeLU: (phenotypes.visionRangePos[slot] as number) / POS_SCALE,
    // The store caches HALF the field of view, because that is what the
    // visibility test compares against; a human reads the full cone.
    visionFovDegrees: (phenotypes.visionHalfFovSteps[slot] as number) * 2 * DEGREES_PER_STEP,
    attack: (phenotypes.attackQ[slot] as number) / Q,
    armor: (phenotypes.armorQ[slot] as number) / Q,
    metabolicPace: (phenotypes.metabolicPaceQ[slot] as number) / Q,
    thermalOptimumC: (phenotypes.thermalOptimumCentiC[slot] as number) / 100,
    thermalToleranceC: (phenotypes.thermalToleranceCentiC[slot] as number) / 100,
    maturityAgeTicks: phenotypes.maturityAgeTicks[slot] as number,
    maxAgeTicks: phenotypes.maxAgeTicks[slot] as number,
    hueDegrees: phenotypes.hueDegrees[slot] as number,
    reproductionCooldownTicks: organisms.reproductionCooldown[slot] as number,

    costBasalPerTick,
    costMovementPerTick,
    // The engine's stress scale runs 0..2Q (2Q = capped worst case, damage
    // begins at Q); normalized here so the DTO's [0, 1] means "fraction of the
    // worst case" and 0.5 is exactly the damage threshold.
    thermalStress: stressQ / (2 * Q),

    brainInputs,
    brainIntents,

    plantEnergyEaten: organisms.plantEnergyEaten[slot] as number,
    meatEnergyEaten: organisms.meatEnergyEaten[slot] as number,
    kills: organisms.kills[slot] as number,

    biome: environment.biome[cell] as number,
    biomeName: BIOME_NAMES[environment.biome[cell] as number] ?? "Unknown",
    cellTemperatureC: environment.getTemperatureCentiC(cell) / 100,
    cellPlantBiomass: environment.getPlantBiomass(cell),
  };
}

/** Mean trait values over the alive population; all zero when it is empty. */
export interface TraitMeans {
  diet: number;
  maxSpeedLUPerTick: number;
  adultRadiusLU: number;
  visionRangeLU: number;
  attack: number;
  armor: number;
  metabolicPace: number;
  thermalOptimumC: number;
}

/**
 * Cheap world-wide aggregates for the HUD and charts (docs/02 §11, docs/05 §10).
 *
 * One ascending pass over live slots. Called at telemetry cadence — a couple of
 * times per second — never per tick, and never per frame. The trait means are
 * what lets the Milestone 7 charts show evolutionary drift without ever
 * shipping a per-organism array off the Worker.
 */
export function collectTelemetryAggregates(engine: SimulationEngine): {
  population: number;
  maxGeneration: number;
  plantBiomass: number;
  plantCapacity: number;
  organismMass: number;
  meanEnergyFraction: number;
  traitMeans: TraitMeans;
} {
  const { context } = engineInternals(engine);
  const { organisms, phenotypes, environment, config } = context;
  const massScale = config.organism.massScalePerRadiusSquared;

  let maxGeneration = 0;
  let organismMass = 0;
  let energyFractionSum = 0;
  let dietSum = 0;
  let speedSum = 0;
  let radiusSum = 0;
  let visionSum = 0;
  let attackSum = 0;
  let armorSum = 0;
  let paceSum = 0;
  let thermalSum = 0;
  let alive = 0;

  const slotHighWater = organisms.slotHighWater;
  for (let slot = 0; slot < slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    alive += 1;
    const generation = organisms.generation[slot] as number;
    if (generation > maxGeneration) {
      maxGeneration = generation;
    }

    const radiusPos = currentRadiusPos(
      phenotypes.adultRadiusPos[slot] as number,
      organisms.developmentQ[slot] as number,
    );
    const mass = massFromRadiusPos(radiusPos, massScale);
    organismMass += mass;
    const maxEnergy = maxEnergyForMass(mass, config);
    if (maxEnergy > 0) {
      energyFractionSum += Math.min(1, (organisms.energy[slot] as number) / maxEnergy);
    }

    dietSum += phenotypes.dietQ[slot] as number;
    speedSum += phenotypes.maxSpeedVel[slot] as number;
    radiusSum += phenotypes.adultRadiusPos[slot] as number;
    visionSum += phenotypes.visionRangePos[slot] as number;
    attackSum += phenotypes.attackQ[slot] as number;
    armorSum += phenotypes.armorQ[slot] as number;
    paceSum += phenotypes.metabolicPaceQ[slot] as number;
    thermalSum += phenotypes.thermalOptimumCentiC[slot] as number;
  }

  let plantBiomass = 0;
  let plantCapacity = 0;
  const cellCount = environment.cellCount;
  for (let cell = 0; cell < cellCount; cell += 1) {
    plantBiomass += environment.plantBiomass[cell] as number;
    plantCapacity += environment.plantCapacity[cell] as number;
  }

  const traitMeans: TraitMeans =
    alive === 0
      ? {
          diet: 0,
          maxSpeedLUPerTick: 0,
          adultRadiusLU: 0,
          visionRangeLU: 0,
          attack: 0,
          armor: 0,
          metabolicPace: 0,
          thermalOptimumC: 0,
        }
      : {
          diet: dietSum / alive / Q,
          maxSpeedLUPerTick: speedSum / alive / VELOCITY_UNITS_PER_LU,
          adultRadiusLU: radiusSum / alive / POS_SCALE,
          visionRangeLU: visionSum / alive / POS_SCALE,
          attack: attackSum / alive / Q,
          armor: armorSum / alive / Q,
          metabolicPace: paceSum / alive / Q,
          thermalOptimumC: thermalSum / alive / 100,
        };

  return {
    population: organisms.liveCount,
    maxGeneration,
    plantBiomass,
    plantCapacity,
    organismMass,
    meanEnergyFraction: alive === 0 ? 0 : energyFractionSum / alive,
    traitMeans,
  };
}
