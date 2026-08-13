import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";

/**
 * Carrion as Structure-of-Arrays (docs/03 §§1, 23, docs/10 §1, task F01).
 *
 * A carcass is the only thing a death leaves behind, and it is what makes
 * carnivory possible without any predator role existing in the engine: a dead
 * body is a food source that anyone whose diet gene digests meat can compete
 * for, exactly as plant biomass is a food source anyone can graze.
 *
 * ## Layout mirrors OrganismStore, deliberately
 *
 * Same slot/identity split (docs/03 §5): a **slot** is a storage index that is
 * reused after the carcass is gone, while `entityId` is the *dead organism's*
 * monotonic ID and is never reused. That gives every carcass a stable identity
 * for tie-breaking and attribution without minting a second ID space — two
 * carcasses can never collide, because two organisms never shared an ID.
 *
 * Authoritative iteration is ascending slot index over `[0, slotHighWater)`,
 * and released slots are cleared, for the reasons OrganismStore documents.
 *
 * ## Everything here is authoritative
 *
 * Carcasses are sensed, eaten and decayed, so they are hashed and serialized in
 * full. The counters are the meat conservation audit: created == eaten +
 * decayed + what is still lying in the world, which is the invariant that
 * proves meat is neither conjured nor lost by a rounding mistake.
 */
export class CarcassStore {
  readonly capacity: number;

  /** 1 when the slot holds a carcass. */
  readonly active: Uint8Array;
  /** Entity ID of the organism that died here; never reused, never 0. */
  readonly entityId: Uint32Array;
  /** Position in world sub-units, fixed for the carcass's whole life. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** Meat units left to eat. Reaching 0 releases the slot. */
  readonly remainingMeat: Uint32Array;
  /** Species the dead organism belonged to (docs/03 §23); read by Milestone 8. */
  readonly sourceSpeciesId: Uint32Array;
  /**
   * Age in ticks, advanced by the decay phase.
   *
   * Its resolution is therefore `time.carcassDecayInterval`, not one tick: the
   * decay phase is the only phase that visits carcasses, and adding a per-tick
   * sweep purely to make this counter finer would cost the whole population's
   * worth of writes for a number nothing reads on a per-tick basis.
   */
  readonly ageTicks: Uint32Array;

  // --- Conservation counters ------------------------------------------------
  /** Cumulative meat units ever created. */
  totalMeatCreated = 0;
  /** Cumulative meat units eaten by organisms. */
  totalMeatEaten = 0;
  /** Cumulative meat units lost to decay. */
  totalMeatDecayed = 0;
  /** Cumulative carcasses created. */
  totalCreated = 0;
  /**
   * Cumulative carcasses that were never created because every slot was taken.
   *
   * docs/10 §14 requires the carcass cap to be a deterministic skip with a
   * diagnostics metric — never a random replacement of an existing carcass.
   * This counter is what makes "the world is losing carrion to its ceiling"
   * visible, the same role `capRejectedBirths` plays for the population cap.
   */
  skippedAtCap = 0;

  // --- Slot bookkeeping -----------------------------------------------------
  readonly freeSlots: Int32Array;
  #freeCount = 0;
  #slotHighWater = 0;
  #liveCount = 0;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `carcass capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;
    this.active = new Uint8Array(capacity);
    this.entityId = new Uint32Array(capacity);
    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.remainingMeat = new Uint32Array(capacity);
    this.sourceSpeciesId = new Uint32Array(capacity);
    this.ageTicks = new Uint32Array(capacity);
    this.freeSlots = new Int32Array(capacity);
  }

  /** Number of carcasses currently lying in the world. */
  get liveCount(): number {
    return this.#liveCount;
  }

  /** Exclusive upper bound for authoritative ascending-slot iteration. */
  get slotHighWater(): number {
    return this.#slotHighWater;
  }

  /** Number of released slots waiting for reuse. */
  get freeCount(): number {
    return this.#freeCount;
  }

  isActiveSlot(slot: number): boolean {
    return slot >= 0 && slot < this.capacity && this.active[slot] === 1;
  }

  /** Whether {@link create} would succeed right now. */
  canAllocate(): boolean {
    return this.#freeCount > 0 || this.#slotHighWater < this.capacity;
  }

  /**
   * Add a carcass and return its slot, or -1 when the cap is reached.
   *
   * Returning -1 rather than evicting is the docs/10 §14 rule: at the cap the
   * carcass is deterministically skipped and counted, because evicting an
   * existing carcass would delete food that organisms can already see and are
   * possibly already claiming.
   */
  create(
    entityId: number,
    xPos: number,
    yPos: number,
    meat: number,
    sourceSpeciesId: number,
  ): number {
    assert(entityId !== 0, "a carcass must carry the dead organism's entity ID, not 0");
    assert(
      Number.isSafeInteger(meat) && meat >= 0,
      `carcass meat must be a non-negative integer, got ${meat}`,
    );
    if (!this.canAllocate()) {
      this.skippedAtCap += 1;
      return -1;
    }

    let slot: number;
    if (this.#freeCount > 0) {
      this.#freeCount -= 1;
      slot = this.freeSlots[this.#freeCount] as number;
    } else {
      slot = this.#slotHighWater;
      this.#slotHighWater += 1;
    }

    this.active[slot] = 1;
    this.entityId[slot] = entityId;
    this.x[slot] = xPos;
    this.y[slot] = yPos;
    this.remainingMeat[slot] = meat;
    this.sourceSpeciesId[slot] = sourceSpeciesId;
    this.ageTicks[slot] = 0;
    this.#liveCount += 1;
    this.totalCreated += 1;
    this.totalMeatCreated += meat;
    return slot;
  }

  /** Remove a carcass and return its slot to the free stack. */
  release(slot: number): void {
    assert(
      slot >= 0 && slot < this.capacity,
      `carcass release out of range: ${slot} (capacity ${this.capacity})`,
    );
    assert(this.active[slot] === 1, `carcass release on an inactive slot: ${slot}`);
    this.clearSlot(slot);
    this.#liveCount -= 1;
    this.freeSlots[this.#freeCount] = slot;
    this.#freeCount += 1;
  }

  /** Zero every field of one slot. */
  clearSlot(slot: number): void {
    this.active[slot] = 0;
    this.entityId[slot] = 0;
    this.x[slot] = 0;
    this.y[slot] = 0;
    this.remainingMeat[slot] = 0;
    this.sourceSpeciesId[slot] = 0;
    this.ageTicks[slot] = 0;
  }

  /**
   * Take `units` of meat from a carcass, counting it as eaten.
   *
   * The caller has already resolved how much this claimant may have, so the
   * amount is asserted rather than clamped: a request above what is left means
   * the allocation is wrong, and silently trimming it would hide the bug while
   * breaking conservation.
   */
  consume(slot: number, units: number): void {
    assert(this.active[slot] === 1, `carcass consume on an inactive slot: ${slot}`);
    const remaining = this.remainingMeat[slot] as number;
    assert(
      Number.isSafeInteger(units) && units >= 0 && units <= remaining,
      `carcass consume of ${units} units exceeds the ${remaining} left in slot ${slot}`,
    );
    this.remainingMeat[slot] = remaining - units;
    this.totalMeatEaten += units;
  }

  /** Remove `units` of meat to decay, and report the amount actually lost. */
  decay(slot: number, units: number): number {
    assert(this.active[slot] === 1, `carcass decay on an inactive slot: ${slot}`);
    const remaining = this.remainingMeat[slot] as number;
    const lost = Math.min(Math.max(units, 0), remaining);
    this.remainingMeat[slot] = remaining - lost;
    this.totalMeatDecayed += lost;
    return lost;
  }

  /** Total meat lying in the world right now; the conservation audit's third term. */
  totalRemainingMeat(): number {
    let total = 0;
    for (let slot = 0; slot < this.#slotHighWater; slot += 1) {
      total += this.remainingMeat[slot] as number;
    }
    return total;
  }

  /** Drop every carcass and reset bookkeeping (used by snapshot restore). */
  reset(): void {
    for (let slot = 0; slot < this.#slotHighWater; slot += 1) {
      this.clearSlot(slot);
    }
    this.freeSlots.fill(0);
    this.totalMeatCreated = 0;
    this.totalMeatEaten = 0;
    this.totalMeatDecayed = 0;
    this.totalCreated = 0;
    this.skippedAtCap = 0;
    this.#freeCount = 0;
    this.#slotHighWater = 0;
    this.#liveCount = 0;
  }

  /**
   * Restore slot bookkeeping from a snapshot.
   *
   * The per-slot arrays are already written; this adopts the saved free stack
   * verbatim and rebuilds the derived live count. The stack cannot be
   * reconstructed by scanning for inactive slots: that would change which slot
   * the next death reuses, and with it which carcass a later tie-break picks
   * (docs/10 §18).
   */
  adoptSlotState(slotHighWater: number, freeSlots: ArrayLike<number>, freeCount: number): void {
    assert(
      Number.isSafeInteger(slotHighWater) && slotHighWater >= 0 && slotHighWater <= this.capacity,
      `restored carcass slotHighWater out of range: ${slotHighWater}`,
    );
    assert(
      Number.isSafeInteger(freeCount) && freeCount >= 0 && freeCount <= slotHighWater,
      `restored carcass freeCount out of range: ${freeCount}`,
    );

    this.#slotHighWater = slotHighWater;
    this.#freeCount = freeCount;
    this.freeSlots.fill(0);
    const seen = new Set<number>();
    for (let i = 0; i < freeCount; i += 1) {
      const slot = freeSlots[i] as number;
      assert(
        Number.isSafeInteger(slot) && slot >= 0 && slot < slotHighWater,
        `restored free carcass slot out of range: ${slot}`,
      );
      assert(this.active[slot] === 0, `restored free carcass slot ${slot} is marked active`);
      assert(!seen.has(slot), `restored free carcass slot ${slot} appears twice in the free list`);
      seen.add(slot);
      this.freeSlots[i] = slot;
    }

    this.#liveCount = 0;
    for (let slot = 0; slot < slotHighWater; slot += 1) {
      if (this.active[slot] !== 1) {
        continue;
      }
      assert(
        (this.entityId[slot] as number) !== 0,
        `restored active carcass slot ${slot} has the invalid entity ID 0`,
      );
      this.#liveCount += 1;
    }

    assert(
      this.#liveCount + freeCount === slotHighWater,
      `restored carcass slot bookkeeping is inconsistent: ${this.#liveCount} active + ` +
        `${freeCount} free !== ${slotHighWater} used slots`,
    );
  }

  /**
   * Feed authoritative carcass state into the canonical state hash.
   *
   * Only the used prefix is hashed, with the high-water mark in the stream, for
   * the reasons OrganismStore.hashInto documents. The order is a hashing
   * contract: changing it changes every world hash from the first death onward.
   */
  hashInto(hasher: StateHash): void {
    const used = this.#slotHighWater;
    hasher.word(this.capacity);
    hasher.word(used);
    hasher.word(this.#liveCount);
    hasher.word(this.#freeCount);
    hasher.array(HASH_TAG.i32, this.freeSlots.subarray(0, this.#freeCount));
    hasher.safeInteger(this.totalCreated);
    hasher.safeInteger(this.skippedAtCap);
    hasher.safeInteger(this.totalMeatCreated);
    hasher.safeInteger(this.totalMeatEaten);
    hasher.safeInteger(this.totalMeatDecayed);

    hasher.array(HASH_TAG.u8, this.active.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.entityId.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.x.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.y.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.remainingMeat.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.sourceSpeciesId.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.ageTicks.subarray(0, used));
  }
}
