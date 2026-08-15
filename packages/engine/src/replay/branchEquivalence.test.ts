import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import { InterventionKind } from "../commands/SimulationCommand";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import type { EngineCoreSnapshot } from "../snapshot/EngineSnapshot";
import { prepareBranchSnapshot, reconstructAt } from "./reconstruct";

/**
 * THE CRITICAL BRANCH TEST (Milestone 11 acceptance, docs/06 §30, docs/07).
 *
 *   CONTROL  world -> tick 10 000
 *   BRANCH   identical world -> tick 5 000, branch, NO NEW COMMANDS,
 *            branch -> tick 10 000
 *
 * The canonical state hashes must be equal. If they are not, a branch is not a
 * continuation of the history it claims to inherit, and every other guarantee in
 * this milestone is decoration.
 *
 * This is the populated world — organisms, species, carcasses, events, the PRNG
 * stream — not a bare environment. A branch that reproduced only the terrain
 * would prove nothing about the thing the project is for.
 *
 * ## Why one shared run
 *
 * 10 000 ticks of the reference world costs minutes (the golden fixture budgets
 * for it), so the control run is ALSO the source run: one uninterrupted world to
 * 10 000, saving at the branch ticks on the way past. That is not a shortcut
 * around the test's meaning — the control's hash at 10 000 is produced by a run
 * that never rewound, which is exactly what the branch is measured against.
 */

const SEED = 0xe0a12026;
const CONTROL_TICKS = 10_000;
const BRANCH_TICK = 5_000;
/** Deliberately off any round cadence: this branch point needs save + replay. */
const OFF_CADENCE_BRANCH_TICK = 6_234;
/** The one save the off-cadence branch must be reconstructed from. */
const NEAREST_SAVE_TICK = 5_000;

interface Reference {
  saves: Map<number, EngineCoreSnapshot>;
  hashes: Map<number, string>;
  populationAt10k: number;
  speciesAt10k: number;
}

/** One uninterrupted control run, saving at the branch ticks on the way. */
function runControl(): Reference {
  const engine = new SimulationEngine({ seed: SEED, config: DEFAULT_CONFIG });
  const saves = new Map<number, EngineCoreSnapshot>();
  const hashes = new Map<number, string>();
  const saveTicks = new Set([BRANCH_TICK]);

  for (let tick = 0; tick < CONTROL_TICKS; tick += 1) {
    if (saveTicks.has(tick)) {
      saves.set(tick, engine.serialize());
      hashes.set(tick, engine.computeStateHash());
    }
    engine.step();
  }
  hashes.set(CONTROL_TICKS, engine.computeStateHash());

  return {
    saves,
    hashes,
    populationAt10k: engine.organisms.liveCount,
    speciesAt10k: engine.species.activeCount,
  };
}

// One run for the whole file. Vitest evaluates this once per module.
const control = runControl();

describe("branch equivalence", () => {
  it("the control world is actually alive at 10 000 ticks", () => {
    // A branch test over an empty world would pass trivially. Guard the guard.
    expect(control.populationAt10k).toBeGreaterThan(0);
    expect(control.speciesAt10k).toBeGreaterThan(0);
  });

  it(
    "a branch with no new commands reproduces the control hash exactly",
    { timeout: 1_800_000 },
    () => {
      const at5000 = control.saves.get(BRANCH_TICK) as EngineCoreSnapshot;

      // Branch from the state at 5 000, exactly as the app does: take the save
      // the preview is showing and strip the parent's queued future.
      const origin = prepareBranchSnapshot(at5000, BRANCH_TICK);
      const branch = SimulationEngine.fromSnapshot(origin);
      expect(branch.tick).toBe(BRANCH_TICK);
      expect(branch.computeStateHash()).toBe(control.hashes.get(BRANCH_TICK));

      branch.stepMany(CONTROL_TICKS - BRANCH_TICK);

      expect(branch.tick).toBe(CONTROL_TICKS);
      expect(branch.computeStateHash()).toBe(control.hashes.get(CONTROL_TICKS));
      expect(branch.organisms.liveCount).toBe(control.populationAt10k);
      expect(branch.species.activeCount).toBe(control.speciesAt10k);
    },
  );

  it(
    "a branch from a tick needing save + replay also reproduces the control hash",
    { timeout: 1_800_000 },
    () => {
      // 6 234 has no save of its own: reconstructing it must load the 5 000 save
      // and replay 1 234 ticks — the reconstruction path the UI actually uses.
      const nearest = control.saves.get(NEAREST_SAVE_TICK) as EngineCoreSnapshot;
      const preview = reconstructAt({
        snapshot: nearest,
        targetTick: OFF_CADENCE_BRANCH_TICK,
        sliceTicks: 250,
      });
      expect(preview.tick).toBe(OFF_CADENCE_BRANCH_TICK);

      const origin = prepareBranchSnapshot(preview.serialize(), OFF_CADENCE_BRANCH_TICK);
      const branch = SimulationEngine.fromSnapshot(origin);
      branch.stepMany(CONTROL_TICKS - OFF_CADENCE_BRANCH_TICK);

      expect(branch.tick).toBe(CONTROL_TICKS);
      expect(branch.computeStateHash()).toBe(control.hashes.get(CONTROL_TICKS));
    },
  );

  it(
    "a branch-only command diverges the branch and leaves the original untouched",
    { timeout: 1_800_000 },
    () => {
      const at5000 = control.saves.get(BRANCH_TICK) as EngineCoreSnapshot;
      const controlHashBefore = control.hashes.get(CONTROL_TICKS);

      const branch = SimulationEngine.fromSnapshot(prepareBranchSnapshot(at5000, BRANCH_TICK));
      const queued = branch.queueCommand({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: 800,
      });
      expect(queued.accepted).toBe(true);
      branch.stepMany(CONTROL_TICKS - BRANCH_TICK);

      // The branch went somewhere else.
      expect(branch.computeStateHash()).not.toBe(controlHashBefore);
      expect(branch.environment.globalTemperatureOffsetCentiC).toBe(800);

      // The original is untouched: its save still restores to the same state,
      // and re-running it forward still lands on the same hash.
      const reopened = SimulationEngine.fromSnapshot(at5000);
      expect(reopened.computeStateHash()).toBe(control.hashes.get(BRANCH_TICK));
      expect(reopened.environment.globalTemperatureOffsetCentiC).toBe(0);
      reopened.stepMany(CONTROL_TICKS - BRANCH_TICK);
      expect(reopened.computeStateHash()).toBe(controlHashBefore);
    },
  );

  it("branching twice from one save gives two independent worlds", { timeout: 1_800_000 }, () => {
    const at5000 = control.saves.get(BRANCH_TICK) as EngineCoreSnapshot;

    const warm = SimulationEngine.fromSnapshot(prepareBranchSnapshot(at5000, BRANCH_TICK));
    const cool = SimulationEngine.fromSnapshot(prepareBranchSnapshot(at5000, BRANCH_TICK));
    expect(
      warm.queueCommand({ kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 700 })
        .accepted,
    ).toBe(true);
    expect(
      cool.queueCommand({ kind: InterventionKind.SetGlobalTemperature, offsetCentiC: -700 })
        .accepted,
    ).toBe(true);

    warm.stepMany(500);
    cool.stepMany(500);

    expect(warm.environment.globalTemperatureOffsetCentiC).toBe(700);
    expect(cool.environment.globalTemperatureOffsetCentiC).toBe(-700);
    expect(warm.computeStateHash()).not.toBe(cool.computeStateHash());
  });
});
