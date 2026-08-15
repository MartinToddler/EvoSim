import { Biome } from "@eon/engine";
import { describe, expect, it } from "vitest";
import { type DebugWorldModel, createDebugWorld, readDebugWorldModel } from "./debugWorld";
import { FIXTURE_SEED, PRESET_SEEDS, RETRY_PRESET_SEED } from "./presetSeeds";
import { MAX_SEED, formatSeedHex, parseSeedInput } from "./seedInput";

function requireModel(seed: number): DebugWorldModel {
  const result = createDebugWorld(seed);
  if (!result.ok) {
    throw new Error(`expected seed ${seed} to produce a world: ${result.error}`);
  }
  return readDebugWorldModel(result.value);
}

function biomeShare(model: DebugWorldModel, biome: Biome): number {
  return (model.summary.biomeCellCounts[biome] as number) / model.summary.cellCount;
}

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

  it("the golden fixture note is honest about its near-absent forest", () => {
    // The note used to claim "all six biome classes" — true only in the sense that
    // three of 65 536 cells are forest, which nobody can see on the map. A debug
    // tool must not describe a world it is not showing, so the claim now says
    // "a handful of cells" and this pins both halves of it.
    const model = requireModel(FIXTURE_SEED);
    const forest = biomeShare(model, Biome.Forest);
    expect(forest).toBeGreaterThan(0);
    expect(forest).toBeLessThan(0.001);
  });

  it("the no-desert preset really has no desert cells", () => {
    const model = requireModel(0x00c0ffee);
    expect(model.summary.biomeCellCounts[Biome.Desert]).toBe(0);
    expect(PRESET_SEEDS.some((preset) => preset.seed === 0x00c0ffee)).toBe(true);
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
