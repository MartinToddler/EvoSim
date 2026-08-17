import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  hoWeightIndex,
  ihWeightIndex,
} from "../brain/BrainLayout";
import { createFounderTopology } from "../brain/founderTopology";
import { countNeuralComplexity, createNeuralComplexity } from "../brain/neuralComplexity";
import {
  BRAIN_MEMORY_COUNT,
  TOPOLOGY_CONNECTION_WORD,
  TOPOLOGY_HIDDEN_WORD,
  TOPOLOGY_MEMORY_WORD,
  TOPOLOGY_RECURRENT_WORD,
  TOPOLOGY_WORD_COUNT,
  memoryGateWeightIndex,
  memoryReadWeightIndex,
  memorySkipWeightIndex,
  memoryValueWeightIndex,
  recurrentWeightIndex,
  setMaskBit,
} from "../brain/NeuralTopology";
import { Q } from "../math/fixed";
import { Xoshiro128 } from "../random/Xoshiro128";
import type { SimulationEngine } from "../SimulationEngine";
import { engineInternals } from "../internal";

/**
 * Evolutionary accessibility for memory (M16, CLAUDE.md "Evolutionary
 * accessibility rule", ADR 0030).
 *
 * The rule names memory use explicitly: it is not enough that a hand-built
 * network in a unit test can hold a bearing for forty ticks. There has to be an
 * ordinary mutation + inheritance + selection pathway to a memory-using
 * lineage, running the ordinary engine, with realized survival and reproduction
 * as the only fitness.
 *
 * ## What is actually being claimed, and what would falsify it
 *
 * Two claims, and they pull in opposite directions, which is the point.
 *
 * 1. **Complexity that costs and does not pay is selected against.** M16 bills
 *    every mask bit above the founder's allowance, so a brain that is bigger
 *    for no reason is a brain that starves slightly sooner. If the complex
 *    share did *not* fall in a world with nothing to remember, the cost would
 *    be decorative and the trade-off rule would be violated.
 * 2. **Complexity that can pay is not priced out of existence.** If the complex
 *    share fell equally hard in *both* worlds, memory would be a trait evolution
 *    can never afford, and the mechanism would be unreachable in practice
 *    whatever the unit tests show.
 *
 * So the measurement is a **contrast between two worlds**, not an absolute
 * number, and either half failing is a real failure of the milestone rather
 * than a tuning inconvenience.
 *
 * ## The worlds are M15's, deliberately
 *
 * {@link TURF_CONFIG} and {@link PATCHWORK_CONFIG} are imported from the
 * morphology experiment rather than re-invented, for two reasons. They are
 * already pinned against `DEFAULT_CONFIG` retuning, so both milestones keep
 * measuring the same worlds; and the axis they contest turns out to be the same
 * axis memory contests. On the turf, thin food is everywhere and grows back, so
 * the right action is always derivable from the current senses and nothing has
 * to be carried between ticks. On the patchwork, rich patches are separated by
 * barren ground where the senses report nothing useful, so holding *anything*
 * across the gap — a heading, a decision to keep going, a count — is worth
 * something that reacting to the present moment is not.
 *
 * Neither world knows what memory is, and nothing in either config mentions the
 * brain.
 */

export {
  PATCHWORK_CONFIG,
  SELECTION_GRID_SIZE,
  SELECTION_HORIZON,
  SELECTION_SEEDS,
  TURF_CONFIG,
} from "./morphologySelection";

/**
 * How many hidden units **both** variants wake.
 *
 * Six of twelve rather than all twelve: enough capacity to drive four registers
 * and still leave headroom for mutation to add or remove units in either
 * direction, so the seeded variants are points inside the space rather than its
 * ceiling.
 */
export const SEEDED_HIDDEN_UNITS = 6;

/**
 * The shared half of both variants: a hidden layer with recurrence on it, wired
 * to every input and every output.
 *
 * Built outward from the founder's topology, so both variants keep every sense
 * and every skip wire the founder has and are strictly *additions* to it.
 */
export function createReactiveTopology(): Uint16Array {
  const words = createFounderTopology();
  for (let hidden = 0; hidden < SEEDED_HIDDEN_UNITS; hidden += 1) {
    setMaskBit(words, 0, TOPOLOGY_HIDDEN_WORD, hidden, true);
    setMaskBit(words, 0, TOPOLOGY_RECURRENT_WORD, hidden, true);
    setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, recurrentWeightIndex(hidden), true);
    for (let input = 0; input < BRAIN_INPUT_COUNT; input += 1) {
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, ihWeightIndex(hidden, input), true);
    }
    for (let output = 0; output < BRAIN_OUTPUT_COUNT; output += 1) {
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, hoWeightIndex(output, hidden), true);
    }
  }
  return words;
}

/**
 * The reactive topology plus four live registers, wired both ways.
 *
 * **The two variants differ in memory and in nothing else.** That control is
 * the whole experiment. The first version of this fixture compared a complex
 * brain against the pristine founder, and it measured what anyone would expect:
 * the randomly wired brain was wiped out inside a thousand ticks — less than one
 * generation, so not selection at all, just a worse controller. Comparing a
 * memory-capable brain against an otherwise identical memory-less one is the
 * only arrangement in which a difference in outcome is attributable to memory.
 */
export function createMemoryTopology(): Uint16Array {
  const words = createReactiveTopology();
  for (let memory = 0; memory < BRAIN_MEMORY_COUNT; memory += 1) {
    setMaskBit(words, 0, TOPOLOGY_MEMORY_WORD, memory, true);
    for (let hidden = 0; hidden < SEEDED_HIDDEN_UNITS; hidden += 1) {
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, memoryReadWeightIndex(hidden, memory), true);
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, memoryGateWeightIndex(memory, hidden), true);
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, memoryValueWeightIndex(memory, hidden), true);
    }
    for (let output = 0; output < BRAIN_OUTPUT_COUNT; output += 1) {
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, memorySkipWeightIndex(output, memory), true);
    }
  }
  return words;
}

/** Weight indices the shared hidden layer uses and the founder does not. */
function hiddenLayerWeightIndices(): number[] {
  const indices: number[] = [];
  for (let hidden = 0; hidden < SEEDED_HIDDEN_UNITS; hidden += 1) {
    indices.push(recurrentWeightIndex(hidden));
    for (let input = 0; input < BRAIN_INPUT_COUNT; input += 1) {
      indices.push(ihWeightIndex(hidden, input));
    }
    for (let output = 0; output < BRAIN_OUTPUT_COUNT; output += 1) {
      indices.push(hoWeightIndex(output, hidden));
    }
  }
  return indices;
}

/** Weight indices only the memory variant uses. */
function memoryWeightIndices(): number[] {
  const indices: number[] = [];
  for (let memory = 0; memory < BRAIN_MEMORY_COUNT; memory += 1) {
    for (let hidden = 0; hidden < SEEDED_HIDDEN_UNITS; hidden += 1) {
      indices.push(memoryReadWeightIndex(hidden, memory));
      indices.push(memoryGateWeightIndex(memory, hidden));
      indices.push(memoryValueWeightIndex(memory, hidden));
    }
    for (let output = 0; output < BRAIN_OUTPUT_COUNT; output += 1) {
      indices.push(memorySkipWeightIndex(output, memory));
    }
  }
  return indices;
}

/**
 * How far a newly wired connection's weight is drawn from zero, in stored units.
 *
 * A wire that ordinary evolution has just switched on does not arrive carrying a
 * full-scale weight. `createFounderBrainWeights` leaves every hidden-layer
 * weight at zero and drift moves it a small step at a time, so what a mask bit
 * actually exposes is a few mutations' worth of accumulated drift. Four small
 * sigmas is that, and it matters: a first attempt drew uniformly over the whole
 * legal range, which saturated every hidden unit and left a network that had
 * stopped responding to its senses. That measures saturation, not memory.
 */
const SEEDED_WEIGHT_SPREAD_SIGMAS = 4;

/**
 * Give a freshly created world standing topological variation.
 *
 * Founders are paired. Both members of a pair get the same hidden layer with the
 * **same** randomly drawn weights on it; the second member additionally gets
 * four live registers with their own randomly drawn wiring. So the pair is
 * matched on everything except memory, and the population starts at exactly half
 * and half.
 *
 * Random rather than designed is the methodological point. A hand-tuned memory
 * circuit would prove that the author can write one, which is what the
 * capability fixtures already prove and is not what the accessibility rule asks.
 * What has to be shown is that selection, given ordinary variation, can sort it
 * — so the variation must be ordinary.
 *
 * The draw uses its own PRNG seeded from the world seed. The engine's own stream
 * is untouched, so a seeded run consumes randomness identically to an unseeded
 * one from tick 1.
 *
 * This sets up variation. It does not set up an outcome: which group's
 * descendants are still there at the end is decided by the ordinary feeding,
 * metabolism, movement and reproduction phases, and by nothing else.
 */
export function seedTopologicalVariation(engine: SimulationEngine): void {
  const { context } = engineInternals(engine);
  const { organisms, genomes, config, seed } = context;

  const reactive = createReactiveTopology();
  const withMemory = createMemoryTopology();
  const hiddenWeights = hiddenLayerWeightIndices();
  const memoryWeights = memoryWeightIndices();
  // A separate stream, so seeding cannot shift the simulation's own draws.
  const rng = Xoshiro128.fromSeed(seed ^ 0x4d454d4f);
  const spread = SEEDED_WEIGHT_SPREAD_SIGMAS * config.mutation.brain.weightSmallSigmaQ;
  const draw = (): number => Math.trunc(((rng.nextQ() - (Q >> 1)) * 2 * spread) / Q);

  const live: number[] = [];
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] === 1) {
      live.push(slot);
    }
  }

  for (let pair = 0; pair + 1 < live.length; pair += 2) {
    const reactiveSlot = live[pair] as number;
    const memorySlot = live[pair + 1] as number;

    genomes.topology.set(reactive, genomes.topologyOffset(reactiveSlot));
    genomes.topology.set(withMemory, genomes.topologyOffset(memorySlot));

    // The same hidden layer in both, drawn once: the pair is matched, so a
    // difference in outcome cannot come from one of them having been dealt a
    // better set of random weights.
    const reactiveBase = genomes.weightOffset(reactiveSlot);
    const memoryBase = genomes.weightOffset(memorySlot);
    for (const weight of hiddenWeights) {
      const value = draw();
      genomes.brainWeights[reactiveBase + weight] = value;
      genomes.brainWeights[memoryBase + weight] = value;
    }
    for (const weight of memoryWeights) {
      genomes.brainWeights[memoryBase + weight] = draw();
    }
  }
}

/** Share of the living population carrying a live memory register, in `[0, Q]`. */
export function memoryShareQ(engine: SimulationEngine): number {
  const { context } = engineInternals(engine);
  const { organisms, genomes } = context;
  const counts = createNeuralComplexity();
  let carriers = 0;
  let count = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    count += 1;
    countNeuralComplexity(genomes.topology, genomes.topologyOffset(slot), counts);
    if (counts.memory > 0) {
      carriers += 1;
    }
  }
  return count === 0 ? 0 : Math.round((carriers * Q) / count);
}

/** Mean neural complexity over the living population. */
export interface ComplexityMeans {
  population: number;
  inputs: number;
  hidden: number;
  recurrent: number;
  memory: number;
  connections: number;
}

export function measureComplexity(engine: SimulationEngine): ComplexityMeans {
  const { context } = engineInternals(engine);
  const { organisms, genomes } = context;
  const totals = { inputs: 0, hidden: 0, recurrent: 0, memory: 0, connections: 0 };
  const counts = createNeuralComplexity();
  let count = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    countNeuralComplexity(genomes.topology, genomes.topologyOffset(slot), counts);
    totals.inputs += counts.inputs;
    totals.hidden += counts.hidden;
    totals.recurrent += counts.recurrent;
    totals.memory += counts.memory;
    totals.connections += counts.connections;
    count += 1;
  }
  const mean = (total: number): number => (count === 0 ? 0 : total / count);
  return {
    population: count,
    inputs: mean(totals.inputs),
    hidden: mean(totals.hidden),
    recurrent: mean(totals.recurrent),
    memory: mean(totals.memory),
    connections: mean(totals.connections),
  };
}

/**
 * How far the population's topology has moved off the founder's, counted as the
 * number of distinct topology genomes among the living.
 *
 * The founder-only claim: ordinary structural mutation explores the space at
 * all. A world whose population still carries one topology after thousands of
 * ticks has an inert mutation operator however good its unit tests are.
 */
export function distinctTopologies(engine: SimulationEngine): number {
  const { context } = engineInternals(engine);
  const { organisms, genomes } = context;
  const seen = new Set<string>();
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const base = genomes.topologyOffset(slot);
    let key = "";
    for (let word = 0; word < TOPOLOGY_WORD_COUNT; word += 1) {
      key += (genomes.topology[base + word] as number).toString(36) + ",";
    }
    seen.add(key);
  }
  return seen.size;
}

/** Highest and lowest connection count in the living population. */
export function connectionSpread(engine: SimulationEngine): { min: number; max: number } {
  const { context } = engineInternals(engine);
  const { organisms, genomes } = context;
  const counts = createNeuralComplexity();
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    countNeuralComplexity(genomes.topology, genomes.topologyOffset(slot), counts);
    min = Math.min(min, counts.connections);
    max = Math.max(max, counts.connections);
  }
  return { min: Number.isFinite(min) ? min : 0, max };
}

/** Hidden-unit count is bounded by the layout, whatever mutation does. */
export const MAX_HIDDEN = BRAIN_HIDDEN_COUNT;
