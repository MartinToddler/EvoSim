import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q } from "../math/fixed";
import { PLANT_RESOURCE_COUNT } from "./resources";
import { BIOME_COUNT } from "./biomes";
import { EnvironmentStore } from "./EnvironmentStore";
import type { FounderRegion } from "./validateWorld";

/**
 * Serializable environment state (docs/10 §18).
 *
 * Typed arrays are kept as typed arrays rather than being flattened to JSON
 * numbers: docs/10 §18 requires lossless storage, and a 65 536-entry array is
 * ~128 KB as binary against megabytes as decimal text.
 *
 * Only authoritative arrays are captured. Passability is recomputed on restore,
 * which is both smaller and safer: a stale cache in a save can never disagree
 * with the state it was derived from. The plant gradient is not stored at all —
 * it is computed where it is read (see plants.ts).
 */
export interface EnvironmentSnapshot {
  size: number;
  cellSizeLU: number;
  globalTemperatureOffsetCentiC: number;
  elevationQ: Uint16Array;
  baseMoistureQ: Uint16Array;
  moistureOffsetQ: Int16Array;
  fertilityQ: Uint16Array;
  baseTemperatureCentiC: Int16Array;
  temperatureOffsetCentiC: Int16Array;
  biome: Uint8Array;
  resourceBiomass: Uint16Array;
  resourceCapacity: Uint16Array;
  plantGrowthRemainderQ: Uint16Array;
  founderRegion: FounderRegion;
}

/** Copy the authoritative environment arrays out of the live store. */
export function captureEnvironment(
  environment: EnvironmentStore,
  founderRegion: FounderRegion,
): EnvironmentSnapshot {
  return {
    size: environment.size,
    cellSizeLU: environment.cellSizeLU,
    globalTemperatureOffsetCentiC: environment.globalTemperatureOffsetCentiC,
    elevationQ: new Uint16Array(environment.elevationQ),
    baseMoistureQ: new Uint16Array(environment.baseMoistureQ),
    moistureOffsetQ: new Int16Array(environment.moistureOffsetQ),
    fertilityQ: new Uint16Array(environment.fertilityQ),
    baseTemperatureCentiC: new Int16Array(environment.baseTemperatureCentiC),
    temperatureOffsetCentiC: new Int16Array(environment.temperatureOffsetCentiC),
    biome: new Uint8Array(environment.biome),
    resourceBiomass: new Uint16Array(environment.resourceBiomass),
    resourceCapacity: new Uint16Array(environment.resourceCapacity),
    plantGrowthRemainderQ: new Uint16Array(environment.plantGrowthRemainderQ),
    founderRegion: { ...founderRegion },
  };
}

/** Error thrown when an environment snapshot cannot be restored. */
export class EnvironmentSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentSnapshotError";
  }
}

function checkLength(actual: number, expected: number, name: string): void {
  if (actual !== expected) {
    throw new EnvironmentSnapshotError(
      `environment snapshot array ${name} has ${actual} entries, expected ${expected}`,
    );
  }
}

function checkRange(values: ArrayLike<number>, min: number, max: number, name: string): void {
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as number;
    if (value < min || value > max) {
      throw new EnvironmentSnapshotError(
        `environment snapshot ${name}[${i}] is ${value}, outside [${min}, ${max}]`,
      );
    }
  }
}

/**
 * Rebuild a live store from a snapshot, validating array lengths first
 * (docs/06 §27: a load validates lengths before trusting the payload).
 */
export function restoreEnvironment(
  snapshot: EnvironmentSnapshot,
  config: DeepReadonly<SimulationConfig>,
): EnvironmentStore {
  if (snapshot.size !== config.world.envGridSize) {
    throw new EnvironmentSnapshotError(
      `environment snapshot grid size ${snapshot.size} does not match config ${config.world.envGridSize}`,
    );
  }
  if (snapshot.cellSizeLU !== config.world.envCellSizeLU) {
    throw new EnvironmentSnapshotError(
      `environment snapshot cell size ${snapshot.cellSizeLU} does not match config ${config.world.envCellSizeLU}`,
    );
  }

  const environment = new EnvironmentStore(snapshot.size, snapshot.cellSizeLU);
  const cells = environment.cellCount;

  checkLength(snapshot.elevationQ.length, cells, "elevationQ");
  checkLength(snapshot.baseMoistureQ.length, cells, "baseMoistureQ");
  checkLength(snapshot.moistureOffsetQ.length, cells, "moistureOffsetQ");
  checkLength(snapshot.fertilityQ.length, cells, "fertilityQ");
  checkLength(snapshot.baseTemperatureCentiC.length, cells, "baseTemperatureCentiC");
  checkLength(snapshot.temperatureOffsetCentiC.length, cells, "temperatureOffsetCentiC");
  checkLength(snapshot.biome.length, cells, "biome");
  const resourceCells = cells * PLANT_RESOURCE_COUNT;
  checkLength(snapshot.resourceBiomass.length, resourceCells, "resourceBiomass");
  checkLength(snapshot.resourceCapacity.length, resourceCells, "resourceCapacity");
  checkLength(snapshot.plantGrowthRemainderQ.length, resourceCells, "plantGrowthRemainderQ");

  // Value validation (docs/06 §27, docs/03 §27; foundation-gate ADR §5): a
  // payload with correct lengths and impossible contents must fail here, not
  // surface later as a world that silently went barren or wrapped a row.
  checkRange(snapshot.elevationQ, 0, Q, "elevationQ");
  checkRange(snapshot.baseMoistureQ, 0, Q, "baseMoistureQ");
  checkRange(snapshot.moistureOffsetQ, -Q, Q, "moistureOffsetQ");
  checkRange(snapshot.fertilityQ, 0, Q, "fertilityQ");
  checkRange(snapshot.temperatureOffsetCentiC, -32768, 32767, "temperatureOffsetCentiC");
  // Growth carry is a strict fraction of one biomass unit.
  checkRange(snapshot.plantGrowthRemainderQ, 0, Q - 1, "plantGrowthRemainderQ");
  for (let i = 0; i < snapshot.biome.length; i += 1) {
    const biome = snapshot.biome[i] as number;
    if (biome >= BIOME_COUNT) {
      throw new EnvironmentSnapshotError(
        `environment snapshot biome[${i}] is ${biome}, not a Biome value (0..${BIOME_COUNT - 1})`,
      );
    }
  }
  // Biomass may exceed capacity only within the documented transient brush
  // overfill allowance (docs/03 §27, interventions.biomassOverfillLimitQ) —
  // a snapshot saved right after an ADD_BIOMASS stroke is a legitimate world.
  const overfillLimitQ = config.interventions.biomassOverfillLimitQ;
  for (let i = 0; i < snapshot.resourceBiomass.length; i += 1) {
    const biomass = snapshot.resourceBiomass[i] as number;
    const capacity = snapshot.resourceCapacity[i] as number;
    const ceiling = Math.trunc((capacity * overfillLimitQ) / Q);
    if (biomass > ceiling) {
      throw new EnvironmentSnapshotError(
        `environment snapshot resourceBiomass[${i}] is ${biomass}, above the overfill ceiling ` +
          `${ceiling} for capacity ${capacity}`,
      );
    }
  }
  if (!Number.isSafeInteger(snapshot.globalTemperatureOffsetCentiC)) {
    throw new EnvironmentSnapshotError(
      `environment snapshot global temperature offset must be an integer, got ` +
        `${snapshot.globalTemperatureOffsetCentiC}`,
    );
  }

  // The founder region must be internally consistent with the grid it claims
  // to belong to: it becomes authoritative state on restore (the saved region
  // is the true one; foundation-gate ADR §2), so a corrupt one must not load.
  const region = snapshot.founderRegion;
  const inGrid =
    Number.isSafeInteger(region.centerGridX) &&
    Number.isSafeInteger(region.centerGridY) &&
    region.centerGridX >= 0 &&
    region.centerGridX < snapshot.size &&
    region.centerGridY >= 0 &&
    region.centerGridY < snapshot.size;
  if (!inGrid) {
    throw new EnvironmentSnapshotError(
      `environment snapshot founder region centre (${region.centerGridX}, ${region.centerGridY}) ` +
        `is outside the ${snapshot.size}x${snapshot.size} grid`,
    );
  }
  if (region.centerCellIndex !== region.centerGridY * snapshot.size + region.centerGridX) {
    throw new EnvironmentSnapshotError(
      `environment snapshot founder region cell index ${region.centerCellIndex} does not match ` +
        `its coordinates (${region.centerGridX}, ${region.centerGridY})`,
    );
  }
  if (
    !Number.isSafeInteger(region.componentCells) ||
    region.componentCells < 1 ||
    region.componentCells > snapshot.size * snapshot.size
  ) {
    throw new EnvironmentSnapshotError(
      `environment snapshot founder region component size ${region.componentCells} is not a ` +
        `cell count within the grid`,
    );
  }

  environment.elevationQ.set(snapshot.elevationQ);
  environment.baseMoistureQ.set(snapshot.baseMoistureQ);
  environment.moistureOffsetQ.set(snapshot.moistureOffsetQ);
  environment.fertilityQ.set(snapshot.fertilityQ);
  environment.baseTemperatureCentiC.set(snapshot.baseTemperatureCentiC);
  environment.temperatureOffsetCentiC.set(snapshot.temperatureOffsetCentiC);
  environment.biome.set(snapshot.biome);
  environment.resourceBiomass.set(snapshot.resourceBiomass);
  environment.resourceCapacity.set(snapshot.resourceCapacity);
  environment.plantGrowthRemainderQ.set(snapshot.plantGrowthRemainderQ);
  environment.setGlobalTemperatureOffsetCentiC(snapshot.globalTemperatureOffsetCentiC);

  environment.recomputePassability();
  return environment;
}
