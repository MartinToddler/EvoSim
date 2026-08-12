/**
 * Biome classification constants (docs/03 §19).
 *
 * Only the enum lives here for now; the classification rules and environment
 * arrays arrive with Milestone 2 (tasks C03–C05). Values are wire/config
 * stable: plant capacity/growth tables are indexed by these numbers.
 */
export const Biome = {
  Water: 0,
  Grassland: 1,
  Forest: 2,
  Desert: 3,
  Tundra: 4,
  Mountain: 5,
} as const;

export type Biome = (typeof Biome)[keyof typeof Biome];

export const BIOME_COUNT = 6;

/** Human-readable names, indexed by biome value. Diagnostics only. */
export const BIOME_NAMES: readonly string[] = [
  "Water",
  "Grassland",
  "Forest",
  "Desert",
  "Tundra",
  "Mountain",
];

export interface BiomeInputs {
  elevationQ: number;
  moistureQ: number;
  fertilityQ: number;
  temperatureCentiC: number;
}

export interface BiomeThresholds {
  seaLevelQ: number;
  mountainLevelQ: number;
  tundraTemperatureCentiC: number;
  desertMaxMoistureQ: number;
  desertMinTemperatureCentiC: number;
  forestMinMoistureQ: number;
  forestMinFertilityQ: number;
}

/**
 * Classify one cell (docs/03 §19).
 *
 * The rule ORDER is part of the contract, not just the thresholds: water and
 * mountain are decided by elevation before any climate rule, so a frozen peak
 * is mountain rather than tundra, and a flooded cell is water whatever its
 * climate says. Changing the order changes world hashes.
 */
export function classifyBiome(inputs: BiomeInputs, thresholds: BiomeThresholds): Biome {
  if (inputs.elevationQ < thresholds.seaLevelQ) {
    return Biome.Water;
  }
  if (inputs.elevationQ > thresholds.mountainLevelQ) {
    return Biome.Mountain;
  }
  if (inputs.temperatureCentiC < thresholds.tundraTemperatureCentiC) {
    return Biome.Tundra;
  }
  if (
    inputs.moistureQ < thresholds.desertMaxMoistureQ &&
    inputs.temperatureCentiC > thresholds.desertMinTemperatureCentiC
  ) {
    return Biome.Desert;
  }
  if (
    inputs.moistureQ > thresholds.forestMinMoistureQ &&
    inputs.fertilityQ > thresholds.forestMinFertilityQ
  ) {
    return Biome.Forest;
  }
  return Biome.Grassland;
}
