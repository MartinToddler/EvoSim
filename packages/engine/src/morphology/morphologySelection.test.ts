import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import {
  PATCHWORK_CONFIG,
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
 * own body's maximum energy. From tick 1 nothing distinguishes them: no fitness
 * is assigned, no body is scored, no morphological gene is touched, and the
 * engine has no idea the two groups exist.
 *
 * On the turf, food is thin, everywhere, and grows back, so a propulsive
 * apparatus is a bill with nothing to buy. On the patchwork the same apparatus
 * is what reaches the next patch across barren ground. Measured trajectories and
 * the two scenario designs that failed first are in ADR 0029 §5.
 */

/** Measured margins, with headroom. See the table in ADR 0029 §5e. */
const PATCHWORK_FLOOR_Q = Math.round(Q * 0.65);
const TURF_CEILING_Q = Math.round(Q * 0.55);
const SEPARATION_FLOOR_Q = Math.round(Q * 0.2);

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

const mean = (runs: RunResult[]): number =>
  runs.reduce((total, run) => total + run.shareQ, 0) / runs.length;

describe("morphology evolves, and the world decides which way (M15)", () => {
  it(
    "the turf selects against a propulsive apparatus and the patchwork selects for one",
    { timeout: 3_600_000 },
    () => {
      const turf: RunResult[] = [];
      const patchwork: RunResult[] = [];
      for (const seed of SELECTION_SEEDS) {
        turf.push(runScenario(TURF_CONFIG, seed));
        patchwork.push(runScenario(PATCHWORK_CONFIG, seed));
      }

      // A run that went extinct measured nothing, and silently passing on one
      // would turn this gate into a test of whether the world survived.
      for (const run of [...turf, ...patchwork]) {
        expect(`seed 0x${run.seed.toString(16)} population`).toBe(
          run.population > 0
            ? `seed 0x${run.seed.toString(16)} population`
            : `seed 0x${run.seed.toString(16)} went extinct`,
        );
      }

      const turfMean = mean(turf);
      const patchworkMean = mean(patchwork);

      // The core claim: the two worlds are far apart, and on the sides the
      // mechanism predicts.
      expect(patchworkMean - turfMean).toBeGreaterThan(SEPARATION_FLOOR_Q);
      expect(patchworkMean).toBeGreaterThan(PATCHWORK_FLOOR_Q);
      expect(turfMean).toBeLessThan(TURF_CEILING_Q);

      // And the direction is a property of the world rather than of one lucky
      // stream. The patchwork's effect is large enough to demand every seed;
      // the turf's is smaller, so a majority is what is asserted there —
      // demanding a fixed outcome on every stochastic run is the brittle shape
      // ADR 0027 §3b forbids.
      for (const run of patchwork) {
        expect(`patchwork 0x${run.seed.toString(16)}: ${run.shareQ}`).toBe(
          run.shareQ > Q / 2
            ? `patchwork 0x${run.seed.toString(16)}: ${run.shareQ}`
            : `patchwork 0x${run.seed.toString(16)} did not favour mobility`,
        );
      }
      const turfAgreeing = turf.filter((run) => run.shareQ < Q / 2).length;
      expect(turfAgreeing * 2).toBeGreaterThan(SELECTION_SEEDS.length);
    },
  );
});
