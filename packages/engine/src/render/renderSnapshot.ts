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
 * Display quantization range for the terrain temperature plane.
 *
 * Chosen to cover what the default generator can actually produce with margin:
 * +30 °C at a sea-level equator, -10 °C at the pole edges, a further -10 °C of
 * elevation cooling and a few degrees of noise (docs/03 §17, docs/08 §4).
 * Values outside the range clamp — they are still *drawn*, at the ramp's end.
 * These are named display constants, not tuning: no authoritative rule reads
 * them, and the UI receives them via `WorldSummaryDto.display` so its legend
 * can never disagree with the writer.
 */
export const TEMPERATURE_DISPLAY_MIN_CENTI_C = -2500;
export const TEMPERATURE_DISPLAY_MAX_CENTI_C = 3500;

/**
 * Plant units that byte 255 of the capacity plane represents: the richest
 * biome's base capacity. Real cells sit at `base × fertility × suitability`,
 * so every value fits under this reference by construction (docs/03 §20).
 */
export function capacityDisplayReference(config: {
  plants: { baseCapacityByBiome: readonly number[] };
}): number {
  let reference = 1;
  for (const base of config.plants.baseCapacityByBiome) {
    if (base > reference) {
      reference = base;
    }
  }
  return reference;
}

/**
 * The byte planes a static world-fields consumer must provide.
 *
 * Structural for the same reason as {@link RenderSnapshotWriter}: the packed
 * wire layout is `@eon/protocol`'s concern and its `TerrainSnapshotView`
 * satisfies this shape without either package importing the other.
 */
export interface StaticWorldFieldsWriter {
  readonly biome: Uint8Array;
  readonly elevation: Uint8Array;
  readonly temperature: Uint8Array;
  readonly moisture: Uint8Array;
  readonly fertility: Uint8Array;
  readonly capacity: Uint8Array;
}

/**
 * Fill the static terrain fields: biome and elevation for the base map, and
 * the temperature/moisture/fertility/capacity planes behind the Milestone 7
 * world layers.
 *
 * Sent once with WORLD_READY. Everything is rescaled to bytes purely for
 * display; nothing reads any of it back, and this function writes to no engine
 * array — the same read-only contract as {@link writeRenderSnapshot}. "Static"
 * is a Milestone 0-8 fact, not a law: the Milestone 9 interventions that edit
 * these fields will resend them.
 */
export function writeTerrainFields(engine: SimulationEngine, out: StaticWorldFieldsWriter): void {
  const { context } = engineInternals(engine);
  const environment = engine.environment;
  const capacityReference = capacityDisplayReference(context.config);
  const temperatureSpan = TEMPERATURE_DISPLAY_MAX_CENTI_C - TEMPERATURE_DISPLAY_MIN_CENTI_C;
  // Bounded by every plane, not just the first: a writer with one short array
  // truncates the whole projection deterministically instead of silently
  // no-op-writing past the short plane's end.
  const count = Math.min(
    environment.cellCount,
    out.biome.length,
    out.elevation.length,
    out.temperature.length,
    out.moisture.length,
    out.fertility.length,
    out.capacity.length,
  );
  for (let cell = 0; cell < count; cell += 1) {
    out.biome[cell] = environment.biome[cell] as number;
    out.elevation[cell] = byteFromQ(environment.elevationQ[cell] as number);
    out.temperature[cell] = clamp(
      Math.round(
        ((environment.getTemperatureCentiC(cell) - TEMPERATURE_DISPLAY_MIN_CENTI_C) * 255) /
          temperatureSpan,
      ),
      0,
      255,
    );
    out.moisture[cell] = byteFromQ(environment.getMoistureQ(cell));
    out.fertility[cell] = byteFromQ(environment.fertilityQ[cell] as number);
    out.capacity[cell] = clamp(
      Math.round(((environment.plantCapacity[cell] as number) * 255) / capacityReference),
      0,
      255,
    );
  }
}

/** Speed in location units per tick, for display. */
export function speedLUPerTick(vx: number, vy: number): number {
  return Math.sqrt(vx * vx + vy * vy) / VELOCITY_UNITS_PER_LU;
}
