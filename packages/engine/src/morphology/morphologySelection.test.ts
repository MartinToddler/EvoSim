import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import {
  ARCHIPELAGO_CONFIG,
  SELECTION_HORIZON,
  SELECTION_SEEDS,
  TURF_CONFIG,
  mobileShareQ,
  morphLimbBounds,
  seedMorphologicalVariation,
} from "../fixtures/morphologySelection";
import { Q } from "../math/fixed";

/**
 * M15 evolutionary reachability (CLAUDE.md "Evolutionary accessibility rule",
 * docs/11 §M15, ADR 0029 §5).
 *
 * The claim under test is the one the milestone exists to support: **two
 * ordinary worlds move the same founder population's body plan in opposite
 * directions, judged by nothing but who survived and reproduced.**
 *
 * Both runs start from an identical 50/50 mix of two locomotor morphs — long
 * limbs and a long tail against stubs — seeded as ordinary organisms with
 * identical ecological genes, identical brains and the same fraction of their
 * own body's maximum energy. From tick 1 nothing distinguishes them: no
 * fitness is assigned, no body is scored, no morphological gene is touched, and
 * the engine has no idea the two groups exist.
 *
 * On the turf, food is thin, everywhere, and grows back — so a propulsive
 * apparatus is a bill with nothing to buy, and the mobile share falls. In the
 * archipelago the same apparatus is what crosses the water between fragments,
 * and it rises. The measured trajectories are in ADR 0029 §5c.
 */

/** Where a run must have moved from the 50/50 start to count as a direction. */
const DECISIVE_MARGIN_Q = Math.round(Q * 0.04);

interface RunResult {
  seed: number;
  shareQ: number;
  population: number;
}

function runScenario(config: typeof TURF_CONFIG, seed: number): RunResult {
  const bounds = morphLimbBounds(config);
  const engine = new SimulationEngine({ seed, config });
  seedMorphologicalVariation(engine);
  // The seeding is exactly half and half, or the experiment starts tilted.
  expect(Math.abs(mobileShareQ(engine, bounds) - Q / 2)).toBeLessThan(Q / 50);
  engine.stepMany(SELECTION_HORIZON);
  return {
    seed,
    shareQ: mobileShareQ(engine, bounds),
    population: engine.organisms.liveCount,
  };
}

describe("morphology evolves, and the world decides which way (M15)", () => {
  it(
    "the turf selects against a propulsive apparatus and the archipelago selects for one",
    { timeout: 3_600_000 },
    () => {
      const turf: RunResult[] = [];
      const archipelago: RunResult[] = [];
      for (const seed of SELECTION_SEEDS) {
        turf.push(runScenario(TURF_CONFIG, seed));
        archipelago.push(runScenario(ARCHIPELAGO_CONFIG, seed));
      }

      // A run that went extinct measured nothing, and silently passing on one
      // would turn this gate into a test of whether the world survived.
      for (const run of [...turf, ...archipelago]) {
        expect(`seed 0x${run.seed.toString(16)} population`).toBe(
          run.population > 0
            ? `seed 0x${run.seed.toString(16)} population`
            : `seed 0x${run.seed.toString(16)} went extinct`,
        );
      }

      const mean = (runs: RunResult[]): number =>
        runs.reduce((total, run) => total + run.shareQ, 0) / runs.length;
      const turfMean = mean(turf);
      const archipelagoMean = mean(archipelago);

      // Each world moved off the 50/50 start, in its own direction...
      expect(turfMean).toBeLessThan(Q / 2 - DECISIVE_MARGIN_Q);
      expect(archipelagoMean).toBeGreaterThan(Q / 2 + DECISIVE_MARGIN_Q);
      // ...and they are on opposite sides of it, which is the whole claim.
      expect(archipelagoMean - turfMean).toBeGreaterThan(2 * DECISIVE_MARGIN_Q);

      // The direction is a property of the world, not of one lucky stream: a
      // majority of seeds must agree with their world's mean. Stated as a
      // majority rather than as unanimity because these are stochastic runs and
      // demanding a fixed outcome on every seed is the brittle shape ADR 0027
      // §3b forbids.
      const turfAgreeing = turf.filter((run) => run.shareQ < Q / 2).length;
      const archipelagoAgreeing = archipelago.filter((run) => run.shareQ > Q / 2).length;
      expect(turfAgreeing * 2).toBeGreaterThan(SELECTION_SEEDS.length);
      expect(archipelagoAgreeing * 2).toBeGreaterThan(SELECTION_SEEDS.length);
    },
  );
});
