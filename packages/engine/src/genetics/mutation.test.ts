import { describe, expect, it } from "vitest";
import { createFounderTopology } from "../brain/founderTopology";
import { BRAIN_WEIGHT_COUNT } from "../brain/BrainLayout";
import { createFounderBrainWeights } from "../brain/founderBrain";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { StateHash, HASH_TAG } from "../math/hash";
import { Q } from "../math/fixed";
import { GenomeStore } from "../organisms/GenomeStore";
import { Xoshiro128 } from "../random/Xoshiro128";
import goldenMutation from "../fixtures/mutationGolden.json";
import { CONFIG_SCHEMA_VERSION, ENGINE_VERSION } from "../version";
import { createFounderMorphGenes } from "../morphology/founderMorphGenome";
import { createFounderGenes } from "./founderGenome";
import { GENE_COUNT, GENE_RAW_MAX } from "./genes";
import {
  MutationClass,
  classifyGeneRoll,
  classifyWeightRoll,
  geneDeltaRaw,
  mutateBrainWeights,
  mutateEcologicalGenes,
  mutateGenome,
} from "./mutation";

const ECOLOGICAL = DEFAULT_CONFIG.mutation.ecological;
const BRAIN = DEFAULT_CONFIG.mutation.brain;

/** Digest of a weight block, so a fixture can pin 400 values in one string. */
function weightDigest(weights: Int16Array): string {
  const hasher = new StateHash();
  hasher.array(HASH_TAG.i16, weights);
  return hasher.digest();
}

describe("mutation class partition", () => {
  it("maps the roll intervals onto reset, large, small and none in order", () => {
    const reset = ECOLOGICAL.resetProbabilityQ;
    const large = ECOLOGICAL.largeMutationProbabilityQ;
    const small = ECOLOGICAL.perGeneMutationProbabilityQ;

    expect(classifyGeneRoll(0, ECOLOGICAL)).toBe(MutationClass.Reset);
    expect(classifyGeneRoll(reset - 1, ECOLOGICAL)).toBe(MutationClass.Reset);
    expect(classifyGeneRoll(reset, ECOLOGICAL)).toBe(MutationClass.Large);
    expect(classifyGeneRoll(reset + large - 1, ECOLOGICAL)).toBe(MutationClass.Large);
    expect(classifyGeneRoll(reset + large, ECOLOGICAL)).toBe(MutationClass.Small);
    expect(classifyGeneRoll(reset + large + small - 1, ECOLOGICAL)).toBe(MutationClass.Small);
    expect(classifyGeneRoll(reset + large + small, ECOLOGICAL)).toBe(MutationClass.None);
    expect(classifyGeneRoll(Q - 1, ECOLOGICAL)).toBe(MutationClass.None);
  });

  it("gives each gene class exactly its configured marginal probability", () => {
    // Counted over the whole roll domain rather than sampled: the partition is
    // deterministic, so the exact count IS the probability numerator.
    const counts = new Array<number>(4).fill(0);
    for (let roll = 0; roll < Q; roll += 1) {
      const kind = classifyGeneRoll(roll, ECOLOGICAL);
      counts[kind] = (counts[kind] as number) + 1;
    }
    expect(counts[MutationClass.Reset]).toBe(ECOLOGICAL.resetProbabilityQ);
    expect(counts[MutationClass.Large]).toBe(ECOLOGICAL.largeMutationProbabilityQ);
    expect(counts[MutationClass.Small]).toBe(ECOLOGICAL.perGeneMutationProbabilityQ);
    expect(counts[MutationClass.None]).toBe(
      Q -
        ECOLOGICAL.resetProbabilityQ -
        ECOLOGICAL.largeMutationProbabilityQ -
        ECOLOGICAL.perGeneMutationProbabilityQ,
    );
  });

  it("never resets a brain weight and gives its two classes their exact shares", () => {
    const counts = new Array<number>(4).fill(0);
    for (let roll = 0; roll < Q; roll += 1) {
      const kind = classifyWeightRoll(roll, BRAIN);
      counts[kind] = (counts[kind] as number) + 1;
    }
    expect(counts[MutationClass.Reset]).toBe(0);
    expect(counts[MutationClass.Large]).toBe(BRAIN.largeWeightMutationProbabilityQ);
    expect(counts[MutationClass.Small]).toBe(BRAIN.perWeightMutationProbabilityQ);
  });
});

describe("geneDeltaRaw", () => {
  it("scales a normalized sigma onto the raw gene span", () => {
    // A +1σ normal sample at sigma 0.025 should move a gene by ~2.5% of its span.
    expect(geneDeltaRaw(Q, ECOLOGICAL.smallSigmaQ)).toBe(
      Math.trunc((Q * ECOLOGICAL.smallSigmaQ * GENE_RAW_MAX) / (Q * Q)),
    );
    expect(geneDeltaRaw(Q, ECOLOGICAL.smallSigmaQ)).toBeCloseTo(GENE_RAW_MAX * 0.025, -2);
    expect(geneDeltaRaw(Q, ECOLOGICAL.largeSigmaQ)).toBeCloseTo(GENE_RAW_MAX * 0.15, -2);
  });

  it("is sign-symmetric and zero for a zero sigma or a zero sample", () => {
    expect(geneDeltaRaw(-Q, ECOLOGICAL.smallSigmaQ)).toBe(-geneDeltaRaw(Q, ECOLOGICAL.smallSigmaQ));
    expect(geneDeltaRaw(0, ECOLOGICAL.largeSigmaQ)).toBe(0);
    expect(geneDeltaRaw(6 * Q, 0)).toBe(0);
  });

  it("stays exact at the extreme the approx-normal sampler can reach", () => {
    // ±6Q is the Irwin-Hall range; the product must stay far below 2^53.
    const extreme = geneDeltaRaw(6 * Q, Q);
    expect(Number.isSafeInteger(extreme)).toBe(true);
    expect(extreme).toBe(6 * GENE_RAW_MAX);
  });
});

describe("mutateEcologicalGenes", () => {
  it("changes nothing when every probability is zero", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.ecological.perGeneMutationProbabilityQ = 0;
    config.mutation.ecological.largeMutationProbabilityQ = 0;
    config.mutation.ecological.resetProbabilityQ = 0;

    const genes = createFounderGenes();
    const before = Uint16Array.from(genes);
    mutateEcologicalGenes(genes, 0, Xoshiro128.fromSeed(7), config);
    expect(genes).toEqual(before);
  });

  it("keeps every gene inside the stored range even under an extreme sigma", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    // Mutate every gene, every time, as hard as the schema permits.
    config.mutation.ecological.perGeneMutationProbabilityQ = Q;
    config.mutation.ecological.largeMutationProbabilityQ = 0;
    config.mutation.ecological.resetProbabilityQ = 0;
    config.mutation.ecological.smallSigmaQ = Q;
    config.mutation.ecological.largeSigmaQ = Q;

    const rng = Xoshiro128.fromSeed(0x5eed);
    const genes = createFounderGenes();
    for (let generation = 0; generation < 500; generation += 1) {
      mutateEcologicalGenes(genes, 0, rng, config);
      for (let i = 0; i < GENE_COUNT; i += 1) {
        const value = genes[i] as number;
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(GENE_RAW_MAX);
      }
    }
  });

  it("resets a gene to a fresh uniform draw over the whole range", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.ecological.resetProbabilityQ = Q;

    const rng = Xoshiro128.fromSeed(11);
    const seen = new Set<number>();
    let min = GENE_RAW_MAX;
    let max = 0;
    for (let generation = 0; generation < 200; generation += 1) {
      const genes = createFounderGenes();
      mutateEcologicalGenes(genes, 0, rng, config);
      for (let i = 0; i < GENE_COUNT; i += 1) {
        const value = genes[i] as number;
        seen.add(value);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    // A reset reaches far beyond the founder's mid-range values in both
    // directions; a nudge could not.
    expect(seen.size).toBeGreaterThan(3000);
    expect(min).toBeLessThan(GENE_RAW_MAX * 0.01);
    expect(max).toBeGreaterThan(GENE_RAW_MAX * 0.99);
  });

  it("only touches the gene block it was given", () => {
    const genomes = new GenomeStore(4);
    const genes = createFounderGenes();
    const morphGenes = createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology);
    genomes.writeGenome(
      1,
      genes,
      morphGenes,
      createFounderTopology(),
      createFounderBrainWeights(4096, -8192, 8192),
    );
    genomes.writeGenome(
      2,
      genes,
      morphGenes,
      createFounderTopology(),
      createFounderBrainWeights(4096, -8192, 8192),
    );
    const neighbourBefore = Uint16Array.from(
      genomes.genes.subarray(genomes.geneOffset(2), genomes.geneOffset(2) + GENE_COUNT),
    );

    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.ecological.perGeneMutationProbabilityQ = Q;
    mutateEcologicalGenes(genomes.genes, genomes.geneOffset(1), Xoshiro128.fromSeed(3), config);

    expect(
      genomes.genes.subarray(genomes.geneOffset(2), genomes.geneOffset(2) + GENE_COUNT),
    ).toEqual(neighbourBefore);
  });
});

describe("mutateBrainWeights", () => {
  it("changes nothing when every probability is zero", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.brain.perWeightMutationProbabilityQ = 0;
    config.mutation.brain.largeWeightMutationProbabilityQ = 0;

    const weights = createFounderBrainWeights(
      DEFAULT_CONFIG.brain.weightScale,
      DEFAULT_CONFIG.brain.weightMin,
      DEFAULT_CONFIG.brain.weightMax,
    );
    const before = Int16Array.from(weights);
    mutateBrainWeights(weights, 0, Xoshiro128.fromSeed(19), config);
    expect(weights).toEqual(before);
  });

  it("clamps to the configured symmetric weight bound under sustained drift", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.brain.perWeightMutationProbabilityQ = Q;
    config.mutation.brain.weightSmallSigmaQ = 8192;
    config.mutation.brain.weightLargeSigmaQ = 8192;

    const rng = Xoshiro128.fromSeed(0xb00c);
    const weights = new Int16Array(BRAIN_WEIGHT_COUNT);
    let sawMin = false;
    let sawMax = false;
    for (let generation = 0; generation < 400; generation += 1) {
      mutateBrainWeights(weights, 0, rng, config);
      for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
        const value = weights[i] as number;
        expect(value).toBeGreaterThanOrEqual(DEFAULT_CONFIG.brain.weightMin);
        expect(value).toBeLessThanOrEqual(DEFAULT_CONFIG.brain.weightMax);
        if (value === DEFAULT_CONFIG.brain.weightMin) sawMin = true;
        if (value === DEFAULT_CONFIG.brain.weightMax) sawMax = true;
      }
    }
    // A random walk this wide must actually reach both bounds, or the clamp
    // assertion above would be vacuous.
    expect({ sawMin, sawMax }).toEqual({ sawMin: true, sawMax: true });
  });

  it("mutates about 2% of the 400 weights per birth at the default rate", () => {
    const rng = Xoshiro128.fromSeed(0x4242);
    const base = createFounderBrainWeights(
      DEFAULT_CONFIG.brain.weightScale,
      DEFAULT_CONFIG.brain.weightMin,
      DEFAULT_CONFIG.brain.weightMax,
    );

    let changed = 0;
    const births = 200;
    for (let birth = 0; birth < births; birth += 1) {
      const weights = Int16Array.from(base);
      mutateBrainWeights(weights, 0, rng, DEFAULT_CONFIG);
      for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
        if (weights[i] !== base[i]) changed += 1;
      }
    }
    // docs/04 §18: "At 400 weights, 2% ~ 8 changed weights/birth". Zero deltas
    // are possible, so the observed mean sits slightly below the nominal 8.
    const perBirth = changed / births;
    expect(perBirth).toBeGreaterThan(6);
    expect(perBirth).toBeLessThan(10);
  });
});

/**
 * Mutation golden fixture (task E03/E04, docs/07 §2 "Genome: deterministic
 * mutation" and "Brain: mutation").
 *
 * Pins the exact result of mutating the founder genome with a fixed PRNG seed.
 * This is the tripwire for any change to the draw order, the interval partition,
 * the sigma scaling or the clamp: all of them would silently produce a different
 * evolutionary history, and none of them would be caught by a range assertion.
 *
 * Regenerating these values is an ENGINE_VERSION event.
 */
describe("mutation golden fixture", () => {
  it("belongs to the current engine and config schema version", () => {
    expect(goldenMutation.engineVersion).toBe(ENGINE_VERSION);
    expect(goldenMutation.configSchemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("reproduces the recorded genes and brain digest after 50 successive births", () => {
    const rng = Xoshiro128.fromSeed(Number.parseInt(goldenMutation.seedHex, 16));
    const genomes = new GenomeStore(1);
    genomes.writeGenome(
      0,
      createFounderGenes(),
      createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology),
      createFounderTopology(),
      createFounderBrainWeights(
        DEFAULT_CONFIG.brain.weightScale,
        DEFAULT_CONFIG.brain.weightMin,
        DEFAULT_CONFIG.brain.weightMax,
      ),
    );

    // Mutating the same block 50 times models a 50-generation lineage: each
    // birth inherits the previous mutant, exactly as the engine does.
    for (let generation = 0; generation < goldenMutation.generations; generation += 1) {
      mutateGenome(genomes, 0, rng, DEFAULT_CONFIG);
    }

    expect([...genomes.genes]).toEqual(goldenMutation.genes);
    expect([...genomes.morphGenes]).toEqual(goldenMutation.morphGenes);
    expect([...genomes.topology]).toEqual(goldenMutation.topology);
    expect(weightDigest(genomes.brainWeights)).toBe(goldenMutation.brainWeightDigest);
    expect(rng.serializeState()).toEqual(goldenMutation.rngStateAfter);
  });

  it("consumes exactly the recorded number of PRNG words per birth", () => {
    // The draw count is part of the stream: if mutation started drawing a
    // different number of words, every world would diverge from the tick of its
    // first birth. Counted by comparing against a reference generator advanced
    // by hand.
    const seed = Number.parseInt(goldenMutation.seedHex, 16);
    const mutating = Xoshiro128.fromSeed(seed);
    const genomes = new GenomeStore(1);
    genomes.writeGenome(
      0,
      createFounderGenes(),
      createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology),
      createFounderTopology(),
      createFounderBrainWeights(
        DEFAULT_CONFIG.brain.weightScale,
        DEFAULT_CONFIG.brain.weightMin,
        DEFAULT_CONFIG.brain.weightMax,
      ),
    );
    mutateGenome(genomes, 0, mutating, DEFAULT_CONFIG);

    const counting = Xoshiro128.fromSeed(seed);
    for (let i = 0; i < goldenMutation.firstBirthPrngWords; i += 1) {
      counting.nextU32();
    }
    expect(counting.serializeState()).toEqual(mutating.serializeState());
  });
});
