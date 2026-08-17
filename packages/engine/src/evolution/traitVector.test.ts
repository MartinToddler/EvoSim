import { PLANT_RESOURCE_COUNT, Resource } from "../world/resources";
import { GENE_COUNT } from "../genetics/genes";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Gene } from "../genetics/genes";
import { Q } from "../math/fixed";
import { createTestWorld, spawnTestOrganism } from "../testing/harness";
import {
  TRAIT_DIMENSIONS,
  TRAIT_DIM_NAMES,
  TraitDim,
  buildTraitRanges,
  rmsThresholdSumSq,
  traitDistanceSumSq,
  writeTraitVector,
} from "./traitVector";

/**
 * Trait vector definition tests (docs/05 §§3–4, task I02).
 */

describe("trait ranges", () => {
  it("every dimension has a positive span under the default config", () => {
    const ranges = buildTraitRanges(DEFAULT_CONFIG);
    for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
      expect(ranges.span[d]).toBeGreaterThan(0);
    }
  });

  it("a validator-accepted min==max range becomes a constant dimension, not a crash (M8 review)", () => {
    // "Fix this trait" is a legitimate experiment config: the validator accepts
    // min == max, every organism shares the value, and the frozen dimension
    // must contribute exactly zero to every distance.
    const world = createTestWorld({
      configure: (config) => {
        config.organism.geneRanges.adultRadiusMaxPos = config.organism.geneRanges.adultRadiusMinPos;
      },
    });
    const small = spawnTestOrganism(world, {
      xPos: 5000,
      yPos: 5000,
      silentBrain: true,
      genesQ: { [Gene.AdultSize]: 0 },
    });
    const large = spawnTestOrganism(world, {
      xPos: 6000,
      yPos: 6000,
      silentBrain: true,
      genesQ: { [Gene.AdultSize]: Q },
    });

    const out = new Int32Array(2 * TRAIT_DIMENSIONS);
    writeTraitVector(out, 0, world.ctx.phenotypes, small, world.ctx.traitRanges);
    writeTraitVector(out, TRAIT_DIMENSIONS, world.ctx.phenotypes, large, world.ctx.traitRanges);
    expect(out[TraitDim.AdultSize]).toBe(0);
    expect(out[TRAIT_DIMENSIONS + TraitDim.AdultSize]).toBe(0);
  });

  it("has exactly the documented fifteen dimensions, named", () => {
    expect(TRAIT_DIMENSIONS).toBe(15);
    expect(TRAIT_DIM_NAMES).toHaveLength(15);
    expect(TRAIT_DIM_NAMES[TraitDim.Diet]).toBe("diet");
    expect(TRAIT_DIM_NAMES).not.toContain("hue");
  });
});

describe("writeTraitVector", () => {
  it("normalizes gene extremes onto the [0, Q] band", () => {
    const world = createTestWorld();
    const low = spawnTestOrganism(world, {
      xPos: 5000,
      yPos: 5000,
      silentBrain: true,
      genesQ: Object.fromEntries(Array.from({ length: GENE_COUNT }, (_, gene) => [gene, 0])),
    });
    const high = spawnTestOrganism(world, {
      xPos: 6000,
      yPos: 6000,
      silentBrain: true,
      genesQ: Object.fromEntries(Array.from({ length: GENE_COUNT }, (_, gene) => [gene, Q])),
    });

    const out = new Int32Array(2 * TRAIT_DIMENSIONS);
    writeTraitVector(out, 0, world.ctx.phenotypes, low, world.ctx.traitRanges);
    writeTraitVector(out, TRAIT_DIMENSIONS, world.ctx.phenotypes, high, world.ctx.traitRanges);

    for (let d = 0; d < 2 * TRAIT_DIMENSIONS; d += 1) {
      expect(out[d]).toBeGreaterThanOrEqual(0);
      expect(out[d]).toBeLessThanOrEqual(Q);
    }
    // All-zero genes floor every dimension except the effective ones, which
    // sit at their own floor by construction; all-max genes reach the top of
    // each band except where a penalty (armor on speed, size on turn) applies.
    expect(out[TraitDim.AdultSize]).toBe(0);
    expect(out[TRAIT_DIMENSIONS + TraitDim.AdultSize]).toBe(Q);
    expect(out[TraitDim.Attack]).toBe(0);
    expect(out[TRAIT_DIMENSIONS + TraitDim.Attack]).toBe(Q);
    // Diet is deliberately NOT in that list. Since M17 it is a CONTRAST — meat
    // processing against the best plant channel — so moving every locus the
    // same way leaves it at the midpoint by construction, and an all-zero and
    // an all-maximum genome are both exactly diet-neutral. Driving it to its
    // ends means putting the loci in opposition, which is the next test.
    expect(out[TraitDim.Diet]).toBe(Q >> 1);
    expect(out[TRAIT_DIMENSIONS + TraitDim.Diet]).toBe(Q >> 1);
  });

  it("puts the diet dimension at its ends only when the loci disagree", () => {
    const plantLoci = (valueQ: number): Record<number, number> =>
      Object.fromEntries(
        Array.from({ length: PLANT_RESOURCE_COUNT }, (_, resource) => [
          Gene.Process + resource,
          valueQ,
        ]),
      );
    const world = createTestWorld();
    const plantSpecialist = spawnTestOrganism(world, {
      xPos: 5000,
      yPos: 5000,
      silentBrain: true,
      // Every plant locus, not just foliage: diet contrasts meat against the
      // BEST plant channel, so a locus left at its founder value sets the
      // baseline and the contrast never reaches its end.
      genesQ: { ...plantLoci(Q), [Gene.Process + Resource.Meat]: 0 },
    });
    const meatSpecialist = spawnTestOrganism(world, {
      xPos: 6000,
      yPos: 6000,
      silentBrain: true,
      genesQ: { ...plantLoci(0), [Gene.Process + Resource.Meat]: Q },
    });

    const out = new Int32Array(2 * TRAIT_DIMENSIONS);
    writeTraitVector(out, 0, world.ctx.phenotypes, plantSpecialist, world.ctx.traitRanges);
    writeTraitVector(
      out,
      TRAIT_DIMENSIONS,
      world.ctx.phenotypes,
      meatSpecialist,
      world.ctx.traitRanges,
    );

    expect(out[TraitDim.Diet]).toBe(0);
    expect(out[TRAIT_DIMENSIONS + TraitDim.Diet]).toBe(Q);
  });

  it("excludes hue: two organisms differing only in hue have distance zero", () => {
    const world = createTestWorld();
    const a = spawnTestOrganism(world, {
      xPos: 5000,
      yPos: 5000,
      silentBrain: true,
      genesQ: { [Gene.Hue]: 0 },
    });
    const b = spawnTestOrganism(world, {
      xPos: 6000,
      yPos: 6000,
      silentBrain: true,
      genesQ: { [Gene.Hue]: Q },
    });

    const out = new Int32Array(2 * TRAIT_DIMENSIONS);
    writeTraitVector(out, 0, world.ctx.phenotypes, a, world.ctx.traitRanges);
    writeTraitVector(out, TRAIT_DIMENSIONS, world.ctx.phenotypes, b, world.ctx.traitRanges);
    expect(traitDistanceSumSq(out, 0, out, TRAIT_DIMENSIONS)).toBe(0);
  });
});

describe("distance and thresholds", () => {
  it("is symmetric, zero on identity, and exact in integers", () => {
    const a = new Int32Array(TRAIT_DIMENSIONS);
    const b = new Int32Array(TRAIT_DIMENSIONS);
    a[0] = 100;
    b[1] = 250;
    expect(traitDistanceSumSq(a, 0, a, 0)).toBe(0);
    expect(traitDistanceSumSq(a, 0, b, 0)).toBe(100 * 100 + 250 * 250);
    expect(traitDistanceSumSq(a, 0, b, 0)).toBe(traitDistanceSumSq(b, 0, a, 0));
  });

  it("rmsThresholdSumSq matches the docs/05 §4 normalization exactly", () => {
    // RMS(a, b) >= t  <=>  sum >= t² * 15. For a single-axis displacement of
    // exactly t * sqrt(15)… integers cannot express that, so verify both sides
    // of the boundary instead.
    const t = DEFAULT_CONFIG.species.splitDistanceThresholdQ;
    const bound = rmsThresholdSumSq(t);
    expect(bound).toBe(t * t * TRAIT_DIMENSIONS);
    const a = new Int32Array(TRAIT_DIMENSIONS);
    const b = new Int32Array(TRAIT_DIMENSIONS);
    b.fill(t); // every dimension exactly t apart -> RMS exactly t
    expect(traitDistanceSumSq(a, 0, b, 0)).toBe(bound);
    b[0] = t - 1;
    expect(traitDistanceSumSq(a, 0, b, 0)).toBeLessThan(bound);
  });
});
