import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { BIOME_COUNT, BIOME_NAMES, Biome, classifyBiome } from "./biomes";

const thresholds = {
  seaLevelQ: DEFAULT_CONFIG.world.seaLevelQ,
  mountainLevelQ: DEFAULT_CONFIG.world.mountainLevelQ,
  ...DEFAULT_CONFIG.world.biomeThresholds,
};

/** A temperate, moderately wet lowland cell — the grassland baseline. */
const baseline = {
  elevationQ: 2500,
  moistureQ: 2000,
  fertilityQ: 2000,
  temperatureCentiC: 1500,
};

describe("biome enum", () => {
  it("has a name per value", () => {
    expect(BIOME_NAMES).toHaveLength(BIOME_COUNT);
    expect(BIOME_NAMES[Biome.Water]).toBe("Water");
    expect(BIOME_NAMES[Biome.Mountain]).toBe("Mountain");
  });
});

describe("classifyBiome (docs/03 §19)", () => {
  it("classifies the baseline as grassland", () => {
    expect(classifyBiome(baseline, thresholds)).toBe(Biome.Grassland);
  });

  it("puts anything below sea level in water", () => {
    expect(classifyBiome({ ...baseline, elevationQ: thresholds.seaLevelQ - 1 }, thresholds)).toBe(
      Biome.Water,
    );
  });

  it("puts anything above the mountain line in mountain", () => {
    expect(
      classifyBiome({ ...baseline, elevationQ: thresholds.mountainLevelQ + 1 }, thresholds),
    ).toBe(Biome.Mountain);
  });

  it("classifies cold land as tundra", () => {
    expect(classifyBiome({ ...baseline, temperatureCentiC: -500 }, thresholds)).toBe(Biome.Tundra);
  });

  it("classifies hot dry land as desert", () => {
    expect(
      classifyBiome({ ...baseline, moistureQ: 500, temperatureCentiC: 2500 }, thresholds),
    ).toBe(Biome.Desert);
  });

  it("requires both moisture and fertility for forest", () => {
    const wet = { ...baseline, moistureQ: 3000, fertilityQ: 3000 };
    expect(classifyBiome(wet, thresholds)).toBe(Biome.Forest);
    // Wet but infertile is not forest.
    expect(classifyBiome({ ...wet, fertilityQ: 1000 }, thresholds)).toBe(Biome.Grassland);
  });

  it("applies elevation rules before climate rules", () => {
    // A frozen peak is mountain, not tundra: the rule ORDER is part of the
    // contract, not just the thresholds.
    expect(
      classifyBiome(
        { ...baseline, elevationQ: thresholds.mountainLevelQ + 1, temperatureCentiC: -3000 },
        thresholds,
      ),
    ).toBe(Biome.Mountain);
    // A flooded cell is water whatever its climate says.
    expect(
      classifyBiome(
        { ...baseline, elevationQ: 0, moistureQ: 200, temperatureCentiC: 3000 },
        thresholds,
      ),
    ).toBe(Biome.Water);
  });

  it("prefers tundra over desert for cold dry land", () => {
    const coldAndDry = { ...baseline, temperatureCentiC: -1000, moistureQ: 100 };
    expect(classifyBiome(coldAndDry, thresholds)).toBe(Biome.Tundra);
  });

  it("always returns a valid biome", () => {
    for (let elevation = 0; elevation <= 4096; elevation += 256) {
      for (let moisture = 0; moisture <= 4096; moisture += 512) {
        for (let temperature = -2000; temperature <= 4000; temperature += 500) {
          const biome = classifyBiome(
            {
              elevationQ: elevation,
              moistureQ: moisture,
              fertilityQ: 2048,
              temperatureCentiC: temperature,
            },
            thresholds,
          );
          expect(biome).toBeGreaterThanOrEqual(0);
          expect(biome).toBeLessThan(BIOME_COUNT);
        }
      }
    }
  });
});
