import { ANGLE_STEPS, POS_SCALE, Q, TRIG_SCALE, clamp, clampSignedQ, qmul } from "../math/fixed";
import { cosLut, sinLut } from "../math/trigLut";
import { isqrt } from "../math/isqrt";
import { statelessNoiseSignedQ, statelessNoiseU32 } from "../random/statelessNoise";
import type { EngineContext } from "../EngineContext";
import { HUE_DEGREES } from "../genetics/genes";
import { currentRadiusPos, maxEnergyForMass, massFromRadiusPos } from "../organisms/phenotype";
import { thermalStressQ } from "../organisms/thermal";
import { plantGradientXQAt, plantGradientYQAt } from "../world/plants";
import {
  type NearestCreature,
  type NearestTarget,
  countCrowding,
  findNearestVisibleCarcass,
  findNearestVisibleCreature,
} from "../spatial/queries";
import { BRAIN_INPUT_COUNT, BrainInput } from "./BrainLayout";

/**
 * Sensing — phase 3 of the authoritative tick order (docs/04 §§12-16,
 * docs/08 §18, docs/10 §10, task D05).
 *
 * Writes each living organism's 20-value sensor block. All twenty inputs are
 * Q-scaled and every one of them is something the organism could plausibly
 * perceive about itself or its immediate surroundings. There is deliberately
 * no species ID, no "that one is a predator", no global population figure and
 * no knowledge of another organism's genes: ecological roles have to emerge
 * from geometry, phenotype cues and the inherited controller, not from an
 * omniscient input (docs/04 §12, CLAUDE.md).
 *
 * Sensing runs to completion for the whole population before any brain runs,
 * so every organism decides from the same coherent pre-decision state
 * (docs/03 §9). It reads the PRE-movement spatial index for the same reason.
 *
 * No bearings are computed with `atan2` (docs/04 §13): direction reaches the
 * brain as forward/lateral components against the organism's own heading.
 */

/** Reused across the sensing loop so the hot path allocates nothing. */
const nearestCreature: NearestCreature = { slot: -1, distSq: 0 };
const nearestCarcass: NearestTarget = { slot: -1, distSq: 0 };

/** Map a value in [0, scale] onto the full signed sensor range [-Q, Q]. */
function toSignedRange(value: number, scale: number): number {
  if (scale <= 0) {
    return -Q;
  }
  return clampSignedQ(Math.trunc((2 * clamp(value, 0, scale) * Q) / scale) - Q);
}

/** 1 when the point is water or outside the world; the world edge is a wall. */
function isDangerousPoint(ctx: EngineContext, xPos: number, yPos: number, maxPos: number): number {
  if (xPos < 0 || yPos < 0 || xPos > maxPos || yPos > maxPos) {
    return 1;
  }
  return ctx.environment.isWaterCell(ctx.environment.cellIndexFromPosition(xPos, yPos)) ? 1 : 0;
}

/**
 * Danger along a ray, as a Q fraction of samples that are dangerous.
 *
 * Several samples rather than one so the signal rises as water approaches
 * instead of flipping from safe to lethal in a single tick, which gives
 * avoidance behaviour something to evolve against.
 */
function probeDanger(
  ctx: EngineContext,
  xPos: number,
  yPos: number,
  dirX: number,
  dirY: number,
  probePos: number,
  samples: number,
  maxPos: number,
): number {
  let hits = 0;
  for (let i = 1; i <= samples; i += 1) {
    const distance = Math.trunc((probePos * i) / samples);
    const px = xPos + Math.trunc((dirX * distance) / TRIG_SCALE);
    const py = yPos + Math.trunc((dirY * distance) / TRIG_SCALE);
    hits += isDangerousPoint(ctx, px, py, maxPos);
  }
  return Math.trunc((hits * Q) / samples);
}

/**
 * Internal signal (docs/04 §16): a deterministic triangular oscillator with a
 * per-entity phase, blended with stateless hash noise.
 *
 * Both terms are functions of (seed, entityId, tick) only. Nothing here draws
 * from the global PRNG, so a render or a query can never shift an organism's
 * behaviour by advancing the generator.
 */
function internalSignalQ(
  seed: number,
  entityId: number,
  tick: number,
  periodTicks: number,
  noiseAmplitudeQ: number,
): number {
  const phaseOffset = statelessNoiseU32(seed, entityId, 0) % periodTicks;
  const phase = (tick + phaseOffset) % periodTicks;
  const half = periodTicks >> 1;
  const triangle =
    phase < half
      ? -Q + Math.trunc((2 * Q * phase) / half)
      : Q - Math.trunc((2 * Q * (phase - half)) / half);

  if (noiseAmplitudeQ <= 0) {
    return clampSignedQ(triangle);
  }
  const noise = statelessNoiseSignedQ(seed, entityId, tick);
  return clampSignedQ(qmul(triangle, Q - noiseAmplitudeQ) + qmul(noise, noiseAmplitudeQ));
}

/** Signed circular hue difference in [-Q, Q]; ±Q is the opposite colour. */
function hueDifferenceQ(selfHue: number, otherHue: number): number {
  let diff = (otherHue - selfHue) % HUE_DEGREES;
  if (diff < 0) {
    diff += HUE_DEGREES;
  }
  if (diff >= HUE_DEGREES / 2) {
    diff -= HUE_DEGREES;
  }
  return clampSignedQ(Math.trunc((diff * 2 * Q) / HUE_DEGREES));
}

/** Write the sensor block for every living organism. */
export function senseAll(ctx: EngineContext, tick: number): void {
  const { organisms, phenotypes, environment, config, scratch, seed } = ctx;
  const sensors = scratch.sensorValues;
  const senses = config.senses;
  const maxPos = config.world.sizeLU * POS_SCALE - 1;
  const probePos = senses.terrainProbeDistanceLU * POS_SCALE;
  const birthFractionQ = config.organism.birthSizeFractionQ;
  const developmentSpanQ = Q - birthFractionQ;
  const minToleranceCentiC = config.organism.health.thermalStressMinToleranceCentiC;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const base = slot * BRAIN_INPUT_COUNT;
    const xPos = organisms.x[slot] as number;
    const yPos = organisms.y[slot] as number;
    const angle = organisms.angle[slot] as number;

    // Heading basis. `right` is a quarter turn clockwise from the heading, so
    // a positive lateral component means "that way is to my right" and a
    // positive turn output steers toward it (docs/08 §18).
    const forwardX = cosLut(angle);
    const forwardY = sinLut(angle);
    const rightAngle = (angle + ANGLE_STEPS / 4) & (ANGLE_STEPS - 1);
    const rightX = cosLut(rightAngle);
    const rightY = sinLut(rightAngle);

    sensors[base + BrainInput.Bias] = Q;

    // --- Interoception -----------------------------------------------------
    const developmentQ = organisms.developmentQ[slot] as number;
    const radius = currentRadiusPos(phenotypes.adultRadiusPos[slot] as number, developmentQ);
    const mass = massFromRadiusPos(radius, config.organism.massScalePerRadiusSquared);
    const maxEnergy = maxEnergyForMass(mass, config);
    sensors[base + BrainInput.Energy] = toSignedRange(organisms.energy[slot] as number, maxEnergy);
    sensors[base + BrainInput.Health] = toSignedRange(organisms.healthQ[slot] as number, Q);
    sensors[base + BrainInput.Development] =
      developmentSpanQ > 0 ? toSignedRange(developmentQ - birthFractionQ, developmentSpanQ) : Q;

    // --- Plants (a field, never individual objects — docs/03 §22) ----------
    const cell = environment.cellIndexFromPosition(xPos, yPos);
    const capacity = environment.plantCapacity[cell] as number;
    sensors[base + BrainInput.LocalPlant] = toSignedRange(
      environment.plantBiomass[cell] as number,
      capacity,
    );
    const gradX = plantGradientXQAt(environment, cell);
    const gradY = plantGradientYQAt(environment, cell);
    sensors[base + BrainInput.PlantGradientForward] = clampSignedQ(
      Math.trunc((gradX * forwardX + gradY * forwardY) / TRIG_SCALE),
    );
    sensors[base + BrainInput.PlantGradientLateral] = clampSignedQ(
      Math.trunc((gradX * rightX + gradY * rightY) / TRIG_SCALE),
    );

    // --- Carcasses (docs/04 §13, docs/08 §18, task F02) --------------------
    // Absence reads -Q, the same as a creature out of sight, and NOT 0: an
    // organism at the very edge of vision reads -Q, and absence is "further away
    // than that", so a zero for absence would rank above a distant sighting and
    // invert the ordering the founder's eat weight is calibrated against
    // (ADR 0004 §1).
    findNearestVisibleCarcass(ctx, slot, nearestCarcass);
    if (nearestCarcass.slot === -1) {
      sensors[base + BrainInput.CarcassProximity] = -Q;
      sensors[base + BrainInput.CarcassForward] = 0;
      sensors[base + BrainInput.CarcassLateral] = 0;
    } else {
      const range = Math.max(phenotypes.visionRangePos[slot] as number, 1);
      const distance = isqrt(nearestCarcass.distSq);
      sensors[base + BrainInput.CarcassProximity] = clampSignedQ(
        Q - Math.trunc((2 * Q * distance) / range),
      );

      const dx = (ctx.carcasses.x[nearestCarcass.slot] as number) - xPos;
      const dy = (ctx.carcasses.y[nearestCarcass.slot] as number) - yPos;
      if (distance > 0) {
        const scale = distance * TRIG_SCALE;
        sensors[base + BrainInput.CarcassForward] = clampSignedQ(
          Math.trunc(((dx * forwardX + dy * forwardY) * Q) / scale),
        );
        sensors[base + BrainInput.CarcassLateral] = clampSignedQ(
          Math.trunc(((dx * rightX + dy * rightY) * Q) / scale),
        );
      } else {
        sensors[base + BrainInput.CarcassForward] = 0;
        sensors[base + BrainInput.CarcassLateral] = 0;
      }
    }

    // --- Other creatures ---------------------------------------------------
    findNearestVisibleCreature(ctx, slot, nearestCreature);
    const targetSlot = nearestCreature.slot;
    if (targetSlot === -1) {
      sensors[base + BrainInput.CreatureProximity] = -Q;
      sensors[base + BrainInput.CreatureForward] = 0;
      sensors[base + BrainInput.CreatureLateral] = 0;
      sensors[base + BrainInput.CreatureRelativeSize] = 0;
      sensors[base + BrainInput.CreatureHueDifference] = 0;
    } else {
      const range = Math.max(phenotypes.visionRangePos[slot] as number, 1);
      const distance = isqrt(nearestCreature.distSq);
      // +Q at contact, -Q at the edge of vision.
      sensors[base + BrainInput.CreatureProximity] = clampSignedQ(
        Q - Math.trunc((2 * Q * distance) / range),
      );

      const dx = (organisms.x[targetSlot] as number) - xPos;
      const dy = (organisms.y[targetSlot] as number) - yPos;
      if (distance > 0) {
        const scale = distance * TRIG_SCALE;
        sensors[base + BrainInput.CreatureForward] = clampSignedQ(
          Math.trunc(((dx * forwardX + dy * forwardY) * Q) / scale),
        );
        sensors[base + BrainInput.CreatureLateral] = clampSignedQ(
          Math.trunc(((dx * rightX + dy * rightY) * Q) / scale),
        );
      } else {
        sensors[base + BrainInput.CreatureForward] = 0;
        sensors[base + BrainInput.CreatureLateral] = 0;
      }

      // Relative size: +Q once the other body is twice this one's radius.
      const otherRadius = currentRadiusPos(
        phenotypes.adultRadiusPos[targetSlot] as number,
        organisms.developmentQ[targetSlot] as number,
      );
      sensors[base + BrainInput.CreatureRelativeSize] = clampSignedQ(
        radius > 0 ? Math.trunc(((otherRadius - radius) * Q) / radius) : 0,
      );
      sensors[base + BrainInput.CreatureHueDifference] = hueDifferenceQ(
        phenotypes.hueDegrees[slot] as number,
        phenotypes.hueDegrees[targetSlot] as number,
      );
    }

    // --- Climate, crowding, terrain ----------------------------------------
    const stressQ = thermalStressQ(
      environment.getTemperatureCentiC(cell),
      phenotypes.thermalOptimumCentiC[slot] as number,
      phenotypes.thermalToleranceCentiC[slot] as number,
      minToleranceCentiC,
    );
    sensors[base + BrainInput.ThermalComfort] = clampSignedQ(Q - stressQ);

    sensors[base + BrainInput.Crowding] = toSignedRange(
      countCrowding(ctx, slot),
      senses.crowdingSaturationCount,
    );

    const samples = senses.terrainForwardProbeSamples;
    sensors[base + BrainInput.TerrainDangerForward] = probeDanger(
      ctx,
      xPos,
      yPos,
      forwardX,
      forwardY,
      probePos,
      samples,
      maxPos,
    );
    // Positive means MORE danger on the left, which a positive (rightward)
    // turn escapes — the convention the founder weights rely on (docs/08 §18).
    const dangerRight = probeDanger(ctx, xPos, yPos, rightX, rightY, probePos, samples, maxPos);
    const dangerLeft = probeDanger(ctx, xPos, yPos, -rightX, -rightY, probePos, samples, maxPos);
    sensors[base + BrainInput.TerrainDangerLateral] = clampSignedQ(dangerLeft - dangerRight);

    sensors[base + BrainInput.InternalSignal] = internalSignalQ(
      seed,
      organisms.entityId[slot] as number,
      tick,
      senses.oscillatorPeriodTicks,
      senses.internalNoiseAmplitudeQ,
    );
  }
}
