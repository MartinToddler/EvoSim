import { assert, type DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { ANGLE_STEPS, Q, clamp, lerpQ, qdiv, qmul } from "../math/fixed";
import { HUE_DEGREES } from "../genetics/genes";
import type { GenomeStore } from "../organisms/GenomeStore";
import {
  MAX_MORPH_PATTERN_FREQUENCY,
  MORPH_GENE_COUNT,
  MorphGene,
  appendagePairCount,
  morphGeneToQ,
  segmentCount,
} from "./morphGenes";

/**
 * Developmental interpreter and morphological phenotype (M14, docs/11 §M14).
 *
 * ```text
 * MorphologyGenotype -> [this file] -> MorphologyPhenotype -> geometry params
 * ```
 *
 * The interpreter is a pure function of the morphological genome, the
 * ecological hue gene and the config. Same genotype, same phenotype, on every
 * machine and in every process. It reads no world state, no position and no
 * clock, which is what lets the phenotype live in a derived cache that is
 * neither hashed nor serialized — exactly like `PhenotypeStore` (docs/10 §8).
 *
 * ## Bounded development
 *
 * Development is a fixed sequence of mappings, not a grammar. There is no
 * recursion, no rewrite rule and no growth loop that could run a different
 * number of times for different genomes: segment and appendage counts come
 * from two structural loci with configured hard minima and maxima, and every
 * other field is one bounded interpolation. The cost of developing a body is
 * therefore constant, which is what makes it affordable for thousands of
 * organisms.
 *
 * ## Shape, not size
 *
 * Every length here is expressed as a Q-scaled MULTIPLE of the organism's adult
 * radius, never in world units. Scale belongs to `Gene.AdultSize`; this file
 * only decides proportions. The renderer multiplies by the radius it is already
 * given.
 */

/**
 * Derived morphology cache, one entry per organism slot.
 *
 * Structure-of-Arrays like every other per-organism store. Not hashed and not
 * serialized: `deriveMorphology` reconstructs it from the genome on restore,
 * so a save can never carry a body that disagrees with the genes that grew it.
 */
export class MorphologyStore {
  readonly capacity: number;

  /** Body extent along the heading, as a Q multiple of the adult radius. */
  readonly bodyLengthQ: Uint16Array;
  /** Body extent across the heading, as a Q multiple of the adult radius. */
  readonly bodyWidthQ: Uint16Array;
  /** `bodyLength / bodyWidth`, Q-scaled and clamped. Purely derived. */
  readonly aspectQ: Uint16Array;
  readonly frontTaperQ: Uint16Array;
  readonly rearTaperQ: Uint16Array;
  /** Number of body segments, `[minSegments, maxSegments]`. */
  readonly segmentCount: Uint8Array;
  /** Per-segment size multiplier toward the rear. */
  readonly segmentFalloffQ: Uint16Array;

  /** Number of symmetric appendage pairs. */
  readonly appendagePairs: Uint8Array;
  /** Fore/aft centre of the span the pairs occupy, Q along the body. */
  readonly appendagePlacementQ: Uint16Array;
  /** Appendage length as a Q multiple of the body half-width. */
  readonly appendageLengthQ: Uint16Array;
  /** Appendage thickness as a Q fraction of its length. */
  readonly appendageThicknessQ: Uint16Array;
  /** Rest angle from the lateral axis, in heading steps. */
  readonly appendageAngleSteps: Uint16Array;
  /** How much longer front pairs are than rear pairs, Q. */
  readonly appendageFrontBiasQ: Uint16Array;

  readonly headProportionQ: Uint16Array;
  readonly mouthSizeQ: Uint16Array;
  readonly sensorSizeQ: Uint16Array;
  readonly sensorPlacementQ: Uint16Array;

  /** Posterior extension length as a Q multiple of the body length. */
  readonly tailLengthQ: Uint16Array;
  readonly tailWidthQ: Uint16Array;
  readonly tailTaperQ: Uint16Array;

  readonly armorCoverageQ: Uint16Array;
  readonly plateExpressionQ: Uint16Array;
  readonly armorDistributionQ: Uint16Array;

  readonly primaryHueDeg: Uint16Array;
  readonly secondaryHueDeg: Uint16Array;
  readonly pigmentContrastQ: Uint16Array;
  readonly patternFrequency: Uint8Array;
  readonly patternOrientationSteps: Uint16Array;

  /**
   * Total forward+rear silhouette extent (head + body + tail) as a Q multiple
   * of the adult radius, and the same across the lateral axis including
   * appendages.
   *
   * Purely geometric summaries of the fields above. M14 uses them to scale the
   * sprite so a long-bodied lineage does not overflow its frame; M15 is where
   * they acquire physical meaning.
   */
  readonly silhouetteLengthQ: Uint16Array;
  readonly silhouetteWidthQ: Uint16Array;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `morphology capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;
    this.bodyLengthQ = new Uint16Array(capacity);
    this.bodyWidthQ = new Uint16Array(capacity);
    this.aspectQ = new Uint16Array(capacity);
    this.frontTaperQ = new Uint16Array(capacity);
    this.rearTaperQ = new Uint16Array(capacity);
    this.segmentCount = new Uint8Array(capacity);
    this.segmentFalloffQ = new Uint16Array(capacity);
    this.appendagePairs = new Uint8Array(capacity);
    this.appendagePlacementQ = new Uint16Array(capacity);
    this.appendageLengthQ = new Uint16Array(capacity);
    this.appendageThicknessQ = new Uint16Array(capacity);
    this.appendageAngleSteps = new Uint16Array(capacity);
    this.appendageFrontBiasQ = new Uint16Array(capacity);
    this.headProportionQ = new Uint16Array(capacity);
    this.mouthSizeQ = new Uint16Array(capacity);
    this.sensorSizeQ = new Uint16Array(capacity);
    this.sensorPlacementQ = new Uint16Array(capacity);
    this.tailLengthQ = new Uint16Array(capacity);
    this.tailWidthQ = new Uint16Array(capacity);
    this.tailTaperQ = new Uint16Array(capacity);
    this.armorCoverageQ = new Uint16Array(capacity);
    this.plateExpressionQ = new Uint16Array(capacity);
    this.armorDistributionQ = new Uint16Array(capacity);
    this.primaryHueDeg = new Uint16Array(capacity);
    this.secondaryHueDeg = new Uint16Array(capacity);
    this.pigmentContrastQ = new Uint16Array(capacity);
    this.patternFrequency = new Uint8Array(capacity);
    this.patternOrientationSteps = new Uint16Array(capacity);
    this.silhouetteLengthQ = new Uint16Array(capacity);
    this.silhouetteWidthQ = new Uint16Array(capacity);
  }
}

/** Signed hue shift in degrees from a normalized gene and a half-range. */
function hueShiftDegrees(valueQ: number, halfRangeDeg: number): number {
  return Math.trunc(((2 * valueQ - Q) * halfRangeDeg) / Q);
}

/** Wrap a degree value into `[0, 360)` without a modulo of a negative. */
function wrapHue(degrees: number): number {
  const wrapped = degrees % HUE_DEGREES;
  return wrapped < 0 ? wrapped + HUE_DEGREES : wrapped;
}

/**
 * Grow one slot's body from its morphological genome.
 *
 * `hueDeg` is the organism's ecological hue phenotype: the morphological
 * pigment genes shift away from it rather than replacing it, so a lineage's
 * base colour stays the thing the `creatureHueDifference` sensor already sees
 * and morphology adds the variation on top.
 */
export function deriveMorphology(
  morphology: MorphologyStore,
  genomes: GenomeStore,
  slot: number,
  hueDeg: number,
  config: DeepReadonly<SimulationConfig>,
): void {
  const m = config.organism.morphology;
  const base = genomes.morphOffset(slot);
  const raw = genomes.morphGenes;
  const g = (gene: number): number => morphGeneToQ(raw[base + gene] as number);

  const bodyLengthQ = lerpQ(m.bodyLengthMinQ, m.bodyLengthMaxQ, g(MorphGene.BodyLength));
  const bodyWidthQ = lerpQ(m.bodyWidthMinQ, m.bodyWidthMaxQ, g(MorphGene.BodyWidth));
  morphology.bodyLengthQ[slot] = bodyLengthQ;
  morphology.bodyWidthQ[slot] = bodyWidthQ;
  // Aspect is derived, not a gene: an independent aspect locus would be a
  // third way to say the same thing and would let two genomes disagree with
  // their own body about what shape it is.
  morphology.aspectQ[slot] = clamp(qdiv(bodyLengthQ, Math.max(1, bodyWidthQ)), 0, 65535);
  morphology.frontTaperQ[slot] = g(MorphGene.FrontTaper);
  morphology.rearTaperQ[slot] = g(MorphGene.RearTaper);
  morphology.segmentCount[slot] = segmentCount(g(MorphGene.SegmentCount), m);
  morphology.segmentFalloffQ[slot] = lerpQ(
    m.segmentFalloffMinQ,
    m.segmentFalloffMaxQ,
    g(MorphGene.SegmentProportion),
  );

  const pairs = appendagePairCount(g(MorphGene.AppendagePairs), m);
  const appendageLengthQ = lerpQ(
    m.appendageLengthMinQ,
    m.appendageLengthMaxQ,
    g(MorphGene.AppendageLength),
  );
  morphology.appendagePairs[slot] = pairs;
  morphology.appendagePlacementQ[slot] = g(MorphGene.AppendagePlacement);
  morphology.appendageLengthQ[slot] = appendageLengthQ;
  morphology.appendageThicknessQ[slot] = lerpQ(
    m.appendageThicknessMinQ,
    m.appendageThicknessMaxQ,
    g(MorphGene.AppendageThickness),
  );
  morphology.appendageAngleSteps[slot] = lerpQ(
    m.appendageAngleMinSteps,
    m.appendageAngleMaxSteps,
    g(MorphGene.AppendageAngle),
  );
  morphology.appendageFrontBiasQ[slot] = g(MorphGene.AppendageFrontBias);

  morphology.headProportionQ[slot] = lerpQ(
    m.headProportionMinQ,
    m.headProportionMaxQ,
    g(MorphGene.HeadProportion),
  );
  morphology.mouthSizeQ[slot] = lerpQ(m.mouthSizeMinQ, m.mouthSizeMaxQ, g(MorphGene.MouthSize));
  morphology.sensorSizeQ[slot] = lerpQ(m.sensorSizeMinQ, m.sensorSizeMaxQ, g(MorphGene.SensorSize));
  morphology.sensorPlacementQ[slot] = g(MorphGene.SensorPlacement);

  const tailLengthQ = lerpQ(m.tailLengthMinQ, m.tailLengthMaxQ, g(MorphGene.TailLength));
  morphology.tailLengthQ[slot] = tailLengthQ;
  morphology.tailWidthQ[slot] = lerpQ(m.tailWidthMinQ, m.tailWidthMaxQ, g(MorphGene.TailWidth));
  morphology.tailTaperQ[slot] = g(MorphGene.TailTaper);

  morphology.armorCoverageQ[slot] = g(MorphGene.ArmorCoverage);
  morphology.plateExpressionQ[slot] = g(MorphGene.PlateExpression);
  morphology.armorDistributionQ[slot] = g(MorphGene.ArmorDistribution);

  const primaryHue = wrapHue(
    hueDeg + hueShiftDegrees(g(MorphGene.PigmentPrimaryShift), m.pigmentPrimaryShiftMaxDeg),
  );
  morphology.primaryHueDeg[slot] = primaryHue;
  morphology.secondaryHueDeg[slot] = wrapHue(
    primaryHue + hueShiftDegrees(g(MorphGene.PigmentSecondaryShift), m.pigmentSecondaryShiftMaxDeg),
  );
  morphology.pigmentContrastQ[slot] = g(MorphGene.PigmentContrast);
  morphology.patternFrequency[slot] = clamp(
    Math.trunc((g(MorphGene.PatternFrequency) * (m.patternFrequencyMax + 1)) / (Q + 1)),
    0,
    MAX_MORPH_PATTERN_FREQUENCY,
  );
  morphology.patternOrientationSteps[slot] = Math.trunc(
    (g(MorphGene.PatternOrientation) * (ANGLE_STEPS >> 1)) / Q,
  );

  // Geometric summaries. Head and tail extend the body along the heading; the
  // widest appendage pair extends it laterally. Both are clamped into Uint16
  // because a Q multiple of the radius cannot legitimately exceed ~16x.
  const headExtentQ = qmul(bodyLengthQ, morphology.headProportionQ[slot]);
  const tailExtentQ = qmul(bodyLengthQ, tailLengthQ);
  morphology.silhouetteLengthQ[slot] = clamp(
    bodyLengthQ + headExtentQ + tailExtentQ,
    0,
    m.maxSilhouetteExtentQ,
  );
  const halfWidthQ = bodyWidthQ >> 1;
  const reachQ = pairs === 0 ? 0 : qmul(halfWidthQ, appendageLengthQ);
  morphology.silhouetteWidthQ[slot] = clamp(bodyWidthQ + 2 * reachQ, 0, m.maxSilhouetteExtentQ);
}

/** Number of morphological genes, re-exported for stride arithmetic. */
export { MORPH_GENE_COUNT };
