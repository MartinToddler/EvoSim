import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q } from "../math/fixed";
import type { Xoshiro128 } from "../random/Xoshiro128";
import { BRAIN_HIDDEN_COUNT, BRAIN_INPUT_COUNT } from "./BrainLayout";
import {
  BRAIN_MEMORY_COUNT,
  NEURAL_WEIGHT_COUNT,
  TOPOLOGY_CONNECTION_WORD,
  TOPOLOGY_HIDDEN_WORD,
  TOPOLOGY_INPUT_WORD,
  TOPOLOGY_MEMORY_WORD,
  TOPOLOGY_RECURRENT_WORD,
  maskBit,
  setMaskBit,
} from "./NeuralTopology";

/**
 * Structural mutation of the neural topology (M16, docs/11 §M16).
 *
 * ## Why this does not draw once per bit
 *
 * The topology genome is 576 connection bits plus 48 unit bits. A per-bit
 * classification roll, which is how the ecological, morphological and weight
 * blocks work, would cost 624 PRNG draws at every birth — more than doubling
 * the 443 the engine already spends — for a block where the overwhelming
 * majority of draws would resolve to "no change".
 *
 * So structural mutation draws a **count first**: one roll for how many bits to
 * flip this birth, then two draws per flip to pick one. A birth that changes
 * nothing costs one draw. The distribution is deliberately blunt — uniform over
 * `[0, maxFlipsPerBirth]` after a probability gate — because the interesting
 * question is whether topology can change at a controlled rate, not whether the
 * change is drawn from an elegant distribution.
 *
 * The draw count is therefore `1 + 2 × flips`, bounded by
 * `1 + 2 × maxFlipsPerBirth` and independent of the network's size. That
 * matters for the determinism contract: the PRNG stream must not depend on how
 * complicated an organism's brain happens to be, or one lineage's structural
 * history would shift every subsequent organism's random draws.
 *
 * ## The five mask kinds are drawn together, on purpose
 *
 * A flip picks a *bit out of the whole genome*, so switching a hidden unit on
 * is exactly as likely per-bit as switching one connection on. Hidden units are
 * rarer events simply because there are 12 of them against 576 connections,
 * which is the right ratio: a body plan that gains a unit but no wiring for it
 * has gained nothing, and a lineage needs many more connection changes than
 * unit changes to build anything.
 */

/** Total addressable topology bits, in the order `flipBit` walks them. */
export const TOPOLOGY_BIT_COUNT =
  BRAIN_INPUT_COUNT +
  BRAIN_HIDDEN_COUNT +
  BRAIN_HIDDEN_COUNT +
  BRAIN_MEMORY_COUNT +
  NEURAL_WEIGHT_COUNT;

const INPUT_BIT_BASE = 0;
const HIDDEN_BIT_BASE = INPUT_BIT_BASE + BRAIN_INPUT_COUNT;
const RECURRENT_BIT_BASE = HIDDEN_BIT_BASE + BRAIN_HIDDEN_COUNT;
const MEMORY_BIT_BASE = RECURRENT_BIT_BASE + BRAIN_HIDDEN_COUNT;
const CONNECTION_BIT_BASE = MEMORY_BIT_BASE + BRAIN_MEMORY_COUNT;

/**
 * Flip one bit of the topology genome, addressed as a single flat index.
 *
 * Exported so the tests can flip a known bit rather than fishing for one
 * through the PRNG.
 */
export function flipTopologyBit(words: Uint16Array, offset: number, bit: number): void {
  if (bit < HIDDEN_BIT_BASE) {
    const index = bit - INPUT_BIT_BASE;
    setMaskBit(
      words,
      offset,
      TOPOLOGY_INPUT_WORD,
      index,
      !maskBit(words, offset, TOPOLOGY_INPUT_WORD, index),
    );
    return;
  }
  if (bit < RECURRENT_BIT_BASE) {
    const index = bit - HIDDEN_BIT_BASE;
    setMaskBit(
      words,
      offset,
      TOPOLOGY_HIDDEN_WORD,
      index,
      !maskBit(words, offset, TOPOLOGY_HIDDEN_WORD, index),
    );
    return;
  }
  if (bit < MEMORY_BIT_BASE) {
    const index = bit - RECURRENT_BIT_BASE;
    setMaskBit(
      words,
      offset,
      TOPOLOGY_RECURRENT_WORD,
      index,
      !maskBit(words, offset, TOPOLOGY_RECURRENT_WORD, index),
    );
    return;
  }
  if (bit < CONNECTION_BIT_BASE) {
    const index = bit - MEMORY_BIT_BASE;
    setMaskBit(
      words,
      offset,
      TOPOLOGY_MEMORY_WORD,
      index,
      !maskBit(words, offset, TOPOLOGY_MEMORY_WORD, index),
    );
    return;
  }
  const index = bit - CONNECTION_BIT_BASE;
  setMaskBit(
    words,
    offset,
    TOPOLOGY_CONNECTION_WORD,
    index,
    !maskBit(words, offset, TOPOLOGY_CONNECTION_WORD, index),
  );
}

/**
 * Mutate one topology block in place.
 *
 * Draws exactly `1 + 2 × flips`, and `flips` is bounded by the config — see the
 * module comment for why the count comes first.
 */
export function mutateTopology(
  words: Uint16Array,
  offset: number,
  rng: Xoshiro128,
  config: DeepReadonly<SimulationConfig>,
): void {
  const mutation = config.mutation.topology;
  if (rng.nextQ() >= mutation.structuralProbabilityQ) {
    return;
  }
  const flips = 1 + rng.nextInt(Math.max(1, mutation.maxFlipsPerBirth));
  for (let i = 0; i < flips; i += 1) {
    // Two draws per flip: one to choose a bit, one that is spent regardless so
    // the stream advances by a fixed amount per flip whatever the bit chosen.
    const bit = rng.nextInt(TOPOLOGY_BIT_COUNT);
    rng.nextQ();
    flipTopologyBit(words, offset, bit);
  }
}

/** The gate probability, re-exported so `validateConfig` can bound it. */
export const TOPOLOGY_MAX_PROBABILITY_Q = Q;
