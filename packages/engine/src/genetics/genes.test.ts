import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q } from "../math/fixed";
import {
  GENE_COUNT,
  GENE_NAMES,
  GENE_RAW_MAX,
  Gene,
  accelerationVel,
  adultRadiusPos,
  carnivoreAffinityQ,
  dietSignedQ,
  digestionEfficiencyQ,
  effectiveMaxSpeedVel,
  effectiveMaxTurnSteps,
  geneFromQ,
  geneMaxSpeedVel,
  geneMaxTurnSteps,
  geneToQ,
  herbivoreAffinityQ,
  hueDegrees,
  maturityAgeTicks,
  maxAgeTicks,
  metabolicPaceQ,
  offspringInvestmentQ,
  thermalOptimumCentiC,
  thermalToleranceCentiC,
  visionFovSteps,
  visionRangePos,
} from "./genes";

const ranges = DEFAULT_CONFIG.organism.geneRanges;

/** Every mapping as (name, fn, min, max), so bounds can be checked uniformly. */
const MAPPINGS: readonly [string, (geneQ: number) => number, number, number][] = [
  [
    "adultRadius",
    (g) => adultRadiusPos(g, ranges),
    ranges.adultRadiusMinPos,
    ranges.adultRadiusMaxPos,
  ],
  ["maxSpeed", (g) => geneMaxSpeedVel(g, ranges), ranges.maxSpeedMinVel, ranges.maxSpeedMaxVel],
  [
    "acceleration",
    (g) => accelerationVel(g, ranges),
    ranges.accelerationMinVel,
    ranges.accelerationMaxVel,
  ],
  ["maxTurn", (g) => geneMaxTurnSteps(g, ranges), ranges.maxTurnMinSteps, ranges.maxTurnMaxSteps],
  [
    "visionRange",
    (g) => visionRangePos(g, ranges),
    ranges.visionRangeMinPos,
    ranges.visionRangeMaxPos,
  ],
  [
    "visionFov",
    (g) => visionFovSteps(g, ranges),
    ranges.visionFovMinSteps,
    ranges.visionFovMaxSteps,
  ],
  [
    "metabolicPace",
    (g) => metabolicPaceQ(g, ranges),
    ranges.metabolicPaceMinQ,
    ranges.metabolicPaceMaxQ,
  ],
  [
    "thermalOptimum",
    (g) => thermalOptimumCentiC(g, ranges),
    ranges.thermalOptimumMinCentiC,
    ranges.thermalOptimumMaxCentiC,
  ],
  [
    "thermalTolerance",
    (g) => thermalToleranceCentiC(g, ranges),
    ranges.thermalToleranceMinCentiC,
    ranges.thermalToleranceMaxCentiC,
  ],
  [
    "maturityAge",
    (g) => maturityAgeTicks(g, ranges),
    ranges.maturityAgeMinTicks,
    ranges.maturityAgeMaxTicks,
  ],
  ["maxAge", (g) => maxAgeTicks(g, ranges), ranges.maxAgeMinTicks, ranges.maxAgeMaxTicks],
  [
    "offspringInvestment",
    (g) => offspringInvestmentQ(g, ranges),
    ranges.offspringInvestmentMinQ,
    ranges.offspringInvestmentMaxQ,
  ],
];

describe("gene quantization", () => {
  it("normalizes the stored range onto [0, Q] and hits both endpoints", () => {
    expect(geneToQ(0)).toBe(0);
    expect(geneToQ(GENE_RAW_MAX)).toBe(Q);
  });

  it("is monotone across the whole stored range", () => {
    let previous = -1;
    for (let raw = 0; raw <= GENE_RAW_MAX; raw += 7) {
      const value = geneToQ(raw);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(Q);
      previous = value;
    }
  });

  it("round-trips every normalized value exactly", () => {
    for (let valueQ = 0; valueQ <= Q; valueQ += 1) {
      expect(geneToQ(geneFromQ(valueQ))).toBe(valueQ);
    }
  });

  it("clamps out-of-range stored values instead of wrapping", () => {
    expect(geneToQ(-5)).toBe(0);
    expect(geneToQ(1e9)).toBe(Q);
    expect(geneFromQ(-1)).toBe(0);
    // geneFromQ returns the SMALLEST stored value that normalizes to the
    // target, so the top of the range is not GENE_RAW_MAX itself.
    expect(geneFromQ(Q + 1000)).toBe(geneFromQ(Q));
    expect(geneToQ(geneFromQ(Q + 1000))).toBe(Q);
    expect(geneFromQ(Q)).toBeLessThanOrEqual(GENE_RAW_MAX);
  });

  it("names every gene exactly once", () => {
    expect(GENE_NAMES).toHaveLength(GENE_COUNT);
    expect(new Set(GENE_NAMES).size).toBe(GENE_COUNT);
    expect(Object.keys(Gene)).toHaveLength(GENE_COUNT);
  });
});

describe("gene to phenotype mappings", () => {
  it("stays inside its configured range for every gene value", () => {
    for (const [name, map, min, max] of MAPPINGS) {
      for (let geneQ = 0; geneQ <= Q; geneQ += 1) {
        const value = map(geneQ);
        expect(`${name}@${geneQ}:${value >= min && value <= max}`).toBe(`${name}@${geneQ}:true`);
      }
    }
  });

  it("is exact at both endpoints", () => {
    for (const [name, map, min, max] of MAPPINGS) {
      expect(`${name}:${map(0)}`).toBe(`${name}:${min}`);
      expect(`${name}:${map(Q)}`).toBe(`${name}:${max}`);
    }
  });

  it("is monotone non-decreasing in the gene", () => {
    for (const [name, map] of MAPPINGS) {
      let previous = -Infinity;
      for (let geneQ = 0; geneQ <= Q; geneQ += 1) {
        const value = map(geneQ);
        expect(`${name}@${geneQ}:${value >= previous}`).toBe(`${name}@${geneQ}:true`);
        previous = value;
      }
    }
  });

  it("applies the documented nonlinear exponents rather than a straight line", () => {
    // With an exponent above 1, the midpoint sits below the linear midpoint:
    // most of the gene range buys modest values and the extreme is expensive.
    const midLinear = (ranges.adultRadiusMinPos + ranges.adultRadiusMaxPos) / 2;
    expect(adultRadiusPos(Q / 2, ranges)).toBeLessThan(midLinear);
    expect(geneMaxSpeedVel(Q / 2, ranges)).toBeLessThan(
      (ranges.maxSpeedMinVel + ranges.maxSpeedMaxVel) / 2,
    );
    expect(visionRangePos(Q / 2, ranges)).toBeLessThan(
      (ranges.visionRangeMinPos + ranges.visionRangeMaxPos) / 2,
    );
    // Acceleration is specified as a plain linear range.
    expect(accelerationVel(Q / 2, ranges)).toBe(
      ranges.accelerationMinVel +
        Math.trunc((ranges.accelerationMaxVel - ranges.accelerationMinVel) / 2),
    );
  });

  it("maps hue onto whole degrees inside the colour circle", () => {
    expect(hueDegrees(0)).toBe(0);
    expect(hueDegrees(Q)).toBe(0); // 360° wraps to 0°
    for (let geneQ = 0; geneQ <= Q; geneQ += 1) {
      const hue = hueDegrees(geneQ);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("diet trade-off", () => {
  it("maps the stored gene onto a signed [-Q, Q] axis", () => {
    expect(dietSignedQ(0)).toBe(-Q);
    expect(dietSignedQ(GENE_RAW_MAX)).toBe(Q);
    expect(dietSignedQ(geneFromQ(Q / 2))).toBe(0);
  });

  it("keeps the two affinities complementary, so specialization must be paid for", () => {
    for (let dietQ = -Q; dietQ <= Q; dietQ += 64) {
      const herb = herbivoreAffinityQ(dietQ);
      const carn = carnivoreAffinityQ(dietQ);
      expect(herb + carn).toBe(Q);
      expect(herb).toBeGreaterThanOrEqual(0);
      expect(carn).toBeGreaterThanOrEqual(0);
    }
  });

  it("gives specialists an advantage over a generalist floor", () => {
    const { digestionEfficiencyFloorQ, digestionEfficiencySpanQ } = DEFAULT_CONFIG.organism.feeding;
    const efficiency = (affinity: number): number =>
      digestionEfficiencyQ(affinity, digestionEfficiencyFloorQ, digestionEfficiencySpanQ);

    expect(efficiency(0)).toBe(digestionEfficiencyFloorQ);
    expect(efficiency(Q)).toBe(digestionEfficiencyFloorQ + digestionEfficiencySpanQ);
    // Squared affinity: a generalist gets far less than half the specialist's
    // efficiency, which is what stops "eat everything well" from dominating.
    const generalist = efficiency(Q / 2);
    const specialist = efficiency(Q);
    expect(generalist).toBeLessThan(specialist / 2);
    expect(generalist).toBeGreaterThan(digestionEfficiencyFloorQ);
  });
});

describe("capability penalties", () => {
  it("makes armor cost top speed", () => {
    const base = geneMaxSpeedVel(Q, ranges);
    expect(effectiveMaxSpeedVel(base, 0, DEFAULT_CONFIG)).toBe(base);
    const armored = effectiveMaxSpeedVel(base, Q, DEFAULT_CONFIG);
    expect(armored).toBeLessThan(base);
    // 0.35 penalty at full armor (docs/08 §11).
    expect(armored).toBeCloseTo(base * (1 - 0.35), -1);
  });

  it("makes size cost turn rate", () => {
    const base = geneMaxTurnSteps(Q, ranges);
    expect(effectiveMaxTurnSteps(base, 0, DEFAULT_CONFIG)).toBe(base);
    const large = effectiveMaxTurnSteps(base, Q, DEFAULT_CONFIG);
    expect(large).toBeLessThan(base);
    expect(large).toBeCloseTo(base * (1 - 0.25), -1);
  });

  it("never lets a penalty reach zero capability", () => {
    expect(effectiveMaxSpeedVel(geneMaxSpeedVel(0, ranges), Q, DEFAULT_CONFIG)).toBeGreaterThan(0);
    expect(effectiveMaxTurnSteps(geneMaxTurnSteps(0, ranges), Q, DEFAULT_CONFIG)).toBeGreaterThan(
      0,
    );
  });
});
