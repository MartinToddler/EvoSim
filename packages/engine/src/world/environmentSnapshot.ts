import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
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
  plantBiomass: Uint16Array;
  plantCapacity: Uint16Array;
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
    plantBiomass: new Uint16Array(environment.plantBiomass),
    plantCapacity: new Uint16Array(environment.plantCapacity),
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
  checkLength(snapshot.plantBiomass.length, cells, "plantBiomass");
  checkLength(snapshot.plantCapacity.length, cells, "plantCapacity");
  checkLength(snapshot.plantGrowthRemainderQ.length, cells, "plantGrowthRemainderQ");

  environment.elevationQ.set(snapshot.elevationQ);
  environment.baseMoistureQ.set(snapshot.baseMoistureQ);
  environment.moistureOffsetQ.set(snapshot.moistureOffsetQ);
  environment.fertilityQ.set(snapshot.fertilityQ);
  environment.baseTemperatureCentiC.set(snapshot.baseTemperatureCentiC);
  environment.temperatureOffsetCentiC.set(snapshot.temperatureOffsetCentiC);
  environment.biome.set(snapshot.biome);
  environment.plantBiomass.set(snapshot.plantBiomass);
  environment.plantCapacity.set(snapshot.plantCapacity);
  environment.plantGrowthRemainderQ.set(snapshot.plantGrowthRemainderQ);
  environment.globalTemperatureOffsetCentiC = snapshot.globalTemperatureOffsetCentiC;

  environment.recomputePassability();
  return environment;
}
