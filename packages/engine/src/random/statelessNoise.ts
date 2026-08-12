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

/**
 * Odd multiplier used to fold the tick's high bits into the seed round.
 * Any odd constant works; this is the 32-bit golden-ratio constant.
 */
const TICK_HIGH_MIX = 0x9e3779b1;

/**
 * Uniform uint32 noise word for (seed, entityId, tick).
 *
 * `tick` is a JS safe integer, not a uint32, so its high bits are folded into
 * the first mixing round — otherwise the per-entity stream would repeat with a
 * period of 2^32 ticks. The fold happens in the seed round (which is computed
 * anyway) rather than as an extra finalizer, keeping the cost of this hot,
 * per-organism-per-tick function at one extra multiply.
 *
 * For every tick below 2^32 the high word is 0 and the result is bit-identical
 * to the plain three-round mix, so existing golden values remain valid.
 *
 * Precondition: `tick` is a non-negative safe integer. The engine guarantees
 * this at the only place ticks are produced (SimulationEngine.step), so this
 * hot path deliberately does not re-assert it.
 */
export function statelessNoiseU32(seed: number, entityId: number, tick: number): number {
  const tickHigh = Math.floor(tick / 4294967296);
  const a = fmix32(((seed >>> 0) ^ Math.imul(tickHigh, TICK_HIGH_MIX)) >>> 0);
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
