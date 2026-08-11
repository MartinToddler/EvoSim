import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { engineFromSnapshot, SnapshotCompatibilityError } from "./snapshot/deserialize";
import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION } from "./version";

const SEED = 0xe0a12026;

function newEngine(seed = SEED): SimulationEngine {
  return new SimulationEngine({ seed, config: DEFAULT_CONFIG });
}

describe("SimulationEngine fixed step", () => {
  it("starts at tick 0 and advances exactly one tick per step", () => {
    const engine = newEngine();
    expect(engine.tick).toBe(0);
    engine.step();
    expect(engine.tick).toBe(1);
    engine.stepMany(9);
    expect(engine.tick).toBe(10);
  });

  it("stepMany rejects negative or fractional counts", () => {
    const engine = newEngine();
    expect(() => engine.stepMany(-1)).toThrow();
    expect(() => engine.stepMany(1.5)).toThrow();
    expect(() => engine.stepMany(0)).not.toThrow();
  });

  it("normalizes the seed to uint32", () => {
    expect(newEngine(-1).seed).toBe(0xffffffff);
  });
});

describe("Milestone 1 acceptance: 10k empty ticks deterministic", () => {
  it("two engines with identical seed+config produce identical hashes", () => {
    const a = newEngine();
    const b = newEngine();
    expect(a.computeStateHash()).toBe(b.computeStateHash());
    a.stepMany(10_000);
    b.stepMany(10_000);
    expect(a.tick).toBe(10_000);
    expect(a.computeStateHash()).toBe(b.computeStateHash());
  });

  it("different seeds produce different hashes", () => {
    const a = newEngine(1);
    const b = newEngine(2);
    expect(a.computeStateHash()).not.toBe(b.computeStateHash());
  });

  it("the hash changes with tick progression", () => {
    const engine = newEngine();
    const h0 = engine.computeStateHash();
    engine.step();
    expect(engine.computeStateHash()).not.toBe(h0);
  });
});

describe("Milestone 1 acceptance: serialize/resume core hash exact", () => {
  it("snapshot restore reproduces the exact state hash", () => {
    const original = newEngine();
    original.stepMany(2_500);
    const snapshot = original.serialize();

    const restored = engineFromSnapshot(snapshot);
    expect(restored.tick).toBe(2_500);
    expect(restored.computeStateHash()).toBe(original.computeStateHash());
  });

  it("continuous run equals run -> snapshot -> restore -> continue", () => {
    const continuous = newEngine();
    continuous.stepMany(10_000);

    const interrupted = newEngine();
    interrupted.stepMany(2_500);
    const resumed = engineFromSnapshot(interrupted.serialize());
    resumed.stepMany(7_500);

    expect(resumed.tick).toBe(10_000);
    expect(resumed.computeStateHash()).toBe(continuous.computeStateHash());
  });

  it("captures live PRNG state, not just the seed", () => {
    const original = newEngine();
    original.stepMany(100);
    // Draw from the engine PRNG so its state diverges from the freshly seeded state.
    for (let i = 0; i < 37; i += 1) {
      original.rng.nextU32();
    }

    const restored = engineFromSnapshot(original.serialize());
    expect(restored.computeStateHash()).toBe(original.computeStateHash());
    expect(restored.rng.nextU32()).toBe(original.rng.nextU32());
  });

  it("snapshot config is an isolated deep copy", () => {
    const engine = newEngine();
    const snapshot = engine.serialize();
    expect(snapshot.config).not.toBe(engine.config);
    expect(snapshot.config).toEqual(DEFAULT_CONFIG);
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.engineVersion).toBe(ENGINE_VERSION);
  });

  it("rejects snapshots from an incompatible schema version", () => {
    const snapshot = { ...newEngine().serialize(), schemaVersion: 999 };
    expect(() => engineFromSnapshot(snapshot)).toThrowError(SnapshotCompatibilityError);
  });

  it("rejects snapshots from a different engine version (MVP exact-match policy)", () => {
    const snapshot = { ...newEngine().serialize(), engineVersion: "0.0.9" };
    expect(() => engineFromSnapshot(snapshot)).toThrowError(SnapshotCompatibilityError);
  });
});
