import { ANGLE_STEPS, TRIG_SCALE } from "./fixed";

/**
 * Deterministic sin/cos lookup tables (task B02, docs/03 §3).
 *
 * The tables are NOT built with Math.sin/Math.cos: ECMA-262 leaves
 * transcendental functions implementation-approximated, so engines may differ
 * in the last ulp. IEEE-754 basic operations (+, -, *, /) are exactly
 * specified, therefore the quadrant values are computed with a fixed-order
 * Taylor polynomial using only basic operations. The result is bit-identical
 * on every conforming JS engine, and the full table is locked by a golden
 * hash test.
 *
 * Layout: SIN_LUT[h] == round(TRIG_SCALE * sin(2π * h / ANGLE_STEPS)) for
 * h in [0, ANGLE_STEPS). cos(h) is read as sin(h + ANGLE_STEPS/4).
 */

const QUARTER = ANGLE_STEPS / 4; // 1024 steps per quadrant
const HALF_PI = Math.PI / 2; // Math.PI is an exact double constant, not a function call.

/**
 * Taylor polynomial for sin(x), x in [0, π/2], evaluated in a fixed Horner
 * order over x². Truncation error < 1e-11 on the interval — far below the
 * 1/TRIG_SCALE quantization step (~3e-5).
 */
function sinTaylor(x: number): number {
  const x2 = x * x;
  let acc = -1 / 1307674368000; // -1/15!
  acc = acc * x2 + 1 / 6227020800; // +1/13!
  acc = acc * x2 - 1 / 39916800; // -1/11!
  acc = acc * x2 + 1 / 362880; // +1/9!
  acc = acc * x2 - 1 / 5040; // -1/7!
  acc = acc * x2 + 1 / 120; // +1/5!
  acc = acc * x2 - 1 / 6; // -1/3!
  acc = acc * x2 + 1;
  return x * acc;
}

function buildSinLut(): Int16Array {
  const lut = new Int16Array(ANGLE_STEPS);
  for (let h = 0; h < ANGLE_STEPS; h += 1) {
    const quadrant = h >> 10; // 0..3
    const r = h & (QUARTER - 1); // step within quadrant, 0..1023
    // Reduce to the first quadrant via exact symmetries:
    // q0: sin(x), q1: sin(π/2 + x) = sin(π/2 - x), q2: -sin(x), q3: -sin(π/2 - x).
    const rising = (quadrant & 1) === 0;
    const arg = ((rising ? r : QUARTER - r) / QUARTER) * HALF_PI;
    const magnitude = Math.round(TRIG_SCALE * sinTaylor(arg));
    lut[h] = quadrant < 2 ? magnitude : -magnitude;
  }
  return lut;
}

/** Read-only sine table: SIN_LUT[h] in [-TRIG_SCALE, TRIG_SCALE]. */
export const SIN_LUT: Readonly<Int16Array> = buildSinLut();

/** sin(heading) scaled by TRIG_SCALE, heading wrapped by caller into [0, ANGLE_STEPS). */
export function sinLut(steps: number): number {
  return SIN_LUT[steps & (ANGLE_STEPS - 1)] as number;
}

/** cos(heading) scaled by TRIG_SCALE — sine table shifted a quarter turn. */
export function cosLut(steps: number): number {
  return SIN_LUT[(steps + QUARTER) & (ANGLE_STEPS - 1)] as number;
}
