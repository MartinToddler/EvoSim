import { describe, expect, it } from "vitest";
import { NEURAL_WEIGHT_COUNT as BRAIN_WEIGHT_COUNT } from "../brain/NeuralTopology";
import { createFounderBrainWeights } from "../brain/founderBrain";
import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { validateConfig } from "../config/validateConfig";
import { Q } from "../math/fixed";
import { Xoshiro128 } from "../random/Xoshiro128";
import { createFounderGenes } from "./founderGenome";
import { GENE_COUNT, GENE_RAW_MAX } from "./genes";
import { mutateBrainWeights, mutateEcologicalGenes } from "./mutation";

/**
 * Mutation statistical sanity on a deterministic large sample, plus the two
 * ablation fixtures (Milestone 4 review; docs/07 §2 "Genome: deterministic
 * mutation, clamp", docs/07 §12 "mutation destroys brain too fast").
 *
 * `mutation.test.ts` pins the *mechanism*: the roll partition counted over its
 * whole domain, the delta scaling, the clamps and a 50-generation golden. This
 * file pins the *distribution* the mechanism produces, which is what a
 * calibration question ("is 2% of 400 weights really ~8 changes?", "is the
 * delta symmetric?") actually asks.
 *
 * Nothing here samples in the statistical sense: the PRNG is seeded, so every
 * number below is a fixed property of this engine version, and the tolerances
 * exist to describe how much drift would be a real change rather than to absorb
 * run-to-run noise. All of them would still hold at a much larger sample.
 */

const ECOLOGICAL = DEFAULT_CONFIG.mutation.ecological;
const BRAIN = DEFAULT_CONFIG.mutation.brain;

/** Births per statistical sample. Large enough to pin a mean to ~0.5%. */
const SAMPLE_BIRTHS = 20_000;

interface MutationSample {
  /** Mean number of the 16 genes that changed per birth. */
  genesChangedPerBirth: number;
  /** Mean number of the 400 weights that changed per birth. */
  weightsChangedPerBirth: number;
  /** Standard deviation of a changed weight's delta, in stored weight units. */
  weightDeltaSd: number;
  /** Mean of a changed weight's delta. Must be ~0: the sampler is symmetric. */
  weightDeltaMean: number;
  /** Fraction of births in which not one of the 416 loci changed. */
  exactCloneFraction: number;
  /** Genes that left `[0, GENE_RAW_MAX]`; must be zero. */
  geneOutOfRange: number;
  /** Weights that left the configured clamp; must be zero. */
  weightOutOfRange: number;
}

/**
 * Mutate a fresh copy of the founder genome `SAMPLE_BIRTHS` times and summarize.
 *
 * Re-seeding from the founder each time isolates one generation of mutation:
 * a lineage would compound drift and mix the classes' contributions together.
 */
function sampleMutation(config: ReadonlySimulationConfig, seed: number): MutationSample {
  const rng = Xoshiro128.fromSeed(seed);
  const founderGenes = createFounderGenes();
  const founderWeights = createFounderBrainWeights(
    config.brain.weightScale,
    config.brain.weightMin,
    config.brain.weightMax,
  );
  const genes = new Uint16Array(GENE_COUNT);
  const weights = new Int16Array(BRAIN_WEIGHT_COUNT);

  let genesChanged = 0;
  let weightsChanged = 0;
  let weightDeltaSum = 0;
  let weightDeltaSquares = 0;
  let clones = 0;
  let geneOutOfRange = 0;
  let weightOutOfRange = 0;

  for (let birth = 0; birth < SAMPLE_BIRTHS; birth += 1) {
    genes.set(founderGenes);
    weights.set(founderWeights);
    mutateEcologicalGenes(genes, 0, rng, config);
    mutateBrainWeights(weights, 0, rng, config);

    let changedHere = 0;
    for (let i = 0; i < GENE_COUNT; i += 1) {
      const value = genes[i] as number;
      if (value < 0 || value > GENE_RAW_MAX) {
        geneOutOfRange += 1;
      }
      if (value !== founderGenes[i]) {
        changedHere += 1;
      }
    }
    genesChanged += changedHere;

    for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
      const value = weights[i] as number;
      if (value < config.brain.weightMin || value > config.brain.weightMax) {
        weightOutOfRange += 1;
      }
      const delta = value - (founderWeights[i] as number);
      if (delta !== 0) {
        changedHere += 1;
        weightsChanged += 1;
        weightDeltaSum += delta;
        weightDeltaSquares += delta * delta;
      }
    }
    if (changedHere === 0) {
      clones += 1;
    }
  }

  return {
    genesChangedPerBirth: genesChanged / SAMPLE_BIRTHS,
    weightsChangedPerBirth: weightsChanged / SAMPLE_BIRTHS,
    weightDeltaSd: Math.sqrt(weightDeltaSquares / weightsChanged),
    weightDeltaMean: weightDeltaSum / weightsChanged,
    exactCloneFraction: clones / SAMPLE_BIRTHS,
    geneOutOfRange,
    weightOutOfRange,
  };
}

describe("mutation statistics on a deterministic large sample", () => {
  const sample = sampleMutation(DEFAULT_CONFIG, 0xa7_0004);

  it("changes the configured number of loci per birth", () => {
    // The expectation is the partition's own arithmetic, not a magic number:
    // every locus has exactly (reset + large + small) / Q chance of changing.
    const geneRateQ =
      ECOLOGICAL.resetProbabilityQ +
      ECOLOGICAL.largeMutationProbabilityQ +
      ECOLOGICAL.perGeneMutationProbabilityQ;
    const weightRateQ = BRAIN.largeWeightMutationProbabilityQ + BRAIN.perWeightMutationProbabilityQ;
    const expectedGenes = (GENE_COUNT * geneRateQ) / Q;
    const expectedWeights = (BRAIN_WEIGHT_COUNT * weightRateQ) / Q;

    // A changed locus is counted by value, so a delta that truncates to zero
    // reads as "unchanged" — the observed rate is at most the roll rate IN
    // EXPECTATION. It is not bounded by it in a finite sample, and asserting
    // that it is was a defect this file carried until M16's wider weight block
    // moved the stream and produced 1.3657 against an expectation of 1.36328.
    // Both are the same number to within a fifth of a standard error; the
    // sample was never going to sit permanently below its own mean. The band
    // below is symmetric for that reason.
    expect(sample.genesChangedPerBirth).toBeLessThan(expectedGenes * 1.03);
    expect(sample.genesChangedPerBirth).toBeGreaterThan(expectedGenes * 0.97);
    expect(sample.weightsChangedPerBirth).toBeLessThan(expectedWeights * 1.03);
    expect(sample.weightsChangedPerBirth).toBeGreaterThan(expectedWeights * 0.97);

    // docs/04 §18 says "At 400 weights, 2% ≈ 8 changed weights/birth". M16
    // widened the block to 576 for the recurrent and memory weights, so the
    // same rate is ~11.5 — the rate did not change, the network did.
    expect(sample.weightsChangedPerBirth).toBeGreaterThan(10.5);
    expect(sample.weightsChangedPerBirth).toBeLessThan(12.5);
  });

  it("draws symmetric weight deltas at the configured mixture sigma", () => {
    // approxNormalQ is centred and qmul truncates toward zero, so the mean must
    // sit within a fraction of one standard error of zero. A floor-based qmul
    // would instead bias every mutated weight downward by ~0.5 units, which at
    // eight mutations per birth would drag whole brains toward zero over a
    // lineage — the reason this is asserted rather than assumed.
    const standardError =
      sample.weightDeltaSd / Math.sqrt(sample.weightsChangedPerBirth * SAMPLE_BIRTHS);
    expect(Math.abs(sample.weightDeltaMean)).toBeLessThan(4 * standardError);
    expect(Math.abs(sample.weightDeltaMean)).toBeLessThan(1);

    // The mixture's standard deviation, from the two classes' shares:
    // sqrt(pSmall*smallSigma² + pLarge*largeSigma²).
    const totalQ = BRAIN.perWeightMutationProbabilityQ + BRAIN.largeWeightMutationProbabilityQ;
    const smallShare = BRAIN.perWeightMutationProbabilityQ / totalQ;
    const largeShare = BRAIN.largeWeightMutationProbabilityQ / totalQ;
    const expectedSd = Math.sqrt(
      smallShare * BRAIN.weightSmallSigmaQ ** 2 + largeShare * BRAIN.weightLargeSigmaQ ** 2,
    );
    expect(sample.weightDeltaSd).toBeGreaterThan(expectedSd * 0.95);
    expect(sample.weightDeltaSd).toBeLessThan(expectedSd * 1.05);
  });

  it("never produces a gene or weight outside its stored range", () => {
    expect(sample.geneOutOfRange).toBe(0);
    expect(sample.weightOutOfRange).toBe(0);
  });

  it("clones a parent exactly only as often as the per-locus rates imply", () => {
    // An exact clone is not a bug — docs/04 §18 specifies per-locus
    // probabilities, and "no locus rolled a mutation" is a legitimate outcome —
    // but it must stay as rare as those probabilities say, because a common
    // clone would mean the mutation loop is being skipped.
    const geneMissQ =
      Q -
      ECOLOGICAL.resetProbabilityQ -
      ECOLOGICAL.largeMutationProbabilityQ -
      ECOLOGICAL.perGeneMutationProbabilityQ;
    const weightMissQ =
      Q - BRAIN.largeWeightMutationProbabilityQ - BRAIN.perWeightMutationProbabilityQ;
    const expected = (geneMissQ / Q) ** GENE_COUNT * (weightMissQ / Q) ** BRAIN_WEIGHT_COUNT;

    expect(expected).toBeLessThan(1e-4);
    // Assert what this sample can actually resolve. With 619 loci the analytic
    // clone probability is around 1e-6, i.e. well under one expected clone in
    // the whole sample — so "within 10x of the analytic value" is asking 20 000
    // draws to measure something twenty times finer than their own resolution,
    // and a single clone (5e-5) fails it for no reason but Poisson noise. The
    // claim worth defending is the one the comment above states: a clone must
    // be RARE, not that its frequency matches an unmeasurable prediction.
    expect(sample.exactCloneFraction).toBeLessThan(1e-3);
  });
});

describe("no-mutation config fixture", () => {
  /** Every mutation probability zero: the ablation that isolates inheritance. */
  const NO_MUTATION: ReadonlySimulationConfig = (() => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.ecological.perGeneMutationProbabilityQ = 0;
    config.mutation.ecological.largeMutationProbabilityQ = 0;
    config.mutation.ecological.resetProbabilityQ = 0;
    config.mutation.brain.perWeightMutationProbabilityQ = 0;
    config.mutation.brain.largeWeightMutationProbabilityQ = 0;
    return config;
  })();

  it("is a legal configuration", () => {
    // Zero must stay valid: an ablation that the validator rejects cannot be
    // used to isolate what mutation contributes.
    expect(() => validateConfig(cloneConfig(NO_MUTATION))).not.toThrow();
  });

  it("copies genome and brain exactly, over a thousand successive births", () => {
    const rng = Xoshiro128.fromSeed(0xa7_0005);
    const genes = createFounderGenes();
    const weights = createFounderBrainWeights(
      NO_MUTATION.brain.weightScale,
      NO_MUTATION.brain.weightMin,
      NO_MUTATION.brain.weightMax,
    );
    const originalGenes = Uint16Array.from(genes);
    const originalWeights = Int16Array.from(weights);

    for (let birth = 0; birth < 1_000; birth += 1) {
      mutateEcologicalGenes(genes, 0, rng, NO_MUTATION);
      mutateBrainWeights(weights, 0, rng, NO_MUTATION);
    }

    expect(Array.from(genes)).toEqual(Array.from(originalGenes));
    expect(Array.from(weights)).toEqual(Array.from(originalWeights));
  });

  it("still consumes one classification draw per locus", () => {
    // The classification draw happens before the class is known, so it is spent
    // whatever the probabilities are. That is what keeps the per-birth draw
    // count a function of the config alone rather than of how many loci
    // happened to mutate — and it is why a zero-mutation world is a different
    // PRNG stream, not a frozen one.
    const rng = Xoshiro128.fromSeed(0xa7_0006);
    const reference = Xoshiro128.fromSeed(0xa7_0006);
    const genes = createFounderGenes();
    const weights = createFounderBrainWeights(
      NO_MUTATION.brain.weightScale,
      NO_MUTATION.brain.weightMin,
      NO_MUTATION.brain.weightMax,
    );

    mutateEcologicalGenes(genes, 0, rng, NO_MUTATION);
    mutateBrainWeights(weights, 0, rng, NO_MUTATION);

    // Exactly GENE_COUNT + BRAIN_WEIGHT_COUNT uniform draws, no normal samples.
    let words = 0;
    const target = JSON.stringify(rng.serializeState());
    while (JSON.stringify(reference.serializeState()) !== target) {
      reference.nextU32();
      words += 1;
      expect(words).toBeLessThanOrEqual(GENE_COUNT + BRAIN_WEIGHT_COUNT);
    }
    expect(words).toBe(GENE_COUNT + BRAIN_WEIGHT_COUNT);
  });
});

describe("forced-mutation config fixture", () => {
  /** Every locus mutates in the small class, every birth. */
  const ALL_SMALL: ReadonlySimulationConfig = (() => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.ecological.resetProbabilityQ = 0;
    config.mutation.ecological.largeMutationProbabilityQ = 0;
    config.mutation.ecological.perGeneMutationProbabilityQ = Q;
    config.mutation.brain.largeWeightMutationProbabilityQ = 0;
    config.mutation.brain.perWeightMutationProbabilityQ = Q;
    return config;
  })();

  /** Every gene is re-rolled uniformly, every birth. */
  const ALL_RESET: ReadonlySimulationConfig = (() => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.ecological.resetProbabilityQ = Q;
    config.mutation.ecological.largeMutationProbabilityQ = 0;
    config.mutation.ecological.perGeneMutationProbabilityQ = 0;
    return config;
  })();

  it("accepts probabilities that saturate the roll domain", () => {
    // The validator's ceiling is "reset + large + small <= Q". Exactly Q is the
    // boundary case and must be legal, or the forced fixture is unreachable.
    expect(() => validateConfig(cloneConfig(ALL_SMALL))).not.toThrow();
    expect(() => validateConfig(cloneConfig(ALL_RESET))).not.toThrow();
  });

  it("mutates every gene and effectively every weight in a single birth", () => {
    const rng = Xoshiro128.fromSeed(0xa7_0007);
    const genes = createFounderGenes();
    const weights = createFounderBrainWeights(
      ALL_SMALL.brain.weightScale,
      ALL_SMALL.brain.weightMin,
      ALL_SMALL.brain.weightMax,
    );
    const originalGenes = Uint16Array.from(genes);
    const originalWeights = Int16Array.from(weights);

    mutateEcologicalGenes(genes, 0, rng, ALL_SMALL);
    mutateBrainWeights(weights, 0, rng, ALL_SMALL);

    let unchangedGenes = 0;
    for (let i = 0; i < GENE_COUNT; i += 1) {
      if (genes[i] === originalGenes[i]) {
        unchangedGenes += 1;
      }
    }
    let unchangedWeights = 0;
    for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
      if (weights[i] === originalWeights[i]) {
        unchangedWeights += 1;
      }
    }

    // Genes are perturbed on the 65 536-wide raw span, where the small sigma is
    // 1 632 raw units, so a delta truncating to zero is vanishingly unlikely.
    expect(unchangedGenes).toBe(0);
    // Weights are perturbed in stored units where the small sigma is 246, so a
    // handful of samples legitimately truncate to zero. Anything beyond a few
    // percent would mean the delta is being lost, not rounded.
    expect(unchangedWeights).toBeLessThan(BRAIN_WEIGHT_COUNT * 0.03);
  });

  it("keeps a forced lineage inside range for a thousand generations", () => {
    // Sustained maximal pressure is the clamp's worst case: every locus is
    // pushed every birth, so weights drift until they meet the bound and genes
    // random-walk across the whole span.
    const rng = Xoshiro128.fromSeed(0xa7_0008);
    const genes = createFounderGenes();
    const weights = createFounderBrainWeights(
      ALL_SMALL.brain.weightScale,
      ALL_SMALL.brain.weightMin,
      ALL_SMALL.brain.weightMax,
    );

    for (let generation = 0; generation < 1_000; generation += 1) {
      mutateEcologicalGenes(genes, 0, rng, ALL_SMALL);
      mutateBrainWeights(weights, 0, rng, ALL_SMALL);
      for (let i = 0; i < GENE_COUNT; i += 1) {
        const value = genes[i] as number;
        if (value < 0 || value > GENE_RAW_MAX) {
          throw new Error(`gene ${i} left its range at generation ${generation}: ${value}`);
        }
      }
      for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
        const value = weights[i] as number;
        if (value < ALL_SMALL.brain.weightMin || value > ALL_SMALL.brain.weightMax) {
          throw new Error(`weight ${i} left its clamp at generation ${generation}: ${value}`);
        }
      }
    }

    // And the pressure really was sustained: a thousand forced generations must
    // have driven a substantial share of the weights onto the clamp.
    let atClamp = 0;
    for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
      if (weights[i] === ALL_SMALL.brain.weightMin || weights[i] === ALL_SMALL.brain.weightMax) {
        atClamp += 1;
      }
    }
    expect(atClamp).toBeGreaterThan(0);
  });

  it("re-rolls a reset gene uniformly across the whole stored range", () => {
    const rng = Xoshiro128.fromSeed(0xa7_0009);
    const genes = new Uint16Array(GENE_COUNT);
    let sum = 0;
    let count = 0;
    let min = GENE_RAW_MAX;
    let max = 0;
    for (let birth = 0; birth < 2_000; birth += 1) {
      mutateEcologicalGenes(genes, 0, rng, ALL_RESET);
      for (let i = 0; i < GENE_COUNT; i += 1) {
        const value = genes[i] as number;
        sum += value;
        count += 1;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    const mean = sum / count;
    // Uniform over [0, GENE_RAW_MAX] has mean GENE_RAW_MAX/2 and reaches both
    // ends. A reset biased toward the founder's own value would show up here as
    // a mean pulled off centre.
    expect(mean).toBeGreaterThan(GENE_RAW_MAX * 0.49);
    expect(mean).toBeLessThan(GENE_RAW_MAX * 0.51);
    expect(min).toBeLessThan(GENE_RAW_MAX * 0.01);
    expect(max).toBeGreaterThan(GENE_RAW_MAX * 0.99);
  });
});
