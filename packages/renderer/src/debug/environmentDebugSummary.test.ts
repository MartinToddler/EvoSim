import { describe, expect, it } from "vitest";
import { type EnvironmentDebugFields, Q_SCALE } from "./environmentDebugFields";
import { summarizeEnvironmentFields } from "./environmentDebugSummary";

function makeFields(overrides: Partial<EnvironmentDebugFields> = {}): EnvironmentDebugFields {
  return {
    size: 2,
    cellSizeLU: 16,
    elevationQ: new Uint16Array([0, 2048, 4096, 2048]),
    moistureQ: new Uint16Array([4096, 2048, 0, 2048]),
    temperatureCentiC: new Int16Array([-1000, 0, 1000, 2000]),
    fertilityQ: new Uint16Array([0, 1024, 2048, 4096]),
    biome: new Uint8Array([0, 1, 0, 3]),
    plantCapacity: new Uint16Array([0, 1000, 0, 3000]),
    plantBiomass: new Uint16Array([0, 500, 0, 500]),
    seaLevelQ: 1884,
    mountainLevelQ: 3195,
    biomassReference: 3000,
    ...overrides,
  };
}

describe("summarizeEnvironmentFields", () => {
  it("counts land and water using the engine's definition (non-water is land)", () => {
    const summary = summarizeEnvironmentFields(makeFields());
    expect(summary.cellCount).toBe(4);
    expect(summary.waterCells).toBe(2);
    expect(summary.landCells).toBe(2);
    expect(summary.landFractionQ).toBe(Q_SCALE / 2);
  });

  it("counts cells per biome", () => {
    const summary = summarizeEnvironmentFields(makeFields());
    expect(summary.biomeCellCounts).toEqual([2, 1, 0, 1, 0, 0]);
  });

  it("does not fold an unknown biome value into land or water", () => {
    const summary = summarizeEnvironmentFields(
      makeFields({ biome: new Uint8Array([0, 1, 2, 200]) }),
    );
    expect(summary.waterCells).toBe(1);
    expect(summary.landCells).toBe(2);
    expect(summary.biomeCellCounts).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it("reports mean, min and max temperature in centi-Celsius", () => {
    const summary = summarizeEnvironmentFields(makeFields());
    expect(summary.meanTemperatureCentiC).toBe(500); // (-1000 + 0 + 1000 + 2000) / 4
    expect(summary.minTemperatureCentiC).toBe(-1000);
    expect(summary.maxTemperatureCentiC).toBe(2000);
  });

  it("reports mean fertility, moisture and elevation in Q units", () => {
    const summary = summarizeEnvironmentFields(makeFields());
    expect(summary.meanFertilityQ).toBe(1792); // (0 + 1024 + 2048 + 4096) / 4
    expect(summary.meanMoistureQ).toBe(2048);
    expect(summary.meanElevationQ).toBe(2048);
  });

  it("truncates means rather than rounding, deterministically", () => {
    const summary = summarizeEnvironmentFields(
      makeFields({ fertilityQ: new Uint16Array([1, 1, 1, 2]) }),
    );
    expect(summary.meanFertilityQ).toBe(1); // 5/4 = 1.25 -> 1
  });

  it("totals capacity and biomass and reports the saturation fraction", () => {
    const summary = summarizeEnvironmentFields(makeFields());
    expect(summary.totalPlantCapacity).toBe(4000);
    expect(summary.totalPlantBiomass).toBe(1000);
    expect(summary.maxPlantCapacity).toBe(3000);
    expect(summary.biomassFractionOfCapacityQ).toBe(Q_SCALE / 4);
  });

  it("reports zero saturation for a world with no capacity instead of dividing by zero", () => {
    const summary = summarizeEnvironmentFields(
      makeFields({
        plantCapacity: new Uint16Array(4),
        plantBiomass: new Uint16Array(4),
      }),
    );
    expect(summary.totalPlantCapacity).toBe(0);
    expect(summary.biomassFractionOfCapacityQ).toBe(0);
    expect(Number.isNaN(summary.biomassFractionOfCapacityQ)).toBe(false);
  });

  it("validates its input like the painter does", () => {
    expect(() => summarizeEnvironmentFields(makeFields({ biome: new Uint8Array(3) }))).toThrow(
      /biome has 3 entries/,
    );
  });
});
