import { Q } from "../math/fixed";
import { MORPH_GENE_COUNT, MorphGene, morphGeneFromQ, structuralGeneFromCount } from "./morphGenes";
import type { MorphologyConfig } from "../config/SimulationConfig";
import type { DeepReadonly } from "@eon/shared";

/**
 * Founder morphological genome (M14).
 *
 * The same principle as `genetics/founderGenome.ts`: deliberately
 * middle-of-the-road, so that every direction is reachable and none is
 * pre-selected. A founder body is a short-ish, moderately wide, two-segment
 * form with two appendage pairs, a modest head, a short tail, almost no
 * plating and almost no pattern — visibly an animal, and visibly unspecialized.
 *
 * There is no "founder species look" beyond that. The values below are the
 * MIDPOINT of most ranges precisely so the first mutation in any direction is
 * as likely to be an improvement as a loss.
 *
 * Changing any value here changes morphology from tick 0 and is an
 * ENGINE_VERSION event.
 */
export const FOUNDER_MORPH_GENE_Q: readonly number[] = (() => {
  const genes = new Array<number>(MORPH_GENE_COUNT).fill(Q >> 1);
  // Slightly longer than wide, so heading is legible at the smallest zoom.
  genes[MorphGene.BodyLength] = 2253; // 0.55
  genes[MorphGene.BodyWidth] = 1843; // 0.45
  genes[MorphGene.FrontTaper] = 2458; // 0.60 — a blunt nose, not a needle
  genes[MorphGene.RearTaper] = 1638; // 0.40
  genes[MorphGene.SegmentProportion] = 2048; // 0.50
  genes[MorphGene.AppendagePlacement] = 2048;
  genes[MorphGene.AppendageLength] = 1638; // 0.40 — short limbs
  genes[MorphGene.AppendageThickness] = 1638;
  genes[MorphGene.AppendageAngle] = 2048;
  genes[MorphGene.AppendageFrontBias] = 2048;
  genes[MorphGene.HeadProportion] = 1843; // 0.45
  genes[MorphGene.MouthSize] = 1638; // 0.40
  genes[MorphGene.SensorSize] = 1638;
  genes[MorphGene.SensorPlacement] = 2458; // 0.60 — forward-set
  genes[MorphGene.TailLength] = 1229; // 0.30 — a stub
  genes[MorphGene.TailWidth] = 1638;
  genes[MorphGene.TailTaper] = 2458;
  // Founders are unarmored and unpatterned: plating and pattern are things a
  // lineage acquires, and starting near zero leaves the whole range above.
  genes[MorphGene.ArmorCoverage] = 410; // 0.10
  genes[MorphGene.PlateExpression] = 410;
  genes[MorphGene.ArmorDistribution] = 2048;
  genes[MorphGene.PigmentPrimaryShift] = 2048; // no shift from the hue gene
  genes[MorphGene.PigmentSecondaryShift] = 2048;
  genes[MorphGene.PigmentContrast] = 819; // 0.20
  genes[MorphGene.PatternFrequency] = 205; // 0.05 → no repeats
  genes[MorphGene.PatternOrientation] = 2048;
  return genes;
})();

/** Structural founder values, expressed as counts rather than as gene values. */
export const FOUNDER_SEGMENTS = 2;
export const FOUNDER_APPENDAGE_PAIRS = 2;

/**
 * The founder morphological genome as stored Uint16 values.
 *
 * The two structural loci are written through
 * {@link structuralGeneFromCount} so a founder sits in the MIDDLE of its
 * bucket: a founder parked on a bucket edge would flip its segment count on
 * the first small mutation and make "founders have two segments" untrue after
 * one generation.
 */
export function createFounderMorphGenes(config: DeepReadonly<MorphologyConfig>): Uint16Array {
  const genes = new Uint16Array(MORPH_GENE_COUNT);
  for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
    genes[i] = morphGeneFromQ(FOUNDER_MORPH_GENE_Q[i] as number);
  }
  genes[MorphGene.SegmentCount] = structuralGeneFromCount(
    FOUNDER_SEGMENTS,
    config.minSegments,
    config.maxSegments,
  );
  genes[MorphGene.AppendagePairs] = structuralGeneFromCount(
    FOUNDER_APPENDAGE_PAIRS,
    config.minAppendagePairs,
    config.maxAppendagePairs,
  );
  return genes;
}
