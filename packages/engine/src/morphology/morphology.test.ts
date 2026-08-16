import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { cloneConfig } from "../config/cloneConfig";
import { validateConfig } from "../config/validateConfig";
import { Q } from "../math/fixed";
import { GenomeStore } from "../organisms/GenomeStore";
import { Xoshiro128 } from "../random/Xoshiro128";
import {
  createFounderMorphGenes,
  FOUNDER_APPENDAGE_PAIRS,
  FOUNDER_SEGMENTS,
} from "./founderMorphGenome";
import { MorphologyStore, deriveMorphology } from "./morphDevelopment";
import {
  MAX_MORPH_APPENDAGE_PAIRS,
  MAX_MORPH_PATTERN_FREQUENCY,
  MAX_MORPH_SEGMENTS,
  MORPH_GENE_COUNT,
  MORPH_GENE_NAMES,
  MORPH_GENE_RAW_MAX,
  MorphGene,
  appendagePairCount,
  isStructuralMorphGene,
  morphGeneFromQ,
  morphGeneToQ,
  segmentCount,
  structuralGeneCount,
  structuralGeneFromCount,
} from "./morphGenes";
import {
  MorphMutationClass,
  classifyMorphRoll,
  mutateMorphologyGenes,
  structuralStep,
} from "./morphMutation";

const MORPHOLOGY = DEFAULT_CONFIG.organism.morphology;

/** A store plus a genome block, sized for a handful of slots. */
function makeGenomes(slots = 4): GenomeStore {
  return new GenomeStore(slots);
}

function developed(genes: Uint16Array, hueDeg = 120): MorphologyStore {
  const genomes = makeGenomes(1);
  genomes.morphGenes.set(genes, genomes.morphOffset(0));
  const store = new MorphologyStore(1);
  deriveMorphology(store, genomes, 0, hueDeg, DEFAULT_CONFIG);
  return store;
}

describe("morphological genome (M14)", () => {
  it("names every gene exactly once", () => {
    expect(MORPH_GENE_NAMES).toHaveLength(MORPH_GENE_COUNT);
    expect(new Set(MORPH_GENE_NAMES).size).toBe(MORPH_GENE_COUNT);
    expect(Object.keys(MorphGene)).toHaveLength(MORPH_GENE_COUNT);
    // Index order is a storage contract; the values must be a dense 0..N-1.
    expect([...Object.values(MorphGene)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: MORPH_GENE_COUNT }, (_, i) => i),
    );
  });

  it("carries no gene named for an animal or an ecological role", () => {
    // ADR 0027 §2a: morphology is a continuous space, not a template chooser.
    const forbidden =
      /wolf|tiger|bug|insect|fish|bird|predator|herbivore|carnivore|grazer|scavenger/i;
    for (const name of MORPH_GENE_NAMES) {
      expect(name).not.toMatch(forbidden);
    }
  });

  it("normalizes and inverts a gene exactly at both endpoints", () => {
    expect(morphGeneToQ(0)).toBe(0);
    expect(morphGeneToQ(MORPH_GENE_RAW_MAX)).toBe(Q);
    for (let valueQ = 0; valueQ <= Q; valueQ += 1) {
      expect(morphGeneToQ(morphGeneFromQ(valueQ))).toBe(valueQ);
    }
  });

  it("reads structural loci as integers covering the whole configured range", () => {
    const seen = new Set<number>();
    for (let valueQ = 0; valueQ <= Q; valueQ += 1) {
      const count = segmentCount(valueQ, MORPHOLOGY);
      expect(count).toBeGreaterThanOrEqual(MORPHOLOGY.minSegments);
      expect(count).toBeLessThanOrEqual(MORPHOLOGY.maxSegments);
      seen.add(count);
    }
    expect(seen.size).toBe(MORPHOLOGY.maxSegments - MORPHOLOGY.minSegments + 1);
  });

  it("places a structural gene in the middle of its bucket, so a nudge cannot flip it", () => {
    for (let count = MORPHOLOGY.minSegments; count <= MORPHOLOGY.maxSegments; count += 1) {
      const raw = structuralGeneFromCount(count, MORPHOLOGY.minSegments, MORPHOLOGY.maxSegments);
      expect(segmentCount(morphGeneToQ(raw), MORPHOLOGY)).toBe(count);
      // A one-percent perturbation in either direction must not change the count.
      const nudge = Math.trunc(MORPH_GENE_RAW_MAX / 100);
      const bucketWidth = Math.trunc(
        MORPH_GENE_RAW_MAX / (MORPHOLOGY.maxSegments - MORPHOLOGY.minSegments + 1),
      );
      expect(nudge).toBeLessThan(bucketWidth / 2);
      expect(
        structuralGeneCount(
          morphGeneToQ(raw + nudge),
          MORPHOLOGY.minSegments,
          MORPHOLOGY.maxSegments,
        ),
      ).toBe(count);
      expect(
        structuralGeneCount(
          morphGeneToQ(Math.max(0, raw - nudge)),
          MORPHOLOGY.minSegments,
          MORPHOLOGY.maxSegments,
        ),
      ).toBe(count);
    }
  });

  it("marks exactly the two integer-valued loci as structural", () => {
    const structural = Array.from({ length: MORPH_GENE_COUNT }, (_, i) => i).filter(
      isStructuralMorphGene,
    );
    expect(structural).toEqual([MorphGene.SegmentCount, MorphGene.AppendagePairs]);
  });
});

describe("developmental interpreter (M14)", () => {
  it("is a pure function of the genome: same genes, same body", () => {
    const genes = createFounderMorphGenes(MORPHOLOGY);
    const a = developed(genes);
    const b = developed(genes);
    for (const key of Object.keys(a) as (keyof MorphologyStore)[]) {
      const left = a[key];
      const right = b[key];
      if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
        expect(Array.from(left as unknown as Uint16Array)).toEqual(
          Array.from(right as unknown as Uint16Array),
        );
      }
    }
  });

  it("develops the founder body the founder genome describes", () => {
    const store = developed(createFounderMorphGenes(MORPHOLOGY));
    expect(store.segmentCount[0]).toBe(FOUNDER_SEGMENTS);
    expect(store.appendagePairs[0]).toBe(FOUNDER_APPENDAGE_PAIRS);
    // Founders are longer than they are wide, so heading is legible.
    expect(store.bodyLengthQ[0] as number).toBeGreaterThan(store.bodyWidthQ[0] as number);
    expect(store.aspectQ[0] as number).toBeGreaterThan(Q);
  });

  it("keeps every field inside its configured bounds for any genome", () => {
    const rng = Xoshiro128.fromSeed(0x4d31_4d31);
    for (let trial = 0; trial < 400; trial += 1) {
      const genes = new Uint16Array(MORPH_GENE_COUNT);
      for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
        genes[i] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      }
      const store = developed(genes, rng.nextInt(360));
      const slot = 0;
      expect(store.bodyLengthQ[slot] as number).toBeGreaterThanOrEqual(MORPHOLOGY.bodyLengthMinQ);
      expect(store.bodyLengthQ[slot] as number).toBeLessThanOrEqual(MORPHOLOGY.bodyLengthMaxQ);
      expect(store.bodyWidthQ[slot] as number).toBeGreaterThanOrEqual(MORPHOLOGY.bodyWidthMinQ);
      expect(store.bodyWidthQ[slot] as number).toBeLessThanOrEqual(MORPHOLOGY.bodyWidthMaxQ);
      expect(store.segmentCount[slot] as number).toBeGreaterThanOrEqual(MORPHOLOGY.minSegments);
      expect(store.segmentCount[slot] as number).toBeLessThanOrEqual(MAX_MORPH_SEGMENTS);
      expect(store.appendagePairs[slot] as number).toBeLessThanOrEqual(MAX_MORPH_APPENDAGE_PAIRS);
      expect(store.patternFrequency[slot] as number).toBeLessThanOrEqual(
        MAX_MORPH_PATTERN_FREQUENCY,
      );
      expect(store.primaryHueDeg[slot] as number).toBeLessThan(360);
      expect(store.secondaryHueDeg[slot] as number).toBeLessThan(360);
      // The silhouette must never reach the declared ceiling, or the renderer's
      // frame would be clipping a body it was sized to contain.
      expect(store.silhouetteLengthQ[slot] as number).toBeLessThan(MORPHOLOGY.maxSilhouetteExtentQ);
      expect(store.silhouetteWidthQ[slot] as number).toBeLessThan(MORPHOLOGY.maxSilhouetteExtentQ);
    }
  });

  it("shifts pigment away from the ecological hue rather than replacing it", () => {
    const genes = createFounderMorphGenes(MORPHOLOGY);
    // The founder's primary shift gene sits at the midpoint, which is zero shift.
    expect(developed(genes, 200).primaryHueDeg[0]).toBe(200);
    expect(developed(genes, 40).primaryHueDeg[0]).toBe(40);
  });

  it("wraps a pigment shift that crosses zero instead of clamping it", () => {
    const genes = createFounderMorphGenes(MORPHOLOGY);
    genes[MorphGene.PigmentPrimaryShift] = 0; // full negative shift
    const hue = developed(genes, 5).primaryHueDeg[0] as number;
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(hue).toBe((5 - MORPHOLOGY.pigmentPrimaryShiftMaxDeg + 360) % 360);
  });
});

describe("morphological mutation (M14)", () => {
  it("partitions one roll into disjoint classes with the configured margins", () => {
    const m = DEFAULT_CONFIG.mutation.morphology;
    const continuous = MorphGene.BodyLength;
    expect(classifyMorphRoll(0, continuous, m)).toBe(MorphMutationClass.Reset);
    expect(classifyMorphRoll(m.resetProbabilityQ, continuous, m)).toBe(MorphMutationClass.Large);
    expect(
      classifyMorphRoll(m.resetProbabilityQ + m.largeMutationProbabilityQ, continuous, m),
    ).toBe(MorphMutationClass.Small);
    expect(classifyMorphRoll(Q - 1, continuous, m)).toBe(MorphMutationClass.None);
  });

  it("gives structural loci a structural class instead of small and large ones", () => {
    const m = DEFAULT_CONFIG.mutation.morphology;
    expect(classifyMorphRoll(m.resetProbabilityQ, MorphGene.SegmentCount, m)).toBe(
      MorphMutationClass.Structural,
    );
    expect(
      classifyMorphRoll(m.resetProbabilityQ + m.structuralProbabilityQ, MorphGene.SegmentCount, m),
    ).toBe(MorphMutationClass.None);
  });

  it("steps a structural locus by exactly one, reflecting at the bounds", () => {
    const atMax = structuralGeneFromCount(
      MORPHOLOGY.maxSegments,
      MORPHOLOGY.minSegments,
      MORPHOLOGY.maxSegments,
    );
    const stepped = structuralStep(MorphGene.SegmentCount, atMax, true, MORPHOLOGY);
    expect(segmentCount(morphGeneToQ(stepped), MORPHOLOGY)).toBe(MORPHOLOGY.maxSegments - 1);

    const atMin = structuralGeneFromCount(
      MORPHOLOGY.minSegments,
      MORPHOLOGY.minSegments,
      MORPHOLOGY.maxSegments,
    );
    const down = structuralStep(MorphGene.SegmentCount, atMin, false, MORPHOLOGY);
    expect(segmentCount(morphGeneToQ(down), MORPHOLOGY)).toBe(MORPHOLOGY.minSegments + 1);

    const middle = structuralGeneFromCount(3, MORPHOLOGY.minSegments, MORPHOLOGY.maxSegments);
    expect(
      segmentCount(
        morphGeneToQ(structuralStep(MorphGene.SegmentCount, middle, true, MORPHOLOGY)),
        MORPHOLOGY,
      ),
    ).toBe(4);
    expect(
      segmentCount(
        morphGeneToQ(structuralStep(MorphGene.SegmentCount, middle, false, MORPHOLOGY)),
        MORPHOLOGY,
      ),
    ).toBe(2);
  });

  it("leaves a structural locus alone when its range has a single value", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.organism.morphology.minSegments = 3;
    config.organism.morphology.maxSegments = 3;
    validateConfig(config);
    const raw = structuralGeneFromCount(3, 3, 3);
    expect(structuralStep(MorphGene.SegmentCount, raw, true, config.organism.morphology)).toBe(raw);
  });

  it("is deterministic: the same seed mutates a genome the same way", () => {
    const runOnce = (): number[] => {
      const genes = createFounderMorphGenes(MORPHOLOGY);
      const rng = Xoshiro128.fromSeed(0x0e0f_1011);
      for (let birth = 0; birth < 200; birth += 1) {
        mutateMorphologyGenes(genes, 0, rng, DEFAULT_CONFIG);
      }
      return [...genes];
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it("never leaves the stored range, however many generations pass", () => {
    const genes = createFounderMorphGenes(MORPHOLOGY);
    const rng = Xoshiro128.fromSeed(0xabcd_1234);
    for (let birth = 0; birth < 5_000; birth += 1) {
      mutateMorphologyGenes(genes, 0, rng, DEFAULT_CONFIG);
    }
    for (const value of genes) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(MORPH_GENE_RAW_MAX);
    }
  });

  it("touches only the block it was given", () => {
    const genomes = makeGenomes(3);
    const founder = createFounderMorphGenes(MORPHOLOGY);
    genomes.morphGenes.set(founder, genomes.morphOffset(1));
    genomes.morphGenes.set(founder, genomes.morphOffset(2));
    const neighbourBefore = [
      ...genomes.morphGenes.subarray(
        genomes.morphOffset(2),
        genomes.morphOffset(2) + MORPH_GENE_COUNT,
      ),
    ];

    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.morphology.perGeneMutationProbabilityQ =
      Q -
      config.mutation.morphology.resetProbabilityQ -
      config.mutation.morphology.largeMutationProbabilityQ;
    validateConfig(config);
    mutateMorphologyGenes(
      genomes.morphGenes,
      genomes.morphOffset(1),
      Xoshiro128.fromSeed(7),
      config,
    );

    expect([
      ...genomes.morphGenes.subarray(
        genomes.morphOffset(2),
        genomes.morphOffset(2) + MORPH_GENE_COUNT,
      ),
    ]).toEqual(neighbourBefore);
  });

  it("reaches both ends of the range over enough generations, so no shape is unreachable", () => {
    // Evolutionary accessibility (CLAUDE.md): a body plan that cannot be
    // reached by ordinary mutation is not part of the search space at all.
    const rng = Xoshiro128.fromSeed(0x5150_0001);
    const sawEveryPairCount = new Set<number>();
    const genes = createFounderMorphGenes(MORPHOLOGY);
    let minLength = MORPH_GENE_RAW_MAX;
    let maxLength = 0;
    for (let birth = 0; birth < 60_000; birth += 1) {
      mutateMorphologyGenes(genes, 0, rng, DEFAULT_CONFIG);
      const length = genes[MorphGene.BodyLength] as number;
      minLength = Math.min(minLength, length);
      maxLength = Math.max(maxLength, length);
      sawEveryPairCount.add(
        appendagePairCount(morphGeneToQ(genes[MorphGene.AppendagePairs] as number), MORPHOLOGY),
      );
    }
    expect(minLength).toBeLessThan(MORPH_GENE_RAW_MAX * 0.1);
    expect(maxLength).toBeGreaterThan(MORPH_GENE_RAW_MAX * 0.9);
    expect(sawEveryPairCount.size).toBe(
      MORPHOLOGY.maxAppendagePairs - MORPHOLOGY.minAppendagePairs + 1,
    );
  });
});
