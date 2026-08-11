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
