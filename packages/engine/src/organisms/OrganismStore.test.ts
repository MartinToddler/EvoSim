import { describe, expect, it } from "vitest";
import { EonAssertionError } from "@eon/shared";
import { OrganismStore } from "./OrganismStore";

/**
 * Slot lifecycle and identity rules (docs/03 §5, docs/10 §6, task D01).
 */
describe("OrganismStore slot allocation", () => {
  it("hands out fresh slots in ascending order and tracks the high-water mark", () => {
    const store = new OrganismStore(8);
    expect(store.slotHighWater).toBe(0);
    expect(store.liveCount).toBe(0);

    expect(store.allocateSlot()).toBe(0);
    expect(store.allocateSlot()).toBe(1);
    expect(store.allocateSlot()).toBe(2);
    expect(store.slotHighWater).toBe(3);
    expect(store.liveCount).toBe(3);
  });

  it("reuses released slots LIFO, which is part of the deterministic semantics", () => {
    const store = new OrganismStore(8);
    for (let i = 0; i < 4; i += 1) {
      store.allocateSlot();
    }
    store.releaseSlot(1);
    store.releaseSlot(3);
    expect(store.freeCount).toBe(2);

    // Last released comes back first (docs/10 §14).
    expect(store.allocateSlot()).toBe(3);
    expect(store.allocateSlot()).toBe(1);
    expect(store.freeCount).toBe(0);
    // The high-water mark never shrinks.
    expect(store.slotHighWater).toBe(4);
  });

  it("prefers the free list over untouched capacity", () => {
    const store = new OrganismStore(8);
    store.allocateSlot();
    store.allocateSlot();
    store.releaseSlot(0);
    expect(store.allocateSlot()).toBe(0);
    expect(store.slotHighWater).toBe(2);
  });

  it("returns -1 at the population cap instead of throwing or culling", () => {
    const store = new OrganismStore(2);
    expect(store.allocateSlot()).toBe(0);
    expect(store.allocateSlot()).toBe(1);
    // docs/03 §2: reaching the cap is a deterministic rejection, never a
    // silent cull of somebody already alive.
    expect(store.allocateSlot()).toBe(-1);
    expect(store.liveCount).toBe(2);
  });

  it("clears every field of a released slot", () => {
    const store = new OrganismStore(4);
    const slot = store.allocateSlot();
    store.x[slot] = 1234;
    store.energy[slot] = 5678;
    store.healthQ[slot] = 4096;
    store.generation[slot] = 9;
    store.kills[slot] = 3;

    store.releaseSlot(slot);

    expect(store.alive[slot]).toBe(0);
    expect(store.entityId[slot]).toBe(0);
    expect(store.x[slot]).toBe(0);
    expect(store.energy[slot]).toBe(0);
    expect(store.healthQ[slot]).toBe(0);
    expect(store.generation[slot]).toBe(0);
    expect(store.kills[slot]).toBe(0);
  });

  it("refuses to release a slot that is not alive", () => {
    const store = new OrganismStore(4);
    expect(() => store.releaseSlot(0)).toThrow(EonAssertionError);
    const slot = store.allocateSlot();
    store.releaseSlot(slot);
    expect(() => store.releaseSlot(slot)).toThrow(EonAssertionError);
  });
});

describe("OrganismStore entity identity", () => {
  it("never issues entity ID 0", () => {
    const store = new OrganismStore(4);
    const slot = store.allocateSlot();
    expect(store.entityId[slot]).toBe(1);
  });

  it("never reuses an entity ID, even when the slot is reused", () => {
    const store = new OrganismStore(4);
    const seen = new Set<number>();
    for (let round = 0; round < 50; round += 1) {
      const slot = store.allocateSlot();
      const id = store.entityId[slot] as number;
      expect(id).not.toBe(0);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      store.releaseSlot(slot);
    }
    // Every allocation landed in slot 0 (LIFO), yet all 50 IDs were distinct.
    expect(seen.size).toBe(50);
    expect(store.slotHighWater).toBe(1);
  });

  it("keeps live entity IDs unique across the whole store", () => {
    const store = new OrganismStore(64);
    const ids = new Set<number>();
    for (let i = 0; i < 64; i += 1) {
      ids.add(store.entityId[store.allocateSlot()] as number);
    }
    expect(ids.size).toBe(64);
  });

  it("resolves entity IDs to slots and forgets dead ones", () => {
    const store = new OrganismStore(4);
    const slot = store.allocateSlot();
    const id = store.entityId[slot] as number;
    expect(store.findSlotByEntityId(id)).toBe(slot);
    expect(store.findSlotByEntityId(9999)).toBe(-1);

    store.releaseSlot(slot);
    expect(store.findSlotByEntityId(id)).toBe(-1);
  });
});

describe("OrganismStore restore", () => {
  it("rejects a free list that claims a living slot", () => {
    const store = new OrganismStore(4);
    store.allocateSlot();
    expect(() => store.adoptSlotState(1, [0], 1, 2)).toThrow(EonAssertionError);
  });

  it("rejects a live slot carrying an unissued entity ID", () => {
    const store = new OrganismStore(4);
    store.alive[0] = 1;
    store.entityId[0] = 99;
    expect(() => store.adoptSlotState(1, [], 0, 2)).toThrow(EonAssertionError);
  });

  it("rebuilds the live count and the ID index", () => {
    const store = new OrganismStore(4);
    store.alive[0] = 1;
    store.entityId[0] = 1;
    store.alive[2] = 1;
    store.entityId[2] = 7;
    store.adoptSlotState(3, [1], 1, 8);

    expect(store.liveCount).toBe(2);
    expect(store.findSlotByEntityId(7)).toBe(2);
    expect(store.freeCount).toBe(1);
    // The saved free slot is reused before any fresh slot.
    expect(store.allocateSlot()).toBe(1);
    expect(store.entityId[1]).toBe(8);
  });
});
