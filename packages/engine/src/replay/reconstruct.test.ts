import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import { InterventionKind } from "../commands/SimulationCommand";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import type { EngineCoreSnapshot } from "../snapshot/EngineSnapshot";
import {
  Reconstruction,
  ReconstructionError,
  prepareBranchSnapshot,
  reconstructAt,
  type ReconstructionProgress,
} from "./reconstruct";

/**
 * Reconstruction unit tests (task K07).
 *
 * These run the real populated world rather than the synthetic harness: replay
 * has to reproduce organisms, species, events and the PRNG stream, and a flat
 * test world would prove none of that. Tick counts are kept small — the
 * 10 000-tick equivalence run is the acceptance test's job, not this file's.
 */

const SEED = 0xe0a12026;
const REFERENCE_TICKS = 900;
const SAVE_TICKS = [0, 400, 600] as const;

/** One uninterrupted run: saves along the way, hashes at every tick of interest. */
function buildReference(): {
  saves: Map<number, EngineCoreSnapshot>;
  hashes: Map<number, string>;
} {
  const engine = new SimulationEngine({ seed: SEED, config: DEFAULT_CONFIG });
  const saves = new Map<number, EngineCoreSnapshot>();
  const hashes = new Map<number, string>();
  const wanted = new Set<number>([...SAVE_TICKS, 1, 137, 401, 599, 601, 750, REFERENCE_TICKS]);

  for (let tick = 0; tick <= REFERENCE_TICKS; tick += 1) {
    if (wanted.has(tick)) {
      hashes.set(tick, engine.computeStateHash());
    }
    if ((SAVE_TICKS as readonly number[]).includes(tick)) {
      saves.set(tick, engine.serialize());
    }
    if (tick < REFERENCE_TICKS) {
      engine.step();
    }
  }
  return { saves, hashes };
}

const reference = buildReference();

/** Nearest save at or before `tick`, as the host will choose it. */
function saveFor(tick: number): EngineCoreSnapshot {
  const from = [...SAVE_TICKS].filter((saveTick) => saveTick <= tick).pop();
  expect(from).toBeDefined();
  return reference.saves.get(from as number) as EngineCoreSnapshot;
}

function reconstruct(tick: number): SimulationEngine {
  return reconstructAt({ snapshot: saveFor(tick), targetTick: tick, sliceTicks: 128 });
}

describe("reconstruction reproduces uninterrupted simulation", () => {
  it("matches at a tick that has its own save, replaying nothing", { timeout: 300_000 }, () => {
    for (const tick of SAVE_TICKS) {
      const engine = reconstruct(tick);
      expect(engine.tick).toBe(tick);
      expect(`${tick}:${engine.computeStateHash()}`).toBe(`${tick}:${reference.hashes.get(tick)}`);
    }
  });

  it("matches at ticks between saves", { timeout: 300_000 }, () => {
    for (const tick of [1, 137, 401, 599, 601, 750, REFERENCE_TICKS]) {
      const engine = reconstruct(tick);
      expect(engine.tick).toBe(tick);
      expect(`${tick}:${engine.computeStateHash()}`).toBe(`${tick}:${reference.hashes.get(tick)}`);
    }
  });

  it("is idempotent: the same target twice gives the same state", { timeout: 300_000 }, () => {
    const first = reconstruct(750);
    const second = reconstruct(750);
    expect(second.computeStateHash()).toBe(first.computeStateHash());
    expect(second.events.latestEventId).toBe(first.events.latestEventId);
  });

  it("reproduces the event history rather than accumulating it", { timeout: 300_000 }, () => {
    // Navigating back and forth must not leave a world with duplicated events:
    // the event store is restored from the save and re-derived by replay, never
    // appended to across reconstructions.
    const ids = [750, 401, 750, 601, 750].map((tick) => reconstruct(tick).events.latestEventId);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[0]).toBe(ids[4]);
    expect(ids[1]).toBeLessThanOrEqual(ids[0] as number);
  });

  it("never mutates the save it replayed from", { timeout: 300_000 }, () => {
    const snapshot = saveFor(750);
    const before = JSON.stringify(snapshot.commands);
    const tickBefore = snapshot.tick;

    const engine = reconstruct(750);
    engine.stepMany(20);

    expect(snapshot.tick).toBe(tickBefore);
    expect(JSON.stringify(snapshot.commands)).toBe(before);
    // And the save still reconstructs the same state afterwards.
    expect(reconstruct(750).computeStateHash()).toBe(reference.hashes.get(750));
  });

  it(
    "shares no state with a second reconstruction from the same save",
    { timeout: 300_000 },
    () => {
      const a = reconstruct(600);
      const b = reconstruct(600);
      a.stepMany(50);
      expect(b.tick).toBe(600);
      expect(b.computeStateHash()).toBe(reference.hashes.get(600));
    },
  );
});

describe("reconstruction driver", () => {
  it("refuses to replay backwards from a later save", () => {
    expect(() =>
      reconstructAt({ snapshot: reference.saves.get(600) as EngineCoreSnapshot, targetTick: 500 }),
    ).toThrowError(/cannot replay backwards/);
  });

  it("refuses a target that is not a non-negative safe integer", () => {
    const snapshot = reference.saves.get(0) as EngineCoreSnapshot;
    expect(() => reconstructAt({ snapshot, targetTick: -1 })).toThrowError(ReconstructionError);
    expect(() => reconstructAt({ snapshot, targetTick: 1.5 })).toThrowError(ReconstructionError);
  });

  it("reports progress that starts at zero and lands on the target", { timeout: 300_000 }, () => {
    const seen: ReconstructionProgress[] = [];
    reconstructAt({
      snapshot: reference.saves.get(400) as EngineCoreSnapshot,
      targetTick: 700,
      sliceTicks: 100,
      onProgress: (progress) => seen.push({ ...progress }),
    });

    expect(seen[0]).toEqual({
      fromTick: 400,
      targetTick: 700,
      currentTick: 400,
      ticksReplayed: 0,
      ticksTotal: 300,
    });
    expect(seen.map((p) => p.ticksReplayed)).toEqual([0, 100, 200, 300]);
  });

  it("reports one zero-work progress event when the target needs no replay", () => {
    const seen: ReconstructionProgress[] = [];
    reconstructAt({
      snapshot: reference.saves.get(600) as EngineCoreSnapshot,
      targetTick: 600,
      onProgress: (progress) => seen.push({ ...progress }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ticksTotal).toBe(0);
  });

  it("advances in slices without changing where it lands", { timeout: 300_000 }, () => {
    const stepwise = new Reconstruction({
      snapshot: reference.saves.get(400) as EngineCoreSnapshot,
      targetTick: 750,
    });
    while (!stepwise.advance(37)) {
      // Deliberately awkward slice size: landing exactly on the target must not
      // depend on the target being a multiple of the slice.
    }
    expect(stepwise.engine.tick).toBe(750);
    expect(stepwise.engine.computeStateHash()).toBe(reference.hashes.get(750));
  });
});

describe("branch origin snapshots", () => {
  /** A world with one applied command and one still pending at the branch tick. */
  function worldWithPendingCommand(): EngineCoreSnapshot {
    const engine = new SimulationEngine({ seed: SEED, config: DEFAULT_CONFIG });
    expect(
      engine.queueCommand({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: 250,
        targetTick: 10,
      }).accepted,
    ).toBe(true);
    expect(
      engine.queueCommand({
        kind: InterventionKind.SetGlobalTemperature,
        offsetCentiC: -250,
        targetTick: 200,
      }).accepted,
    ).toBe(true);
    engine.stepMany(100);
    return engine.serialize();
  }

  it("keeps the applied history and drops the pending future", () => {
    const snapshot = worldWithPendingCommand();
    expect(snapshot.commands.commands).toHaveLength(2);
    expect(snapshot.commands.cursor).toBe(1);

    const branch = prepareBranchSnapshot(snapshot, 100);
    expect(branch.commands.commands).toHaveLength(1);
    expect(branch.commands.cursor).toBe(1);
    expect(branch.commands.commands[0]?.id).toBe(1);
  });

  it("continues the identity counters so branch commands cannot collide", () => {
    const snapshot = worldWithPendingCommand();
    const branch = prepareBranchSnapshot(snapshot, 100);
    expect(branch.commands.nextCommandId).toBe(snapshot.commands.nextCommandId);
    expect(branch.commands.nextSequence).toBe(snapshot.commands.nextSequence);
  });

  it("restores to the same state the parent had at the branch tick", () => {
    const snapshot = worldWithPendingCommand();
    const parent = SimulationEngine.fromSnapshot(snapshot);
    const branch = SimulationEngine.fromSnapshot(prepareBranchSnapshot(snapshot, 100));

    expect(branch.tick).toBe(parent.tick);
    expect(branch.commands.cursor).toBe(parent.commands.cursor);
    // The hashes differ ONLY by the dropped pending command — which is the
    // point: the branch does not carry the parent's future.
    expect(branch.commands.length).toBe(parent.commands.length - 1);
    expect(branch.computeStateHash()).not.toBe(parent.computeStateHash());
  });

  it("refuses a save that is not at the branch tick", () => {
    const snapshot = worldWithPendingCommand();
    expect(() => prepareBranchSnapshot(snapshot, 99)).toThrowError(/must start from the exact/);
  });

  it("leaves a branch with no pending commands identical to the parent's replay", () => {
    // No pending commands at the branch point => nothing to drop => the branch
    // origin is byte-for-byte the parent's state, which is what makes the
    // no-new-commands equivalence exact.
    const engine = new SimulationEngine({ seed: SEED, config: DEFAULT_CONFIG });
    engine.stepMany(50);
    const snapshot = engine.serialize();
    const branch = prepareBranchSnapshot(snapshot, 50);

    expect(SimulationEngine.fromSnapshot(branch).computeStateHash()).toBe(
      SimulationEngine.fromSnapshot(snapshot).computeStateHash(),
    );
  });
});
