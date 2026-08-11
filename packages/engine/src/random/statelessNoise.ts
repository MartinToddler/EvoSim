import { Q } from "../math/fixed";

/**
 * Stateless hash noise (docs/03 §4, docs/04 §16).
 *
 * Deterministic function of (seed, entityId, tick) for per-entity sensory
 * noise, so that querying or rendering never advances the global PRNG and
 * per-entity noise stays independent of iteration order. Mixing uses the
 * murmur3 finalizer (fmix32) chained over the three inputs.
 */

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Uniform uint32 noise word for (seed, entityId, tick). */
export function statelessNoiseU32(seed: number, entityId: number, tick: number): number {
  const a = fmix32(seed >>> 0);
  const b = fmix32((a ^ (entityId >>> 0)) >>> 0);
  return fmix32((b ^ (tick >>> 0)) >>> 0);
}

/**
 * Uniform signed Q noise in [-Q, Q-1] for (seed, entityId, tick).
 * The 8192-value range is a power of two, keeping the mapping bias-free.
 */
export function statelessNoiseSignedQ(seed: number, entityId: number, tick: number): number {
  return (statelessNoiseU32(seed, entityId, tick) & (2 * Q - 1)) - Q;
}
