import { engineInternals } from "../internal";
import { ANGLE_STEPS, POS_SCALE, Q } from "../math/fixed";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";
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
  const { organisms, phenotypes, environment, config } = context;

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

    plantEnergyEaten: organisms.plantEnergyEaten[slot] as number,
    meatEnergyEaten: organisms.meatEnergyEaten[slot] as number,
    kills: organisms.kills[slot] as number,

    biome: environment.biome[cell] as number,
    biomeName: BIOME_NAMES[environment.biome[cell] as number] ?? "Unknown",
    cellTemperatureC: environment.getTemperatureCentiC(cell) / 100,
    cellPlantBiomass: environment.getPlantBiomass(cell),
  };
}

/**
 * Cheap world-wide aggregates for the HUD (docs/02 §11).
 *
 * One ascending pass over live slots. Called at telemetry cadence — a couple of
 * times per second — never per tick, and never per frame.
 */
export function collectTelemetryAggregates(engine: SimulationEngine): {
  population: number;
  maxGeneration: number;
  plantBiomass: number;
  plantCapacity: number;
} {
  const { context } = engineInternals(engine);
  const { organisms, environment } = context;

  let maxGeneration = 0;
  const slotHighWater = organisms.slotHighWater;
  for (let slot = 0; slot < slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const generation = organisms.generation[slot] as number;
    if (generation > maxGeneration) {
      maxGeneration = generation;
    }
  }

  let plantBiomass = 0;
  let plantCapacity = 0;
  const cellCount = environment.cellCount;
  for (let cell = 0; cell < cellCount; cell += 1) {
    plantBiomass += environment.plantBiomass[cell] as number;
    plantCapacity += environment.plantCapacity[cell] as number;
  }

  return {
    population: organisms.liveCount,
    maxGeneration,
    plantBiomass,
    plantCapacity,
  };
}
