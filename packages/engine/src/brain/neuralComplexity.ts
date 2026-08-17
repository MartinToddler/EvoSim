import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp } from "../math/fixed";
import type { GenomeStore } from "../organisms/GenomeStore";
import { BRAIN_INPUT_COUNT } from "./BrainLayout";
import {
  TOPOLOGY_CONNECTION_WORD,
  TOPOLOGY_CONNECTION_WORDS,
  TOPOLOGY_HIDDEN_WORD,
  TOPOLOGY_INPUT_WORD,
  TOPOLOGY_INPUT_WORDS,
  TOPOLOGY_MEMORY_WORD,
  TOPOLOGY_RECURRENT_WORD,
  maskPopcount,
} from "./NeuralTopology";
import { FOUNDER_ACTIVE_CONNECTIONS } from "./founderTopology";

/**
 * What a brain costs to run (M16, docs/11 §M16).
 *
 * ## Why this exists at all
 *
 * Without it, topology is a free lunch and the milestone fails its own contract.
 * Every mask bit a lineage sets buys capability — another sense, another unit,
 * another wire, another thing remembered — and CLAUDE.md's trade-off rule is
 * explicit that a benefit with no cost fixates immediately and stops carrying
 * information. M15 learned that the hard way three times over; M16 pays for
 * complexity from the first commit.
 *
 * The charge is per-tick metabolic upkeep, added to the basal cost the
 * physiology phase already bills. Nervous tissue is expensive to keep alive
 * whether or not it is thinking, which is both the biological fact and the
 * mechanism that makes an unused hidden unit a liability rather than a
 * harmless spare.
 *
 * ## Why it is measured against the founder rather than from zero
 *
 * The founder's brain — 20 senses, no hidden layer, 100 skip wires — is what
 * Milestones 0–13 calibrated an entire ecology around. Charging it for its own
 * existence would move every population number in the project for reasons that
 * have nothing to do with evolving topology. So the founder's complexity is the
 * free allowance, and what is billed is the excess over it.
 *
 * The excess is **floored at zero**. A lineage that trims its brain below the
 * founder's pays nothing extra; it does not earn a rebate. That is the same
 * shape M15's offspring-construction cost needed, and for the same reason: a
 * cost that can go negative is an energy source, and an energy source attached
 * to "do less" is a bug with an evolutionary strategy attached to it.
 *
 * Trimming still pays, just not here — an unused sense whose channel is masked
 * off stops feeding noise into the network, and an unused wire stops carrying a
 * mutation's drift into an output. Those are behavioural benefits, which is
 * where the benefit of parsimony belongs.
 */

/** The pieces of a brain that draw upkeep, counted. */
export interface NeuralComplexity {
  inputs: number;
  hidden: number;
  recurrent: number;
  memory: number;
  connections: number;
}

/** Reused so counting a brain allocates nothing. */
const scratchComplexity: NeuralComplexity = {
  inputs: 0,
  hidden: 0,
  recurrent: 0,
  memory: 0,
  connections: 0,
};

/** Count what one organism's topology switches on. */
export function countNeuralComplexity(
  topology: Uint16Array,
  offset: number,
  out: NeuralComplexity,
): void {
  out.inputs = maskPopcount(topology, offset, TOPOLOGY_INPUT_WORD, TOPOLOGY_INPUT_WORDS);
  out.hidden = maskPopcount(topology, offset, TOPOLOGY_HIDDEN_WORD, 1);
  out.recurrent = maskPopcount(topology, offset, TOPOLOGY_RECURRENT_WORD, 1);
  out.memory = maskPopcount(topology, offset, TOPOLOGY_MEMORY_WORD, 1);
  out.connections = maskPopcount(
    topology,
    offset,
    TOPOLOGY_CONNECTION_WORD,
    TOPOLOGY_CONNECTION_WORDS,
  );
}

/** Fresh, zeroed complexity counters. Tests and the inspector. */
export function createNeuralComplexity(): NeuralComplexity {
  return { ...scratchComplexity };
}

/**
 * The founder's complexity, which is the free allowance.
 *
 * Written as constants rather than counted from `createFounderTopology()` at
 * module load, because a cost baseline that quietly follows a changed founder
 * would hide exactly the kind of ecology-wide shift this baseline exists to
 * prevent. A test asserts the two agree, so changing the founder fails loudly.
 */
export const FOUNDER_COMPLEXITY: Readonly<NeuralComplexity> = {
  inputs: BRAIN_INPUT_COUNT,
  hidden: 0,
  recurrent: 0,
  memory: 0,
  connections: FOUNDER_ACTIVE_CONNECTIONS,
};

/**
 * Per-tick upkeep for one organism's brain, in whole energy units.
 *
 * Every term is `max(0, count - founderCount) × coefficient`, so the founder
 * pays nothing and only the excess is billed. The coefficients are Q-scaled —
 * a connection costs a small fraction of an energy unit, because the thing a
 * lineage actually buys is a hidden unit and one of those arrives wired to
 * twenty-six of them (see `NeuralComplexityConfig`).
 *
 * The Q sum is reduced to whole energy once at the end rather than term by
 * term, and **any non-zero excess is billed at least one energy per tick**.
 * That floor is what keeps "no free complexity" true at a fractional scale:
 * without it a lineage could add a handful of connections, round down to zero
 * and carry them for nothing. The result stays monotone in every count, so
 * more complexity can never cost less.
 */
export function neuralUpkeep(
  genomes: GenomeStore,
  slot: number,
  config: DeepReadonly<SimulationConfig>,
): number {
  const cost = config.brain.complexity;
  const counts = scratchComplexity;
  countNeuralComplexity(genomes.topology, genomes.topologyOffset(slot), counts);

  const excess = (count: number, allowance: number): number => Math.max(0, count - allowance);
  const totalQ =
    excess(counts.inputs, FOUNDER_COMPLEXITY.inputs) * cost.perSensoryChannelQ +
    excess(counts.hidden, FOUNDER_COMPLEXITY.hidden) * cost.perHiddenUnitQ +
    excess(counts.recurrent, FOUNDER_COMPLEXITY.recurrent) * cost.perRecurrentLinkQ +
    excess(counts.memory, FOUNDER_COMPLEXITY.memory) * cost.perMemoryRegisterQ +
    excess(counts.connections, FOUNDER_COMPLEXITY.connections) * cost.perConnectionQ;

  if (totalQ === 0) {
    return 0;
  }
  return clamp(Math.max(1, Math.trunc(totalQ / Q)), 1, 65535);
}
