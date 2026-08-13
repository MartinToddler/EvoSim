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

/** Carcasses are drawn as desaturated meat, distinct from any living hue. */
export const CARCASS_TINT = 0x8a5a4a;

/** Selection ring colour: high contrast against terrain and every organism hue. */
export const SELECTION_TINT = 0xffffff;
