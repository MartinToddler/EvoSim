import { engineInternals } from "../internal";
import { Q, POS_SCALE, ANGLE_STEPS, clamp } from "../math/fixed";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";
import { VELOCITY_SCALE } from "../organisms/movement";
import type { SimulationEngine } from "../SimulationEngine";

/**
 * Render snapshot production — phase 18 of the tick order (task G04,
 * docs/02 §10, docs/06 §§3-4).
 *
 * ## This is a projection, not state
 *
 * `writeRenderSnapshot` reads authoritative state and writes display numbers
 * into buffers the *caller* owns. It allocates nothing, it advances no tick, it
 * touches no PRNG, and it writes to no engine array. That is what makes it safe
 * to call at an arbitrary wall-clock cadence: the renderer asking for a picture
 * cannot change the world it is a picture of.
 *
 * ## Units change at this boundary, on purpose
 *
 * Inside the engine a position is an `Int32` count of sub-units and a heading
 * is one of 4096 integer steps. Neither is useful to a GPU. Here they become
 * `Float32` location units and radians — "renderer floats derived from
 * authoritative fixed-point state" (docs/02 §10). The conversion is one-way:
 * nothing ever converts a renderer float back into authoritative state.
 *
 * ## Why the writer is structural
 *
 * The parameter is an interface of plain TypedArrays, not a protocol class.
 * `@eon/engine` therefore does not depend on `@eon/protocol`, and the packed
 * wire layout stays a protocol concern (`@eon/protocol`'s `RenderSnapshotView`
 * satisfies this shape structurally). The engine's only contract is "fill these
 * columns in ascending slot order".
 *
 * ## What is deliberately excluded
 *
 * No genome, no brain weights, no sensor values, no per-organism internals
 * beyond what a pixel needs. Colour is not decided here either: the engine
 * emits the hue *gene* in degrees and the renderer owns the palette, because
 * choosing an RGB triple is presentation policy (CLAUDE.md renderer boundary,
 * read in the direction that keeps the engine out of the paint box).
 */

/** Bit flags mirroring `RenderFlag` in `@eon/protocol`. */
export const RenderFlagBit = {
  Juvenile: 1 << 0,
  Attacking: 1 << 1,
  Injured: 1 << 2,
  CarnivoreLeaning: 1 << 3,
} as const;

/**
 * The columns a render snapshot consumer must provide.
 *
 * Every array is indexed by *dense output index*, not by engine slot: the
 * writer compacts live organisms into `[0, organismCount)` so the renderer can
 * iterate without liveness checks.
 */
export interface RenderSnapshotWriter {
  readonly organismId: Uint32Array;
  readonly organismX: Float32Array;
  readonly organismY: Float32Array;
  readonly organismRotation: Float32Array;
  readonly organismRadiusLU: Float32Array;
  readonly organismSpeciesId: Uint32Array;
  readonly organismHueDeg: Uint16Array;
  readonly organismFlags: Uint16Array;
  readonly organismHealth: Uint8Array;
  readonly organismEnergy: Uint8Array;
  readonly organismDiet: Int8Array;
  readonly organismSpeed: Uint8Array;

  readonly carcassId: Uint32Array;
  readonly carcassX: Float32Array;
  readonly carcassY: Float32Array;
  readonly carcassRadiusLU: Float32Array;
}

export interface RenderSnapshotCounts {
  organismCount: number;
  carcassCount: number;
}

/** Radians per heading step. Constant folded once, not per organism. */
const RADIANS_PER_STEP = (Math.PI * 2) / ANGLE_STEPS;
/** Velocity units per location unit per tick. */
const VELOCITY_UNITS_PER_LU = VELOCITY_SCALE * POS_SCALE;

/** Scale a Q value in `[0, Q]` to a byte in `[0, 255]`. */
function byteFromQ(value: number): number {
  return clamp(Math.round((value * 255) / Q), 0, 255);
}

/**
 * Project the current authoritative state into `writer`.
 *
 * Returns how many organisms and carcasses were written. Both are capped by the
 * writer's column lengths: a writer sized for a smaller population truncates
 * deterministically in ascending slot order rather than writing out of bounds.
 * In practice the host sizes buffers from `limits.maxOrganisms`, so truncation
 * cannot happen — but "in practice" is not a bounds check.
 */
export function writeRenderSnapshot(
  engine: SimulationEngine,
  writer: RenderSnapshotWriter,
): RenderSnapshotCounts {
  const { context } = engineInternals(engine);
  const { organisms, phenotypes, carcasses, config } = context;

  const organismLimit = writer.organismId.length;
  const referenceMaxSpeedVel = config.organism.geneRanges.maxSpeedMaxVel;
  const massScale = config.organism.massScalePerRadiusSquared;

  let organismCount = 0;
  const slotHighWater = organisms.slotHighWater;
  for (let slot = 0; slot < slotHighWater && organismCount < organismLimit; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const out = organismCount;
    organismCount += 1;

    const developmentQ = organisms.developmentQ[slot] as number;
    const radiusPos = currentRadiusPos(phenotypes.adultRadiusPos[slot] as number, developmentQ);
    const mass = massFromRadiusPos(radiusPos, massScale);

    writer.organismId[out] = organisms.entityId[slot] as number;
    writer.organismX[out] = (organisms.x[slot] as number) / POS_SCALE;
    writer.organismY[out] = (organisms.y[slot] as number) / POS_SCALE;
    writer.organismRotation[out] = (organisms.angle[slot] as number) * RADIANS_PER_STEP;
    writer.organismRadiusLU[out] = radiusPos / POS_SCALE;
    writer.organismSpeciesId[out] = organisms.speciesId[slot] as number;
    writer.organismHueDeg[out] = phenotypes.hueDegrees[slot] as number;

    writer.organismHealth[out] = byteFromQ(organisms.healthQ[slot] as number);

    // Energy is shown as a fraction of what this body can hold, because the
    // absolute number means nothing without the body: a large juvenile and a
    // small adult holding the same energy are in completely different states.
    const maxEnergy = maxEnergyForMass(mass, config);
    const energy = organisms.energy[slot] as number;
    writer.organismEnergy[out] =
      maxEnergy > 0 ? clamp(Math.round((energy * 255) / maxEnergy), 0, 255) : 0;

    const dietQ = phenotypes.dietQ[slot] as number;
    writer.organismDiet[out] = clamp(Math.round((dietQ * 127) / Q), -127, 127);
    writer.organismSpeed[out] =
      referenceMaxSpeedVel > 0
        ? clamp(
            Math.round(((phenotypes.maxSpeedVel[slot] as number) * 255) / referenceMaxSpeedVel),
            0,
            255,
          )
        : 0;

    let flags = 0;
    if (developmentQ < Q) {
      flags |= RenderFlagBit.Juvenile;
    }
    if ((organisms.attackCooldown[slot] as number) > 0) {
      flags |= RenderFlagBit.Attacking;
    }
    if ((organisms.lastDamageQ[slot] as number) > 0) {
      flags |= RenderFlagBit.Injured;
    }
    if (dietQ > 0) {
      flags |= RenderFlagBit.CarnivoreLeaning;
    }
    writer.organismFlags[out] = flags;
  }

  const carcassLimit = writer.carcassId.length;
  let carcassCount = 0;
  const carcassHighWater = carcasses.slotHighWater;
  for (let slot = 0; slot < carcassHighWater && carcassCount < carcassLimit; slot += 1) {
    if (carcasses.active[slot] !== 1) {
      continue;
    }
    const out = carcassCount;
    carcassCount += 1;

    writer.carcassId[out] = carcasses.entityId[slot] as number;
    writer.carcassX[out] = (carcasses.x[slot] as number) / POS_SCALE;
    writer.carcassY[out] = (carcasses.y[slot] as number) / POS_SCALE;

    // Display radius is the inverse of the body's own mass law
    // (mass = massScale × radiusLU²) applied to the meat still lying there, so
    // a carcass shrinks as it is eaten and decays instead of being drawn at an
    // invented constant size.
    const remainingMass =
      (carcasses.remainingMeat[slot] as number) / config.organism.carcass.meatPerMass;
    writer.carcassRadiusLU[out] = massScale > 0 ? Math.sqrt(remainingMass / massScale) : 0;
  }

  return { organismCount, carcassCount };
}

/**
 * Fill a byte-per-cell vegetation field: plant biomass as a fraction of that
 * cell's capacity.
 *
 * A fraction rather than an absolute: capacity varies by biome, fertility and
 * climate, so absolute biomass would paint a fertile grassland at half stock
 * greener than a saturated tundra, which is the opposite of what "how grazed is
 * this place" should look like.
 */
export function writeVegetationField(engine: SimulationEngine, out: Uint8Array): void {
  const environment = engine.environment;
  const count = Math.min(out.length, environment.cellCount);
  for (let cell = 0; cell < count; cell += 1) {
    const capacity = environment.plantCapacity[cell] as number;
    if (capacity <= 0) {
      out[cell] = 0;
      continue;
    }
    const biomass = environment.plantBiomass[cell] as number;
    out[cell] = clamp(Math.round((biomass * 255) / capacity), 0, 255);
  }
}

/**
 * Fill the static terrain fields: biome index and elevation shading.
 *
 * Sent once with WORLD_READY. Elevation is rescaled from Q to a byte purely for
 * shading; nothing reads it back.
 */
export function writeTerrainFields(
  engine: SimulationEngine,
  biomeOut: Uint8Array,
  elevationOut: Uint8Array,
): void {
  const environment = engine.environment;
  const count = Math.min(biomeOut.length, elevationOut.length, environment.cellCount);
  for (let cell = 0; cell < count; cell += 1) {
    biomeOut[cell] = environment.biome[cell] as number;
    elevationOut[cell] = byteFromQ(environment.elevationQ[cell] as number);
  }
}

/** Speed in location units per tick, for display. */
export function speedLUPerTick(vx: number, vy: number): number {
  return Math.sqrt(vx * vx + vy * vy) / VELOCITY_UNITS_PER_LU;
}
