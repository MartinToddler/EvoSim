import { Q, clampQ, qmul } from "./fixed";

/**
 * Deterministic integer square root and fractional powers (Milestone 3).
 *
 * `Math.sqrt` and `**` are implementation-approximated by ECMA-262, exactly
 * like `Math.sin` (see the trig LUT rationale in ADR 0001 §2), so authoritative
 * code cannot use them: a last-bit difference between platforms would fork a
 * world. Everything here is built from integer arithmetic and IEEE-754 basic
 * operations, which are exactly specified.
 *
 * Both functions run at spawn time (phenotype derivation) and in the movement
 * phase (velocity magnitudes), so they are written to be cheap: the initial
 * square-root guess comes from a bit-length estimate rather than from a fixed
 * number of halving steps.
 */

/**
 * Largest integer `r` with `r * r <= value`.
 *
 * Precondition: `value` is a non-negative number below 2^52, so that the final
 * correction loop's `x * x` stays exact. Callers in the engine work with
 * squared world distances (< 2^41) and squared Q values (< 2^26).
 */
export function isqrt(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  const n = Math.floor(value);
  if (n < 4) {
    return 1;
  }

  // Initial guess 2^ceil(bits/2) >= sqrt(n). Built by doubling rather than with
  // `2 ** k`, which is implementation-approximated.
  const high = Math.floor(n / 4294967296);
  const bits = high > 0 ? 64 - Math.clz32(high) : 32 - Math.clz32(n);
  let x = 1;
  for (let i = 0, halfBits = (bits + 1) >> 1; i < halfBits; i += 1) {
    x *= 2;
  }

  // Integer Newton iteration, monotonically decreasing from an upper bound.
  for (;;) {
    const next = Math.floor((x + Math.floor(n / x)) / 2);
    if (next >= x) {
      break;
    }
    x = next;
  }

  // `Math.floor(n / x)` can be one off when the quotient lands just under an
  // integer, so the result is corrected explicitly. Both loops run at most once.
  while (x > 0 && x * x > n) {
    x -= 1;
  }
  while ((x + 1) * (x + 1) <= n) {
    x += 1;
  }
  return x;
}

/**
 * Square root of a Q-scaled value in [0, Q], returned in Q.
 *
 * sqrt(a/Q) * Q === sqrt(a * Q), so one integer square root suffices.
 */
export function qsqrt(aQ: number): number {
  return isqrt(clampQ(aQ) * Q);
}

/**
 * `xQ ^ expQ` for a normalized base in [0, Q] and a non-negative Q-scaled
 * exponent, returned in Q.
 *
 * The integer part of the exponent is applied by repeated multiplication; the
 * fractional part is decomposed into binary digits and applied with successive
 * square roots (x^(1/2), x^(1/4), …). Twelve digits exhaust the Q resolution.
 *
 * The result is an approximation with a small downward bias — each qmul
 * truncates — bounded by well under 1% of Q over the range the gene mappings
 * use. It is exact at the endpoints (0 and Q) and monotone in `xQ`, which is
 * what the mappings require. Determinism, not analytical precision, is the
 * point: the gene exponents are tuning hypotheses (docs/08 §7).
 */
export function powQ(xQ: number, expQ: number): number {
  const x = clampQ(xQ);
  if (expQ <= 0) {
    return Q;
  }
  if (x === 0) {
    return 0;
  }

  let result = Q;
  const whole = Math.floor(expQ / Q);
  for (let i = 0; i < whole; i += 1) {
    result = qmul(result, x);
  }

  const frac = expQ - whole * Q;
  if (frac > 0) {
    let root = x;
    for (let bit = Q >> 1; bit >= 1; bit >>= 1) {
      root = qsqrt(root);
      if ((frac & bit) !== 0) {
        result = qmul(result, root);
      }
    }
  }
  return result;
}
