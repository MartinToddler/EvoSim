import type { DeepReadonly } from "@eon/shared";
import type { GeneRangeConfig, SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, lerpQ, qmul } from "../math/fixed";
import { powQ } from "../math/isqrt";

/**
 * The 16-gene ecological genome (docs/04 §2, task D02).
 *
 * Genes are stored quantized as Uint16 (`0 … GENE_RAW_MAX`) and converted to a
 * normalized `geneQ` in `[0, Q]` before any mapping, exactly as docs/08 §7
 * prescribes. Only `diet` is signed, and only after conversion: it is stored
 * unsigned like every other gene and mapped onto `[-Q, +Q]` by
 * {@link dietSignedQ}.
 *
 * The index order below is a storage contract. Reordering it changes every
 * genome layout, every snapshot and every world hash.
 */
export const Gene = {
  AdultSize: 0,
  MaxSpeed: 1,
  Acceleration: 2,
  TurnRate: 3,
  VisionRange: 4,
  VisionFov: 5,
  AttackPower: 6,
  Armor: 7,
  MetabolicPace: 8,
  ThermalOptimum: 9,
  ThermalTolerance: 10,
  MaturityAge: 11,
  MaxAge: 12,
  OffspringInvestment: 13,
  Hue: 14,
  /**
   * Processing ability for each resource channel, **contiguous and in
   * `Resource` order** (M17). `Gene.Process + resource` is the locus for
   * channel `resource`, which is what lets the feeding phase loop over channels
   * without a switch — and a switch on resource identity is exactly the shape
   * ADR 0027 forbids.
   *
   * This replaces the single signed `diet` locus. One axis could only ever
   * express a trade between two foods; with six loci a lineage can be good at
   * any subset, and what stops "good at everything" is the digestive upkeep in
   * `phenotype.ts`, not a constraint on the genome.
   */
  Process: 15,
  /**
   * Resistance to chemically defended growth (M17).
   *
   * Its own locus rather than a seventh processing gene, because it does a
   * different job: processing decides how much energy a unit yields, resistance
   * decides how much health it costs. A lineage can evolve to tolerate the
   * damage without getting better at extracting the energy, or the reverse, and
   * those are genuinely different strategies.
   */
  ToxinResistance: 21,
} as const;

export type Gene = (typeof Gene)[keyof typeof Gene];

/** Number of ecological genes per organism. */
export const GENE_COUNT = 22;

/** Human-readable gene names, indexed by gene value. Diagnostics and DTOs. */
export const GENE_NAMES: readonly string[] = [
  "adultSize",
  "maxSpeed",
  "acceleration",
  "turnRate",
  "visionRange",
  "visionFov",
  "attackPower",
  "armor",
  "metabolicPace",
  "thermalOptimum",
  "thermalTolerance",
  "maturityAge",
  "maxAge",
  "offspringInvestment",
  "hue",
  "processFoliage",
  "processBrowse",
  "processFruit",
  "processRoots",
  "processDefended",
  "processMeat",
  "toxinResistance",
];

/** Maximum stored gene value; genes occupy the whole Uint16 range. */
export const GENE_RAW_MAX = 65535;

/** Hue is expressed in whole degrees around the colour circle (docs/04 §3). */
export const HUE_DEGREES = 360;

/**
 * Normalize a stored gene to `[0, Q]`.
 *
 * `raw * (Q + 1) >>> 16` is exact, monotone, and reaches both endpoints:
 * raw 0 → 0 and raw 65535 → Q. A plain `raw * Q / 65535` would need a division
 * and would not be exactly invertible.
 */
export function geneToQ(raw: number): number {
  return (clamp(Math.trunc(raw), 0, GENE_RAW_MAX) * (Q + 1)) >>> 16;
}

/**
 * Right inverse of {@link geneToQ}: the smallest stored value that normalizes
 * to `valueQ`. Round-trips exactly for every `valueQ` in `[0, Q]`.
 *
 * `geneToQ` floors `raw * (Q + 1) / 2^16`, so the inverse must CEIL
 * `valueQ * 2^16 / (Q + 1)`. Scaling by `GENE_RAW_MAX / Q` instead looks
 * natural and is wrong by one step at most values — 65535/4096 is 15.99975,
 * not 16 — which would quietly shift a founder gene one quantum down.
 */
export function geneFromQ(valueQ: number): number {
  const numerator = clamp(Math.trunc(valueQ), 0, Q) * 65536;
  const divisor = Q + 1;
  const quotient = Math.floor(numerator / divisor);
  const raw = quotient * divisor < numerator ? quotient + 1 : quotient;
  return clamp(raw, 0, GENE_RAW_MAX);
}

/**
 * Digestion efficiency for a diet affinity (docs/03 §24).
 *
 * `efficiency = floor + span * affinity²` gives specialists a real advantage
 * while leaving generalists a floor, from ONE signed gene — two independently
 * maximizable digestion genes would have no trade-off at all.
 */
export function digestionEfficiencyQ(affinityQ: number, floorQ: number, spanQ: number): number {
  const affinity = clamp(affinityQ, 0, Q);
  return floorQ + qmul(spanQ, qmul(affinity, affinity));
}

/**
 * Nonlinear interpolation `min + (max - min) * geneQ^exponent`.
 *
 * The exponent makes the mapping's response uneven on purpose (docs/08 §7):
 * with an exponent above 1, most of the gene range produces modest values and
 * the extreme is genuinely expensive to reach.
 */
function lerpPowQ(minValue: number, maxValue: number, geneQ: number, exponentQ: number): number {
  return lerpQ(minValue, maxValue, powQ(geneQ, exponentQ));
}

/** Adult body radius in world sub-units (docs/04 §3). */
export function adultRadiusPos(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpPowQ(
    ranges.adultRadiusMinPos,
    ranges.adultRadiusMaxPos,
    geneQ,
    ranges.adultRadiusExponentQ,
  );
}

/** Genetic maximum speed in velocity units, before the armor penalty. */
export function geneMaxSpeedVel(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpPowQ(ranges.maxSpeedMinVel, ranges.maxSpeedMaxVel, geneQ, ranges.maxSpeedExponentQ);
}

/** Acceleration in velocity units per tick. */
export function accelerationVel(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.accelerationMinVel, ranges.accelerationMaxVel, geneQ);
}

/** Maximum turn per tick in heading steps, before the size penalty. */
export function geneMaxTurnSteps(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.maxTurnMinSteps, ranges.maxTurnMaxSteps, geneQ);
}

/** Vision range in world sub-units. */
export function visionRangePos(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpPowQ(
    ranges.visionRangeMinPos,
    ranges.visionRangeMaxPos,
    geneQ,
    ranges.visionRangeExponentQ,
  );
}

/** Total field of view in heading steps. */
export function visionFovSteps(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.visionFovMinSteps, ranges.visionFovMaxSteps, geneQ);
}

/** Metabolic pace multiplier in Q (0.65 … 1.45 by default). */
export function metabolicPaceQ(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.metabolicPaceMinQ, ranges.metabolicPaceMaxQ, geneQ);
}

/** Preferred temperature in hundredths of °C. */
export function thermalOptimumCentiC(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.thermalOptimumMinCentiC, ranges.thermalOptimumMaxCentiC, geneQ);
}

/** Thermal tolerance half-width in hundredths of °C. */
export function thermalToleranceCentiC(
  geneQ: number,
  ranges: DeepReadonly<GeneRangeConfig>,
): number {
  return lerpQ(ranges.thermalToleranceMinCentiC, ranges.thermalToleranceMaxCentiC, geneQ);
}

/** Age at maturity in ticks. */
export function maturityAgeTicks(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.maturityAgeMinTicks, ranges.maturityAgeMaxTicks, geneQ);
}

/** Hard maximum age in ticks (docs/04 §22: MVP old age is a deterministic cap). */
export function maxAgeTicks(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.maxAgeMinTicks, ranges.maxAgeMaxTicks, geneQ);
}

/** Offspring investment as a Q fraction of the parent's maximum energy. */
export function offspringInvestmentQ(geneQ: number, ranges: DeepReadonly<GeneRangeConfig>): number {
  return lerpQ(ranges.offspringInvestmentMinQ, ranges.offspringInvestmentMaxQ, geneQ);
}

/** Hue in whole degrees `[0, 360)`. Cosmetic in MVP (docs/04 §3). */
export function hueDegrees(geneQ: number): number {
  return Math.trunc((clamp(geneQ, 0, Q) * HUE_DEGREES) / Q) % HUE_DEGREES;
}

/**
 * Effective maximum speed after the armor penalty (docs/04 §3):
 * `geneMaxSpeed * (1 - armorMaxSpeedPenalty * armor)`.
 *
 * Armor is not free: it is the trade-off that stops maximum armor from being
 * a strictly dominant strategy.
 */
export function effectiveMaxSpeedVel(
  geneSpeedVel: number,
  armorQ: number,
  config: DeepReadonly<SimulationConfig>,
): number {
  const penaltyQ = qmul(config.organism.movement.armorMaxSpeedPenaltyQ, armorQ);
  return qmul(geneSpeedVel, Q - penaltyQ);
}

/**
 * Effective maximum turn after the size penalty (docs/04 §3):
 * `geneMaxTurn * (1 - sizeMaxTurnPenalty * sizeNorm)`.
 */
export function effectiveMaxTurnSteps(
  geneTurnSteps: number,
  sizeGeneQ: number,
  config: DeepReadonly<SimulationConfig>,
): number {
  const penaltyQ = qmul(config.organism.movement.sizeMaxTurnPenaltyQ, sizeGeneQ);
  return qmul(geneTurnSteps, Q - penaltyQ);
}
