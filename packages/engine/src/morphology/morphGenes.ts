import type { DeepReadonly } from "@eon/shared";
import type { MorphologyConfig } from "../config/SimulationConfig";
import { Q, clamp } from "../math/fixed";

/**
 * The morphological genome (M14, docs/11 §M14).
 *
 * A second inherited gene block, stored and mutated exactly like the 16
 * ecological genes in `genetics/genes.ts`: quantized Uint16 in
 * `[0, MORPH_GENE_RAW_MAX]`, normalized to `[0, Q]` before any mapping.
 *
 * ## What this genome is NOT
 *
 * It is not a selector over body templates. There is no "wolf plan", no
 * "predator body" and no lookup table of creature archetypes; every body is
 * the developmental interpreter's output for one point in a 27-dimensional
 * continuous space (ADR 0027 §2a — no authoritative biological categories,
 * including in art). Two lineages that end up looking different got there by
 * drifting apart in that space, not by switching template.
 *
 * ## Why shape and scale are separate genomes
 *
 * `Gene.AdultSize` (ecological) decides how BIG an organism is. Everything
 * here decides what SHAPE it is, in units relative to that size. Keeping the
 * two apart means a lineage can evolve a long thin body at any size, and it
 * keeps M14 from silently re-deciding a quantity the MVP already selects on.
 *
 * ## Structural vs continuous loci
 *
 * Two loci — {@link MorphGene.SegmentCount} and
 * {@link MorphGene.AppendagePairs} — are read as small integers rather than as
 * continuous values. They get their own bounded mutation class so that gaining
 * or losing a segment is a discrete, rare, single-step evolutionary event
 * rather than something a continuous nudge does by accident at a bucket edge.
 *
 * The index order below is a storage contract. Reordering it changes every
 * genome layout, every snapshot and every world hash.
 */
export const MorphGene = {
  // Body ------------------------------------------------------------------
  /** Body extent along the heading axis, relative to the adult radius. */
  BodyLength: 0,
  /** Body extent across the heading axis, relative to the adult radius. */
  BodyWidth: 1,
  /** How sharply the body narrows toward the front. */
  FrontTaper: 2,
  /** How sharply the body narrows toward the rear. */
  RearTaper: 3,
  /** Structural: number of body segments. */
  SegmentCount: 4,
  /** How quickly successive segments shrink toward the rear. */
  SegmentProportion: 5,

  // Appendages ------------------------------------------------------------
  /** Structural: number of symmetric appendage pairs. */
  AppendagePairs: 6,
  /** Fore/aft bias of the span the pairs are distributed over. */
  AppendagePlacement: 7,
  /** Appendage length, relative to the body's half-width. */
  AppendageLength: 8,
  /** Appendage thickness, relative to its length. */
  AppendageThickness: 9,
  /** Rest angle away from the body's lateral axis. */
  AppendageAngle: 10,
  /** Front/rear specialization: how much longer front pairs are than rear ones. */
  AppendageFrontBias: 11,

  // Anterior --------------------------------------------------------------
  /** Share of body length occupied by the head region. */
  HeadProportion: 12,
  /** Size of the anterior feeding structure. */
  MouthSize: 13,
  /** Size of the anterior sensory structures. */
  SensorSize: 14,
  /** How far forward and apart the sensory structures sit. */
  SensorPlacement: 15,

  // Posterior -------------------------------------------------------------
  /** Length of the posterior extension, relative to the body length. */
  TailLength: 16,
  /** Width of the posterior extension at its base. */
  TailWidth: 17,
  /** How sharply the posterior extension narrows along its length. */
  TailTaper: 18,

  // Defensive appearance --------------------------------------------------
  /** Fraction of the silhouette covered by plating. */
  ArmorCoverage: 19,
  /** How pronounced individual ridges/plates are. */
  PlateExpression: 20,
  /** Where plating concentrates: 0 fully anterior, Q fully posterior. */
  ArmorDistribution: 21,

  // Pigment ---------------------------------------------------------------
  /** Signed shift of the primary pigment from the ecological hue gene. */
  PigmentPrimaryShift: 22,
  /** Signed shift of the secondary pigment from the primary one. */
  PigmentSecondaryShift: 23,
  /** How strongly the secondary pigment reads against the primary. */
  PigmentContrast: 24,
  /** Spatial frequency of the pattern. */
  PatternFrequency: 25,
  /** Pattern orientation: along the body, across it, or between. */
  PatternOrientation: 26,
} as const;

export type MorphGene = (typeof MorphGene)[keyof typeof MorphGene];

/** Number of morphological genes per organism. */
export const MORPH_GENE_COUNT = 27;

/**
 * Hard engine ceilings on the two structural loci and the pattern loop.
 *
 * These are limits, not tuning. Development and the renderer both loop once per
 * segment, once per appendage pair and once per pattern band, so a config is
 * not allowed to turn a per-organism constant into a per-organism variable that
 * grows without bound (CLAUDE.md, EvoSim 2.0 performance rule). `validateConfig`
 * enforces them.
 */
export const MAX_MORPH_SEGMENTS = 8;
export const MAX_MORPH_APPENDAGE_PAIRS = 6;
export const MAX_MORPH_PATTERN_FREQUENCY = 7;

/** Maximum stored morphological gene value; the whole Uint16 range. */
export const MORPH_GENE_RAW_MAX = 65535;

/** Human-readable names, indexed by gene value. Diagnostics and DTOs. */
export const MORPH_GENE_NAMES: readonly string[] = [
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
  "pigmentPrimaryShift",
  "pigmentSecondaryShift",
  "pigmentContrast",
  "patternFrequency",
  "patternOrientation",
];

/**
 * The loci read as small integers rather than as continuous values, in
 * ascending index order. Mutation treats these differently; see
 * `morphMutation.ts`.
 */
export const STRUCTURAL_MORPH_GENES: readonly MorphGene[] = [
  MorphGene.SegmentCount,
  MorphGene.AppendagePairs,
];

/** True when a locus is structural (integer-valued). */
export function isStructuralMorphGene(gene: number): boolean {
  return gene === MorphGene.SegmentCount || gene === MorphGene.AppendagePairs;
}

/**
 * Normalize a stored morphological gene to `[0, Q]`.
 *
 * Identical arithmetic to `geneToQ` for the ecological block — exact, monotone
 * and reaching both endpoints — deliberately duplicated rather than shared so
 * that the two genomes can be re-quantized independently later without one
 * silently changing the other's hashes.
 */
export function morphGeneToQ(raw: number): number {
  return (clamp(Math.trunc(raw), 0, MORPH_GENE_RAW_MAX) * (Q + 1)) >>> 16;
}

/** Right inverse of {@link morphGeneToQ}: smallest raw value normalizing to `valueQ`. */
export function morphGeneFromQ(valueQ: number): number {
  const numerator = clamp(Math.trunc(valueQ), 0, Q) * 65536;
  const divisor = Q + 1;
  const quotient = Math.floor(numerator / divisor);
  const raw = quotient * divisor < numerator ? quotient + 1 : quotient;
  return clamp(raw, 0, MORPH_GENE_RAW_MAX);
}

/**
 * Read a structural locus as an integer in `[min, max]`.
 *
 * The normalized value is split into `max - min + 1` equal buckets, with the
 * top bucket absorbing the endpoint. Deterministic, allocation-free, and the
 * inverse {@link structuralGeneFromCount} lands in the MIDDLE of a bucket so a
 * structural mutation cannot sit on an edge where a later continuous nudge
 * would flip it back.
 */
export function structuralGeneCount(valueQ: number, min: number, max: number): number {
  const buckets = max - min + 1;
  const index = Math.trunc((clamp(valueQ, 0, Q) * buckets) / (Q + 1));
  return clamp(min + index, min, max);
}

/** Stored gene value at the centre of the bucket that yields `count`. */
export function structuralGeneFromCount(count: number, min: number, max: number): number {
  const buckets = max - min + 1;
  const index = clamp(count, min, max) - min;
  const centreQ = Math.trunc(((2 * index + 1) * (Q + 1)) / (2 * buckets));
  return morphGeneFromQ(clamp(centreQ, 0, Q));
}

/** Segment count for a normalized gene value. */
export function segmentCount(valueQ: number, config: DeepReadonly<MorphologyConfig>): number {
  return structuralGeneCount(valueQ, config.minSegments, config.maxSegments);
}

/** Appendage pair count for a normalized gene value. */
export function appendagePairCount(valueQ: number, config: DeepReadonly<MorphologyConfig>): number {
  return structuralGeneCount(valueQ, config.minAppendagePairs, config.maxAppendagePairs);
}
