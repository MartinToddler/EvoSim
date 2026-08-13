import type { CarcassStore } from "./CarcassStore";

/**
 * Serializable carcass state (docs/10 §18, task F01).
 *
 * Carcasses are food that organisms can already see and claim, so a resumed
 * world that lost them — or that rebuilt their slot order differently — would
 * diverge on the next carcass tie-break. Only the used slot prefix is stored,
 * with the free list verbatim, exactly as the organism snapshot does.
 */
export interface CarcassSnapshot {
  capacity: number;
  slotHighWater: number;
  freeSlots: Int32Array;
  totalCreated: number;
  skippedAtCap: number;
  totalMeatCreated: number;
  totalMeatEaten: number;
  totalMeatDecayed: number;

  active: Uint8Array;
  entityId: Uint32Array;
  x: Int32Array;
  y: Int32Array;
  remainingMeat: Uint32Array;
  sourceSpeciesId: Uint32Array;
  ageTicks: Uint32Array;
}

/** Error thrown when a carcass snapshot cannot be restored. */
export class CarcassSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarcassSnapshotError";
  }
}

export function captureCarcasses(carcasses: CarcassStore): CarcassSnapshot {
  const used = carcasses.slotHighWater;
  return {
    capacity: carcasses.capacity,
    slotHighWater: used,
    freeSlots: new Int32Array(carcasses.freeSlots.subarray(0, carcasses.freeCount)),
    totalCreated: carcasses.totalCreated,
    skippedAtCap: carcasses.skippedAtCap,
    totalMeatCreated: carcasses.totalMeatCreated,
    totalMeatEaten: carcasses.totalMeatEaten,
    totalMeatDecayed: carcasses.totalMeatDecayed,

    active: new Uint8Array(carcasses.active.subarray(0, used)),
    entityId: new Uint32Array(carcasses.entityId.subarray(0, used)),
    x: new Int32Array(carcasses.x.subarray(0, used)),
    y: new Int32Array(carcasses.y.subarray(0, used)),
    remainingMeat: new Uint32Array(carcasses.remainingMeat.subarray(0, used)),
    sourceSpeciesId: new Uint32Array(carcasses.sourceSpeciesId.subarray(0, used)),
    ageTicks: new Uint32Array(carcasses.ageTicks.subarray(0, used)),
  };
}

function checkLength(actual: number, expected: number, name: string): void {
  if (actual !== expected) {
    throw new CarcassSnapshotError(
      `carcass snapshot array ${name} has ${actual} entries, expected ${expected}`,
    );
  }
}

/** Rebuild carcass state from a snapshot, validating shape before trusting it. */
export function restoreCarcasses(snapshot: CarcassSnapshot, carcasses: CarcassStore): void {
  if (snapshot.capacity !== carcasses.capacity) {
    throw new CarcassSnapshotError(
      `carcass snapshot capacity ${snapshot.capacity} does not match config ${carcasses.capacity}`,
    );
  }
  const used = snapshot.slotHighWater;
  if (!Number.isSafeInteger(used) || used < 0 || used > carcasses.capacity) {
    throw new CarcassSnapshotError(`carcass snapshot slotHighWater out of range: ${used}`);
  }

  carcasses.reset();

  const perSlot: readonly [ArrayLike<number>, { set(v: ArrayLike<number>): void }, string][] = [
    [snapshot.active, carcasses.active, "active"],
    [snapshot.entityId, carcasses.entityId, "entityId"],
    [snapshot.x, carcasses.x, "x"],
    [snapshot.y, carcasses.y, "y"],
    [snapshot.remainingMeat, carcasses.remainingMeat, "remainingMeat"],
    [snapshot.sourceSpeciesId, carcasses.sourceSpeciesId, "sourceSpeciesId"],
    [snapshot.ageTicks, carcasses.ageTicks, "ageTicks"],
  ];
  for (const [source, target, name] of perSlot) {
    checkLength(source.length, used, name);
    target.set(source);
  }

  carcasses.totalCreated = snapshot.totalCreated;
  carcasses.skippedAtCap = snapshot.skippedAtCap;
  carcasses.totalMeatCreated = snapshot.totalMeatCreated;
  carcasses.totalMeatEaten = snapshot.totalMeatEaten;
  carcasses.totalMeatDecayed = snapshot.totalMeatDecayed;

  carcasses.adoptSlotState(used, snapshot.freeSlots, snapshot.freeSlots.length);
}
