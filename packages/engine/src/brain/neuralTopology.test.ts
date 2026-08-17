import { describe, expect, it } from "vitest";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { ConfigValidationError, validateConfig } from "../config/validateConfig";
import { GenomeStore } from "../organisms/GenomeStore";
import { Xoshiro128 } from "../random/Xoshiro128";
import { Q } from "../math/fixed";
import { BRAIN_HIDDEN_COUNT, BRAIN_INPUT_COUNT, BRAIN_WEIGHT_COUNT } from "./BrainLayout";
import { NeuralStateStore } from "./NeuralStateStore";
import {
  BRAIN_MEMORY_COUNT,
  MEMORY_GATE_OFFSET,
  MEMORY_READ_OFFSET,
  MEMORY_SKIP_OFFSET,
  MEMORY_VALUE_OFFSET,
  NEURAL_WEIGHT_COUNT,
  RECURRENT_OFFSET,
  TOPOLOGY_CONNECTION_WORD,
  TOPOLOGY_CONNECTION_WORDS,
  TOPOLOGY_HIDDEN_WORD,
  TOPOLOGY_INPUT_WORD,
  TOPOLOGY_INPUT_WORDS,
  TOPOLOGY_MEMORY_WORD,
  TOPOLOGY_RECURRENT_WORD,
  TOPOLOGY_WORD_COUNT,
  maskBit,
  maskPopcount,
  setMaskBit,
} from "./NeuralTopology";
import { FOUNDER_ACTIVE_CONNECTIONS, createFounderTopology } from "./founderTopology";
import {
  FOUNDER_COMPLEXITY,
  countNeuralComplexity,
  createNeuralComplexity,
  neuralUpkeep,
} from "./neuralComplexity";
import { TOPOLOGY_BIT_COUNT, flipTopologyBit, mutateTopology } from "./topologyMutation";

/**
 * M16 — the topology genome, its mutation and what it costs (docs/11 §M16,
 * ADR 0030).
 */

describe("the topology genome is bounded by construction (M16)", () => {
  it("is a fixed number of words, whatever the network", () => {
    // The boundedness rule, stated as arithmetic. Every mask is sized at
    // compile time from the layout constants, so a genome cannot grow.
    expect(TOPOLOGY_INPUT_WORDS).toBe(Math.ceil(BRAIN_INPUT_COUNT / 16));
    expect(TOPOLOGY_CONNECTION_WORDS).toBe(Math.ceil(NEURAL_WEIGHT_COUNT / 16));
    expect(TOPOLOGY_WORD_COUNT).toBe(TOPOLOGY_CONNECTION_WORD + TOPOLOGY_CONNECTION_WORDS);
    // Every addressable bit has a home in exactly one mask.
    expect(TOPOLOGY_BIT_COUNT).toBe(
      BRAIN_INPUT_COUNT + BRAIN_HIDDEN_COUNT * 2 + BRAIN_MEMORY_COUNT + NEURAL_WEIGHT_COUNT,
    );
  });

  it("lays the M16 weight blocks after the M14 block, without overlapping", () => {
    // The offsets are a storage contract: an overlap would make one lineage's
    // recurrence quietly share storage with another's memory gate.
    expect(RECURRENT_OFFSET).toBe(BRAIN_WEIGHT_COUNT);
    expect(MEMORY_READ_OFFSET).toBe(RECURRENT_OFFSET + BRAIN_HIDDEN_COUNT);
    expect(MEMORY_SKIP_OFFSET).toBe(MEMORY_READ_OFFSET + BRAIN_MEMORY_COUNT * BRAIN_HIDDEN_COUNT);
    expect(MEMORY_GATE_OFFSET).toBeGreaterThan(MEMORY_SKIP_OFFSET);
    expect(MEMORY_VALUE_OFFSET).toBeGreaterThan(MEMORY_GATE_OFFSET);
    expect(NEURAL_WEIGHT_COUNT).toBeGreaterThan(MEMORY_VALUE_OFFSET);
  });

  it("reads back every bit it was told to set", () => {
    const words = new Uint16Array(TOPOLOGY_WORD_COUNT);
    for (let bit = 0; bit < NEURAL_WEIGHT_COUNT; bit += 7) {
      setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, bit, true);
    }
    for (let bit = 0; bit < NEURAL_WEIGHT_COUNT; bit += 1) {
      expect(maskBit(words, 0, TOPOLOGY_CONNECTION_WORD, bit)).toBe(bit % 7 === 0);
    }
  });

  it("keeps each organism's masks to its own block", () => {
    const genomes = new GenomeStore(4);
    genomes.topology.set(createFounderTopology(), genomes.topologyOffset(2));
    for (const slot of [0, 1, 3]) {
      const base = genomes.topologyOffset(slot);
      expect(maskPopcount(genomes.topology, base, TOPOLOGY_INPUT_WORD, TOPOLOGY_INPUT_WORDS)).toBe(
        0,
      );
    }
  });
});

describe("the founder's topology is the network it always was (M16)", () => {
  it("switches on every sense, no hidden unit, and the skip block", () => {
    const words = createFounderTopology();
    expect(maskPopcount(words, 0, TOPOLOGY_INPUT_WORD, TOPOLOGY_INPUT_WORDS)).toBe(
      BRAIN_INPUT_COUNT,
    );
    expect(maskPopcount(words, 0, TOPOLOGY_HIDDEN_WORD, 1)).toBe(0);
    expect(maskPopcount(words, 0, TOPOLOGY_RECURRENT_WORD, 1)).toBe(0);
    expect(maskPopcount(words, 0, TOPOLOGY_MEMORY_WORD, 1)).toBe(0);
    expect(maskPopcount(words, 0, TOPOLOGY_CONNECTION_WORD, TOPOLOGY_CONNECTION_WORDS)).toBe(
      FOUNDER_ACTIVE_CONNECTIONS,
    );
  });

  it("costs exactly nothing to run", () => {
    // The property that keeps M16 from re-tuning an ecology calibrated over
    // Milestones 0-13: the founder's brain is the free allowance.
    const genomes = new GenomeStore(1);
    genomes.topology.set(createFounderTopology(), 0);
    expect(neuralUpkeep(genomes, 0, DEFAULT_CONFIG)).toBe(0);
  });

  it("matches the complexity baseline the cost model assumes", () => {
    // FOUNDER_COMPLEXITY is written down rather than counted, so that changing
    // the founder fails here instead of silently moving every population number
    // in the project.
    const counts = createNeuralComplexity();
    countNeuralComplexity(createFounderTopology(), 0, counts);
    expect(counts).toEqual({ ...FOUNDER_COMPLEXITY });
  });
});

describe("complexity is charged for (M16, CLAUDE.md trade-off rule)", () => {
  const withMask = (apply: (words: Uint16Array) => void): GenomeStore => {
    const genomes = new GenomeStore(1);
    const words = createFounderTopology();
    apply(words);
    genomes.topology.set(words, 0);
    return genomes;
  };

  it("every kind of complexity beyond the founder costs something", () => {
    const cases: [string, (words: Uint16Array) => void][] = [
      ["a hidden unit", (w) => setMaskBit(w, 0, TOPOLOGY_HIDDEN_WORD, 0, true)],
      ["a recurrent link", (w) => setMaskBit(w, 0, TOPOLOGY_RECURRENT_WORD, 0, true)],
      ["a memory register", (w) => setMaskBit(w, 0, TOPOLOGY_MEMORY_WORD, 0, true)],
      ["a connection", (w) => setMaskBit(w, 0, TOPOLOGY_CONNECTION_WORD, RECURRENT_OFFSET, true)],
    ];
    for (const [name, apply] of cases) {
      const genomes = withMask(apply);
      expect(`${name}: ${neuralUpkeep(genomes, 0, DEFAULT_CONFIG)}`).not.toBe(`${name}: 0`);
    }
  });

  it("a brain simpler than the founder's is free, never profitable", () => {
    // The M15 lesson applied before it could bite: a cost that can go negative
    // is an energy source, and one attached to "do less" is a strategy.
    const stripped = withMask((words) => {
      for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
        setMaskBit(words, 0, TOPOLOGY_INPUT_WORD, i, false);
      }
      for (let w = 0; w < NEURAL_WEIGHT_COUNT; w += 1) {
        setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, w, false);
      }
    });
    expect(neuralUpkeep(stripped, 0, DEFAULT_CONFIG)).toBe(0);
  });

  it("the most complex expressible brain is a real bill, and fits its storage", () => {
    const maximal = withMask((words) => {
      for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
        setMaskBit(words, 0, TOPOLOGY_INPUT_WORD, i, true);
      }
      for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
        setMaskBit(words, 0, TOPOLOGY_HIDDEN_WORD, h, true);
        setMaskBit(words, 0, TOPOLOGY_RECURRENT_WORD, h, true);
      }
      for (let m = 0; m < BRAIN_MEMORY_COUNT; m += 1) {
        setMaskBit(words, 0, TOPOLOGY_MEMORY_WORD, m, true);
      }
      for (let w = 0; w < NEURAL_WEIGHT_COUNT; w += 1) {
        setMaskBit(words, 0, TOPOLOGY_CONNECTION_WORD, w, true);
      }
    });
    const upkeep = neuralUpkeep(maximal, 0, DEFAULT_CONFIG);
    // A newborn founder's whole basal bill is 10 energy/tick and the adult mean
    // is 30 (measured, ADR 0030 §10). A maximal brain has to be a decision
    // rather than a rounding error — and it also has to be a decision a lineage
    // could conceivably make, which is the half the first calibration failed:
    // at one whole energy per connection the same brain cost 545/tick, and
    // measurement found hidden units being switched on by mutation and removed
    // by selection every time.
    const ADULT_BASAL = 30;
    expect(upkeep).toBeGreaterThan(ADULT_BASAL);
    expect(upkeep).toBeLessThan(ADULT_BASAL * 4);
    expect(upkeep).toBeLessThanOrEqual(65535);
  });
});

describe("structural mutation is bounded and deterministic (M16)", () => {
  it("costs the same number of draws whatever the network looks like", () => {
    // The determinism contract: a lineage's structural history must not shift
    // any other organism's random stream.
    // Same seed, wildly different genomes: the stream must advance identically,
    // and must keep doing so over many births rather than by luck on one.
    const empty = Xoshiro128.fromSeed(0x16a2);
    const full = Xoshiro128.fromSeed(0x16a2);
    const emptyWords = new Uint16Array(TOPOLOGY_WORD_COUNT);
    const fullWords = new Uint16Array(TOPOLOGY_WORD_COUNT).fill(0xffff);
    for (let birth = 0; birth < 500; birth += 1) {
      mutateTopology(emptyWords, 0, empty, DEFAULT_CONFIG);
      mutateTopology(fullWords, 0, full, DEFAULT_CONFIG);
      expect(empty.serializeState()).toEqual(full.serializeState());
    }
  });

  it("never flips more bits than the config allows", () => {
    const rng = Xoshiro128.fromSeed(0x16a3);
    for (let trial = 0; trial < 2_000; trial += 1) {
      const before = new Uint16Array(TOPOLOGY_WORD_COUNT);
      const after = new Uint16Array(before);
      mutateTopology(after, 0, rng, DEFAULT_CONFIG);
      let changed = 0;
      for (let bit = 0; bit < TOPOLOGY_BIT_COUNT; bit += 1) {
        const word = bit >> 4;
        if (
          ((before[word] ?? 0) & (1 << (bit & 15))) !==
          ((after[word] ?? 0) & (1 << (bit & 15)))
        ) {
          changed += 1;
        }
      }
      expect(changed).toBeLessThanOrEqual(DEFAULT_CONFIG.mutation.topology.maxFlipsPerBirth);
    }
  });

  it("reaches every mask over enough generations", () => {
    // Reachability: no part of the topology may be evolutionarily unreachable,
    // or it is decoration rather than a genome.
    const words = createFounderTopology();
    const rng = Xoshiro128.fromSeed(0x16a4);
    for (let generation = 0; generation < 20_000; generation += 1) {
      mutateTopology(words, 0, rng, DEFAULT_CONFIG);
    }
    expect(maskPopcount(words, 0, TOPOLOGY_HIDDEN_WORD, 1)).toBeGreaterThan(0);
    expect(maskPopcount(words, 0, TOPOLOGY_RECURRENT_WORD, 1)).toBeGreaterThan(0);
    expect(maskPopcount(words, 0, TOPOLOGY_MEMORY_WORD, 1)).toBeGreaterThan(0);
  });

  it("flips exactly the bit it is asked to", () => {
    const words = new Uint16Array(TOPOLOGY_WORD_COUNT);
    for (const bit of [0, BRAIN_INPUT_COUNT, TOPOLOGY_BIT_COUNT - 1]) {
      flipTopologyBit(words, 0, bit);
      let set = 0;
      for (const word of words) {
        set += word === 0 ? 0 : 1;
      }
      expect(set).toBe(1);
      flipTopologyBit(words, 0, bit);
      expect(words.every((word) => word === 0)).toBe(true);
    }
  });
});

describe("neural state is authoritative (M16)", () => {
  it("clears a slot completely, so a recycled slot inherits no thoughts", () => {
    const neural = new NeuralStateStore(2);
    neural.hiddenPrevQ.fill(1234);
    neural.memoryQ.fill(-567);
    neural.clearSlot(1);
    for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
      expect(neural.hiddenPrevQ[neural.hiddenOffset(1) + h]).toBe(0);
      expect(neural.hiddenPrevQ[neural.hiddenOffset(0) + h]).toBe(1234);
    }
    for (let m = 0; m < BRAIN_MEMORY_COUNT; m += 1) {
      expect(neural.memoryQ[neural.memoryOffset(1) + m]).toBe(0);
      expect(neural.memoryQ[neural.memoryOffset(0) + m]).toBe(-567);
    }
  });
});

describe("the config cannot ask for a brain that has no meaning (M16)", () => {
  it("rejects a complexity cost that would saturate its own storage", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.brain.complexity.perConnectionQ = 1000 * Q;
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(/free lunch at the top/);
  });

  it("rejects more flips per birth than there are bits", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.mutation.topology.maxFlipsPerBirth = TOPOLOGY_BIT_COUNT + 1;
    expect(() => validateConfig(config)).toThrow(/bits there are to flip/);
  });

  it("accepts the shipped configuration", () => {
    expect(() => validateConfig(cloneConfig(DEFAULT_CONFIG))).not.toThrow();
  });
});
