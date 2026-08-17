import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, clampQ, qmul } from "../math/fixed";
import type { EnvironmentStore } from "./EnvironmentStore";
import { Biome } from "./biomes";
import { PLANT_RESOURCE_COUNT } from "./resources";

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
 * Carrying capacity of one channel in one cell (docs/03 §20 as amended by M17):
 * biome base × fertility × moisture suitability × temperature suitability.
 *
 * The shape is what it always was. What M17 changes is that every factor is now
 * read from the **channel's own** profile, so the same cell can be excellent
 * foliage ground and hopeless for roots, or the reverse. That is the whole
 * mechanism behind "different places offer different livings" (docs/11 §M17):
 * no code decides that a place is a niche, it simply happens that the five
 * suitability curves peak in different parts of the world.
 *
 * Fertility enters through a per-channel exponent-free lever instead of being
 * applied identically: `fertilityWeightQ` mixes the cell's fertility with 1, so
 * a channel with weight 0 ignores fertility entirely and one with weight Q is
 * as fertility-hungry as the Milestone 0–16 field was. Roots and defended
 * growth use low weights, which is what lets them hold the ground that nothing
 * else will grow on.
 *
 * Water always yields 0 in every channel while aquatic life is out of scope.
 */
export function computeResourceCapacity(
  config: DeepReadonly<SimulationConfig>,
  resource: number,
  biome: number,
  fertilityQ: number,
  moistureQ: number,
  temperatureCentiC: number,
  elevationQ: number,
): number {
  const profile = config.plants.resources[resource];
  if (profile === undefined) {
    return 0;
  }
  const base = profile.baseCapacityByBiome[biome] ?? 0;
  if (base === 0) {
    return 0;
  }
  const tempQ = temperatureSuitabilityQ(
    temperatureCentiC,
    profile.optimumTemperatureCentiC,
    profile.temperatureToleranceCentiC,
  );
  if (tempQ === 0) {
    return 0;
  }
  const moistQ = moistureSuitabilityQ(moistureQ, profile.minMoistureQ, profile.fullMoistureQ);
  if (moistQ === 0) {
    return 0;
  }

  // Fertility mixed toward 1 by the channel's own weight, so a channel can be
  // indifferent to it. `Q - weight + weight * fertility` in Q arithmetic.
  const weightQ = clampQ(profile.fertilityWeightQ);
  const fertilityMixQ = Q - weightQ + qmul(weightQ, clampQ(fertilityQ));

  // Elevation preference, same triangular shape as temperature: a channel with
  // full tolerance is flat and pays nothing for terrain.
  const elevQ = temperatureSuitabilityQ(
    clampQ(elevationQ),
    profile.optimumElevationQ,
    profile.elevationToleranceQ,
  );
  if (elevQ === 0) {
    return 0;
  }

  let capacity = qmul(base, fertilityMixQ);
  capacity = qmul(capacity, moistQ);
  capacity = qmul(capacity, tempQ);
  capacity = qmul(capacity, elevQ);
  return clamp(capacity, 0, MAX_BIOMASS);
}

/** Recompute capacity for every channel of every cell. */
export function recomputeAllPlantCapacities(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  const { cellCount } = environment;
  for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
    const offset = resource * cellCount;
    for (let i = 0; i < cellCount; i += 1) {
      const capacity = computeResourceCapacity(
        config,
        resource,
        environment.biome[i] as number,
        environment.fertilityQ[i] as number,
        environment.getMoistureQ(i),
        environment.getTemperatureCentiC(i),
        environment.elevationQ[i] as number,
      );
      environment.resourceCapacity[offset + i] = capacity;
      // Biomass can never exceed a shrunken capacity (docs/03 §27 invariant).
      if ((environment.resourceBiomass[offset + i] as number) > capacity) {
        environment.resourceBiomass[offset + i] = capacity;
      }
    }
  }
}

/**
 * One logistic growth step for every channel of the whole grid (docs/03 §20):
 *
 *   delta = rate × biomass × (capacity − biomass) / capacity
 *
 * plus a small seed-bank term so a cell emptied to exactly zero can recover.
 * Without it, `delta` is 0 forever once biomass hits 0 and grazing would
 * permanently sterilise a cell.
 *
 * Runs on the scheduled environment update, so `rate` is per environment step,
 * not per tick.
 *
 * ## Regrowth rate is what makes a channel's *timing* differ (M17)
 *
 * The five channels are told apart as much by how fast they come back as by
 * where they grow. Foliage regrows almost as fast as it is eaten, so a grazed
 * cell is worth returning to; fruit regrows two orders of magnitude slower, so
 * a stripped patch stays stripped for thousands of ticks and the living is made
 * by finding the next one. That is where "intermittent" comes from — an
 * emergent property of a slow logistic term against fast consumption, not a
 * clock. A clock would be a time-varying environment, which is M18's milestone
 * and not this one's to pre-empt.
 *
 * Roots are the channel that is *always* there in small amounts, and that comes
 * from the capacity side rather than the growth side: a near-zero fertility
 * weight and a growth rate that barely varies by biome mean roots hold ground
 * that nothing else will grow on. It used to come from the seed bank instead —
 * see the invariant below for why that was a mistake.
 *
 * ## The seed bank must never be reachable by a cell that still has biomass
 *
 * The seed bank adds a flat number of units, so it is independent of capacity,
 * of growth rate and of how hard the cell is being grazed. That is harmless for
 * a term that fires on empty ground and nowhere else, and ruinous for one that
 * fires below a threshold: grazing pins the cell just under the threshold and
 * the flat term becomes a permanent food source that no amount of capacity
 * tuning can turn down.
 *
 * It was written with a per-channel `minRegenThreshold` and the measurement was
 * unambiguous. With five channels each carrying their own floor, a fully grazed
 * 144x144 soak world could draw 247 797 energy per tick from the seed banks
 * against 65 343 from the logistic term of an *ungrazed* world — the floor was
 * nearly four times the real production, it set the population ceiling by
 * itself, and it is why population scaled as only K^0.6 when capacity was cut.
 * Firing on empty cells alone restores capacity as the thing that decides how
 * much a place can feed.
 */
export function growPlants(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  const { resourceBiomass, resourceCapacity, plantGrowthRemainderQ, biome, cellCount } =
    environment;

  for (let resource = 0; resource < PLANT_RESOURCE_COUNT; resource += 1) {
    const profile = config.plants.resources[resource];
    if (profile === undefined) {
      continue;
    }
    const { growthRateQByBiome, seedBankRegenUnits } = profile;
    const offset = resource * cellCount;

    for (let i = 0; i < cellCount; i += 1) {
      const flat = offset + i;
      const capacity = resourceCapacity[flat] as number;
      if (capacity === 0) {
        resourceBiomass[flat] = 0;
        plantGrowthRemainderQ[flat] = 0;
        continue;
      }

      const biomass = resourceBiomass[flat] as number;
      const rateQ = growthRateQByBiome[biome[i] as number] ?? 0;

      let next = biomass;
      let remainder = plantGrowthRemainderQ[flat] as number;

      if (rateQ > 0 && biomass > 0) {
        const headroom = capacity - biomass;
        if (headroom > 0) {
          // Q-scaled logistic delta, computed as one expression so the division
          // by capacity happens last. The largest possible numerator is
          // Q × 65535 × 65535 ≈ 1.8e13, comfortably exact as a double.
          const deltaQ = Math.trunc((rateQ * biomass * headroom) / capacity);

          // Carry the fraction. Without this, any cell whose true growth is
          // below one unit per step — every sparsely vegetated cell, and every
          // cell at all in a slow channel — would truncate to zero and freeze.
          const totalQ = deltaQ + remainder;
          const whole = Math.trunc(totalQ / Q);
          remainder = totalQ - whole * Q;
          next += whole;
        }
      }

      // Seed bank: a deterministic trickle that lifts a cell off exactly zero,
      // where the logistic term is identically zero (docs/03 §20). Exactly zero
      // and not "near zero" — a flat term that a grazed cell can keep reaching
      // is a food source, not a recovery mechanism.
      if (next === 0) {
        next += seedBankRegenUnits;
      }

      if (next >= capacity) {
        next = capacity;
        // At capacity there is nothing left to carry.
        remainder = 0;
      } else if (next < 0) {
        next = 0;
      }

      resourceBiomass[flat] = next;
      plantGrowthRemainderQ[flat] = remainder;
    }
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
export function resourceGradientXQAt(
  environment: EnvironmentStore,
  resource: number,
  cell: number,
): number {
  const { size, resourceBiomass, cellCount } = environment;
  const offset = resource * cellCount;
  const gx = cell % size;
  const left = resourceBiomass[offset + (gx > 0 ? cell - 1 : cell)] as number;
  const right = resourceBiomass[offset + (gx < size - 1 ? cell + 1 : cell)] as number;
  return gradientQ(
    right - left,
    resourceBiomass.length === 0 ? 0 : referenceQ(environment, resource, cell),
  );
}

/** Vertical counterpart of {@link resourceGradientXQAt}; +y is south on screen. */
export function resourceGradientYQAt(
  environment: EnvironmentStore,
  resource: number,
  cell: number,
): number {
  const { size, resourceBiomass, cellCount } = environment;
  const offset = resource * cellCount;
  const gy = (cell - (cell % size)) / size;
  const up = resourceBiomass[offset + (gy > 0 ? cell - size : cell)] as number;
  const down = resourceBiomass[offset + (gy < size - 1 ? cell + size : cell)] as number;
  return gradientQ(down - up, referenceQ(environment, resource, cell));
}

/**
 * What a channel's gradient is measured against.
 *
 * The cell's own capacity in that channel, so "food is that way" means the same
 * thing in a desert and in a forest — but floored by a configured minimum, or a
 * channel that is locally absent would divide by ~1 and report a full-scale
 * gradient for a single stray unit next door.
 */
function referenceQ(environment: EnvironmentStore, resource: number, cell: number): number {
  return environment.resourceCapacity[resource * environment.cellCount + cell] as number;
}

/** Normalize a central difference against the local capacity, clamped to ±Q. */
function gradientQ(difference: number, capacity: number): number {
  // A non-zero reference so barren cells report 0 instead of dividing by zero.
  const reference = Math.max(capacity, 1);
  return clamp(Math.trunc((difference * Q) / (2 * reference)), -Q, Q);
}

/**
 * Total standing biomass across every channel and cell (diagnostics, validity).
 *
 * Summed across channels without weighting. A weighted total would be the
 * engine expressing a view about which food counts, and nothing outside an
 * organism's own genome is allowed one (docs/11 §M17).
 */
export function totalPlantBiomass(environment: EnvironmentStore): number {
  let total = 0;
  for (let i = 0; i < environment.resourceBiomass.length; i += 1) {
    total += environment.resourceBiomass[i] as number;
  }
  return total;
}

/** Total carrying capacity across every channel (world validity, docs/03 §15). */
export function totalPlantCapacity(environment: EnvironmentStore): number {
  let total = 0;
  for (let i = 0; i < environment.resourceCapacity.length; i += 1) {
    total += environment.resourceCapacity[i] as number;
  }
  return total;
}

/**
 * True when the cell is land that can support *any* channel.
 *
 * Any rather than all: a cell that grows only roots is still somewhere an
 * organism can make a living, and world validity has no business preferring
 * one channel's ground over another's.
 */
export function isProductiveLand(environment: EnvironmentStore, index: number): boolean {
  return environment.biome[index] !== Biome.Water && environment.totalPlantCapacity(index) > 0;
}
