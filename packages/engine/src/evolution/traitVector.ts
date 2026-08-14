import { assert, type DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, qmul } from "../math/fixed";
import type { PhenotypeStore } from "../organisms/phenotype";

/**
 * Ecological trait vector for species detection (docs/05 §§3–4, task I02).
 *
 * Species are detected from persistent PHENOTYPE divergence, never from raw
 * neural weights and never from hue (docs/05 §3 excludes both: weights are a
 * hundred-dimensional space where distance means nothing ecological, and hue is
 * cosmetic by definition). The fifteen dimensions below are exactly the docs'
 * list, in the docs' order.
 *
 * Every dimension is normalized onto `[0, Q]` by its configured phenotype
 * range, so one dimension cannot dominate the distance just because its native
 * unit is large (ticks vs. Q fractions vs. sub-units). Where the phenotype is
 * an *effective* value — speed after the armor penalty, turn after the size
 * penalty — the normalization floor is the smallest effective value any genome
 * can produce, so the whole `[0, Q]` band remains reachable.
 *
 * The definition is versioned (docs/05 §3): any change to the dimension list,
 * their order, or the normalization is a TRAIT_VECTOR_VERSION bump and, because
 * centroids are authoritative state, an ENGINE_VERSION bump as well.
 */
export const TRAIT_VECTOR_VERSION = 1;

/** Trait dimension indices (docs/05 §3 order). */
export const TraitDim = {
  AdultSize: 0,
  EffectiveMaxSpeed: 1,
  Acceleration: 2,
  Turn: 3,
  VisionRange: 4,
  VisionFov: 5,
  Diet: 6,
  Attack: 7,
  Armor: 8,
  MetabolicPace: 9,
  ThermalOptimum: 10,
  ThermalTolerance: 11,
  Maturity: 12,
  MaxAge: 13,
  OffspringInvestment: 14,
} as const;

export type TraitDim = (typeof TraitDim)[keyof typeof TraitDim];

/** Number of trait dimensions. Storage layout contract for centroids/scratch. */
export const TRAIT_DIMENSIONS = 15;

/** Human-readable dimension names, indexed by TraitDim. Diagnostics and DTOs. */
export const TRAIT_DIM_NAMES: readonly string[] = [
  "adultSize",
  "effectiveMaxSpeed",
  "acceleration",
  "turn",
  "visionRange",
  "visionFov",
  "diet",
  "attack",
  "armor",
  "metabolicPace",
  "thermalOptimum",
  "thermalTolerance",
  "maturity",
  "maxAge",
  "offspringInvestment",
] as const;

/**
 * Per-dimension normalization ranges, derived once from the frozen config.
 *
 * Derived state on the same footing as the phenotype cache: a pure function of
 * the config, rebuilt at construction and restore, never hashed or serialized.
 */
export interface TraitRanges {
  /** Minimum native value per dimension. */
  readonly min: Int32Array;
  /** `max - min` per dimension; always positive. */
  readonly span: Int32Array;
}

/** Build the normalization table from the authoritative config. */
export function buildTraitRanges(config: DeepReadonly<SimulationConfig>): TraitRanges {
  const r = config.organism.geneRanges;
  const movement = config.organism.movement;

  const min = new Int32Array(TRAIT_DIMENSIONS);
  const max = new Int32Array(TRAIT_DIMENSIONS);

  min[TraitDim.AdultSize] = r.adultRadiusMinPos;
  max[TraitDim.AdultSize] = r.adultRadiusMaxPos;

  // Effective speed floor: the slowest genome at full armor. The ceiling stays
  // the unpenalized maximum, which zero-armor genomes genuinely reach.
  min[TraitDim.EffectiveMaxSpeed] = qmul(r.maxSpeedMinVel, Q - movement.armorMaxSpeedPenaltyQ);
  max[TraitDim.EffectiveMaxSpeed] = r.maxSpeedMaxVel;

  min[TraitDim.Acceleration] = r.accelerationMinVel;
  max[TraitDim.Acceleration] = r.accelerationMaxVel;

  // Effective turn floor: the stiffest genome at full size penalty.
  min[TraitDim.Turn] = qmul(r.maxTurnMinSteps, Q - movement.sizeMaxTurnPenaltyQ);
  max[TraitDim.Turn] = r.maxTurnMaxSteps;

  min[TraitDim.VisionRange] = r.visionRangeMinPos;
  max[TraitDim.VisionRange] = r.visionRangeMaxPos;

  // The phenotype caches the HALF field of view (the visibility test bound).
  min[TraitDim.VisionFov] = r.visionFovMinSteps >> 1;
  max[TraitDim.VisionFov] = r.visionFovMaxSteps >> 1;

  min[TraitDim.Diet] = -Q;
  max[TraitDim.Diet] = Q;

  min[TraitDim.Attack] = 0;
  max[TraitDim.Attack] = Q;

  min[TraitDim.Armor] = 0;
  max[TraitDim.Armor] = Q;

  min[TraitDim.MetabolicPace] = r.metabolicPaceMinQ;
  max[TraitDim.MetabolicPace] = r.metabolicPaceMaxQ;

  min[TraitDim.ThermalOptimum] = r.thermalOptimumMinCentiC;
  max[TraitDim.ThermalOptimum] = r.thermalOptimumMaxCentiC;

  min[TraitDim.ThermalTolerance] = r.thermalToleranceMinCentiC;
  max[TraitDim.ThermalTolerance] = r.thermalToleranceMaxCentiC;

  min[TraitDim.Maturity] = r.maturityAgeMinTicks;
  max[TraitDim.Maturity] = r.maturityAgeMaxTicks;

  min[TraitDim.MaxAge] = r.maxAgeMinTicks;
  max[TraitDim.MaxAge] = r.maxAgeMaxTicks;

  min[TraitDim.OffspringInvestment] = r.offspringInvestmentMinQ;
  max[TraitDim.OffspringInvestment] = r.offspringInvestmentMaxQ;

  const span = new Int32Array(TRAIT_DIMENSIONS);
  for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
    const s = (max[d] as number) - (min[d] as number);
    assert(s > 0, `trait dimension ${d} has a non-positive range ${s}; config was not validated`);
    span[d] = s;
  }
  return { min, span };
}

/** Normalize one native value into `[0, Q]` against a dimension's range. */
function normalizeTrait(value: number, min: number, span: number): number {
  return clamp(Math.trunc(((value - min) * Q) / span), 0, Q);
}

/**
 * Write one organism's normalized trait vector into `out` at `outOffset`.
 *
 * Reads the derived phenotype cache, so it costs fifteen integer
 * normalizations and no gene mapping. Deterministic: same genome + config
 * always produces the same vector.
 */
export function writeTraitVector(
  out: Int32Array,
  outOffset: number,
  phenotypes: PhenotypeStore,
  slot: number,
  ranges: TraitRanges,
): void {
  const { min, span } = ranges;
  out[outOffset + TraitDim.AdultSize] = normalizeTrait(
    phenotypes.adultRadiusPos[slot] as number,
    min[TraitDim.AdultSize] as number,
    span[TraitDim.AdultSize] as number,
  );
  out[outOffset + TraitDim.EffectiveMaxSpeed] = normalizeTrait(
    phenotypes.maxSpeedVel[slot] as number,
    min[TraitDim.EffectiveMaxSpeed] as number,
    span[TraitDim.EffectiveMaxSpeed] as number,
  );
  out[outOffset + TraitDim.Acceleration] = normalizeTrait(
    phenotypes.accelerationVel[slot] as number,
    min[TraitDim.Acceleration] as number,
    span[TraitDim.Acceleration] as number,
  );
  out[outOffset + TraitDim.Turn] = normalizeTrait(
    phenotypes.maxTurnSteps[slot] as number,
    min[TraitDim.Turn] as number,
    span[TraitDim.Turn] as number,
  );
  out[outOffset + TraitDim.VisionRange] = normalizeTrait(
    phenotypes.visionRangePos[slot] as number,
    min[TraitDim.VisionRange] as number,
    span[TraitDim.VisionRange] as number,
  );
  out[outOffset + TraitDim.VisionFov] = normalizeTrait(
    phenotypes.visionHalfFovSteps[slot] as number,
    min[TraitDim.VisionFov] as number,
    span[TraitDim.VisionFov] as number,
  );
  out[outOffset + TraitDim.Diet] = normalizeTrait(
    phenotypes.dietQ[slot] as number,
    min[TraitDim.Diet] as number,
    span[TraitDim.Diet] as number,
  );
  out[outOffset + TraitDim.Attack] = normalizeTrait(
    phenotypes.attackQ[slot] as number,
    min[TraitDim.Attack] as number,
    span[TraitDim.Attack] as number,
  );
  out[outOffset + TraitDim.Armor] = normalizeTrait(
    phenotypes.armorQ[slot] as number,
    min[TraitDim.Armor] as number,
    span[TraitDim.Armor] as number,
  );
  out[outOffset + TraitDim.MetabolicPace] = normalizeTrait(
    phenotypes.metabolicPaceQ[slot] as number,
    min[TraitDim.MetabolicPace] as number,
    span[TraitDim.MetabolicPace] as number,
  );
  out[outOffset + TraitDim.ThermalOptimum] = normalizeTrait(
    phenotypes.thermalOptimumCentiC[slot] as number,
    min[TraitDim.ThermalOptimum] as number,
    span[TraitDim.ThermalOptimum] as number,
  );
  out[outOffset + TraitDim.ThermalTolerance] = normalizeTrait(
    phenotypes.thermalToleranceCentiC[slot] as number,
    min[TraitDim.ThermalTolerance] as number,
    span[TraitDim.ThermalTolerance] as number,
  );
  out[outOffset + TraitDim.Maturity] = normalizeTrait(
    phenotypes.maturityAgeTicks[slot] as number,
    min[TraitDim.Maturity] as number,
    span[TraitDim.Maturity] as number,
  );
  out[outOffset + TraitDim.MaxAge] = normalizeTrait(
    phenotypes.maxAgeTicks[slot] as number,
    min[TraitDim.MaxAge] as number,
    span[TraitDim.MaxAge] as number,
  );
  out[outOffset + TraitDim.OffspringInvestment] = normalizeTrait(
    phenotypes.offspringInvestmentQ[slot] as number,
    min[TraitDim.OffspringInvestment] as number,
    span[TraitDim.OffspringInvestment] as number,
  );
}

/**
 * Sum of squared per-dimension differences between two trait vectors.
 *
 * This is the docs/05 §4 weighted Euclidean squared distance with the v0.1
 * equal weights, WITHOUT the `/ Σw` normalization: comparisons against
 * thresholds multiply the threshold by {@link TRAIT_DIMENSIONS} instead, so no
 * division ever truncates a comparison (see {@link rmsThresholdSumSq}).
 *
 * Exact in doubles: each squared difference is at most Q² ≈ 1.7e7 and fifteen
 * of them sum far below 2^53.
 */
export function traitDistanceSumSq(
  a: Int32Array,
  aOffset: number,
  b: Int32Array,
  bOffset: number,
): number {
  let sum = 0;
  for (let d = 0; d < TRAIT_DIMENSIONS; d += 1) {
    const delta = (a[aOffset + d] as number) - (b[bOffset + d] as number);
    sum += delta * delta;
  }
  return sum;
}

/**
 * Convert a normalized RMS distance threshold (Q units, e.g.
 * `species.splitDistanceThresholdQ`) into the equivalent sum-of-squares bound:
 * `RMS(a,b) >= t  <=>  ΣΔ² >= t² * TRAIT_DIMENSIONS`. Integer-exact.
 */
export function rmsThresholdSumSq(thresholdQ: number): number {
  return thresholdQ * thresholdQ * TRAIT_DIMENSIONS;
}
