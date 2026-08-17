import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  BRAIN_WEIGHT_COUNT,
} from "./BrainLayout";

/**
 * Evolvable topology and generic memory (M16, docs/11 §M16).
 *
 * M14 made the body inherited and M15 made it physical. The controller is still
 * a fixed 20 → 12 → 5 network with a fixed set of connections: what evolves is
 * only how strongly each wire pulls. M16 makes the *shape* inherited too, and
 * gives the network somewhere to keep a thought between ticks.
 *
 * ## Bounded, and bounded by construction
 *
 * There is no growth here. The maximum network is the one `BrainLayout` already
 * declares, plus a fixed bank of memory registers, and a genome can only switch
 * parts of it **off**. Every mask is a fixed-width bitset sized at compile time,
 * so a genome is the same number of bytes for every organism, no organism owns
 * a graph object, and nothing allocates per tick. That is the shape CLAUDE.md's
 * boundedness rule asks for, and it is what "no unbounded NEAT growth" means in
 * practice: the ceiling is a constant, not a policy.
 *
 * ## Why masks at all, when a zero weight already disconnects
 *
 * Two reasons, and neither is cosmetic.
 *
 * A mask makes complexity **countable**, which is what lets it be *charged for*.
 * "How many connections does this brain use" has no answer if the only evidence
 * is a float that happens to be near zero; with a mask it is a popcount, and
 * M16's metabolic cost can be a function of it.
 *
 * A mask also lets a lineage switch a connection off **without losing what it
 * learned**. A weight zeroed by mutation is gone; a weight masked off keeps its
 * value and can be switched back on by a single bit flip. That is the
 * difference between a structural change being a cliff and being reversible,
 * and reversible structural change is the whole point of evolving topology.
 *
 * ## Memory is numbered, not named
 *
 * The registers are `memory0 … memory3`. They are not `homeX`, `nestY` or
 * `lastThreatSeen`: the engine has no idea what a lineage keeps in them, and
 * ADR 0027 forbids it from ever finding out. A register is somewhere to put a
 * number; what the number means is the lineage's business, and if a persistent
 * location strategy ever appears it will be because one evolved, not because a
 * field was called `home`.
 */

/**
 * Memory registers per organism.
 *
 * Four, because the acceptance fixtures need a couple of independent latches
 * plus somewhere to alternate, and because every register costs upkeep whether
 * or not it holds anything worth keeping. A bank large enough to be free would
 * teach the wrong lesson.
 */
export const BRAIN_MEMORY_COUNT = 4;

/**
 * Extra weights M16 adds, in blocks, after the M14/M15 weight block.
 *
 * ```text
 *   recurrent      hidden -> itself next tick        12
 *   memory read    memory -> hidden          4 x 12 = 48
 *   memory skip    memory -> output          4 x  5 = 20
 *   memory gate    hidden -> write gate      12 x 4 = 48
 *   memory value   hidden -> write value     12 x 4 = 48
 *                                            total  176
 * ```
 *
 * The gate/value split is what makes a register a *latch* rather than a running
 * average: the gate decides whether to write at all, the value decides what.
 * One weight block could not express "keep what you have" and "store this now"
 * as separate decisions, and every capability fixture below needs both.
 */
export const RECURRENT_OFFSET = BRAIN_WEIGHT_COUNT;
export const MEMORY_READ_OFFSET = RECURRENT_OFFSET + BRAIN_HIDDEN_COUNT;
export const MEMORY_SKIP_OFFSET = MEMORY_READ_OFFSET + BRAIN_MEMORY_COUNT * BRAIN_HIDDEN_COUNT;
export const MEMORY_GATE_OFFSET = MEMORY_SKIP_OFFSET + BRAIN_MEMORY_COUNT * BRAIN_OUTPUT_COUNT;
export const MEMORY_VALUE_OFFSET = MEMORY_GATE_OFFSET + BRAIN_HIDDEN_COUNT * BRAIN_MEMORY_COUNT;

/** Total weights per organism once M16's blocks are included. */
export const NEURAL_WEIGHT_COUNT = MEMORY_VALUE_OFFSET + BRAIN_HIDDEN_COUNT * BRAIN_MEMORY_COUNT;

/** Weight index of the recurrent self-connection on one hidden unit. */
export function recurrentWeightIndex(hidden: number): number {
  return RECURRENT_OFFSET + hidden;
}

/** Weight index of memory register `m` read into hidden unit `h`. */
export function memoryReadWeightIndex(hidden: number, memory: number): number {
  return MEMORY_READ_OFFSET + memory * BRAIN_HIDDEN_COUNT + hidden;
}

/** Weight index of memory register `m` read straight into output `o`. */
export function memorySkipWeightIndex(output: number, memory: number): number {
  return MEMORY_SKIP_OFFSET + memory * BRAIN_OUTPUT_COUNT + output;
}

/** Weight index of hidden unit `h` driving the write gate of register `m`. */
export function memoryGateWeightIndex(memory: number, hidden: number): number {
  return MEMORY_GATE_OFFSET + memory * BRAIN_HIDDEN_COUNT + hidden;
}

/** Weight index of hidden unit `h` driving the write value of register `m`. */
export function memoryValueWeightIndex(memory: number, hidden: number): number {
  return MEMORY_VALUE_OFFSET + memory * BRAIN_HIDDEN_COUNT + hidden;
}

/**
 * The topology genome, as a fixed run of Uint16 words.
 *
 * ```text
 *   word 0      inputs  0..15   active
 *   word 1      inputs 16..19   active
 *   word 2      hidden  0..11   active
 *   word 3      hidden  0..11   recurrent
 *   word 4      memory  0..3    active
 *   words 5..40 connections 0..575 active   (one bit per weight, 36 words)
 * ```
 *
 * Forty-one Uint16 words — 82 bytes — per organism, whatever the topology.
 */
export const TOPOLOGY_INPUT_WORD = 0;
export const TOPOLOGY_INPUT_WORDS = Math.ceil(BRAIN_INPUT_COUNT / 16);
export const TOPOLOGY_HIDDEN_WORD = TOPOLOGY_INPUT_WORD + TOPOLOGY_INPUT_WORDS;
export const TOPOLOGY_RECURRENT_WORD = TOPOLOGY_HIDDEN_WORD + 1;
export const TOPOLOGY_MEMORY_WORD = TOPOLOGY_RECURRENT_WORD + 1;
export const TOPOLOGY_CONNECTION_WORD = TOPOLOGY_MEMORY_WORD + 1;
export const TOPOLOGY_CONNECTION_WORDS = Math.ceil(NEURAL_WEIGHT_COUNT / 16);
export const TOPOLOGY_WORD_COUNT = TOPOLOGY_CONNECTION_WORD + TOPOLOGY_CONNECTION_WORDS;

/** Read one bit out of a packed mask run. */
export function maskBit(words: Uint16Array, base: number, wordIndex: number, bit: number): boolean {
  return ((words[base + wordIndex + (bit >> 4)] as number) & (1 << (bit & 15))) !== 0;
}

/** Set or clear one bit in a packed mask run. */
export function setMaskBit(
  words: Uint16Array,
  base: number,
  wordIndex: number,
  bit: number,
  active: boolean,
): void {
  const index = base + wordIndex + (bit >> 4);
  const flag = 1 << (bit & 15);
  const current = words[index] as number;
  words[index] = active ? current | flag : current & ~flag;
}

/** Whether sensory input `i` reaches this organism's network at all. */
export function inputActive(words: Uint16Array, base: number, input: number): boolean {
  return maskBit(words, base, TOPOLOGY_INPUT_WORD, input);
}

/** Whether hidden unit `h` participates. An inactive unit outputs zero. */
export function hiddenActive(words: Uint16Array, base: number, hidden: number): boolean {
  return maskBit(words, base, TOPOLOGY_HIDDEN_WORD, hidden);
}

/** Whether hidden unit `h` sees its own previous activation. */
export function recurrentActive(words: Uint16Array, base: number, hidden: number): boolean {
  return maskBit(words, base, TOPOLOGY_RECURRENT_WORD, hidden);
}

/** Whether memory register `m` is retained and readable. */
export function memoryActive(words: Uint16Array, base: number, memory: number): boolean {
  return maskBit(words, base, TOPOLOGY_MEMORY_WORD, memory);
}

/** Whether weight `w` is wired in. A masked-off weight keeps its value. */
export function connectionActive(words: Uint16Array, base: number, weight: number): boolean {
  return maskBit(words, base, TOPOLOGY_CONNECTION_WORD, weight);
}

/** Population count of a 16-bit word. */
function popcount16(value: number): number {
  let v = value & 0xffff;
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  v = (v + (v >> 4)) & 0x0f0f;
  return (v + (v >> 8)) & 0x1f;
}

/** How many bits are set across `count` words starting at `base + wordIndex`. */
export function maskPopcount(
  words: Uint16Array,
  base: number,
  wordIndex: number,
  count: number,
): number {
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += popcount16(words[base + wordIndex + i] as number);
  }
  return total;
}
