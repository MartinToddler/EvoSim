import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { POS_SCALE, clamp } from "../math/fixed";
import { Biome } from "./biomes";

/**
 * Environment state as Structure-of-Arrays (docs/03 §14, docs/10 §5).
 *
 * One entry per environment cell, row-major (`index = y * size + x`), for a
 * 256×256 grid by default. Everything here is authoritative and serialized;
 * the derived caches (passability, plant gradient) are recomputed rather than
 * saved, so they never need to be hashed — but they are deterministic
 * functions of the authoritative arrays, recomputed at exactly the points the
 * tick order defines.
 *
 * Player brush edits write the `*Offset*` arrays rather than the base fields,
 * so the underlying generated world stays intact and an intervention can be
 * described exactly (docs/03 §25). Those arrays are zero until Milestone 9.
 */
export class EnvironmentStore {
  readonly size: number;
  readonly cellCount: number;
  readonly cellSizeLU: number;

  // --- Authoritative fields (docs/03 §14) -----------------------------------
  readonly elevationQ: Uint16Array;
  readonly baseMoistureQ: Uint16Array;
  readonly moistureOffsetQ: Int16Array;
  readonly fertilityQ: Uint16Array;
  readonly baseTemperatureCentiC: Int16Array;
  readonly temperatureOffsetCentiC: Int16Array;
  readonly biome: Uint8Array;
  readonly plantBiomass: Uint16Array;
  readonly plantCapacity: Uint16Array;
  /**
   * Carried fractional growth per cell, in Q units (always < Q).
   *
   * Biomass is an integer, but a cell's true logistic growth per step is often
   * a fraction of one unit — at low biomass, always. Truncating it would leave
   * sparse cells permanently frozen, so the fraction is carried here until it
   * completes a whole unit. Authoritative state: it is hashed and serialized.
   */
  readonly plantGrowthRemainderQ: Uint16Array;

  /** Persistent world-wide temperature offset set by the player (docs/03 §25). */
  globalTemperatureOffsetCentiC = 0;

  // --- Derived caches (recomputed, never serialized) -------------------------
  /** 1 where a terrestrial organism can walk, 0 in water. */
  readonly passable: Uint8Array;
  /** Plant density gradient per cell, Q-scaled, for sensing (docs/03 §22). */
  readonly plantGradientXQ: Int16Array;
  readonly plantGradientYQ: Int16Array;

  constructor(size: number, cellSizeLU: number) {
    assert(
      Number.isSafeInteger(size) && size > 0,
      `environment size must be positive, got ${size}`,
    );
    assert(
      Number.isSafeInteger(cellSizeLU) && cellSizeLU > 0,
      `environment cell size must be positive, got ${cellSizeLU}`,
    );

    this.size = size;
    this.cellCount = size * size;
    this.cellSizeLU = cellSizeLU;

    this.elevationQ = new Uint16Array(this.cellCount);
    this.baseMoistureQ = new Uint16Array(this.cellCount);
    this.moistureOffsetQ = new Int16Array(this.cellCount);
    this.fertilityQ = new Uint16Array(this.cellCount);
    this.baseTemperatureCentiC = new Int16Array(this.cellCount);
    this.temperatureOffsetCentiC = new Int16Array(this.cellCount);
    this.biome = new Uint8Array(this.cellCount);
    this.plantBiomass = new Uint16Array(this.cellCount);
    this.plantCapacity = new Uint16Array(this.cellCount);
    this.plantGrowthRemainderQ = new Uint16Array(this.cellCount);

    this.passable = new Uint8Array(this.cellCount);
    this.plantGradientXQ = new Int16Array(this.cellCount);
    this.plantGradientYQ = new Int16Array(this.cellCount);
  }

  /** Cell index from grid coordinates. Coordinates are clamped to the grid. */
  cellIndex(gx: number, gy: number): number {
    const x = clamp(gx, 0, this.size - 1);
    const y = clamp(gy, 0, this.size - 1);
    return y * this.size + x;
  }

  /**
   * Cell index from a fixed-point world position (POS_SCALE sub-units per LU).
   * Positions outside the world clamp to the border cell.
   */
  cellIndexFromPosition(xPos: number, yPos: number): number {
    const gx = Math.floor(xPos / (POS_SCALE * this.cellSizeLU));
    const gy = Math.floor(yPos / (POS_SCALE * this.cellSizeLU));
    return this.cellIndex(gx, gy);
  }

  isWaterCell(index: number): boolean {
    return this.biome[index] === Biome.Water;
  }

  /** Effective temperature including player offsets (docs/03 §17). */
  getTemperatureCentiC(index: number): number {
    return (
      (this.baseTemperatureCentiC[index] as number) +
      (this.temperatureOffsetCentiC[index] as number) +
      this.globalTemperatureOffsetCentiC
    );
  }

  /** Effective moisture including the player offset, clamped to [0, Q]. */
  getMoistureQ(index: number): number {
    const value = (this.baseMoistureQ[index] as number) + (this.moistureOffsetQ[index] as number);
    return clamp(value, 0, 4096);
  }

  getPlantBiomass(index: number): number {
    return this.plantBiomass[index] as number;
  }

  /**
   * Recompute the passability cache from the authoritative biome array.
   * Called after generation and after any terrain edit.
   */
  recomputePassability(): void {
    for (let i = 0; i < this.cellCount; i += 1) {
      this.passable[i] = this.biome[i] === Biome.Water ? 0 : 1;
    }
  }

  /**
   * Feed every authoritative array into the canonical state hash.
   *
   * The order here is part of the hashing contract (docs/10 §17): changing it
   * changes every world hash and requires an ENGINE_VERSION bump. Derived
   * caches are deliberately excluded — they are pure functions of these arrays
   * and are recomputed on load.
   */
  hashInto(hasher: StateHash): void {
    hasher.word(this.size);
    hasher.word(this.cellSizeLU);
    hasher.word(this.globalTemperatureOffsetCentiC | 0);
    hasher.array(HASH_TAG.u16, this.elevationQ);
    hasher.array(HASH_TAG.u16, this.baseMoistureQ);
    hasher.array(HASH_TAG.i16, this.moistureOffsetQ);
    hasher.array(HASH_TAG.u16, this.fertilityQ);
    hasher.array(HASH_TAG.i16, this.baseTemperatureCentiC);
    hasher.array(HASH_TAG.i16, this.temperatureOffsetCentiC);
    hasher.array(HASH_TAG.u8, this.biome);
    hasher.array(HASH_TAG.u16, this.plantBiomass);
    hasher.array(HASH_TAG.u16, this.plantCapacity);
    hasher.array(HASH_TAG.u16, this.plantGrowthRemainderQ);
  }
}
