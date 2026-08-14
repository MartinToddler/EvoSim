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
