import { PLANT_RESOURCE_COUNT, Resource } from "./resources";
import type { ResourceProfile } from "../config/SimulationConfig";
import { describe, expect, it } from "vitest";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q } from "../math/fixed";
import { EnvironmentStore } from "./EnvironmentStore";
import { Biome } from "./biomes";
import {
  computeResourceCapacity,
  growPlants,
  moistureSuitabilityQ,
  resourceGradientXQAt,
  resourceGradientYQAt,
  temperatureSuitabilityQ,
  totalPlantBiomass,
} from "./plants";

/** The foliage channel of a config, non-optional. M17 made plants a list. */
function foliageProfile(config: {
  plants: { resources: readonly ResourceProfile[] };
}): ResourceProfile {
  const profile = config.plants.resources[Resource.Foliage];
  if (profile === undefined) {
    throw new Error("config is missing the foliage channel");
  }
  return profile;
}

/** A tiny grassland world with one uniform capacity, for growth arithmetic. */
function grasslandStore(capacity: number, biomass: number, size = 4): EnvironmentStore {
  const store = new EnvironmentStore(size, 16);
  store.biome.fill(Biome.Grassland);
  // The foliage channel only: these tests are about growth arithmetic, and one
  // channel exercises it exactly as five would (M17).
  store.resourceCapacity.fill(capacity, 0, store.cellCount);
  store.resourceBiomass.fill(biomass, 0, store.cellCount);
  return store;
}

describe("temperatureSuitabilityQ", () => {
  it("peaks at the optimum and reaches zero at the tolerance edge", () => {
    expect(temperatureSuitabilityQ(1800, 1800, 2000)).toBe(Q);
    expect(temperatureSuitabilityQ(3800, 1800, 2000)).toBe(0);
    expect(temperatureSuitabilityQ(-200, 1800, 2000)).toBe(0);
  });

  it("is symmetric and linear between", () => {
    const warm = temperatureSuitabilityQ(2800, 1800, 2000);
    const cold = temperatureSuitabilityQ(800, 1800, 2000);
    expect(warm).toBe(cold);
    expect(warm).toBe(Q / 2);
  });

  it("stays at zero far outside the window", () => {
    expect(temperatureSuitabilityQ(10_000, 1800, 2000)).toBe(0);
    expect(temperatureSuitabilityQ(-10_000, 1800, 2000)).toBe(0);
  });
});

describe("moistureSuitabilityQ", () => {
  it("is zero at or below the minimum and full at or above the full point", () => {
    expect(moistureSuitabilityQ(0, 205, 2458)).toBe(0);
    expect(moistureSuitabilityQ(205, 205, 2458)).toBe(0);
    expect(moistureSuitabilityQ(2458, 205, 2458)).toBe(Q);
    expect(moistureSuitabilityQ(4096, 205, 2458)).toBe(Q);
  });

  it("rises monotonically in between", () => {
    let previous = -1;
    for (let m = 0; m <= 4096; m += 64) {
      const value = moistureSuitabilityQ(m, 205, 2458);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("computeResourceCapacity", () => {
  it("is zero in water however fertile the cell looks", () => {
    expect(
      computeResourceCapacity(DEFAULT_CONFIG, Resource.Foliage, Biome.Water, Q, Q, 1800, 2048),
    ).toBe(0);
  });

  it("is zero outside the temperature window", () => {
    expect(
      computeResourceCapacity(DEFAULT_CONFIG, Resource.Foliage, Biome.Grassland, Q, Q, -5000, 2048),
    ).toBe(0);
    expect(
      computeResourceCapacity(DEFAULT_CONFIG, Resource.Foliage, Biome.Grassland, Q, Q, 9000, 2048),
    ).toBe(0);
  });

  it("is zero in a bone-dry cell", () => {
    expect(
      computeResourceCapacity(DEFAULT_CONFIG, Resource.Foliage, Biome.Grassland, Q, 0, 1800, 2048),
    ).toBe(0);
  });

  it("reaches the biome base under ideal conditions", () => {
    const ideal = computeResourceCapacity(
      DEFAULT_CONFIG,
      Resource.Foliage,
      Biome.Grassland,
      Q,
      Q,
      1800,
      2048,
    );
    expect(ideal).toBe(foliageProfile(DEFAULT_CONFIG).baseCapacityByBiome[Biome.Grassland]);
  });

  it("ranks forest above grassland above desert under equal conditions", () => {
    const forest = computeResourceCapacity(
      DEFAULT_CONFIG,
      Resource.Foliage,
      Biome.Forest,
      Q,
      Q,
      1800,
      2048,
    );
    const grass = computeResourceCapacity(
      DEFAULT_CONFIG,
      Resource.Foliage,
      Biome.Grassland,
      Q,
      Q,
      1800,
      2048,
    );
    const desert = computeResourceCapacity(
      DEFAULT_CONFIG,
      Resource.Foliage,
      Biome.Desert,
      Q,
      Q,
      1800,
      2048,
    );
    expect(forest).toBeGreaterThan(grass);
    expect(grass).toBeGreaterThan(desert);
  });

  it("never exceeds the Uint16 biomass array range", () => {
    for (let biome = 0; biome < 6; biome += 1) {
      for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
        const capacity = computeResourceCapacity(DEFAULT_CONFIG, resource, biome, Q, Q, 1800, 2048);
        expect(capacity).toBeLessThanOrEqual(65535);
      }
      const capacity = computeResourceCapacity(
        DEFAULT_CONFIG,
        Resource.Foliage,
        biome,
        Q,
        Q,
        1800,
        2048,
      );
      expect(capacity).toBeLessThanOrEqual(65535);
    }
  });
});

describe("growPlants (docs/03 §20)", () => {
  it("grows toward capacity without exceeding it", () => {
    const store = grasslandStore(10_000, 5_000);
    for (let step = 0; step < 500; step += 1) {
      growPlants(store, DEFAULT_CONFIG);
      for (let i = 0; i < store.cellCount; i += 1) {
        expect(store.resourceBiomass[i] as number).toBeLessThanOrEqual(10_000);
      }
    }
    // Logistic growth should have closed most of the gap in 500 steps.
    expect(store.resourceBiomass[0] as number).toBeGreaterThan(9_000);
  });

  it("grows fastest near half capacity (logistic shape)", () => {
    const low = grasslandStore(10_000, 500);
    const mid = grasslandStore(10_000, 5_000);
    const high = grasslandStore(10_000, 9_500);
    growPlants(low, DEFAULT_CONFIG);
    growPlants(mid, DEFAULT_CONFIG);
    growPlants(high, DEFAULT_CONFIG);

    const lowDelta = (low.resourceBiomass[0] as number) - 500;
    const midDelta = (mid.resourceBiomass[0] as number) - 5_000;
    const highDelta = (high.resourceBiomass[0] as number) - 9_500;
    expect(midDelta).toBeGreaterThan(lowDelta);
    expect(midDelta).toBeGreaterThan(highDelta);
  });

  it("never tops up a cell that still has biomass, however little", () => {
    // The defect this pins down: the seed bank used to fire below a per-channel
    // `minRegenThreshold`, so a cell grazed just under it collected a flat
    // deposit every step forever. That is a food source rather than a recovery
    // mechanism — it is independent of capacity and of growth rate, so it set
    // the population ceiling by itself and made capacity tuning nearly inert.
    //
    // One unit of biomass in a 10 000-capacity cell grows by 49·1·9999/10000 =
    // 48 Q per step, so 10 steps accumulate 480 Q — well short of the 4096 Q
    // that buys a whole unit. The cell must therefore be *exactly* unchanged.
    const store = grasslandStore(10_000, 1);
    for (let step = 0; step < 10; step += 1) {
      growPlants(store, DEFAULT_CONFIG);
    }
    expect(store.resourceBiomass[0] as number).toBe(1);

    // The same cell emptied completely gets exactly one deposit, once.
    const emptied = grasslandStore(10_000, 0);
    growPlants(emptied, DEFAULT_CONFIG);
    const regen = foliageProfile(DEFAULT_CONFIG).seedBankRegenUnits;
    expect(emptied.resourceBiomass[0] as number).toBe(regen);
    growPlants(emptied, DEFAULT_CONFIG);
    expect(emptied.resourceBiomass[0] as number).toBeLessThan(regen * 2);
  });

  it("recovers a cell grazed to exactly zero via the seed bank", () => {
    const store = grasslandStore(10_000, 0);
    growPlants(store, DEFAULT_CONFIG);
    expect(store.resourceBiomass[0] as number).toBeGreaterThan(0);

    // It must climb away from the trickle under its own logistic growth rather
    // than being carried by repeated seed-bank deposits — the seed bank fires
    // once, on the empty cell, and never again. The pace matches the continuous
    // solution from a single 4-unit deposit (10000/(1 + 2499·e^(-0.012·200)) ≈
    // 44), so recovery is slow at first by design.
    for (let step = 0; step < 200; step += 1) {
      growPlants(store, DEFAULT_CONFIG);
    }
    const after200 = store.resourceBiomass[0] as number;
    expect(after200).toBeGreaterThan(foliageProfile(DEFAULT_CONFIG).seedBankRegenUnits * 8);

    // Given enough time it recovers fully rather than stalling.
    for (let step = 0; step < 800; step += 1) {
      growPlants(store, DEFAULT_CONFIG);
    }
    expect(store.resourceBiomass[0] as number).toBeGreaterThan(9_000);
  });

  it("never freezes a sparse cell, in any biome (integer truncation trap)", () => {
    // The logistic delta of a sparse cell is far below one biomass unit, and in
    // a slow biome it stays below one for hundreds of units. Truncating it would
    // leave the cell permanently frozen — silently, and only in some biomes.
    for (const biome of [
      Biome.Grassland,
      Biome.Forest,
      Biome.Desert,
      Biome.Tundra,
      Biome.Mountain,
    ]) {
      const store = grasslandStore(4_000, 20);
      store.biome.fill(biome);
      const start = store.resourceBiomass[0] as number;
      for (let step = 0; step < 2_000; step += 1) {
        growPlants(store, DEFAULT_CONFIG);
      }
      expect(store.resourceBiomass[0] as number).toBeGreaterThan(start);
    }
  });

  it("keeps barren cells at zero", () => {
    const store = grasslandStore(0, 0);
    store.biome.fill(Biome.Water);
    for (let step = 0; step < 50; step += 1) {
      growPlants(store, DEFAULT_CONFIG);
    }
    expect(totalPlantBiomass(store)).toBe(0);
  });

  it("clamps biomass down when capacity shrinks", () => {
    const store = grasslandStore(10_000, 9_000);
    store.resourceCapacity.fill(1_000);
    growPlants(store, DEFAULT_CONFIG);
    expect(store.resourceBiomass[0] as number).toBeLessThanOrEqual(1_000);
  });

  it("does not grow biomes with a zero growth rate", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    foliageProfile(config).growthRateQByBiome = [0, 0, 0, 0, 0, 0];
    foliageProfile(config).seedBankRegenUnits = 0;
    const store = grasslandStore(10_000, 5_000);
    growPlants(store, config);
    expect(store.resourceBiomass[0] as number).toBe(5_000);
  });
});

describe("plant gradient (docs/03 §22)", () => {
  it("points toward richer cells", () => {
    const store = new EnvironmentStore(4, 16);
    store.biome.fill(Biome.Grassland);
    store.resourceCapacity.fill(10_000);
    // A horizontal ramp: biomass grows with x.
    for (let gy = 0; gy < 4; gy += 1) {
      for (let gx = 0; gx < 4; gx += 1) {
        store.resourceBiomass[gy * 4 + gx] = gx * 2_000;
      }
    }

    // Interior cell: food is to the right, so the x gradient is positive.
    const interior = 1 * 4 + 1;
    expect(resourceGradientXQAt(store, Resource.Foliage, interior)).toBeGreaterThan(0);
    expect(resourceGradientYQAt(store, Resource.Foliage, interior)).toBe(0);
  });

  it("is zero on a uniform field", () => {
    const store = grasslandStore(10_000, 5_000);
    for (let i = 0; i < store.cellCount; i += 1) {
      expect(resourceGradientXQAt(store, Resource.Foliage, i)).toBe(0);
      expect(resourceGradientYQAt(store, Resource.Foliage, i)).toBe(0);
    }
  });

  it("stays inside the signed Q range", () => {
    const store = new EnvironmentStore(8, 16);
    store.biome.fill(Biome.Grassland);
    store.resourceCapacity.fill(1);
    for (let i = 0; i < store.cellCount; i += 1) {
      store.resourceBiomass[i] = i % 2 === 0 ? 0 : 65535;
    }
    for (let i = 0; i < store.cellCount; i += 1) {
      expect(resourceGradientXQAt(store, Resource.Foliage, i)).toBeGreaterThanOrEqual(-Q);
      expect(resourceGradientXQAt(store, Resource.Foliage, i)).toBeLessThanOrEqual(Q);
      expect(resourceGradientYQAt(store, Resource.Foliage, i)).toBeGreaterThanOrEqual(-Q);
      expect(resourceGradientYQAt(store, Resource.Foliage, i)).toBeLessThanOrEqual(Q);
    }
  });

  it("reflects grazing immediately, with no refresh step in between", () => {
    // The gradient used to be a cached array refreshed only by the environment
    // update. Organisms eat every tick, so the cache went stale and a snapshot
    // restore — which recomputed it — diverged from the continuous run.
    const store = grasslandStore(10_000, 5_000);
    const cell = store.cellIndex(4, 4);
    expect(resourceGradientXQAt(store, Resource.Foliage, cell)).toBe(0);
    store.resourceBiomass[store.cellIndex(5, 4)] = 9_000;
    expect(resourceGradientXQAt(store, Resource.Foliage, cell)).toBeGreaterThan(0);
  });

  it("samples itself at the world border instead of reading past the edge", () => {
    const store = grasslandStore(10_000, 5_000);
    const size = store.size;
    for (const cell of [0, size - 1, (size - 1) * size, size * size - 1]) {
      expect(resourceGradientXQAt(store, Resource.Foliage, cell)).toBe(0);
      expect(resourceGradientYQAt(store, Resource.Foliage, cell)).toBe(0);
    }
  });
});
