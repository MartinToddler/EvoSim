import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import {
  SCENARIO_CHANNEL_TICK,
  SCENARIO_CONFIG,
  SCENARIO_SEED,
  SCENARIO_SPLIT_HORIZON,
  queueScenarioChannel,
  queueScenarioClimate,
} from "./fixtures/speciationScenario";
import { WorldEventType } from "./history/EventStore";

/**
 * MVP release gate 6 (docs/01 §12; docs/07 §16 third bullet; ADR 0025 §3):
 * at least one calibrated fragmented/environmentally divergent run creates an
 * automatic species split — ecological, not synthetic.
 *
 * The synthetic fixtures (ADR 0013) prove the detector splits real bimodality
 * and refuses noise; every long run of the undivided reference world proves it
 * keeps refusing a continuous cloud. What none of those could show is
 * REACHABILITY: that a world nobody hand-built can get from one founder clone
 * to two detected species through nothing but the engine's own rules. This run
 * shows it: one continent, a flooded channel (ordinary player terrain
 * commands), two isolated demes, and mutation + selection until the detector —
 * unchanged in kind, thresholds calibrated for this world and documented in
 * the fixture — declares the split on its own.
 *
 * The assertion is a horizon, not a tick: the split must have happened by
 * SCENARIO_SPLIT_HORIZON (measured at ~73 000, asserted with ~23% headroom),
 * which is the non-brittle form docs/07 §16 asks for. Determinism still holds
 * — same seed, config and engine replay the identical history — but the test
 * does not encode the incidental tick.
 *
 * Cost: over an hour — a 192×192 world stepped up to 90 000 ticks. It sits
 * beside the 100 000-tick soak in the "inherently long determinism tests"
 * budget class (docs/07 §8: hang detector, not a wall-clock assertion), and the
 * timeout is sized for a contended machine rather than a quiet one.
 */

describe("ecological speciation reachability (release gate 6)", () => {
  it(
    "a flooded channel splits one founder lineage into two detected species",
    { timeout: 14_400_000 },
    () => {
      const engine = new SimulationEngine({ seed: SCENARIO_SEED, config: SCENARIO_CONFIG });
      const queued = queueScenarioChannel(engine) + queueScenarioClimate(engine);
      expect(queued).toBeGreaterThan(0);

      // Run to the channel, confirm the world still has its one species and
      // both hemispheres are inhabited — the divergence must start from a
      // connected, spread population, or this test proves nothing.
      engine.stepMany(SCENARIO_CHANNEL_TICK);
      expect(engine.species.activeCount).toBe(1);
      const halfPos = (engine.config.world.sizeLU / 2) * 256;
      let north = 0;
      let south = 0;
      for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
        if (engine.organisms.alive[slot] !== 1) continue;
        if ((engine.organisms.y[slot] as number) < halfPos) north += 1;
        else south += 1;
      }
      expect(north).toBeGreaterThan(0);
      expect(south).toBeGreaterThan(0);

      // Step to the horizon in analysis-sized bites, stopping at the first
      // split so the assertion also records WHEN reachability was proven.
      let splitTick: number | null = null;
      while (engine.tick < SCENARIO_SPLIT_HORIZON) {
        engine.stepMany(Math.min(2_000, SCENARIO_SPLIT_HORIZON - engine.tick));
        expect(engine.organisms.liveCount).toBeGreaterThan(0);
        if (engine.species.activeCount >= 2) {
          splitTick = engine.tick;
          break;
        }
      }

      expect(
        splitTick,
        `no automatic species split by tick ${SCENARIO_SPLIT_HORIZON}`,
      ).not.toBeNull();

      // The split is the engine's own event, attributed and typed.
      expect(engine.events.events.some((event) => event.type === WorldEventType.SpeciesSplit)).toBe(
        true,
      );
    },
  );
});
