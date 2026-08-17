import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { POS_SCALE, Q, clamp } from "../math/fixed";
import { Biome } from "./biomes";
import { PLANT_RESOURCE_COUNT } from "./resources";

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
  /**
   * Standing biomass of every plant channel, `PLANT_RESOURCE_COUNT * cellCount`
   * in resource-major order (M17). Index with {@link resourceCell}.
   *
   * One field held one channel through Milestone 16 and the name `plantBiomass`
   * described it exactly. It is gone rather than kept as an alias for channel
   * 0: an alias would let a caller mean "the plants" and silently get one
   * fifth of them, which is the kind of quiet wrong answer a rename makes
   * impossible. Callers that want the whole cell ask {@link totalPlantBiomass}.
   */
  readonly resourceBiomass: Uint16Array;
  /** Carrying capacity of every plant channel, same layout as the biomass. */
  readonly resourceCapacity: Uint16Array;
  /**
   * Carried fractional growth per cell, in Q units (always < Q).
   *
   * Biomass is an integer, but a cell's true logistic growth per step is often
   * a fraction of one unit — at low biomass, always. Truncating it would leave
   * sparse cells permanently frozen, so the fraction is carried here until it
   * completes a whole unit. Authoritative state: it is hashed and serialized.
   */
  readonly plantGrowthRemainderQ: Uint16Array;

  /**
   * Persistent world-wide temperature offset set by the player (docs/03 §25).
   *
   * A private field with a getter: the store instance is frozen (see the
   * constructor), so a public mutable field could not work, and an assignable
   * offset was exactly the foundation-gate ADR §1 defect — authoritative state
   * writable from outside any tick. Writers go through
   * {@link setGlobalTemperatureOffsetCentiC}, which only engine-internal code
   * (the phase-0 command applier and snapshot restore) may call.
   */
  #globalTemperatureOffsetCentiC = 0;

  // --- Derived caches (recomputed, never serialized) -------------------------
  /** 1 where a terrestrial organism can walk, 0 in water. */
  readonly passable: Uint8Array;

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
    this.resourceBiomass = new Uint16Array(PLANT_RESOURCE_COUNT * this.cellCount);
    this.resourceCapacity = new Uint16Array(PLANT_RESOURCE_COUNT * this.cellCount);
    this.plantGrowthRemainderQ = new Uint16Array(PLANT_RESOURCE_COUNT * this.cellCount);

    this.passable = new Uint8Array(this.cellCount);

    // Freeze the instance (foundation-gate ADR §1): an array reference cannot
    // be swapped for a shorter or aliased buffer, and no field can be added or
    // reassigned. Element writes through the TypedArrays remain possible —
    // Object.freeze cannot stop those — so the write boundary is the type
    // surface plus the lint rule banning deep engine imports, plus the fact
    // that every out-of-process consumer only ever sees copies (snapshots and
    // packed render buffers cross the worker boundary by structured clone or
    // transfer, never as live references). The private #global offset lives in
    // an internal slot that freeze does not touch.
    Object.freeze(this);
  }

  /** Current world-wide player temperature offset in centi-°C. */
  get globalTemperatureOffsetCentiC(): number {
    return this.#globalTemperatureOffsetCentiC;
  }

  /**
   * Set the world-wide player temperature offset.
   *
   * Engine-internal: the only legitimate callers are the phase-0 command
   * applier (SET_GLOBAL_TEMPERATURE_OFFSET) and snapshot restore. Anything
   * else writing this would change authoritative state outside a tick.
   */
  setGlobalTemperatureOffsetCentiC(offsetCentiC: number): void {
    assert(
      Number.isSafeInteger(offsetCentiC),
      `global temperature offset must be an integer, got ${offsetCentiC}`,
    );
    this.#globalTemperatureOffsetCentiC = offsetCentiC;
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
      this.#globalTemperatureOffsetCentiC
    );
  }

  /** Effective moisture including the player offset, clamped to [0, Q]. */
  getMoistureQ(index: number): number {
    const value = (this.baseMoistureQ[index] as number) + (this.moistureOffsetQ[index] as number);
    return clamp(value, 0, Q);
  }

  /** Flat index of one channel in one cell, for the resource-major arrays. */
  resourceCell(resource: number, index: number): number {
    return resource * this.cellCount + index;
  }

  /** Standing biomass of one channel in one cell. */
  getResourceBiomass(resource: number, index: number): number {
    return this.resourceBiomass[resource * this.cellCount + index] as number;
  }

  /** Carrying capacity of one channel in one cell. */
  getResourceCapacity(resource: number, index: number): number {
    return this.resourceCapacity[resource * this.cellCount + index] as number;
  }

  /**
   * Standing biomass summed over every plant channel in one cell.
   *
   * For statistics, the renderer and the resource-agnostic sensors. It sums
   * rather than ranking, which is the whole point: a total treats every channel
   * alike, where anything that weighted them would be the engine deciding which
   * food matters (docs/11 §M17, "the brain does the ranking").
   */
  totalPlantBiomass(index: number): number {
    let total = 0;
    for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
      total += this.resourceBiomass[resource * this.cellCount + index] as number;
    }
    return total;
  }

  /** Carrying capacity summed over every plant channel in one cell. */
  totalPlantCapacity(index: number): number {
    let total = 0;
    for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
      total += this.resourceCapacity[resource * this.cellCount + index] as number;
    }
    return total;
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
   * and are recomputed on load. The plant gradient is not among them: it is
   * computed where it is read rather than stored (see plants.ts).
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
    hasher.array(HASH_TAG.u16, this.resourceBiomass);
    hasher.array(HASH_TAG.u16, this.resourceCapacity);
    hasher.array(HASH_TAG.u16, this.plantGrowthRemainderQ);
  }
}
