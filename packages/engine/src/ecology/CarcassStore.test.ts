import { describe, expect, it } from "vitest";
import { StateHash } from "../math/hash";
import { CarcassStore } from "./CarcassStore";
import { captureCarcasses, restoreCarcasses, CarcassSnapshotError } from "./carcassSnapshot";

/**
 * Carcass store mechanics (docs/03 §23, task F01).
 *
 * The store's contract is the same one OrganismStore has to honour — reusable
 * slots, never-reused identities, a serialized free list — plus one it does not:
 * meat conservation. Every unit created must end up eaten, decayed or still
 * lying in the world.
 */

function create(store: CarcassStore, id: number, meat: number): number {
  return store.create(id, 100 * id, 200 * id, meat, 1);
}

describe("carcass slots", () => {
  it("hands out ascending slots and tracks the high-water mark", () => {
    const store = new CarcassStore(4);
    expect(create(store, 1, 50)).toBe(0);
    expect(create(store, 2, 50)).toBe(1);
    expect(store.slotHighWater).toBe(2);
    expect(store.liveCount).toBe(2);
    expect(store.freeCount).toBe(0);
  });

  it("reuses released slots LIFO and clears the released row", () => {
    const store = new CarcassStore(4);
    create(store, 1, 50);
    const second = create(store, 2, 60);
    create(store, 3, 70);

    store.release(second);
    expect(store.active[second]).toBe(0);
    expect(store.entityId[second]).toBe(0);
    expect(store.remainingMeat[second]).toBe(0);
    expect(store.liveCount).toBe(2);
    expect(store.freeCount).toBe(1);

    // LIFO: the most recently released slot comes back first.
    expect(create(store, 4, 80)).toBe(second);
    expect(store.slotHighWater).toBe(3);
  });

  it("skips deterministically at the cap and counts the skip", () => {
    const store = new CarcassStore(2);
    create(store, 1, 10);
    create(store, 2, 10);
    expect(store.canAllocate()).toBe(false);

    // docs/10 §14: skip plus diagnostics, never a random replacement.
    expect(create(store, 3, 10)).toBe(-1);
    expect(store.skippedAtCap).toBe(1);
    expect(store.liveCount).toBe(2);
    expect(store.entityId[0]).toBe(1);
    expect(store.entityId[1]).toBe(2);
    expect(store.totalMeatCreated).toBe(20);
  });

  it("refuses a carcass without an entity identity", () => {
    const store = new CarcassStore(2);
    expect(() => store.create(0, 0, 0, 10, 1)).toThrow(/entity ID/);
  });
});

describe("meat accounting", () => {
  it("conserves every unit across eating, decay and what is left", () => {
    const store = new CarcassStore(4);
    const a = create(store, 1, 100);
    const b = create(store, 2, 40);

    store.consume(a, 30);
    store.decay(a, 10);
    store.consume(b, 40);

    expect(store.totalMeatCreated).toBe(140);
    expect(store.totalMeatEaten).toBe(70);
    expect(store.totalMeatDecayed).toBe(10);
    expect(store.totalRemainingMeat()).toBe(60);
    expect(store.totalMeatEaten + store.totalMeatDecayed + store.totalRemainingMeat()).toBe(
      store.totalMeatCreated,
    );
  });

  it("rejects consuming more than a carcass holds instead of clamping", () => {
    const store = new CarcassStore(2);
    const slot = create(store, 1, 25);
    // Clamping would hide a broken allocation while quietly breaking
    // conservation, so this is an assertion rather than a Math.min.
    expect(() => store.consume(slot, 26)).toThrow(/exceeds/);
  });

  it("clamps decay to what is left and reports what was actually lost", () => {
    const store = new CarcassStore(2);
    const slot = create(store, 1, 5);
    expect(store.decay(slot, 9)).toBe(5);
    expect(store.remainingMeat[slot]).toBe(0);
    expect(store.totalMeatDecayed).toBe(5);
  });

  it("refuses a body worth more meat than the Uint32 row can hold", () => {
    const store = new CarcassStore(2);
    // The row would wrap while totalMeatCreated kept the full amount, so the
    // store would report having created meat it does not hold. The config
    // validator makes this unreachable; the assertion is what guarantees it can
    // never happen silently if some future path bypasses the validator.
    expect(() => create(store, 1, 4_294_967_296)).toThrow(/remainingMeat row/);
    expect(store.totalMeatCreated).toBe(0);
    expect(store.liveCount).toBe(0);
  });

  it("accepts the largest value the row can hold", () => {
    const store = new CarcassStore(2);
    const slot = create(store, 1, 4_294_967_295);
    expect(store.remainingMeat[slot]).toBe(4_294_967_295);
    expect(store.totalMeatEaten + store.totalMeatDecayed + store.totalRemainingMeat()).toBe(
      store.totalMeatCreated,
    );
  });
});

describe("carcass hashing", () => {
  function digest(store: CarcassStore): string {
    const hasher = new StateHash();
    store.hashInto(hasher);
    return hasher.digest();
  }

  it("distinguishes two stores that differ only in remaining meat", () => {
    const a = new CarcassStore(4);
    const b = new CarcassStore(4);
    create(a, 1, 50);
    create(b, 1, 51);
    expect(digest(a)).not.toBe(digest(b));
  });

  it("distinguishes two stores that differ only in free-list order", () => {
    const a = new CarcassStore(4);
    const b = new CarcassStore(4);
    for (const store of [a, b]) {
      create(store, 1, 10);
      create(store, 2, 10);
      create(store, 3, 10);
    }
    a.release(0);
    a.release(1);
    b.release(1);
    b.release(0);
    // The free list decides which slot the next death reuses, so its order is
    // authoritative and must be visible to the hash.
    expect(digest(a)).not.toBe(digest(b));
  });

  it("ignores slots beyond the high-water mark", () => {
    const small = new CarcassStore(4);
    const large = new CarcassStore(4);
    create(small, 1, 10);
    create(large, 1, 10);
    expect(digest(small)).toBe(digest(large));
  });
});

describe("carcass snapshot", () => {
  it("round-trips state, counters and the free list verbatim", () => {
    const store = new CarcassStore(8);
    create(store, 1, 100);
    const second = create(store, 2, 50);
    create(store, 3, 25);
    store.consume(second, 10);
    store.release(0);
    store.decay(second, 5);

    const snapshot = captureCarcasses(store);
    const restored = new CarcassStore(8);
    restoreCarcasses(snapshot, restored);

    expect(restored.slotHighWater).toBe(store.slotHighWater);
    expect(restored.liveCount).toBe(store.liveCount);
    expect(restored.freeCount).toBe(store.freeCount);
    expect(restored.totalMeatCreated).toBe(store.totalMeatCreated);
    expect(restored.totalMeatEaten).toBe(store.totalMeatEaten);
    expect(restored.totalMeatDecayed).toBe(store.totalMeatDecayed);
    expect(restored.totalCreated).toBe(store.totalCreated);

    const hash = (s: CarcassStore): string => {
      const hasher = new StateHash();
      s.hashInto(hasher);
      return hasher.digest();
    };
    expect(hash(restored)).toBe(hash(store));

    // The next carcass must land in the same slot on both sides, or the two
    // worlds diverge on the very next death.
    expect(create(restored, 9, 10)).toBe(create(store, 9, 10));
  });

  it("rejects a capacity mismatch", () => {
    const store = new CarcassStore(4);
    create(store, 1, 10);
    expect(() => restoreCarcasses(captureCarcasses(store), new CarcassStore(8))).toThrow(
      CarcassSnapshotError,
    );
  });

  it("rejects a free list that names an active slot", () => {
    const store = new CarcassStore(4);
    create(store, 1, 10);
    create(store, 2, 10);
    const snapshot = captureCarcasses(store);
    snapshot.freeSlots = new Int32Array([0]);
    expect(() => restoreCarcasses(snapshot, new CarcassStore(4))).toThrow(/marked active/);
  });

  it("rejects a free list that names the same slot twice", () => {
    const store = new CarcassStore(4);
    create(store, 1, 10);
    create(store, 2, 10);
    store.release(0);
    store.release(1);
    const snapshot = captureCarcasses(store);
    snapshot.freeSlots = new Int32Array([0, 0]);
    expect(() => restoreCarcasses(snapshot, new CarcassStore(4))).toThrow(/appears twice/);
  });

  it("rejects bookkeeping that leaks a slot", () => {
    const store = new CarcassStore(4);
    create(store, 1, 10);
    create(store, 2, 10);
    store.release(1);
    const snapshot = captureCarcasses(store);
    // Slot 1 is neither active nor free: a restored world would lose it forever.
    snapshot.freeSlots = new Int32Array(0);
    expect(() => restoreCarcasses(snapshot, new CarcassStore(4))).toThrow(/inconsistent/);
  });
});
