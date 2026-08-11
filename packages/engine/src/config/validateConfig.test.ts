import { deepCloneJson } from "@eon/shared";
import { describe, expect, it } from "vitest";
import type { SimulationConfig } from "./SimulationConfig";
import { DEFAULT_CONFIG } from "./defaultConfig";
import { ConfigValidationError, validateConfig } from "./validateConfig";

function mutatedConfig(mutate: (config: SimulationConfig) => void): SimulationConfig {
  const clone = deepCloneJson(DEFAULT_CONFIG);
  mutate(clone);
  return clone;
}

describe("validateConfig", () => {
  it("accepts the default config", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  it("rejects an unsupported schema version", () => {
    const config = mutatedConfig((c) => {
      c.schemaVersion = 999;
    });
    expect(() => validateConfig(config)).toThrowError(ConfigValidationError);
  });

  it("rejects inconsistent world grid geometry", () => {
    const config = mutatedConfig((c) => {
      c.world.envCellSizeLU = 15; // 256 * 15 !== 4096
    });
    expect(() => validateConfig(config)).toThrowError(/envGridSize \* envCellSizeLU/);
  });

  it("rejects a spatial cell size that does not divide the world", () => {
    const config = mutatedConfig((c) => {
      c.world.spatialCellSizeLU = 33;
    });
    expect(() => validateConfig(config)).toThrowError(/spatialCellSizeLU/);
  });

  it("rejects sea level above mountain level", () => {
    const config = mutatedConfig((c) => {
      c.world.seaLevelQ = 4000;
      c.world.mountainLevelQ = 1000;
    });
    expect(() => validateConfig(config)).toThrowError(/seaLevelQ/);
  });

  it("rejects out-of-range Q fractions", () => {
    const config = mutatedConfig((c) => {
      c.mutation.ecological.perGeneMutationProbabilityQ = 5000;
    });
    expect(() => validateConfig(config)).toThrowError(/perGeneMutationProbabilityQ/);
  });

  it("rejects a brain weight count that contradicts the topology", () => {
    const config = mutatedConfig((c) => {
      c.brain.weightCount = 399;
    });
    expect(() => validateConfig(config)).toThrowError(/weightCount/);
  });

  it("rejects biome tables of the wrong length", () => {
    const config = mutatedConfig((c) => {
      (c.plants as unknown as { baseCapacityByBiome: number[] }).baseCapacityByBiome = [0, 1, 2];
    });
    expect(() => validateConfig(config)).toThrowError(/baseCapacityByBiome/);
  });

  it("rejects founder populations above the organism cap", () => {
    const config = mutatedConfig((c) => {
      c.world.initialOrganisms = c.limits.maxOrganisms + 1;
    });
    expect(() => validateConfig(config)).toThrowError(/initialOrganisms/);
  });

  it("rejects a water movement cost multiplier below 1.0", () => {
    const config = mutatedConfig((c) => {
      c.organism.movement.waterMovementCostMultiplierQ = 2048;
    });
    expect(() => validateConfig(config)).toThrowError(/waterMovementCostMultiplierQ/);
  });
});
