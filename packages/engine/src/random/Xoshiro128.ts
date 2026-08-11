import { assert } from "@eon/shared";
import { Q } from "../math/fixed";

/**
 * Project-owned deterministic PRNG (tasks B03/B04, docs/03 §4).
 *
 * Algorithm: xoshiro128** (Blackman & Vigna), a 32-bit generator with 128-bit
 * state. State is seeded from a single uint32 seed through four rounds of
 * splitmix32 so that similar seeds produce unrelated streams. The exact output
 * sequence is locked by golden vector tests; changing either algorithm or
 * seeding is an engine-version-bump event.
 *
 * Inside authoritative simulation code this class is the ONLY source of
 * randomness (never Math.random — CLAUDE.md hard rules).
 */

const ALL_ZERO_FALLBACK = 0x9e3779b9;

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** One splitmix32 round: advances a 32-bit state and returns a mixed output. */
export function splitmix32(state: number): { state: number; value: number } {
  const next = (state + 0x9e3779b9) >>> 0;
  let z = next;
  z ^= z >>> 16;
  z = Math.imul(z, 0x21f0aaad) >>> 0;
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97) >>> 0;
  z ^= z >>> 15;
  return { state: next, value: z >>> 0 };
}

/** Serialized PRNG state: exactly the four xoshiro words. */
export type Xoshiro128State = readonly [number, number, number, number];

export class Xoshiro128 {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  private constructor() {
    // Use fromSeed / fromState.
  }

  /** Create a generator from a 32-bit seed (any JS integer; coerced with >>> 0). */
  static fromSeed(seed: number): Xoshiro128 {
    const rng = new Xoshiro128();
    let sm = seed >>> 0;
    const words: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const round = splitmix32(sm);
      sm = round.state;
      words.push(round.value);
    }
    rng.s0 = words[0] as number;
    rng.s1 = words[1] as number;
    rng.s2 = words[2] as number;
    rng.s3 = words[3] as number;
    if ((rng.s0 | rng.s1 | rng.s2 | rng.s3) === 0) {
      // xoshiro must never sit in the all-zero state; deterministic fallback.
      rng.s0 = ALL_ZERO_FALLBACK;
    }
    return rng;
  }

  /** Restore a generator from serialized state. */
  static fromState(state: Xoshiro128State): Xoshiro128 {
    const rng = new Xoshiro128();
    rng.restoreState(state);
    return rng;
  }

  /** Next uniform uint32 in [0, 2^32). */
  nextU32(): number {
    const s1 = this.s1;
    const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ s1) >>> 0;
    this.s1 = (s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl32(this.s3, 11);

    return result;
  }

  /**
   * Next uniform integer in [0, maxExclusive). Unbiased via rejection
   * sampling; maxExclusive must be an integer in [1, 2^32 - 1].
   */
  nextInt(maxExclusive: number): number {
    assert(
      Number.isInteger(maxExclusive) && maxExclusive >= 1 && maxExclusive <= 0xffffffff,
      `nextInt maxExclusive out of range: ${maxExclusive}`,
    );
    // threshold = 2^32 mod maxExclusive; doubles are exact for these magnitudes.
    const threshold = (4294967296 - maxExclusive) % maxExclusive;
    for (;;) {
      const r = this.nextU32();
      if (r >= threshold) {
        return r % maxExclusive;
      }
    }
  }

  /** Next uniform Q fraction in [0, Q). Suitable for `nextQ() < probabilityQ` checks. */
  nextQ(): number {
    // Q is a power of two, so masking the scrambled output is unbiased.
    return this.nextU32() & (Q - 1);
  }

  /** Next uniform signed Q value in [-Q, +Q] inclusive. */
  nextSignedQ(): number {
    return this.nextInt(2 * Q + 1) - Q;
  }

  /**
   * Approximate normal sample via Irwin–Hall (docs/03 §4): the sum of 12
   * uniforms on [0, Q] recentred to mean 0. One standard deviation ≈ Q, so
   * callers scale with qmul(approxNormalQ(), sigmaQ). Range [-6Q, +6Q]. No
   * transcendental math involved.
   */
  approxNormalQ(): number {
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += this.nextInt(Q + 1);
    }
    return sum - 6 * Q;
  }

  /** Snapshot the exact generator state (four uint32 words). */
  serializeState(): Xoshiro128State {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Restore exact generator state previously produced by serializeState(). */
  restoreState(state: Xoshiro128State): void {
    assert(state.length === 4, "PRNG state must have exactly 4 words");
    for (const word of state) {
      assert(
        Number.isInteger(word) && word >= 0 && word <= 0xffffffff,
        `PRNG state word out of uint32 range: ${word}`,
      );
    }
    assert((state[0] | state[1] | state[2] | state[3]) !== 0, "PRNG state must not be all zero");
    this.s0 = state[0];
    this.s1 = state[1];
    this.s2 = state[2];
    this.s3 = state[3];
  }
}
