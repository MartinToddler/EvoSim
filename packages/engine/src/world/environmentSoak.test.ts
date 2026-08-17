import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q } from "../math/fixed";
import { Biome } from "./biomes";
import { totalPlantBiomass, totalPlantCapacity } from "./plants";

/**
 * Environment soak (Milestone 2 acceptance, docs/03 §27: "environment update
 * remains valid after 100k headless ticks"; docs/07 §6 makes 100k the routine
 * development soak).
 *
 * 100 000 ticks is 5 000 scheduled environment updates. What this really tests
 * is that nothing drifts over a long run: no Uint16 wrap, no biomass creeping
 * above capacity, no cell silently frozen, and the same seed still landing on
 * the same state.
 *
 * ## Why this world is lifeless
 *
 * It runs the reference world geometry with `initialOrganisms = 0`. Up to
 * Milestone 3 the founder cohort died out by tick 6 100 and the remaining 94% of
 * the run was already an empty world, so the distinction did not exist; the
 * assertions below — vegetation rising toward carrying capacity and saturating
 * — describe the plant model, and were only ever true because grazing was
 * negligible.
 *
 * Milestone 4 made the population persistent, which both invalidated those
 * assertions and multiplied the run's cost by ~40x. Splitting the two concerns
 * is strictly more coverage than before, not less: this file pins the
 * environment model in isolation over 100 000 ticks, and `soak.test.ts` pins the
 * environment AND a reproducing population over another 100 000 ticks.
 *
 * Determinism is checked against a recorded hash rather than by running a
 * second engine: it costs half the time and is strictly stronger, because a
 * golden also catches drift between platforms and between engine versions,
 * which two runs in the same process cannot.
 */
describe("100k tick environment soak", () => {
  const SOAK_TICKS = 100_000;
  /**
   * State hash after 100 000 ticks for seed 0xE0A12026 + the lifeless reference
   * world. Regenerate together with the golden fixture whenever ENGINE_VERSION
   * changes.
   */
  // Engine 0.7.0 moved this hash with no ecological change: the founder
  // region and the (empty) command log joined the canonical stream, event
  // payloads became signed 32-bit words, and the config digest gained the
  // interventions section. The world itself is untouched — no command ever
  // runs here.
  //
  // Engine 0.8.0 moved it through the config calibration alone (ADR 0025):
  // a lifeless world has no feeder for the expected-gain rule to steer and no
  // carcasses to rot, but every cell's capacity is 0.6x what it was and the
  // config digest in the hash stream carries the new decay value.
  const GOLDEN_SOAK_HASH = "1049774f50276cdf";

  const LIFELESS_CONFIG = (() => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.world.initialOrganisms = 0;
    return config;
  })();

  // 100 000 environment-only ticks. The budget matches the other soaks': it
  // exists to catch a hang, not to assert a wall clock on unknown hardware
  // (docs/07 §8). 300 s was the number that proved too tight for the populated
  // 10 000-tick tests under parallel-worker contention.
  it("stays valid and deterministic across 100k ticks", { timeout: 1_800_000 }, () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: LIFELESS_CONFIG });
    const { environment } = engine;
    expect(engine.organisms.liveCount).toBe(0);

    const initialBiomass = totalPlantBiomass(environment);
    const capacity = totalPlantCapacity(environment);

    engine.stepMany(SOAK_TICKS / 2);
    const midpointBiomass = totalPlantBiomass(environment);
    engine.stepMany(SOAK_TICKS / 2);
    const finalBiomass = totalPlantBiomass(environment);

    expect(engine.tick).toBe(SOAK_TICKS);

    // Invariants after 5 000 environment updates. Scanned in a plain loop and
    // asserted once: an expect() per cell would cost more than the simulation.
    let overCapacity = 0;
    let remainderOutOfRange = 0;
    let vegetatedWater = 0;
    for (let i = 0; i < environment.cellCount; i += 1) {
      if ((environment.plantBiomass[i] as number) > (environment.plantCapacity[i] as number)) {
        overCapacity += 1;
      }
      if ((environment.plantGrowthRemainderQ[i] as number) >= Q) {
        remainderOutOfRange += 1;
      }
      if (environment.biome[i] === Biome.Water && (environment.plantBiomass[i] as number) !== 0) {
        vegetatedWater += 1;
      }
    }
    expect({ overCapacity, remainderOutOfRange, vegetatedWater }).toEqual({
      overCapacity: 0,
      remainderOutOfRange: 0,
      vegetatedWater: 0,
    });

    // Vegetation grows from the configured half-capacity start toward carrying
    // capacity, and saturates rather than growing without bound. With nothing
    // alive to graze it, this is the plant model on its own.
    expect(midpointBiomass).toBeGreaterThan(initialBiomass);
    expect(finalBiomass).toBeGreaterThanOrEqual(midpointBiomass);
    expect(finalBiomass).toBeLessThanOrEqual(capacity);
    expect(finalBiomass - midpointBiomass).toBeLessThan(finalBiomass / 10);

    expect(engine.computeStateHash()).toBe(GOLDEN_SOAK_HASH);
  });
});
