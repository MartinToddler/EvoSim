/**
 * @eon/renderer — PixiJS world renderer package.
 *
 * The full Pixi renderer arrives with Milestone 6 (tasks G05–G10). The renderer
 * is a projection only: it never decides attacks, food allocation, deaths,
 * reproduction, mutations, species or authoritative positions (CLAUDE.md
 * renderer boundary). PixiJS 8.x is already pinned as a dependency per the
 * bootstrap toolchain policy, but no Pixi code exists yet by design.
 *
 * What does exist is the `debug/` module: pure environment → RGBA projections
 * used by the Milestone 2.5 development visualizer. It imports neither Pixi nor
 * the engine, so it runs in Node tests and can later back the docs/06 §18 debug
 * overlay (task G10) without change.
 */
export const RENDERER_PACKAGE_STATUS = "placeholder-until-milestone-6" as const;

export {
  type Rgb,
  type RampStop,
  type ColorRamp,
  compactRamp,
  isAscendingRamp,
  sampleRamp,
  rgbToCss,
} from "./debug/colorRamp";
export {
  DEBUG_BIOME_COUNT,
  DEBUG_BIOME_COLORS,
  DEBUG_BIOME_NAMES,
  UNKNOWN_BIOME_COLOR,
  debugBiomeColor,
  debugBiomeName,
} from "./debug/biomePalette";
export {
  Q_SCALE,
  type DebugPixelBuffer,
  type EnvironmentDebugFields,
  EnvironmentDebugError,
  assertDebugFields,
  debugFieldCellCount,
  debugCellCoordinates,
} from "./debug/environmentDebugFields";
export {
  ENVIRONMENT_DEBUG_LAYER_IDS,
  ENVIRONMENT_DEBUG_LAYERS,
  type EnvironmentDebugLayerId,
  type EnvironmentDebugLayerDescriptor,
  type DebugLegendEntry,
  TEMPERATURE_DISPLAY_MIN_CENTIC,
  TEMPERATURE_DISPLAY_MAX_CENTIC,
  TEMPERATURE_RAMP,
  MOISTURE_RAMP,
  FERTILITY_RAMP,
  parseEnvironmentDebugLayerId,
  paintEnvironmentLayer,
  createDebugPixelBuffer,
  describeLayerLegend,
  formatCellValue,
  formatQ,
  formatCentiC,
} from "./debug/environmentLayers";
export {
  type EnvironmentDebugSummary,
  summarizeEnvironmentFields,
} from "./debug/environmentDebugSummary";
