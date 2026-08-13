import { describe, expect, it } from "vitest";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { SimulationEngine } from "./SimulationEngine";
import { engineFromSnapshot } from "./snapshot/deserialize";

/**
 * Milestone 4 review: save/load continuation at every tick of a window.
 *
 * ## Why every tick, when a resume test already exists
 *
 * `evolutionSimulation.test.ts` and `organismSimulation.test.ts` resume from a
 * handful of chosen ticks. That proves the snapshot carries what those ticks
 * needed; it does not prove the snapshot carries everything, because a field
 * that is only *sometimes* load-bearing hides between chosen ticks. Reproduction
 * makes several such fields: the free list only matters on a tick where a birth
 * follows a death, `nextEntityId` only matters when a birth happens at all, and
 * a `reproductionCooldown` of N only matters within N ticks of a birth.
 *
 * So this sweeps a contiguous window instead of sampling it: restore at EVERY
 * tick of a 48-tick window that straddles the 20-tick environment cadence and
 * the 40-tick reproduction cooldown, continue each restore, and require the
 * hash to match an uninterrupted control. Scratch is zero-filled in a restored
 * engine and holds the previous tick's values in a continuous one, so this also
 * proves no phase reads a scratch value it did not write in the same tick.
 *
 * ## World
 *
 * The 96x96 / 64-founder world from `soak.test.ts`, for the reason given there:
 * the reference world's carrying capacity is far above the safety cap, so the
 * same evidence costs several times more compute on it. Every organism, brain,
 * mutation and reproduction constant is DEFAULT_CONFIG's.
 */

const SEED = 0xe0a12026;
const GRID_SIZE = 96;
const FOUNDERS = 64;

const CONFIG: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = GRID_SIZE;
  config.world.sizeLU = GRID_SIZE * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(GRID_SIZE / 8));
  config.world.initialOrganisms = FOUNDERS;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((GRID_SIZE * GRID_SIZE) / 8);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  return config;
})();

/** Deep enough that births, deaths and slot reuse are all routine. */
const WINDOW_START = 3_000;
/** Straddles both the 20-tick environment cadence and the 40-tick cooldown. */
const WINDOW_TICKS = 48;
/** Continued ticks per restore. Long enough to cross an environment update. */
const CONTINUE_TICKS = 24;

describe("save/load continuation at every tick of a window", () => {
  /**
   * One uninterrupted control run, hashed at every tick of the window and of the
   * continuation reach. This is the truth every restore is compared against.
   */
  const control = (() => {
    const engine = new SimulationEngine({ seed: SEED, config: CONFIG });
    engine.stepMany(WINDOW_START);
    const hashes = new Map<number, string>();
    const snapshots = new Map<number, ReturnType<SimulationEngine["serialize"]>>();
    for (let i = 0; i <= WINDOW_TICKS + CONTINUE_TICKS; i += 1) {
      hashes.set(engine.tick, engine.computeStateHash());
      if (i < WINDOW_TICKS) {
        snapshots.set(engine.tick, engine.serialize());
      }
      engine.stepMany(1);
    }
    return { engine, hashes, snapshots };
  })();

  it("has a live, reproducing population across the window", () => {
    // The sweep below proves nothing about reproduction if nothing reproduced.
    const { organisms } = control.engine;
    expect(organisms.liveCount).toBeGreaterThan(0);
    expect(organisms.totalBirths).toBeGreaterThan(FOUNDERS);
    expect(organisms.totalDeaths).toBeGreaterThan(0);
    // Deaths before reproduction in the tick order mean slots really are being
    // recycled into newborns, which is what makes the free list load-bearing.
    expect(organisms.freeCount + organisms.liveCount).toBe(organisms.slotHighWater);
  });

  /**
   * One restore per tick, every check on the same restored engine, inside one
   * test.
   *
   * Split across three `it` blocks this would restore 48 engines three times
   * over — and each restore regenerates the world — so the sweep runs once and
   * reports its three failure categories as one object instead. Running it in a
   * test rather than at collection time keeps the cost inside a declared budget.
   *
   * Measured on the review machine: ~150 s for the control run plus 48 restores
   * and 1 152 continued ticks. The budget is a hang detector (docs/07 §8).
   */
  it("restores and continues identically from every tick", { timeout: 1_800_000 }, () => {
    const atSnapshotTick: string[] = [];
    const afterContinuing: string[] = [];
    const fields: string[] = [];

    for (const [tick, snapshot] of control.snapshots) {
      const restored = engineFromSnapshot(snapshot);
      const { organisms } = restored;
      const saved = snapshot.organisms;

      if (restored.tick !== tick) {
        atSnapshotTick.push(`tick ${tick}: restored to ${restored.tick}`);
        continue;
      }
      const hash = restored.computeStateHash();
      if (hash !== control.hashes.get(tick)) {
        atSnapshotTick.push(`tick ${tick}: ${hash} != ${control.hashes.get(tick) ?? "?"}`);
      }

      // Named field checks as well as the hash: a hash mismatch says "something
      // diverged", these say which field would have caused it.
      if (organisms.nextEntityId !== saved.nextEntityId) fields.push(`tick ${tick}: nextEntityId`);
      if (organisms.freeCount !== saved.freeSlots.length) fields.push(`tick ${tick}: freeCount`);
      for (let i = 0; i < saved.freeSlots.length; i += 1) {
        if (organisms.freeSlots[i] !== saved.freeSlots[i]) {
          fields.push(`tick ${tick}: freeSlots[${i}]`);
          break;
        }
      }
      if (organisms.totalBirths !== saved.totalBirths) fields.push(`tick ${tick}: totalBirths`);
      if (organisms.totalDeaths !== saved.totalDeaths) fields.push(`tick ${tick}: totalDeaths`);
      if (organisms.capRejectedBirths !== saved.capRejectedBirths) {
        fields.push(`tick ${tick}: capRejectedBirths`);
      }
      if (organisms.birthEnergyDiscarded !== saved.birthEnergyDiscarded) {
        fields.push(`tick ${tick}: birthEnergyDiscarded`);
      }
      // Generation and parent links are per-slot inherited state; a snapshot
      // that dropped them would restore a population with no lineage.
      for (let slot = 0; slot < saved.slotHighWater; slot += 1) {
        if (organisms.generation[slot] !== saved.generation[slot]) {
          fields.push(`tick ${tick}: generation[${slot}]`);
          break;
        }
        if (organisms.parentEntityId[slot] !== saved.parentEntityId[slot]) {
          fields.push(`tick ${tick}: parentEntityId[${slot}]`);
          break;
        }
        if (organisms.reproductionCooldown[slot] !== saved.reproductionCooldown[slot]) {
          fields.push(`tick ${tick}: reproductionCooldown[${slot}]`);
          break;
        }
      }

      restored.stepMany(CONTINUE_TICKS);
      const target = tick + CONTINUE_TICKS;
      const continuedHash = restored.computeStateHash();
      if (continuedHash !== control.hashes.get(target)) {
        afterContinuing.push(
          `restore@${tick} -> ${target}: ${continuedHash} != ${control.hashes.get(target) ?? "?"}`,
        );
      }
    }

    expect(control.snapshots.size).toBe(WINDOW_TICKS);
    expect({ atSnapshotTick, afterContinuing, fields }).toEqual({
      atSnapshotTick: [],
      afterContinuing: [],
      fields: [],
    });
  });
});
