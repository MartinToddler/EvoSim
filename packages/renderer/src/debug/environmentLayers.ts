import { debugBiomeColor, debugBiomeName, DEBUG_BIOME_COUNT } from "./biomePalette";
import { type ColorRamp, type Rgb, compactRamp, rgbToCss, sampleRamp } from "./colorRamp";
import {
  assertDebugFields,
  debugFieldCellCount,
  type DebugPixelBuffer,
  EnvironmentDebugError,
  type EnvironmentDebugFields,
  Q_SCALE,
} from "./environmentDebugFields";

/**
 * Environment → debug pixels (Milestone 2.5).
 *
 * Every function here is a pure projection of {@link EnvironmentDebugFields}: no
 * DOM, no canvas, no engine, no simulation decision. The output is raw RGBA bytes
 * that a Canvas 2D `ImageData` (now) or a Pixi data texture (Milestone 6 debug
 * overlay, task G10) can consume unchanged.
 *
 * Layer semantics are documented per layer because a debug tool that colours
 * fields in an undocumented way is worse than no tool: a reader must be able to
 * tell "the map is wrong" from "the palette is surprising".
 */

/** Bytes per pixel in the RGBA output. */
const RGBA_STRIDE = 4;
const OPAQUE = 255;

/** Biome enum value 0 is Water (docs/03 §19); named so the loops read clearly. */
const WATER_BIOME = 0;

/**
 * Temperature display window, centi-Celsius.
 *
 * Generated worlds span roughly -13 °C … +33 °C under `DEFAULT_CONFIG`
 * (ADR 0003 §2), so a fixed -20 °C … +40 °C window keeps every world on the same
 * scale — different seeds are visually comparable — while leaving headroom for a
 * player global-temperature offset (Milestone 9) to stay on-scale.
 */
export const TEMPERATURE_DISPLAY_MIN_CENTIC = -2000;
export const TEMPERATURE_DISPLAY_MAX_CENTIC = 4000;

/** Water shown in the vegetation layers, where "0 biomass" would read as barren land. */
const VEGETATION_WATER_COLOR: Rgb = { r: 28, g: 48, b: 74 };

/** Ocean depth ramp; the upper stop is substituted with the world's sea level. */
const OCEAN_DEEP: Rgb = { r: 10, g: 26, b: 58 };
const OCEAN_SHELF: Rgb = { r: 72, g: 132, b: 186 };

/** Land hypsometric stops: shore, midland, rock (at mountain level), snow (at 1.0). */
const LAND_SHORE: Rgb = { r: 96, g: 142, b: 84 };
const LAND_MIDLAND: Rgb = { r: 168, g: 158, b: 96 };
const LAND_ROCK: Rgb = { r: 140, g: 126, b: 108 };
const LAND_SNOW: Rgb = { r: 238, g: 240, b: 244 };

/**
 * Diverging temperature ramp, anchored on values that mean something:
 * 0 °C (freezing) and 18 °C (the plant capacity optimum of docs/08 §5).
 */
export const TEMPERATURE_RAMP: ColorRamp = [
  { at: TEMPERATURE_DISPLAY_MIN_CENTIC, r: 49, g: 78, b: 158 },
  { at: 0, r: 122, g: 178, b: 220 },
  { at: 1800, r: 245, g: 240, b: 205 },
  { at: 3000, r: 232, g: 150, b: 78 },
  { at: TEMPERATURE_DISPLAY_MAX_CENTIC, r: 176, g: 48, b: 42 },
];

/** Dry → wet. Tan through sage to open water blue. */
export const MOISTURE_RAMP: ColorRamp = [
  { at: 0, r: 196, g: 172, b: 120 },
  { at: Q_SCALE / 2, r: 140, g: 186, b: 168 },
  { at: Q_SCALE, r: 32, g: 96, b: 148 },
];

/** Barren → fertile soil. */
export const FERTILITY_RAMP: ColorRamp = [
  { at: 0, r: 40, g: 34, b: 28 },
  { at: Q_SCALE / 2, r: 128, g: 132, b: 64 },
  { at: Q_SCALE, r: 140, g: 220, b: 120 },
];

/** Vegetation ramp; the upper stop is substituted with the world's biomass reference. */
const VEGETATION_EMPTY: Rgb = { r: 24, g: 28, b: 24 };
const VEGETATION_MID: Rgb = { r: 60, g: 132, b: 66 };
const VEGETATION_FULL: Rgb = { r: 128, g: 236, b: 128 };

export const ENVIRONMENT_DEBUG_LAYER_IDS = [
  "elevation",
  "biome",
  "temperature",
  "moisture",
  "fertility",
  "plantCapacity",
  "plantBiomass",
] as const;

export type EnvironmentDebugLayerId = (typeof ENVIRONMENT_DEBUG_LAYER_IDS)[number];

export interface EnvironmentDebugLayerDescriptor {
  readonly id: EnvironmentDebugLayerId;
  readonly label: string;
  /** What the layer shows and how to read it. Rendered in the UI, not decoration. */
  readonly description: string;
}

export const ENVIRONMENT_DEBUG_LAYERS: readonly EnvironmentDebugLayerDescriptor[] = [
  {
    id: "elevation",
    label: "Elevation",
    description:
      "Normalized elevation. The palette breaks exactly at the configured sea level, so the " +
      "coastline you see is the same threshold the biome rules use.",
  },
  {
    id: "biome",
    label: "Biome",
    description:
      "Biome class from the docs/03 §19 rule order: elevation decides water and mountain " +
      "before any climate rule applies.",
  },
  {
    id: "temperature",
    label: "Temperature",
    description:
      "Effective temperature including player offsets, on a fixed -20 °C … +40 °C scale so " +
      "different seeds are comparable.",
  },
  {
    id: "moisture",
    label: "Moisture",
    description:
      "Effective moisture: independent noise, inverse elevation and the coastal water-influence " +
      "gradient (docs/03 §16).",
  },
  {
    id: "fertility",
    label: "Fertility",
    description: "Soil fertility from moisture, temperature, lowland preference and noise.",
  },
  {
    id: "plantCapacity",
    label: "Plant capacity",
    description:
      "Per-cell carrying capacity: biome base × fertility × moisture and temperature " +
      "suitability. Water is drawn in blue rather than as barren land.",
  },
  {
    id: "plantBiomass",
    label: "Current biomass",
    description:
      "Current plant biomass on the same scale as capacity, so switching between the two layers " +
      "shows how much headroom the vegetation has left.",
  },
];

function isLayerId(value: string): value is EnvironmentDebugLayerId {
  return (ENVIRONMENT_DEBUG_LAYER_IDS as readonly string[]).includes(value);
}

/** Parse a layer id from untrusted input (query string, stored preference). */
export function parseEnvironmentDebugLayerId(value: string): EnvironmentDebugLayerId | null {
  return isLayerId(value) ? value : null;
}

/** Ocean ramp for this world: deep at 0, shelf colour at the sea-level threshold. */
function oceanRamp(fields: EnvironmentDebugFields): ColorRamp {
  return compactRamp([
    { at: 0, ...OCEAN_DEEP },
    { at: fields.seaLevelQ, ...OCEAN_SHELF },
  ]);
}

/** Land ramp for this world; the midland stop sits halfway from shore to mountain. */
function landRamp(fields: EnvironmentDebugFields): ColorRamp {
  const midland = fields.seaLevelQ + Math.trunc((fields.mountainLevelQ - fields.seaLevelQ) / 2);
  return compactRamp([
    { at: fields.seaLevelQ, ...LAND_SHORE },
    { at: midland, ...LAND_MIDLAND },
    { at: fields.mountainLevelQ, ...LAND_ROCK },
    { at: Q_SCALE, ...LAND_SNOW },
  ]);
}

/** Vegetation ramp for this world, topping out at the world's biomass reference. */
function vegetationRamp(fields: EnvironmentDebugFields): ColorRamp {
  const reference = fields.biomassReference;
  return compactRamp([
    { at: 0, ...VEGETATION_EMPTY },
    { at: Math.trunc(reference / 2), ...VEGETATION_MID },
    { at: reference, ...VEGETATION_FULL },
  ]);
}

/**
 * Paint one layer into `target` as RGBA bytes, row-major, fully opaque.
 *
 * `target` must be exactly `size² × 4` bytes: it is normally the backing array of
 * an `ImageData`, reused across repaints so switching layers allocates nothing.
 */
export function paintEnvironmentLayer(
  fields: EnvironmentDebugFields,
  layer: EnvironmentDebugLayerId,
  target: DebugPixelBuffer,
): void {
  assertDebugFields(fields);
  const cells = debugFieldCellCount(fields);
  if (target.length !== cells * RGBA_STRIDE) {
    throw new EnvironmentDebugError(
      `debug pixel target has ${target.length} bytes, expected ${cells * RGBA_STRIDE} ` +
        `for a ${fields.size}×${fields.size} grid`,
    );
  }

  // One scratch colour for the whole pass; see colorRamp.sampleRamp.
  const color: Rgb = { r: 0, g: 0, b: 0 };

  switch (layer) {
    case "elevation": {
      const ocean = oceanRamp(fields);
      const land = landRamp(fields);
      for (let i = 0; i < cells; i += 1) {
        const elevation = fields.elevationQ[i] as number;
        sampleRamp(elevation < fields.seaLevelQ ? ocean : land, elevation, color);
        writePixel(target, i, color);
      }
      return;
    }
    case "biome": {
      for (let i = 0; i < cells; i += 1) {
        writePixel(target, i, debugBiomeColor(fields.biome[i] as number));
      }
      return;
    }
    case "temperature": {
      for (let i = 0; i < cells; i += 1) {
        sampleRamp(TEMPERATURE_RAMP, fields.temperatureCentiC[i] as number, color);
        writePixel(target, i, color);
      }
      return;
    }
    case "moisture": {
      for (let i = 0; i < cells; i += 1) {
        sampleRamp(MOISTURE_RAMP, fields.moistureQ[i] as number, color);
        writePixel(target, i, color);
      }
      return;
    }
    case "fertility": {
      for (let i = 0; i < cells; i += 1) {
        sampleRamp(FERTILITY_RAMP, fields.fertilityQ[i] as number, color);
        writePixel(target, i, color);
      }
      return;
    }
    case "plantCapacity":
    case "plantBiomass": {
      const ramp = vegetationRamp(fields);
      const values = layer === "plantCapacity" ? fields.plantCapacity : fields.plantBiomass;
      for (let i = 0; i < cells; i += 1) {
        if (fields.biome[i] === WATER_BIOME) {
          writePixel(target, i, VEGETATION_WATER_COLOR);
          continue;
        }
        sampleRamp(ramp, values[i] as number, color);
        writePixel(target, i, color);
      }
      return;
    }
  }
}

function writePixel(target: DebugPixelBuffer, cellIndex: number, color: Rgb): void {
  const at = cellIndex * RGBA_STRIDE;
  target[at] = color.r;
  target[at + 1] = color.g;
  target[at + 2] = color.b;
  target[at + 3] = OPAQUE;
}

/** Allocate an RGBA buffer sized for one repaint of `fields`. */
export function createDebugPixelBuffer(fields: EnvironmentDebugFields): DebugPixelBuffer {
  return new Uint8ClampedArray(debugFieldCellCount(fields) * RGBA_STRIDE);
}

// --- Human-readable readouts -------------------------------------------------

/** Q value as a normalized fraction, e.g. 2048 → "0.500". */
export function formatQ(value: number): string {
  return (value / Q_SCALE).toFixed(3);
}

/** Centi-Celsius as degrees, e.g. 770 → "7.70 °C". */
export function formatCentiC(value: number): string {
  return `${(value / 100).toFixed(2)} °C`;
}

export interface DebugLegendEntry {
  readonly caption: string;
  readonly css: string;
}

/**
 * Legend for a layer, as caption + CSS colour pairs.
 *
 * Derived from the same ramps the painter uses, so a legend can never describe a
 * palette the image does not have.
 */
export function describeLayerLegend(
  fields: EnvironmentDebugFields,
  layer: EnvironmentDebugLayerId,
): readonly DebugLegendEntry[] {
  switch (layer) {
    case "elevation":
      return [
        { caption: "0.000 (deep)", css: rgbToCss(OCEAN_DEEP) },
        { caption: `${formatQ(fields.seaLevelQ)} sea level`, css: rgbToCss(OCEAN_SHELF) },
        { caption: `${formatQ(fields.seaLevelQ)} shore`, css: rgbToCss(LAND_SHORE) },
        { caption: `${formatQ(fields.mountainLevelQ)} mountain`, css: rgbToCss(LAND_ROCK) },
        { caption: "1.000 (peak)", css: rgbToCss(LAND_SNOW) },
      ];
    case "biome":
      return Array.from({ length: DEBUG_BIOME_COUNT }, (_unused, biome) => ({
        caption: debugBiomeName(biome),
        css: rgbToCss(debugBiomeColor(biome)),
      }));
    case "temperature":
      return TEMPERATURE_RAMP.map((stop) => ({
        caption: formatCentiC(stop.at),
        css: rgbToCss(stop),
      }));
    case "moisture":
      return MOISTURE_RAMP.map((stop) => ({ caption: formatQ(stop.at), css: rgbToCss(stop) }));
    case "fertility":
      return FERTILITY_RAMP.map((stop) => ({ caption: formatQ(stop.at), css: rgbToCss(stop) }));
    case "plantCapacity":
    case "plantBiomass":
      return [
        ...vegetationRamp(fields).map((stop) => ({
          caption: `${stop.at} units`,
          css: rgbToCss(stop),
        })),
        { caption: "water", css: rgbToCss(VEGETATION_WATER_COLOR) },
      ];
  }
}

/** The value one cell contributes to a layer, formatted for a hover readout. */
export function formatCellValue(
  fields: EnvironmentDebugFields,
  layer: EnvironmentDebugLayerId,
  index: number,
): string {
  switch (layer) {
    case "elevation":
      return formatQ(fields.elevationQ[index] as number);
    case "biome":
      return debugBiomeName(fields.biome[index] as number);
    case "temperature":
      return formatCentiC(fields.temperatureCentiC[index] as number);
    case "moisture":
      return formatQ(fields.moistureQ[index] as number);
    case "fertility":
      return formatQ(fields.fertilityQ[index] as number);
    case "plantCapacity":
      return `${fields.plantCapacity[index] as number} units`;
    case "plantBiomass":
      return `${fields.plantBiomass[index] as number} units`;
  }
}
