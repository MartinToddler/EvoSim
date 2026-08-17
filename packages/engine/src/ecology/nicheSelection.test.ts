import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import {
  NICHE_HORIZON,
  NICHE_SEEDS,
  NICHE_WORLDS,
  argmax,
  intakeShares,
  seedProcessingVariation,
  specialistShares,
} from "../fixtures/nicheSelection";
import { RESOURCE_COUNT, RESOURCE_NAMES } from "../world/resources";

/**
 * M17's acceptance criterion, run on the ordinary engine (docs/11 §M17,
 * ADR 0031 §5d).
 *
 * The criterion is that **no single resource strategy is structurally
 * universal**: there must be no channel that the population sorts onto in every
 * world, whatever the world offers. A channel that wins everywhere is a
 * universal strategy wearing five names, and it fails the milestone whether it
 * arises from an energy table, an efficiency curve or an access factor.
 *
 * What is measured is each organism's argmax processing locus — a derived
 * observational label (ADR 0027). The engine never reads it, nothing branches
 * on it, and an organism counted as "roots" here is not a `RootEater` anywhere:
 * it eats whatever the expected-gain rule picks from what is underfoot.
 *
 * The fixture deals the six specialists across the founders so that selection
 * has standing variation to sort, for the reason ADR 0029 §5a gives — a
 * population founded on one genome has none until mutation supplies it, which
 * takes far longer than a gate can run.
 *
 * ## Why this file exists at all
 *
 * The fixture and the measurements in ADR 0031 §5d predate it: the table was
 * produced by an ad-hoc script and written into the ADR, with nothing in the
 * suite to keep it true. That is not what CLAUDE.md's evolutionary
 * accessibility rule asks for, and it went stale exactly as an unenforced
 * measurement does — closing the seed-bank floor (ADR 0031 §5e) invalidated the
 * whole table, and no test said so.
 */

/** Every world must still be alive at the horizon, or its label means nothing. */
const MIN_SURVIVING_POPULATION = 100;

interface Outcome {
  readonly world: string;
  readonly seed: number;
  readonly population: number;
  readonly winner: number;
  readonly shares: readonly number[];
  readonly intake: readonly number[];
}

function runWorld(world: (typeof NICHE_WORLDS)[number], seed: number): Outcome {
  const engine = new SimulationEngine({ seed, config: world.config });
  seedProcessingVariation(engine);
  engine.stepMany(NICHE_HORIZON);
  const shares = specialistShares(engine);
  return {
    world: world.name,
    seed,
    population: engine.organisms.liveCount,
    winner: argmax(shares),
    shares,
    intake: intakeShares(engine),
  };
}

/** The channel a majority of a world's seeds sorted onto, or -1 if they disagree entirely. */
function majorityWinner(outcomes: readonly Outcome[]): number {
  const counts = new Array<number>(RESOURCE_COUNT).fill(0);
  for (const outcome of outcomes) {
    counts[outcome.winner] = (counts[outcome.winner] as number) + 1;
  }
  const best = argmax(counts);
  return (counts[best] as number) > 1 ? best : -1;
}

describe("M17 niche selection", { timeout: 3_600_000 }, () => {
  const byWorld = NICHE_WORLDS.map((world) => ({
    world,
    outcomes: NICHE_SEEDS.map((seed) => runWorld(world, seed)),
  }));

  for (const { world, outcomes } of byWorld) {
    it(`${world.name} sustains a population that can be read`, () => {
      for (const outcome of outcomes) {
        expect(
          outcome.population,
          `${outcome.world} seed 0x${outcome.seed.toString(16)} ended with ` +
            `${outcome.population} organisms; a dying world's argmax is noise, not selection`,
        ).toBeGreaterThanOrEqual(MIN_SURVIVING_POPULATION);
      }
    });
  }

  it("has no channel that wins every world", () => {
    const winners = byWorld.map(({ world, outcomes }) => ({
      name: world.name,
      winner: majorityWinner(outcomes),
      perSeed: outcomes.map((outcome) => RESOURCE_NAMES[outcome.winner]),
    }));

    for (const entry of winners) {
      // Recorded on failure so a re-measurement does not need a re-run.
      expect(
        entry.winner,
        `${entry.name} seeds disagreed entirely (${entry.perSeed.join(", ")}); ` +
          `the outcome should be a property of the world, not of the seed`,
      ).toBeGreaterThanOrEqual(0);
    }

    const distinct = new Set(winners.map((entry) => entry.winner));
    expect(
      distinct.size,
      `every world sorted onto ${RESOURCE_NAMES[winners[0]?.winner ?? 0]}: ` +
        `that is a universal strategy, which is what this milestone forbids`,
    ).toBeGreaterThan(1);
  });
});
