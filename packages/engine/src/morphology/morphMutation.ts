import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp } from "../math/fixed";
import type { GenomeStore } from "../organisms/GenomeStore";
import type { Xoshiro128 } from "../random/Xoshiro128";
import {
  MORPH_GENE_COUNT,
  MORPH_GENE_RAW_MAX,
  MorphGene,
  appendagePairCount,
  isStructuralMorphGene,
  morphGeneToQ,
  segmentCount,
  structuralGeneFromCount,
} from "./morphGenes";

/**
 * Morphological mutation (M14, docs/11 §M14).
 *
 * Mirrors `genetics/mutation.ts` — one uniform draw per locus partitioned into
 * disjoint outcome intervals, so each marginal probability is exactly the
 * configured value and the outcomes cannot combine. What is different is a
 * fourth class for the two structural loci.
 *
 * ## Structural mutation is a step, not a nudge
 *
 * `SegmentCount` and `AppendagePairs` are read as small integers. A continuous
 * perturbation on those loci would do nothing at all most of the time and flip
 * the count at a bucket edge, which makes gaining a segment an artefact of
 * where a genome happens to sit rather than an event. Instead the structural
 * class moves the DERIVED COUNT by exactly ±1 and rewrites the gene to the
 * centre of the destination bucket, so the change is discrete, bounded, and
 * stable against the small mutations that follow it.
 *
 * At the ends of the range the step is reflected inward rather than clamped in
 * place: clamping would make "mutate at the maximum" a no-op and quietly bias
 * lineages toward parking at the bounds.
 *
 * ## Draw accounting
 *
 * Exactly `MORPH_GENE_COUNT` classification draws per birth, plus one
 * {@link Xoshiro128.approxNormalQ} (12 draws) per continuously mutated locus,
 * one uniform draw per reset locus and one uniform draw per structural step.
 * Morphology is mutated AFTER the ecological genes and BEFORE the brain
 * weights; that position in the PRNG stream is part of the engine version.
 */

/** Which change a single per-locus morphological roll selects. */
export const MorphMutationClass = {
  None: 0,
  Small: 1,
  Large: 2,
  Reset: 3,
  Structural: 4,
} as const;

export type MorphMutationClass = (typeof MorphMutationClass)[keyof typeof MorphMutationClass];

/**
 * Classify one morphological roll in `[0, Q)`.
 *
 * Structural loci use the structural interval in place of the small and large
 * intervals: a segment count has no meaningful "slightly bigger". They keep
 * the reset interval, which re-rolls the count uniformly over its whole range.
 */
export function classifyMorphRoll(
  rollQ: number,
  gene: number,
  mutation: DeepReadonly<SimulationConfig>["mutation"]["morphology"],
): MorphMutationClass {
  if (rollQ < mutation.resetProbabilityQ) {
    return MorphMutationClass.Reset;
  }
  if (isStructuralMorphGene(gene)) {
    const bound = mutation.resetProbabilityQ + mutation.structuralProbabilityQ;
    return rollQ < bound ? MorphMutationClass.Structural : MorphMutationClass.None;
  }
  let bound = mutation.resetProbabilityQ + mutation.largeMutationProbabilityQ;
  if (rollQ < bound) {
    return MorphMutationClass.Large;
  }
  bound += mutation.perGeneMutationProbabilityQ;
  if (rollQ < bound) {
    return MorphMutationClass.Small;
  }
  return MorphMutationClass.None;
}

/** Approximately normal delta in raw morphological gene units. */
export function morphDeltaRaw(normalQ: number, sigmaQ: number): number {
  return Math.trunc((normalQ * sigmaQ * MORPH_GENE_RAW_MAX) / (Q * Q));
}

/** Current integer value of a structural locus. */
function structuralValue(
  gene: number,
  valueQ: number,
  config: DeepReadonly<SimulationConfig>["organism"]["morphology"],
): { count: number; min: number; max: number } {
  if (gene === MorphGene.SegmentCount) {
    return {
      count: segmentCount(valueQ, config),
      min: config.minSegments,
      max: config.maxSegments,
    };
  }
  return {
    count: appendagePairCount(valueQ, config),
    min: config.minAppendagePairs,
    max: config.maxAppendagePairs,
  };
}

/**
 * Apply a bounded ±1 structural step and return the new stored gene value.
 *
 * `up` is the direction the caller drew. A step that would leave the range is
 * reflected; when the range has only one value the gene is unchanged.
 */
export function structuralStep(
  gene: number,
  currentRaw: number,
  up: boolean,
  config: DeepReadonly<SimulationConfig>["organism"]["morphology"],
): number {
  const { count, min, max } = structuralValue(gene, morphGeneToQ(currentRaw), config);
  if (min === max) {
    return currentRaw;
  }
  let next = up ? count + 1 : count - 1;
  if (next > max) {
    next = max - 1;
  } else if (next < min) {
    next = min + 1;
  }
  return structuralGeneFromCount(next, min, max);
}

/**
 * Mutate one morphological gene block in place.
 *
 * Clamping to `[0, MORPH_GENE_RAW_MAX]` keeps every developmental mapping
 * inside its declared range, so the interpreter never has to defend against an
 * out-of-range gene.
 */
export function mutateMorphologyGenes(
  genes: Uint16Array,
  offset: number,
  rng: Xoshiro128,
  config: DeepReadonly<SimulationConfig>,
): void {
  const mutation = config.mutation.morphology;
  const morphology = config.organism.morphology;

  for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
    const kind = classifyMorphRoll(rng.nextQ(), i, mutation);
    if (kind === MorphMutationClass.None) {
      continue;
    }
    const index = offset + i;
    if (kind === MorphMutationClass.Reset) {
      genes[index] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      continue;
    }
    if (kind === MorphMutationClass.Structural) {
      genes[index] = structuralStep(i, genes[index] as number, rng.nextInt(2) === 1, morphology);
      continue;
    }
    const sigmaQ = kind === MorphMutationClass.Large ? mutation.largeSigmaQ : mutation.smallSigmaQ;
    genes[index] = clamp(
      (genes[index] as number) + morphDeltaRaw(rng.approxNormalQ(), sigmaQ),
      0,
      MORPH_GENE_RAW_MAX,
    );
  }
}

/** Mutate one slot's morphological genome. */
export function mutateMorphology(
  genomes: GenomeStore,
  slot: number,
  rng: Xoshiro128,
  config: DeepReadonly<SimulationConfig>,
): void {
  mutateMorphologyGenes(genomes.morphGenes, genomes.morphOffset(slot), rng, config);
}
