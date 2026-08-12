import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, clampQ, qmul } from "../math/fixed";
import type { EnvironmentStore } from "./EnvironmentStore";
import { Biome } from "./biomes";

/**
 * Plants as a biomass field (docs/03 §§20-22, task C06/C07).
 *
 * Plants are never individual entities. Each environment cell carries a
 * biomass value and a carrying capacity; growth is logistic and runs on the
 * scheduled environment update, not every tick.
 */

/** Uint16 ceiling for the biomass/capacity arrays. */
const MAX_BIOMASS = 65535;

/**
 * Triangular suitability in [0, Q]: 1.0 at `optimum`, falling linearly to 0 at
 * `optimum ± tolerance`.
 *
 * A triangle rather than a bell curve because it is exact in integer math —
 * docs/03 §3 forbids transcendental math in authoritative paths where a
 * deterministic alternative exists, and the shape only has to be monotone and
 * plausible, not physically derived.
 */
export function temperatureSuitabilityQ(
  temperatureCentiC: number,
  optimumCentiC: number,
  toleranceCentiC: number,
): number {
  if (toleranceCentiC <= 0) {
    return temperatureCentiC === optimumCentiC ? Q : 0;
  }
  const distance = Math.abs(temperatureCentiC - optimumCentiC);
  if (distance >= toleranceCentiC) {
    return 0;
  }
  return Math.trunc(((toleranceCentiC - distance) * Q) / toleranceCentiC);
}

/** Moisture suitability in [0, Q]: 0 at or below `minQ`, 1.0 at or above `fullQ`. */
export function moistureSuitabilityQ(moistureQ: number, minQ: number, fullQ: number): number {
  if (moistureQ <= minQ) {
    return 0;
  }
  if (moistureQ >= fullQ || fullQ <= minQ) {
    return Q;
  }
  return Math.trunc(((moistureQ - minQ) * Q) / (fullQ - minQ));
}

/**
 * Carrying capacity of one cell (docs/03 §20):
 * biome base × fertility × moisture suitability × temperature suitability.
 *
 * Water always yields 0 while aquatic life is out of MVP scope.
 */
export function computePlantCapacity(
  config: DeepReadonly<SimulationConfig>,
  biome: number,
  fertilityQ: number,
  moistureQ: number,
  temperatureCentiC: number,
): number {
  const base = config.plants.baseCapacityByBiome[biome] ?? 0;
  if (base === 0) {
    return 0;
  }
  const suitability = config.plants.capacitySuitability;
  const tempQ = temperatureSuitabilityQ(
    temperatureCentiC,
    suitability.optimumTemperatureCentiC,
    suitability.temperatureToleranceCentiC,
  );
  if (tempQ === 0) {
    return 0;
  }
  const moistQ = moistureSuitabilityQ(
    moistureQ,
    suitability.minMoistureQ,
    suitability.fullMoistureQ,
  );
  if (moistQ === 0) {
    return 0;
  }

  let capacity = qmul(base, clampQ(fertilityQ));
  capacity = qmul(capacity, moistQ);
  capacity = qmul(capacity, tempQ);
  return clamp(capacity, 0, MAX_BIOMASS);
}

/** Recompute capacity for every cell. Used after generation and terrain edits. */
export function recomputeAllPlantCapacities(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  for (let i = 0; i < environment.cellCount; i += 1) {
    const capacity = computePlantCapacity(
      config,
      environment.biome[i] as number,
      environment.fertilityQ[i] as number,
      environment.getMoistureQ(i),
      environment.getTemperatureCentiC(i),
    );
    environment.plantCapacity[i] = capacity;
    // Biomass can never exceed a shrunken capacity (docs/03 §27 invariant).
    if ((environment.plantBiomass[i] as number) > capacity) {
      environment.plantBiomass[i] = capacity;
    }
  }
}

/**
 * One logistic growth step for the whole grid (docs/03 §20):
 *
 *   delta = rate × biomass × (capacity − biomass) / capacity
 *
 * plus a small seed-bank term so a cell emptied to exactly zero can recover.
 * Without it, `delta` is 0 forever once biomass hits 0 and grazing would
 * permanently sterilise a cell.
 *
 * Runs on the scheduled environment update, so `rate` is per environment step,
 * not per tick.
 */
export function growPlants(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  const { growthRateQByBiome, plantSeedBankRegenUnits, plantMinRegenThreshold } = config.plants;
  const { plantBiomass, plantCapacity, plantGrowthRemainderQ, biome } = environment;

  for (let i = 0; i < environment.cellCount; i += 1) {
    const capacity = plantCapacity[i] as number;
    if (capacity === 0) {
      plantBiomass[i] = 0;
      plantGrowthRemainderQ[i] = 0;
      continue;
    }

    const biomass = plantBiomass[i] as number;
    const rateQ = growthRateQByBiome[biome[i] as number] ?? 0;

    let next = biomass;
    let remainder = plantGrowthRemainderQ[i] as number;

    if (rateQ > 0 && biomass > 0) {
      const headroom = capacity - biomass;
      if (headroom > 0) {
        // Q-scaled logistic delta, computed as one expression so the division
        // by capacity happens last. The largest possible numerator is
        // Q × 65535 × 65535 ≈ 1.8e13, comfortably exact as a double.
        const deltaQ = Math.trunc((rateQ * biomass * headroom) / capacity);

        // Carry the fraction. Without this, any cell whose true growth is below
        // one unit per step — every sparsely vegetated cell, and every cell at
        // all in a slow biome — would truncate to zero growth and freeze.
        const totalQ = deltaQ + remainder;
        const whole = Math.trunc(totalQ / Q);
        remainder = totalQ - whole * Q;
        next += whole;
      }
    }

    // Seed bank: a deterministic trickle that lifts a cell off exactly zero,
    // where the logistic term is identically zero (docs/03 §20).
    if (next < plantMinRegenThreshold) {
      next += plantSeedBankRegenUnits;
    }

    if (next >= capacity) {
      next = capacity;
      // At capacity there is nothing left to carry.
      remainder = 0;
    } else if (next < 0) {
      next = 0;
    }

    plantBiomass[i] = next;
    plantGrowthRemainderQ[i] = remainder;
  }
}

/**
 * Local plant gradient for organism sensing (docs/03 §22).
 *
 * Organisms never see individual plants: they read local density plus this
 * central difference of the biomass field, normalized to Q against the cell's
 * own capacity so that "food is that way" means the same thing in a desert and
 * in a forest. Border cells sample themselves on the missing side.
 *
 * ## Why this is computed on demand rather than cached
 *
 * It WAS a cached array refreshed by the environment update. That was correct
 * only while nothing changed biomass between updates. Once organisms started
 * grazing every tick, the cache became a derived value whose inputs moved
 * faster than its refresh: it was up to 20 ticks stale, and — worse — a
 * snapshot restore recomputed it from the *current* biomass, so a resumed run
 * sensed a slightly different world than the continuous one and diverged.
 * docs/10 §17 names exactly this trap: a cache that can influence future state
 * must be hashed or provably recomputable, and this one was neither.
 *
 * Computing it where it is consumed makes it a pure function of the biomass
 * field, always fresh and never serialized. It also costs less: a handful of
 * reads per organism per tick against a 65 536-cell sweep every 20 ticks.
 * Sensing runs before feeding in the tick order, so every organism still reads
 * one coherent snapshot of the field (docs/03 §9).
 */
export function plantGradientXQAt(environment: EnvironmentStore, cell: number): number {
  const { size, plantBiomass } = environment;
  const gx = cell % size;
  const left = plantBiomass[gx > 0 ? cell - 1 : cell] as number;
  const right = plantBiomass[gx < size - 1 ? cell + 1 : cell] as number;
  return gradientQ(right - left, environment.plantCapacity[cell] as number);
}

/** Vertical counterpart of {@link plantGradientXQAt}; +y is south on screen. */
export function plantGradientYQAt(environment: EnvironmentStore, cell: number): number {
  const { size, plantBiomass } = environment;
  const gy = (cell - (cell % size)) / size;
  const up = plantBiomass[gy > 0 ? cell - size : cell] as number;
  const down = plantBiomass[gy < size - 1 ? cell + size : cell] as number;
  return gradientQ(down - up, environment.plantCapacity[cell] as number);
}

/** Normalize a central difference against the local capacity, clamped to ±Q. */
function gradientQ(difference: number, capacity: number): number {
  // A non-zero reference so barren cells report 0 instead of dividing by zero.
  const reference = Math.max(capacity, 1);
  return clamp(Math.trunc((difference * Q) / (2 * reference)), -Q, Q);
}

/** Total plant biomass across the world (diagnostics and validity checks). */
export function totalPlantBiomass(environment: EnvironmentStore): number {
  let total = 0;
  for (let i = 0; i < environment.cellCount; i += 1) {
    total += environment.plantBiomass[i] as number;
  }
  return total;
}

/** Total carrying capacity across the world (world validity, docs/03 §15). */
export function totalPlantCapacity(environment: EnvironmentStore): number {
  let total = 0;
  for (let i = 0; i < environment.cellCount; i += 1) {
    total += environment.plantCapacity[i] as number;
  }
  return total;
}

/** True when the cell is land that can support plants at all. */
export function isProductiveLand(environment: EnvironmentStore, index: number): boolean {
  return (
    environment.biome[index] !== Biome.Water && (environment.plantCapacity[index] as number) > 0
  );
}
