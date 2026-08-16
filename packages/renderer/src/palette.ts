/**
 * Colour policy for the world view (docs/06 §§2, 4, 17).
 *
 * ## Why colour lives in the renderer
 *
 * The engine emits a hue *gene* in degrees and a biome *index*; it never emits
 * an RGB triple. Which green a grassland is, and how strongly vegetation tints
 * it, are presentation decisions with no simulation meaning, and putting them
 * in the engine would make a palette tweak a change to a package that must stay
 * free of presentation (CLAUDE.md engine purity).
 *
 * ## Colour is never the only signal
 *
 * docs/06 §17 forbids colour as the sole status signal. Every colour choice
 * here is paired with something non-chromatic elsewhere: biome names in the
 * inspector readout, size for body scale, a drawn ring for selection, an
 * outline for the detail layer.
 *
 * The biome colours match the Milestone 2.5 debug view's palette exactly, so
 * the two ways of looking at the same world agree, and they are chosen to stay
 * distinguishable under the common forms of colour blindness.
 */

/** Biome colours indexed by the engine's `Biome` enum (docs/03 §19). */
export const BIOME_COLORS: readonly (readonly [number, number, number])[] = [
  [38, 76, 130], // 0 Water
  [124, 168, 88], // 1 Grassland
  [44, 104, 66], // 2 Forest
  [214, 192, 130], // 3 Desert
  [198, 208, 214], // 4 Tundra
  [128, 122, 116], // 5 Mountain
];

export const BIOME_NAMES: readonly string[] = [
  "Water",
  "Grassland",
  "Forest",
  "Desert",
  "Tundra",
  "Mountain",
];

/** Deliberately garish, so an unknown biome index is impossible to miss. */
const UNKNOWN_BIOME: readonly [number, number, number] = [255, 0, 255];

/** Colour a fully stocked land cell trends toward as plants grow. */
const VEGETATION_COLOR: readonly [number, number, number] = [58, 122, 52];

/** Water index in the engine's `Biome` enum. */
const WATER_BIOME = 0;

export function biomeName(biome: number): string {
  return BIOME_NAMES[biome] ?? `Unknown(${biome})`;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

/**
 * Compose the terrain RGBA texture from the three environment fields.
 *
 * Pure and synchronous so it can be unit-tested without a GPU; the caller
 * uploads `out` to a texture.
 *
 * - **Land** is its biome colour, shaded by elevation so relief is readable,
 *   then blended toward {@link VEGETATION_COLOR} in proportion to how stocked
 *   the cell is. A grazed-bare grassland and a saturated one are visibly
 *   different, which is the single most useful thing this view can show.
 * - **Water** ignores vegetation (nothing grows there in MVP) and uses
 *   elevation the other way round: deeper is darker.
 *
 * `out` must be `cellCount * 4` bytes, RGBA8.
 */
export function composeTerrainRgba(
  biome: Uint8Array,
  elevation: Uint8Array,
  vegetation: Uint8Array,
  out: Uint8Array,
): void {
  const cells = Math.min(biome.length, elevation.length, vegetation.length, out.length >> 2);
  for (let cell = 0; cell < cells; cell += 1) {
    const biomeIndex = biome[cell] as number;
    const base = BIOME_COLORS[biomeIndex] ?? UNKNOWN_BIOME;
    const elevationUnit = (elevation[cell] as number) / 255;

    let r: number;
    let g: number;
    let b: number;

    if (biomeIndex === WATER_BIOME) {
      // 0.55 … 1.0: shallow water reads close to the base blue, deep water
      // clearly darker, without ever going black.
      const depthShade = 0.55 + 0.45 * elevationUnit;
      r = base[0] * depthShade;
      g = base[1] * depthShade;
      b = base[2] * depthShade;
    } else {
      // 0.78 … 1.18 gives visible relief while keeping biomes recognisable.
      const relief = 0.78 + 0.4 * elevationUnit;
      const stock = (vegetation[cell] as number) / 255;
      // Cap the vegetation blend below 1 so the biome underneath never
      // disappears: a saturated desert must still look like desert.
      const blend = stock * 0.72;
      r = (base[0] * (1 - blend) + VEGETATION_COLOR[0] * blend) * relief;
      g = (base[1] * (1 - blend) + VEGETATION_COLOR[1] * blend) * relief;
      b = (base[2] * (1 - blend) + VEGETATION_COLOR[2] * blend) * relief;
    }

    const offset = cell << 2;
    out[offset] = clampByte(r);
    out[offset + 1] = clampByte(g);
    out[offset + 2] = clampByte(b);
    out[offset + 3] = 255;
  }
}

/**
 * Hue-to-RGB lookup for organism tints, built once.
 *
 * 360 entries at fixed saturation and value. A table rather than a conversion:
 * the alternative is an HSV→RGB conversion per organism per snapshot, which at
 * 8192 organisms and 15 Hz is 123 000 conversions a second to produce one of
 * 360 possible answers.
 */
const HUE_TABLE = buildHueTable();

function buildHueTable(): Uint32Array {
  const table = new Uint32Array(360);
  // Saturation and value chosen so every hue stays legible against both the
  // dark blue of water and the pale sand of desert.
  const saturation = 0.62;
  const value = 0.95;
  for (let hue = 0; hue < 360; hue += 1) {
    const sector = hue / 60;
    const chroma = value * saturation;
    const x = chroma * (1 - Math.abs((sector % 2) - 1));
    const m = value - chroma;
    let r = 0;
    let g = 0;
    let b = 0;
    if (sector < 1) {
      r = chroma;
      g = x;
    } else if (sector < 2) {
      r = x;
      g = chroma;
    } else if (sector < 3) {
      g = chroma;
      b = x;
    } else if (sector < 4) {
      g = x;
      b = chroma;
    } else if (sector < 5) {
      r = x;
      b = chroma;
    } else {
      r = chroma;
      b = x;
    }
    table[hue] =
      (clampByte((r + m) * 255) << 16) | (clampByte((g + m) * 255) << 8) | clampByte((b + m) * 255);
  }
  return table;
}

/** 24-bit RGB tint for a hue in degrees. */
export function hueTint(hueDegrees: number): number {
  return HUE_TABLE[((hueDegrees % 360) + 360) % 360] as number;
}

/**
 * Tint for one organism: its hue gene, darkened as health falls.
 *
 * Health is shown by darkening rather than by shifting hue, so the inherited
 * colour — the thing that makes a lineage recognisable as it spreads — stays
 * readable on a wounded animal.
 */
export function organismTint(hueDegrees: number, health255: number): number {
  const base = hueTint(hueDegrees);
  // Floor at 0.45 so a nearly-dead organism is dark but still visible.
  const shade = 0.45 + 0.55 * (health255 / 255);
  const r = clampByte(((base >> 16) & 0xff) * shade);
  const g = clampByte(((base >> 8) & 0xff) * shade);
  const b = clampByte((base & 0xff) * shade);
  return (r << 16) | (g << 8) | b;
}

/**
 * Neutral shade tint for a sprite whose colours are already baked in (M14).
 *
 * A procedurally generated body carries two pigments and a pattern between
 * them, so it cannot be tinted by hue without losing the pattern. This returns
 * a grey that multiplies both pigments down together as health falls, using
 * exactly the floor {@link organismTint} uses, so a wounded animal darkens the
 * same amount whichever layer is drawing it.
 */
export function healthShade(health255: number): number {
  const shade = clampByte((0.45 + 0.55 * (health255 / 255)) * 255);
  return (shade << 16) | (shade << 8) | shade;
}

/** Carcasses are drawn as desaturated meat, distinct from any living hue. */
export const CARCASS_TINT = 0x8a5a4a;

/** Selection ring colour: high contrast against terrain and every organism hue. */
export const SELECTION_TINT = 0xffffff;

// --- World layers (Milestone 7, task H05, docs/06 §7) -------------------------
//
// Each data layer maps one byte-per-cell field through a colour ramp and blends
// the result over the composed terrain, so coastlines and relief stay readable
// underneath the data. Ramps follow the charting rules the UI uses elsewhere:
// magnitude is a single hue running dark → bright (dark recedes into this
// app's dark canvas, bright means "more"), and temperature — the one field with
// a real polarity — is a cool/warm diverging ramp through a neutral midpoint.
// One layer is active at a time, with an opacity control (docs/06 §7).

/** Identifiers for the selectable world views. */
export type WorldLayerId =
  | "terrain"
  | "biome"
  | "elevation"
  | "temperature"
  | "moisture"
  | "fertility"
  | "vegetation"
  | "capacity"
  | "density";

export interface WorldLayerInfo {
  readonly id: WorldLayerId;
  readonly label: string;
  /** How the legend should present it. */
  readonly kind: "composed" | "categorical" | "sequential" | "diverging";
  /** What the two ends of the ramp mean, for the legend ("low" → "high"). */
  readonly lowLabel: string;
  readonly highLabel: string;
  /**
   * Where the field comes from. Static planes arrive once with WORLD_READY;
   * `vegetation` follows the ~4 Hz vegetation stream; `density` is derived on
   * the main thread from each render snapshot. Purely descriptive — switching
   * layers never sends a message and never touches the simulation.
   */
  readonly source: "static" | "vegetation-stream" | "render-snapshot";
}

/** Every selectable layer, in the order the UI lists them. */
export const WORLD_LAYERS: readonly WorldLayerInfo[] = [
  {
    id: "terrain",
    label: "Terrain",
    kind: "composed",
    lowLabel: "",
    highLabel: "",
    source: "static",
  },
  {
    id: "biome",
    label: "Biomes",
    kind: "categorical",
    lowLabel: "",
    highLabel: "",
    source: "static",
  },
  {
    id: "elevation",
    label: "Elevation",
    kind: "sequential",
    lowLabel: "low",
    highLabel: "high",
    source: "static",
  },
  {
    id: "temperature",
    label: "Temperature",
    kind: "diverging",
    lowLabel: "cold",
    highLabel: "hot",
    source: "static",
  },
  {
    id: "moisture",
    label: "Moisture",
    kind: "sequential",
    lowLabel: "arid",
    highLabel: "saturated",
    source: "static",
  },
  {
    id: "fertility",
    label: "Fertility",
    kind: "sequential",
    lowLabel: "barren",
    highLabel: "fertile",
    source: "static",
  },
  {
    id: "vegetation",
    label: "Plant biomass",
    kind: "sequential",
    lowLabel: "grazed bare",
    highLabel: "full stock",
    source: "vegetation-stream",
  },
  {
    id: "capacity",
    label: "Plant capacity",
    kind: "sequential",
    lowLabel: "none",
    highLabel: "richest",
    source: "static",
  },
  {
    id: "density",
    label: "Organism density",
    kind: "sequential",
    lowLabel: "empty",
    highLabel: "crowded",
    source: "render-snapshot",
  },
];

export function isWorldLayerId(value: unknown): value is WorldLayerId {
  return typeof value === "string" && WORLD_LAYERS.some((layer) => layer.id === value);
}

/** One ramp stop: field byte position 0-255 and the colour there. */
type RampStop = readonly [position: number, r: number, g: number, b: number];

/**
 * Ramp definitions per data layer.
 *
 * Sequential ramps run dark → bright in a single hue; the dark end sits near
 * the app's canvas colour so "little" recedes and "much" glows. Temperature is
 * the diverging exception: deep cool blue through a pale neutral to warm red,
 * with the neutral at the middle of the published display range.
 */
const LAYER_RAMPS: Partial<Record<WorldLayerId, readonly RampStop[]>> = {
  elevation: [
    [0, 16, 22, 28],
    [255, 219, 227, 232],
  ],
  temperature: [
    [0, 13, 54, 107],
    [96, 85, 152, 231],
    [128, 240, 239, 236],
    [176, 236, 132, 82],
    [255, 179, 38, 42],
  ],
  moisture: [
    [0, 11, 22, 32],
    [160, 42, 120, 214],
    [255, 158, 197, 244],
  ],
  fertility: [
    [0, 14, 26, 16],
    [255, 85, 201, 106],
  ],
  vegetation: [
    [0, 13, 26, 13],
    [255, 70, 224, 94],
  ],
  capacity: [
    [0, 12, 26, 23],
    [255, 46, 230, 168],
  ],
  density: [
    [0, 23, 13, 26],
    [255, 213, 81, 129],
  ],
};

/** CSS hex stops for a layer's legend gradient, low → high. */
export function worldLayerLegendStops(id: WorldLayerId): readonly string[] {
  if (id === "biome") {
    return BIOME_COLORS.map(
      ([r, g, b]) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`,
    );
  }
  const ramp = LAYER_RAMPS[id];
  if (ramp === undefined) {
    return [];
  }
  return ramp.map(([, r, g, b]) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`);
}

/** Sample a data layer's ramp at a byte value; RGB into `out`. */
function sampleRamp(ramp: readonly RampStop[], value: number, out: [number, number, number]): void {
  const first = ramp[0] as RampStop;
  if (value <= first[0]) {
    out[0] = first[1];
    out[1] = first[2];
    out[2] = first[3];
    return;
  }
  for (let i = 1; i < ramp.length; i += 1) {
    const stop = ramp[i] as RampStop;
    if (value <= stop[0]) {
      const previous = ramp[i - 1] as RampStop;
      const span = stop[0] - previous[0];
      const t = span > 0 ? (value - previous[0]) / span : 1;
      out[0] = previous[1] + (stop[1] - previous[1]) * t;
      out[1] = previous[2] + (stop[2] - previous[2]) * t;
      out[2] = previous[3] + (stop[3] - previous[3]) * t;
      return;
    }
  }
  const last = ramp[ramp.length - 1] as RampStop;
  out[0] = last[1];
  out[1] = last[2];
  out[2] = last[3];
}

/**
 * Blend a data layer over the composed terrain base.
 *
 * `values` is the byte-per-cell field, `base` the RGBA the default view would
 * show, `opacity` in [0, 1] how strongly the data covers it. Pure and
 * GPU-free, like {@link composeTerrainRgba}, so it is unit-testable and the
 * caller owns the upload.
 */
export function composeDataLayerRgba(
  id: WorldLayerId,
  values: Uint8Array,
  base: Uint8Array,
  opacity: number,
  out: Uint8Array,
): void {
  const ramp = LAYER_RAMPS[id];
  if (ramp === undefined) {
    out.set(base.subarray(0, out.length));
    return;
  }
  const cells = Math.min(values.length, out.length >> 2, base.length >> 2);
  const alpha = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  const keep = 1 - alpha;
  const colour: [number, number, number] = [0, 0, 0];
  for (let cell = 0; cell < cells; cell += 1) {
    sampleRamp(ramp, values[cell] as number, colour);
    const offset = cell << 2;
    out[offset] = clampByte((base[offset] as number) * keep + colour[0] * alpha);
    out[offset + 1] = clampByte((base[offset + 1] as number) * keep + colour[1] * alpha);
    out[offset + 2] = clampByte((base[offset + 2] as number) * keep + colour[2] * alpha);
    out[offset + 3] = 255;
  }
}

/**
 * Blend flat biome colours over the composed terrain base.
 *
 * Categorical, so no ramp: each cell takes its biome's own colour, unshaded —
 * the elevation relief of the default view would only muddy category edges.
 */
export function composeBiomeLayerRgba(
  biome: Uint8Array,
  base: Uint8Array,
  opacity: number,
  out: Uint8Array,
): void {
  const cells = Math.min(biome.length, out.length >> 2, base.length >> 2);
  const alpha = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  const keep = 1 - alpha;
  for (let cell = 0; cell < cells; cell += 1) {
    const colour = BIOME_COLORS[biome[cell] as number] ?? UNKNOWN_BIOME;
    const offset = cell << 2;
    out[offset] = clampByte((base[offset] as number) * keep + colour[0] * alpha);
    out[offset + 1] = clampByte((base[offset + 1] as number) * keep + colour[1] * alpha);
    out[offset + 2] = clampByte((base[offset + 2] as number) * keep + colour[2] * alpha);
    out[offset + 3] = 255;
  }
}

/**
 * Organisms per cell at which the density layer saturates.
 *
 * The environment grid averages well under one organism per cell even at the
 * population cap, so density is interesting in exactly the places several
 * bodies share a cell. Six is "a visible crowd" without making a single grazer
 * invisible: 1 organism already reads at 42 of 255.
 */
export const DENSITY_SATURATION_COUNT = 6;
