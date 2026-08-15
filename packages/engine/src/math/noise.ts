import { Q, clampQ, lerpQ, qmul } from "./fixed";

/**
 * Deterministic integer value noise (task C02, docs/03 §15).
 *
 * Project-owned lattice noise: every lattice point's value comes from an
 * integer hash of (seed, salt, ix, iy), and samples between lattice points are
 * bilinearly interpolated with smoothstep weights. Everything is integer math
 * in Q units, so results are bit-identical on every platform — the same
 * requirement that made the trig LUT integer-only.
 *
 * `salt` separates independent noise fields drawn from one world seed
 * (elevation octaves, moisture, temperature, fertility), so they do not
 * correlate and none of them consumes the authoritative PRNG.
 */

/**
 * Distinct salts for the independent fields generated from one world seed.
 *
 * Elevation carries ONE base salt: `layeredNoiseQ` derives a distinct salt per
 * octave from it internally, so there are no per-octave entries here — listing
 * them suggested a mapping that never existed (foundation-gate ADR §7).
 */
export const NOISE_SALT = {
  elevationOctave0: 0x00000101,
  moisture: 0x00000201,
  temperature: 0x00000301,
  fertility: 0x00000401,
} as const;

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Value at one lattice point, in [0, Q].
 *
 * Lattice coordinates are mixed one at a time so that neighbouring points —
 * which differ by 1 in a single coordinate — produce unrelated values.
 */
export function latticeValueQ(seed: number, salt: number, ix: number, iy: number): number {
  let h = fmix32((seed ^ salt) >>> 0);
  h = fmix32((h ^ (ix | 0)) >>> 0);
  h = fmix32((h ^ (iy | 0)) >>> 0);
  // Q is a power of two, so masking is an unbiased map into [0, Q-1];
  // the +1 range is closed at Q by construction of the interpolation instead.
  return h & (Q - 1);
}

/**
 * Smoothstep 3t² − 2t³ in Q units, for t in [0, Q].
 * Exact at both ends: s(0) = 0, s(Q) = Q.
 */
export function smoothstepQ(tQ: number): number {
  const t = clampQ(tQ);
  const t2 = qmul(t, t);
  return qmul(t2, 3 * Q - 2 * t);
}

/**
 * Sample the value-noise field at integer grid coordinates (gx, gy) with the
 * given wavelength in grid cells. Returns [0, Q].
 *
 * `wavelengthCells` must be a positive power of two so the lattice divides the
 * grid exactly and the fractional position is an exact Q value.
 */
export function valueNoiseQ(
  seed: number,
  salt: number,
  gx: number,
  gy: number,
  wavelengthCells: number,
): number {
  const ix = Math.floor(gx / wavelengthCells);
  const iy = Math.floor(gy / wavelengthCells);

  // Fractional position inside the lattice cell, scaled to [0, Q).
  const fx = Math.trunc(((gx - ix * wavelengthCells) * Q) / wavelengthCells);
  const fy = Math.trunc(((gy - iy * wavelengthCells) * Q) / wavelengthCells);

  const u = smoothstepQ(fx);
  const v = smoothstepQ(fy);

  const v00 = latticeValueQ(seed, salt, ix, iy);
  const v10 = latticeValueQ(seed, salt, ix + 1, iy);
  const v01 = latticeValueQ(seed, salt, ix, iy + 1);
  const v11 = latticeValueQ(seed, salt, ix + 1, iy + 1);

  const top = lerpQ(v00, v10, u);
  const bottom = lerpQ(v01, v11, u);
  return clampQ(lerpQ(top, bottom, v));
}

/** One octave of a layered noise field. */
export interface NoiseOctave {
  /** Wavelength in grid cells; must be a positive power of two. */
  wavelengthCells: number;
  /** Q-scaled weight. Weights across all octaves should sum to Q. */
  weightQ: number;
}

/**
 * Weighted sum of value-noise octaves, in [0, Q].
 *
 * With weights summing to Q the result stays in range without a final rescale,
 * which keeps the mapping from raw noise to elevation exactly as configured.
 */
export function layeredNoiseQ(
  seed: number,
  baseSalt: number,
  gx: number,
  gy: number,
  octaves: readonly NoiseOctave[],
): number {
  let sum = 0;
  for (let i = 0; i < octaves.length; i += 1) {
    const octave = octaves[i] as NoiseOctave;
    // Each octave gets its own lattice so octaves are independent, not merely
    // rescaled copies of one field.
    const salt = (baseSalt + i * 0x9e37) >>> 0;
    sum += qmul(valueNoiseQ(seed, salt, gx, gy, octave.wavelengthCells), octave.weightQ);
  }
  return clampQ(sum);
}
