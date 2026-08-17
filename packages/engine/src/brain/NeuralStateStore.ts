import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { BRAIN_HIDDEN_COUNT } from "./BrainLayout";
import { BRAIN_MEMORY_COUNT } from "./NeuralTopology";

/**
 * What an organism carries from one tick to the next (M16, docs/11 §M16).
 *
 * ## This is authoritative, and that is the whole difference
 *
 * M14's `MorphologyStore` and M15's `PhysicalPhenotypeStore` are derived
 * caches: pure functions of the genome, never hashed, never serialized, rebuilt
 * on restore. Neural state is the opposite of that in every respect. It is not
 * derivable from the genome — it is the *history* the genome's network has
 * accumulated — so it is hashed with the world, written into every snapshot,
 * and restored verbatim.
 *
 * That is not a detail; it is what "memory" means. An organism that has learned
 * where it fed, or that is halfway through an alternation, must still be that
 * organism after a save and load, after a rewind, and in every branch taken
 * from the same tick. If this store were rebuilt rather than restored, a rewind
 * would silently give every organism amnesia and two branches from one save
 * would diverge for no reason a player could see.
 *
 * ## Bounded, like everything else
 *
 * `BRAIN_HIDDEN_COUNT + BRAIN_MEMORY_COUNT` Int16 values per organism — 16
 * numbers, 32 bytes — and the count is a compile-time constant. No organism
 * owns a buffer, nothing grows, and clearing a slot is two `fill` calls.
 */
export class NeuralStateStore {
  readonly capacity: number;

  /**
   * Each hidden unit's activation at the end of the previous tick, in `[-Q, Q]`.
   *
   * Read by hidden units whose recurrent bit is set; ignored by the rest. Kept
   * for every unit regardless, because a lineage that switches recurrence back
   * on should resume from the state its network was actually in rather than
   * from a zero that never occurred.
   */
  readonly hiddenPrevQ: Int16Array;

  /**
   * Generic memory registers, in `[-Q, Q]`.
   *
   * Numbered, never named (ADR 0027). The engine does not know and must never
   * learn what a lineage keeps in `memory2`.
   */
  readonly memoryQ: Int16Array;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `neural state capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;
    this.hiddenPrevQ = new Int16Array(capacity * BRAIN_HIDDEN_COUNT);
    this.memoryQ = new Int16Array(capacity * BRAIN_MEMORY_COUNT);
  }

  /** Offset of a slot's hidden-state block. */
  hiddenOffset(slot: number): number {
    return slot * BRAIN_HIDDEN_COUNT;
  }

  /** Offset of a slot's memory block. */
  memoryOffset(slot: number): number {
    return slot * BRAIN_MEMORY_COUNT;
  }

  /**
   * Wipe one slot's state.
   *
   * Called at spawn and when a slot is released. A newborn inherits its
   * parent's genome, not its parent's thoughts: memory is what an organism has
   * lived, and there is no mechanism in this project by which experience is
   * inherited. A slot recycled without this would hand the dead occupant's
   * memories to whoever lands there next, which is the storage layer leaking
   * into biology.
   */
  clearSlot(slot: number): void {
    const hidden = this.hiddenOffset(slot);
    this.hiddenPrevQ.fill(0, hidden, hidden + BRAIN_HIDDEN_COUNT);
    const memory = this.memoryOffset(slot);
    this.memoryQ.fill(0, memory, memory + BRAIN_MEMORY_COUNT);
  }

  /** Hash the used prefix, exactly as the genome store does. */
  hashInto(hasher: StateHash, usedSlots: number): void {
    hasher.array(HASH_TAG.i16, this.hiddenPrevQ.subarray(0, usedSlots * BRAIN_HIDDEN_COUNT));
    hasher.array(HASH_TAG.i16, this.memoryQ.subarray(0, usedSlots * BRAIN_MEMORY_COUNT));
  }
}
