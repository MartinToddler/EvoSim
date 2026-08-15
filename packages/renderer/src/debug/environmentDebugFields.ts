/**
 * Plain-data projection of the authoritative environment grid, for debug
 * painting (Milestone 2.5 debug visualizer).
 *
 * This is deliberately NOT the engine's `EnvironmentStore`:
 *
 * - the painter must be a pure function of plain arrays, so it can be tested in
 *   Node against synthetic grids without constructing a world;
 * - the player offsets are already folded in (`moistureQ`, `temperatureCentiC`
 *   are effective values), so the painter never has to know how the engine
 *   splits a field into base + offset;
 * - `@eon/renderer` therefore needs no dependency on `@eon/engine`, keeping the
 *   dependency direction of docs/02 §4 intact.
 *
 * When the Worker protocol arrives (Milestone 6, task G01) this is the shape a
 * terrain/overlay message would carry, but it is intentionally unversioned for
 * now: it is a development tool, not a wire contract.
 *
 * Arrays are row-major with `size * size` entries: `index = gridY * size + gridX`.
 */

/** Fixed-point scale shared by the whole project (docs/03 §3, docs/08 §1). */
export const Q_SCALE = 4096;

/**
 * RGBA output buffer for one repaint.
 *
 * Pinned to a non-shared `ArrayBuffer`: `ImageData` refuses a `SharedArrayBuffer`
 * view, and docs/02 §10 rules out requiring `SharedArrayBuffer` in the MVP anyway.
 * Spelling it out here keeps the constraint on the type instead of on a cast at
 * every call site.
 */
export type DebugPixelBuffer = Uint8ClampedArray<ArrayBuffer>;

export interface EnvironmentDebugFields {
  /** Grid edge length in cells. */
  readonly size: number;
  /** Environment cell edge in logical units, for coordinate readouts. */
  readonly cellSizeLU: number;

  /** Normalized elevation, [0, Q_SCALE]. */
  readonly elevationQ: Readonly<Uint16Array>;
  /** Effective moisture including player offsets, [0, Q_SCALE]. */
  readonly moistureQ: Readonly<Uint16Array>;
  /** Effective temperature including player and global offsets, centi-Celsius. */
  readonly temperatureCentiC: Readonly<Int16Array>;
  /** Soil fertility, [0, Q_SCALE]. */
  readonly fertilityQ: Readonly<Uint16Array>;
  /** Biome class per cell; values index the engine's Biome enum. */
  readonly biome: Readonly<Uint8Array>;
  /** Plant carrying capacity per cell, biomass units. */
  readonly plantCapacity: Readonly<Uint16Array>;
  /** Current plant biomass per cell, biomass units. */
  readonly plantBiomass: Readonly<Uint16Array>;

  /** Elevation below which a cell is water, so the painter can split the ramp. */
  readonly seaLevelQ: number;
  /** Elevation above which a cell is mountain. */
  readonly mountainLevelQ: number;

  /**
   * Biomass value painted as "full" by the capacity and biomass layers.
   *
   * Both vegetation layers share one reference so they can be compared by eye:
   * switching between them shows how far the field is from its own ceiling. The
   * reference is a property of the world (the highest capacity any cell reached),
   * so it is reported in the legend — two different worlds are not on the same
   * scale, and the UI must say so rather than imply otherwise.
   */
  readonly biomassReference: number;
}

/** Number of cells addressed by the field arrays. */
export function debugFieldCellCount(fields: EnvironmentDebugFields): number {
  return fields.size * fields.size;
}

/** Grid coordinates of a cell index. */
export function debugCellCoordinates(
  fields: EnvironmentDebugFields,
  index: number,
): { gridX: number; gridY: number } {
  const gridX = index % fields.size;
  return { gridX, gridY: (index - gridX) / fields.size };
}

/** Thrown when a debug view is asked to work with inconsistent inputs. */
export class EnvironmentDebugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentDebugError";
  }
}

/**
 * Validate that every array matches `size²`.
 *
 * A silently short array would paint a partially stale image, which is the worst
 * possible failure for a tool whose only job is to tell the truth about state.
 */
export function assertDebugFields(fields: EnvironmentDebugFields): void {
  if (!Number.isSafeInteger(fields.size) || fields.size <= 0) {
    throw new EnvironmentDebugError(`debug field grid size must be positive, got ${fields.size}`);
  }
  const expected = debugFieldCellCount(fields);
  const arrays: readonly [string, ArrayLike<number>][] = [
    ["elevationQ", fields.elevationQ],
    ["moistureQ", fields.moistureQ],
    ["temperatureCentiC", fields.temperatureCentiC],
    ["fertilityQ", fields.fertilityQ],
    ["biome", fields.biome],
    ["plantCapacity", fields.plantCapacity],
    ["plantBiomass", fields.plantBiomass],
  ];
  for (const [name, array] of arrays) {
    if (array.length !== expected) {
      throw new EnvironmentDebugError(
        `debug field ${name} has ${array.length} entries, expected ${expected}`,
      );
    }
  }

  // The elevation palette breaks at sea level and again at mountain level, so
  // those thresholds must be ordered for the ramp to be well formed. The engine
  // config validator already guarantees it; checking here keeps a hand-built
  // fixture from producing a confusing ramp error instead of a clear one.
  if (fields.seaLevelQ < 0 || fields.seaLevelQ > Q_SCALE) {
    throw new EnvironmentDebugError(`sea level ${fields.seaLevelQ} is outside [0, ${Q_SCALE}]`);
  }
  if (fields.mountainLevelQ <= fields.seaLevelQ || fields.mountainLevelQ > Q_SCALE) {
    throw new EnvironmentDebugError(
      `mountain level ${fields.mountainLevelQ} must be above sea level ${fields.seaLevelQ} ` +
        `and at most ${Q_SCALE}`,
    );
  }
  if (!Number.isSafeInteger(fields.biomassReference) || fields.biomassReference < 1) {
    throw new EnvironmentDebugError(
      `biomass reference must be a positive integer, got ${fields.biomassReference}`,
    );
  }
}
