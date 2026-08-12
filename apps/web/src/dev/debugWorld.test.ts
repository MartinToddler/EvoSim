import { DEFAULT_CONFIG, ENGINE_VERSION, SimulationEngine, hashEnvironment } from "@eon/engine";
import { describe, expect, it } from "vitest";
import { advanceDebugWorld, createDebugWorld, readDebugWorldModel } from "./debugWorld";
import { FIXTURE_SEED } from "./presetSeeds";

function requireEngine(seed: number): SimulationEngine {
  const result = createDebugWorld(seed);
  if (!result.ok) {
    throw new Error(`expected seed ${seed} to produce a world: ${result.error}`);
  }
  return result.value;
}

describe("createDebugWorld", () => {
  it("builds a world and reports the engine's own identity values", () => {
    const engine = requireEngine(FIXTURE_SEED);
    const model = readDebugWorldModel(engine);
    expect(model.seed).toBe(FIXTURE_SEED);
    expect(model.tick).toBe(0);
    expect(model.engineVersion).toBe(ENGINE_VERSION);
    expect(model.configHash).toBe(engine.configHash);
    expect(model.stateHash).toBe(engine.computeStateHash());
    expect(model.environmentHash).toBe(hashEnvironment(engine.environment));
    expect(model.generationAttempt).toBe(engine.generationAttempt);
  });

  it("is reproducible: the same seed yields the same hashes", () => {
    const first = readDebugWorldModel(requireEngine(FIXTURE_SEED));
    const second = readDebugWorldModel(requireEngine(FIXTURE_SEED));
    expect(second.environmentHash).toBe(first.environmentHash);
    expect(second.stateHash).toBe(first.stateHash);
  });

  it("yields a different map for a different seed", () => {
    const a = readDebugWorldModel(requireEngine(FIXTURE_SEED));
    const b = readDebugWorldModel(requireEngine(FIXTURE_SEED + 1));
    expect(b.environmentHash).not.toBe(a.environmentHash);
  });

  it("reports the founder region and its radius in cells", () => {
    const engine = requireEngine(FIXTURE_SEED);
    const model = readDebugWorldModel(engine);
    expect(model.founderRegion.centerCellIndex).toBe(engine.founderRegion.centerCellIndex);
    expect(model.founderRegion.componentCells).toBe(engine.founderRegion.componentCells);
    expect(model.founderRadiusCells).toBe(
      Math.ceil(DEFAULT_CONFIG.world.founderSpawnRadiusLU / DEFAULT_CONFIG.world.envCellSizeLU),
    );
  });

  it("returns construction failures as values instead of throwing at the UI", () => {
    // A non-integer seed is rejected by the engine (ADR 0002 §3): distinct seeds
    // must not collapse onto one world.
    const result = createDebugWorld(1.5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("seed must be an integer");
    }
  });
});

describe("advanceDebugWorld", () => {
  it("advances the authoritative tick and re-reads the environment", () => {
    const engine = requireEngine(FIXTURE_SEED);
    const before = readDebugWorldModel(engine);
    const result = advanceDebugWorld(engine, DEFAULT_CONFIG.time.environmentInterval * 5);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.tick).toBe(DEFAULT_CONFIG.time.environmentInterval * 5);
    expect(result.value.environmentHash).not.toBe(before.environmentHash);
    expect(result.value.summary.totalPlantBiomass).toBeGreaterThan(
      before.summary.totalPlantBiomass,
    );
  });

  it("does not perturb determinism: the debug view observes without changing", () => {
    const engine = requireEngine(FIXTURE_SEED);
    const stepped = advanceDebugWorld(engine, 137);
    expect(stepped.ok).toBe(true);

    // A bare engine given the same seed and the same number of ticks — no field
    // captures, no hash reads in between — must reach the identical state.
    const control = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    control.stepMany(137);
    expect(engine.computeStateHash()).toBe(control.computeStateHash());
    if (stepped.ok) {
      expect(stepped.value.stateHash).toBe(control.computeStateHash());
    }
  });

  it("reports an invalid tick count as a value", () => {
    const engine = requireEngine(FIXTURE_SEED);
    const result = advanceDebugWorld(engine, -1);
    expect(result.ok).toBe(false);
    expect(engine.tick).toBe(0);
  });
});

describe("readDebugWorldModel", () => {
  it("reads a fresh model from an engine that was advanced elsewhere", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    engine.stepMany(40);
    const model = readDebugWorldModel(engine);
    expect(model.tick).toBe(40);
    expect(model.stateHash).toBe(engine.computeStateHash());
  });
});
