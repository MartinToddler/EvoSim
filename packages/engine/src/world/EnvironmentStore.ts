import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { POS_SCALE, Q, clamp } from "../math/fixed";
import { Biome } from "./biomes";

/**
 * Read-only element view of a numeric array.
 *
 * TypedArrays satisfy this structurally (TypeScript ignores `readonly` index
 * modifiers when checking assignability), so the engine hands out the live
 * arrays with no copy and no cast, while consumer code that tries to write
 * through the view fails to compile.
 *
 * Honest statement of the limit: element writes cannot be blocked at runtime.
 * `Object.freeze` throws on a TypedArray that has elements, and a Proxy would
 * cost a trap on every read in the hottest loops in the project. A caller
 * willing to cast can still write a cell. Everything else — the mutating
 * methods, the scalar setter, the array references themselves — is genuinely
 * unreachable through the published view.
 */
export interface ReadonlyNumericArray extends ArrayLike<number>, Iterable<number> {
  readonly length: number;
  readonly [index: number]: number;
}

/**
 * The environment as seen from outside the engine: every authoritative array,
 * read-only, plus the derived caches and the pure lookup helpers.
 *
 * This is the type of `SimulationEngine.environment`, and at runtime it is a
 * separate frozen object rather than the store itself, so `recomputePassability`,
 * `hashInto` and `setGlobalTemperatureOffsetCentiC` cannot be reached by casting.
 * Engine phase code that legitimately writes to the grid takes the concrete
 * {@link EnvironmentStore} from `internal.ts` instead.
 */
export interface ReadonlyEnvironmentView {
  readonly size: number;
  readonly cellCount: number;
  readonly cellSizeLU: number;

  readonly elevationQ: ReadonlyNumericArray;
  readonly baseMoistureQ: ReadonlyNumericArray;
  readonly moistureOffsetQ: ReadonlyNumericArray;
  readonly fertilityQ: ReadonlyNumericArray;
  readonly baseTemperatureCentiC: ReadonlyNumericArray;
  readonly temperatureOffsetCentiC: ReadonlyNumericArray;
  readonly biome: ReadonlyNumericArray;
  readonly plantBiomass: ReadonlyNumericArray;
  readonly plantCapacity: ReadonlyNumericArray;
  readonly plantGrowthRemainderQ: ReadonlyNumericArray;
  readonly globalTemperatureOffsetCentiC: number;

  readonly passable: ReadonlyNumericArray;
  readonly plantGradientXQ: ReadonlyNumericArray;
  readonly plantGradientYQ: ReadonlyNumericArray;

  cellIndex(gx: number, gy: number): number;
  cellIndexFromPosition(xPos: number, yPos: number): number;
  isWaterCell(index: number): boolean;
  getTemperatureCentiC(index: number): number;
  getMoistureQ(index: number): number;
  getPlantBiomass(index: number): number;
}

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
 *
 * The instance is frozen at the end of construction: an array reference can
 * never be swapped out, and the global temperature offset is reachable only
 * through {@link setGlobalTemperatureOffsetCentiC}, which does not exist on
 * the {@link ReadonlyEnvironmentView} the engine publishes (ADR 0004 §1).
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

  /**
   * Persistent world-wide temperature offset set by the player (docs/03 §25).
   *
   * A private field with an accessor, not a public data property: the store is
   * frozen, and a frozen data property could not be written by the engine
   * either. Private fields live in internal slots that freezing does not touch.
   */
  #globalTemperatureOffsetCentiC = 0;

  /** Built once at construction; see {@link readonlyView}. */
  readonly #readonlyView: ReadonlyEnvironmentView;

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

    this.#readonlyView = this.#buildReadonlyView();

    // Must stay the last statement: the array references and every declared
    // field become non-writable, so no caller can substitute a shorter buffer
    // or an aliased view of engine memory.
    Object.freeze(this);
  }

  /**
   * The frozen read-only projection published by the engine.
   *
   * Built once and shared: it holds the same array references, so reads cost
   * exactly what they cost on the store, but it carries none of the mutating
   * members. Method identities are bound to this store rather than delegated
   * through `this`, so the view cannot be re-pointed either.
   */
  get readonlyView(): ReadonlyEnvironmentView {
    return this.#readonlyView;
  }

  #buildReadonlyView(): ReadonlyEnvironmentView {
    const view = {
      size: this.size,
      cellCount: this.cellCount,
      cellSizeLU: this.cellSizeLU,

      elevationQ: this.elevationQ,
      baseMoistureQ: this.baseMoistureQ,
      moistureOffsetQ: this.moistureOffsetQ,
      fertilityQ: this.fertilityQ,
      baseTemperatureCentiC: this.baseTemperatureCentiC,
      temperatureOffsetCentiC: this.temperatureOffsetCentiC,
      biome: this.biome,
      plantBiomass: this.plantBiomass,
      plantCapacity: this.plantCapacity,
      plantGrowthRemainderQ: this.plantGrowthRemainderQ,

      passable: this.passable,
      plantGradientXQ: this.plantGradientXQ,
      plantGradientYQ: this.plantGradientYQ,

      // Replaced by a live getter below; the placeholder only fixes the shape.
      globalTemperatureOffsetCentiC: 0,

      cellIndex: (gx: number, gy: number) => this.cellIndex(gx, gy),
      cellIndexFromPosition: (xPos: number, yPos: number) => this.cellIndexFromPosition(xPos, yPos),
      isWaterCell: (index: number) => this.isWaterCell(index),
      getTemperatureCentiC: (index: number) => this.getTemperatureCentiC(index),
      getMoistureQ: (index: number) => this.getMoistureQ(index),
      getPlantBiomass: (index: number) => this.getPlantBiomass(index),
    };

    // An accessor rather than a copied number: the offset changes when a player
    // command shifts the climate, and the view must never go stale.
    Object.defineProperty(view, "globalTemperatureOffsetCentiC", {
      get: () => this.globalTemperatureOffsetCentiC,
      enumerable: true,
      configurable: false,
    });

    return Object.freeze(view);
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

  /** Persistent world-wide temperature offset set by the player (docs/03 §25). */
  get globalTemperatureOffsetCentiC(): number {
    return this.#globalTemperatureOffsetCentiC;
  }

  /**
   * Set the global temperature offset. Engine-side only: it is absent from
   * {@link ReadonlyEnvironmentView}, so authoritative state cannot be shifted
   * from application, worker or renderer code.
   */
  setGlobalTemperatureOffsetCentiC(centiC: number): void {
    assert(
      Number.isSafeInteger(centiC),
      `global temperature offset must be an integer centi-Celsius value, got ${centiC}`,
    );
    this.#globalTemperatureOffsetCentiC = centiC;
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
    hasher.word(this.#globalTemperatureOffsetCentiC | 0);
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
