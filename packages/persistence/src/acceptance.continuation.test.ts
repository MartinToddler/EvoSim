import { SimulationEngine } from "@eon/engine";
import { describe, expect, it } from "vitest";
import { decodeDurableSnapshot, encodeDurableSnapshot } from "./durableSnapshot";
import { ACCEPTANCE_CONFIG, ACCEPTANCE_SEED, countAlive, distinctGenes } from "./testWorlds";

/**
 * The Milestone 10 acceptance test (task K06, docs/06 §25).
 *
 * ```text
 *   CONTROL     fresh world -> tick 10 000
 *   SAVE/LOAD   the same world -> tick 2 500 -> save -> destroy the runtime
 *                             -> load into a fresh runtime -> tick 10 000
 *   The canonical state hashes must be identical.
 * ```
 *
 * "Destroy the runtime" is taken literally. The continuation is built from
 * *bytes* — the same container IndexedDB stores — decoded into a new engine.
 * No object reference, no shared typed array, no live PRNG crosses the gap; the
 * only thing that survives is the file.
 *
 * ## Two save points from one control run
 *
 * The control run also yields a second save at tick 4 000, continued to tick
 * 6 000. That point is chosen for what the world contains there rather than for
 * the round number: by tick 4 000 this world has a thousand carcasses lying in
 * it and a heavily recycled organism free list, which is exactly the state a
 * snapshot that rebuilds its free lists instead of storing them gets wrong.
 * Reusing one control run for both costs 2 000 extra ticks instead of another
 * 6 000, and taking a save cannot perturb the run — proven independently in
 * `durableSnapshot.test.ts`.
 */

const SAVE_AT = 2500;
const SECOND_SAVE_AT = 4000;
const SECOND_TARGET = 6000;
const TOTAL = 10_000;

/** Encode, discard the engine, decode: a save that survived a cold start. */
function throughDurableBytes(engine: SimulationEngine): Uint8Array {
  const bytes = encodeDurableSnapshot({
    snapshot: engine.serialize(),
    stateHash: engine.computeStateHash(),
    configHash: engine.configHash,
  });
  // A stored save is a byte stream, not a JS object graph. Copying through a
  // detached buffer makes accidental structural sharing impossible.
  return new Uint8Array(bytes.slice().buffer);
}

function restore(bytes: Uint8Array): SimulationEngine {
  const { header, snapshot } = decodeDurableSnapshot(bytes);
  const engine = SimulationEngine.fromSnapshot(snapshot);
  // The save recorded what the world hashed to; the restored world must agree.
  expect(engine.computeStateHash()).toBe(header.stateHash);
  return engine;
}

describe("save/load preserves the exact deterministic future", () => {
  // One control run, shared by every assertion below.
  const control = new SimulationEngine({ seed: ACCEPTANCE_SEED, config: ACCEPTANCE_CONFIG });

  control.stepMany(SAVE_AT);
  const hashAtSave = control.computeStateHash();
  const savedAt2500 = throughDurableBytes(control);
  const snapshotAt2500 = control.serialize();

  control.stepMany(SECOND_SAVE_AT - SAVE_AT);
  const hashAt4000 = control.computeStateHash();
  const savedAt4000 = throughDurableBytes(control);
  const snapshotAt4000 = control.serialize();

  control.stepMany(SECOND_TARGET - SECOND_SAVE_AT);
  const hashAt6000 = control.computeStateHash();

  control.stepMany(TOTAL - SECOND_TARGET);
  const controlHash = control.computeStateHash();

  it("runs a world with something worth saving", () => {
    // Without this the comparison could pass while proving almost nothing: two
    // empty worlds also agree. These are the stores the milestone is about.
    expect(countAlive(snapshotAt2500.organisms.alive)).toBeGreaterThan(0);
    expect(snapshotAt2500.organisms.totalBirths).toBeGreaterThan(0);
    expect(snapshotAt2500.organisms.totalDeaths).toBeGreaterThan(0);
    expect(snapshotAt2500.organisms.nextEntityId).toBeGreaterThan(
      ACCEPTANCE_CONFIG.world.initialOrganisms,
    );
    // Mutation has moved the population off the single founder genome.
    expect(distinctGenes(snapshotAt2500.organisms.genes)).toBeGreaterThan(1);
    expect(snapshotAt2500.history.events.events.length).toBeGreaterThan(0);
    expect(snapshotAt2500.history.stats.tiers.length).toBeGreaterThan(0);

    // The tick-4 000 save is the carcass-rich one, with recycled free lists.
    expect(snapshotAt4000.carcasses.slotHighWater).toBeGreaterThan(0);
    expect(snapshotAt4000.carcasses.totalCreated).toBeGreaterThan(0);
    expect(snapshotAt4000.organisms.freeSlots.length).toBeGreaterThan(0);
    expect(countAlive(snapshotAt4000.organisms.alive)).toBeGreaterThan(0);
  });

  it("reaches tick 10 000 with the control's hash after a save at 2 500", () => {
    const continued = restore(savedAt2500);
    expect(continued.tick).toBe(SAVE_AT);
    expect(continued.computeStateHash()).toBe(hashAtSave);

    continued.stepMany(TOTAL - SAVE_AT);

    expect(continued.tick).toBe(TOTAL);
    expect(continued.computeStateHash()).toBe(controlHash);
  });

  it("continues identically from a carcass-rich save at 4 000", () => {
    const continued = restore(savedAt4000);
    expect(continued.computeStateHash()).toBe(hashAt4000);

    continued.stepMany(SECOND_TARGET - SECOND_SAVE_AT);

    expect(continued.tick).toBe(SECOND_TARGET);
    expect(continued.computeStateHash()).toBe(hashAt6000);
  });
});
