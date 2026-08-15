import type { Rgb } from "./colorRamp";

/**
 * Debug biome palette and labels.
 *
 * Indexed by the engine's `Biome` enum value (Water, Grassland, Forest, Desert,
 * Tundra, Mountain — docs/03 §19). This is an intentional second copy rather than
 * an import: keeping `@eon/renderer` free of an `@eon/engine` dependency is worth
 * more than deduplicating six names, and a cross-check test in `apps/web` asserts
 * that the copy still matches the engine's enum, so drift fails a test instead of
 * mislabelling a map.
 *
 * Colours are chosen to stay distinguishable under the common forms of colour
 * blindness, and every layer that uses them also reports the biome NAME in the
 * hover readout and legend — docs/06 §17 forbids colour as the only signal.
 */
export const DEBUG_BIOME_COUNT = 6;

export const DEBUG_BIOME_COLORS: readonly Rgb[] = [
  { r: 38, g: 76, b: 130 }, // 0 Water
  { r: 124, g: 168, b: 88 }, // 1 Grassland
  { r: 44, g: 104, b: 66 }, // 2 Forest
  { r: 214, g: 192, b: 130 }, // 3 Desert
  { r: 198, g: 208, b: 214 }, // 4 Tundra
  { r: 128, g: 122, b: 116 }, // 5 Mountain
];

export const DEBUG_BIOME_NAMES: readonly string[] = [
  "Water",
  "Grassland",
  "Forest",
  "Desert",
  "Tundra",
  "Mountain",
];

/** Fallback for a biome value outside the known enum — visibly wrong on purpose. */
export const UNKNOWN_BIOME_COLOR: Rgb = { r: 255, g: 0, b: 255 };

export function debugBiomeColor(biome: number): Rgb {
  return DEBUG_BIOME_COLORS[biome] ?? UNKNOWN_BIOME_COLOR;
}

export function debugBiomeName(biome: number): string {
  return DEBUG_BIOME_NAMES[biome] ?? `Unknown(${biome})`;
}
