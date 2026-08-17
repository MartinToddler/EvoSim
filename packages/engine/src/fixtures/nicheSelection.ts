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

/**
 * The niche geography with the **shipped** resource mix, unscaled.
 *
 * Exported because it is the control the five worlds are read against, and
 * because the capacity shares that set their multipliers are measured on it.
 */
export function nicheBase(): SimulationConfig {
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

/**
 * Realised share of total plant capacity per channel, in hundredths of a
 * percent, measured on this geography with the shipped mix across all three
 * `NICHE_SEEDS`: foliage 46.50%, browse 23.37%, fruit 4.66%, roots 17.32%,
 * defended 8.14%.
 *
 * Realised rather than declared, because a channel's base capacity says very
 * little about how much of it a world actually has. Fruit's base is the second
 * largest of the five and its suitability window is narrow enough that it lands
 * at a twentieth of the world's capacity.
 */
const REALISED_CAPACITY_SHARE_BP: readonly number[] = [4650, 2337, 466, 1732, 814];

/**
 * Per-world capacity multipliers, as percentages: the favoured channel first,
 * every other channel second.
 *
 * Chosen so that each world has the **same total plant capacity** as the
 * shipped mix and differs only in how that capacity is distributed. Given a
 * channel's realised share `s`, boosting it by `F` and damping the rest by
 * `m = (1 - F·s) / (1 - s)` leaves the total unchanged; `F` targets a 50% share
 * for the favoured channel.
 *
 * Fruit is the exception and cannot reach 50%: `baseCapacityByBiome` has to fit
 * a Uint16, which caps its boost at 7.28x and its share at 33.9%. That still
 * makes it the largest channel in its own world — foliage lands at 32.1% — but
 * only just, and the ADR records it rather than forcing it.
 *
 * The previous construction (favoured x1.60, everything else x0.25) is what
 * these replace. It changed each world's total richness as well as its mix, so
 * "any difference in outcome is attributable to the mix" was not true of it:
 * a world favouring a small channel ended up a third as rich as one favouring
 * foliage. That went unnoticed while the seed-bank floor supplied most of the
 * food and capacity barely moved the population; with the floor closed
 * (ADR 0031 §5e) it showed up immediately as three of the five worlds falling
 * to double-digit populations or dying outright.
 */
const FAVOUR_MULTIPLIER_PCT: readonly number[] = [
  108, // foliage  -> 50.2%
  214, // browse   -> 50.0%
  728, // fruit    -> 33.9%, the Uint16 ceiling
  289, // roots    -> 50.1%
  614, // defended -> 50.0%
];

/** A world where one channel is the bulk of the capacity and the rest share the remainder. */
function worldFavouring(resource: number): ReadonlySimulationConfig {
  const config = nicheBase();
  const favouredPct = FAVOUR_MULTIPLIER_PCT[resource];
  const shareBp = REALISED_CAPACITY_SHARE_BP[resource];
  if (favouredPct === undefined || shareBp === undefined) {
    throw new Error(`no capacity calibration measured for channel ${resource}`);
  }

  // The damping that keeps the world's total capacity where it was. Derived
  // rather than tabulated, so the invariant cannot drift away from the boost.
  const share = shareBp / 10_000;
  const othersPct = Math.round((100 * (1 - (favouredPct / 100) * share)) / (1 - share));

  for (let other = 0; other < config.plants.resources.length; other += 1) {
    scaleCapacity(config, other, other === resource ? favouredPct : othersPct);
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
 * only available way to make a carrion world is to make plants scarce and see
 * what share of the living has to come from what has already died. The engine
 * is not told this; it follows from the ecology.
 *
 * ## What it actually produces, recorded rather than tuned away
 *
 * Not scavengers. Measured across the three seeds at 45%, meat is 0.09%, 0.59%
 * and 0.06% of intake — a rounding error, and the population still lives on
 * plants. Making the world poorer does not help, because it is the wrong
 * direction: scarce plants mean fewer and thinner bodies, bodies being made of
 * plants. At 22%, which is where this fixture started, the world went extinct on
 * its first seed and carried 30 and 67 organisms on the others.
 *
 * So this is the lean world rather than the carrion world, and it earns its
 * place in the acceptance set by being uniformly poor rather than by feeding
 * anything on meat. Carnivory as a selectable strategy is demonstrated where it
 * can be demonstrated honestly — `predationSimulation.test.ts`, "rewards the
 * carnivore specialist in a world of meat".
 *
 * 45% is the calibration: poor enough to be a distinctly harder world, rich
 * enough that all three seeds keep a population worth reading.
 */
export const CARRION_RICH_CONFIG: ReadonlySimulationConfig = (() => {
  const config = nicheBase();
  for (let resource = 0; resource < config.plants.resources.length; resource += 1) {
    scaleCapacity(config, resource, 45);
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
