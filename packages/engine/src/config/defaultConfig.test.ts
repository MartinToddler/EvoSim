import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_VERSION } from "../version";
import { DEFAULT_CONFIG } from "./defaultConfig";
import { canonicalJsonStringify, hashConfig } from "./hashConfig";
import { validateConfig } from "./validateConfig";

describe("DEFAULT_CONFIG", () => {
  it("declares the current schema version", () => {
    expect(DEFAULT_CONFIG.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("passes structural validation", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.world)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.plants.baseCapacityByBiome)).toBe(true);
    expect(() => {
      (DEFAULT_CONFIG.world as { sizeLU: number }).sizeLU = 1;
    }).toThrow();
  });

  it("keeps the documented v0.1 headline values (docs/08)", () => {
    expect(DEFAULT_CONFIG.world.sizeLU).toBe(4096);
    expect(DEFAULT_CONFIG.world.envGridSize).toBe(256);
    expect(DEFAULT_CONFIG.world.initialOrganisms).toBe(256);
    expect(DEFAULT_CONFIG.time.environmentInterval).toBe(20);
    expect(DEFAULT_CONFIG.time.statisticsInterval).toBe(100);
    expect(DEFAULT_CONFIG.time.speciesAnalysisInterval).toBe(400);
    expect(DEFAULT_CONFIG.limits.maxOrganisms).toBe(8192);
    expect(DEFAULT_CONFIG.limits.maxCarcasses).toBe(4096);
    expect(DEFAULT_CONFIG.brain.weightCount).toBe(400);
  });

  it("contains no wall-clock or presentation values", () => {
    // Host pacing/render/autosave/display values live in HostRuntimeConfig
    // (@eon/protocol) so they can never enter the authoritative config hash.
    const serialized = JSON.stringify(DEFAULT_CONFIG);
    for (const hostField of [
      "targetTicksPerSecond1x",
      "ticksPerSimYear",
      "autosaveCheckInterval",
      "normalRenderSnapshotsPerSecond",
      "maxModeRenderSnapshotsPerSecond",
      "maxWorkerSliceMs",
      "maxDetailedRenderedOrganisms",
    ]) {
      expect(serialized).not.toContain(hostField);
    }
  });

  it("matches the golden config hash (config drift is a versioned decision)", () => {
    expect(hashConfig(DEFAULT_CONFIG)).toBe("66cfb128e8ff0144");
  });
});

describe("canonicalJsonStringify", () => {
  it("sorts object keys so semantically equal configs hash identically", () => {
    const a = { b: 1, a: [1, 2], c: { z: true, y: "s" } };
    const b = { c: { y: "s", z: true }, a: [1, 2], b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it("preserves array order", () => {
    expect(canonicalJsonStringify([1, 2])).not.toBe(canonicalJsonStringify([2, 1]));
  });

  it("rejects non-finite numbers and null", () => {
    expect(() => canonicalJsonStringify({ x: Number.NaN })).toThrow();
    expect(() => canonicalJsonStringify({ x: Infinity })).toThrow();
    expect(() => canonicalJsonStringify({ x: null })).toThrow();
  });
});
