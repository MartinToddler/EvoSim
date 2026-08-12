import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { cloneConfig } from "../config/cloneConfig";
import { engineInternals } from "../internal";
import { Q } from "../math/fixed";
import type { EngineCoreSnapshot } from "../snapshot/EngineSnapshot";
import { BIOME_COUNT } from "./biomes";
import { createWorld } from "./createWorld";
import {
  EnvironmentSnapshotError,
  captureEnvironment,
  restoreEnvironment,
} from "./environmentSnapshot";
import { totalPlantBiomass } from "./plants";

const SEED = 0xe0a12026;

function newEngine(seed = SEED): SimulationEngine {
  return new SimulationEngine({ seed, config: DEFAULT_CONFIG });
}

/** A snapshot of a world that has actually grown, so restore has something to prove. */
function grownSnapshot(ticks = 400): EngineCoreSnapshot {
  const engine = newEngine();
  engine.stepMany(ticks);
  return engine.serialize();
}

describe("captureEnvironment / restoreEnvironment", () => {
  it("round-trips every authoritative array", () => {
    const world = createWorld(DEFAULT_CONFIG, SEED);
    const snapshot = captureEnvironment(world.environment, world.founderRegion);
    const restored = restoreEnvironment(snapshot, DEFAULT_CONFIG);

    const arrays = [
      "elevationQ",
      "baseMoistureQ",
      "moistureOffsetQ",
      "fertilityQ",
      "baseTemperatureCentiC",
      "temperatureOffsetCentiC",
      "biome",
      "plantBiomass",
      "plantCapacity",
      "plantGrowthRemainderQ",
    ] as const;
    for (const name of arrays) {
      expect({ [name]: Array.from(restored[name]) }).toEqual({
        [name]: Array.from(world.environment[name]),
      });
    }
    expect(restored.globalTemperatureOffsetCentiC).toBe(
      world.environment.globalTemperatureOffsetCentiC,
    );
  });

  it("copies rather than aliases the live arrays", () => {
    const world = createWorld(DEFAULT_CONFIG, SEED);
    const snapshot = captureEnvironment(world.environment, world.founderRegion);
    world.environment.plantBiomass[0] = 4321;
    expect(snapshot.plantBiomass[0]).not.toBe(4321);
  });

  it("recomputes the derived caches instead of trusting stored ones", () => {
    // A save can only be wrong about a cache, never right in a way the
    // authoritative arrays are not, so passability and the gradient are rebuilt.
    const world = createWorld(DEFAULT_CONFIG, SEED);
    const snapshot = captureEnvironment(world.environment, world.founderRegion);
    const restored = restoreEnvironment(snapshot, DEFAULT_CONFIG);
    expect(Array.from(restored.passable)).toEqual(Array.from(world.environment.passable));
    expect(Array.from(restored.plantGradientXQ)).toEqual(
      Array.from(world.environment.plantGradientXQ),
    );
  });

  it("rejects a grid that does not match the configuration", () => {
    const world = createWorld(DEFAULT_CONFIG, SEED);
    const snapshot = captureEnvironment(world.environment, world.founderRegion);
    expect(() => restoreEnvironment({ ...snapshot, size: 128 }, DEFAULT_CONFIG)).toThrowError(
      EnvironmentSnapshotError,
    );
    expect(() => restoreEnvironment({ ...snapshot, cellSizeLU: 8 }, DEFAULT_CONFIG)).toThrowError(
      EnvironmentSnapshotError,
    );
  });

  it("rejects an array of the wrong length", () => {
    const world = createWorld(DEFAULT_CONFIG, SEED);
    const snapshot = captureEnvironment(world.environment, world.founderRegion);
    expect(() =>
      restoreEnvironment({ ...snapshot, biome: new Uint8Array(4) }, DEFAULT_CONFIG),
    ).toThrowError(/biome has 4 entries/);
  });
});

/**
 * Value validation on load (docs/06 §27).
 *
 * Right lengths with wrong contents used to restore "successfully" and then
 * behave as a silently different world: an unknown biome index falls through
 * the `?? 0` capacity lookup and sterilises the cell on the next environment
 * update, with no error anywhere.
 */
describe("restoreEnvironment value invariants", () => {
  it("rejects a biome index no table covers", () => {
    const snapshot = grownSnapshot(20);
    snapshot.environment.biome[17] = BIOME_COUNT;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(/biome\[17\]/);
  });

  it("rejects a carried growth fraction that is not a fraction", () => {
    const snapshot = grownSnapshot(20);
    snapshot.environment.plantGrowthRemainderQ[5] = Q;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(
      /plantGrowthRemainderQ\[5\]/,
    );
  });

  it("rejects biomass above its own cell's capacity (docs/03 §27)", () => {
    const snapshot = grownSnapshot(20);
    const index = snapshot.environment.plantCapacity.findIndex((capacity) => capacity > 0);
    expect(index).toBeGreaterThanOrEqual(0);
    snapshot.environment.plantBiomass[index] = 65535;
    snapshot.environment.plantCapacity[index] = 10;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(/exceeds plantCapacity/);
  });

  it("rejects elevation, moisture and fertility outside [0, Q]", () => {
    for (const field of ["elevationQ", "baseMoistureQ", "fertilityQ"] as const) {
      const snapshot = grownSnapshot(20);
      snapshot.environment[field][3] = Q + 1;
      expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(
        new RegExp(`${field}\\[3\\]`),
      );
    }
  });

  it("rejects a non-integer global temperature offset", () => {
    const snapshot = grownSnapshot(20);
    snapshot.environment.globalTemperatureOffsetCentiC = 1.5;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(
      /globalTemperatureOffsetCentiC/,
    );
  });

  it("rejects a founder region that contradicts its own coordinates", () => {
    const snapshot = grownSnapshot(20);
    snapshot.environment.founderRegion = {
      centerCellIndex: 0,
      centerGridX: 5,
      centerGridY: 5,
      componentCells: 100,
    };
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(/does not\s+match/);
  });

  it("rejects a founder region outside the grid", () => {
    const snapshot = grownSnapshot(20);
    snapshot.environment.founderRegion = {
      centerCellIndex: 999_999,
      centerGridX: 900,
      centerGridY: 900,
      componentCells: 100,
    };
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(/outside the 256x256 grid/);
  });

  it("rejects a founder component larger than the world", () => {
    const snapshot = grownSnapshot(20);
    snapshot.environment.founderRegion = {
      ...snapshot.environment.founderRegion,
      componentCells: 256 * 256 + 1,
    };
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrowError(/componentCells/);
  });
});

/**
 * Milestone 2 acceptance: save -> restore -> continue must be bit-identical,
 * and restore must take the world from the snapshot rather than regenerating it.
 */
describe("environment snapshot / resume equivalence", () => {
  it("continuous growth equals run -> snapshot -> restore -> continue", () => {
    const continuous = newEngine();
    continuous.stepMany(2_000);

    const interrupted = newEngine();
    interrupted.stepMany(700);
    const resumed = SimulationEngine.fromSnapshot(interrupted.serialize());
    resumed.stepMany(1_300);

    expect(resumed.tick).toBe(2_000);
    expect(totalPlantBiomass(resumed.environment)).toBe(totalPlantBiomass(continuous.environment));
    expect(resumed.computeStateHash()).toBe(continuous.computeStateHash());
  });

  it("adopts the stored world instead of regenerating it from the seed", () => {
    // The stored grid is deliberately made impossible to regenerate: only a
    // restore that honours the payload can reproduce it.
    const engine = newEngine();
    engine.stepMany(100);
    const snapshot = engine.serialize();
    const index = snapshot.environment.plantCapacity.findIndex((capacity) => capacity > 100);
    snapshot.environment.plantBiomass[index] = 7;

    const restored = SimulationEngine.fromSnapshot(snapshot);
    expect(restored.environment.plantBiomass[index]).toBe(7);
    expect(restored.computeStateHash()).not.toBe(engine.computeStateHash());
  });

  it("preserves the founder region across a save/load cycle", () => {
    const engine = newEngine();
    const restored = SimulationEngine.fromSnapshot(engine.serialize());
    expect(restored.founderRegion).toEqual(engine.founderRegion);
  });

  it("preserves the generation attempt across a save/load cycle", () => {
    const engine = newEngine();
    const snapshot = engine.serialize();
    expect(snapshot.generationAttempt).toBe(engine.generationAttempt);
    expect(SimulationEngine.fromSnapshot(snapshot).generationAttempt).toBe(
      engine.generationAttempt,
    );
  });

  it("restores a world whose configuration could no longer generate one", () => {
    // Regenerating on load would throw here even though the payload is
    // perfectly good; a save must not become unloadable because the validity
    // rules it was saved under have moved.
    const engine = newEngine();
    const snapshot = engine.serialize();
    const impossible = cloneConfig(DEFAULT_CONFIG);
    impossible.world.minLandFractionQ = 4000;
    impossible.world.maxLandFractionQ = 4096;
    impossible.world.generationMaxRetries = 1;
    snapshot.config = impossible;

    const restored = SimulationEngine.fromSnapshot(snapshot);
    expect(restored.tick).toBe(0);
    expect(Array.from(restored.environment.biome)).toEqual(Array.from(engine.environment.biome));
  });

  it("restores the live PRNG state, not a re-seeded one", () => {
    const engine = newEngine();
    engineInternals(engine).rng.nextU32();
    const restored = SimulationEngine.fromSnapshot(engine.serialize());
    expect(restored.getRngState()).toEqual(engine.getRngState());
  });
});
