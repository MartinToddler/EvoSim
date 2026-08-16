/**
 * Per-organism morphology channels in a render snapshot (M14, docs/11 §M14).
 *
 * ## Why the wire carries a developed phenotype, not a genome
 *
 * The renderer must never re-run development. If it interpreted raw genes it
 * would own a second copy of the developmental rules, and the day the two
 * copies disagreed the picture would stop being a projection of the
 * simulation. So the engine develops the body and sends the RESULT: 27 bytes
 * that describe proportions, never genes and never a body "type".
 *
 * ## Why bytes
 *
 * Morphology is fixed for an organism's life, so this block is the same every
 * frame — which makes it the cheapest thing in the snapshot to make small.
 * One byte per channel is enough for a drawing (256 levels of "how tapered is
 * the rear" is far past what any zoom level can show), and it keeps the
 * addition to 27 bytes per organism against the 32 the snapshot already
 * carried. Two channels are small COUNTS rather than fractions and are stored
 * raw; the rest are `[0, 255]` quantizations of a Q fraction.
 *
 * ## Why the renderer can cache on this block
 *
 * Two organisms with identical channels are drawn identically — there is no
 * randomness anywhere downstream — so the block doubles as a cache key for a
 * generated body texture. Relatives share a key, which is what keeps a
 * procedurally drawn population affordable.
 *
 * The index order is a wire contract; reordering it is a
 * RENDER_SNAPSHOT_LAYOUT_VERSION change.
 */
export const MorphChannel = {
  BodyLength: 0,
  BodyWidth: 1,
  FrontTaper: 2,
  RearTaper: 3,
  /** Raw count, not a fraction. */
  SegmentCount: 4,
  SegmentProportion: 5,
  /** Raw count, not a fraction. */
  AppendagePairs: 6,
  AppendagePlacement: 7,
  AppendageLength: 8,
  AppendageThickness: 9,
  AppendageAngle: 10,
  AppendageFrontBias: 11,
  HeadProportion: 12,
  MouthSize: 13,
  SensorSize: 14,
  SensorPlacement: 15,
  TailLength: 16,
  TailWidth: 17,
  TailTaper: 18,
  ArmorCoverage: 19,
  PlateExpression: 20,
  ArmorDistribution: 21,
  /** Primary pigment hue in half-degrees: `hueDeg >> 1`, so `[0, 179]`. */
  PrimaryHueHalfDeg: 22,
  /** Secondary pigment hue in half-degrees. */
  SecondaryHueHalfDeg: 23,
  PigmentContrast: 24,
  /** Raw count, not a fraction. */
  PatternFrequency: 25,
  PatternOrientation: 26,
} as const;

export type MorphChannel = (typeof MorphChannel)[keyof typeof MorphChannel];

/** Bytes per organism in the morphology section. */
export const MORPH_CHANNEL_COUNT = 27;

/**
 * Decode scale for the magnitude channels — the ones that can exceed 1.
 *
 * `byte = round(value * 255 / MORPH_MAGNITUDE_SCALE)`, so a byte of 255 means
 * 10.0 and one byte is 1/25.5 of a unit. A FIXED constant rather than the
 * config's silhouette ceiling: the renderer decodes a snapshot without being
 * told the simulation config, and a quantization that moved with tuning would
 * make two builds read the same bytes differently. `validateConfig` keeps the
 * config's ceiling at or below this, so nothing saturates.
 *
 * What the unit IS depends on the channel, which is why this is not called a
 * radius: BodyLength and BodyWidth are multiples of the adult body radius,
 * TailLength is a multiple of the body length, and AppendageLength is a
 * multiple of the body half-width. Each is the unit its own field is defined
 * in; the codec is shared because the numeric range is.
 */
export const MORPH_MAGNITUDE_SCALE = 10;

/** Channel names, indexed by channel value. Diagnostics and the gallery view. */
export const MORPH_CHANNEL_NAMES: readonly string[] = [
  "bodyLength",
  "bodyWidth",
  "frontTaper",
  "rearTaper",
  "segmentCount",
  "segmentProportion",
  "appendagePairs",
  "appendagePlacement",
  "appendageLength",
  "appendageThickness",
  "appendageAngle",
  "appendageFrontBias",
  "headProportion",
  "mouthSize",
  "sensorSize",
  "sensorPlacement",
  "tailLength",
  "tailWidth",
  "tailTaper",
  "armorCoverage",
  "plateExpression",
  "armorDistribution",
  "primaryHueHalfDeg",
  "secondaryHueHalfDeg",
  "pigmentContrast",
  "patternFrequency",
  "patternOrientation",
];

/** Decode a magnitude channel byte to its value in that channel's own unit. */
export function morphMagnitude(byte: number): number {
  return (byte / 255) * MORPH_MAGNITUDE_SCALE;
}
