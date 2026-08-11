/**
 * Fixed-point helpers (task B01).
 *
 * Authoritative hot state uses integer fixed-point (docs/03 §3, docs/08 §1):
 * - Q            — normalized fraction scale: 1.0 == 4096;
 * - POS_SCALE    — world position sub-units per logical unit (LU): 12.5 LU == 3200;
 * - ANGLE_STEPS  — headings per full turn: 0..4095;
 * - TRIG_SCALE   — sin/cos LUT amplitude: 1.0 == 32767.
 *
 * Rounding policy (docs/08 §9 "round/floor consistently"): every division in
 * these helpers truncates toward zero (`Math.trunc` semantics), including for
 * negative operands. All helpers assume |a*b| stays well below
 * Number.MAX_SAFE_INTEGER (2^53); callers keep operands within documented
 * ranges (positions ≤ 2^20 sub-units, Q values ≤ 2^13, energies ≤ 2^31).
 */

export const Q = 4096;
export const POS_SCALE = 256;
export const ANGLE_STEPS = 4096;
export const TRIG_SCALE = 32767;

/** Multiply two Q-scaled values: (a*b)/Q, truncated toward zero. */
export function qmul(a: number, b: number): number {
  // `+ 0` canonicalizes IEEE -0 (possible out of Math.trunc) to +0 so results
  // are always canonical integers.
  return Math.trunc((a * b) / Q) + 0;
}

/** Divide two Q-scaled values: (a*Q)/b, truncated toward zero. b must be nonzero. */
export function qdiv(a: number, b: number): number {
  return Math.trunc((a * Q) / b) + 0;
}

/** Clamp an integer into [lo, hi]. */
export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Clamp into the normalized Q range [0, Q]. */
export function clampQ(value: number): number {
  return clamp(value, 0, Q);
}

/** Clamp into the signed Q range [-Q, Q]. */
export function clampSignedQ(value: number): number {
  return clamp(value, -Q, Q);
}

/**
 * Linear interpolation between integers a and b by tQ in [0, Q].
 * lerpQ(a, b, 0) === a exactly; lerpQ(a, b, Q) === b exactly.
 */
export function lerpQ(a: number, b: number, tQ: number): number {
  return a + Math.trunc(((b - a) * tQ) / Q) + 0;
}

/** Squared Euclidean distance between two integer points. */
export function distSq(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy;
}

/** Absolute value for integers (Math.abs is exact for integers; alias for clarity). */
export function absInt(value: number): number {
  return value < 0 ? -value : value;
}
