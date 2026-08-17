import { BRAIN_INPUT_COUNT, BRAIN_OUTPUT_COUNT, IO_OFFSET, ioWeightIndex } from "./BrainLayout";
import {
  TOPOLOGY_CONNECTION_WORD,
  TOPOLOGY_INPUT_WORD,
  TOPOLOGY_WORD_COUNT,
  setMaskBit,
} from "./NeuralTopology";

/**
 * The founder's topology genome (M16, docs/11 §M16).
 *
 * ```text
 *   inputs       all 20 active
 *   hidden       none active
 *   recurrent    none active
 *   memory       none active
 *   connections  the 100 input->output skips, and nothing else
 * ```
 *
 * This is not a new founder. It is a *description* of the founder that
 * `founderBrain.ts` has always been: a pure reflex network whose every weight is
 * an input→output skip, with all 240 input→hidden and 60 hidden→output weights
 * at zero and a hidden layer that docs/08 §20 explicitly calls silent. Before
 * M16 that silence was a fact about the weights; now the mask says it out loud,
 * which is what makes it *cost nothing* and what makes waking the hidden layer
 * an event a lineage can pay for.
 *
 * ## Why all twenty inputs, when the founder's weights use eight
 *
 * Because an inactive input is a sense the organism does not have, and taking
 * senses away from the founder would be a behaviour change smuggled in as a
 * representation change. The founder can see everything it could always see;
 * what it does with each channel is what its weights say. A lineage that stops
 * paying for a channel it never used is then an ordinary saving that ordinary
 * mutation can find — which is the point of charging for sensory channels at
 * all.
 *
 * The 100 skip bits are likewise the whole skip block rather than the ~15
 * weights the founder actually leans on. Masking a connection is not the same
 * claim as zeroing it: the founder's genome says "these wires exist", and
 * evolution decides which ones carry anything. Trimming the unused ones is a
 * saving available from the first generation.
 */
export function createFounderTopology(): Uint16Array {
  const words = new Uint16Array(TOPOLOGY_WORD_COUNT);

  for (let input = 0; input < BRAIN_INPUT_COUNT; input += 1) {
    setMaskBit(words, 0, TOPOLOGY_INPUT_WORD, input, true);
  }

  // Hidden, recurrent and memory masks stay zero: the founder has a silent
  // hidden layer, no state that survives a tick, and nothing to remember with.

  for (let output = 0; output < BRAIN_OUTPUT_COUNT; output += 1) {
    for (let input = 0; input < BRAIN_INPUT_COUNT; input += 1) {
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, ioWeightIndex(output, input), true);
    }
  }

  return words;
}

/**
 * Number of connection bits the founder sets — the skip block, exactly.
 *
 * Exported so the complexity-cost calibration and its tests can talk about the
 * founder's brain bill without re-deriving what the founder is.
 */
export const FOUNDER_ACTIVE_CONNECTIONS = BRAIN_INPUT_COUNT * BRAIN_OUTPUT_COUNT;

/** Where the skip block starts, re-exported for the same reason. */
export { IO_OFFSET };
