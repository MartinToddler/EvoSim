import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_RUNTIME_CONFIG, type HostRuntimeConfig } from "./hostRuntimeConfig";
import {
  HostRuntimeConfigValidationError,
  validateHostRuntimeConfig,
} from "./validateHostRuntimeConfig";

function variant(mutate: (config: HostRuntimeConfig) => void): HostRuntimeConfig {
  const clone: HostRuntimeConfig = { ...DEFAULT_HOST_RUNTIME_CONFIG };
  mutate(clone);
  return clone;
}

describe("DEFAULT_HOST_RUNTIME_CONFIG", () => {
  it("keeps the documented v0.1 hosting values (docs/08 §§3-4)", () => {
    expect(DEFAULT_HOST_RUNTIME_CONFIG.targetTicksPerSecond1x).toBe(20);
    expect(DEFAULT_HOST_RUNTIME_CONFIG.ticksPerSimYear).toBe(2000);
    expect(DEFAULT_HOST_RUNTIME_CONFIG.normalRenderSnapshotsPerSecond).toBe(15);
    expect(DEFAULT_HOST_RUNTIME_CONFIG.maxModeRenderSnapshotsPerSecond).toBe(5);
    expect(DEFAULT_HOST_RUNTIME_CONFIG.maxWorkerSliceMs).toBe(10);
    expect(DEFAULT_HOST_RUNTIME_CONFIG.autosaveCheckInterval).toBe(2000);
    expect(DEFAULT_HOST_RUNTIME_CONFIG.maxDetailedRenderedOrganisms).toBe(250);
  });

  it("is frozen and valid", () => {
    expect(Object.isFrozen(DEFAULT_HOST_RUNTIME_CONFIG)).toBe(true);
    expect(() => validateHostRuntimeConfig(DEFAULT_HOST_RUNTIME_CONFIG)).not.toThrow();
  });
});

describe("validateHostRuntimeConfig", () => {
  it("rejects an unsupported schema version", () => {
    expect(() => validateHostRuntimeConfig(variant((c) => (c.schemaVersion = 99)))).toThrowError(
      HostRuntimeConfigValidationError,
    );
  });

  it("rejects cadences that would divide by zero or spin the worker", () => {
    expect(() =>
      validateHostRuntimeConfig(variant((c) => (c.normalRenderSnapshotsPerSecond = 0))),
    ).toThrow();
    expect(() => validateHostRuntimeConfig(variant((c) => (c.maxWorkerSliceMs = 0)))).toThrow();
    expect(() =>
      validateHostRuntimeConfig(variant((c) => (c.targetTicksPerSecond1x = -1))),
    ).toThrow();
  });

  it("rejects a MAX mode that renders more often than normal mode", () => {
    expect(() =>
      validateHostRuntimeConfig(variant((c) => (c.maxModeRenderSnapshotsPerSecond = 60))),
    ).toThrowError(/MAX mode/);
  });
});
