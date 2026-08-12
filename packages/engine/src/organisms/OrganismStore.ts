import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { DEATH_CAUSE_COUNT } from "./death";

/**
 * Live organism state as Structure-of-Arrays (docs/03 §§5-6, docs/10 §6,
 * task D01).
 *
 * Thousands of organisms are never nested class instances (CLAUDE.md data
 * layout rule): every field is one TypedArray indexed by slot, so the hot
 * loops walk contiguous memory and allocate nothing per tick.
 *
 * ## Slots and entity IDs are different things
 *
 * A **slot** is a storage index in `[0, capacity)`. It is reused after a death.
 * An **entity ID** is a monotonic uint32 identity, never reused, with 0 meaning
 * "no entity" (docs/03 §5). Two organisms can share a slot across time; they
 * can never share an ID. Anything that must remain stable across a death —
 * parent links, event records, kill attribution — stores IDs, never slots.
 *
 * ## Deterministic allocation
 *
 * Slots come from a LIFO free stack; when the stack is empty a fresh slot is
 * taken from the never-used region. The stack contents are authoritative state
 * and are serialized, because "which slot did this birth land in" changes the
 * ascending-slot iteration order and therefore future outcomes (docs/10 §14).
 *
 * Authoritative iteration is always ascending slot index over
 * `[0, slotHighWater)`.
 *
 * ## Released slots are cleared
 *
 * `releaseSlot` zeroes the row. Nothing reads a dead slot, but leaving stale
 * bytes there would make the state hash depend on the history of the dead, and
 * would force snapshots to preserve garbage to stay bit-identical.
 */
export class OrganismStore {
  readonly capacity: number;

  // --- Identity and liveness ------------------------------------------------
  readonly alive: Uint8Array;
  readonly entityId: Uint32Array;
  readonly parentEntityId: Uint32Array;
  readonly generation: Uint32Array;
  readonly speciesId: Uint32Array;

  // --- Kinematics -----------------------------------------------------------
  /** Position in world sub-units (POS_SCALE per LU). */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /**
   * Sub-sub-unit position remainder in `[0, VELOCITY_SCALE)`.
   *
   * Velocities are finer than one position sub-unit — the slowest genome moves
   * 9 sub-units per tick at full throttle, so truncating each tick's step would
   * quantize slow organisms into stillness and bias selection against low speed
   * genes. The remainder carries the fraction forward instead.
   */
  readonly posFracX: Uint8Array;
  readonly posFracY: Uint8Array;
  /** Velocity in velocity units (VELOCITY_SCALE per sub-unit per tick). */
  readonly vx: Int32Array;
  readonly vy: Int32Array;
  /** Heading in `[0, ANGLE_STEPS)`. */
  readonly angle: Uint16Array;

  // --- Physiology -----------------------------------------------------------
  readonly energy: Int32Array;
  readonly healthQ: Uint16Array;
  readonly ageTicks: Uint32Array;
  /** Realized development in `[birthSizeFractionQ, Q]` (docs/04 §4). */
  readonly developmentQ: Uint16Array;
  /** Consecutive ticks spent in water, for the drowning grace period. */
  readonly waterTicks: Uint16Array;
  readonly lastDamageQ: Uint16Array;
  readonly attackCooldown: Uint16Array;

  // --- Lifetime counters ----------------------------------------------------
  readonly plantEnergyEaten: Uint32Array;
  readonly meatEnergyEaten: Uint32Array;
  readonly kills: Uint16Array;

  // --- Population counters --------------------------------------------------
  /**
   * Cumulative deaths per {@link DeathCause}, and their total.
   *
   * Authoritative rather than diagnostic: docs/02 §9 lists the statistics
   * accumulators that event detection reads as saved state, and a counter that
   * reset on reload would make a boom/crash or mass-extinction event depend on
   * when the player last saved.
   */
  readonly deathsByCause: Uint32Array;
  totalDeaths = 0;
  /** Cumulative births, including the founder generation. */
  totalBirths = 0;

  // --- Slot bookkeeping -----------------------------------------------------
  /** LIFO stack of released slots. */
  readonly freeSlots: Int32Array;
  #freeCount = 0;
  /** Slots `[0, slotHighWater)` have been used at least once. */
  #slotHighWater = 0;
  #liveCount = 0;
  /** Next entity ID to hand out. Starts at 1 because 0 is invalid. */
  #nextEntityId = 1;

  /** Entity ID → slot, for queries only. Its iteration order is never used. */
  readonly #slotByEntityId = new Map<number, number>();

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `organism capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;

    this.alive = new Uint8Array(capacity);
    this.entityId = new Uint32Array(capacity);
    this.parentEntityId = new Uint32Array(capacity);
    this.generation = new Uint32Array(capacity);
    this.speciesId = new Uint32Array(capacity);

    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.posFracX = new Uint8Array(capacity);
    this.posFracY = new Uint8Array(capacity);
    this.vx = new Int32Array(capacity);
    this.vy = new Int32Array(capacity);
    this.angle = new Uint16Array(capacity);

    this.energy = new Int32Array(capacity);
    this.healthQ = new Uint16Array(capacity);
    this.ageTicks = new Uint32Array(capacity);
    this.developmentQ = new Uint16Array(capacity);
    this.waterTicks = new Uint16Array(capacity);
    this.lastDamageQ = new Uint16Array(capacity);
    this.attackCooldown = new Uint16Array(capacity);

    this.plantEnergyEaten = new Uint32Array(capacity);
    this.meatEnergyEaten = new Uint32Array(capacity);
    this.kills = new Uint16Array(capacity);

    this.freeSlots = new Int32Array(capacity);
    this.deathsByCause = new Uint32Array(DEATH_CAUSE_COUNT);
  }

  /** Number of living organisms. */
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

  /** Entity ID that the next allocation will use. */
  get nextEntityId(): number {
    return this.#nextEntityId;
  }

  isAliveSlot(slot: number): boolean {
    return slot >= 0 && slot < this.capacity && this.alive[slot] === 1;
  }

  /** Slot holding this entity ID, or -1 if it is dead or never existed. */
  findSlotByEntityId(id: number): number {
    return this.#slotByEntityId.get(id) ?? -1;
  }

  /**
   * Claim a slot and a fresh entity ID, or -1 when the population cap is
   * reached.
   *
   * Returning -1 rather than throwing is deliberate: the cap is a safety limit
   * whose only correct response is a deterministic rejection plus diagnostics,
   * never a silent cull (docs/03 §2).
   */
  allocateSlot(): number {
    let slot: number;
    if (this.#freeCount > 0) {
      this.#freeCount -= 1;
      slot = this.freeSlots[this.#freeCount] as number;
    } else if (this.#slotHighWater < this.capacity) {
      slot = this.#slotHighWater;
      this.#slotHighWater += 1;
    } else {
      return -1;
    }

    assert(
      this.#nextEntityId <= 0xffffffff,
      "entity IDs are exhausted: the uint32 identity space would have to be reused, which " +
        "would silently merge distinct lineages",
    );

    const id = this.#nextEntityId;
    this.#nextEntityId += 1;
    this.entityId[slot] = id;
    this.alive[slot] = 1;
    this.#liveCount += 1;
    this.#slotByEntityId.set(id, slot);
    return slot;
  }

  /** Return a slot to the free stack and clear its row. */
  releaseSlot(slot: number): void {
    assert(
      slot >= 0 && slot < this.capacity,
      `releaseSlot out of range: ${slot} (capacity ${this.capacity})`,
    );
    assert(this.alive[slot] === 1, `releaseSlot called on a slot that is not alive: ${slot}`);

    this.#slotByEntityId.delete(this.entityId[slot] as number);
    this.clearSlot(slot);
    this.#liveCount -= 1;
    this.freeSlots[this.#freeCount] = slot;
    this.#freeCount += 1;
  }

  /** Zero every field of one slot. */
  clearSlot(slot: number): void {
    this.alive[slot] = 0;
    this.entityId[slot] = 0;
    this.parentEntityId[slot] = 0;
    this.generation[slot] = 0;
    this.speciesId[slot] = 0;
    this.x[slot] = 0;
    this.y[slot] = 0;
    this.posFracX[slot] = 0;
    this.posFracY[slot] = 0;
    this.vx[slot] = 0;
    this.vy[slot] = 0;
    this.angle[slot] = 0;
    this.energy[slot] = 0;
    this.healthQ[slot] = 0;
    this.ageTicks[slot] = 0;
    this.developmentQ[slot] = 0;
    this.waterTicks[slot] = 0;
    this.lastDamageQ[slot] = 0;
    this.attackCooldown[slot] = 0;
    this.plantEnergyEaten[slot] = 0;
    this.meatEnergyEaten[slot] = 0;
    this.kills[slot] = 0;
  }

  /** Drop every organism and reset slot bookkeeping (used by snapshot restore). */
  reset(): void {
    for (let slot = 0; slot < this.#slotHighWater; slot += 1) {
      this.clearSlot(slot);
    }
    this.freeSlots.fill(0);
    this.deathsByCause.fill(0);
    this.totalDeaths = 0;
    this.totalBirths = 0;
    this.#freeCount = 0;
    this.#slotHighWater = 0;
    this.#liveCount = 0;
    this.#nextEntityId = 1;
    this.#slotByEntityId.clear();
  }

  /**
   * Restore slot bookkeeping from a snapshot.
   *
   * The caller has already written the per-slot arrays; this rebuilds the
   * derived live count and ID index and adopts the saved free stack verbatim.
   * Reconstructing the stack by scanning for dead slots instead would produce a
   * *different* reuse order and diverge on the next birth (docs/10 §18).
   */
  adoptSlotState(
    slotHighWater: number,
    freeSlots: ArrayLike<number>,
    freeCount: number,
    nextEntityId: number,
  ): void {
    assert(
      Number.isSafeInteger(slotHighWater) && slotHighWater >= 0 && slotHighWater <= this.capacity,
      `restored slotHighWater out of range: ${slotHighWater}`,
    );
    assert(
      Number.isSafeInteger(freeCount) && freeCount >= 0 && freeCount <= slotHighWater,
      `restored freeCount out of range: ${freeCount}`,
    );
    assert(
      Number.isSafeInteger(nextEntityId) && nextEntityId >= 1 && nextEntityId <= 0x100000000,
      `restored nextEntityId out of range: ${nextEntityId}`,
    );

    this.#slotHighWater = slotHighWater;
    this.#freeCount = freeCount;
    this.#nextEntityId = nextEntityId;
    this.freeSlots.fill(0);
    for (let i = 0; i < freeCount; i += 1) {
      const slot = freeSlots[i] as number;
      assert(
        Number.isSafeInteger(slot) && slot >= 0 && slot < slotHighWater,
        `restored free slot out of range: ${slot}`,
      );
      assert(this.alive[slot] === 0, `restored free slot ${slot} is marked alive`);
      this.freeSlots[i] = slot;
    }

    this.#liveCount = 0;
    this.#slotByEntityId.clear();
    for (let slot = 0; slot < slotHighWater; slot += 1) {
      if (this.alive[slot] !== 1) {
        continue;
      }
      const id = this.entityId[slot] as number;
      assert(id !== 0, `restored live slot ${slot} has the invalid entity ID 0`);
      assert(id < nextEntityId, `restored live slot ${slot} has an unissued entity ID ${id}`);
      assert(!this.#slotByEntityId.has(id), `restored entity ID ${id} appears in two slots`);
      this.#slotByEntityId.set(id, slot);
      this.#liveCount += 1;
    }
  }

  /**
   * Feed authoritative organism state into the canonical state hash.
   *
   * Only the used prefix `[0, slotHighWater)` is hashed: slots beyond it have
   * never been written and are all zero, and `slotHighWater` itself is hashed,
   * so the stream stays unambiguous while staying proportional to the
   * population rather than to the 8192-slot capacity.
   *
   * The order is a hashing contract — changing it changes every world hash and
   * requires an ENGINE_VERSION bump.
   */
  hashInto(hasher: StateHash): void {
    const used = this.#slotHighWater;
    hasher.word(this.capacity);
    hasher.word(used);
    hasher.word(this.#liveCount);
    hasher.word(this.#nextEntityId);
    hasher.word(this.#freeCount);
    hasher.array(HASH_TAG.i32, this.freeSlots.subarray(0, this.#freeCount));
    hasher.safeInteger(this.totalBirths);
    hasher.safeInteger(this.totalDeaths);
    hasher.array(HASH_TAG.u32, this.deathsByCause);

    hasher.array(HASH_TAG.u8, this.alive.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.entityId.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.parentEntityId.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.generation.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.speciesId.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.x.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.y.subarray(0, used));
    hasher.array(HASH_TAG.u8, this.posFracX.subarray(0, used));
    hasher.array(HASH_TAG.u8, this.posFracY.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.vx.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.vy.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.angle.subarray(0, used));
    hasher.array(HASH_TAG.i32, this.energy.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.healthQ.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.ageTicks.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.developmentQ.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.waterTicks.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.lastDamageQ.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.attackCooldown.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.plantEnergyEaten.subarray(0, used));
    hasher.array(HASH_TAG.u32, this.meatEnergyEaten.subarray(0, used));
    hasher.array(HASH_TAG.u16, this.kills.subarray(0, used));
  }
}
