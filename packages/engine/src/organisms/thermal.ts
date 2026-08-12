import { Q, absInt } from "../math/fixed";

/**
 * Thermal stress (docs/04 §8), shared by sensing and metabolism so the number
 * an organism feels and the number that bills it can never drift apart.
 *
 * ```text
 * delta  = |localTemp - optimum|
 * excess = max(0, delta - tolerance)
 * stress = clamp(excess / max(tolerance, minimum), 0, 2)
 * ```
 *
 * Returned in Q units, so the range is `[0, 2Q]`: 0 inside tolerance, Q at
 * "one whole tolerance width beyond tolerance", 2Q at the capped worst case.
 *
 * The divisor floor exists because tolerance is genetic and may be near zero;
 * without it a cold-blooded specialist would divide by zero rather than simply
 * suffer.
 */
export function thermalStressQ(
  temperatureCentiC: number,
  optimumCentiC: number,
  toleranceCentiC: number,
  minToleranceCentiC: number,
): number {
  const delta = absInt(temperatureCentiC - optimumCentiC);
  const excess = delta - toleranceCentiC;
  if (excess <= 0) {
    return 0;
  }
  const divisor = Math.max(toleranceCentiC, minToleranceCentiC);
  const stress = Math.trunc((excess * Q) / divisor);
  return stress > 2 * Q ? 2 * Q : stress;
}

/**
 * Stress level at which thermal damage begins.
 *
 * "Severe excess causes health damage" (docs/04 §8) needs a threshold, and
 * this is it: damage starts once the excess equals a whole tolerance width and
 * rises linearly to the configured maximum at the 2Q cap. Below it, thermal
 * stress only raises the basal cost.
 */
export const SEVERE_THERMAL_STRESS_Q = Q;
