import { describe, expect, it } from "vitest";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q } from "../math/fixed";
import { WorldGenerationError, createWorld } from "./createWorld";
import { Biome } from "./biomes";
import { generateEnvironment, generationSubSeed } from "./generateWorld";
import { totalPlantCapacity } from "./plants";
import { labelLandComponents, landFractionQ, validateWorld } from "./validateWorld";

const FIXTURE_SEED = 0xe0a12026;

/** Seeds used as the calibration suite (docs/07 §12, MVP gate wants ≥10). */
const CALIBRATION_SEEDS = Array.from({ length: 10 }, (_, i) => FIXTURE_SEED + i * 7919);

describe("generationSubSeed", () => {
  it("uses the world seed unchanged on the first attempt", () => {
    expect(generationSubSeed(FIXTURE_SEED, 0)).toBe(FIXTURE_SEED);
  });

  it("derives distinct sub-seeds for later attempts", () => {
    const seen = new Set<number>();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      seen.add(generationSubSeed(FIXTURE_SEED, attempt));
    }
    expect(seen.size).toBe(16);
  });

  it("is deterministic", () => {
    expect(generationSubSeed(FIXTURE_SEED, 3)).toBe(generationSubSeed(FIXTURE_SEED, 3));
  });
});

describe("generateEnvironment determinism", () => {
  it("produces byte-identical arrays for the same seed", () => {
    const a = generateEnvironment(DEFAULT_CONFIG, FIXTURE_SEED);
    const b = generateEnvironment(DEFAULT_CONFIG, FIXTURE_SEED);
    expect(Array.from(a.elevationQ)).toEqual(Array.from(b.elevationQ));
    expect(Array.from(a.baseMoistureQ)).toEqual(Array.from(b.baseMoistureQ));
    expect(Array.from(a.baseTemperatureCentiC)).toEqual(Array.from(b.baseTemperatureCentiC));
    expect(Array.from(a.fertilityQ)).toEqual(Array.from(b.fertilityQ));
    expect(Array.from(a.biome)).toEqual(Array.from(b.biome));
    expect(Array.from(a.plantCapacity)).toEqual(Array.from(b.plantCapacity));
    expect(Array.from(a.plantBiomass)).toEqual(Array.from(b.plantBiomass));
  });

  it("produces different worlds for different seeds", () => {
    const a = generateEnvironment(DEFAULT_CONFIG, 1);
    const b = generateEnvironment(DEFAULT_CONFIG, 2);
    expect(Array.from(a.elevationQ)).not.toEqual(Array.from(b.elevationQ));
  });

  it("does not consume the PRNG (generation is a pure function of seed+config)", () => {
    // Generation must not advance any shared generator: it is called during
    // construction, and a world that "used up" randomness would make the first
    // organism decisions depend on how the map happened to be shaped.
    const environment = generateEnvironment(DEFAULT_CONFIG, FIXTURE_SEED);
    expect(environment.cellCount).toBe(256 * 256);
  });
});

describe("generated world invariants (docs/03 §27)", () => {
  const environment = generateEnvironment(DEFAULT_CONFIG, FIXTURE_SEED);

  // These scan all 65 536 cells and assert once on the violation counts;
  // an expect() per cell would dominate the suite's runtime.
  it("keeps every field inside its array range", () => {
    const violations: string[] = [];
    for (let i = 0; i < environment.cellCount; i += 1) {
      if ((environment.elevationQ[i] as number) > Q) violations.push(`elevation@${i}`);
      if ((environment.baseMoistureQ[i] as number) > Q) violations.push(`moisture@${i}`);
      if ((environment.fertilityQ[i] as number) > Q) violations.push(`fertility@${i}`);
      if ((environment.biome[i] as number) >= 6) violations.push(`biome@${i}`);
      const temperature = environment.baseTemperatureCentiC[i] as number;
      if (temperature <= -32768 || temperature >= 32767) violations.push(`temperature@${i}`);
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });

  it("never lets biomass exceed capacity", () => {
    let violations = 0;
    for (let i = 0; i < environment.cellCount; i += 1) {
      if ((environment.plantBiomass[i] as number) > (environment.plantCapacity[i] as number)) {
        violations += 1;
      }
    }
    expect(violations).toBe(0);
  });

  it("grows nothing in water", () => {
    let vegetatedWater = 0;
    for (let i = 0; i < environment.cellCount; i += 1) {
      if (
        environment.biome[i] === Biome.Water &&
        ((environment.plantCapacity[i] as number) > 0 ||
          (environment.plantBiomass[i] as number) > 0)
      ) {
        vegetatedWater += 1;
      }
    }
    expect(vegetatedWater).toBe(0);
  });

  it("surrounds the world with ocean (docs/03 §15)", () => {
    const { size } = environment;
    for (let g = 0; g < size; g += 1) {
      expect(environment.biome[environment.cellIndex(g, 0)]).toBe(Biome.Water);
      expect(environment.biome[environment.cellIndex(g, size - 1)]).toBe(Biome.Water);
      expect(environment.biome[environment.cellIndex(0, g)]).toBe(Biome.Water);
      expect(environment.biome[environment.cellIndex(size - 1, g)]).toBe(Biome.Water);
    }
  });

  it("marks exactly the water cells impassable", () => {
    let mismatches = 0;
    for (let i = 0; i < environment.cellCount; i += 1) {
      if ((environment.passable[i] === 1) !== (environment.biome[i] !== Biome.Water)) {
        mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
  });

  it("produces a temperature field within the documented range (docs/03 §17)", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < environment.cellCount; i += 1) {
      const temperature = environment.baseTemperatureCentiC[i] as number;
      min = Math.min(min, temperature);
      max = Math.max(max, temperature);
    }
    // docs/03 §17 calls for roughly -15 °C … +35 °C.
    expect(min).toBeGreaterThan(-2500);
    expect(max).toBeLessThan(3800);
    // And it must actually vary, or thermal selection has nothing to act on.
    expect(max - min).toBeGreaterThan(2000);
  });

  it("is colder toward the poles than at the equator", () => {
    const { size } = environment;
    const rowMean = (gy: number): number => {
      let sum = 0;
      for (let gx = 0; gx < size; gx += 1) {
        sum += environment.baseTemperatureCentiC[gy * size + gx] as number;
      }
      return sum / size;
    };
    expect(rowMean(size / 2)).toBeGreaterThan(rowMean(0) + 1000);
    expect(rowMean(size / 2)).toBeGreaterThan(rowMean(size - 1) + 1000);
  });
});

describe("world validity and retry (docs/03 §15)", () => {
  it("accepts the fixture seed on the first attempt", () => {
    const world = createWorld(DEFAULT_CONFIG, FIXTURE_SEED);
    expect(world.attempt).toBe(0);
    expect(world.subSeed).toBe(FIXTURE_SEED);
    expect(world.validity.valid).toBe(true);
  });

  it("produces a valid world for every calibration seed (MVP gate)", () => {
    for (const seed of CALIBRATION_SEEDS) {
      const world = createWorld(DEFAULT_CONFIG, seed);
      expect(world.validity.valid).toBe(true);
      expect(world.validity.landFractionQ).toBeGreaterThanOrEqual(
        DEFAULT_CONFIG.world.minLandFractionQ,
      );
      expect(world.validity.landFractionQ).toBeLessThanOrEqual(
        DEFAULT_CONFIG.world.maxLandFractionQ,
      );
      expect(world.validity.biomeClasses).toBeGreaterThanOrEqual(
        DEFAULT_CONFIG.world.validity.minBiomeClasses,
      );
      expect(world.founderRegion.componentCells).toBeGreaterThanOrEqual(
        DEFAULT_CONFIG.world.validity.minFounderRegionCells,
      );
    }
  });

  it("rejects a world that fails a validity rule instead of shipping it", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    // No world can be 99% land, so every attempt must fail.
    config.world.minLandFractionQ = 4000;
    config.world.maxLandFractionQ = 4096;
    config.world.generationMaxRetries = 2;

    expect(() => createWorld(config, FIXTURE_SEED)).toThrowError(WorldGenerationError);
    try {
      createWorld(config, FIXTURE_SEED);
    } catch (error) {
      expect((error as WorldGenerationError).attempts).toHaveLength(2);
    }
  });

  it("reports why a world was rejected", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.world.validity.minTotalPlantCapacity = 10 ** 12;
    const environment = generateEnvironment(config, FIXTURE_SEED);
    const validity = validateWorld(environment, config);
    expect(validity.valid).toBe(false);
    expect(validity.reason).toContain("total plant capacity");
    expect(validity.founderRegion).toBeNull();
  });

  it("computes a land fraction consistent with the biome array", () => {
    const environment = generateEnvironment(DEFAULT_CONFIG, FIXTURE_SEED);
    let land = 0;
    for (let i = 0; i < environment.cellCount; i += 1) {
      if (environment.biome[i] !== Biome.Water) land += 1;
    }
    expect(landFractionQ(environment)).toBe(Math.trunc((land * Q) / environment.cellCount));
  });

  it("has a total plant capacity above the configured minimum", () => {
    const environment = generateEnvironment(DEFAULT_CONFIG, FIXTURE_SEED);
    expect(totalPlantCapacity(environment)).toBeGreaterThan(
      DEFAULT_CONFIG.world.validity.minTotalPlantCapacity,
    );
  });
});

describe("founder region (docs/03 §26, task C08)", () => {
  const world = createWorld(DEFAULT_CONFIG, FIXTURE_SEED);

  it("sits on productive land", () => {
    const index = world.founderRegion.centerCellIndex;
    expect(world.environment.biome[index]).not.toBe(Biome.Water);
    expect(world.environment.plantCapacity[index] as number).toBeGreaterThan(0);
  });

  it("sits inside the largest connected land component", () => {
    const { labels, sizes } = labelLandComponents(world.environment);
    const label = labels[world.founderRegion.centerCellIndex] as number;
    expect(label).toBeGreaterThan(0);
    const largest = Math.max(...sizes.slice(1));
    expect(sizes[label]).toBe(largest);
    expect(world.founderRegion.componentCells).toBe(largest);
  });

  it("is deterministic for a given seed", () => {
    const again = createWorld(DEFAULT_CONFIG, FIXTURE_SEED);
    expect(again.founderRegion).toEqual(world.founderRegion);
  });

  it("has grid coordinates consistent with the cell index", () => {
    const { centerCellIndex, centerGridX, centerGridY } = world.founderRegion;
    expect(centerGridY * world.environment.size + centerGridX).toBe(centerCellIndex);
  });

  it("prefers a productive neighbourhood over a lone fertile cell", () => {
    // The centre's surroundings should be productive too, not just the cell.
    const { centerGridX, centerGridY } = world.founderRegion;
    let productiveNeighbours = 0;
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const index = world.environment.cellIndex(centerGridX + dx, centerGridY + dy);
        if ((world.environment.plantCapacity[index] as number) > 0) {
          productiveNeighbours += 1;
        }
      }
    }
    expect(productiveNeighbours).toBeGreaterThan(60); // out of 81
  });
});
