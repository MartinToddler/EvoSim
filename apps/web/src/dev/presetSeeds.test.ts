import { describe, expect, it } from "vitest";
import { createDebugWorld, readDebugWorldModel } from "./debugWorld";
import { FIXTURE_SEED, PRESET_SEEDS, RETRY_PRESET_SEED } from "./presetSeeds";
import { MAX_SEED, formatSeedHex, parseSeedInput } from "./seedInput";

describe("preset seeds", () => {
  it("are unique, in range and typeable in the seed field", () => {
    expect(new Set(PRESET_SEEDS.map((preset) => preset.seed)).size).toBe(PRESET_SEEDS.length);
    for (const preset of PRESET_SEEDS) {
      expect(Number.isInteger(preset.seed)).toBe(true);
      expect(preset.seed).toBeGreaterThanOrEqual(0);
      expect(preset.seed).toBeLessThanOrEqual(MAX_SEED);
      const parsed = parseSeedInput(formatSeedHex(preset.seed));
      expect(parsed.ok).toBe(true);
    }
  });

  it("all carry a label and an explanation of why they are interesting", () => {
    for (const preset of PRESET_SEEDS) {
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(preset.note.trim().length).toBeGreaterThan(20);
    }
  });

  it("include the mandatory deterministic fixture seed", () => {
    expect(PRESET_SEEDS.some((preset) => preset.seed === FIXTURE_SEED)).toBe(true);
    expect(FIXTURE_SEED).toBe(0xe0a12026);
  });

  it("every preset generates a valid world", () => {
    for (const preset of PRESET_SEEDS) {
      const result = createDebugWorld(preset.seed);
      expect(result.ok, `preset "${preset.label}" (${formatSeedHex(preset.seed)})`).toBe(true);
      if (result.ok) {
        expect(readDebugWorldModel(result.value).summary.totalPlantCapacity).toBeGreaterThan(0);
      }
    }
  });

  it("the retry preset really exercises the deterministic retry path", () => {
    // If this fails after a generation change, the "Retry path" preset needs a new
    // seed — its note tells the user the first attempt is rejected, and a debug
    // tool must not describe a world it is not showing.
    const result = createDebugWorld(RETRY_PRESET_SEED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.generationAttempt).toBeGreaterThan(0);
    }
    expect(PRESET_SEEDS.some((preset) => preset.seed === RETRY_PRESET_SEED)).toBe(true);
  });
});
