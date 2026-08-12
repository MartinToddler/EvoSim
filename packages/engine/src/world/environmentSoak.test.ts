import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../SimulationEngine";
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
 * Determinism is checked against a recorded hash rather than by running a
 * second engine: it costs half the time and is strictly stronger, because a
 * golden also catches drift between platforms and between engine versions,
 * which two runs in the same process cannot.
 */
describe("100k tick environment soak", () => {
  const SOAK_TICKS = 100_000;
  /**
   * State hash after 100 000 ticks for seed 0xE0A12026 + DEFAULT_CONFIG.
   * Regenerate together with the golden fixture whenever ENGINE_VERSION changes.
   */
  const GOLDEN_SOAK_HASH = "f88b60bb3f502983";

  it("stays valid and deterministic across 100k ticks", { timeout: 300_000 }, () => {
    const engine = new SimulationEngine({ seed: 0xe0a12026, config: DEFAULT_CONFIG });
    const { environment } = engine;

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

    // Ungrazed vegetation grows from the configured half-capacity start toward
    // carrying capacity, and saturates rather than growing without bound.
    expect(midpointBiomass).toBeGreaterThan(initialBiomass);
    expect(finalBiomass).toBeGreaterThanOrEqual(midpointBiomass);
    expect(finalBiomass).toBeLessThanOrEqual(capacity);
    expect(finalBiomass - midpointBiomass).toBeLessThan(finalBiomass / 10);

    expect(engine.computeStateHash()).toBe(GOLDEN_SOAK_HASH);
  });
});
