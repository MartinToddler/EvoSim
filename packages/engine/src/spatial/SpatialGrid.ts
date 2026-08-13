import { assert } from "@eon/shared";
import { POS_SCALE, clamp } from "../math/fixed";
import type { OrganismStore } from "../organisms/OrganismStore";

/**
 * Uniform spatial hash over organism positions (docs/03 §10, task D04).
 *
 * A 128×128 grid of 32 LU cells for the default 4096 LU world. Membership is a
 * classic head/next intrusive list: `head[cell]` is the first slot in that
 * cell and `next[slot]` chains to the following one, so a rebuild is one pass
 * with zero allocation and no per-cell arrays.
 *
 * Its whole purpose is to keep sensing off the O(N²) path: a vision query
 * visits the handful of cells the vision radius overlaps instead of all 8192
 * organisms.
 *
 * The grid is DERIVED state — rebuilt from positions twice per tick — so it is
 * never hashed or serialized.
 *
 * Insertion runs over slots in DESCENDING order and pushes to the front, which
 * leaves every cell list in ascending slot order. Queries must still encode
 * their tie-breaks explicitly (docs/03 §10: lower squared distance, then lower
 * entity ID); the ordering is a readability guarantee, not a substitute.
 */
export class SpatialGrid {
  readonly size: number;
  readonly cellCount: number;
  readonly cellSizeLU: number;
  /** Cell edge in world sub-units. */
  readonly cellSizePos: number;
  readonly head: Int32Array;
  readonly next: Int32Array;

  /**
   * Cells that currently hold at least one organism.
   *
   * A rebuild clears only these instead of the whole grid. With a 128×128 grid
   * and two indexes per tick, blanket clearing costs 32 768 writes per tick
   * whatever the population is — measurable over a 100 000-tick soak, and
   * absurd once a world is nearly empty. At most one entry is recorded per
   * organism, so the buffer never needs more than the population cap.
   */
  readonly #occupiedCells: Int32Array;
  #occupiedCount = 0;

  constructor(worldSizeLU: number, cellSizeLU: number, capacity: number) {
    assert(
      Number.isSafeInteger(cellSizeLU) && cellSizeLU > 0,
      `spatial cell size must be positive, got ${cellSizeLU}`,
    );
    assert(
      worldSizeLU % cellSizeLU === 0,
      `spatial cell size ${cellSizeLU} must divide the world size ${worldSizeLU}`,
    );

    this.size = worldSizeLU / cellSizeLU;
    this.cellCount = this.size * this.size;
    this.cellSizeLU = cellSizeLU;
    this.cellSizePos = cellSizeLU * POS_SCALE;
    this.head = new Int32Array(this.cellCount);
    this.next = new Int32Array(capacity);
    this.head.fill(-1);
    this.#occupiedCells = new Int32Array(Math.min(this.cellCount, capacity));
  }

  /** Grid column for a world x in sub-units, clamped to the grid. */
  cellX(xPos: number): number {
    return clamp(Math.floor(xPos / this.cellSizePos), 0, this.size - 1);
  }

  /** Grid row for a world y in sub-units, clamped to the grid. */
  cellY(yPos: number): number {
    return clamp(Math.floor(yPos / this.cellSizePos), 0, this.size - 1);
  }

  /** Rebuild from current organism positions. Dead slots are skipped. */
  rebuild(store: OrganismStore): void {
    this.rebuildFrom(store.slotHighWater, store.alive, store.x, store.y);
  }

  /**
   * Rebuild from any Structure-of-Arrays occupancy + position triple.
   *
   * Carcasses need the same 3×3-neighbourhood lookup that organisms do — the
   * carrion sensor would otherwise scan every carcass in the world for every
   * organism, which is the O(N×M) shape the grid exists to avoid — and they are
   * a different store with a different capacity. Taking the arrays rather than
   * the store keeps one implementation of the grid instead of two.
   */
  rebuildFrom(
    slotHighWater: number,
    occupancy: Uint8Array,
    xPos: Int32Array,
    yPos: Int32Array,
  ): void {
    const head = this.head;
    const next = this.next;
    const occupied = this.#occupiedCells;
    for (let i = 0; i < this.#occupiedCount; i += 1) {
      head[occupied[i] as number] = -1;
    }
    let occupiedCount = 0;

    for (let slot = slotHighWater - 1; slot >= 0; slot -= 1) {
      if (occupancy[slot] !== 1) {
        continue;
      }
      const cell = this.cellY(yPos[slot] as number) * this.size + this.cellX(xPos[slot] as number);
      const first = head[cell] as number;
      if (first === -1) {
        occupied[occupiedCount] = cell;
        occupiedCount += 1;
      }
      next[slot] = first;
      head[cell] = slot;
    }
    this.#occupiedCount = occupiedCount;
  }

  /** Clear every cell list (used when the population is reset). */
  clear(): void {
    this.head.fill(-1);
    this.next.fill(-1);
    this.#occupiedCount = 0;
  }
}
