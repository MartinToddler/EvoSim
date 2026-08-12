import { describe, expect, it } from "vitest";
import { MAX_TICK, SimulationEngine } from "./SimulationEngine";
import { cloneConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { hashConfig } from "./config/hashConfig";
import { validateConfig } from "./config/validateConfig";
import { engineInternals } from "./internal";
import { SnapshotCompatibilityError } from "./snapshot/EngineSnapshot";
import { engineFromSnapshot } from "./snapshot/deserialize";
import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION } from "./version";
import { totalPlantBiomass } from "./world/plants";

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

  it("stepMany rejects negative, fractional and unsafe counts", () => {
    const engine = newEngine();
    expect(() => engine.stepMany(-1)).toThrow();
    expect(() => engine.stepMany(1.5)).toThrow();
    expect(() => engine.stepMany(2 ** 53)).toThrow();
    expect(() => engine.stepMany(0)).not.toThrow();
  });

  it("normalizes the seed to uint32", () => {
    expect(newEngine(-1).seed).toBe(0xffffffff);
  });
});

describe("authoritative state encapsulation", () => {
  it("does not expose the PRNG on the public surface", () => {
    const engine = newEngine();
    const asRecord = engine as unknown as Record<string, unknown>;
    // Advancing the PRNG outside a tick would break the contract that state is a
    // pure function of seed + config + commands + engine version.
    expect(asRecord["rng"]).toBeUndefined();
    expect(Object.keys(engine)).not.toContain("rng");
  });

  it("does not expose a way to overwrite tick or PRNG state", () => {
    const engine = newEngine();
    const asRecord = engine as unknown as Record<string, unknown>;
    expect(asRecord["restoreCore"]).toBeUndefined();
    expect(typeof (engine as unknown as { setTick?: unknown }).setTick).toBe("undefined");
  });

  it("cannot have its authoritative identity fields reassigned", () => {
    // `readonly` is erased at runtime. Without a frozen instance, assigning
    // engine.configHash would change the world's state hash while every
    // simulation value stayed the same.
    const engine = newEngine();
    const before = engine.computeStateHash();
    const asRecord = engine as unknown as Record<string, unknown>;

    expect(Object.isFrozen(engine)).toBe(true);
    expect(() => {
      asRecord["configHash"] = "deadbeefdeadbeef";
    }).toThrow();
    expect(() => {
      asRecord["seed"] = 1;
    }).toThrow();
    expect(() => {
      asRecord["injected"] = true;
    }).toThrow();

    expect(engine.computeStateHash()).toBe(before);
  });

  it("still advances its own private state while frozen", () => {
    const engine = newEngine();
    engine.stepMany(5);
    expect(engine.tick).toBe(5);
    const restored = engineFromSnapshot(engine.serialize());
    expect(restored.tick).toBe(5);
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
  });

  it("getRngState returns a detached copy", () => {
    const engine = newEngine();
    const first = engine.getRngState();
    const second = engine.getRngState();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);

    const hashBefore = engine.computeStateHash();
    (first as unknown as number[])[0] = 12345;
    expect(engine.computeStateHash()).toBe(hashBefore);
  });

  it("gives engine-internal code the live generator", () => {
    const engine = newEngine();
    const before = engine.getRngState();
    engineInternals(engine).rng.nextU32();
    expect(engine.getRngState()).not.toEqual(before);
  });
});

/**
 * The environment is authoritative state and is hashed, so it must be no more
 * reachable for writing than the PRNG is (ADR 0004 §1). Milestone 2 originally
 * published the live `EnvironmentStore`, which let any caller change a world's
 * hash without running a tick.
 */
describe("authoritative environment encapsulation", () => {
  it("publishes a view whose writes do not type-check", () => {
    // Never executed: each line below is a compile-time assertion, and tsc
    // fails the build if any of them stops being an error.
    const writesMustNotCompile = (engine: SimulationEngine): unknown[] => [
      // @ts-expect-error authoritative cells must not be writable through the public API
      (engine.environment.plantBiomass[0] = 1),
      // @ts-expect-error the global temperature offset is engine-owned
      (engine.environment.globalTemperatureOffsetCentiC = 500),
      // @ts-expect-error mutating helpers are absent from the published view
      engine.environment.recomputePassability,
      // @ts-expect-error and so is the hashing hook
      engine.environment.hashInto,
    ];
    expect(typeof writesMustNotCompile).toBe("function");
    expect(newEngine().environment.cellCount).toBe(256 * 256);
  });

  it("offers no runtime door onto the store object either", () => {
    const engine = newEngine();
    const view = engine.environment as unknown as Record<string, unknown>;

    expect(Object.isFrozen(engine.environment)).toBe(true);
    // The published object is a projection, not the store: casting away the
    // type finds nothing to call.
    for (const member of ["setGlobalTemperatureOffsetCentiC", "recomputePassability", "hashInto"]) {
      expect({ member, type: typeof view[member] }).toEqual({ member, type: "undefined" });
    }
    // Swapping an array for a shorter or aliased buffer must not be possible.
    expect(() => {
      view["plantBiomass"] = new Uint16Array(4);
    }).toThrow();
    expect(() => {
      view["globalTemperatureOffsetCentiC"] = 500;
    }).toThrow();
  });

  it("reads through to the live grid without copying it", () => {
    const engine = newEngine();
    const store = engineInternals(engine).environment;
    expect(engine.environment.plantBiomass).toBe(store.plantBiomass);
    expect(engine.environment).toBe(engine.environment);
  });

  it("keeps the writable store reachable for engine phase code", () => {
    const engine = newEngine();
    const store = engineInternals(engine).environment;
    const before = engine.computeStateHash();
    store.setGlobalTemperatureOffsetCentiC(250);
    expect(engine.environment.globalTemperatureOffsetCentiC).toBe(250);
    expect(engine.computeStateHash()).not.toBe(before);
  });

  it("hashes the founder region as authoritative state", () => {
    // Milestone 3 spawns the founder population here, so two states that agree
    // on every array but disagree on the region are different worlds.
    const engine = newEngine();
    const snapshot = engine.serialize();
    snapshot.environment.founderRegion = {
      centerCellIndex: 3 * 256 + 9,
      centerGridX: 9,
      centerGridY: 3,
      componentCells: 500,
    };
    const moved = engineFromSnapshot(snapshot);
    expect(moved.founderRegion.centerCellIndex).toBe(3 * 256 + 9);
    expect(moved.computeStateHash()).not.toBe(engine.computeStateHash());
  });

  it("freezes the founder region it publishes", () => {
    const engine = newEngine();
    expect(Object.isFrozen(engine.founderRegion)).toBe(true);
    expect(() => {
      (engine.founderRegion as { componentCells: number }).componentCells = 1;
    }).toThrow();
  });
});

describe("restore channel", () => {
  it("cannot be driven with a forged token", () => {
    // fromSnapshot is the single validated restore door (ADR 0002 §2); the
    // second constructor argument exists only for it.
    const forged = {
      token: Symbol("not the restore token"),
      tick: 99,
      rngState: newEngine().getRngState(),
      environment: newEngine().serialize().environment,
      generationAttempt: 0,
    };
    expect(
      () => new SimulationEngine({ seed: SEED, config: DEFAULT_CONFIG }, forged as never),
    ).toThrowError(SnapshotCompatibilityError);
  });

  it("rejects a snapshot with a nonsensical generation attempt", () => {
    const snapshot = { ...newEngine().serialize(), generationAttempt: -1 };
    expect(() => engineFromSnapshot(snapshot)).toThrowError(SnapshotCompatibilityError);
  });
});

describe("seed validation", () => {
  it("rejects non-integer seeds instead of silently normalizing them", () => {
    // 1.5 >>> 0 === 1 and NaN >>> 0 === 0: two callers who believe they used
    // different seeds would otherwise share a world.
    expect(() => new SimulationEngine({ seed: 1.5, config: DEFAULT_CONFIG })).toThrow();
    expect(() => new SimulationEngine({ seed: Number.NaN, config: DEFAULT_CONFIG })).toThrow();
    expect(() => new SimulationEngine({ seed: Infinity, config: DEFAULT_CONFIG })).toThrow();
  });
});

describe("configuration immutability", () => {
  it("freezes the configuration it holds", () => {
    const engine = newEngine();
    expect(Object.isFrozen(engine.config)).toBe(true);
    expect(Object.isFrozen(engine.config.world)).toBe(true);
    expect(() => {
      (engine.config as unknown as { world: { sizeLU: number } }).world.sizeLU = 1;
    }).toThrow();
  });

  it("is immune to mutation of the caller's config object after construction", () => {
    const mutable = cloneConfig(DEFAULT_CONFIG);
    const engine = new SimulationEngine({ seed: SEED, config: mutable });
    const hashBefore = engine.computeStateHash();
    const configHashBefore = engine.configHash;

    // The classic trap: mutate the config after the engine hashed it.
    mutable.world.sizeLU = 8192;
    mutable.limits.maxOrganisms = 1;

    expect(engine.config.world.sizeLU).toBe(DEFAULT_CONFIG.world.sizeLU);
    expect(engine.config.limits.maxOrganisms).toBe(DEFAULT_CONFIG.limits.maxOrganisms);
    expect(engine.configHash).toBe(configHashBefore);
    expect(engine.computeStateHash()).toBe(hashBefore);
  });

  it("rejects an invalid configuration at construction", () => {
    const broken = cloneConfig(DEFAULT_CONFIG);
    broken.world.envCellSizeLU = 15;
    expect(() => new SimulationEngine({ seed: SEED, config: broken })).toThrow();
  });

  it("validates the copy it keeps, not the object the caller passed", () => {
    // A config whose getter returns a valid value once and garbage afterwards
    // must not be able to pass validation and then poison the stored config.
    const shifty = cloneConfig(DEFAULT_CONFIG);
    let reads = 0;
    Object.defineProperty(shifty.world, "sizeLU", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 4096 : 999;
      },
    });

    // Whatever the engine ends up holding must itself be valid and match the hash.
    const engine = new SimulationEngine({ seed: SEED, config: shifty });
    expect(engine.configHash).toBe(hashConfig(engine.config));
    expect(() => validateConfig(engine.config)).not.toThrow();
  });

  it("configHash always describes the configuration actually held", () => {
    const engine = newEngine();
    expect(engine.configHash).toBe(hashConfig(engine.config));
    expect(engine.configHash).toBe(hashConfig(DEFAULT_CONFIG));
  });

  it("hashes different configurations differently", () => {
    const variant = cloneConfig(DEFAULT_CONFIG);
    variant.time.statisticsInterval = 50;
    const a = newEngine();
    const b = new SimulationEngine({ seed: SEED, config: variant });
    expect(b.configHash).not.toBe(a.configHash);
    expect(b.computeStateHash()).not.toBe(a.computeStateHash());
  });
});

describe("tick range safety", () => {
  function engineAtTick(tick: number): SimulationEngine {
    return engineFromSnapshot({ ...newEngine().serialize(), tick });
  }

  it("hashes ticks 2^32 apart differently (no uint32 aliasing)", () => {
    expect(engineAtTick(0).computeStateHash()).not.toBe(engineAtTick(2 ** 32).computeStateHash());
    expect(engineAtTick(1).computeStateHash()).not.toBe(
      engineAtTick(2 ** 32 + 1).computeStateHash(),
    );
  });

  it("refuses to step past the safe integer range", () => {
    const engine = engineAtTick(MAX_TICK);
    expect(engine.tick).toBe(MAX_TICK);
    expect(() => engine.step()).toThrowError(RangeError);
  });

  it("refuses a stepMany that would cross the maximum tick", () => {
    const engine = engineAtTick(MAX_TICK - 2);
    expect(() => engine.stepMany(5)).toThrow();
    expect(engine.tick).toBe(MAX_TICK - 2);
  });

  it("rejects snapshots with an out-of-range tick", () => {
    expect(() => engineAtTick(2 ** 53)).toThrowError(SnapshotCompatibilityError);
    expect(() => engineAtTick(-1)).toThrowError(SnapshotCompatibilityError);
    expect(() => engineAtTick(1.5)).toThrowError(SnapshotCompatibilityError);
  });

  it("schedules phases from the whole tick, not its low 32 bits", () => {
    // 2^32 ≡ 16 (mod 20), so the environment phase must NOT run there; a
    // scheduler that truncated the tick with `>>> 0` would see 0 and run it.
    // Verified by restoring to the tick rather than by stepping four billion
    // times.
    const interval = DEFAULT_CONFIG.time.environmentInterval;
    expect(2 ** 32 % interval).toBe(16);

    const quiet = engineAtTick(2 ** 32);
    const scheduled = engineAtTick(2 ** 32 + 4); // ≡ 0 (mod 20)
    const before = totalPlantBiomass(quiet.environment);

    quiet.step();
    scheduled.step();

    expect(totalPlantBiomass(quiet.environment)).toBe(before);
    expect(totalPlantBiomass(scheduled.environment)).toBeGreaterThan(before);
  });

  it("keeps hashing distinct across high-tick epochs", () => {
    const hashes = new Set(
      [0, 1, 2 ** 32, 2 ** 32 + 1, 2 ** 40, 2 ** 45 + 7].map((tick) =>
        engineAtTick(tick).computeStateHash(),
      ),
    );
    expect(hashes.size).toBe(6);
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
    expect(newEngine(1).computeStateHash()).not.toBe(newEngine(2).computeStateHash());
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
    const restored = engineFromSnapshot(original.serialize());
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
      engineInternals(original).rng.nextU32();
    }

    const restored = engineFromSnapshot(original.serialize());
    expect(restored.computeStateHash()).toBe(original.computeStateHash());
    expect(engineInternals(restored).rng.nextU32()).toBe(engineInternals(original).rng.nextU32());
  });

  it("snapshot config is an isolated mutable deep copy", () => {
    const engine = newEngine();
    const snapshot = engine.serialize();
    expect(snapshot.config).not.toBe(engine.config);
    expect(snapshot.config).toEqual(DEFAULT_CONFIG);
    expect(Object.isFrozen(snapshot.config)).toBe(false);
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

  it("rejects snapshots carrying an invalid config", () => {
    const snapshot = newEngine().serialize();
    snapshot.config.world.envCellSizeLU = 15;
    expect(() => engineFromSnapshot(snapshot)).toThrow();
  });
});
