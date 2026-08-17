import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { ConfigValidationError, validateConfig } from "./config/validateConfig";
import type { SimulationConfig } from "./config/SimulationConfig";
import { EnvironmentSnapshotError } from "./world/environmentSnapshot";
import { WorldGenerationError, createWorld } from "./world/createWorld";
import { Biome } from "./world/biomes";

/**
 * The foundation-gate fixes, ported into this line as part of the pre-J05
 * merge mandate (ADR 0006 §0, ADR 0008 §0, ADR 0010 §0, ADR 0013 §10): exact
 * config shape, world geometry bounds, snapshot value validation, restore
 * without regeneration, the hashed founder region and the sealed environment
 * store. Each test pins one of them so the port cannot silently regress.
 */

const SMALL_GRID = 96;

const SMALL_CONFIG: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = SMALL_GRID;
  config.world.sizeLU = SMALL_GRID * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(SMALL_GRID / 8));
  config.world.initialOrganisms = 64;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((SMALL_GRID * SMALL_GRID) / 8);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  return config;
})();

describe("exact config shape (foundation-gate §4)", () => {
  it("rejects an unknown field anywhere in the tree", () => {
    const config = cloneConfig(DEFAULT_CONFIG) as SimulationConfig & Record<string, unknown>;
    config["experimentalFlag"] = true;
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(/experimentalFlag is not a field/);
  });

  it("rejects the classic typo: a misspelled field is both unknown and missing", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    const time = config.time as unknown as Record<string, unknown>;
    time["enviromentInterval"] = time["environmentInterval"];
    delete time["environmentInterval"];
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
  });

  it("rejects a host-runtime value pasted into the authoritative config", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    (config.time as unknown as Record<string, unknown>)["targetTicksPerSecond1x"] = 20;
    expect(() => validateConfig(config)).toThrow(/targetTicksPerSecond1x is not a field/);
  });

  it("rejects a missing section", () => {
    const config = cloneConfig(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    delete config["interventions"];
    expect(() => validateConfig(config as unknown as SimulationConfig)).toThrow(
      /interventions is missing/,
    );
  });
});

describe("world geometry bounds (foundation-gate §6)", () => {
  it("rejects an environment grid above the allocation ceiling", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.world.envGridSize = 8192;
    config.world.sizeLU = 8192 * config.world.envCellSizeLU;
    expect(() => validateConfig(config)).toThrow(/envGridSize must not exceed 4096/);
  });

  it("rejects a world whose positions would leave the Int32 range", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.world.envCellSizeLU = 65536;
    config.world.sizeLU = config.world.envGridSize * config.world.envCellSizeLU;
    expect(() => validateConfig(config)).toThrow(/sizeLU must not exceed/);
  });
});

describe("snapshot value validation (foundation-gate §5)", () => {
  function snapshotOf(engine: SimulationEngine) {
    return engine.serialize();
  }

  it("rejects an impossible biome index", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = snapshotOf(engine);
    snapshot.environment.biome[0] = 200;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(EnvironmentSnapshotError);
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/not a Biome value/);
  });

  it("rejects out-of-range field values", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = snapshotOf(engine);
    snapshot.environment.moistureOffsetQ[7] = 4097;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/moistureOffsetQ\[7\]/);
  });

  it("rejects biomass above the overfill ceiling, and accepts sanctioned overfill", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = snapshotOf(engine);
    // Find a vegetated cell.
    let cell = -1;
    for (let i = 0; i < snapshot.environment.resourceCapacity.length; i += 1) {
      if ((snapshot.environment.resourceCapacity[i] as number) > 100) {
        cell = i;
        break;
      }
    }
    expect(cell).toBeGreaterThanOrEqual(0);
    const capacity = snapshot.environment.resourceCapacity[cell] as number;

    // 2x capacity is the sanctioned ADD_BIOMASS overfill — loadable.
    snapshot.environment.resourceBiomass[cell] = Math.min(65535, capacity * 2);
    expect(() => SimulationEngine.fromSnapshot(snapshot)).not.toThrow();

    // Beyond the ceiling is corruption.
    snapshot.environment.resourceBiomass[cell] = Math.min(65535, capacity * 2 + 1);
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/overfill ceiling/);
  });

  it("rejects an internally inconsistent founder region", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = snapshotOf(engine);
    snapshot.environment.founderRegion.centerCellIndex += 1;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/does not match/);
  });
});

describe("restore without regeneration (foundation-gate §2)", () => {
  it("loads a snapshot even when its config can no longer generate any world", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    engine.stepMany(10);
    const snapshot = engine.serialize();

    // Make generation impossible while keeping the config valid: demand more
    // plant capacity than any world could hold. A fresh construction throws;
    // the snapshot needs no generation at all and must load.
    snapshot.config.world.validity.minTotalPlantCapacity = Number.MAX_SAFE_INTEGER;
    expect(() => new SimulationEngine({ seed: snapshot.seed, config: snapshot.config })).toThrow(
      WorldGenerationError,
    );
    const restored = SimulationEngine.fromSnapshot(snapshot);
    expect(restored.tick).toBe(10);
    // The hash differs from the source engine's only through the config digest
    // (the validity threshold changed); the world content is byte-identical.
    expect(restored.environment.elevationQ).toEqual(engine.environment.elevationQ);
    expect(restored.founderRegion).toEqual(engine.founderRegion);
  });

  it("adopts the SAVED founder region rather than rediscovering one", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = engine.serialize();
    // A different but internally consistent region: one cell to the right.
    const region = snapshot.environment.founderRegion;
    region.centerGridX += 1;
    region.centerCellIndex += 1;
    const restored = SimulationEngine.fromSnapshot(snapshot);
    expect(restored.founderRegion.centerGridX).toBe(engine.founderRegion.centerGridX + 1);
  });

  it("hashes the founder region: two states differing only there differ (foundation-gate §3)", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = engine.serialize();
    const control = SimulationEngine.fromSnapshot(engine.serialize());
    expect(control.computeStateHash()).toBe(engine.computeStateHash());

    snapshot.environment.founderRegion.centerGridX += 1;
    snapshot.environment.founderRegion.centerCellIndex += 1;
    const moved = SimulationEngine.fromSnapshot(snapshot);
    expect(moved.computeStateHash()).not.toBe(engine.computeStateHash());
  });

  it("stores the generation attempt instead of recomputing it", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    const snapshot = engine.serialize();
    expect(snapshot.generationAttempt).toBe(engine.generationAttempt);
    const restored = SimulationEngine.fromSnapshot(snapshot);
    expect(restored.generationAttempt).toBe(engine.generationAttempt);
  });
});

describe("sealed environment store (foundation-gate §1)", () => {
  it("the store instance is frozen and the global offset cannot be assigned", () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: SMALL_CONFIG });
    expect(Object.isFrozen(engine.environment)).toBe(true);
    expect(() => {
      (
        engine.environment as unknown as { globalTemperatureOffsetCentiC: number }
      ).globalTemperatureOffsetCentiC = 999;
    }).toThrow(TypeError);
    expect(() => {
      (engine.environment as unknown as { plantBiomass: Uint16Array }).plantBiomass =
        new Uint16Array(1);
    }).toThrow(TypeError);
  });
});

describe("world generation still behaves at the boundary (regression guards)", () => {
  it("createWorld remains a pure function of (seed, config): two calls agree", () => {
    const a = createWorld(SMALL_CONFIG, 0xe0a12026);
    const b = createWorld(SMALL_CONFIG, 0xe0a12026);
    expect(a.founderRegion).toEqual(b.founderRegion);
    expect(a.environment.elevationQ).toEqual(b.environment.elevationQ);
    expect(a.environment.biome.filter((v) => v === Biome.Water).length).toBe(
      b.environment.biome.filter((v) => v === Biome.Water).length,
    );
  });
});
