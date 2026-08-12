import { DEBUG_BIOME_COUNT } from "./biomePalette";
import {
  assertDebugFields,
  debugFieldCellCount,
  type EnvironmentDebugFields,
  Q_SCALE,
} from "./environmentDebugFields";

/** Biome enum value 0 is Water (docs/03 §19). */
const WATER_BIOME = 0;

/**
 * Aggregate readouts for the environment debug view.
 *
 * Derived from exactly the same field arrays the painter reads, so the numbers on
 * screen always describe the image on screen. Means are truncated integers rather
 * than floats: it keeps the tests exact and 0.01 °C / 1/4096 is far finer than any
 * question this view answers.
 *
 * These are diagnostics. Nothing here feeds back into the simulation, and the
 * engine has its own authoritative `landFractionQ()` — a test cross-checks the two
 * against a generated world so the debug copy cannot drift into telling a
 * different story.
 */
export interface EnvironmentDebugSummary {
  readonly cellCount: number;
  readonly landCells: number;
  readonly waterCells: number;
  /** Land share in Q units, matching the engine's own definition (non-water cells). */
  readonly landFractionQ: number;
  /** Cell counts per biome, indexed by the engine's Biome enum value. */
  readonly biomeCellCounts: readonly number[];

  readonly meanTemperatureCentiC: number;
  readonly minTemperatureCentiC: number;
  readonly maxTemperatureCentiC: number;

  readonly meanFertilityQ: number;
  readonly meanMoistureQ: number;
  /** Mean elevation, for spotting a world that generated all-ocean or all-plateau. */
  readonly meanElevationQ: number;

  readonly totalPlantCapacity: number;
  readonly totalPlantBiomass: number;
  readonly maxPlantCapacity: number;
  /** Biomass as a Q fraction of capacity; 0 when the world has no capacity at all. */
  readonly biomassFractionOfCapacityQ: number;
}

export function summarizeEnvironmentFields(
  fields: EnvironmentDebugFields,
): EnvironmentDebugSummary {
  assertDebugFields(fields);
  const cellCount = debugFieldCellCount(fields);

  const biomeCellCounts = new Array<number>(DEBUG_BIOME_COUNT).fill(0);
  let unknownBiomeCells = 0;
  let waterCells = 0;

  let temperatureSum = 0;
  let minTemperature = Number.POSITIVE_INFINITY;
  let maxTemperature = Number.NEGATIVE_INFINITY;
  let fertilitySum = 0;
  let moistureSum = 0;
  let elevationSum = 0;
  let capacitySum = 0;
  let biomassSum = 0;
  let maxCapacity = 0;

  for (let i = 0; i < cellCount; i += 1) {
    const biome = fields.biome[i] as number;
    if (biome >= 0 && biome < DEBUG_BIOME_COUNT) {
      biomeCellCounts[biome] = (biomeCellCounts[biome] as number) + 1;
    } else {
      unknownBiomeCells += 1;
    }
    if (biome === WATER_BIOME) {
      waterCells += 1;
    }

    const temperature = fields.temperatureCentiC[i] as number;
    temperatureSum += temperature;
    if (temperature < minTemperature) minTemperature = temperature;
    if (temperature > maxTemperature) maxTemperature = temperature;

    fertilitySum += fields.fertilityQ[i] as number;
    moistureSum += fields.moistureQ[i] as number;
    elevationSum += fields.elevationQ[i] as number;

    const capacity = fields.plantCapacity[i] as number;
    capacitySum += capacity;
    if (capacity > maxCapacity) maxCapacity = capacity;
    biomassSum += fields.plantBiomass[i] as number;
  }

  // An unknown biome value would be a real engine bug; `landCells` refuses to
  // absorb it into either category. `landFractionQ` deliberately keeps the
  // engine's own definition — every non-water cell — so the two numbers can be
  // compared directly (a test does exactly that).
  const landCells = cellCount - waterCells - unknownBiomeCells;

  return {
    cellCount,
    landCells,
    waterCells,
    landFractionQ: Math.trunc(((cellCount - waterCells) * Q_SCALE) / cellCount),
    biomeCellCounts,
    meanTemperatureCentiC: Math.trunc(temperatureSum / cellCount),
    minTemperatureCentiC: minTemperature === Number.POSITIVE_INFINITY ? 0 : minTemperature,
    maxTemperatureCentiC: maxTemperature === Number.NEGATIVE_INFINITY ? 0 : maxTemperature,
    meanFertilityQ: Math.trunc(fertilitySum / cellCount),
    meanMoistureQ: Math.trunc(moistureSum / cellCount),
    meanElevationQ: Math.trunc(elevationSum / cellCount),
    totalPlantCapacity: capacitySum,
    totalPlantBiomass: biomassSum,
    maxPlantCapacity: maxCapacity,
    biomassFractionOfCapacityQ:
      capacitySum > 0 ? Math.trunc((biomassSum * Q_SCALE) / capacitySum) : 0,
  };
}
