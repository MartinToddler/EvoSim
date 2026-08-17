import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Gene, geneFromQ } from "../genetics/genes";
import { engineInternals } from "../internal";
import { Q } from "../math/fixed";
import type { SimulationEngine } from "../SimulationEngine";
import { RESOURCE_COUNT, Resource } from "../world/resources";

/**
 * M17 acceptance: no resource strategy is structurally universal.
 *
 * docs/11 §M17 asks for "multi-seed controlled runs in grass-rich, fruit-patchy,
 * toxin-rich, root-rich and carrion-rich worlds" showing that no single way of
 * making a living wins everywhere. That is a claim about the *shape* of the
 * ecology rather than about any one number, and it is the claim M17 exists to
 * support: five channels that all reduce to "eat the richest one" would be one
 * channel with five names.
 *
 * It is also the claim the milestone already failed once, before this gate
 * existed. The first energy-per-unit table spread channel values wider than the
 * genome could spread processing efficiency, so raw richness beat every genetic
 * difference and the founder ate 91% defended growth — a channel it had no
 * resistance to and was bad at processing (ADR 0031 §4). The gate is written the
 * way it is because that failure was invisible to every unit test.
 *
 * ## What is measured
 *
 * Each organism's **argmax processing locus** — the channel it is genetically
 * best at. That is a derived observational label, computed by the observer from
 * the genome, and ADR 0027 permits exactly this: the engine never reads it, no
 * decision branches on it, and an organism labelled "roots" here is not a
 * `RootEater` anywhere in the simulation. It eats whatever the expected-gain
 * rule picks, tick by tick, from what is actually underfoot.
 *
 * ## What would falsify it
 *
 * One channel taking the largest share in all five worlds. That is a universal
 * strategy, and it fails the milestone whether it arises from an energy table,
 * an efficiency curve or an access factor.
 */

/** Grid size for the niche worlds; the M15/M16 scenarios use the same. */
export const NICHE_GRID_SIZE = 128;

/**
 * How long each world runs.
 *
 * Longer than the M15/M16 selection horizon because processing loci start at an
 * even six-way split rather than a two-way one, so the signal has more ways to
 * go before it goes anywhere.
 */
export const NICHE_HORIZON = 10_000;

/** Seeds each world is run on. Stochastic outcomes need more than one. */
export const NICHE_SEEDS: readonly number[] = [0xe0a12026, 0xe0a13f15, 0xe0a17cf3];

function nicheBase(): SimulationConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  const grid = NICHE_GRID_SIZE;
  config.world.envGridSize = grid;
  config.world.sizeLU = grid * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(grid / 8));
  config.world.initialOrganisms = 120;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.limits.maxOrganisms = 4096;
  config.limits.maxCarcasses = 2048;
  config.world.validity.minFounderRegionCells = Math.floor((grid * grid) / 24);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    DEFAULT_CONFIG.world.validity.minTotalPlantCapacity / 16,
  );
  return config;
}

/**
 * Scale one channel's capacity everywhere, leaving its curves alone.
 *
 * The worlds differ in **how much** of each channel there is, not in where each
 * channel likes to grow. That keeps the five configurations comparable: any
 * difference in outcome is a difference in the resource mix, not in the shape of
 * the map.
 */
function scaleCapacity(config: SimulationConfig, resource: number, factorPct: number): void {
  const profile = config.plants.resources[resource];
  if (profile === undefined) {
    return;
  }
  profile.baseCapacityByBiome = profile.baseCapacityByBiome.map((base) =>
    Math.min(65535, Math.floor((base * factorPct) / 100)),
  );
}

/** A world where one channel is abundant and the rest are scarce. */
function worldFavouring(resource: number): ReadonlySimulationConfig {
  const config = nicheBase();
  for (let other = 0; other < config.plants.resources.length; other += 1) {
    scaleCapacity(config, other, other === resource ? 160 : 25);
  }
  return config;
}

/** Scenario A — grass-rich: foliage everywhere, everything else thin. */
export const GRASS_RICH_CONFIG: ReadonlySimulationConfig = worldFavouring(Resource.Foliage);

/** Scenario B — fruit-patchy: fruit is the abundant channel, and still patchy. */
export const FRUIT_PATCHY_CONFIG: ReadonlySimulationConfig = worldFavouring(Resource.Fruit);

/** Scenario C — toxin-rich: defended growth is what there is to eat. */
export const TOXIN_RICH_CONFIG: ReadonlySimulationConfig = worldFavouring(Resource.Defended);

/** Scenario D — root-rich: the living is underground. */
export const ROOT_RICH_CONFIG: ReadonlySimulationConfig = worldFavouring(Resource.Roots);

/**
 * Scenario E — carrion-rich: every plant channel is poor, so bodies matter.
 *
 * Meat has no capacity field to raise — it comes from organisms dying — so the
 * only honest way to make a carrion world is to make plants scarce enough that
 * a substantial share of the population's energy has to come from what has
 * already died. The engine is not told this; it follows from the ecology.
 */
export const CARRION_RICH_CONFIG: ReadonlySimulationConfig = (() => {
  const config = nicheBase();
  for (let resource = 0; resource < config.plants.resources.length; resource += 1) {
    scaleCapacity(config, resource, 22);
  }
  return config;
})();

/** The five worlds, with the names docs/11 §M17 uses. */
export const NICHE_WORLDS: readonly { name: string; config: ReadonlySimulationConfig }[] = [
  { name: "grass-rich", config: GRASS_RICH_CONFIG },
  { name: "fruit-patchy", config: FRUIT_PATCHY_CONFIG },
  { name: "toxin-rich", config: TOXIN_RICH_CONFIG },
  { name: "root-rich", config: ROOT_RICH_CONFIG },
  { name: "carrion-rich", config: CARRION_RICH_CONFIG },
];

/**
 * Give a freshly created world standing variation in processing ability.
 *
 * Founders are dealt round-robin across the six channels: each is made a
 * specialist in one channel and left mediocre in the rest. Nothing else about
 * them changes — same body, same brain, same ecological genes — so the only
 * axis the worlds can sort on is the one under test.
 *
 * Specialists rather than a random spread, for the reason ADR 0029 §5a gives:
 * selection sorts **standing variation**, and a population founded on one genome
 * has none until mutation supplies it, which takes far more generations than a
 * gate can run. Dealing the six specialists is what makes ten thousand ticks
 * enough to see which one a world prefers.
 *
 * The toxin-resistance locus is dealt with the defended specialist and only
 * with it, because resistance without defended growth to eat is pure upkeep —
 * giving it to everyone would tax five lineages for a capability one of them
 * uses.
 */
export function seedProcessingVariation(engine: SimulationEngine): void {
  const { context } = engineInternals(engine);
  const { organisms, genomes } = context;

  const SPECIALIST_Q = Math.round(Q * 0.95);
  const MEDIOCRE_Q = Math.round(Q * 0.25);

  let index = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const specialty = index % RESOURCE_COUNT;
    index += 1;

    const base = genomes.geneOffset(slot);
    for (let resource = 0; resource < RESOURCE_COUNT; resource += 1) {
      genomes.genes[base + Gene.Process + resource] = geneFromQ(
        resource === specialty ? SPECIALIST_Q : MEDIOCRE_Q,
      );
    }
    genomes.genes[base + Gene.ToxinResistance] = geneFromQ(
      specialty === Resource.Defended ? SPECIALIST_Q : 0,
    );
  }
}

/**
 * Which channel each living organism is genetically best at, as a distribution.
 *
 * A **derived observational label** (ADR 0027): computed by the observer from
 * the genome, never read by the engine, and never the reason an organism does
 * anything. Ties go to the lowest channel index, which matters only for a
 * genome whose loci are exactly equal.
 */
export function specialistShares(engine: SimulationEngine): number[] {
  const { context } = engineInternals(engine);
  const { organisms, genomes } = context;
  const counts = new Array<number>(RESOURCE_COUNT).fill(0);
  let population = 0;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    population += 1;
    const base = genomes.geneOffset(slot);
    let best = 0;
    let bestValue = -1;
    for (let resource = 0; resource < RESOURCE_COUNT; resource += 1) {
      const value = genomes.genes[base + Gene.Process + resource] as number;
      if (value > bestValue) {
        bestValue = value;
        best = resource;
      }
    }
    counts[best] = (counts[best] as number) + 1;
  }

  if (population === 0) {
    return counts;
  }
  return counts.map((count) => count / population);
}

/** Realized energy taken from each channel by the living, as a distribution. */
export function intakeShares(engine: SimulationEngine): number[] {
  const { context } = engineInternals(engine);
  const { organisms } = context;
  const totals = new Array<number>(RESOURCE_COUNT).fill(0);

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    for (let resource = 0; resource < RESOURCE_COUNT; resource += 1) {
      totals[resource] =
        (totals[resource] as number) +
        (organisms.resourceEnergyEaten[slot * RESOURCE_COUNT + resource] as number);
    }
  }

  const sum = totals.reduce((a, b) => a + b, 0);
  return sum === 0 ? totals : totals.map((total) => total / sum);
}

/** Index of the largest entry, lowest index on a tie. */
export function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) > (values[best] as number)) {
      best = i;
    }
  }
  return best;
}
