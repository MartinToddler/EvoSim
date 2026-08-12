import {
  Biome,
  DEFAULT_CONFIG,
  SimulationEngine,
  landFractionQ,
  totalPlantBiomass,
  totalPlantCapacity,
} from "@eon/engine";
import {
  ENVIRONMENT_DEBUG_LAYER_IDS,
  createDebugPixelBuffer,
  paintEnvironmentLayer,
  summarizeEnvironmentFields,
} from "@eon/renderer";
import { beforeAll, describe, expect, it } from "vitest";
import { captureEnvironmentDebugFields } from "./captureEnvironmentDebugFields";
import { FIXTURE_SEED } from "./presetSeeds";

/**
 * End-to-end check of the debug pipeline against a real generated world:
 * engine environment → debug fields → summary and pixels.
 *
 * The unit tests in `@eon/renderer` cover the transformations against synthetic
 * grids. What can only be checked here is that the adapter reads the authoritative
 * arrays faithfully and that observing a world never changes it.
 */
describe("captureEnvironmentDebugFields", () => {
  let engine: SimulationEngine;

  beforeAll(() => {
    engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
  });

  it("matches the engine grid geometry and configured thresholds", () => {
    const fields = captureEnvironmentDebugFields(engine);
    expect(fields.size).toBe(engine.environment.size);
    expect(fields.cellSizeLU).toBe(engine.environment.cellSizeLU);
    expect(fields.elevationQ).toHaveLength(engine.environment.cellCount);
    expect(fields.seaLevelQ).toBe(DEFAULT_CONFIG.world.seaLevelQ);
    expect(fields.mountainLevelQ).toBe(DEFAULT_CONFIG.world.mountainLevelQ);
  });

  it("copies the authoritative arrays verbatim", () => {
    const fields = captureEnvironmentDebugFields(engine);
    const environment = engine.environment;
    expect(Array.from(fields.elevationQ)).toEqual(Array.from(environment.elevationQ));
    expect(Array.from(fields.fertilityQ)).toEqual(Array.from(environment.fertilityQ));
    expect(Array.from(fields.biome)).toEqual(Array.from(environment.biome));
    expect(Array.from(fields.plantCapacity)).toEqual(Array.from(environment.plantCapacity));
    expect(Array.from(fields.plantBiomass)).toEqual(Array.from(environment.plantBiomass));
  });

  it("folds player offsets into effective moisture and temperature", () => {
    const fields = captureEnvironmentDebugFields(engine);
    for (let i = 0; i < engine.environment.cellCount; i += 1) {
      expect(fields.moistureQ[i]).toBe(engine.environment.getMoistureQ(i));
      expect(fields.temperatureCentiC[i]).toBe(engine.environment.getTemperatureCentiC(i));
    }
  });

  it("snapshots rather than aliases: advancing the world leaves an old capture intact", () => {
    const local = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const before = captureEnvironmentDebugFields(local);
    const biomassBefore = Array.from(before.plantBiomass);

    local.stepMany(DEFAULT_CONFIG.time.environmentInterval * 5);

    expect(Array.from(before.plantBiomass)).toEqual(biomassBefore);
    const after = captureEnvironmentDebugFields(local);
    expect(Array.from(after.plantBiomass)).not.toEqual(biomassBefore);
  });

  it("does not change engine state", () => {
    const local = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const stateHash = local.computeStateHash();
    captureEnvironmentDebugFields(local);
    captureEnvironmentDebugFields(local);
    expect(local.computeStateHash()).toBe(stateHash);
    expect(local.tick).toBe(0);
  });

  it("is repeatable for the same state", () => {
    const first = captureEnvironmentDebugFields(engine);
    const second = captureEnvironmentDebugFields(engine);
    expect(Array.from(second.plantCapacity)).toEqual(Array.from(first.plantCapacity));
    expect(second.biomassReference).toBe(first.biomassReference);
  });

  it("uses the world's highest per-cell capacity as the shared vegetation reference", () => {
    const fields = captureEnvironmentDebugFields(engine);
    let max = 0;
    for (const capacity of engine.environment.plantCapacity) {
      if (capacity > max) {
        max = capacity;
      }
    }
    expect(fields.biomassReference).toBe(Math.max(max, 1));
    expect(fields.biomassReference).toBeGreaterThan(1);
  });
});

describe("summary agrees with the engine's own diagnostics", () => {
  it("reports the same land fraction the engine computes", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const summary = summarizeEnvironmentFields(captureEnvironmentDebugFields(engine));
    expect(summary.landFractionQ).toBe(landFractionQ(engine.environment));
  });

  it("reports the same plant totals the engine computes", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const summary = summarizeEnvironmentFields(captureEnvironmentDebugFields(engine));
    expect(summary.totalPlantCapacity).toBe(totalPlantCapacity(engine.environment));
    expect(summary.totalPlantBiomass).toBe(totalPlantBiomass(engine.environment));
  });

  it("counts every cell exactly once across the biome classes", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const summary = summarizeEnvironmentFields(captureEnvironmentDebugFields(engine));
    const counted = summary.biomeCellCounts.reduce((total, cells) => total + cells, 0);
    expect(counted).toBe(engine.environment.cellCount);
    expect(summary.landCells + summary.waterCells).toBe(engine.environment.cellCount);
  });
});

describe("painting a real world", () => {
  it("fills every pixel of every layer", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const fields = captureEnvironmentDebugFields(engine);
    const target = createDebugPixelBuffer(fields);

    for (const layer of ENVIRONMENT_DEBUG_LAYER_IDS) {
      target.fill(0);
      paintEnvironmentLayer(fields, layer, target);
      for (let i = 3; i < target.length; i += 4) {
        expect(target[i]).toBe(255);
      }
    }
  });

  it("places water pixels exactly on the engine's water cells", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const fields = captureEnvironmentDebugFields(engine);
    const target = createDebugPixelBuffer(fields);
    paintEnvironmentLayer(fields, "biome", target);

    // The water swatch is whatever the palette paints for a known water cell;
    // every water cell must get it and no land cell may.
    let waterCellIndex = -1;
    for (let i = 0; i < fields.biome.length; i += 1) {
      if (fields.biome[i] === Biome.Water) {
        waterCellIndex = i;
        break;
      }
    }
    expect(waterCellIndex).toBeGreaterThanOrEqual(0);
    const at = waterCellIndex * 4;
    const water = [target[at], target[at + 1], target[at + 2]];

    let waterPixels = 0;
    for (let i = 0; i < fields.biome.length; i += 1) {
      const base = i * 4;
      const isWaterPixel =
        target[base] === water[0] && target[base + 1] === water[1] && target[base + 2] === water[2];
      expect(isWaterPixel).toBe(fields.biome[i] === Biome.Water);
      if (isWaterPixel) {
        waterPixels += 1;
      }
    }
    expect(waterPixels).toBe(summarizeEnvironmentFields(fields).waterCells);
  });

  it("produces a visibly varied image rather than a flat field", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const fields = captureEnvironmentDebugFields(engine);
    const target = createDebugPixelBuffer(fields);

    for (const layer of ENVIRONMENT_DEBUG_LAYER_IDS) {
      paintEnvironmentLayer(fields, layer, target);
      const distinct = new Set<number>();
      for (let i = 0; i < fields.biome.length; i += 1) {
        const base = i * 4;
        distinct.add(
          ((target[base] as number) << 16) |
            ((target[base + 1] as number) << 8) |
            (target[base + 2] as number),
        );
      }
      // Six for the biome palette; the continuous layers use far more.
      expect(distinct.size).toBeGreaterThanOrEqual(5);
    }
  });
});
