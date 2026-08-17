import { describe, expect, it } from "vitest";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import {
  PATCHWORK_CONFIG,
  SELECTION_HORIZON,
  SELECTION_SEEDS,
  TURF_CONFIG,
  connectionSpread,
  distinctTopologies,
  measureComplexity,
  memoryShareQ,
  seedTopologicalVariation,
} from "../fixtures/memorySelection";
import { Q } from "../math/fixed";
import { SimulationEngine } from "../SimulationEngine";
import { BRAIN_HIDDEN_COUNT, BRAIN_INPUT_COUNT } from "./BrainLayout";
import { FOUNDER_ACTIVE_CONNECTIONS } from "./founderTopology";
import { BRAIN_MEMORY_COUNT, NEURAL_WEIGHT_COUNT } from "./NeuralTopology";

/**
 * M16 evolutionary reachability (CLAUDE.md "Evolutionary accessibility rule",
 * docs/11 §M16, ADR 0030 §9).
 *
 * The capability fixtures in `neuralCapability.test.ts` prove the architecture
 * can *represent* memory use. That is not the same claim as memory use being
 * *reachable*, and the accessibility rule names memory explicitly. What has to
 * be shown here is an ordinary mutation + inheritance + selection pathway, on
 * the ordinary engine, with realized survival and reproduction as the only
 * fitness.
 *
 * Two claims, pulling against each other on purpose:
 *
 * 1. Structural mutation actually explores the topology space from an unseeded
 *    founder population, in both directions, staying inside its bounds.
 * 2. Selection reaches into that space. Complexity that costs and does not pay
 *    is selected *against* — otherwise M16's upkeep is decorative and the
 *    trade-off rule is violated — while the same complexity in a world where it
 *    can pay is not driven out, or memory would be a trait evolution can never
 *    afford whatever the fixtures show.
 *
 * The second is therefore a **contrast between two worlds**, not an absolute
 * number, and either half failing is a real milestone failure rather than a
 * tuning inconvenience.
 */

const EXPLORATION_TICKS = 10_000;

describe("structural mutation explores the topology space", { timeout: 1_800_000 }, () => {
  // One ordinary world, no seeding, no intervention: the founders all carry the
  // founder topology and everything below is what ordinary births produced.
  const engine = new SimulationEngine({
    seed: SELECTION_SEEDS[0] as number,
    config: cloneConfig(DEFAULT_CONFIG),
  });
  engine.stepMany(EXPLORATION_TICKS);
  const spread = connectionSpread(engine);
  const means = measureComplexity(engine);

  it("has a live, reproducing population to draw conclusions from", () => {
    expect(means.population).toBeGreaterThan(100);
    expect(engine.organisms.totalBirths).toBeGreaterThan(1000);
  });

  it("produces many distinct topologies from one founder topology", () => {
    // Every founder starts identical. Anything above 1 is mutation working; the
    // floor is set well below the measured value so this reports an operator
    // that has stopped working rather than a shift in how much it works.
    expect(distinctTopologies(engine)).toBeGreaterThan(10);
  });

  it("moves in both directions, not just toward more", () => {
    // The founder wires 100 connections. A population that only ever adds is a
    // ratchet, and a ratchet plus a per-bit cost is a slow extinction rather
    // than an evolvable trait.
    expect(spread.min).toBeLessThan(FOUNDER_ACTIVE_CONNECTIONS);
    expect(spread.max).toBeGreaterThan(FOUNDER_ACTIVE_CONNECTIONS);
  });

  it("stays inside the compile-time ceiling everywhere", () => {
    // The boundedness claim, measured rather than asserted from the types.
    expect(means.inputs).toBeLessThanOrEqual(BRAIN_INPUT_COUNT);
    expect(means.hidden).toBeLessThanOrEqual(BRAIN_HIDDEN_COUNT);
    expect(means.recurrent).toBeLessThanOrEqual(BRAIN_HIDDEN_COUNT);
    expect(means.memory).toBeLessThanOrEqual(BRAIN_MEMORY_COUNT);
    expect(spread.max).toBeLessThanOrEqual(NEURAL_WEIGHT_COUNT);
  });
});

/**
 * Measured margins, with headroom. The table is in ADR 0030 §9d:
 *
 * ```text
 *   seed          turf    patchwork
 *   0xE0A12026    0.133      0.387
 *   0xE0A13F15    0.297      0.995
 *   0xE0A17CF3    0.266      0.940
 *   mean          0.232      0.774
 * ```
 *
 * The thresholds sit outside every measured value rather than at the mean, so
 * this reports a mechanism that stopped working rather than an ordinary shift
 * in how strongly it works.
 */
const TURF_CEILING_Q = Math.round(Q * 0.4);
const PATCHWORK_FLOOR_Q = Math.round(Q * 0.33);
const SEPARATION_FLOOR_Q = Math.round(Q * 0.2);

interface RunResult {
  seed: number;
  startQ: number;
  shareQ: number;
  population: number;
}

function runScenario(config: typeof TURF_CONFIG, seed: number): RunResult {
  const engine = new SimulationEngine({ seed, config });
  seedTopologicalVariation(engine);
  const startQ = memoryShareQ(engine);
  engine.stepMany(SELECTION_HORIZON);
  return {
    seed,
    startQ,
    shareQ: memoryShareQ(engine),
    population: engine.organisms.liveCount,
  };
}

const mean = (runs: RunResult[]): number =>
  runs.reduce((total, run) => total + run.shareQ, 0) / runs.length;

describe("selection sorts standing topological variation", { timeout: 3_600_000 }, () => {
  const turf = SELECTION_SEEDS.map((seed) => runScenario(TURF_CONFIG, seed));
  const patchwork = SELECTION_SEEDS.map((seed) => runScenario(PATCHWORK_CONFIG, seed));

  it("starts both worlds at an even split, and neither dies out", () => {
    // Both halves of the claim below are shares, so a run that went extinct or
    // started tilted would produce a number that means nothing.
    for (const run of [...turf, ...patchwork]) {
      expect(Math.abs(run.startQ - Q / 2)).toBeLessThan(Q / 50);
      expect(run.population).toBeGreaterThan(0);
    }
  });

  it("selects against memory where there is nothing to remember", () => {
    // Claim 1. Registers cost upkeep every tick they are retained, and on the
    // turf the right action is always derivable from the current senses, so
    // there is nothing for that upkeep to buy. If this did not fall, M16's cost
    // would be decorative and CLAUDE.md's trade-off rule would be violated.
    expect(mean(turf)).toBeLessThan(TURF_CEILING_Q);
    for (const run of turf) {
      expect(run.shareQ).toBeLessThan(Q / 2);
    }
  });

  it("does not price memory out where it can pay", () => {
    // Claim 2, and the reachability claim proper. The same registers at the
    // same cost, in a world where rich patches are separated by ground the
    // senses report nothing useful about. If this fell too, memory would be a
    // trait evolution can never afford whatever the capability fixtures show.
    expect(mean(patchwork)).toBeGreaterThan(PATCHWORK_FLOOR_Q);
    for (const run of patchwork) {
      expect(run.shareQ).toBeGreaterThan(TURF_CEILING_Q / 2);
    }
  });

  it("moves the same founder population in opposite directions", () => {
    // The two claims together, which is the only form in which either means
    // anything: one seeded 50/50 population, two ordinary worlds, no fitness
    // assigned and no topology bit touched after tick 0. The environment
    // decides whether memory is worth its upkeep — the engine has no opinion.
    expect(mean(patchwork) - mean(turf)).toBeGreaterThan(SEPARATION_FLOOR_Q);
    for (let i = 0; i < SELECTION_SEEDS.length; i += 1) {
      const turfRun = turf[i] as RunResult;
      const patchworkRun = patchwork[i] as RunResult;
      expect(patchworkRun.shareQ).toBeGreaterThan(turfRun.shareQ);
    }
  });
});
