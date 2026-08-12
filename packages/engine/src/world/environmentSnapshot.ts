import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q } from "../math/fixed";
import { EnvironmentStore } from "./EnvironmentStore";
import { BIOME_COUNT } from "./biomes";
import { recomputePlantGradient } from "./plants";
import type { FounderRegion } from "./validateWorld";

/**
 * Serializable environment state (docs/10 §18).
 *
 * Typed arrays are kept as typed arrays rather than being flattened to JSON
 * numbers: docs/10 §18 requires lossless storage, and a 65 536-entry array is
 * ~128 KB as binary against megabytes as decimal text.
 *
 * Only authoritative arrays are captured. The derived caches (passability,
 * plant gradient) are recomputed on restore, which is both smaller and safer:
 * a stale cache in a save can never disagree with the state it was derived
 * from.
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
  founderRegion: Readonly<FounderRegion>,
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

/** First index where `values[i]` leaves [0, max], or -1 when all are in range. */
function findOutOfRange(values: ArrayLike<number>, max: number): number {
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as number;
    if (value < 0 || value > max) {
      return i;
    }
  }
  return -1;
}

function checkRange(values: ArrayLike<number>, max: number, name: string): void {
  const bad = findOutOfRange(values, max);
  if (bad >= 0) {
    throw new EnvironmentSnapshotError(
      `environment snapshot ${name}[${bad}] = ${values[bad] as number} is outside [0, ${max}]`,
    );
  }
}

/**
 * Check the value invariants the engine relies on but cannot re-derive.
 *
 * Array lengths alone are not enough. A payload with the right shape and wrong
 * contents — a biome index no table covers, a carried growth fraction at or
 * above Q, biomass above its own cell's capacity — restores "successfully" and
 * then behaves as a silently different world: unknown biomes fall through
 * `?? 0` lookups and sterilise the cell. docs/03 §27 states these as world
 * invariants, so a load that cannot satisfy them must fail loudly instead.
 *
 * One pass over the grid on load only; nothing here runs per tick.
 */
function validateEnvironmentValues(snapshot: EnvironmentSnapshot, cells: number): void {
  checkRange(snapshot.elevationQ, Q, "elevationQ");
  checkRange(snapshot.baseMoistureQ, Q, "baseMoistureQ");
  checkRange(snapshot.fertilityQ, Q, "fertilityQ");
  // Carried growth is strictly below one whole unit by construction.
  checkRange(snapshot.plantGrowthRemainderQ, Q - 1, "plantGrowthRemainderQ");
  checkRange(snapshot.biome, BIOME_COUNT - 1, "biome");

  for (let i = 0; i < cells; i += 1) {
    const biomass = snapshot.plantBiomass[i] as number;
    const capacity = snapshot.plantCapacity[i] as number;
    if (biomass > capacity) {
      throw new EnvironmentSnapshotError(
        `environment snapshot plantBiomass[${i}] = ${biomass} exceeds plantCapacity[${i}] = ${capacity}`,
      );
    }
  }

  if (!Number.isSafeInteger(snapshot.globalTemperatureOffsetCentiC)) {
    throw new EnvironmentSnapshotError(
      `environment snapshot globalTemperatureOffsetCentiC must be an integer, got ` +
        `${snapshot.globalTemperatureOffsetCentiC}`,
    );
  }
}

/**
 * Check the founder region against the grid it belongs to (docs/03 §26).
 *
 * The region decides where Milestone 3 spawns the founder population and is
 * part of the canonical state hash, so a payload that disagrees with its own
 * grid must not load.
 */
function validateFounderRegion(region: FounderRegion, size: number, cells: number): void {
  const fields: readonly [keyof FounderRegion, number][] = [
    ["centerCellIndex", region.centerCellIndex],
    ["centerGridX", region.centerGridX],
    ["centerGridY", region.centerGridY],
    ["componentCells", region.componentCells],
  ];
  for (const [name, value] of fields) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EnvironmentSnapshotError(
        `environment snapshot founderRegion.${name} must be a non-negative integer, got ${value}`,
      );
    }
  }
  if (region.centerGridX >= size || region.centerGridY >= size) {
    throw new EnvironmentSnapshotError(
      `environment snapshot founderRegion centre (${region.centerGridX}, ${region.centerGridY}) ` +
        `is outside the ${size}x${size} grid`,
    );
  }
  if (region.centerCellIndex !== region.centerGridY * size + region.centerGridX) {
    throw new EnvironmentSnapshotError(
      `environment snapshot founderRegion.centerCellIndex ${region.centerCellIndex} does not ` +
        `match its grid coordinates (${region.centerGridX}, ${region.centerGridY})`,
    );
  }
  if (region.componentCells < 1 || region.componentCells > cells) {
    throw new EnvironmentSnapshotError(
      `environment snapshot founderRegion.componentCells ${region.componentCells} is not a ` +
        `possible component size for ${cells} cells`,
    );
  }
}

/**
 * Rebuild a live store from a snapshot, validating array lengths and values
 * first (docs/06 §27: a load validates before trusting the payload).
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

  validateEnvironmentValues(snapshot, cells);
  validateFounderRegion(snapshot.founderRegion, environment.size, cells);

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
  environment.setGlobalTemperatureOffsetCentiC(snapshot.globalTemperatureOffsetCentiC);

  environment.recomputePassability();
  recomputePlantGradient(environment);
  return environment;
}
