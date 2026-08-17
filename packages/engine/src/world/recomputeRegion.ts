import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { clamp } from "../math/fixed";
import { PLANT_RESOURCE_COUNT } from "./resources";
import { Biome, classifyBiome } from "./biomes";
import type { EnvironmentStore } from "./EnvironmentStore";
import { computeResourceCapacity } from "./plants";

/**
 * Recompute the derived environment fields of a cell region after a persistent
 * player edit (docs/03 §19 "Recompute affected cells after persistent edits",
 * docs/10 §5 `recomputeRegion`).
 *
 * Applies EXACTLY the pipeline world generation runs, over effective values
 * (base + player offsets): biome classification, then plant capacity, then the
 * docs/03 §27 biomass-within-capacity clamp, then passability. A pristine
 * world recomputed through this function is byte-identical to itself — a test
 * pins that — which is what guarantees an edit changes precisely the cells it
 * touched and nothing else.
 *
 * The clamp means a climate or terrain edit re-grounds any biomass above the
 * NEW capacity immediately: a flooded forest loses its plants with the land.
 * The one sanctioned way biomass may exceed capacity — the ADD_BIOMASS
 * transient overfill (docs/03 §27) — does not pass through here, because
 * biomass edits change no classification input.
 *
 * Bounds are inclusive grid coordinates; callers clamp to the grid.
 */
export function recomputeDerivedRegion(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
  gxMin: number,
  gyMin: number,
  gxMax: number,
  gyMax: number,
): void {
  const size = environment.size;
  const x0 = clamp(gxMin, 0, size - 1);
  const y0 = clamp(gyMin, 0, size - 1);
  const x1 = clamp(gxMax, 0, size - 1);
  const y1 = clamp(gyMax, 0, size - 1);

  const thresholds = {
    seaLevelQ: config.world.seaLevelQ,
    mountainLevelQ: config.world.mountainLevelQ,
    ...config.world.biomeThresholds,
  };

  for (let gy = y0; gy <= y1; gy += 1) {
    const rowBase = gy * size;
    for (let gx = x0; gx <= x1; gx += 1) {
      const i = rowBase + gx;
      const biome = classifyBiome(
        {
          elevationQ: environment.elevationQ[i] as number,
          moistureQ: environment.getMoistureQ(i),
          fertilityQ: environment.fertilityQ[i] as number,
          temperatureCentiC: environment.getTemperatureCentiC(i),
        },
        thresholds,
      );
      environment.biome[i] = biome;

      // Every channel, not just one: a terrain edit that turns forest into
      // desert has to move all five capacities, or the channels the edit should
      // have destroyed keep standing on ground that no longer supports them.
      for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
        const flat = resource * environment.cellCount + i;
        const capacity = computeResourceCapacity(
          config,
          resource,
          biome,
          environment.fertilityQ[i] as number,
          environment.getMoistureQ(i),
          environment.getTemperatureCentiC(i),
          environment.elevationQ[i] as number,
        );
        environment.resourceCapacity[flat] = capacity;
        if ((environment.resourceBiomass[flat] as number) > capacity) {
          environment.resourceBiomass[flat] = capacity;
          // A cell clamped to (or below) capacity has no growth fraction to carry.
          if (capacity === 0) {
            environment.plantGrowthRemainderQ[flat] = 0;
          }
        }
      }
      environment.passable[i] = biome === Biome.Water ? 0 : 1;
    }
  }
}
