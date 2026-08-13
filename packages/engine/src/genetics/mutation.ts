import type { DeepReadonly } from "@eon/shared";
import { BRAIN_WEIGHT_COUNT } from "../brain/BrainLayout";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, qmul } from "../math/fixed";
import type { GenomeStore } from "../organisms/GenomeStore";
import type { Xoshiro128 } from "../random/Xoshiro128";
import { GENE_COUNT, GENE_RAW_MAX } from "./genes";

/**
 * Asexual mutation (docs/04 §18, docs/08 §17, tasks E03/E04).
 *
 * A child is an exact copy of its parent's 16 genes and 400 weights, then
 * perturbed. There is no crossover and no second parent — reproduction is
 * asexual for the whole MVP.
 *
 * ## One roll per locus, three mutually exclusive outcomes
 *
 * docs/04 §18 states three per-gene probabilities (small 0.08, large 0.0049,
 * reset ~0.00024) without saying whether they are independent events. They are
 * implemented as one uniform draw partitioned into disjoint intervals:
 *
 * ```text
 * roll in [0, resetP)                                  -> Reset
 * roll in [resetP, resetP+largeP)                      -> Large
 * roll in [resetP+largeP, resetP+largeP+smallP)         -> Small
 * otherwise                                            -> None
 * ```
 *
 * Each marginal probability is therefore exactly the configured value, the
 * outcomes cannot combine (a gene that is re-rolled from scratch should not also
 * be nudged), and the cost is one PRNG draw per locus instead of three. The
 * partition order is a determinism contract: reordering the intervals changes
 * which class a given roll selects and therefore every evolutionary history.
 *
 * ## Draw accounting
 *
 * Exactly `GENE_COUNT + BRAIN_WEIGHT_COUNT` = 416 classification draws per
 * birth, plus one {@link Xoshiro128.approxNormalQ} (12 draws) per mutated locus
 * and one uniform draw per reset gene. Genes are always mutated before weights.
 * Both counts and the order are part of the PRNG stream and cannot change
 * without an ENGINE_VERSION bump.
 *
 * ## Sigma units differ between the two blocks, and that is deliberate
 *
 * Ecological sigmas are fractions of the *normalized* gene range (docs/08 §17
 * calls `smallSigmaQ` "0.025 normalized"), so they must be scaled onto the raw
 * Uint16 span. Brain sigmas are already expressed in *stored weight units*
 * (`weightSmallSigmaQ` = 246 ≈ 0.06 × `weightScale`), so they apply directly.
 */

/** Which change a single per-locus roll selects. */
export const MutationClass = {
  None: 0,
  Small: 1,
  Large: 2,
  Reset: 3,
} as const;

export type MutationClass = (typeof MutationClass)[keyof typeof MutationClass];

/**
 * Classify one ecological-gene roll in `[0, Q)`.
 *
 * Exported so tests can pin the interval boundaries against the config without
 * restating the arithmetic that the mutation loop uses.
 */
export function classifyGeneRoll(
  rollQ: number,
  mutation: DeepReadonly<SimulationConfig>["mutation"]["ecological"],
): MutationClass {
  if (rollQ < mutation.resetProbabilityQ) {
    return MutationClass.Reset;
  }
  let bound = mutation.resetProbabilityQ + mutation.largeMutationProbabilityQ;
  if (rollQ < bound) {
    return MutationClass.Large;
  }
  bound += mutation.perGeneMutationProbabilityQ;
  if (rollQ < bound) {
    return MutationClass.Small;
  }
  return MutationClass.None;
}

/**
 * Classify one brain-weight roll in `[0, Q)`.
 *
 * There is no reset class for weights: re-rolling a single connection uniformly
 * over ±8192 is not a mutation of a controller, it is damage to it, and
 * docs/07 §12 lists "mutation destroys brain too fast" as a failure mode to
 * avoid. The large class covers rare big jumps.
 */
export function classifyWeightRoll(
  rollQ: number,
  mutation: DeepReadonly<SimulationConfig>["mutation"]["brain"],
): MutationClass {
  if (rollQ < mutation.largeWeightMutationProbabilityQ) {
    return MutationClass.Large;
  }
  if (rollQ < mutation.largeWeightMutationProbabilityQ + mutation.perWeightMutationProbabilityQ) {
    return MutationClass.Small;
  }
  return MutationClass.None;
}

/**
 * Approximately normal delta in raw gene units.
 *
 * `normalQ` is an {@link Xoshiro128.approxNormalQ} sample (σ ≈ Q, range ±6Q) and
 * `sigmaQ` is a Q fraction of the *normalized* gene range, so the result has
 * standard deviation `sigmaQ / Q × GENE_RAW_MAX` raw units. The multiplication
 * happens before either division so a small sigma does not truncate to zero:
 * the worst-case product is 6Q × Q × 65535 ≈ 6.6e12, three orders of magnitude
 * below the exact integer limit.
 */
export function geneDeltaRaw(normalQ: number, sigmaQ: number): number {
  return Math.trunc((normalQ * sigmaQ * GENE_RAW_MAX) / (Q * Q));
}

/**
 * Mutate the 16 ecological genes of one gene block in place.
 *
 * Clamping to `[0, GENE_RAW_MAX]` is what keeps every downstream mapping inside
 * its declared range: the phenotype code never has to defend against an
 * out-of-range gene, because a gene cannot leave the range in the first place.
 */
export function mutateEcologicalGenes(
  genes: Uint16Array,
  offset: number,
  rng: Xoshiro128,
  config: DeepReadonly<SimulationConfig>,
): void {
  const mutation = config.mutation.ecological;

  for (let i = 0; i < GENE_COUNT; i += 1) {
    const kind = classifyGeneRoll(rng.nextQ(), mutation);
    if (kind === MutationClass.None) {
      continue;
    }
    const index = offset + i;
    if (kind === MutationClass.Reset) {
      // A full re-roll over the whole stored range: the one mutation that can
      // reach a distant part of the gene space in a single birth.
      genes[index] = rng.nextInt(GENE_RAW_MAX + 1);
      continue;
    }
    const sigmaQ = kind === MutationClass.Large ? mutation.largeSigmaQ : mutation.smallSigmaQ;
    genes[index] = clamp(
      (genes[index] as number) + geneDeltaRaw(rng.approxNormalQ(), sigmaQ),
      0,
      GENE_RAW_MAX,
    );
  }
}

/**
 * Mutate the 400 brain weights of one weight block in place.
 *
 * Weights are clamped to the configured symmetric bound (±8192 by default,
 * docs/08 §17), so a lineage cannot accumulate unbounded weights and push the
 * inference accumulator out of exact integer range.
 */
export function mutateBrainWeights(
  weights: Int16Array,
  offset: number,
  rng: Xoshiro128,
  config: DeepReadonly<SimulationConfig>,
): void {
  const mutation = config.mutation.brain;
  const { weightMin, weightMax } = config.brain;

  for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
    const kind = classifyWeightRoll(rng.nextQ(), mutation);
    if (kind === MutationClass.None) {
      continue;
    }
    const sigmaQ =
      kind === MutationClass.Large ? mutation.weightLargeSigmaQ : mutation.weightSmallSigmaQ;
    const index = offset + i;
    weights[index] = clamp(
      (weights[index] as number) + qmul(rng.approxNormalQ(), sigmaQ),
      weightMin,
      weightMax,
    );
  }
}

/**
 * Mutate one slot's inherited state: ecological genes first, then brain weights.
 *
 * The caller has already copied the parent's genome onto this slot. The order of
 * the two blocks fixes the PRNG stream and is part of the engine version.
 */
export function mutateGenome(
  genomes: GenomeStore,
  slot: number,
  rng: Xoshiro128,
  config: DeepReadonly<SimulationConfig>,
): void {
  mutateEcologicalGenes(genomes.genes, genomes.geneOffset(slot), rng, config);
  mutateBrainWeights(genomes.brainWeights, genomes.weightOffset(slot), rng, config);
}
