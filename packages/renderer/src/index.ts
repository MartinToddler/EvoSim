/**
 * @eon/renderer — PixiJS world renderer (Milestone 6, tasks G05-G10).
 *
 * The renderer is a projection only: it never decides attacks, food allocation,
 * deaths, reproduction, mutations, species or authoritative positions
 * (CLAUDE.md renderer boundary). It depends on `@eon/protocol` for the packed
 * snapshot layouts and on nothing else in the workspace — in particular not on
 * `@eon/engine`, so there is no import path through which a rendering change
 * could reach simulation state (docs/02 §4).
 */

export { Camera, type CameraState } from "./Camera";
export { EonRenderer, type EonRendererOptions, type RendererStats } from "./EonRenderer";
export {
  BIOME_COLORS,
  BIOME_NAMES,
  CARCASS_TINT,
  DENSITY_SATURATION_COUNT,
  SELECTION_TINT,
  WORLD_LAYERS,
  biomeName,
  composeBiomeLayerRgba,
  composeDataLayerRgba,
  composeTerrainRgba,
  hueTint,
  isWorldLayerId,
  organismTint,
  worldLayerLegendStops,
  type WorldLayerId,
  type WorldLayerInfo,
} from "./palette";
export { findOrganismIndex, pickOrganism, type PickResult } from "./selection/pickOrganism";
export { SPRITE_FRAME, createRendererTextures, type RendererTextures } from "./textures";

// Environment debug projections (Milestone 2.5, recovered in Milestone 11).
//
// Pure environment -> RGBA, importing neither Pixi nor the engine, so they run
// in Node tests and back the world generator's field views.
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
